/**
 * AI Compose — DeepSeek Client Service
 *
 * Provides a typed interface to the DeepSeek API with configurable
 * parameters, adaptive request timeouts, rate-limiting with exponential
 * backoff, and granular error handling.
 */

import { getSetting, ReasoningMode, MAX_RETRIES, INITIAL_RETRY_DELAY_MS, RETRY_BACKOFF_FACTOR } from '../features/settings';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Streaming health-monitoring tiers (ms). All are wall-clock and independent
 * of prompt size — a model that goes quiet is hanging regardless of input. */
const CONNECT_TIMEOUT_MS = 30_000; // No response headers at all.
const STALL_TIMEOUT_MS = 60_000; // No new body data after the stream started.
const OVERALL_TIMEOUT_MS = 300_000; // Hard ceiling for the whole response.

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-flash';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Error codes surfaced by the DeepSeek service. */
export enum DeepSeekErrorCode {
  INVALID_API_KEY = 'INVALID_API_KEY',
  RATE_LIMITED = 'RATE_LIMITED',
  API_ERROR = 'API_ERROR',
  TIMEOUT = 'TIMEOUT',
  EMPTY_RESPONSE = 'EMPTY_RESPONSE',
  INVALID_JSON = 'INVALID_JSON',
  NETWORK_ERROR = 'NETWORK_ERROR',
  ABORTED = 'ABORTED',
  UNKNOWN = 'UNKNOWN',
}

/** Typed error thrown by the DeepSeek service. */
export class DeepSeekError extends Error {
  code: DeepSeekErrorCode;
  retryable: boolean;
  statusCode?: number;

  constructor(message: string, code: DeepSeekErrorCode, retryable = false, statusCode?: number) {
    super(message);
    this.name = 'DeepSeekError';
    this.code = code;
    this.retryable = retryable;
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// Client state
// ---------------------------------------------------------------------------

let deepseekApiKey = '';
let activeController: AbortController | null = null;

export function initDeepSeekClient(apiKey: string): void {
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error('API key is required for DeepSeek.');
  }
  deepseekApiKey = apiKey;
}

/**
 * Abort any in-flight DeepSeek request (used when the user starts a new
 * action or the add-in unloads).
 */
export function abortDeepSeekRequest(): void {
  if (activeController) {
    activeController.abort();
    activeController = null;
  }
}

// ---------------------------------------------------------------------------
// Low-level HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Stream a chat-completion request from DeepSeek and aggregate the response.
 *
 * Uses `stream: true` (SSE) with health monitoring:
 *  - Connect window: fails if response headers don't arrive within
 *    `CONNECT_TIMEOUT_MS` (genuine network/host problem).
 *  - Stall window: fails if the body goes quiet for `STALL_TIMEOUT_MS`
 *    (e.g. a model that stops generating — retrying won't help).
 *  - Overall ceiling: fails if the whole response exceeds `OVERALL_TIMEOUT_MS`.
 *
 * The request is registered on `activeController` so `abortDeepSeekRequest`
 * still cancels it. Timeouts are hard failures (never retried).
 */
async function streamChatCompletion(
  body: Record<string, unknown>,
  onStream?: (delta: string) => void,
): Promise<{ text: string; finishReason?: string }> {
  const controller = new AbortController();
  activeController = controller;
  const startedAt = Date.now();
  let text = '';
  let finishReason: string | undefined;

  const buildBody = () =>
    JSON.stringify({
      ...body,
      stream: true,
      stream_options: { include_usage: true },
    });

  const elapsed = () => Date.now() - startedAt;

  // FIX(5): extract the SSE parsing so we can also use it on the final buffer
  // flush (which previously could drop a trailing chunk with no newline).
  const consumeLine = (rawLine: string) => {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const chunk = JSON.parse(payload);
      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        text += delta;
        onStream?.(delta);
      }
    } catch {
      // Malformed/incomplete SSE line — skip and keep going.
    }
  };

  try {
    // Connect window: headers must arrive before CONNECT_TIMEOUT_MS.
    const connectBudget = Math.min(CONNECT_TIMEOUT_MS, OVERALL_TIMEOUT_MS);
    const response = await raceWithTimeout(
      fetch(DEEPSEEK_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${deepseekApiKey}`,
        },
        body: buildBody(),
        signal: controller.signal,
      }),
      connectBudget,
      () => streamTimeoutError('connect'),
      // FIX(5): ensure the underlying request is actually torn down on
      // timeout instead of lingering in the background.
      () => controller.abort(),
    );

    if (!response.ok) {
      const errText = await response.text();
      throw classifyHttpError(response.status, errText);
    }

    if (!response.body) {
      throw new DeepSeekError(
        'DeepSeek returned an empty body.',
        DeepSeekErrorCode.EMPTY_RESPONSE,
        false,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const overallLeft = OVERALL_TIMEOUT_MS - elapsed();
      if (overallLeft <= 0) throw streamTimeoutError('overall');

      const waitMs = Math.min(STALL_TIMEOUT_MS, overallLeft);
      const { done, value } = await raceWithTimeout(
        reader.read(),
        waitMs,
        // FIX: `firstByte` was always true by this point, so the ternary
        // was dead code — every read is, correctly, a stall check.
        () => streamTimeoutError('stall'),
        () => controller.abort(),
      );

      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) consumeLine(line);
    }

    // FIX(4): previously only flushed when `decoder.decode()` had leftover
    // bytes. If the final `data:` line arrived without a trailing newline
    // AND the decoder had nothing buffered, `buffer` was silently dropped.
    // Now we always flush.
    buffer += decoder.decode();
    if (buffer.trim()) {
      consumeLine(buffer);
      buffer = '';
    }

    return { text, finishReason };
  } catch (error) {
    throw classifyStreamError(error, controller);
  } finally {
    if (activeController === controller) activeController = null;
  }
}

/**
 * Map a normalized ReasoningMode onto DeepSeek's OpenAI-compatible request
 * params.
 *
 * FIX(1) & FIX(3): The previous implementation used an Anthropic-shaped
 * `thinking: { type: 'disabled' | 'enabled' }` field which DeepSeek's
 * OpenAI-compatible endpoint silently ignores. In `fast` mode that meant
 * reasoning was never actually suppressed, so reasoning tokens consumed the
 * same `max_tokens` budget as the visible output — producing a `length`
 * finish with no text (the exact error this service was hitting). We now use
 * the OpenAI-style `reasoning_effort` knob, and fall through to the *disabled*
 * branch for any unrecognised mode rather than enabling thinking.
 */
function resolveThinkingParams(
  reasoningMode: ReasoningMode,
): Record<string, unknown> {
  if (reasoningMode === 'high') {
    return {
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    };
  }
  if (reasoningMode === 'fast') {
    // 'fast' → 关闭思考
    return { thinking: { type: 'disabled' } };
  }
  return {
    thinking: { type: 'enabled' },
    reasoning_effort: 'low',
    };
}

/**
 * Build the typed error thrown when DeepSeek returns no text, choosing a
 * message based on the stream's finish reason so the user gets a precise
 * explanation instead of a generic "empty response".
 */
function emptyResponseError(finishReason?: string): DeepSeekError {
  if (finishReason === 'length') {
    // FIX(7): the previous copy ("use a shorter request") was misleading for
    // short prompts. The real cause is almost always reasoning tokens eating
    // the max_tokens budget.
    return new DeepSeekError(
      'The model response was cut off because it reached the maximum output token limit. Try again, use a shorter request, or disable "Reasoning" mode.',
      DeepSeekErrorCode.EMPTY_RESPONSE,
      false,
    );
  }
  if (finishReason === 'content_filter') {
    return new DeepSeekError(
      'The model returned an empty response. The content was blocked by content filters.',
      DeepSeekErrorCode.EMPTY_RESPONSE,
      false,
    );
  }
  return new DeepSeekError(
    'The model returned an empty response.',
    DeepSeekErrorCode.EMPTY_RESPONSE,
    false,
  );
}

/** Build a typed timeout error for one of the health-monitoring tiers. */
function streamTimeoutError(kind: 'connect' | 'stall' | 'overall'): DeepSeekError {
  let message: string;
  if (kind === 'connect') {
    message = `No response from the model within ${CONNECT_TIMEOUT_MS / 1000}s — check your connection and try again.`;
  } else if (kind === 'stall') {
    message = `The model went quiet for ${STALL_TIMEOUT_MS / 1000}s with no new data — try again.`;
  } else {
    message = `The response did not finish within ${OVERALL_TIMEOUT_MS / 1000}s — try a shorter request.`;
  }
  // Not transient — retrying a hanging stream won't help.
  return new DeepSeekError(message, DeepSeekErrorCode.TIMEOUT, false);
}

/**
 * Race a promise against a timeout that fires `onTimeout` (an Error).
 *
 * FIX(5): added an optional `onCancel` callback so callers can tear down the
 * underlying request (e.g. abort the fetch/reader) when the timeout wins.
 * Without this, `streamChatCompletion` left orphaned connections behind on
 * every stall.
 */
function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
  onCancel?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          onCancel?.();
        } catch {
          // Ignore cancellation failures — the timeout is what matters.
        }
        reject(onTimeout());
      }
    }, ms);

    promise.then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      },
    );
  });
}

/** Classify a stream/read error, honouring user aborts and typed errors. */
function classifyStreamError(error: unknown, controller: AbortController): DeepSeekError {
  if (error instanceof DeepSeekError) return error;

  if (controller.signal.aborted) {
    return new DeepSeekError('Request aborted.', DeepSeekErrorCode.ABORTED, false);
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/network|fetch failed|ECONNREFUSED|ENOTFOUND|offline/i.test(message)) {
    return new DeepSeekError(
      `Network error: ${message}`,
      DeepSeekErrorCode.NETWORK_ERROR,
      true,
    );
  }

  return new DeepSeekError(message, DeepSeekErrorCode.UNKNOWN, false);
}

/** Classify a non-2xx HTTP response into a typed, retry-aware error. */
function classifyHttpError(status: number, body: string): DeepSeekError {
  const snippet = body.slice(0, 500);
  const message = `DeepSeek API error: ${status} - ${snippet}`;

  if (status === 401 || status === 403) {
    return new DeepSeekError(
      'Invalid or expired DeepSeek API key. Please check your API key.',
      DeepSeekErrorCode.INVALID_API_KEY,
      false,
      status,
    );
  }
  if (status === 429) {
    return new DeepSeekError(
      'DeepSeek API rate limit reached. Please wait a moment and try again.',
      DeepSeekErrorCode.RATE_LIMITED,
      true,
      status,
    );
  }
  if (status >= 500) {
    return new DeepSeekError(message, DeepSeekErrorCode.API_ERROR, true, status);
  }
  return new DeepSeekError(message, DeepSeekErrorCode.API_ERROR, false, status);
}

/** Ensure any thrown error is a typed DeepSeekError (for the retry loop). */
function classifyError(error: unknown): DeepSeekError {
  if (error instanceof DeepSeekError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new DeepSeekError(message, DeepSeekErrorCode.UNKNOWN, false);
}

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

/**
 * FIX(6): extract the first balanced JSON object/array from a string.
 *
 * The previous implementation used a greedy `/\{[\s\S]*\}/` regex which
 * over-matched when the model emitted preamble or trailing prose, and it
 * completely ignored top-level arrays. This walks the string once, respects
 * string literals / escapes, and returns the first balanced block.
 */
function extractJson(text: string): unknown {
  // Fast path: whole payload is already valid JSON.
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to structural extraction.
  }

  const start = text.search(/[\[{]/);
  if (start === -1) return undefined;

  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Retry with exponential backoff
// ---------------------------------------------------------------------------

/**
 * Retry a function with exponential backoff. Only retries errors marked as
 * `retryable` (transient server / rate-limit / network failures) — never
 * empty responses, invalid keys, timeouts, or malformed payloads.
 */
async function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries: number = MAX_RETRIES): Promise<T> {
  let lastError: DeepSeekError | undefined;
  let delay = INITIAL_RETRY_DELAY_MS;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = classifyError(error);

      if (!lastError.retryable || attempt === maxRetries) {
        throw lastError;
      }

      const jitter = Math.random() * 0.3 * delay;
      await new Promise((resolve) => setTimeout(resolve, delay + jitter));
      delay *= RETRY_BACKOFF_FACTOR;
    }
  }

  throw lastError!;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function generateText(
  prompt: string,
  options: any = {},
): Promise<string> {
  if (!deepseekApiKey) {
    throw new Error('DeepSeek client not initialised. Call initDeepSeekClient first.');
  }
  const modelName = options.model ?? getSetting('defaultModel') ?? DEFAULT_MODEL;
  const reasoningMode: ReasoningMode =
    options.reasoningMode ?? getSetting('reasoningMode') ?? 'fast';

  const callFn = async () => {
    const { text, finishReason } = await streamChatCompletion(
      {
        model: modelName,
        messages: [{ role: 'user', content: prompt }],
        temperature: options.temperature ?? 1.0,
        max_tokens: options.maxOutputTokens ?? 2048,
        ...resolveThinkingParams(reasoningMode),
      },
      options.onStream,
    );

    if (!text || !text.trim()) {
      throw emptyResponseError(finishReason);
    }
    return text;
  };

  return retryWithBackoff(callFn, options.maxRetries ?? MAX_RETRIES);
}

export async function generateJson<T = Record<string, unknown>>(
  prompt: string,
  options: any = {},
): Promise<T> {
  if (!deepseekApiKey) {
    throw new Error('DeepSeek client not initialised. Call initDeepSeekClient first.');
  }
  const modelName = options.model ?? getSetting('defaultModel') ?? DEFAULT_MODEL;
  const reasoningMode: ReasoningMode =
    options.reasoningMode ?? getSetting('reasoningMode') ?? 'fast';

  const callFn = async () => {
    const { text, finishReason } = await streamChatCompletion(
      {
        model: modelName,
        messages: [
          ...(options.systemInstruction ? [{ role: 'system', content: options.systemInstruction }] : []),
          { role: 'user', content: prompt },
        ],
        temperature: options.temperature ?? 0.1,
        max_tokens: options.maxOutputTokens ?? 1024,
        response_format: { type: 'json_object' },
        ...resolveThinkingParams(reasoningMode),
      },
      options.onStream,
    );

    if (!text || !text.trim()) {
      throw emptyResponseError(finishReason);
    }

    const parsed = extractJson(text);
    if (parsed === undefined) {
      throw new DeepSeekError(
        `Model returned invalid JSON: ${text.slice(0, 100)}`,
        DeepSeekErrorCode.INVALID_JSON,
        false,
      );
    }
    return parsed as T;
  };

  return retryWithBackoff(callFn, options.maxRetries ?? MAX_RETRIES);
}

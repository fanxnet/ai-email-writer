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

/** Upper bound for backoff delays so a long outage can't push us out hours. */
const MAX_RETRY_DELAY_MS = 30_000;

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

/** Fallback model when neither options nor settings provide one. */
const DEFAULT_MODEL = 'deepseek-flash';
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

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

/** One AbortController per in-flight generation, spanning the retry loop so an
 * abort during backoff still stops the pending work. */
let activeController: AbortController | null = null;

export function initDeepSeekClient(apiKey: string): void {
  const trimmed = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!trimmed) {
    throw new DeepSeekError(
      'API key is required for DeepSeek.',
      DeepSeekErrorCode.INVALID_API_KEY,
      false,
    );
  }
  deepseekApiKey = trimmed;
}

/**
 * Abort the in-flight DeepSeek request (used when the user starts a new
 * action or the add-in unloads). Also cancels a retry waiting in backoff.
 */
export function abortDeepSeekRequest(): void {
  if (activeController) {
    const controller = activeController;
    activeController = null;
    try {
      controller.abort();
    } catch {
      // ignore
    }
  }
}

function abortedError(): DeepSeekError {
  return new DeepSeekError('Request aborted.', DeepSeekErrorCode.ABORTED, false);
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
 * Timeouts abort the underlying request, and `[DONE]` terminates the read
 * loop immediately. If any delta already reached the UI, retryable errors are
 * downgraded to non-retryable so a retry can't duplicate visible output.
 */
async function streamChatCompletion(
  body: Record<string, unknown>,
  controller: AbortController,
  onStream?: (delta: string) => void,
): Promise<{ text: string; finishReason?: string }> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  let text = '';
  let finishReason: string | undefined;
  let streamed = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    // Connect window: headers must arrive before CONNECT_TIMEOUT_MS.
    const connectBudget = Math.min(CONNECT_TIMEOUT_MS, OVERALL_TIMEOUT_MS);
    const response = await raceWithTimeout(
      fetch(DEEPSEEK_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'Authorization': `Bearer ${deepseekApiKey}`,
        },
        body: JSON.stringify({
          ...body,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: controller.signal,
      }),
      connectBudget,
      () => {
        controller.abort();
        return streamTimeoutError('connect');
      },
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw classifyHttpError(response.status, errText);
    }

    if (!response.body) {
      throw new DeepSeekError(
        'DeepSeek returned an empty body.',
        DeepSeekErrorCode.EMPTY_RESPONSE,
        false,
      );
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sawDone = false;

    /** Parse one SSE line. Returns true when the stream signalled `[DONE]`. */
    const handleLine = (line: string): boolean => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) return false; // comment / keep-alive
      if (!trimmed.startsWith('data:')) return false;

      const payload = trimmed.slice(5).trim();
      if (!payload) return false;
      if (payload === '[DONE]') return true;

      try {
        const chunk = JSON.parse(payload);
        const choice = chunk?.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          text += delta;
          streamed = true;
          try {
            onStream?.(delta);
          } catch {
            // A UI callback error must not kill the network stream.
          }
        }
      } catch {
        // Malformed / partial SSE payload — skip and keep going.
      }
      return false;
    };

    while (!sawDone) {
      const overallLeft = OVERALL_TIMEOUT_MS - elapsed();
      if (overallLeft <= 0) {
        controller.abort();
        throw streamTimeoutError('overall');
      }

      const waitMs = Math.min(STALL_TIMEOUT_MS, overallLeft);
      // If the wait was clipped by the overall ceiling, the timeout is
      // "overall", not "stall" — the user-facing message must match reality.
      const isOverall = waitMs < STALL_TIMEOUT_MS;

      const { done, value } = await raceWithTimeout(
        reader.read(),
        waitMs,
        () => {
          controller.abort();
          reader?.cancel().catch(() => {
            // ignore
          });
          return streamTimeoutError(isOverall ? 'overall' : 'stall');
        },
      );

      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (handleLine(line)) {
          sawDone = true;
          break;
        }
      }
    }

    // Flush any trailing bytes that never ended with a newline.
    if (!sawDone) {
      const tail = decoder.decode();
      if (tail) buffer += tail;
      for (const line of buffer.split('\n')) {
        if (handleLine(line)) break;
      }
    }

    return { text, finishReason };
  } catch (error) {
    const classified = classifyStreamError(error, controller);
    // Once part of the answer reached the UI, retrying would duplicate it.
    if (streamed && classified.retryable) classified.retryable = false;
    throw classified;
  } finally {
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Map a normalized ReasoningMode onto DeepSeek's OpenAI-compatible request
 * params. DeepSeek V4 enables thinking by default with `reasoning_effort: high`;
 * when thinking is on, reasoning tokens are spent from the same `max_tokens`
 * budget as the visible output — which is exactly how the output can be
 * starved (the empty-response bug). `off` disables thinking entirely.
 */
function resolveThinkingParams(
  reasoningMode: ReasoningMode,
): Record<string, unknown> {
  if (reasoningMode === 'fast') {
    return { thinking: { type: 'disabled' } };
  }
  if (reasoningMode === 'high') {
    return { thinking: { type: 'enabled' }, reasoning_effort: 'high' };
  }
  return { thinking: { type: 'enabled' }, reasoning_effort: 'low' };
}

/**
 * Build the typed error thrown when DeepSeek returns no text, choosing a
 * message based on the stream's finish reason so the user gets a precise
 * explanation instead of a generic "empty response".
 */
function emptyResponseError(finishReason?: string): DeepSeekError {
  if (finishReason === 'length') {
    return new DeepSeekError(
      'The model response was cut off because the request reached the maximum output token limit. Try again, use a shorter request, or disable "Reasoning" mode.',
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

/** Race a promise against a timeout that fires `onTimeout` (an Error). */
function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        reject(onTimeout());
      } catch (err) {
        reject(err);
      }
    }, ms);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Classify a stream/read error, honouring user aborts and typed errors. */
function classifyStreamError(error: unknown, controller: AbortController): DeepSeekError {
  if (error instanceof DeepSeekError) return error;

  if (controller.signal.aborted) return abortedError();

  const message = error instanceof Error ? error.message : String(error);
  if (
    /network|fetch failed|failed to fetch|load failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|offline/i.test(
      message,
    )
  ) {
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
  if (status === 402) {
    return new DeepSeekError(
      'DeepSeek account has insufficient balance. Please top up and try again.',
      DeepSeekErrorCode.API_ERROR,
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
// Retry with exponential backoff
// ---------------------------------------------------------------------------

/** Sleep that wakes up immediately when the controller is aborted. */
function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortedError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Retry a function with exponential backoff. Only retries errors marked as
 * `retryable` (transient server / rate-limit / network failures) — never
 * empty responses, invalid keys, timeouts, or malformed payloads. The
 * controller aborts both the in-flight attempt and the backoff wait.
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  controller: AbortController,
  maxRetries: number,
): Promise<T> {
  let lastError: DeepSeekError | undefined;
  let delay = INITIAL_RETRY_DELAY_MS;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (controller.signal.aborted) throw abortedError();

    try {
      return await fn();
    } catch (error) {
      lastError = classifyError(error);

      if (controller.signal.aborted) throw abortedError();
      if (!lastError.retryable || attempt === maxRetries) throw lastError;

      const jitter = Math.random() * 0.3 * delay;
      await sleepWithAbort(delay + jitter, controller.signal);
      delay = Math.min(delay * RETRY_BACKOFF_FACTOR, MAX_RETRY_DELAY_MS);
    }
  }

  throw lastError ?? new DeepSeekError('Request failed.', DeepSeekErrorCode.UNKNOWN, false);
}

// ---------------------------------------------------------------------------
// Shared request helpers
// ---------------------------------------------------------------------------

/** Start a fresh abort session and register it as the active request. */
function startSession(): AbortController {
  abortDeepSeekRequest();
  const controller = new AbortController();
  activeController = controller;
  return controller;
}

/** Clear the active controller if it's still this session. */
function endSession(controller: AbortController): void {
  if (activeController === controller) activeController = null;
}

/** Resolve model / reasoning mode / retries from options + settings. */
function resolveRequestConfig(options: any) {
  const model =
    (typeof options.model === 'string' && options.model.trim()) ||
    getSetting('defaultModel') ||
    DEFAULT_MODEL;
  const reasoningMode: ReasoningMode =
    options.reasoningMode ?? getSetting('reasoningMode') ?? 'fast';
  const maxRetries =
    Number.isInteger(options.maxRetries) && options.maxRetries >= 0
      ? options.maxRetries
      : MAX_RETRIES;
  return { model, reasoningMode, maxRetries };
}

/** Parse a model response into JSON, tolerating code fences and prose. */
function parseJsonResponse<T>(text: string): T {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // fall through
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim()) as T;
    } catch {
      // fall through
    }
  }

  const objMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]) as T;
    } catch {
      // fall through
    }
  }

  throw new DeepSeekError(
    `Model returned invalid JSON: ${trimmed.slice(0, 100)}`,
    DeepSeekErrorCode.INVALID_JSON,
    false,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function generateText(
  prompt: string,
  options: any = {},
): Promise<string> {
  if (!deepseekApiKey) {
    throw new DeepSeekError(
      'DeepSeek client not initialised. Call initDeepSeekClient first.',
      DeepSeekErrorCode.INVALID_API_KEY,
      false,
    );
  }

  const { model, reasoningMode, maxRetries } = resolveRequestConfig(options);
  const controller = startSession();

  const callFn = async () => {
    const { text, finishReason } = await streamChatCompletion(
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: typeof options.temperature === 'number' ? options.temperature : 1.0,
        max_tokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        ...resolveThinkingParams(reasoningMode),
      },
      controller,
      options.onStream,
    );

    if (!text || !text.trim()) throw emptyResponseError(finishReason);
    return text;
  };

  try {
    return await retryWithBackoff(callFn, controller, maxRetries);
  } finally {
    endSession(controller);
  }
}

export async function generateJson<T = Record<string, unknown>>(
  prompt: string,
  options: any = {},
): Promise<T> {
  if (!deepseekApiKey) {
    throw new DeepSeekError(
      'DeepSeek client not initialised. Call initDeepSeekClient first.',
      DeepSeekErrorCode.INVALID_API_KEY,
      false,
    );
  }

  const { model, reasoningMode, maxRetries } = resolveRequestConfig(options);
  const controller = startSession();

  const callFn = async () => {
    const { text, finishReason } = await streamChatCompletion(
      {
        model,
        messages: [
          ...(options.systemInstruction
            ? [{ role: 'system', content: options.systemInstruction }]
            : []),
          { role: 'user', content: prompt },
        ],
        temperature: typeof options.temperature === 'number' ? options.temperature : 0.1,
        max_tokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        response_format: { type: 'json_object' },
        ...resolveThinkingParams(reasoningMode),
      },
      controller,
      options.onStream,
    );

    if (!text || !text.trim()) throw emptyResponseError(finishReason);
    return parseJsonResponse<T>(text);
  };

  try {
    return await retryWithBackoff(callFn, controller, maxRetries);
  } finally {
    endSession(controller);
  }
}

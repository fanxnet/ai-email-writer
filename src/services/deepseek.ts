/**
 * AI Compose — DeepSeek Client Service
 *
 * Provides a typed interface to the DeepSeek API with configurable
 * parameters, adaptive request timeouts, rate-limiting with exponential
 * backoff, and granular error handling.
 */

import { getSetting } from '../features/settings';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base request timeout (ms). */
const BASE_TIMEOUT_MS = 30_000;

/** Extra timeout per ~5k chars of prompt (ms). */
const TIMEOUT_PER_5K_CHARS_MS = 10_000;

/** Hard cap for the adaptive timeout (ms). */
const MAX_TIMEOUT_MS = 90_000;

/** Maximum retry attempts after the initial call. */
const MAX_RETRIES = 3;

/** Initial backoff delay between retries (ms). */
const INITIAL_RETRY_DELAY_MS = 1000;

/** Exponential backoff factor applied after each retry. */
const RETRY_BACKOFF_FACTOR = 2;

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

/** Calculate adaptive timeout based on prompt length (mirrors gemini). */
function calcTimeout(promptLength: number, overrideMs?: number): number {
  if (overrideMs) return overrideMs;
  const scaled = BASE_TIMEOUT_MS + Math.ceil(promptLength / 5000) * TIMEOUT_PER_5K_CHARS_MS;
  return Math.min(scaled, MAX_TIMEOUT_MS);
}

/**
 * Fetch with an adaptive timeout via AbortController. Timeouts are a hard
 * failure (never retried); pure network failures are classified as retryable.
 */
async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  activeController = controller;
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error: any) {
    if (timedOut) {
      throw new DeepSeekError(
        `Request timed out after ${ms / 1000}s. The email may be too long — try a shorter selection.`,
        DeepSeekErrorCode.TIMEOUT,
        false,
      );
    }
    if (controller.signal.aborted) {
      throw new DeepSeekError(
        'Request aborted.',
        DeepSeekErrorCode.ABORTED,
        false,
      );
    }
    throw new DeepSeekError(
      `Network error: ${error?.message ?? String(error)}`,
      DeepSeekErrorCode.NETWORK_ERROR,
      true,
    );
  } finally {
    clearTimeout(timer);
    if (activeController === controller) activeController = null;
  }
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
      'Rate limited by the DeepSeek API. Retrying with backoff…',
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

/**
 * Retry a function with exponential backoff. Only retries errors marked as
 * `retryable` (transient server / rate-limit / network failures) — never
 * empty responses, invalid keys, timeouts, or malformed payloads.
 */
async function retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: DeepSeekError | undefined;
  let delay = INITIAL_RETRY_DELAY_MS;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = classifyError(error);

      if (!lastError.retryable || attempt === MAX_RETRIES) {
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
  const modelName = options.model ?? getSetting('defaultModel') ?? 'deepseek-v4-flash';
  const timeoutMs = calcTimeout(prompt.length, options.timeoutMs);

  const callFn = async () => {
    const response = await fetchWithTimeout(
      'https://api.deepseek.com/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${deepseekApiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: 'user', content: prompt }],
          temperature: options.temperature ?? 1.0,
          max_tokens: options.maxOutputTokens ?? 2048,
        }),
      },
      timeoutMs,
    );

    if (!response.ok) {
      const errText = await response.text();
      throw classifyHttpError(response.status, errText);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text || !text.trim()) {
      throw new DeepSeekError(
        'The model returned an empty response.',
        DeepSeekErrorCode.EMPTY_RESPONSE,
        false,
      );
    }
    return text;
  };

  return retryWithBackoff(callFn);
}

export async function generateJson<T = Record<string, unknown>>(
  prompt: string,
  options: any = {},
): Promise<T> {
  if (!deepseekApiKey) {
    throw new Error('DeepSeek client not initialised. Call initDeepSeekClient first.');
  }
  const modelName = options.model ?? getSetting('defaultModel') ?? 'deepseek-v4-flash';
  const timeoutMs = calcTimeout(prompt.length, options.timeoutMs);

  const callFn = async () => {
    const response = await fetchWithTimeout(
      'https://api.deepseek.com/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${deepseekApiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            ...(options.systemInstruction ? [{ role: 'system', content: options.systemInstruction }] : []),
            { role: 'user', content: prompt },
          ],
          temperature: options.temperature ?? 0.1,
          max_tokens: options.maxOutputTokens ?? 1024,
          response_format: { type: 'json_object' },
        }),
      },
      timeoutMs,
    );

    if (!response.ok) {
      const errText = await response.text();
      throw classifyHttpError(response.status, errText);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text || !text.trim()) {
      throw new DeepSeekError(
        'The model returned an empty response.',
        DeepSeekErrorCode.EMPTY_RESPONSE,
        false,
      );
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]) as T;
      }
      throw new DeepSeekError(
        `Model returned invalid JSON: ${text.slice(0, 100)}`,
        DeepSeekErrorCode.INVALID_JSON,
        false,
      );
    }
  };

  return retryWithBackoff(callFn);
}

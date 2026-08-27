/**
 * AI Compose — Gemini Client Service
 *
 * Provides a typed interface to the Google GenAI (Gemini) API
 * with configurable parameters, rate-limiting with exponential backoff,
 * and granular error handling.
 *
 * Uses the @google/genai SDK (successor to @google/generative-ai).
 *
 * © Rizonetech (Pty) Ltd. — https://rizonesoft.com
 */

import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';
import { getSetting, ReasoningMode, MAX_RETRIES, INITIAL_RETRY_DELAY_MS, RETRY_BACKOFF_FACTOR } from '../features/settings';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configurable generation options passed to `generateText`. */
export interface GenerateOptions {
  /** Controls randomness. Lower = more deterministic. Range: 0.0–2.0. Default: 1.0 */
  temperature?: number;
  /** Maximum number of tokens in the response. Default: 2048 */
  maxOutputTokens?: number;
  /** Nucleus sampling. Range: 0.0–1.0. Default: 0.95 */
  topP?: number;
  /** Top-K sampling. Default: 40 */
  topK?: number;
  /** Which Gemini model to use. Default: user's saved setting or 'gemini-2.5-flash' */
  model?: string;
  /** Override the adaptive request timeout (ms). */
  timeoutMs?: number;
  /** Receive text deltas as the model streams (for progressive UI). */
  onStream?: (delta: string) => void;
  /** Number of automatic retries for transient failures. Default: 3. */
  maxRetries?: number;
  /** Reasoning effort. When omitted, falls back to the user's saved
   * `reasoningMode` setting ('off' by default). */
  reasoningMode?: ReasoningMode;
}

/** Options for structured JSON generation. */
export interface GenerateJsonOptions {
  /** Controls randomness. Default: 0.1 */
  temperature?: number;
  /** Maximum number of tokens in the response. Default: 200 */
  maxOutputTokens?: number;
  /** Which Gemini model to use. Default: user's saved setting or 'gemini-2.5-flash' */
  model?: string;
  /** System instruction for the model. */
  systemInstruction?: string;
  /** JSON schema describing the expected response shape. */
  responseSchema?: Record<string, unknown>;
  /** Override the adaptive request timeout (ms). */
  timeoutMs?: number;
  /** Receive text deltas as the model streams (for progressive UI). */
  onStream?: (delta: string) => void;
  /** Number of automatic retries for transient failures. Default: 3. */
  maxRetries?: number;
  /** Reasoning effort. Falls back to the user's saved `reasoningMode`. */
  reasoningMode?: ReasoningMode;
}

/** Error codes surfaced by the Gemini service. */
export enum GeminiErrorCode {
  INVALID_API_KEY = 'INVALID_API_KEY',
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  RATE_LIMITED = 'RATE_LIMITED',
  NETWORK_ERROR = 'NETWORK_ERROR',
  TIMEOUT = 'TIMEOUT',
  CONTENT_FILTERED = 'CONTENT_FILTERED',
  UNKNOWN = 'UNKNOWN',
}

/** Typed error thrown by the Gemini service. */
export class GeminiError extends Error {
  code: GeminiErrorCode;
  retryable: boolean;
  statusCode?: number;

  constructor(message: string, code: GeminiErrorCode, retryable = false, statusCode?: number) {
    super(message);
    this.name = 'GeminiError';
    this.code = code;
    this.retryable = retryable;
    this.statusCode = statusCode;
    // Fix prototype chain for ES5 targets (TypeScript class extending Error)
    Object.setPrototypeOf(this, GeminiError.prototype);
  }
}

// Re-export Type for use in callers (e.g. scoreEmail responseSchema)
export { Type };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FALLBACK_MODEL = 'gemini-3-flash-preview';

/**
 * Fast, non-thinking model for simple extraction/utility tasks
 * (translation, action items, summarization, language detection).
 * These tasks don't benefit from deep reasoning and need low latency.
 */
export const FAST_MODEL = 'gemini-3-flash-preview';

const DEFAULT_TEMPERATURE = 1.0;
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
const DEFAULT_TOP_P = 0.95;
const DEFAULT_TOP_K = 40;

// Streaming health-monitoring tiers. All times are wall-clock and are not
// affected by prompt size — a model that goes quiet is hanging regardless of
// how long the input was.
const CONNECT_TIMEOUT_MS = 30_000; // No first data at all (network/host issue).
const STALL_TIMEOUT_MS = 60_000; // No new data after the stream started.
const OVERALL_TIMEOUT_MS = 300_000; // Hard ceiling for the whole response.

// ---------------------------------------------------------------------------
// Client singleton
// ---------------------------------------------------------------------------

let clientInstance: GoogleGenAI | null = null;

/**
 * Initialise (or reinitialise) the Gemini client with the given API key.
 * Returns the `GoogleGenAI` instance for direct access if needed.
 */
export function initGeminiClient(apiKey: string): GoogleGenAI {
  if (!apiKey || apiKey.trim().length === 0) {
    throw new GeminiError(
      'API key is required. Please set GEMINI_API_KEY in your .env file.',
      GeminiErrorCode.INVALID_API_KEY,
    );
  }
  clientInstance = new GoogleGenAI({ apiKey });
  return clientInstance;
}

/**
 * Returns the current client instance, or throws if `initGeminiClient`
 * has not been called yet.
 */
function getClient(): GoogleGenAI {
  if (!clientInstance) {
    throw new GeminiError(
      'Gemini client not initialised. Call initGeminiClient(apiKey) first.',
      GeminiErrorCode.INVALID_API_KEY,
    );
  }
  return clientInstance;
}

// ---------------------------------------------------------------------------
// Core generation functions
// ---------------------------------------------------------------------------

/**
 * Send a prompt to Gemini and return the generated text.
 *
 * @param prompt  - The user prompt string.
 * @param options - Optional generation parameters.
 * @returns The model's text response.
 *
 * @throws {GeminiError} with a typed `code` for every failure scenario.
 */
export async function generateText(
  prompt: string,
  options: GenerateOptions = {},
): Promise<string> {
  const client = getClient();
  const modelName = options.model ?? getSetting('defaultModel') ?? FALLBACK_MODEL;
  const reasoningMode = options.reasoningMode ?? getSetting('reasoningMode') ?? 'off';

  const callFn = async (): Promise<string> => {
    try {
      const { text, finishReason } = await collectModelStream(
        client.models.generateContentStream({
          model: modelName,
          contents: prompt,
          config: {
            temperature: options.temperature ?? DEFAULT_TEMPERATURE,
            maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
            topP: options.topP ?? DEFAULT_TOP_P,
            topK: options.topK ?? DEFAULT_TOP_K,
            thinkingConfig: resolveThinkingConfig(modelName, reasoningMode),
          },
        }),
        options.onStream,
      );

      if (!text || text.trim().length === 0) {
        throw emptyResponseError(finishReason);
      }

      return text;
    } catch (error) {
      if (error instanceof GeminiError) throw error;
      throw classifyError(error);
    }
  };

  return retryWithBackoff(callFn, options.maxRetries ?? MAX_RETRIES);
}

/**
 * Send a prompt to Gemini and return a structured JSON response.
 *
 * Uses `responseMimeType: 'application/json'` and `responseSchema` to
 * guarantee structured output from models that support JSON mode.
 *
 * @param prompt  - The user prompt string.
 * @param options - Options including schema and model config.
 * @returns The parsed JSON object.
 *
 * @throws {GeminiError} with a typed `code` for every failure scenario.
 */
export async function generateJson<T = Record<string, unknown>>(
  prompt: string,
  options: GenerateJsonOptions = {},
): Promise<T> {
  const client = getClient();
  const modelName = options.model ?? getSetting('defaultModel') ?? FALLBACK_MODEL;
  const reasoningMode = options.reasoningMode ?? getSetting('reasoningMode') ?? 'off';

  const callFn = async (): Promise<T> => {
    try {
      const { text, finishReason } = await collectModelStream(
        client.models.generateContentStream({
          model: modelName,
          contents: prompt,
          config: {
            temperature: options.temperature ?? 0.1,
            maxOutputTokens: options.maxOutputTokens ?? 1024,
            responseMimeType: 'application/json',
            responseSchema: options.responseSchema,
            systemInstruction: options.systemInstruction,
            // Disable thinking for structured JSON — thinking models burn
            // tokens from the maxOutputTokens budget on internal reasoning,
            // leaving too few for the actual JSON response.
            thinkingConfig: resolveThinkingConfig(modelName, reasoningMode),
          },
        }),
        options.onStream,
      );

      if (!text || text.trim().length === 0) {
        throw emptyResponseError(finishReason);
      }

      // Try direct JSON parse first, then extract JSON from text as fallback
      try {
        return JSON.parse(text) as T;
      } catch {
        // Some models wrap JSON in text like "Here is the JSON: {...}"
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]) as T;
        }
        throw new GeminiError(
          `Model returned invalid JSON: ${text.slice(0, 100)}`,
          GeminiErrorCode.UNKNOWN,
        );
      }
    } catch (error) {
      if (error instanceof GeminiError) throw error;
      throw classifyError(error);
    }
  };

  return retryWithBackoff(callFn, options.maxRetries ?? MAX_RETRIES);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Consume a model content stream and return the full text.
 *
 * Applies health monitoring to the stream:
 *  - Connect window: fails if no data arrives at all within `CONNECT_TIMEOUT_MS`.
 *  - Stall window: fails if the stream goes quiet for `STALL_TIMEOUT_MS`.
 *  - Overall ceiling: fails if the whole response exceeds `OVERALL_TIMEOUT_MS`.
 *
 * Also captures the model's `finishReason` from the final chunk (e.g.
 * `STOP`, `MAX_TOKENS`, `SAFETY`) so callers can report why generation
 * ended instead of only seeing an empty string.
 *
 * @param streamLike A promise (or value) resolving to an async iterable of
 *                   chunks exposing `text`. Accepts both the raw async
 *                   iterable and the SDK's stream result wrapper.
 * @param onStream   Optional callback invoked with each text delta.
 * @returns The accumulated text plus the last seen finish reason.
 * @throws {GeminiError} with `code = TIMEOUT` (non-retryable) on health failures.
 */
interface StreamChunk {
  text?: string;
  candidates?: Array<{ finishReason?: string }>;
}

async function collectModelStream(
  streamLike:
    | AsyncIterable<StreamChunk>
    | Promise<AsyncIterable<StreamChunk>>
    | Promise<{ stream: AsyncIterable<StreamChunk> }>,
  onStream?: (delta: string) => void,
): Promise<{ text: string; finishReason?: string }> {
  const resolved = await Promise.resolve(streamLike);
  const iterable: AsyncIterable<StreamChunk> =
    typeof (resolved as { stream?: AsyncIterable<StreamChunk> }).stream === 'object'
      ? (resolved as { stream: AsyncIterable<StreamChunk> }).stream
      : (resolved as AsyncIterable<StreamChunk>);

  let text = '';
  let finishReason: string | undefined;
  let firstByte = false;
  const startedAt = Date.now();

  // Awaiting the stream promise counts as part of the connect window.
  const iterator = iterable[Symbol.asyncIterator]();

  while (true) {
    const overallLeft = OVERALL_TIMEOUT_MS - (Date.now() - startedAt);
    if (overallLeft <= 0) {
      throw streamTimeoutError('overall');
    }

    const tierMs = firstByte ? STALL_TIMEOUT_MS : CONNECT_TIMEOUT_MS;
    const waitMs = Math.min(tierMs, overallLeft);

    let next: IteratorResult<StreamChunk>;
    try {
      next = await raceWithTimeout(iterator.next(), waitMs, () =>
        streamTimeoutError(firstByte ? 'stall' : 'connect'),
      );
    } catch (error) {
      if (error instanceof GeminiError) throw error;
      throw classifyError(error);
    }

    if (next.done) break;
    firstByte = true;

    const reason = next.value.candidates?.[0]?.finishReason;
    if (reason) finishReason = reason;

    const delta = next.value.text ?? '';
    if (delta) {
      text += delta;
      onStream?.(delta);
    }
  }

  return { text, finishReason };
}

/**
 * Map a normalized ReasoningMode onto the model's native thinking config.
 *
 * Gemini 2.5 series uses `thinkingBudget` (0 = disabled, -1 = dynamic, or an
 * explicit token count). Versioned Gemini 3 models (e.g. gemini-3.5-flash)
 * use `thinkingLevel` (MINIMAL/LOW/MEDIUM/HIGH).
 *
 * Ambiguous aliases such as `gemini-flash-latest` / `gemini-flash-lite-latest`
 * do NOT reliably accept `thinkingLevel` (some reject `MINIMAL`), so for those
 * we fall back to the broadly-compatible `thinkingBudget` knob, which is also
 * what `generateJson` already sends and is accepted across model families.
 *
 * Known limits (documented by Google):
 *  - Gemini 3 Flash / Flash-Lite cannot fully disable thinking; MINIMAL is the
 *    lowest level and still permits minimal reasoning on complex tasks.
 *  - Gemini 2.5 Pro cannot disable thinking; `thinkingBudget: 0` is best-effort.
 */
function resolveThinkingConfig(
  modelName: string,
  reasoningMode: ReasoningMode,
): { thinkingBudget?: number; thinkingLevel?: ThinkingLevel } {
  const isGemini25 = /gemini-2\.5/i.test(modelName);
  const isVersionedGemini3 = /^gemini-3[.\-]/i.test(modelName);
  const useBudget = isGemini25 || !isVersionedGemini3;

  if (useBudget) {
    if (reasoningMode === 'off') return { thinkingBudget: 0 };
    if (reasoningMode === 'high') return { thinkingBudget: 16384 };
    return { thinkingBudget: -1 };
  }

  if (reasoningMode === 'off') return { thinkingLevel: ThinkingLevel.MINIMAL };
  if (reasoningMode === 'high') return { thinkingLevel: ThinkingLevel.HIGH };
  return { thinkingLevel: ThinkingLevel.MEDIUM };
}

/**
 * Build the typed error thrown when the model returns no text, choosing a
 * message based on the stream's finish reason so the user gets a precise
 * explanation instead of a generic "empty response".
 */
function emptyResponseError(finishReason?: string): GeminiError {
  if (finishReason === 'SAFETY' || finishReason === 'RECITATION') {
    return new GeminiError(
      'The model returned an empty response. The content was blocked by safety filters.',
      GeminiErrorCode.CONTENT_FILTERED,
    );
  }
  if (finishReason === 'MAX_TOKENS') {
    return new GeminiError(
      'The model response was cut off because it reached the maximum output token limit. Try again, use a shorter request, or disable "Reasoning" mode.',
      GeminiErrorCode.CONTENT_FILTERED,
    );
  }
  return new GeminiError(
    'The model returned an empty response. The content may have been filtered.',
    GeminiErrorCode.CONTENT_FILTERED,
  );
}

/** Build a typed timeout error for one of the health-monitoring tiers. */
function streamTimeoutError(kind: 'connect' | 'stall' | 'overall'): GeminiError {  let message: string;
  if (kind === 'connect') {
    message = `No response from the model within ${CONNECT_TIMEOUT_MS / 1000}s — check your connection and try again.`;
  } else if (kind === 'stall') {
    message = `The model went quiet for ${STALL_TIMEOUT_MS / 1000}s with no new data — try again.`;
  } else {
    message = `The response did not finish within ${OVERALL_TIMEOUT_MS / 1000}s — try a shorter request.`;
  }
  // Not transient — retrying a hanging stream won't help.
  return new GeminiError(message, GeminiErrorCode.TIMEOUT, false);
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
      if (!settled) {
        settled = true;
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

/**
 * Retry a function with exponential backoff.
 * Only retries errors marked as `retryable`.
 */
async function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries: number = MAX_RETRIES): Promise<T> {
  let lastError: GeminiError | undefined;
  let delay = INITIAL_RETRY_DELAY_MS;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof GeminiError ? error : classifyError(error);

      if (!lastError.retryable || attempt === maxRetries) {
        throw lastError;
      }

      // Wait with jitter before retrying
      const jitter = Math.random() * 0.3 * delay;
      await sleep(delay + jitter);
      delay *= RETRY_BACKOFF_FACTOR;
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError!;
}

/** Classify raw errors into typed GeminiError instances. */
function classifyError(error: unknown): GeminiError {
  // Already classified
  if (error instanceof GeminiError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const statusCode = extractStatusCode(error);

  // Invalid / expired API key
  if (statusCode === 401 || statusCode === 403 || /api.?key/i.test(message)) {
    return new GeminiError(
      'Invalid or expired API key. Please check your GEMINI_API_KEY.',
      GeminiErrorCode.INVALID_API_KEY,
      false,
      statusCode,
    );
  }

  // Rate limited
  if (statusCode === 429 || /rate.?limit/i.test(message) || /too many requests/i.test(message)) {
    return new GeminiError(
      'Gemini API rate limit reached. Please wait a moment and try again.',
      GeminiErrorCode.RATE_LIMITED,
      true,
      429,
    );
  }

  // Quota exceeded
  if (statusCode === 429 && /quota/i.test(message)) {
    return new GeminiError(
      'API quota exceeded. Check your billing and quota settings in the Google Cloud Console.',
      GeminiErrorCode.QUOTA_EXCEEDED,
      false,
      429,
    );
  }

  // Network errors
  if (
    /network/i.test(message) ||
    /fetch failed/i.test(message) ||
    /ECONNREFUSED/i.test(message) ||
    /ENOTFOUND/i.test(message) ||
    /offline/i.test(message)
  ) {
    return new GeminiError(
      'Network error — please check your internet connection.',
      GeminiErrorCode.NETWORK_ERROR,
      true,
    );
  }

  // Content safety filter
  if (/safety/i.test(message) || /blocked/i.test(message) || /filter/i.test(message)) {
    return new GeminiError(
      'The response was blocked by content safety filters.',
      GeminiErrorCode.CONTENT_FILTERED,
      false,
    );
  }

  // Server errors (5xx) are retryable
  if (statusCode && statusCode >= 500) {
    return new GeminiError(
      `Server error (${statusCode}). Please wait a moment and try again.`,
      GeminiErrorCode.UNKNOWN,
      true,
      statusCode,
    );
  }

  // Unknown
  return new GeminiError(
    `Unexpected error: ${message}`,
    GeminiErrorCode.UNKNOWN,
    false,
    statusCode,
  );
}

/** Try to extract an HTTP status code from an error object. */
function extractStatusCode(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    if (typeof obj.status === 'number') return obj.status;
    if (typeof obj.statusCode === 'number') return obj.statusCode;
    if (typeof obj.code === 'number') return obj.code;
    // Google GenAI SDK sometimes nests it
    if (obj.response && typeof obj.response === 'object') {
      const resp = obj.response as Record<string, unknown>;
      if (typeof resp.status === 'number') return resp.status;
    }
  }
  return undefined;
}

/** Promise-based sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

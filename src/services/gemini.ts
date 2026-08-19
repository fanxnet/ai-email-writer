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

import { GoogleGenAI, Type } from '@google/genai';
import { getSetting } from '../features/settings';

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

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const RETRY_BACKOFF_FACTOR = 2;

const BASE_TIMEOUT_MS = 30_000;
const TIMEOUT_PER_5K_CHARS_MS = 10_000;
const MAX_TIMEOUT_MS = 90_000;

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

  const timeoutMs = calcTimeout(prompt.length, options.timeoutMs);

  const callFn = async (): Promise<string> => {
    try {
      const response = await withTimeout(
        client.models.generateContent({
          model: modelName,
          contents: prompt,
          config: {
            temperature: options.temperature ?? DEFAULT_TEMPERATURE,
            maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
            topP: options.topP ?? DEFAULT_TOP_P,
            topK: options.topK ?? DEFAULT_TOP_K,
          },
        }),
        timeoutMs,
      );

      const text = (response as { text?: string }).text;

      if (!text || text.trim().length === 0) {
        throw new GeminiError(
          'The model returned an empty response. The content may have been filtered.',
          GeminiErrorCode.CONTENT_FILTERED,
        );
      }

      return text;
    } catch (error) {
      throw classifyError(error);
    }
  };

  return retryWithBackoff(callFn);
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

  const timeoutMs = calcTimeout(prompt.length, options.timeoutMs);

  const callFn = async (): Promise<T> => {
    try {
      const response = await withTimeout(
        client.models.generateContent({
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
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
        timeoutMs,
      );

      const text = (response as { text?: string }).text;

      if (!text || text.trim().length === 0) {
        throw new GeminiError(
          'The model returned an empty response.',
          GeminiErrorCode.CONTENT_FILTERED,
        );
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

  return retryWithBackoff(callFn);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Calculate adaptive timeout based on prompt length. */
function calcTimeout(promptLength: number, overrideMs?: number): number {
  if (overrideMs) return overrideMs;
  const scaled = BASE_TIMEOUT_MS + Math.ceil(promptLength / 5000) * TIMEOUT_PER_5K_CHARS_MS;
  return Math.min(scaled, MAX_TIMEOUT_MS);
}

/** Wrap a promise with a timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new GeminiError(
          `Request timed out after ${ms / 1000}s. The email may be too long — try a shorter selection.`,
          GeminiErrorCode.TIMEOUT,
          false, // Timeouts on large prompts are not transient — don't retry
        ),
      );
    }, ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Retry a function with exponential backoff.
 * Only retries errors marked as `retryable`.
 */
async function retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: GeminiError | undefined;
  let delay = INITIAL_RETRY_DELAY_MS;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof GeminiError ? error : classifyError(error);

      if (!lastError.retryable || attempt === MAX_RETRIES) {
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
      'Rate limited by the Gemini API. Retrying with backoff…',
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
      `Server error (${statusCode}). Retrying…`,
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

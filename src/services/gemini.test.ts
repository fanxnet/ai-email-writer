/**
 * AI Compose — Gemini Service Unit Tests
 *
 * Tests the Gemini client service with mocked @google/genai SDK streams
 * to verify error handling, retry logic, generation behavior, and
 * streaming health monitoring.
 *
 * © Rizonetech (Pty) Ltd. — https://rizonesoft.com
 */

import {
  initGeminiClient,
  generateText,
  GeminiError,
  GeminiErrorCode,
} from './gemini';

// ---------------------------------------------------------------------------
// Mock the @google/genai module
// ---------------------------------------------------------------------------

const mockGenerateContentStream = jest.fn();

jest.mock('@google/genai', () => {
  return {
    GoogleGenAI: jest.fn().mockImplementation(() => ({
      models: {
        generateContentStream: mockGenerateContentStream,
      },
    })),
    Type: {
      STRING: 'STRING',
      NUMBER: 'NUMBER',
      BOOLEAN: 'BOOLEAN',
      OBJECT: 'OBJECT',
      ARRAY: 'ARRAY',
    },
    ThinkingLevel: {
      MINIMAL: 'MINIMAL',
      LOW: 'LOW',
      MEDIUM: 'MEDIUM',
      HIGH: 'HIGH',
    },
  };
});

// Mock settings to avoid side-effect import issues
jest.mock('../features/settings', () => ({
  getSetting: jest.fn().mockReturnValue(null),
  MAX_RETRIES: 0,
  INITIAL_RETRY_DELAY_MS: 1000,
  RETRY_BACKOFF_FACTOR: 2,
}));

// ---------------------------------------------------------------------------
// Streaming mock helpers
// ---------------------------------------------------------------------------

/** Build an async iterable (as returned by generateContentStream) that yields
 * `text` chunks, with an optional per-chunk delay (works with fake timers). */
function streamOf(chunks: string[], perChunkDelayMs = 0): Promise<AsyncIterable<{ text?: string }>> {
  return Promise.resolve(
    (async function* () {
      for (const chunk of chunks) {
        if (perChunkDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, perChunkDelayMs));
        }
        yield { text: chunk };
      }
    })(),
  );
}

/** Like streamOf but attaches a `candidates[0].finishReason` on the final
 * chunk so callers can inspect the model's stop reason. */
function streamOfWithFinish(
  chunks: string[],
  finishReason: string,
): Promise<AsyncIterable<{ text?: string; candidates?: Array<{ finishReason?: string }> }>> {
  return Promise.resolve(
    (async function* () {
      for (let i = 0; i < chunks.length; i++) {
        const last = i === chunks.length - 1;
        yield {
          text: chunks[i],
          ...(last ? { candidates: [{ finishReason }] } : {}),
        };
      }
    })(),
  );
}

/** An async iterable that never produces data (for connect/stall tests). */
function hangingStream(yieldFirst = false): Promise<AsyncIterable<{ text?: string }>> {
  return Promise.resolve(
    (async function* () {
      if (yieldFirst) {
        yield { text: 'partial' };
      }
      await new Promise(() => {}); // hang forever
    })(),
  );
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockGenerateContentStream.mockReset();
  initGeminiClient('test-api-key-123');
});

// ---------------------------------------------------------------------------
// initGeminiClient
// ---------------------------------------------------------------------------

describe('initGeminiClient', () => {
  it('should throw GeminiError for empty API key', () => {
    expect(() => initGeminiClient('')).toThrow(GeminiError);
    expect(() => initGeminiClient('')).toThrow(/API key is required/);
  });

  it('should throw GeminiError for whitespace-only API key', () => {
    expect(() => initGeminiClient('   ')).toThrow(GeminiError);
  });

  it('should return a client instance for a valid key', () => {
    const client = initGeminiClient('valid-key');
    expect(client).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// generateText — successful responses
// ---------------------------------------------------------------------------

describe('generateText — success', () => {
  it('should return generated text from a successful stream', async () => {
    mockGenerateContentStream.mockReturnValue(
      streamOf(['Hello, this is a summary of your email.']),
    );

    const result = await generateText('Summarize this email');
    expect(result).toBe('Hello, this is a summary of your email.');
    expect(mockGenerateContentStream).toHaveBeenCalled();
  });

  it('should aggregate text across multiple stream chunks', async () => {
    mockGenerateContentStream.mockReturnValue(streamOf(['Hello, ', 'this is ', 'a summary.']));

    const result = await generateText('Summarize this email');
    expect(result).toBe('Hello, this is a summary.');
  });

  it('should deliver text deltas progressively via onStream', async () => {
    mockGenerateContentStream.mockReturnValue(streamOf(['Hello, ', 'world!']));

    const deltas: string[] = [];
    await generateText('Test prompt', { onStream: (d) => deltas.push(d) });

    expect(deltas).toEqual(['Hello, ', 'world!']);
  });

  it('should pass custom generation options', async () => {
    mockGenerateContentStream.mockReturnValue(streamOf(['Generated response with custom params.']));

    const result = await generateText('Test prompt', {
      temperature: 0.5,
      maxOutputTokens: 1024,
      topP: 0.8,
      topK: 20,
    });

    expect(result).toBe('Generated response with custom params.');
  });
});

// ---------------------------------------------------------------------------
// generateText — thinking config (Reasoning Mode)
// ---------------------------------------------------------------------------

describe('generateText — reasoning mode', () => {
  it('disables thinking for gemini-3 models when reasoning is off', async () => {
    mockGenerateContentStream.mockReturnValue(streamOf(['Reply text.']));

    await generateText('Test prompt', { reasoningMode: 'off' });

    const config = mockGenerateContentStream.mock.calls[0][0].config;
    expect(config.thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL' });
  });

  it('uses thinkingBudget 0 for gemini-2.5 models when reasoning is off', async () => {
    mockGenerateContentStream.mockReturnValue(streamOf(['Reply text.']));

    await generateText('Test prompt', { model: 'gemini-2.5-pro', reasoningMode: 'off' });

    const config = mockGenerateContentStream.mock.calls[0][0].config;
    expect(config.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it('uses dynamic thinking for balanced mode', async () => {
    mockGenerateContentStream.mockReturnValue(streamOf(['Reply text.']));

    await generateText('Test prompt', { model: 'gemini-2.5-pro', reasoningMode: 'balanced' });

    const config = mockGenerateContentStream.mock.calls[0][0].config;
    expect(config.thinkingConfig).toEqual({ thinkingBudget: -1 });
  });

  it('uses HIGH thinking level for high mode on gemini-3 models', async () => {
    mockGenerateContentStream.mockReturnValue(streamOf(['Reply text.']));

    await generateText('Test prompt', { model: 'gemini-3.5-flash', reasoningMode: 'high' });

    const config = mockGenerateContentStream.mock.calls[0][0].config;
    expect(config.thinkingConfig).toEqual({ thinkingLevel: 'HIGH' });
  });

  it('falls back to thinkingBudget for ambiguous aliases like gemini-flash-latest', async () => {
    mockGenerateContentStream.mockReturnValue(streamOf(['Reply text.']));

    await generateText('Test prompt', { model: 'gemini-flash-latest', reasoningMode: 'off' });

    const config = mockGenerateContentStream.mock.calls[0][0].config;
    expect(config.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });
});

// ---------------------------------------------------------------------------
// generateText — error handling
// ---------------------------------------------------------------------------

describe('generateText — error handling', () => {
  it('should throw INVALID_API_KEY for 401 errors', async () => {
    const error = new Error('API key not valid');
    (error as any).status = 401;
    mockGenerateContentStream.mockRejectedValue(error);

    await expect(generateText('test')).rejects.toMatchObject({
      code: GeminiErrorCode.INVALID_API_KEY,
      retryable: false,
    });
  });

  it('should throw INVALID_API_KEY for 403 errors', async () => {
    const error = new Error('Permission denied');
    (error as any).status = 403;
    mockGenerateContentStream.mockRejectedValue(error);

    await expect(generateText('test')).rejects.toMatchObject({
      code: GeminiErrorCode.INVALID_API_KEY,
      retryable: false,
    });
  });

  it('should throw CONTENT_FILTERED for empty responses', async () => {
    mockGenerateContentStream.mockReturnValue(streamOf(['']));

    await expect(generateText('test')).rejects.toMatchObject({
      code: GeminiErrorCode.CONTENT_FILTERED,
    });
  });

  it('reports a truncated response when finishReason is MAX_TOKENS and text is empty', async () => {
    mockGenerateContentStream.mockReturnValue(streamOfWithFinish([''], 'MAX_TOKENS'));

    await expect(generateText('test')).rejects.toMatchObject({
      code: GeminiErrorCode.CONTENT_FILTERED,
      message: expect.stringContaining('token limit'),
    });
  });

  it('reports a safety-blocked response when finishReason is SAFETY and text is empty', async () => {
    mockGenerateContentStream.mockReturnValue(streamOfWithFinish([''], 'SAFETY'));

    await expect(generateText('test')).rejects.toMatchObject({
      code: GeminiErrorCode.CONTENT_FILTERED,
      message: expect.stringContaining('safety filters'),
    });
  });

  it('should throw NETWORK_ERROR for fetch failures', async () => {
    mockGenerateContentStream.mockRejectedValue(new Error('fetch failed'));

    await expect(generateText('test')).rejects.toMatchObject({
      code: GeminiErrorCode.NETWORK_ERROR,
      retryable: true,
    });
  }, 30_000);

  it('should throw CONTENT_FILTERED for safety filter blocks', async () => {
    mockGenerateContentStream.mockRejectedValue(
      new Error('Response blocked by safety filter'),
    );

    await expect(generateText('test')).rejects.toMatchObject({
      code: GeminiErrorCode.CONTENT_FILTERED,
      retryable: false,
    });
  });
});

// ---------------------------------------------------------------------------
// generateText — retry behavior
// ---------------------------------------------------------------------------

describe('generateText — retry with backoff', () => {
  it('should retry rate-limited requests and succeed', async () => {
    const rateLimitError = new Error('Too many requests');
    (rateLimitError as any).status = 429;

    mockGenerateContentStream
      .mockRejectedValueOnce(rateLimitError)
      .mockRejectedValueOnce(rateLimitError)
      .mockImplementation(() => streamOf(['Success after retries!']));

    const result = await generateText('test', { maxRetries: 3 });
    expect(result).toBe('Success after retries!');
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(3);
  }, 30_000);

  it('should retry server errors (5xx) and succeed', async () => {
    const serverError = new Error('Internal server error');
    (serverError as any).status = 500;

    mockGenerateContentStream
      .mockRejectedValueOnce(serverError)
      .mockImplementation(() => streamOf(['Recovered from server error.']));

    const result = await generateText('test', { maxRetries: 2 });
    expect(result).toBe('Recovered from server error.');
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(2);
  }, 15_000);

  it('should not retry non-retryable errors', async () => {
    const authError = new Error('Invalid API key');
    (authError as any).status = 401;

    mockGenerateContentStream.mockRejectedValue(authError);

    await expect(generateText('test')).rejects.toMatchObject({
      code: GeminiErrorCode.INVALID_API_KEY,
    });
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(1);
  });

  it('should throw after exhausting all retries', async () => {
    const rateLimitError = new Error('Too many requests');
    (rateLimitError as any).status = 429;

    mockGenerateContentStream.mockRejectedValue(rateLimitError);

    await expect(generateText('test', { maxRetries: 3 })).rejects.toMatchObject({
      code: GeminiErrorCode.RATE_LIMITED,
    });
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(4);
  }, 60_000);

  it('should not retry at all when maxRetries is 0', async () => {
    const rateLimitError = new Error('Too many requests');
    (rateLimitError as any).status = 429;

    mockGenerateContentStream.mockRejectedValue(rateLimitError);

    await expect(generateText('test', { maxRetries: 0 })).rejects.toMatchObject({
      code: GeminiErrorCode.RATE_LIMITED,
    });
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Streaming health monitoring (fake timers)
// ---------------------------------------------------------------------------

describe('streaming health monitoring', () => {
  const CONNECT_MS = 30_000;
  const STALL_MS = 60_000;
  const OVERALL_MS = 300_000;

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should throw TIMEOUT when no data arrives at all (connect window)', async () => {
    jest.useFakeTimers();
    mockGenerateContentStream.mockReturnValue(hangingStream());

    const promise = generateText('test');
    const matcher = expect(promise).rejects.toMatchObject({
      code: GeminiErrorCode.TIMEOUT,
      retryable: false,
    });

    await jest.advanceTimersByTimeAsync(CONNECT_MS + 500);
    await matcher;
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(1);
  });

  it('should throw TIMEOUT when the stream stalls for the stall window', async () => {
    jest.useFakeTimers();
    mockGenerateContentStream.mockReturnValue(hangingStream(true));

    const promise = generateText('test');
    const matcher = expect(promise).rejects.toMatchObject({
      code: GeminiErrorCode.TIMEOUT,
      retryable: false,
    });

    await jest.advanceTimersByTimeAsync(STALL_MS + 500);
    await matcher;
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(1);
  });

  it('should throw TIMEOUT when the response exceeds the overall ceiling', async () => {
    jest.useFakeTimers();
    // Trickle data slowly but indefinitely; only the overall ceiling stops it.
    mockGenerateContentStream.mockReturnValue(streamOf(Array(100).fill('x'), 10_000));

    const promise = generateText('test');
    const matcher = expect(promise).rejects.toMatchObject({
      code: GeminiErrorCode.TIMEOUT,
      retryable: false,
    });

    await jest.advanceTimersByTimeAsync(OVERALL_MS + 20_000);
    await matcher;
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// generateText — uninitialised client
// ---------------------------------------------------------------------------

describe('generateText — uninitialised client', () => {
  it('should throw if client was never initialised', async () => {
    jest.resetModules();
    const freshModule = await import('./gemini');

    await expect(freshModule.generateText('test')).rejects.toMatchObject({
      code: GeminiErrorCode.INVALID_API_KEY,
    });
  });
});
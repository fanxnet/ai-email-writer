/**
 * AI Compose — DeepSeek Service Unit Tests
 *
 * Covers the client with mocked fetch responses: happy path, error
 * classification, retry behaviour (transient vs permanent failures),
 * streaming health monitoring (connect / stall / overall timeouts),
 * progressive deltas, and aborts.
 */

import {
  initDeepSeekClient,
  abortDeepSeekRequest,
  generateText,
  generateJson,
  DeepSeekError,
  DeepSeekErrorCode,
} from './deepseek';

// ---------------------------------------------------------------------------
// fetch mock
// ---------------------------------------------------------------------------

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

/** Build a streaming Response-like object from SSE `data:` payload strings. */
function sseResponse(
  sseChunks: string[],
  ok = true,
  status = 200,
  errBody = '',
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of sseChunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return {
    ok,
    status,
    body,
    text: async () => errBody || sseChunks.join(''),
  } as unknown as Response;
}

/** One SSE delta for a content chunk. */
function delta(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

const DONE = 'data: [DONE]\n\n';

/** A fetch that never resolves until aborted (for abort/timeout tests). */
function abortAwareResponse(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
  });
}

beforeEach(() => {
  initDeepSeekClient('sk-test-key-123');
  mockFetch.mockReset();
});

// ---------------------------------------------------------------------------
// initDeepSeekClient
// ---------------------------------------------------------------------------

describe('initDeepSeekClient', () => {
  it('throws for an empty API key', () => {
    expect(() => initDeepSeekClient('')).toThrow(/API key is required/);
  });

  it('throws for a whitespace-only API key', () => {
    expect(() => initDeepSeekClient('   ')).toThrow(/API key is required/);
  });
});

// ---------------------------------------------------------------------------
// generateText / generateJson happy path
// ---------------------------------------------------------------------------

describe('generateText', () => {
  it('returns the streamed assistant message content on success', async () => {
    mockFetch.mockResolvedValue(
      sseResponse([delta('Hello '), delta('there!'), DONE]),
    );

    await expect(generateText('Say hi', { model: 'deepseek-chat' })).resolves.toBe(
      'Hello there!',
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [, init] = mockFetch.mock.calls[0];
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('deepseek-chat');
    expect(body.messages).toEqual([{ role: 'user', content: 'Say hi' }]);
    expect(body.stream).toBe(true);
  });

  it('delivers text deltas progressively via onStream', async () => {
    mockFetch.mockResolvedValue(sseResponse([delta('Hello '), delta('there!'), DONE]));

    const deltas: string[] = [];
    await generateText('Say hi', { model: 'deepseek-chat', onStream: (d) => deltas.push(d) });

    expect(deltas).toEqual(['Hello ', 'there!']);
  });

  it('handles SSE lines split across chunk boundaries', async () => {
    // The first delta is split mid-sequence across two network chunks.
    mockFetch.mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"con',
        'tent":"Hi"}}]}\n\ndata: [DONE]\n\n',
      ]),
    );

    await expect(generateText('Say hi', { model: 'deepseek-chat' })).resolves.toBe('Hi');
  });

  it('does not retry an empty response (only one request is sent)', async () => {
    mockFetch.mockResolvedValue(sseResponse([DONE]));

    await expect(generateText('Say hi', { model: 'deepseek-chat' })).rejects.toMatchObject({
      name: 'DeepSeekError',
      code: DeepSeekErrorCode.EMPTY_RESPONSE,
      retryable: false,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('throws a non-retryable INVALID_API_KEY error for 401 responses', async () => {
    mockFetch.mockResolvedValue(sseResponse([], false, 401, '{"error":"unauthorized"}'));

    await expect(generateText('Say hi', { model: 'deepseek-chat' })).rejects.toMatchObject({
      code: DeepSeekErrorCode.INVALID_API_KEY,
      retryable: false,
      statusCode: 401,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// generateJson
// ---------------------------------------------------------------------------

describe('generateJson', () => {
  it('parses a valid JSON object response', async () => {
    mockFetch.mockResolvedValue(sseResponse([delta('{"ok":true}'), DONE]));

    await expect(generateJson('Return JSON', { model: 'deepseek-chat' })).resolves.toEqual({
      ok: true,
    });
  });

  it('extracts JSON embedded in prose text', async () => {
    mockFetch.mockResolvedValue(sseResponse([delta('Here you go: {"ok":true}'), DONE]));

    await expect(generateJson('Return JSON', { model: 'deepseek-chat' })).resolves.toEqual({
      ok: true,
    });
  });

  it('throws a non-retryable INVALID_JSON error for unparseable output', async () => {
    mockFetch.mockResolvedValue(sseResponse([delta('not json at all'), DONE]));

    await expect(generateJson('Return JSON', { model: 'deepseek-chat' })).rejects.toMatchObject({
      code: DeepSeekErrorCode.INVALID_JSON,
      retryable: false,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Retry with backoff (fake timers)
// ---------------------------------------------------------------------------

describe('retryWithBackoff', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('retries a transient 5xx error up to 4 times then throws', async () => {
    mockFetch.mockResolvedValue(sseResponse([], false, 500, 'boom'));

    const promise = generateText('Say hi', { model: 'deepseek-chat' });
    const matcher = expect(promise).rejects.toMatchObject({
      code: DeepSeekErrorCode.API_ERROR,
      retryable: true,
    });

    await jest.advanceTimersByTimeAsync(100_000);
    await matcher;
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('retries rate-limited (429) responses', async () => {
    mockFetch.mockResolvedValue(sseResponse([], false, 429, 'slow down'));

    const promise = generateText('Say hi', { model: 'deepseek-chat' });
    const matcher = expect(promise).rejects.toMatchObject({
      code: DeepSeekErrorCode.RATE_LIMITED,
      retryable: true,
    });

    await jest.advanceTimersByTimeAsync(100_000);
    await matcher;
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('succeeds on the first retry after a transient failure', async () => {
    mockFetch
      .mockResolvedValueOnce(sseResponse([], false, 500, 'boom'))
      .mockResolvedValueOnce(sseResponse([delta('recovered'), DONE]));

    const promise = generateText('Say hi', { model: 'deepseek-chat' });
    await jest.advanceTimersByTimeAsync(100_000);

    await expect(promise).resolves.toBe('recovered');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry at all when maxRetries is 0', async () => {
    mockFetch.mockResolvedValue(sseResponse([], false, 429, 'slow down'));

    const promise = generateText('Say hi', { model: 'deepseek-chat', maxRetries: 0 });
    const matcher = expect(promise).rejects.toMatchObject({
      code: DeepSeekErrorCode.RATE_LIMITED,
    });

    await jest.advanceTimersByTimeAsync(100_000);
    await matcher;
    expect(mockFetch).toHaveBeenCalledTimes(1);
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

  it('throws a non-retryable TIMEOUT when response headers never arrive (connect)', async () => {
    jest.useFakeTimers();
    mockFetch.mockImplementation((_url: string, init?: RequestInit) =>
      abortAwareResponse((init as RequestInit).signal as AbortSignal),
    );

    const promise = generateText('Say hi', { model: 'deepseek-chat' });
    const matcher = expect(promise).rejects.toMatchObject({
      code: DeepSeekErrorCode.TIMEOUT,
      retryable: false,
    });

    await jest.advanceTimersByTimeAsync(CONNECT_MS + 500);
    await matcher;
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('throws a non-retryable TIMEOUT when the body stalls (no data for 60s)', async () => {
    jest.useFakeTimers();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(delta('first ')));
        // Never close — simulates the model going quiet mid-stream.
      },
    });
    mockFetch.mockResolvedValue({ ok: true, status: 200, body } as unknown as Response);

    const promise = generateText('Say hi', { model: 'deepseek-chat' });
    const matcher = expect(promise).rejects.toMatchObject({
      code: DeepSeekErrorCode.TIMEOUT,
      retryable: false,
    });

    await jest.advanceTimersByTimeAsync(STALL_MS + 500);
    await matcher;
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('throws a non-retryable TIMEOUT when the whole response exceeds the ceiling', async () => {
    jest.useFakeTimers();
    const encoder = new TextEncoder();
    // Keep trickling data indefinitely, but slow enough to exceed OVERALL.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode(delta('x')));
        return new Promise((r) => setTimeout(r, 10_000));
      },
    });
    mockFetch.mockResolvedValue({ ok: true, status: 200, body } as unknown as Response);

    const promise = generateText('Say hi', { model: 'deepseek-chat' });
    const matcher = expect(promise).rejects.toMatchObject({
      code: DeepSeekErrorCode.TIMEOUT,
      retryable: false,
    });

    await jest.advanceTimersByTimeAsync(OVERALL_MS + 10_000);
    await matcher;
  });
});

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

describe('abort', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('aborts the in-flight request and rejects with ABORTED', async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) =>
      abortAwareResponse((init as RequestInit).signal as AbortSignal),
    );

    const promise = generateText('Say hi', { model: 'deepseek-chat' });
    await Promise.resolve(); // let the fetch start
    abortDeepSeekRequest();

    await expect(promise).rejects.toMatchObject({
      name: 'DeepSeekError',
      code: DeepSeekErrorCode.ABORTED,
      retryable: false,
    });
  });
});
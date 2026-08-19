/**
 * AI Compose — DeepSeek Service Unit Tests
 *
 * Covers the client with mocked fetch responses: happy path, error
 * classification, retry behaviour (transient vs permanent failures),
 * adaptive timeouts, and aborts.
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

/** Build a minimal Response-like object the service consumes. */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function abortAwareResponse(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      const err = new DOMException('The operation was aborted.', 'AbortError');
      reject(err);
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
  it('returns the assistant message content on success', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      choices: [{ message: { content: 'Hello there!' } }],
    }));

    await expect(generateText('Say hi', { model: 'deepseek-chat' })).resolves.toBe('Hello there!');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [, init] = mockFetch.mock.calls[0];
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('deepseek-chat');
    expect(body.messages).toEqual([{ role: 'user', content: 'Say hi' }]);
  });

  it('does not retry an empty response (only one request is sent)', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: '' } }] }));

    await expect(generateText('Say hi', { model: 'deepseek-chat' })).rejects.toMatchObject({
      name: 'DeepSeekError',
      code: DeepSeekErrorCode.EMPTY_RESPONSE,
      retryable: false,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('throws a non-retryable INVALID_API_KEY error for 401 responses', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'unauthorized' }, false, 401));

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
    mockFetch.mockResolvedValue(jsonResponse({
      choices: [{ message: { content: '{"ok":true}' } }],
    }));

    await expect(generateJson('Return JSON', { model: 'deepseek-chat' })).resolves.toEqual({ ok: true });
  });

  it('extracts JSON embedded in prose text', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      choices: [{ message: { content: 'Here you go: {"ok":true}' } }],
    }));

    await expect(generateJson('Return JSON', { model: 'deepseek-chat' })).resolves.toEqual({ ok: true });
  });

  it('throws a non-retryable INVALID_JSON error for unparseable output', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      choices: [{ message: { content: 'not json at all' } }],
    }));

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
    mockFetch.mockResolvedValue(jsonResponse({ error: 'boom' }, false, 500));

    const promise = generateText('Say hi', { model: 'deepseek-chat' });
    // Attach the rejection handler before advancing clocks so the rejection is
    // never flagged as unhandled.
    const matcher = expect(promise).rejects.toMatchObject({
      code: DeepSeekErrorCode.API_ERROR,
      retryable: true,
    });

    await jest.advanceTimersByTimeAsync(100_000);
    await matcher;
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('retries rate-limited (429) responses', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'slow down' }, false, 429));

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
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, false, 500))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'recovered' } }] }));

    const promise = generateText('Say hi', { model: 'deepseek-chat' });
    await jest.advanceTimersByTimeAsync(100_000);

    await expect(promise).resolves.toBe('recovered');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe('timeouts', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('aborts and throws a non-retryable TIMEOUT when the request exceeds the limit', async () => {
    jest.useFakeTimers();
    mockFetch.mockImplementation((_url: string, init?: RequestInit) =>
      abortAwareResponse((init as RequestInit).signal as AbortSignal),
    );

    const promise = generateText('Say hi', { model: 'deepseek-chat', timeoutMs: 1000 });
    const matcher = expect(promise).rejects.toMatchObject({
      code: DeepSeekErrorCode.TIMEOUT,
      retryable: false,
    });

    await jest.advanceTimersByTimeAsync(1100);
    await matcher;
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('aborts the in-flight request and rejects with ABORTED', async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) =>
      abortAwareResponse((init as RequestInit).signal as AbortSignal),
    );

    const promise = generateText('Say hi', { model: 'deepseek-chat', timeoutMs: 60_000 });
    await Promise.resolve(); // let the fetch start
    abortDeepSeekRequest();

    await expect(promise).rejects.toMatchObject({
      name: 'DeepSeekError',
      code: DeepSeekErrorCode.ABORTED,
      retryable: false,
    });
  });
});
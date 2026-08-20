/**
 * AI Compose — Conversation Memory Unit Tests
 *
 * Covers append/dedup logic, prompt-window building, email summarization,
 * compaction, and the lazy sweep (TTL, record cap, byte budget).
 *
 * © Rizonetech (Pty) Ltd. — https://rizonesoft.com
 */

import {
  getConversation,
  appendTurn,
  clearConversation,
  clearAllConversations,
  buildReplyContext,
  buildReplyContextText,
  buildEmailRef,
  getEmailContextBlock,
  compactIfNeeded,
  rememberLastRequest,
  getLastAssistantReply,
  ConversationTurn,
} from './conversation-memory';

jest.mock('../services/ai-service', () => ({ generateText: jest.fn() }));
import { generateText as generateTextMockValue } from '../services/ai-service';

const mockGenerateText = generateTextMockValue as jest.Mock;

// ---------------------------------------------------------------------------
// localStorage mock (node test env)
// ---------------------------------------------------------------------------

class MemoryStorage {
  private data: Record<string, string> = {};
  getItem(key: string): string | null {
    return key in this.data ? this.data[key] : null;
  }
  setItem(key: string, value: string): void {
    this.data[key] = String(value);
  }
  removeItem(key: string): void {
    delete this.data[key];
  }
  clear(): void {
    this.data = {};
  }
  get length(): number {
    return Object.keys(this.data).length;
  }
  key(index: number): string | null {
    return Object.keys(this.data)[index] ?? null;
  }
}

const readStore = (): Record<string, unknown> =>
  JSON.parse((globalThis as any).localStorage.getItem('aic_conversations') || '{}');

const buildTurn = (role: 'user' | 'assistant', content: string, ts: number): ConversationTurn => ({
  role,
  content,
  ts,
});

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let now = 1_000_000_000_000;
let nowSpy: jest.SpyInstance;

beforeEach(() => {
  (globalThis as any).localStorage = new MemoryStorage();
  mockGenerateText.mockReset();
  mockGenerateText.mockResolvedValue('mock reply');
  now = 1_000_000_000_000;
  nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
  nowSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// appendTurn
// ---------------------------------------------------------------------------

describe('appendTurn', () => {
  it('appends user and assistant turns', () => {
    appendTurn('k1', 'user', 'Si want a reply');
    appendTurn('k1', 'assistant', 'Here is the reply');

    const rec = getConversation('k1');
    expect(rec.entries).toHaveLength(2);
    expect(rec.entries[0]).toMatchObject({ role: 'user', content: 'Si want a reply' });
    expect(rec.entries[1]).toMatchObject({ role: 'assistant', content: 'Here is the reply' });
  });

  it('replaces the trailing assistant turn when the same instruction is repeated (regenerate)', () => {
    appendTurn('k2', 'user', 'Same question');
    appendTurn('k2', 'assistant', 'Old reply');
    appendTurn('k2', 'user', 'Same question');
    appendTurn('k2', 'assistant', 'New reply');

    const rec = getConversation('k2');
    expect(rec.entries).toHaveLength(2);
    expect(rec.entries[1].content).toBe('New reply');
  });

  it('caps the stored length of user content and keeps longer assistant replies', () => {
    appendTurn('k3', 'user', 'x'.repeat(2000));
    appendTurn('k3', 'assistant', 'y'.repeat(1200));

    const rec = getConversation('k3');
    expect(rec.entries[0].content).toHaveLength(1500);
    // Assistant replies are retained in full (no 1000-char truncation) so
    // long drafts survive re-entry / refinement unchanged.
    expect(rec.entries[1].content).toHaveLength(1200);
  });

  it('retains a long Chinese instruction in full (no aggressive truncation)', () => {
    // 320 Chinese characters — well under the 1500-char ceiling, but the old
    // 200-char store / 100-char inject caps would have lost the tail.
    const instruction = '请'.repeat(320);
    appendTurn('k5', 'user', instruction);

    const rec = getConversation('k5');
    expect(rec.entries[0].content).toBe(instruction);

    const block = buildReplyContext('k5');
    expect(block.recent).toContain('You: ' + instruction);
  });

  it('still caps assistant content at the storage ceiling', () => {
    appendTurn('k4', 'assistant', 'z'.repeat(20000));

    const rec = getConversation('k4');
    expect(rec.entries[0].content).toHaveLength(16000);
  });
});

// ---------------------------------------------------------------------------
// buildReplyContext / buildReplyContextText
// ---------------------------------------------------------------------------

describe('buildReplyContext', () => {
  it('returns only the recent window plus the summary', () => {
    // 3 Q&A pairs (6 entries)
    for (let i = 1; i <= 3; i++) {
      appendTurn('k4', 'user', `question ${i}`);
      appendTurn('k4', 'assistant', `reply ${i}`);
    }

    const block = buildReplyContext('k4');
    expect(block.recent).toContain('You: question 3');
    expect(block.recent).toContain('Assistant: reply 3');
    expect(block.recent).toContain('You: question 2');
    expect(block.recent).not.toContain('question 1');
  });

  it('includes the compaction summary when present', () => {
    const store: Record<string, unknown> = {
      k5: {
        key: 'k5',
        entries: [buildTurn('user', 'q', now)],
        summary: 'Preferences established.',
        emailSummary: undefined,
        updatedAt: now,
      },
    };
    (globalThis as any).localStorage.setItem('aic_conversations', JSON.stringify(store));

    const block = buildReplyContext('k5');
    expect(block.summary).toBe('Preferences established.');
  });

  it('builds an empty context block when there is no history', () => {
    expect(buildReplyContextText(buildReplyContext('k-nothing'))).toBe('');
  });

  it('serializes summary and recent window into a prompt block', () => {
    const txt = buildReplyContextText({ summary: 'S', recent: 'You: q\nAssistant: r' });
    expect(txt).toContain('Summary: S');
    expect(txt).toContain('Most recent exchanges');
  });

  it('injects a long assistant reply in full (no 800-char cap)', () => {
    const longReply = 'R'.repeat(2000);
    appendTurn('k9', 'user', 'q');
    appendTurn('k9', 'assistant', longReply);

    const block = buildReplyContext('k9');
    expect(block.recent).toContain('Assistant: ' + longReply);
  });
});

// ---------------------------------------------------------------------------
// compactIfNeeded
// ---------------------------------------------------------------------------

describe('compactIfNeeded', () => {
  it('folds older turns into a summary only once enough old turns accumulate', async () => {
    mockGenerateText.mockResolvedValue('compacted summary');
    // 10 Q&A pairs (20 entries) → 16 older turns fold into the summary
    for (let i = 1; i <= 10; i++) {
      appendTurn('k6', 'user', `question ${i}`);
      appendTurn('k6', 'assistant', `reply ${i}`);
    }

    await compactIfNeeded('k6');

    const rec = getConversation('k6');
    expect(rec.entries).toHaveLength(4); // last 2 turn pairs
    expect(rec.summary).toBe('compacted summary');
    expect(rec.entries[3].content).toBe('reply 10');
  });

  it('does not compact until the accumulated older turns reach the threshold', async () => {
    mockGenerateText.mockResolvedValue('compacted summary');
    // 9 Q&A pairs (18 entries) → 14 older turns → compaction must wait
    for (let i = 1; i <= 9; i++) {
      appendTurn('k7', 'user', `q${i}`);
      appendTurn('k7', 'assistant', `r${i}`);
    }
    await compactIfNeeded('k7');
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(getConversation('k7').entries).toHaveLength(18);
  });

  it('does not compact conversations at or below the threshold', async () => {
    for (let i = 1; i <= 2; i++) {
      appendTurn('k7low', 'user', `q${i}`);
      appendTurn('k7low', 'assistant', `r${i}`);
    }
    await compactIfNeeded('k7low');
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(getConversation('k7low').entries).toHaveLength(4);
  });

  it('degrades silently when the summarizer fails', async () => {
    mockGenerateText.mockRejectedValue(new Error('boom'));
    for (let i = 1; i <= 10; i++) {
      appendTurn('k8', 'user', `q${i}`);
      appendTurn('k8', 'assistant', `r${i}`);
    }
    await compactIfNeeded('k8');
    const rec = getConversation('k8');
    expect(rec.entries).toHaveLength(20); // unchanged
    expect(rec.summary).toBe('');
  });
});

// ---------------------------------------------------------------------------
// rememberLastRequest / getLastAssistantReply
// ---------------------------------------------------------------------------

describe('rememberLastRequest / getLastAssistantReply', () => {
  it('persists the last request on the conversation record', () => {
    appendTurn('k-lr', 'user', 'Draft a reply');
    appendTurn('k-lr', 'assistant', 'Reply copy');
    rememberLastRequest('k-lr', {
      instructions: 'Draft a reply',
      tone: 'professional',
      includeOriginal: true,
      language: 'auto',
    });

    const rec = getConversation('k-lr');
    expect(rec.lastRequest).toEqual({
      instructions: 'Draft a reply',
      tone: 'professional',
      includeOriginal: true,
      language: 'auto',
    });
  });

  it('does not persist lastRequest for the reserved default key', () => {
    rememberLastRequest('default', {
      instructions: 'q',
      tone: 'professional',
      includeOriginal: true,
    });
    expect(readStore()['default']).toBeUndefined();
  });

  it('clearConversation removes the lastRequest along with the record', () => {
    appendTurn('k-clear', 'user', 'q');
    rememberLastRequest('k-clear', { instructions: 'q', tone: 'friendly', includeOriginal: false });
    clearConversation('k-clear');
    expect(readStore()['k-clear']).toBeUndefined();
  });

  it('returns the most recent assistant turn, or null when none exists', () => {
    appendTurn('k-last', 'user', 'q1');
    appendTurn('k-last', 'assistant', 'r1');
    appendTurn('k-last', 'user', 'q2');
    appendTurn('k-last', 'assistant', 'r2');

    expect(getLastAssistantReply('k-last')).toBe('r2');
    expect(getLastAssistantReply('k-empty')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Email summarization
// ---------------------------------------------------------------------------

describe('getEmailContextBlock', () => {
  const LONG = 'x'.repeat(10000);

  it('summarizes long emails once and caches by ref', async () => {
    mockGenerateText.mockResolvedValueOnce('EMAIL SUMMARY');
    const first = await getEmailContextBlock('k9', 'ref-A', LONG);
    expect(first.text).toBe('EMAIL SUMMARY');

    const second = await getEmailContextBlock('k9', 'ref-A', LONG);
    expect(second.text).toBe('EMAIL SUMMARY');
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it('regenerates the summary when the email ref changes', async () => {
    mockGenerateText.mockResolvedValueOnce('SUMMARY 1').mockResolvedValueOnce('SUMMARY 2');
    await getEmailContextBlock('k10', 'ref-1', LONG);
    const second = await getEmailContextBlock('k10', 'ref-2', LONG);
    expect(second.text).toBe('SUMMARY 2');
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
  });

  it('returns short emails verbatim without a summary call', async () => {
    const short = 'Short email body';
    const result = await getEmailContextBlock('k11', 'ref-s', short);
    expect(result.text).toBe(short);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('falls back to the original text when summarization fails', async () => {
    mockGenerateText.mockRejectedValue(new Error('boom'));
    const result = await getEmailContextBlock('k12', 'ref-L', LONG);
    expect(result.text).toBe(LONG);
  });
});

describe('buildEmailRef', () => {
  it('changes when the subject or body length changes', () => {
    expect(buildEmailRef('Subject A', 'hello')).toBe(buildEmailRef('Subject A', 'hello'));
    expect(buildEmailRef('Subject A', 'hello')).not.toBe(buildEmailRef('Subject A', 'helloo'));
    expect(buildEmailRef('Subject A', 'hello')).not.toBe(buildEmailRef('Subject B', 'hello'));
  });
});

// ---------------------------------------------------------------------------
// Sweep / storage caps
// ---------------------------------------------------------------------------

describe('sweeping', () => {
  it('deletes records untouched for more than 72 hours', () => {
    appendTurn('old-k', 'user', 'q');
    now += 73 * 60 * 60 * 1000; // advance just past the TTL
    const rec = getConversation('old-k');
    expect(rec.entries).toHaveLength(0);
    expect(readStore()['old-k']).toBeUndefined();
  });

  it('keeps records touched within the TTL', () => {
    appendTurn('fresh-k', 'user', 'q');
    now += 71 * 60 * 60 * 1000;
    expect(getConversation('fresh-k').entries).toHaveLength(1);
  });

  it('caps the number of records at MAX_RECORDS, evicting oldest', () => {
    for (let i = 1; i <= 51; i++) {
      appendTurn(`key-${i}`, 'user', `q${i}`);
    }
    const store = readStore();
    expect(Object.keys(store).length).toBeLessThanOrEqual(50);
    expect(store['key-1']).toBeUndefined();
    expect(store['key-51']).toBeDefined();
  });

  it('enforces the byte budget by dropping the largest oldest record', () => {
    const huge = 'x'.repeat(1_100_000);
    const store: Record<string, unknown> = {
      oldHuge: {
        key: 'oldHuge',
        entries: [buildTurn('assistant', huge, now)],
        summary: '',
        emailSummary: undefined,
        updatedAt: now,
      },
    };
    (globalThis as any).localStorage.setItem('aic_conversations', JSON.stringify(store));

    appendTurn('new-k', 'user', 'q1');

    const after = readStore();
    expect(after['oldHuge']).toBeUndefined();
    expect(after['new-k']).toBeDefined();
  });

  it('clearConversation removes a single key and clearAllConversations wipes the store', () => {
    appendTurn('a', 'user', 'q');
    appendTurn('b', 'user', 'q');
    clearConversation('a');
    expect(readStore()['a']).toBeUndefined();
    expect(readStore()['b']).toBeDefined();
    clearAllConversations();
    expect(readStore()).toEqual({});
  });

  it('does not persist reserved "default" conversations', () => {
    appendTurn('default', 'user', 'q');
    expect(readStore()['default']).toBeUndefined();
  });
});
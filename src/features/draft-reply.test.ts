/**
 * AI Compose — Draft Reply Conversation Memory Integration Tests
 *
 * Verifies that follow-up questions on the same email receive the previous
 * exchange as injected context, and that replies/refinements are recorded
 * into the per-conversation store.
 *
 * © Rizonetech (Pty) Ltd. — https://rizonesoft.com
 */

import { generateReply, refineReply } from './draft-reply';
import { getConversation } from './conversation-memory';

jest.mock('../services/ai-service', () => ({ generateText: jest.fn() }));
jest.mock('../services/outlook', () => ({
  getCurrentEmailBody: jest.fn().mockResolvedValue('We need the quarterly figures by Friday. Please confirm your availability for a review meeting.'),
  getCurrentEmailSubject: jest.fn().mockResolvedValue('Q3 figures'),
  getOriginalSender: jest.fn().mockResolvedValue({ name: 'Alice', email: 'alice@example.com' }),
}));
jest.mock('./auto-save', () => ({ getSessionKey: jest.fn().mockReturnValue('conv:integration') }));

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

const SESSION_KEY = 'conv:integration';

beforeEach(() => {
  (globalThis as any).localStorage = new MemoryStorage();
  mockGenerateText.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateReply conversation memory', () => {
  const options = () => ({
    instructions: 'Draft a reply',
    tone: 'professional',
    includeOriginal: true,
    language: 'auto',
  });

  it('sends the original email context on the first question', async () => {
    mockGenerateText.mockResolvedValue('Reply copy one');

    await generateReply(options());

    const prompt = mockGenerateText.mock.calls[0][0] as string;
    expect(prompt).toContain('Q3 figures');
    expect(prompt).toContain('Draft a reply');
    expect(prompt).not.toContain('Conversation so far on this email');
  });

  it('injects the previous exchange into the follow-up prompt', async () => {
    mockGenerateText.mockResolvedValueOnce('Reply copy one');
    await generateReply(options());

    mockGenerateText.mockResolvedValueOnce('Reply copy two');
    await generateReply({ ...options(), instructions: 'Make it friendlier' });

    const prompt = mockGenerateText.mock.calls[1][0] as string;
    expect(prompt).toContain('Make it friendlier');
    expect(prompt).toContain('Conversation so far on this email');
    expect(prompt).toContain('Reply copy one');
  });

  it('records both Q&A rounds for the conversation', async () => {
    mockGenerateText.mockResolvedValueOnce('Reply copy one');
    await generateReply(options());

    mockGenerateText.mockResolvedValueOnce('Reply copy two');
    await generateReply({ ...options(), instructions: 'Follow-up question' });

    const rec = getConversation(SESSION_KEY);
    expect(rec.entries).toHaveLength(4);
    expect(rec.entries.map((e) => e.content)).toEqual([
      'Draft a reply',
      'Reply copy one',
      'Follow-up question',
      'Reply copy two',
    ]);
  });

  it('does not duplicate history when regenerating with the same instructions', async () => {
    mockGenerateText.mockResolvedValue('First generation');
    await generateReply(options());

    mockGenerateText.mockResolvedValue('Regenerated');
    await generateReply(options()); // same instructions → treated as regenerate

    const rec = getConversation(SESSION_KEY);
    expect(rec.entries).toHaveLength(2);
    expect(rec.entries[1].content).toBe('Regenerated');
  });

  it('does not write history when generation fails', async () => {
    expect(generateReply).toBeDefined();
    mockGenerateText.mockRejectedValue(new Error('API down'));
    await expect(generateReply(options())).rejects.toThrow('API down');

    const rec = getConversation(SESSION_KEY);
    expect(rec.entries).toHaveLength(0);
  });
});

describe('refineReply conversation memory', () => {
  it('records refinement rounds and leaves prior drafts recallable', async () => {
    mockGenerateText.mockResolvedValueOnce('Draft reply body');
    await generateReply({
      instructions: 'Draft the reply',
      tone: 'professional',
      includeOriginal: true,
    });

    mockGenerateText.mockResolvedValueOnce('Refined reply body');
    await refineReply('Make the closing shorter');

    const rec = getConversation(SESSION_KEY);
    expect(rec.entries).toHaveLength(4);
    expect(rec.entries[2]).toMatchObject({ role: 'user', content: 'Make the closing shorter' });
    expect(rec.entries[3]).toMatchObject({ role: 'assistant', content: 'Refined reply body' });
  });
});
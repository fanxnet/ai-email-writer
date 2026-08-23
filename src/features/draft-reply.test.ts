/**
 * AI Compose — Draft Reply Conversation Memory Integration Tests
 *
 * Verifies that follow-up questions on the same email receive the previous
 * exchange as injected context, and that replies/refinements are recorded
 * into the per-conversation store.
 *
 * © Rizonetech (Pty) Ltd. — https://rizonesoft.com
 */

import { generateReply, refineReply, restoreFromHistory, clearEmailContext } from './draft-reply';
import { getConversation, appendTurn, rememberLastRequest } from './conversation-memory';
import { getCurrentEmailBody } from '../services/outlook';

jest.mock('../services/ai-service', () => ({ generateText: jest.fn() }));
jest.mock('../services/outlook', () => ({
  getCurrentEmailBody: jest.fn().mockResolvedValue('We need the quarterly figures by Friday. Please confirm your availability for a review meeting.'),
  getCurrentEmailSubject: jest.fn().mockResolvedValue('Q3 figures'),
  getOriginalSender: jest.fn().mockResolvedValue({ name: 'Alice', email: 'alice@example.com' }),
}));
jest.mock('./auto-save', () => ({ getSessionKey: jest.fn().mockReturnValue('conv:integration') }));

import { generateText as generateTextMockValue } from '../services/ai-service';

const mockGenerateText = generateTextMockValue as jest.Mock;
const mockGetBody = getCurrentEmailBody as jest.Mock;

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
  clearEmailContext();
  mockGetBody.mockResolvedValue('We need the quarterly figures by Friday. Please confirm your availability for a review meeting.');
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

  it('does not inject conversation context into the follow-up prompt', async () => {
    mockGenerateText.mockResolvedValueOnce('Reply copy one');
    await generateReply(options());

    mockGenerateText.mockResolvedValueOnce('Reply copy two');
    await generateReply({ ...options(), instructions: 'Make it friendlier' });

    const prompt = mockGenerateText.mock.calls[1][0] as string;
    expect(prompt).toContain('Make it friendlier');
    expect(prompt).not.toContain('Conversation so far on this email');
    expect(prompt).toContain('quarterly figures'); // Original email still injected
  });

  it('records history in localStorage for local display only', async () => {
    mockGenerateText.mockResolvedValueOnce('Reply copy one');
    await generateReply(options());

    mockGenerateText.mockResolvedValueOnce('Reply copy two');
    await generateReply({ ...options(), instructions: 'Follow-up question' });

    const rec = getConversation(SESSION_KEY);
    expect(rec.entries).toHaveLength(4); // History recorded for local display
  });

  it('does not duplicate history when regenerating with the same instructions', async () => {
    mockGenerateText.mockResolvedValue('First generation');
    await generateReply(options());

    mockGenerateText.mockResolvedValue('Regenerated');
    await generateReply(options()); // same instructions → treated as regenerate

    const rec = getConversation(SESSION_KEY);
    expect(rec.entries).toHaveLength(2);
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
  it('records refinement rounds for local display', async () => {
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

describe('restoreFromHistory', () => {
  const options = () => ({
    instructions: 'Draft a reply',
    tone: 'professional',
    includeOriginal: true,
    language: 'auto',
  });

  it('restores the latest reply and the request that produced it', async () => {
    mockGenerateText.mockResolvedValueOnce('Reply copy one');
    await generateReply(options());

    const restored = restoreFromHistory(SESSION_KEY);
    expect(restored).not.toBeNull();
    expect(restored!.reply).toBe('Reply copy one');
    expect(restored!.options.instructions).toBe('Draft a reply');
    expect(restored!.options.tone).toBe('professional');
  });

  it('restores a stored record as if returning to the email after a reload', () => {
    appendTurn(SESSION_KEY, 'user', 'Saved question');
    appendTurn(SESSION_KEY, 'assistant', 'Saved answer');
    rememberLastRequest(SESSION_KEY, {
      instructions: 'Saved question',
      tone: 'formal',
      includeOriginal: true,
    });

    const restored = restoreFromHistory(SESSION_KEY);
    expect(restored?.reply).toBe('Saved answer');
    expect(restored?.options.tone).toBe('formal');
  });

  it('returns null when there is no history to restore', () => {
    expect(restoreFromHistory('conv:empty')).toBeNull();
  });

  it('falls back to the last user turn when no lastRequest was recorded', () => {
    appendTurn(SESSION_KEY, 'user', 'Legacy question');
    appendTurn(SESSION_KEY, 'assistant', 'Legacy answer');

    const restored = restoreFromHistory(SESSION_KEY);
    expect(restored?.reply).toBe('Legacy answer');
    expect(restored?.options.instructions).toBe('Legacy question');
    expect(restored?.options.tone).toBe('professional');
    expect(restored?.options.language).toBe('auto');
  });
});

// ---------------------------------------------------------------------------
// Reply language resolution (auto-detect / explicit / instruction priority)
// ---------------------------------------------------------------------------

const CHINESE_EMAIL = '尊敬的张先生您好，感谢您上周的来信。关于合作协议的条款，我们已经请法务团队复核，预计周五给出最终意见，届时会再与您联系。';

describe('generateReply language resolution', () => {
  const options = () => ({
    instructions: 'Draft a reply',
    tone: 'professional',
    includeOriginal: true,
    language: 'auto',
  });

  it('auto mode → language is embedded in prompt line', async () => {
    mockGenerateText.mockResolvedValue('Reply body');

    await generateReply(options());

    const prompt = mockGenerateText.mock.calls[0][0] as string;
    expect(prompt).toContain('Language：auto');
  });

  it('explicit language selection → used verbatim in prompt', async () => {
    mockGenerateText.mockResolvedValue('保留原文案的回复');

    await generateReply({ ...options(), language: 'Chinese (Simplified)' });

    const prompt = mockGenerateText.mock.calls[0][0] as string;
    expect(prompt).toContain('Language：Chinese (Simplified)');
  });
});

// ---------------------------------------------------------------------------
// filterQuotedContent — multi-line From/Sent/To/Subject filtering
// ---------------------------------------------------------------------------

describe('generateReply quoted content filtering', () => {
  const options = () => ({
    instructions: 'Draft a reply',
    tone: 'professional',
    includeOriginal: true,
    language: 'auto',
  });

  it('filters multi-line Outlook Classic From/Sent/To/Subject block', async () => {
    const multiLineEmail = [
      'Please review the attached document.',
      '',
      'From: Alice Smith',
      'Sent: Monday, January 15, 2024 3:00 PM',
      'To: Bob',
      'Subject: Re: Q3 figures',
      '',
      'Original content here.',
    ].join('\n');
    mockGetBody.mockResolvedValue(multiLineEmail);
    mockGenerateText.mockResolvedValue('Reply');

    await generateReply(options());

    const prompt = mockGenerateText.mock.calls[0][0] as string;
    expect(prompt).toContain('Please review the attached document.');
    expect(prompt).not.toContain('From: Alice Smith');
    expect(prompt).not.toContain('Sent: Monday');
    expect(prompt).not.toContain('Original content here.');
  });

  it('filters multi-line Outlook Classic with CC line', async () => {
    const multiLineEmail = [
      'Please review.',
      '',
      'From: Alice',
      'Sent: Mon, 15 Jan 2024 15:00:00 +0000',
      'To: Bob',
      'CC: Charlie',
      'Subject: Re: Q3',
      '',
      'Old stuff.',
    ].join('\n');
    mockGetBody.mockResolvedValue(multiLineEmail);
    mockGenerateText.mockResolvedValue('Reply');

    await generateReply(options());

    const prompt = mockGenerateText.mock.calls[0][0] as string;
    expect(prompt).toContain('Please review.');
    expect(prompt).not.toContain('From: Alice\n');
    expect(prompt).not.toContain('CC: Charlie');
  });

  it('filters Chinese multi-line headers', async () => {
    const chineseEmail = [
      '请查收附件。',
      '',
      '发件人：张三',
      '发送时间：2024年1月15日 15:00',
      '收件人：李四',
      '主题：回复：Q3 数据',
      '',
      '原始内容。',
    ].join('\n');
    mockGetBody.mockResolvedValue(chineseEmail);
    mockGenerateText.mockResolvedValue('Reply');

    await generateReply(options());

    const prompt = mockGenerateText.mock.calls[0][0] as string;
    expect(prompt).toContain('请查收附件。');
    expect(prompt).not.toContain('发件人：张三');
    expect(prompt).not.toContain('原始内容。');
  });

  it('filters single-line compact From/Sent/To/Subject', async () => {
    const singleLineEmail = 'Please review.\nFrom: Alice; Sent: Mon; To: Bob; Subject: Re\nOld content.';
    mockGetBody.mockResolvedValue(singleLineEmail);
    mockGenerateText.mockResolvedValue('Reply');

    await generateReply(options());

    const prompt = mockGenerateText.mock.calls[0][0] as string;
    expect(prompt).toContain('Please review.');
    expect(prompt).not.toContain('From: Alice;');
  });

  it('preserves current email when no quoted content exists', async () => {
    const cleanEmail = 'Hi, please review the attached document by Friday.';
    mockGetBody.mockResolvedValue(cleanEmail);
    mockGenerateText.mockResolvedValue('Reply');

    await generateReply(options());

    const prompt = mockGenerateText.mock.calls[0][0] as string;
    expect(prompt).toContain('Hi, please review the attached document by Friday.');
  });
});
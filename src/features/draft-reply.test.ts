/**
 * AI Compose — Draft Reply Conversation Memory Integration Tests
 *
 * Verifies that follow-up questions on the same email receive the previous
 * exchange as injected context, and that replies/refinements are recorded
 * into the per-conversation store.
 *
 * © Rizonetech (Pty) Ltd. — https://rizonesoft.com
 */

import { generateReply, refineReply, restoreFromHistory, clearEmailContext, filterQuotedContent } from './draft-reply';
import { getConversation, appendTurn, rememberLastRequest } from './conversation-memory';
import { getCurrentEmailBodyHtml } from '../services/outlook';

jest.mock('../services/ai-service', () => ({ generateText: jest.fn() }));
jest.mock('../services/outlook', () => {
  const actual = jest.requireActual('../services/outlook');
  return {
    ...actual,
    getCurrentEmailBodyHtml: jest.fn().mockResolvedValue(
      '<p>We need the quarterly figures by Friday. Please confirm your availability for a review meeting.</p>',
    ),
    getCurrentEmailSubject: jest.fn().mockResolvedValue('Q3 figures'),
    getOriginalSender: jest.fn().mockResolvedValue({ name: 'Alice', email: 'alice@example.com' }),
  };
});
jest.mock('./auto-save', () => ({ getSessionKey: jest.fn().mockReturnValue('conv:integration') }));

import { generateText as generateTextMockValue } from '../services/ai-service';

const mockGenerateText = generateTextMockValue as jest.Mock;
const mockGetHtml = getCurrentEmailBodyHtml as jest.Mock;

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
  mockGetHtml.mockResolvedValue(
    '<p>We need the quarterly figures by Friday. Please confirm your availability for a review meeting.</p>',
  );
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
// filterQuotedContent — direct unit tests
// ---------------------------------------------------------------------------

describe('filterQuotedContent', () => {
  it('removes multi-line From/Sent/To/Subject block and quoted body', () => {
    const input = [
      'Current reply content',
      '',
      'From: Alice <alice@example.com>',
      'Sent: Monday, January 15, 2024 3:00 PM',
      'To: Bob <bob@example.com>',
      'Subject: RE: Q3 figures',
      '',
      'Original quoted content',
    ].join('\n');
    const result = filterQuotedContent(input);
    expect(result).toContain('Current reply content');
    expect(result).not.toContain('From:');
    expect(result).not.toContain('Original quoted content');
  });

  it('merges split From label/value lines and removes block', () => {
    const input = [
      'Current content',
      '',
      'From:',
      'Alice <alice@example.com>',
      'Sent:',
      'Monday, January 15, 2024 3:00 PM',
      'To:',
      'Bob',
      'Subject:',
      'RE: Q3',
      '',
      'Quoted body',
    ].join('\n');
    const result = filterQuotedContent(input);
    expect(result).toContain('Current content');
    expect(result).not.toContain('From:');
    expect(result).not.toContain('Quoted body');
  });

  it('removes block preceded by underscore separator (Classic Outlook)', () => {
    const input = [
      'Current content',
      '',
      '________________________________________',
      'From: Alice',
      'Sent: Monday, January 15, 2024 3:00 PM',
      'To: Bob',
      'Subject: RE: Q3',
      '',
      'Quoted body',
    ].join('\n');
    const result = filterQuotedContent(input);
    expect(result).toContain('Current content');
    expect(result).not.toContain('________________________________________');
    expect(result).not.toContain('Quoted body');
  });

  it('removes Chinese header block with full-width colons', () => {
    const input = [
      '当前邮件内容',
      '',
      '发件人：张三',
      '发送时间：2024年1月15日 15:00',
      '收件人：李四',
      '主题：回复：Q3 数据',
      '',
      '引用的旧内容',
    ].join('\n');
    const result = filterQuotedContent(input);
    expect(result).toContain('当前邮件内容');
    expect(result).not.toContain('发件人');
    expect(result).not.toContain('引用的旧内容');
  });

  it('removes On...wrote: header and everything after', () => {
    const input = [
      'Current content',
      '',
      'On Mon, Jan 15, 2024 at 3:00 PM, Alice wrote:',
      '',
      '> Original line one',
      '> Original line two',
    ].join('\n');
    const result = filterQuotedContent(input);
    expect(result).toContain('Current content');
    expect(result).not.toContain('wrote:');
    expect(result).not.toContain('Original line');
  });

  it('removes -----Original Message----- and everything after', () => {
    const input = [
      'Current content',
      '',
      '-----Original Message-----',
      'From: Alice',
      'Sent: Monday, January 15, 2024 3:00 PM',
      'To: Bob',
      'Subject: Q3',
      '',
      'Quoted body',
    ].join('\n');
    const result = filterQuotedContent(input);
    expect(result).toContain('Current content');
    expect(result).not.toContain('Original Message');
    expect(result).not.toContain('Quoted body');
  });

  it('removes "> " prefixed quoted lines', () => {
    const input = [
      'Current content',
      '',
      '> quoted line',
      '> another quoted line',
    ].join('\n');
    const result = filterQuotedContent(input);
    expect(result).toContain('Current content');
    expect(result).not.toContain('quoted line');
  });

  it('preserves clean email with no quoted content', () => {
    const input = 'Please review the attached document by Friday.';
    expect(filterQuotedContent(input)).toBe(input);
  });

  it('handles header with Cc and Date fields', () => {
    const input = [
      'Current content',
      '',
      'From: Alice',
      'Sent: Monday, January 15, 2024 3:00 PM',
      'To: Bob',
      'CC: Charlie',
      'Date: Monday, January 15, 2024 3:00 PM',
      'Subject: Re: Q3',
      '',
      'Quoted body',
    ].join('\n');
    const result = filterQuotedContent(input);
    expect(result).toContain('Current content');
    expect(result).not.toContain('From:');
    expect(result).not.toContain('Quoted body');
  });

  it('preserves a forwarded email whose body starts with From: header', () => {
    const input = [
      'From: Alice Smith',
      'Sent: Monday, January 15, 2024 3:00 PM',
      'To: Bob',
      'Subject: Report',
      '',
      'This is a forwarded report that is the actual content to reply to.',
    ].join('\n');
    expect(filterQuotedContent(input)).toBe(input);
  });

  it('preserves email whose own content contains a wrote: phrase', () => {
    const input = [
      'On the call John wrote: please review the draft.',
      'We then discussed the deadline.',
      '',
      'Second paragraph is still relevant.',
    ].join('\n');
    expect(filterQuotedContent(input)).toBe(input);
  });

  it('preserves nested forward chain when the From: header starts the body', () => {
    const input = [
      'From: Alice',
      'Sent: Monday, January 15, 2024 3:00 PM',
      'To: Bob',
      'Subject: Report',
      '',
      'Forwarded body',
      '',
      'From: Charlie',
      'Sent: Sunday, January 14, 2024 3:00 PM',
      'To: Alice',
      'Subject: Original',
      '',
      'Even older content',
    ].join('\n');
    const result = filterQuotedContent(input);
    expect(result).toContain('Forwarded body');
    expect(result).toContain('Even older content');
  });

  it('filters French reply header block (De:/Envoyé le:/À:/Objet:)', () => {
    const input = [
      'Bonjour,',
      'Merci pour votre réponse.',
      '',
      'De : Alice',
      'Envoyé le : 15 janvier 2024 15:00',
      'À : Bob',
      'Objet : RE: Q3',
      '',
      'Message original cité',
    ].join('\n');
    const result = filterQuotedContent(input);
    expect(result).toContain('Bonjour,');
    expect(result).toContain('Merci pour votre réponse.');
    expect(result).not.toContain('De : Alice');
    expect(result).not.toContain('Message original cité');
  });

  it('filters German reply header block (Von:/Gesendet am:/An:/Betreff:)', () => {
    const input = [
      'Hallo,',
      'Danke für Ihre Nachricht.',
      '',
      'Von: Alice',
      'Gesendet am: Montag, 15. Januar 2024 15:00',
      'An: Bob',
      'Betreff: RE: Q3',
      '',
      'Alter Inhalt',
    ].join('\n');
    const result = filterQuotedContent(input);
    expect(result).toContain('Hallo,');
    expect(result).toContain('Danke für Ihre Nachricht.');
    expect(result).not.toContain('Von: Alice');
    expect(result).not.toContain('Alter Inhalt');
  });

  it('filters Spanish reply header block (De:/Enviado el:/Para:/Asunto:)', () => {
    const input = [
      'Hola,',
      'Gracias por tu mensaje.',
      '',
      'De: Alice',
      'Enviado el: lunes, 15 de enero de 2024 15:00',
      'Para: Bob',
      'Asunto: RE: Q3',
      '',
      'Contenido anterior',
    ].join('\n');
    const result = filterQuotedContent(input);
    expect(result).toContain('Hola,');
    expect(result).toContain('Gracias por tu mensaje.');
    expect(result).not.toContain('De: Alice');
    expect(result).not.toContain('Contenido anterior');
  });

  it('filters Dutch-style header via language-neutral fallback (3+ label:value lines)', () => {
    const input = [
      'Hallo,',
      'Bedankt voor je bericht.',
      '',
      'Van: Alice',
      'Verzonden: maandag 15 januari 2024',
      'Aan: Bob',
      'Onderwerp: RE: Q3',
      '',
      'Oud bericht',
    ].join('\n');
    const result = filterQuotedContent(input);
    expect(result).toContain('Hallo,');
    expect(result).toContain('Bedankt voor je bericht.');
    expect(result).not.toContain('Van: Alice');
    expect(result).not.toContain('Oud bericht');
  });

  it('preserves French forwarded email when the De: header starts the body', () => {
    const input = [
      'De : Alice',
      'Envoyé le : 15 janvier 2024 15:00',
      'À : Bob',
      'Objet : RE: Q3',
      '',
      'Contenu transféré à conserver',
    ].join('\n');
    expect(filterQuotedContent(input)).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// generateReply integration tests — quoted content via generateReply
// ---------------------------------------------------------------------------

describe('generateReply quoted content filtering', () => {
  const options = () => ({
    instructions: 'Draft a reply',
    tone: 'professional',
    includeOriginal: true,
    language: 'auto',
  });

  it('filters multi-line Outlook Classic From/Sent/To/Subject block', async () => {
    const multiLineHtml = [
      '<html><body>',
      '<p>Please review the attached document.</p>',
      '<p>From: Alice Smith</p>',
      '<p>Sent: Monday, January 15, 2024 3:00 PM</p>',
      '<p>To: Bob</p>',
      '<p>Subject: Re: Q3 figures</p>',
      '<p>Original content here.</p>',
      '</body></html>',
    ].join('');
    mockGetHtml.mockResolvedValue(multiLineHtml);
    mockGenerateText.mockResolvedValue('Reply');

    await generateReply(options());

    const prompt = mockGenerateText.mock.calls[0][0] as string;
    expect(prompt).toContain('Please review the attached document.');
    expect(prompt).not.toContain('Original content here.');
  });

  it('filters Chinese multi-line headers', async () => {
    const chineseHtml = [
      '<html><body>',
      '<p>请查收附件。</p>',
      '<p>发件人：张三</p>',
      '<p>发送时间：2024年1月15日 15:00</p>',
      '<p>收件人：李四</p>',
      '<p>主题：回复：Q3 数据</p>',
      '<p>原始内容。</p>',
      '</body></html>',
    ].join('');
    mockGetHtml.mockResolvedValue(chineseHtml);
    mockGenerateText.mockResolvedValue('Reply');

    await generateReply(options());

    const prompt = mockGenerateText.mock.calls[0][0] as string;
    expect(prompt).toContain('请查收附件。');
    expect(prompt).not.toContain('原始内容。');
  });

  it('truncates a long blockquote thread to the newest messages before building the prompt', async () => {
    const threadHtml = [
      '<html><body>',
      '<p>Current email body.</p>',
      '<blockquote><p>Reply 1 body.</p>',
      '<blockquote><p>Reply 2 body.</p>',
      '<blockquote><p>Reply 3 body.</p>',
      '<blockquote><p>Reply 4 body (oldest).</p>',
      '</blockquote></blockquote></blockquote></blockquote>',
      '</body></html>',
    ].join('');
    mockGetHtml.mockResolvedValue(threadHtml);
    mockGenerateText.mockResolvedValue('Reply');

    await generateReply(options());

    const prompt = mockGenerateText.mock.calls[0][0] as string;
    expect(prompt).toContain('Current email body.');
    expect(prompt).toContain('Reply 1 body.');
    expect(prompt).toContain('Reply 2 body.');
    expect(prompt).not.toContain('Reply 3 body.');
    expect(prompt).not.toContain('Reply 4 body');
  });

  it('includes the full thread when includeThread is enabled', async () => {
    const threadHtml = [
      '<html><body>',
      '<p>Current email body.</p>',
      '<blockquote><p>Reply 1 body.</p>',
      '<blockquote><p>Reply 2 body.</p>',
      '<blockquote><p>Reply 3 body.</p>',
      '</blockquote></blockquote></blockquote>',
      '</body></html>',
    ].join('');
    mockGetHtml.mockResolvedValue(threadHtml);
    mockGenerateText.mockResolvedValue('Reply');

    await generateReply({ ...options(), includeThread: true });

    const prompt = mockGenerateText.mock.calls[0][0] as string;
    expect(prompt).toContain('Current email body.');
    expect(prompt).toContain('Reply 1 body.');
    expect(prompt).toContain('Reply 3 body.');
  });

  it('preserves current email when no quoted content exists', async () => {
    const cleanHtml = '<html><body><p>Hi, please review the attached document by Friday.</p></body></html>';
    mockGetHtml.mockResolvedValue(cleanHtml);
    mockGenerateText.mockResolvedValue('Reply');

    await generateReply(options());

    const prompt = mockGenerateText.mock.calls[0][0] as string;
    expect(prompt).toContain('Hi, please review the attached document by Friday.');
  });
});
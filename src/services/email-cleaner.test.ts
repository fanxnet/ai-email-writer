/**
 * AI Compose — Email Cleaner Tests
 *
 * Verifies message-by-message cleaning of flattened thread text: email
 * headers, quoted separators, "wrote:" lines, signatures, disclaimers and
 * placeholders are stripped while a compact sender attribution is kept.
 */

import { cleanThreadEmails } from './email-cleaner';

describe('cleanThreadEmails', () => {
  it('returns blank input unchanged', () => {
    expect(cleanThreadEmails('')).toBe('');
  });

  it('preserves a clean single-message email', () => {
    const input = 'Please review the attached document by Friday.';
    expect(cleanThreadEmails(input)).toBe(input);
  });

  describe('header filtering', () => {
    it('removes Cc/抄送 and Sent/发送时间 lines', () => {
      const input = [
        'Please review the attached document.',
        '',
        'Cc: finance@acme.com',
        'Sent: Monday, January 15, 2024 3:00 PM',
        '',
        'Thanks.',
      ].join('\n');
      const result = cleanThreadEmails(input);
      expect(result).toContain('Please review the attached document.');
      expect(result).not.toContain('Cc:');
      expect(result).not.toContain('Sent:');
    });

    it('removes a full multi-language header block (From/Sent/To/Cc/Subject/Date)', () => {
      const input = [
        'Current message body.',
        '',
        'From: Bob Johnson',
        'Sent: Monday, January 15, 2024 3:00 PM',
        'To: Alice',
        'Cc: team@acme.com',
        'Subject: RE: Q3',
        'Date: Monday, January 15, 2024',
        '',
        'Original body content.',
      ].join('\n');
      const result = cleanThreadEmails(input);
      expect(result).not.toContain('From:');
      expect(result).not.toContain('Sent:');
      expect(result).not.toContain('To:');
      expect(result).not.toContain('Cc:');
      expect(result).not.toContain('Subject:');
      expect(result).not.toContain('Date:');
      expect(result).toContain('Original body content.');
    });

    it('removes Chinese header lines (发件人/抄送/发送时间/主题)', () => {
      const input = [
        '请查收附件。',
        '',
        '发件人：张三',
        '抄送：李四',
        '发送时间：2024年1月15日 15:00',
        '主题：Q3 数据',
        '',
        '正文内容。',
      ].join('\n');
      const result = cleanThreadEmails(input);
      expect(result).toContain('请查收附件。');
      expect(result).toContain('正文内容。');
      expect(result).not.toContain('发件人');
      expect(result).not.toContain('抄送');
      expect(result).not.toContain('发送时间');
      expect(result).not.toContain('主题');
    });
  });

  describe('sender attribution', () => {
    it('extracts the display name from a From line', () => {
      const input = [
        'Current body.',
        '',
        'From: Bob Johnson <bob@acme.com>',
        'Sent: Monday, January 15, 2024 3:00 PM',
        'To: Alice',
        'Subject: Re: Q3',
        '',
        'Please find attached the Q3 report.',
      ].join('\n');
      const result = cleanThreadEmails(input);
      expect(result).toContain('Reply from Bob Johnson:');
      expect(result).toContain('Please find attached the Q3 report.');
    });

    it('falls back to the email address when no display name exists', () => {
      const input = [
        'Body.',
        '',
        'From: <bob@acme.com>',
        'Sent: Monday, January 15, 2024 3:00 PM',
        '',
        'Content.',
      ].join('\n');
      const result = cleanThreadEmails(input);
      expect(result).toContain('Reply from bob@acme.com:');
    });

    it('extracts the sender from an "On ... wrote:" line', () => {
      const input = [
        'Hi Alice, please review.',
        '',
        'On Mon, Jan 15, 2024 at 3:00 PM, Bob Johnson wrote:',
        '',
        'Here are the numbers.',
      ].join('\n');
      const result = cleanThreadEmails(input);
      expect(result).toContain('Reply from Bob Johnson:');
      expect(result).toContain('Here are the numbers.');
      expect(result).not.toContain('wrote:');
    });
  });

  describe('signature removal', () => {
    it('removes an English signature block after the sign-off', () => {
      const input = [
        'Hi Bob, thanks for the update.',
        '',
        'Regards,',
        'Alice Chen',
        'Senior PM, Acme Inc.',
        'Tel: +1-555-0100',
        'alice.chen@acme.com',
      ].join('\n');
      const result = cleanThreadEmails(input);
      expect(result).toContain('Hi Bob, thanks for the update.');
      expect(result).not.toContain('Regards,');
      expect(result).not.toContain('Alice Chen');
      expect(result).not.toContain('Tel:');
      expect(result).not.toContain('acme.com');
    });

    it('removes a Chinese signature (此致敬礼)', () => {
      const input = [
        '感谢您的来信，我会尽快处理。',
        '',
        '此致敬礼，',
        '张三',
        '项目经理',
        '电话：+86-10-5555-0100',
      ].join('\n');
      const result = cleanThreadEmails(input);
      expect(result).toContain('感谢您的来信，我会尽快处理。');
      expect(result).not.toContain('此致敬礼');
      expect(result).not.toContain('张三');
      expect(result).not.toContain('电话');
    });

    it('removes localized signatures (Cordialement / Mit freundlichen Grüßen / Saludos)', () => {
      const cases = [
        ['Merci pour votre réponse.\n\nCordialement,\nMarie Dupont\nAcme SARL', 'Merci pour votre réponse.', 'Cordialement'],
        ['Vielen Dank für die Rückmeldung.\n\nMit freundlichen Grüßen\nMax Müller\nAcme GmbH', 'Vielen Dank für die Rückmeldung.', 'Grüßen'],
        ['Gracias por su respuesta.\n\nSaludos,\nCarlos López\nAcme S.L.', 'Gracias por su respuesta.', 'Saludos'],
      ] as const;
      for (const [input, keep, removed] of cases) {
        const result = cleanThreadEmails(input);
        expect(result).toContain(keep);
        expect(result).not.toContain(removed);
      }
    });

    it('does not remove body text containing "Thanks for your patience."', () => {
      const input = [
        'I checked the numbers.',
        'Thanks for your patience.',
        'We will wrap up on Thursday.',
      ].join('\n');
      const result = cleanThreadEmails(input);
      expect(result).toContain('Thanks for your patience.');
      expect(result).toContain('We will wrap up on Thursday.');
    });

    it('keeps the body when a sign-off is the very last line with no signature', () => {
      const input = ['Will follow up tomorrow.', 'Thanks!'].join('\n');
      const result = cleanThreadEmails(input);
      expect(result).toContain('Will follow up tomorrow.');
    });
  });

  describe('disclaimers and placeholders', () => {
    it('removes a confidentiality disclaimer at the end', () => {
      const input = [
        'Please see the attached draft.',
        '',
        'This e-mail and any attachments are confidential and may be privileged.',
        'If you have received it in error, please notify the sender immediately.',
      ].join('\n');
      const result = cleanThreadEmails(input);
      expect(result).toContain('Please see the attached draft.');
      expect(result).not.toContain('confidential');
      expect(result).not.toContain('in error');
    });

    it('removes image placeholders and attachment lines', () => {
      const input = [
        'See the diagram below.',
        '',
        '[image: diagram.png]',
        'Attachment: report.pdf',
      ].join('\n');
      const result = cleanThreadEmails(input);
      expect(result).toContain('See the diagram below.');
      expect(result).not.toContain('image: diagram');
      expect(result).not.toContain('Attachment');
    });
  });

  describe('multi-message threads', () => {
    const thread = [
      'Hi Bob, thanks for the update.',
      '',
      'Regards,',
      'Alice Chen',
      'Acme Inc.',
      '',
      '-----Original Message-----',
      'From: Bob Johnson <bob@acme.com>',
      'Sent: Monday, January 15, 2024 3:00 PM',
      'To: Alice Chen',
      'Cc: finance@acme.com',
      'Subject: RE: Q3 figures',
      '',
      'Please find attached the Q3 report.',
      '',
      'Thanks,',
      'Bob Johnson',
      'Finance Lead',
      'Acme Inc.',
      'Tel: +1-555-0199',
      '',
      '-----Original Message-----',
      'From: Alice Chen',
      'Sent: Sunday, January 14, 2024 10:00 AM',
      'To: Bob Johnson',
      'Subject: Q3 figures',
      '',
      'Do you have the Q3 numbers ready?',
      'Best,',
      'Alice',
    ].join('\n');

    it('cleans every message and keeps the sender attribution', () => {
      const result = cleanThreadEmails(thread);
      expect(result).toContain('Hi Bob, thanks for the update.');
      expect(result).toContain('Reply from Bob Johnson:');
      expect(result).toContain('Please find attached the Q3 report.');
      expect(result).toContain('Reply from Alice Chen:');
      expect(result).toContain('Do you have the Q3 numbers ready?');
      expect(result).not.toContain('Cc:');
      expect(result).not.toContain('Sent:');
      expect(result).not.toContain('Subject:');
      expect(result).not.toContain('-----Original Message-----');
      expect(result).not.toContain('Regards,');
      expect(result).not.toContain('Thanks,');
      expect(result).not.toContain('Best,');
    });

    it('keeps only the newest messages when keepReplies is given', () => {
      const result = cleanThreadEmails(thread, 2);
      expect(result).toContain('Hi Bob, thanks for the update.');
      expect(result).toContain('Reply from Bob Johnson:');
      expect(result).toContain('Please find attached the Q3 report.');
      expect(result).not.toContain('Do you have the Q3 numbers ready?');
    });

    it('removes the signature of every message (not just the last one)', () => {
      const input = [
        'Hi Bob, please review the attached plan.',
        '',
        'Best regards,',
        'Angelina Liu',
        'Senior Manager, Acme Inc.',
        'Tel: +1-555-0100',
        '',
        '-----Original Message-----',
        'From: Bob Johnson',
        'Sent: Monday, January 15, 2024 3:00 PM',
        'To: Angelina Liu',
        'Subject: RE: Project plan',
        '',
        'Thanks for sending the plan, I will review it today.',
        '',
        'Thanks,',
        'Bob Johnson',
        'Finance Lead',
        'Acme Inc.',
      ].join('\n');
      const result = cleanThreadEmails(input);
      expect(result).toContain('Hi Bob, please review the attached plan.');
      expect(result).toContain('Reply from Bob Johnson:');
      expect(result).toContain('Thanks for sending the plan, I will review it today.');
      expect(result).not.toContain('Angelina Liu');
      expect(result).not.toContain('Best regards,');
      expect(result).not.toContain('Finance Lead');
      expect(result).not.toContain('Acme Inc.');
      expect(result).not.toContain('Tel:');
    });
  });

  describe('blank-line normalization', () => {
    it('collapses 3+ consecutive newlines to a single blank line', () => {
      const input = [
        'First paragraph.',
        '',
        '',
        'Second paragraph.',
        '',
        '',
        '',
        'Third paragraph.',
      ].join('\n');
      const result = cleanThreadEmails(input);
      expect(result).toContain('First paragraph.\n\nSecond paragraph.');
      expect(result).toContain('Second paragraph.\n\nThird paragraph.');
      expect(result).not.toContain('\n\n\n');
    });

    it('joins messages with a single blank line', () => {
      const input = [
        'Current email body.',
        '',
        '-----Original Message-----',
        'From: Bob',
        '',
        'Reply body.',
      ].join('\n');
      const result = cleanThreadEmails(input);
      expect(result).toBe('Current email body.\n\nReply from Bob:\nReply body.');
    });
  });

  describe('sign-off phrase matching', () => {
    it('matches sign-off phrases case-insensitively', () => {
      const input = ['Meeting tomorrow at 10.', '', 'Best Regards, Alice Chen'].join('\n');
      const result = cleanThreadEmails(input);
      expect(result).toContain('Meeting tomorrow at 10.');
      expect(result).not.toContain('Best Regards');
      expect(result).not.toContain('Alice Chen');
    });
  });
});

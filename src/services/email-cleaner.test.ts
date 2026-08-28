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

    it('removes non-sender headers but keeps the From line', () => {
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
      expect(result).toContain('From: Bob Johnson');
      expect(result).not.toContain('Sent:');
      expect(result).not.toContain('To:');
      expect(result).not.toContain('Cc:');
      expect(result).not.toContain('Subject:');
      expect(result).not.toContain('Date:');
      expect(result).toContain('Original body content.');
    });

    it('keeps the Chinese sender line but removes the other headers', () => {
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
      expect(result).toContain('发件人：张三');
      expect(result).not.toContain('抄送');
      expect(result).not.toContain('发送时间');
      expect(result).not.toContain('主题');
    });
  });

  describe('sender attribution', () => {
    it('keeps the full From line as attribution', () => {
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
      expect(result).toContain('From: Bob Johnson <bob@acme.com>');
      expect(result).toContain('Please find attached the Q3 report.');
    });

    it('keeps a From line that has only an email address', () => {
      const input = [
        'Body.',
        '',
        'From: <bob@acme.com>',
        'Sent: Monday, January 15, 2024 3:00 PM',
        '',
        'Content.',
      ].join('\n');
      const result = cleanThreadEmails(input);
      expect(result).toContain('From: <bob@acme.com>');
    });

    it('keeps an "On ... wrote:" line as attribution', () => {
      const input = [
        'Hi Alice, please review.',
        '',
        'On Mon, Jan 15, 2024 at 3:00 PM, Bob Johnson wrote:',
        '',
        'Here are the numbers.',
      ].join('\n');
      const result = cleanThreadEmails(input);
      expect(result).toContain('On Mon, Jan 15, 2024 at 3:00 PM, Bob Johnson wrote:');
      expect(result).toContain('Here are the numbers.');
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
      expect(result).toContain('From: Bob Johnson <bob@acme.com>');
      expect(result).toContain('Please find attached the Q3 report.');
      expect(result).toContain('From: Alice Chen');
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
      expect(result).toContain('From: Bob Johnson <bob@acme.com>');
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
      expect(result).toContain('From: Bob Johnson');
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
      expect(result).toBe('Current email body.\n\nFrom: Bob\n\nReply body.');
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

  describe('real-world multi-message thread', () => {
    const thread = [
      'Yes, I believe we can match it, Juliana.',
      '',
      'Based on the option you proposed, we can work toward the USD 34,500.00 target.',
      'Please let me know if there is any room to adjust the dimensions on your end.',
      '',
      '**Original Email**',
      '',
      'From: Juliana Correia <juliana.correia@delphiforwarding.com>',
      'Subject: RE: Quote IM 70414 | FOB Qingdao x Santos (new reference 71429)',
      '',
      'Dear Angelina,',
      '',
      'Our customer said that they have a total target USD 34.500,00 for this shipment.',
      '',
      'Do you believe that we can match it?',
      '',
      'De: TLM - Angelina Liu <tlm-angelinaliu@parisigs.com>',
      '',
      'Dear Larissa,',
      '',
      'Only if the length can be reduced to less than 11.5m to consider the 40fr option.',
      '',
      'Pls note:',
      '',
      'OOG rate depends on occupying deadspace, which depends on different carriers, subject to EFS, and final loading approval, EFS based on slot space killed.',
      '',
      'Excited to work on this!',
      '',
      '2504, A Bldg., ShenFang Plaza, Renmin South Road, Shenzhen 518001 China',
      '',
      'Tel: + [86] 755 8217 6271 ext 518',
      '',
      'WhatsApp/Wechat: + 86 156 0296 7319',
      '',
      'Email: tlm-angelinaliu@parisigs.com',
      '',
      'Website: www.pgs-log.com',
      '',
      'NVOCC: MOC-NV03667',
      '',
      'Office: Hong Kong - Taiwan - Shenzhen- Guangzhou- Xiamen- Ningbo- Shanghai- Qingdao',
      '',
      'From: Larissa Borsatti <larissa.borsatti@delphiforwarding.com>',
      '',
      'Dear,',
      '',
      'If we consider the disassembled equipments in the following terms, could we match it into a FLAT RACK equipment?',
      '',
      'Option 2 – Uncoupled unit (2 pieces):',
      'Piece 1: 14,700 mm (L) x 3,700 mm (W) x 3,500 mm (H) – Gross weight: 20 tons',
      'Piece 2: 14,700 mm (L) x 3,700 mm (W) x 1,600 mm (H) – Gross weight: 10 tons',
      'Total 2 pcs 30 tons 277cbm',
    ].join('\n');

    it('keeps From lines, strips other headers and the signature, preserves the next message', () => {
      const result = cleanThreadEmails(thread);
      expect(result).toContain('From: Juliana Correia <juliana.correia@delphiforwarding.com>');
      expect(result).toContain('De: TLM - Angelina Liu <tlm-angelinaliu@parisigs.com>');
      expect(result).toContain('From: Larissa Borsatti <larissa.borsatti@delphiforwarding.com>');
      expect(result).not.toContain('Subject:');
      expect(result).not.toContain('**Original Email**');
      expect(result).not.toContain('2504, A Bldg.');
      expect(result).not.toContain('Tel: + [86]');
      expect(result).not.toContain('WhatsApp/Wechat:');
      expect(result).not.toContain('NVOCC:');
      expect(result).not.toContain('www.pgs-log.com');
      expect(result).not.toContain('Office: Hong Kong');
      expect(result).toContain('Do you believe that we can match it?');
      expect(result).toContain('Excited to work on this!');
      expect(result).toContain('OOG rate depends on occupying deadspace');
      expect(result).toContain('If we consider the disassembled equipments');
      expect(result).toContain('Option 2 – Uncoupled unit (2 pieces):');
      expect(result).toContain('Total 2 pcs 30 tons 277cbm');
    });

    it('cuts from the signature feature line to the end of the segment (no From boundary)', () => {
      const input = [
        'Current email body.',
        '',
        'Angelina Liu',
        'OOG/BB/RORO project cargo',
        'Parisi Grand Smooth Logistics Ltd.',
        'Add: Room 2504, ShenFang Plaza, Shenzhen 518001 China',
        'Tel: + [86] 755 8217 6271',
        '',
        'Dear,',
        'If we consider the disassembled equipments...',
      ].join('\n');
      const result = cleanThreadEmails(input);
      expect(result).toContain('Current email body.');
      expect(result).not.toContain('Angelina Liu');
      expect(result).not.toContain('OOG/BB/RORO project cargo');
      expect(result).not.toContain('Parisi Grand Smooth Logistics Ltd.');
      expect(result).not.toContain('Tel: + [86]');
      // Content after the signature within the same segment is removed too.
      expect(result).not.toContain('If we consider the disassembled equipments...');
    });
  });

  describe('multilingual sender split and recipient lists', () => {
    it('splits by From, keeps the sender, and strips a De: recipient list (label-alone format)', () => {
      const input = [
        'From:',
        'Adeline Couto <adeline@mmlogisticsconsulting.com>',
        '',
        'De:',
        'TLM - Angelina Liu <tlm@x.com>,',
        'QDO - Amy Yu <amy@x.com>',
        '',
        'Dear Adeline,',
        'Long time!',
        'Just to confirm.',
        '',
        'From:',
        'Larissa Borsatti <larissa@x.com>',
        '',
        'De:',
        'TLM - Angelina Liu <tlm@x.com>',
        '',
        'Dear,',
        'If we consider the disassembled equipments...',
        'Total 2 pcs 30 tons 277cbm',
      ].join('\n');
      const result = cleanThreadEmails(input);
      expect(result).toContain('From: Adeline Couto <adeline@mmlogisticsconsulting.com>');
      expect(result).toContain('Dear Adeline,');
      expect(result).toContain('Long time!');
      expect(result).toContain('From: Larissa Borsatti <larissa@x.com>');
      expect(result).toContain('Total 2 pcs 30 tons 277cbm');
      expect(result).not.toContain('TLM - Angelina Liu <tlm@x.com>');
      expect(result).not.toContain('QDO - Amy Yu');
    });

    it('keeps a De: sender as attribution when it is the first header (FR/PT)', () => {
      const input = [
        'Current body.',
        '',
        'De:',
        'Marie Dupont <marie@x.com>',
        '',
        'Merci pour votre réponse.',
        '',
        'Cordialement,',
        'Marie Dupont',
      ].join('\n');
      const result = cleanThreadEmails(input);
      expect(result).toContain('De: Marie Dupont <marie@x.com>');
      expect(result).toContain('Merci pour votre réponse.');
      expect(result).not.toContain('Cordialement,');
    });

    it('keeps a Von: sender as attribution (German)', () => {
      const input = [
        'Body.',
        '',
        'Von: Max Müller <max@x.com>',
        'Gesendet am: Montag, 15. Januar 2024 15:00',
        'An: Anna',
        'Betreff: RE: Q3',
        '',
        'Vielen Dank.',
      ].join('\n');
      const result = cleanThreadEmails(input);
      expect(result).toContain('Von: Max Müller <max@x.com>');
      expect(result).toContain('Vielen Dank.');
      expect(result).not.toContain('Gesendet am');
      expect(result).not.toContain('Betreff');
    });
  });
});

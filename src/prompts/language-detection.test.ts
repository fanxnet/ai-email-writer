/**
 * AI Compose — Email Language Detection Unit Tests
 */

import { detectEmailLanguage } from './language-detection';

describe('detectEmailLanguage', () => {
  describe('script detection', () => {
    test('detects Chinese from predominantly Han text', () => {
      const body = '尊敬的客户您好，感谢您的来信。关于您提到的发货时间问题，我们已经安排物流团队跟进，预计三天内更新给您。';
      expect(detectEmailLanguage(body)).toBe('Chinese');
    });

    test('detects Chinese even when Simplified/Traditional is mixed (no distinction)', () => {
      const body = '親愛的用戶，這個月我們推出了新的優惠活動，請參考附件內容，謝謝您的支持。';
      expect(detectEmailLanguage(body)).toBe('Chinese');
    });

    test('detects Japanese from kana-dominant text', () => {
      const body = 'いつもお世話になっております。ご連絡いただきありがとうございます。ミーティングの日程は来週の水曜日に変更いたします。';
      expect(detectEmailLanguage(body)).toBe('Japanese');
    });

    test('detects Korean from Hangul text', () => {
      const body = '안녕하세요, 고객님. 보내주신 문의에 대해 답변드립니다. 배송 일정은 다음 주 월요일로 조정되었습니다.';
      expect(detectEmailLanguage(body)).toBe('Korean');
    });

    test('detects Russian from Cyrillic text', () => {
      const body = 'Уважаемый клиент, благодарим вас за письмо. Мы рассмотрели ваш вопрос и отправили ответ по электронной почте.';
      expect(detectEmailLanguage(body)).toBe('Russian');
    });
  });

  describe('Latin script → English', () => {
    test('detects English from common-word-heavy text', () => {
      const body = 'Dear John, thank you for your email. We are happy to confirm that the project will start on Monday as planned. Please let us know if you have any questions. Best regards, the team.';
      expect(detectEmailLanguage(body)).toBe('English');
    });

    test('an English email containing a Chinese excerpt still resolves to English', () => {
      const body = 'Hi Sarah, thanks for getting back to me. I wanted to follow up on the contract we discussed. 请查收附件，里面有完整方案。Let me know if you need more details. Regards, Mark.';
      expect(detectEmailLanguage(body)).toBe('English');
    });
  });

  describe('ambiguous / fallback', () => {
    test('returns null for empty or whitespace-only text', () => {
      expect(detectEmailLanguage('')).toBeNull();
      expect(detectEmailLanguage('   \n\t ')).toBeNull();
    });

    test('returns null for very short text', () => {
      expect(detectEmailLanguage('OK')).toBeNull();
      expect(detectEmailLanguage('See attached.')).toBeNull();
    });

    test('returns null when no script clearly dominates', () => {
      expect(detectEmailLanguage('abc 123 ==== &&& !!')).toBeNull();
    });
  });
});
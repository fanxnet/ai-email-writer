/**
 * AI Compose — Prompt Builder Unit Tests
 *
 * Tests for buildPrompt, truncateContext, and listPlaceholders.
 *
 * © Rizonetech (Pty) Ltd. — https://rizonesoft.com
 */

import { buildPrompt, truncateContext, listPlaceholders } from './builder';

// ---------------------------------------------------------------------------
// buildPrompt
// ---------------------------------------------------------------------------

describe('buildPrompt', () => {
  it('should replace a single placeholder', () => {
    const result = buildPrompt('Hello {{NAME}}!', { NAME: 'Alice' });
    expect(result).toBe('Hello Alice!');
  });

  it('should replace multiple different placeholders', () => {
    const result = buildPrompt('{{GREETING}} {{NAME}}, your order {{ID}} is ready.', {
      GREETING: 'Hi',
      NAME: 'Bob',
      ID: '12345',
    });
    expect(result).toBe('Hi Bob, your order 12345 is ready.');
  });

  it('should replace multiple occurrences of the same placeholder', () => {
    const result = buildPrompt('{{NAME}} said hello. {{NAME}} then left.', {
      NAME: 'Charlie',
    });
    expect(result).toBe('Charlie said hello. Charlie then left.');
  });

  it('should leave unknown placeholders as-is', () => {
    const result = buildPrompt('Hello {{NAME}}, status: {{STATUS}}', {
      NAME: 'Dave',
    });
    expect(result).toBe('Hello Dave, status: {{STATUS}}');
  });

  it('should silently ignore extra variables', () => {
    const result = buildPrompt('Hello {{NAME}}!', {
      NAME: 'Eve',
      UNUSED: 'ignored',
    });
    expect(result).toBe('Hello Eve!');
  });

  it('should handle empty string values', () => {
    const result = buildPrompt('Subject: {{SUBJECT}}', { SUBJECT: '' });
    expect(result).toBe('Subject: ');
  });

  it('should handle multiline templates', () => {
    const template = `Line 1: {{A}}
Line 2: {{B}}
Line 3: {{C}}`;
    const result = buildPrompt(template, { A: 'alpha', B: 'beta', C: 'gamma' });
    expect(result).toBe('Line 1: alpha\nLine 2: beta\nLine 3: gamma');
  });

  it('should throw for empty template', () => {
    expect(() => buildPrompt('', { NAME: 'test' })).toThrow('Prompt template cannot be empty');
  });

  it('should replace RULES, PROFILE, and GOAL placeholders', () => {
    const result = buildPrompt(
      'Hello {{NAME}}\n{{RULES}}\n{{PROFILE}}\n{{GOAL}}',
      {
        NAME: 'Alice',
        RULES: '\nAdditional rules:\n- Mock rule',
        PROFILE: '\nRole and profile:\nI build software.',
        GOAL: '\nStrategic goal: Close a deal.',
      }
    );
    expect(result).toContain('Mock rule');
    expect(result).toContain('Role and profile:');
    expect(result).toContain('I build software.');
    expect(result).toContain('Strategic goal: Close a deal.');
  });

  it('should handle empty optional placeholders', () => {
    const result = buildPrompt('Hello {{NAME}}\n{{RULES}}\n{{PROFILE}}\n{{GOAL}}', {
      NAME: 'Alice',
      RULES: '',
      PROFILE: '',
      GOAL: '',
    });
    expect(result).toBe('Hello Alice\n\n\n');
  });
});

// ---------------------------------------------------------------------------
// truncateContext
// ---------------------------------------------------------------------------

describe('truncateContext', () => {
  it('should not truncate text shorter than the token limit', () => {
    const text = 'Short text.';
    const result = truncateContext(text, 100);
    expect(result).toBe(text);
  });

  it('should truncate long text at a sentence boundary', () => {
    // Total text is ~130 chars. 15 tokens ≈ 60 chars.
    // Suffix is ~35 chars, leaving ~25 chars for content.
    // "First sentence." = 15 chars, fits within budget.
    const text =
      'First sentence. Second sentence is a bit longer. Third sentence has even more detail. Fourth sentence wraps it all up nicely.';
    const result = truncateContext(text, 15);
    expect(result).toContain('First sentence.');
    expect(result).toContain('[Content truncated');
    expect(result.length).toBeLessThan(text.length);
  });

  it('should append a truncation suffix', () => {
    const text = 'A'.repeat(1000);
    const result = truncateContext(text, 50);
    expect(result).toContain('[Content truncated due to length');
  });

  it('should return empty string for empty input', () => {
    expect(truncateContext('', 100)).toBe('');
  });

  it('should throw for zero or negative maxTokens', () => {
    expect(() => truncateContext('test', 0)).toThrow('maxTokens must be a positive number');
    expect(() => truncateContext('test', -5)).toThrow('maxTokens must be a positive number');
  });

  it('should handle text with no sentence boundaries', () => {
    const text = 'A very long string without any punctuation ' + 'word '.repeat(100);
    const result = truncateContext(text, 20);
    expect(result).toContain('[Content truncated');
  });

  it('should handle text exactly at the token limit', () => {
    // 10 tokens ≈ 40 chars
    const text = 'A'.repeat(40);
    const result = truncateContext(text, 10);
    expect(result).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// listPlaceholders
// ---------------------------------------------------------------------------

describe('listPlaceholders', () => {
  it('should list all unique placeholders', () => {
    const result = listPlaceholders('Hello {{NAME}}, your {{ITEM}} is {{STATUS}}.');
    expect(result).toEqual(['NAME', 'ITEM', 'STATUS']);
  });

  it('should deduplicate repeated placeholders', () => {
    const result = listPlaceholders('{{A}} and {{B}} and {{A}} again.');
    expect(result).toEqual(['A', 'B']);
  });

  it('should return empty array for templates with no placeholders', () => {
    const result = listPlaceholders('No placeholders here.');
    expect(result).toEqual([]);
  });

  it('should return empty array for empty string', () => {
    const result = listPlaceholders('');
    expect(result).toEqual([]);
  });

  it('should handle placeholders with underscores and numbers', () => {
    const result = listPlaceholders('{{FIRST_NAME}} {{ADDRESS_2}}');
    expect(result).toEqual(['FIRST_NAME', 'ADDRESS_2']);
  });
});

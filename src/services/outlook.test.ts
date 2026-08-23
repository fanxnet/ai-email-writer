/**
 * AI Compose — Outlook Email Reader Service Unit Tests
 *
 * Tests for emailHtmlToText (HTML → plain-text conversion).
 * Only the pure function is tested; Outlook API callers are excluded.
 */

import { emailHtmlToText } from './outlook';

// ---------------------------------------------------------------------------
// emailHtmlToText
// ---------------------------------------------------------------------------

describe('emailHtmlToText', () => {
  it('strips HTML tags and preserves plain text', () => {
    expect(emailHtmlToText('<p>Hello</p>')).toBe('Hello');
  });

  it('converts <br> to newlines', () => {
    expect(emailHtmlToText('Line 1<br>Line 2')).toBe('Line 1\nLine 2');
  });

  it('converts <hr> to newlines (quoted separator support)', () => {
    const html = '<p>Current content</p><hr><p>Older content</p>';
    expect(emailHtmlToText(html)).toContain('Current content');
    expect(emailHtmlToText(html)).toContain('Older content');
    expect(emailHtmlToText(html)).toContain('\n');
  });

  it('removes <blockquote> containers', () => {
    const html = 'Reply<blockquote><p>Quoted text</p></blockquote>';
    expect(emailHtmlToText(html)).toContain('Reply');
    expect(emailHtmlToText(html)).not.toContain('Quoted');
  });

  it('removes gmail_quote div', () => {
    const html = '<p>Current</p><div class="gmail_quote">Quoted</div>';
    expect(emailHtmlToText(html)).toContain('Current');
    expect(emailHtmlToText(html)).not.toContain('Quoted');
  });

  it('removes yahoo_quoted div', () => {
    const html = '<p>Current</p><div class="yahoo_quoted">Quoted</div>';
    expect(emailHtmlToText(html)).toContain('Current');
    expect(emailHtmlToText(html)).not.toContain('Quoted');
  });

  it('preserves link display text, drops href', () => {
    const html = '<a href="https://example.com">Link text</a>';
    expect(emailHtmlToText(html)).toBe('Link text');
  });

  it('decodes common HTML entities', () => {
    const html = '<p>&amp; &lt;test&gt; &quot;hi&quot;</p>';
    expect(emailHtmlToText(html)).toBe('& <test> "hi"');
  });

  it('decodes Latin accented entities (localized headers)', () => {
    const html = '<p>Envoy&eacute; le &Agrave; 15 janvier, &Uuml;ber</p>';
    expect(emailHtmlToText(html)).toBe('Envoyé le À 15 janvier, Über');
  });

  it('strips style and script tags', () => {
    const html = '<style>.x{}</style><script>alert(1)</script><p>Content</p>';
    expect(emailHtmlToText(html)).toBe('Content');
  });

  it('collapses multiple spaces', () => {
    expect(emailHtmlToText('<p>   hello   world   </p>')).toBe('hello world');
  });

  it('collapses 3+ newlines into 2', () => {
    const html = '<p>A</p><p>B</p><p>C</p><p>D</p>';
    expect(emailHtmlToText(html)).toBe('A\nB\nC\nD');
  });

  it('trims leading and trailing whitespace', () => {
    expect(emailHtmlToText('  <p>Text</p>  ')).toBe('Text');
  });

  it('handles empty input', () => {
    expect(emailHtmlToText('')).toBe('');
  });
});

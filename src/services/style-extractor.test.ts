/**
 * @jest-environment jsdom
 */
import { extractTextStyleFromHtml, buildStyledBodyHtml } from './style-extractor';

describe('extractTextStyleFromHtml', () => {
  it('returns null for empty input', () => {
    expect(extractTextStyleFromHtml('')).toBeNull();
    expect(extractTextStyleFromHtml(null as any)).toBeNull();
    expect(extractTextStyleFromHtml(undefined as any)).toBeNull();
  });

  it('returns null for HTML with no font styling', () => {
    expect(extractTextStyleFromHtml('<p>Hello world</p>')).toBeNull();
  });

  it('extracts font-family from inline style', () => {
    const html = '<p style="font-family: Calibri, Arial;">Hello</p>';
    const result = extractTextStyleFromHtml(html);
    expect(result?.fontFamily).toBe('calibri');
  });

  it('extracts font-size in px and converts to pt', () => {
    const html = '<p style="font-size: 16px;">Hello</p>';
    const result = extractTextStyleFromHtml(html);
    expect(result?.fontSizePt).toBe(12); // 16 * 0.75 = 12
  });

  it('extracts font-size in pt directly', () => {
    const html = '<p style="font-size: 14pt;">Hello</p>';
    const result = extractTextStyleFromHtml(html);
    expect(result?.fontSizePt).toBe(14);
  });

  it('extracts color from hex', () => {
    const html = '<p style="color: #333333;">Hello</p>';
    const result = extractTextStyleFromHtml(html);
    expect(result?.color).toBe('#333333');
  });

  it('expands 3-digit hex color', () => {
    const html = '<p style="color: #fff;">Hello</p>';
    const result = extractTextStyleFromHtml(html);
    expect(result?.color).toBe('#ffffff');
  });

  it('converts rgb() to hex', () => {
    const html = '<p style="color: rgb(102, 102, 102);">Hello</p>';
    const result = extractTextStyleFromHtml(html);
    expect(result?.color).toBe('#666666');
  });

  it('extracts all three properties from one element', () => {
    const html = '<div style="font-family:Arial;font-size:12pt;color:#000"><p>Hi</p></div>';
    const result = extractTextStyleFromHtml(html);
    expect(result).toEqual({
      fontFamily: 'arial',
      fontSizePt: 12,
      color: '#000000',
    });
  });

  it('picks the most frequent font-family (mode)', () => {
    const html = `
      <div>
        <p style="font-family: Calibri;">A</p>
        <p style="font-family: Arial;">B</p>
        <p style="font-family: Calibri;">C</p>
        <p style="font-family: Calibri;">D</p>
      </div>
    `;
    const result = extractTextStyleFromHtml(html);
    expect(result?.fontFamily).toBe('calibri');
  });

  it('handles legacy <font> tags', () => {
    const html = '<font face="Verdana" size="4" color="#ff0000">Hello</font>';
    const result = extractTextStyleFromHtml(html);
    expect(result).toEqual({
      fontFamily: 'verdana',
      fontSizePt: 14,
      color: '#ff0000',
    });
  });

  it('reads font from body wrapper style', () => {
    const html = '<body style="font-family: Tahoma; font-size: 11pt; color: #444"><p>Hi</p></body>';
    const result = extractTextStyleFromHtml(html);
    expect(result).toEqual({
      fontFamily: 'tahoma',
      fontSizePt: 11,
      color: '#444444',
    });
  });

  it('ignores non-font CSS properties', () => {
    const html = '<p style="margin: 0; padding: 10px; font-family: Georgia;">Hello</p>';
    const result = extractTextStyleFromHtml(html);
    expect(result).toEqual({ fontFamily: 'georgia' });
  });

  it('handles named colors', () => {
    const html = '<p style="color: red;">Hello</p>';
    const result = extractTextStyleFromHtml(html);
    expect(result?.color).toBe('#ff0000');
  });

  it('returns partial result when only some properties found', () => {
    const html = '<p style="font-family: Helvetica;">Hello</p>';
    const result = extractTextStyleFromHtml(html);
    expect(result).toEqual({ fontFamily: 'helvetica' });
  });
});

describe('buildStyledBodyHtml', () => {
  it('returns empty string for empty text', () => {
    expect(buildStyledBodyHtml('', null)).toBe('');
  });

  it('wraps paragraphs in <p> tags', () => {
    const result = buildStyledBodyHtml('Hello world', null);
    expect(result).toBe('<p>Hello world</p>');
  });

  it('splits paragraphs on double newlines', () => {
    const result = buildStyledBodyHtml('Para 1\n\nPara 2', null);
    expect(result).toBe('<p>Para 1</p><p>Para 2</p>');
  });

  it('converts single newlines to <br>', () => {
    const result = buildStyledBodyHtml('Line 1\nLine 2', null);
    expect(result).toBe('<p>Line 1<br>Line 2</p>');
  });

  it('applies inline style when style is provided', () => {
    const style = { fontFamily: 'calibri', fontSizePt: 12, color: '#000000' };
    const result = buildStyledBodyHtml('Hello', style);
    expect(result).toBe('<p style="font-family:calibri;font-size:12pt;color:#000000">Hello</p>');
  });

  it('applies partial style (font-family only)', () => {
    const result = buildStyledBodyHtml('Hello', { fontFamily: 'Arial' });
    expect(result).toBe('<p style="font-family:Arial">Hello</p>');
  });

  it('escapes HTML in input text', () => {
    const result = buildStyledBodyHtml('Use <b>bold</b> & "quotes"', null);
    expect(result).toBe('<p>Use &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quotes&quot;</p>');
  });

  it('handles multiple paragraphs with style', () => {
    const style = { fontFamily: 'Georgia', color: '#333' };
    const result = buildStyledBodyHtml('First\n\nSecond', style);
    expect(result).toBe(
      '<p style="font-family:Georgia;color:#333">First</p>' +
      '<p style="font-family:Georgia;color:#333">Second</p>',
    );
  });

  it('filters empty paragraphs (blank lines)', () => {
    const result = buildStyledBodyHtml('Para 1\n\n\n\nPara 2', null);
    expect(result).toBe('<p>Para 1</p><p>Para 2</p>');
  });

  it('filters leading empty paragraphs', () => {
    const result = buildStyledBodyHtml('\n\nHello', null);
    expect(result).toBe('<p>Hello</p>');
  });

  it('filters trailing empty paragraphs', () => {
    const result = buildStyledBodyHtml('Hello\n\n', null);
    expect(result).toBe('<p>Hello</p>');
  });

  it('normalises \\r\\n to \\n before processing', () => {
    const result = buildStyledBodyHtml('A\r\n\r\nB', null);
    expect(result).toBe('<p>A</p><p>B</p>');
  });
});

/**
 * AI Compose — Email Style Extractor
 *
 * Extracts dominant font styling (family, size, colour) from email HTML
 * so that AI-generated replies can match the original email's look.
 *
 * Also provides a helper to build styled HTML from plain text for reply
 * insertion.
 *
 * © Rizonetech (Pty) Ltd. — https://rizonesoft.com
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal font styling extracted from an email body. */
export interface TextStyle {
  fontFamily?: string;
  fontSizePt?: number;
  color?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyse an HTML string and return the most common font-related styles.
 *
 * Looks at both inline `style` attributes and legacy `<font>` tags.
 * Returns `null` when no meaningful style data is found.
 *
 * Whitelist: only `font-family`, `font-size`, and `color` are extracted.
 */
export function extractTextStyleFromHtml(html: string): TextStyle | null {
  if (!html || typeof html !== 'string') return null;

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return null;
  }

  const families: Record<string, number> = {};
  const sizes: Record<string, number> = {};
  const colors: Record<string, number> = {};

  // 1. Walk every element that carries a `style` attribute
  const styled = doc.querySelectorAll('[style]');
  styled.forEach((el) => {
    const inline = el.getAttribute('style') || '';
    const parsed = parseInlineStyle(inline);

    if (parsed.fontFamily) addCount(families, normaliseFontFamily(parsed.fontFamily));
    if (parsed.fontSize) {
      const pt = cssSizeToPt(parsed.fontSize);
      if (pt > 0) addCount(sizes, String(pt));
    }
    if (parsed.color) addCount(colors, normaliseColor(parsed.color));
  });

  // 2. Walk legacy <font> tags
  const fontTags = doc.querySelectorAll('font');
  fontTags.forEach((font) => {
    const face = font.getAttribute('face');
    if (face) addCount(families, normaliseFontFamily(face));

    const size = font.getAttribute('size');
    if (size) {
      const pt = legacySizeToPt(size);
      if (pt > 0) addCount(sizes, String(pt));
    }

    const color = font.getAttribute('color');
    if (color) addCount(colors, normaliseColor(color));
  });

  // 3. Also check parent elements' computed-style via the closest
  //    inline-style ancestor (a common pattern is wrapping everything
  //    in a div with a single style attribute).
  const root = doc.body;
  if (root) {
    const rootInline = root.getAttribute('style');
    if (rootInline) {
      const parsed = parseInlineStyle(rootInline);
      if (parsed.fontFamily) addCount(families, normaliseFontFamily(parsed.fontFamily));
      if (parsed.fontSize) {
        const pt = cssSizeToPt(parsed.fontSize);
        if (pt > 0) addCount(sizes, String(pt));
      }
      if (parsed.color) addCount(colors, normaliseColor(parsed.color));
    }
  }

  // 4. Pick the mode (most frequent value) for each property
  const result: TextStyle = {};

  const bestFamily = bestEntry(families);
  if (bestFamily) result.fontFamily = bestFamily;

  const bestSize = bestEntry(sizes);
  if (bestSize) result.fontSizePt = parseFloat(bestSize);

  const bestColor = bestEntry(colors);
  if (bestColor) result.color = bestColor;

  // Return null if nothing meaningful was found
  if (!result.fontFamily && !result.fontSizePt && !result.color) return null;
  return result;
}

/**
 * Build an HTML body string from plain text, wrapping each paragraph
 * in `<p>` tags with optional inline font styling.
 *
 * Empty paragraphs (blank lines) in the source are filtered out.
 * Paragraph-ending line breaks are preserved: `\n` inside each paragraph
 * becomes `<br>`, and each paragraph is a separate `<p>` block.
 *
 * This replaces the plain `bodyToHtml()` helper in draft-reply / draft-email.
 */
export function buildStyledBodyHtml(text: string, style: TextStyle | null): string {
  if (!text) return '';

  const normalised = text.replace(/\r\n?/g, '\n');
  const paragraphs = normalised.split('\n\n').filter((p) => p.trim().length > 0);
  const attr = buildStyleAttr(style);

  return paragraphs
    .map((para) => {
      const inner = escapeHtml(para).split('\n').join('<br>');
      return `<p${attr}>${inner}</p>`;
    })
    .join('');
}

/**
 * Build a ` style="..."` attribute string from a TextStyle, or empty
 * string when the style is null or has no properties.
 */
function buildStyleAttr(style: TextStyle | null): string {
  if (!style) return '';
  const parts: string[] = [];
  if (style.fontFamily) parts.push(`font-family:${style.fontFamily}`);
  if (style.fontSizePt) parts.push(`font-size:${style.fontSizePt}pt`);
  if (style.color) parts.push(`color:${style.color}`);
  return parts.length > 0 ? ` style="${parts.join(';')}"` : '';
}

// ---------------------------------------------------------------------------
// Inline style parsing (lightweight, no external deps)
// ---------------------------------------------------------------------------

const STYLE_SPLIT = /;\s*/;
const STYLE_KV = /^\s*([a-z-]+)\s*:\s*(.+)\s*$/;
const VALID_PROPS = new Set(['font-family', 'font-size', 'color']);

interface ParsedStyle {
  fontFamily?: string;
  fontSize?: string;
  color?: string;
}

function parseInlineStyle(inline: string): ParsedStyle {
  const result: ParsedStyle = {};
  for (const token of inline.split(STYLE_SPLIT)) {
    const m = STYLE_KV.exec(token);
    if (!m) continue;
    const prop = m[1].toLowerCase();
    const val = m[2].trim();
    if (!VALID_PROPS.has(prop)) continue;

    if (prop === 'font-family') result.fontFamily = val;
    else if (prop === 'font-size') result.fontSize = val;
    else if (prop === 'color') result.color = val;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Font-family normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise a font-family string: strip quotes, take the primary family
 * (first in a comma-separated stack), lowercase.
 *
 * Example: `"Calibri", Arial, Helvetica, sans-serif` → `calibri`
 */
function normaliseFontFamily(raw: string): string {
  const first = raw.split(',')[0].trim();
  // Strip surrounding quotes (single or double)
  const unquoted = first.replace(/^["']|["']$/g, '').trim();
  return unquoted.toLowerCase();
}

// ---------------------------------------------------------------------------
// Font-size conversion
// ---------------------------------------------------------------------------

/** Map legacy HTML `<font size="1-7">` to pt. */
const LEGACY_SIZE_MAP: Record<string, number> = {
  '1': 8,
  '2': 10,
  '3': 12,
  '4': 14,
  '5': 18,
  '6': 24,
  '7': 36,
};

function legacySizeToPt(raw: string): number {
  const n = parseInt(raw, 10);
  if (n >= 1 && n <= 7) return LEGACY_SIZE_MAP[String(n)];
  return 0;
}

/**
 * Convert a CSS font-size value (e.g. `12px`, `14pt`, `1em`, `120%`)
 * to pt.  Returns 0 for values that cannot be reliably converted.
 */
function cssSizeToPt(raw: string): number {
  const s = raw.trim().toLowerCase();

  // px → pt (1px = 0.75pt)
  const pxMatch = s.match(/^([\d.]+)\s*px$/);
  if (pxMatch) return Math.round(parseFloat(pxMatch[1]) * 0.75 * 10) / 10;

  // pt (direct)
  const ptMatch = s.match(/^([\d.]+)\s*pt$/);
  if (ptMatch) return parseFloat(ptMatch[1]);

  // em/rem/% — cannot resolve without a base size, skip
  return 0;
}

// ---------------------------------------------------------------------------
// Colour normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise a CSS colour to 6-digit hex: `#rrggbb`.
 * Handles 3-digit hex, `rgb(r,g,b)`, and named colours.
 */
const NAMED_COLORS: Record<string, string> = {
  black: '#000000',
  blue: '#0000ff',
  green: '#008000',
  gray: '#808080',
  grey: '#808080',
  red: '#ff0000',
  white: '#ffffff',
  orange: '#ffa500',
  purple: '#800080',
  yellow: '#ffff00',
};

function normaliseColor(raw: string): string {
  const s = raw.trim().toLowerCase();

  // 6-digit hex
  if (/^#[0-9a-f]{6}$/.test(s)) return s;

  // 3-digit hex → expand
  if (/^#[0-9a-f]{3}$/.test(s)) {
    return (
      '#' +
      s[1] + s[1] +
      s[2] + s[2] +
      s[3] + s[3]
    );
  }

  // rgb(r, g, b)
  const rgbMatch = s.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1], 10);
    const g = parseInt(rgbMatch[2], 10);
    const b = parseInt(rgbMatch[3], 10);
    return (
      '#' +
      r.toString(16).padStart(2, '0') +
      g.toString(16).padStart(2, '0') +
      b.toString(16).padStart(2, '0')
    );
  }

  // Named colour
  if (NAMED_COLORS[s]) return NAMED_COLORS[s];

  // Unknown — return as-is (caller will still count it)
  return s;
}

// ---------------------------------------------------------------------------
// HTML escaping (shared with buildStyledBodyHtml)
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Increment a tally counter for a key. */
function addCount(map: Record<string, number>, key: string): void {
  map[key] = (map[key] || 0) + 1;
}

/** Return the key with the highest count, or `undefined` if empty. */
function bestEntry(map: Record<string, number>): string | undefined {
  let bestKey: string | undefined;
  let bestCount = 0;
  for (const [key, count] of Object.entries(map)) {
    if (count > bestCount) {
      bestKey = key;
      bestCount = count;
    }
  }
  return bestKey;
}

/**
 * AI Compose — HTML Thread Truncation
 *
 * Truncates a full conversation-thread email to the most recent N messages by
 * detecting reply boundaries in the HTML structure, BEFORE the HTML is
 * flattened to text. Structural boundaries (blockquote nesting depth,
 * quoted-message separators, Outlook containers) are far more reliable than
 * trying to recognise quoted content after the text has been flattened.
 *
 * © Rizonetech (Pty) Ltd. — https://rizonesoft.com
 */

// ---------------------------------------------------------------------------
// Strategy A: nested <blockquote> depth
// ---------------------------------------------------------------------------

const BLOCKQUOTE_OPEN_RE = /<blockquote\b[^>]*>/gi;
const BLOCKQUOTE_CLOSE_RE = /<\/blockquote\s*>/gi;

/**
 * Cut the HTML so only the newest `keepReplies` messages remain when the
 * thread is built from nested <blockquote> elements (Gmail, Outlook Web,
 * Yahoo, Apple Mail, Thunderbird). Kept blockquotes are unwrapped to <div> so
 * the later HTML→text conversion does not strip the messages we want to keep;
 * everything from the first blockquote at depth `keepReplies` onward (older
 * history) is dropped.
 *
 * Returns `null` when the HTML contains no blockquotes, signalling the caller
 * to fall back to the separator strategy.
 */
function cutAtBlockquoteDepth(html: string, keepReplies: number): string | null {
  if (!/<blockquote\b/i.test(html)) return null;

  interface BoundaryEvent {
    index: number;
    open: boolean;
    raw: string;
  }

  const events: BoundaryEvent[] = [];
  let m: RegExpExecArray | null;

  BLOCKQUOTE_OPEN_RE.lastIndex = 0;
  while ((m = BLOCKQUOTE_OPEN_RE.exec(html))) {
    events.push({ index: m.index, open: true, raw: m[0] });
  }
  BLOCKQUOTE_CLOSE_RE.lastIndex = 0;
  while ((m = BLOCKQUOTE_CLOSE_RE.exec(html))) {
    events.push({ index: m.index, open: false, raw: m[0] });
  }
  events.sort((a, b) => a.index - b.index);

  const parts: string[] = [];
  let depth = 0;
  let cursor = 0;

  for (const ev of events) {
    if (ev.open) {
      if (depth >= keepReplies - 1) {
        // Opening a blockquote at depth `keepReplies` → older thread history.
        parts.push(html.slice(cursor, ev.index));
        return parts.join('');
      }
      parts.push(html.slice(cursor, ev.index), '<div>');
      depth += 1;
      cursor = ev.index + ev.raw.length;
    } else {
      parts.push(html.slice(cursor, ev.index), '</div>');
      depth = Math.max(0, depth - 1);
      cursor = ev.index + ev.raw.length;
    }
  }

  // Fewer quoted replies than keepReplies: keep everything, preserving the
  // unwrapped form so emailHtmlToText does not strip the quoted messages.
  parts.push(html.slice(cursor));
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Strategy B: generic separators / quoted containers
// ---------------------------------------------------------------------------

/** Reliable quoted-message start markers (separator lines + Outlook containers). */
const STRONG_SEPARATOR_RE =
  /-{3,}\s*(?:Original Message|Message d'origine|Ursprüngliche Nachricht|Mensaje original|Messaggio originale|Mensagem original|原始邮件|转发的消息|Odpowiedź|Odpowiedz|Oorspronkelijk bericht|Alkuperäinen viesti|Ursprungligt meddelande|Meddelande)\s*-{3,}|_{3,}\s*(?:Original Message|Message d'origine|Ursprüngliche Nachricht|Mensaje original|Messaggio originale|Mensagem original|原始邮件|转发的消息)\s*_{3,}|class=["']OutlookMessageHeader["']|id=["']divRplyFwdMsg["']/gi;

/** Horizontal rules — weaker signal, only used when no strong markers exist. */
const HR_RE = /<hr\b[^>]*\/?>/gi;

/** Drop strong markers that sit within this many chars of an earlier marker. */
const STRONG_WINDOW = 30;

/**
 * Deduplicate a sorted list of boundary indexes: two markers closer than
 * `STRONG_WINDOW` chars almost certainly describe the same quoted message.
 */
function dedupe(indexes: number[]): number[] {
  const sorted = indexes.sort((a, b) => a - b);
  const out: number[] = [];
  for (const index of sorted) {
    if (out.length === 0 || index - out[out.length - 1] > STRONG_WINDOW) {
      out.push(index);
    }
  }
  return out;
}

/** True when the HTML before `index` contains real (non-tag) text. */
function hasRealContentBefore(html: string, index: number): boolean {
  return html.slice(0, index).replace(/<[^>]+>/g, ' ').trim().length > 0;
}

/**
 * Cut the HTML so only the newest `keepReplies` messages remain using generic
 * quoted-message separators and container markers (Classic Outlook and others
 * that do not nest <blockquote>). Returns `null` when no boundary is found or
 * when the body is a forward whose "original" block is its own content.
 */
function cutAtSeparator(html: string, keepReplies: number): string | null {
  const strong: number[] = [];
  const hrs: number[] = [];
  let m: RegExpExecArray | null;

  STRONG_SEPARATOR_RE.lastIndex = 0;
  while ((m = STRONG_SEPARATOR_RE.exec(html))) {
    strong.push(m.index);
  }
  HR_RE.lastIndex = 0;
  while ((m = HR_RE.exec(html))) {
    hrs.push(m.index);
  }

  const strongMarkers = dedupe(strong);
  if (strongMarkers.length >= keepReplies) {
    return cutAtIndex(html, strongMarkers, keepReplies);
  }

  // Strong markers are insufficient — supplement with <hr> boundaries, but
  // ignore an <hr> that merely decorates a strong marker's own message.
  const boundaries = [...strongMarkers];
  for (const hr of hrs) {
    if (strongMarkers.some((s) => Math.abs(hr - s) < STRONG_WINDOW)) continue;
    boundaries.push(hr);
  }
  boundaries.sort((a, b) => a - b);

  return cutAtIndex(html, boundaries, keepReplies);
}

/** Cut just before the `keepReplies`-th boundary, with forward-preservation guard. */
function cutAtIndex(html: string, boundaries: number[], keepReplies: number): string | null {
  if (boundaries.length === 0) return null;

  // If the first boundary sits at the very top of the body, this is a
  // forwarded message whose "original" content is the actual body — preserve it.
  if (!hasRealContentBefore(html, boundaries[0])) return null;

  const cutIndex = boundaries[keepReplies - 1];
  if (cutIndex === undefined) return null; // fewer boundaries than keepReplies

  return html.slice(0, cutIndex);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Truncate a conversation-thread HTML email to the most recent `keepReplies`
 * messages (default 3), dropping older quoted history.
 *
 * Boundary detection is structural and client-agnostic:
 *  1. nested <blockquote> depth (most universal),
 *  2. quoted-message separators / Outlook containers / <hr>,
 *  3. if nothing matches, the input is returned unchanged and downstream
 *     text filtering / character truncation still apply.
 */
export function truncateHtmlThread(html: string, keepReplies = 3): string {
  if (!html) return html;
  const k = Math.max(1, Math.floor(keepReplies));

  const byBlockquote = cutAtBlockquoteDepth(html, k);
  if (byBlockquote !== null) return byBlockquote;

  const bySeparator = cutAtSeparator(html, k);
  if (bySeparator !== null) return bySeparator;

  return html;
}

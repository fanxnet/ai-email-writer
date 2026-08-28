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
 * Split the HTML into per-message fragments when the thread is built from
 * nested <blockquote> elements (Gmail, Outlook Web, Yahoo, Apple Mail,
 * Thunderbird). The first fragment is the current email; each following
 * fragment is one quoted reply. Kept blockquotes are unwrapped to <div> so the
 * later HTML→text conversion keeps their content.
 *
 * Returns `null` when the HTML contains no blockquotes, signalling the caller
 * to fall back to the separator strategy.
 */
function splitByBlockquoteDepth(html: string, keepReplies: number): string[] | null {
  if (!/<blockquote\b/i.test(html)) return null;

  const opens: number[] = [];
  let m: RegExpExecArray | null;
  BLOCKQUOTE_OPEN_RE.lastIndex = 0;
  while ((m = BLOCKQUOTE_OPEN_RE.exec(html))) {
    opens.push(m.index);
  }

  const keep = Math.min(keepReplies, opens.length + 1);
  const fragments: string[] = [];
  for (let j = 0; j < keep; j++) {
    const start = j === 0 ? 0 : opens[j - 1];
    const end = j < opens.length ? opens[j] : html.length;
    fragments.push(
      html
        .slice(start, end)
        .replace(BLOCKQUOTE_OPEN_RE, '<div>')
        .replace(BLOCKQUOTE_CLOSE_RE, '</div>'),
    );
  }
  return fragments;
}

// ---------------------------------------------------------------------------
// Strategy B: generic separators / quoted containers
// ---------------------------------------------------------------------------

/** Reliable quoted-message start markers (separator lines + Outlook containers).
 *  Container markers match the FULL opening tag so the split boundary lands on
 *  the "<" — otherwise a fragment would start mid-tag and leak a broken tag. */
const STRONG_SEPARATOR_RE =
  /-{3,}\s*(?:Original Message|Message d'origine|Ursprüngliche Nachricht|Mensaje original|Messaggio originale|Mensagem original|原始邮件|转发的消息|Odpowiedź|Odpowiedz|Oorspronkelijk bericht|Alkuperäinen viesti|Ursprungligt meddelande|Meddelande)\s*-{3,}|_{3,}\s*(?:Original Message|Message d'origine|Ursprüngliche Nachricht|Mensaje original|Messaggio originale|Mensagem original|原始邮件|转发的消息)\s*_{3,}|<\w+\b[^>]*?\b(?:class=["']OutlookMessageHeader["']|id=["']divRplyFwdMsg["'])[^>]*>/gi;

/** Horizontal rules — weaker signal, only used when no strong markers exist. */
const HR_RE = /<hr\b[^>]*\/?>/gi;

/** Drop strong markers that sit within this many chars of an earlier marker. */
const STRONG_WINDOW = 30;

/** Text "From:"/"De:"-style sender labels that start a quoted message. */
const HTML_FROM_LABEL_RE = /\b(?:From|De|Von|Da|Sender)\b|发件人|寄件人/gi;

/** A From marker is absorbed by a preceding separator/container within this distance. */
const FROM_AFTER_STRONG_WINDOW = 120;

/**
 * Positions of text "From:"/"De:"-style sender markers in the HTML. The label
 * must be immediately followed (tags/whitespace allowed) by a colon, so body
 * sentences like "From the meeting at 3:00" are not treated as markers.
 */
function findHtmlFromMarkers(html: string): number[] {
  const positions: number[] = [];
  let m: RegExpExecArray | null;
  HTML_FROM_LABEL_RE.lastIndex = 0;
  while ((m = HTML_FROM_LABEL_RE.exec(html))) {
    const after = html.slice(m.index + m[0].length, m.index + m[0].length + 60);
    if (/^(?:(?:<[^>]*>|\s)*?)[:：]/.test(after)) {
      positions.push(m.index);
    }
  }
  return positions;
}

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
 * Split the HTML into per-message fragments using generic quoted-message
 * separators and container markers (Classic Outlook and others that do not
 * nest <blockquote>). The first fragment is the current email; each following
 * fragment is one quoted reply. Returns `null` when no boundary is found, and
 * returns a single fragment when the body is a forward whose "original" block
 * is its own content.
 */
function splitAtSeparators(html: string, keepReplies: number): string[] | null {
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
  // A text "From:" marker that merely follows a separator/container's header is
  // absorbed into that message; only standalone markers start a new message.
  const fromMarkers = findHtmlFromMarkers(html).filter(
    (f) => !strongMarkers.some((s) => f - s > 0 && f - s < FROM_AFTER_STRONG_WINDOW),
  );

  const primary = dedupe([...strongMarkers, ...fromMarkers]);
  let boundaries: number[];
  if (primary.length >= keepReplies) {
    boundaries = primary;
  } else {
    const merged = [...primary];
    for (const hr of hrs) {
      if (primary.some((s) => Math.abs(hr - s) < STRONG_WINDOW)) continue;
      merged.push(hr);
    }
    boundaries = merged.sort((a, b) => a - b);
  }

  if (boundaries.length === 0) return null;

  // If the first boundary sits at the very top of the body, this is a
  // forwarded message whose "original" content is the actual body — keep it whole.
  if (!hasRealContentBefore(html, boundaries[0])) return [html];

  const keep = Math.min(keepReplies, boundaries.length + 1);
  const fragments: string[] = [];
  for (let j = 0; j < keep; j++) {
    const start = j === 0 ? 0 : boundaries[j - 1];
    const end = j < boundaries.length ? boundaries[j] : html.length;
    fragments.push(html.slice(start, end));
  }
  return fragments;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Split a conversation-thread HTML email into its most recent `keepReplies`
 * messages as individual HTML fragments (newest first: the current email, then
 * each newer-to-older quoted reply).
 *
 * Boundary detection is structural and client-agnostic:
 *  1. nested <blockquote> depth (most universal),
 *  2. quoted-message separators / Outlook containers / <hr>,
 *  3. if nothing matches, the whole HTML is returned as a single fragment.
 */
export function splitThreadHtmlMessages(html: string, keepReplies: number): string[] {
  if (!html) return [];
  const k = Math.max(1, Math.floor(keepReplies));

  const byBlockquote = splitByBlockquoteDepth(html, k);
  if (byBlockquote !== null) return byBlockquote;

  const bySeparator = splitAtSeparators(html, k);
  if (bySeparator !== null) return bySeparator;

  return [html];
}

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
  return splitThreadHtmlMessages(html, keepReplies).join('');
}

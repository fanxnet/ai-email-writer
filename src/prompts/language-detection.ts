/**
 * AI Compose — Email Language Detection
 *
 * Lightweight, dependency-free heuristic for detecting the dominant
 * language of an email body/thread so the AI features can match it
 * deterministically (reply "auto", summarization, etc.).
 *
 * Only detects high-confidence cases by script:
 *   - Han → Chinese (Simplified/Traditional are deliberately not
 *     distinguished — the model follows the original's register)
 *   - Kana → Japanese
 *   - Hangul → Korean
 *   - Cyrillic → Russian
 *   - Latin → English when common English function words dominate,
 *     otherwise null (falls back to letting the model decide)
 *
 * © Rizonetech (Pty) Ltd. — https://rizonesoft.com
 */

// ---------------------------------------------------------------------------
// Script matchers
// ---------------------------------------------------------------------------

/** Han (CJK Unified Ideographs) — Chinese. */
const HAN = /[\u3400-\u4DBF\u4E00-\u9FFF]/;
/** Hiragana + Katakana — Japanese. */
const KANA = /[\u3040-\u30FF]/;
/** Hangul syllables — Korean. */
const HANGUL = /[\uAC00-\uD7AF]/;
/** Cyrillic — Russian (also used by Ukrainian/Bulgarian/Slavic). */
const CYRILLIC = /[\u0400-\u04FF]/;
/** Latin letters — typically English or other Latin-script languages. */
const LATIN = /[A-Za-z]/;

/** Zhuyin (Taiwan) and rare CJK extensions also count as Han. */
const HAN_EXTENDED = /[\u31A0-\u31BF]/;

// ---------------------------------------------------------------------------
// English stopword sniffing (Latin script only)
// ---------------------------------------------------------------------------

const ENGLISH_STOPWORDS = new Set([
  'the', 'and', 'to', 'of', 'a', 'in', 'for', 'is', 'on', 'that', 'with',
  'this', 'we', 'you', 'it', 'are', 'as', 'at', 'be', 'your', 'have', 'has',
  'not', 'from', 'or', 'will', 'please', 'thank', 'thanks', 'regards', 'hello',
  'subject', 'sent', 'reply',
]);

const STOPWORD_RE = /[a-zA-Z]+/g;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect the dominant language of an email body/thread.
 *
 * Returns a concrete language name for high-confidence script matches,
 * `'English'` for clearly English Latin text, or `null` when the text
 * is ambiguous/too short — in which case callers should fall back to
 * letting the model infer the language itself.
 *
 * @param text - The raw email/thread text (headers fine to include).
 */
export function detectEmailLanguage(text: string): string | null {
  const shortText = String(text ?? '');

  let han = 0;
  let kana = 0;
  let hangul = 0;
  let cyrillic = 0;
  let latin = 0;

  for (const ch of shortText) {
    if (HAN.test(ch) || HAN_EXTENDED.test(ch)) han += 1;
    else if (KANA.test(ch)) kana += 1;
    else if (HANGUL.test(ch)) hangul += 1;
    else if (CYRILLIC.test(ch)) cyrillic += 1;
    else if (LATIN.test(ch)) latin += 1;
  }

  const total = han + kana + hangul + cyrillic + latin;

  // Too little textual content to judge (empty, attachment-only, URLs…)
  if (total < 20) return null;

  // Non-Latin scripts are unambiguous when they clearly dominate.
  // Kana check runs first: Japanese prose mixes kanji and kana, so Han
  // must not swallow it (Chinese text never uses kana).
  if (kana >= 4) return 'Japanese';
  if (hangul >= 4 && hangul > latin * 0.5) return 'Korean';
  if (cyrillic >= 4 && cyrillic > latin * 0.5) return 'Russian';
  if (han >= 4 && han > latin * 0.5) return 'Chinese';

  // Latin script: English is guessed via common function words.
  if (latin > 0 && latin >= cyrillic) {
    const words = shortText.match(STOPWORD_RE) ?? [];
    let hits = 0;
    let count = 0;
    for (const word of words) {
      const lower = word.toLowerCase();
      if (ENGLISH_STOPWORDS.has(lower)) hits += 1;
      count += 1;
      if (count >= 300) break; // sample the first ~300 words
    }
    if (count > 0 && hits / count >= 0.15) return 'English';
  }

  return null;
}
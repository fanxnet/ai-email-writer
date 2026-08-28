/**
 * AI Compose — Email Cleaner
 *
 * Cleans a flattened conversation-thread email message-by-message so the AI
 * receives only the meaningful content. Non-sender email headers, quoted
 * separators, "Original Message:"-style markers, signatures, confidentiality
 * disclaimers and image/attachment placeholders are removed, while the sender
 * line ("From: ...", "De: ...", "On ..., X wrote:") is kept as each message's
 * attribution.
 *
 * © Rizonetech (Pty) Ltd. — https://rizonesoft.com
 */

// ---------------------------------------------------------------------------
// Header labels (multi-language). A header block = a label line (with or
// without a same-line value) plus the following value lines (which may be a
// multi-line recipient list). Only the FIRST sender block is kept.
// ---------------------------------------------------------------------------

/** Any header label line (sender or other). */
const HEADER_LABEL_RE =
  /^(?:From|发件人|寄件人|Sender|De|Von|Da|Van|Od|От|Sent|发送时间|发送|Envoyé le|Gesendet am|Enviado|Enviado el|Enviada em|Inviato il|Verzonden|Verstuurd|Date|日期|Datum|Fecha|Data|Received|接收时间|Delivered-To|To|收件人|À|An|Aan|Para|Cc|CC|抄送|Copie|Kopie|Bcc|BCC|密送|Cci|CCO|Subject|主题|Objet|Betreff|Asunto|Assunto|Oggetto|Onderwerp|Importance|优先级|Priority|X-Priority|Wichtigkeit|Importancia|Importanza|Importância|Reply-To|回复地址|Message-ID|In-Reply-To|References|MIME-Version|Content-Type|Content-Transfer-Encoding|DKIM-Signature|Authentication-Results|Return-Path|List-Unsubscribe|List-Id)\s*[：:]/i;

/** Sender label (kept as attribution, and the split feature). */
const SENDER_LABEL_RE = /^(?:From|发件人|寄件人|Sender|De|Von|Da|Van|Od|От)\s*[：:]/i;

/** A "From: Name <email>" sender line (used to exclude senders from body/signature). */
const FROM_LINE_RE = /^(?:From|发件人|寄件人|Sender|De|Von|Da|Van|Od|От)\s*[：:]\s*(.*)$/i;

// ---------------------------------------------------------------------------
// Quoted separators / markers / "wrote:" attribution lines
// ---------------------------------------------------------------------------

const SEPARATOR_LINE_RE =
  /^-{3,}\s*(?:Original Message|Message d'origine|Ursprüngliche Nachricht|Mensaje original|Messaggio originale|Mensagem original|原始邮件|转发的消息|Odpowiedź|Odpowiedz|Oorspronkelijk bericht|Alkuperäinen viesti|Ursprungligt meddelande|Meddelande)\s*-{3,}$|^_{3,}\s*(?:Original Message|Message d'origine|Ursprüngliche Nachricht|Mensaje original|Messaggio originale|Mensagem original|原始邮件|转发的消息)\s*_{3,}$|^_{3,}$/i;

/** Standalone "Original Email:" / "Forwarded message:" style markers. */
const MARKER_LINE_RE =
  /^\*{0,2}\s*(?:original\s+(?:email|e-?mail|message)|forwarded\s+(?:message|email)|message\s+d'origine|mensaje\s+original|messaggio\s+originale|mensagem\s+original|ursprüngliche\s+nachricht|转发的?消息|原始邮件)[:：]?\s*\*{0,2}\s*$/i;

const WROTE_LINE_RE =
  /^(?:On|Le|Am|El|Il|Em|在)\s+.+?(?:wrote|a écrit|schrieb|escribió|ha scritto|escreveu|schreef|napisał|napisała|skrev|писала|написала|写道)\s*[：:]?$/i;

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/**
 * Exact sign-off phrases (any case). A line is a sign-off when it starts with
 * one of these phrases, optionally followed by a comma and a name. Body
 * sentences like "Thanks for your patience." do NOT match because the phrase
 * must match exactly.
 */
const SIGN_OFF_PHRASES = new Set([
  'regards', 'angelina liu', 'best regards', 'kind regards', 'warm regards', 'warmest regards',
  'kindest regards', 'many regards', 'sincerely', 'sincerely yours',
  'yours sincerely', 'yours faithfully', 'yours truly', 'respectfully yours',
  'truly', 'thanks', 'thanks a lot', 'many thanks', 'thank you', 'cheers',
  'respectfully', 'best', 'appreciated', 'take care', 'all the best', 'all best',
  'wishes', 'best wishes', 'with regards', 'with kind regards', 'gratefully',
  'yours', 'thanks again',
  '此致敬礼', '此致', '敬礼', '祝好', '祝一切顺利', '顺颂商祺', '商祺', '谢谢',
  '感谢', '谨上', '敬上', '敬启', '顺颂时祺', '此致，敬礼',
  'cordialement', 'bien à vous', 'bien a vous', 'salutations', 'meilleures salutations',
  'bien cordialement', 'merci', 'merci beaucoup', 'amitiés', 'bonne journée',
  'mit freundlichen grüßen', 'mit freundlichem gruß', 'mit besten grüßen',
  'viele grüße', 'freundliche grüße', 'beste grüße', 'liebe grüße',
  'schöne grüße', 'grüße', 'grüsse', 'hochachtungsvoll', 'danke', 'danke schön',
  'saludos', 'un saludo', 'un cordial saludo', 'atentamente', 'cordialmente',
  'muchas gracias', 'gracias', 'reciba un cordial saludo', 'saludos cordiales',
  'un abrazo', 'sin otro particular', 'un afectuoso saludo',
  'cordiali saluti', 'distinti saluti', 'un caro saluto', 'un cordiale saluto',
  'saluti', 'grazie',
  'atenciosamente', 'cordialmente', 'obrigado', 'obrigada', 'cumprimentos',
  'obrigado pela atenção', 'com os melhores cumprimentos',
  'met vriendelijke groet', 'met vriendelijke groeten', 'groeten',
  'hartelijke groet', 'bedankt', 'dank je', 'groetjes',
  'z poważaniem', 'z wyrazami szacunku', 'pozdrawiam',
  'с уважением', 'с наилучшими пожеланиями', 'всего доброго',
  's pozdravem', 's pozdravom',
  '敬具', 'よろしくお願いします', 'お願いします',
  '감사합니다', '고맙습니다',
]);

/** Lowercased copy so any phrase (or user-added name) matches regardless of case. */
const SIGN_OFF_PHRASES_LOWER = new Set(
  [...SIGN_OFF_PHRASES].map((p) => p.toLowerCase()),
);

/** A name word: capitalized Latin, or a short CJK run. */
const NAME_WORD_RE = /^(?:[A-ZÀ-ÖØ-öø-ÿ][\w'.-]*|[\u4e00-\u9fff]{1,6})$/;

/** Strip decorative leading chars and a trailing <email> / [bracket] tail. */
function normalizeLine(line: string): string {
  let s = line.trim().replace(/^[\s\-—–~·•*]+/, '');
  s = s.replace(/\s*<[^>]*>\s*$/, '');
  s = s.replace(/\s*\[[^\]]*\]\s*$/, '');
  s = s.replace(/\s*mailto:.*$/i, '');
  return s.trim();
}

function isSignOffLine(line: string): boolean {
  const s = normalizeLine(line);
  if (!s) return false;

  const commaIndex = s.search(/[,，]/);
  const phraseRaw = commaIndex < 0 ? s : s.slice(0, commaIndex);
  const tail = commaIndex < 0 ? '' : s.slice(commaIndex + 1);

  const phrase = phraseRaw.replace(/[.!。！]+$/, '').toLowerCase();
  if (!SIGN_OFF_PHRASES_LOWER.has(phrase)) return false;

  if (!tail) return true;
  const words = tail.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 3) return false;
  return words.every((w) => NAME_WORD_RE.test(w));
}

const GREETING_RE = /^(?:dear|hi|hello|hey|hola|bonjour|hallo|ciao|ol[aá]|hej|hei|moi|greetings|sir|madam|你好|您好|안녕하세요|こんにちは)\b/i;

const ADDRESS_RE =
  /\b(?:road|street|avenue|ave\.?|blvd|boulevard|lane|drive|plaza|square|bldg|building|room|suite|floor|fl\.?|block|district|province|county|邮编|路|街|大道|大厦|楼|号|区|广场|新村|社区|市|街道|국가)\b/i;

const SIGNATURE_LABEL_RE =
  /^(?:add(?:ress)?:|tel(?:ephone)?:|fax:|mobile:|mob:|phone:|email:|e-?mail:|website:|web:|group:|nvocc:|office:|whatsapp:|wechat:|skype:|qq:|reg(?:istered)?:|co:|c\/o|vat:|registered:|www\.|p\.?\s*o\.?\s*box|postal|电话|手机|邮箱|网址|地址|传真|tél|teléfono|telefone|telefon|endereço|enderezo)/i;

const ABBREV_END_RE = /(?:ltd\.|inc\.|co\.|corp\.|s\.l\.|s\.a\.|llc|sas|sarl|pty|b\.v\.|n\.v\.|lda\.|gmbh|ag)$/i;

/** A line that unambiguously belongs to a signature (label / contact / abbrev). */
function isStrongSignatureLine(line: string): boolean {
  const s = line.trim();
  if (!s) return false;
  if (SIGNATURE_LABEL_RE.test(s)) return true;
  if (/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(s)) return true;
  if (/www\.|https?:\/\//i.test(s)) return true;
  if (/\+?\d[\d\s().\-]{7,}/.test(s)) return true;
  if (s.length <= 40 && ABBREV_END_RE.test(s)) return true;
  return false;
}

/** A line that looks like signature content (strong, address, or a short non-sentence line). */
function isSignatureLike(line: string): boolean {
  const s = line.trim();
  if (!s) return false;
  if (FROM_LINE_RE.test(s)) return false;
  if (WROTE_LINE_RE.test(s)) return false;
  if (SEPARATOR_LINE_RE.test(s)) return false;
  if (MARKER_LINE_RE.test(s)) return false;
  if (GREETING_RE.test(s)) return false;
  if (isStrongSignatureLine(s)) return true;
  if (/@/.test(s)) return true;
  if (/\d/.test(s) && ADDRESS_RE.test(s) && !/[.!?。！？]$/.test(s)) return true;
  if (s.length <= 40 && !/[.!?。！？]$/.test(s)) return true;
  return false;
}

function isNameLine(line: string): boolean {
  const s = normalizeLine(line);
  if (!s || s.length > 40) return false;
  if (/[.!?。！？]/.test(s)) return false;
  const words = s.split(/\s+/);
  return words.length >= 1 && words.length <= 4 && words.every((w) => NAME_WORD_RE.test(w));
}

/** True when the immediate next non-empty line is signature-like. */
function hasSignatureLikeAhead(lines: string[], index: number): boolean {
  for (let k = index + 1; k < lines.length; k++) {
    const l = lines[k].trim();
    if (!l) continue;
    return isSignatureLike(l);
  }
  return false;
}

/** A line with an unambiguous signature label / bare email / website. */
function isLabeledSignatureLine(line: string): boolean {
  const s = line.trim();
  return (
    SIGNATURE_LABEL_RE.test(s) ||
    /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(s) ||
    /^www\./i.test(s)
  );
}

/**
 * True when a run of at least 2 signature-like lines starts at `index`,
 * contains a labeled line, and ends at the segment end or right before a
 * message-start marker / greeting. Used to recognise signatures that begin
 * directly with an address or contact line (no name / sign-off line).
 */
function startsLabeledSignatureRun(lines: string[], index: number): boolean {
  let count = 0;
  let hasLabel = false;
  let j = index;
  while (j < lines.length) {
    const l = lines[j].trim();
    if (!l) {
      j++;
      continue;
    }
    if (isSignatureLike(l)) {
      count++;
      if (isLabeledSignatureLine(l)) hasLabel = true;
      j++;
      continue;
    }
    break;
  }
  if (count < 2 || !hasLabel) return false;

  let k = j;
  while (k < lines.length && lines[k].trim() === '') k++;
  if (k >= lines.length) return true;
  const next = lines[k].trim();
  return (
    FROM_LINE_RE.test(next) ||
    WROTE_LINE_RE.test(next) ||
    SEPARATOR_LINE_RE.test(next) ||
    GREETING_RE.test(next)
  );
}

/**
 * Index of the first signature feature line in a message segment, or -1.
 * A feature line is a sign-off phrase (including user-added feature words), a
 * name line followed by signature content, or the start of a labeled
 * signature run.
 */
function findSignatureStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    if (isSignOffLine(l)) return i;
    if (isNameLine(l) && hasSignatureLikeAhead(lines, i)) return i;
    if (startsLabeledSignatureRun(lines, i)) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Confidentiality disclaimers / placeholders
// ---------------------------------------------------------------------------

const DISCLAIMER_LINE_RE =
  /^(?:this\s+e?-?mail|this\s+message|this\s+communication|the\s+information\s+contained|confidentiality\s+notice|please\s+consider\s+the\s+environment|avis\s+important|ce\s+message|este\s+correo|diese\s+e?-?mail|本邮件|本郵件|此邮件|此郵件|保密声明|保密通知|含保密信息|该邮件|该郵件)/i;

const PLACEHOLDER_RE = /\[(?:image|cid|attachment|图片|附件)[^\]]*\]/gi;
const ATTACHMENT_LINE_RE = /^(?:Attachment|Attachments|附件|附件文件)\s*[:：].*$/i;

// ---------------------------------------------------------------------------
// Message splitting
// ---------------------------------------------------------------------------

/**
 * Split flattened thread text into individual messages. A new message starts at
 * a quoted separator line, an "On ... wrote:" line, or a multilingual sender
 * label ("From:"/"发件人:"/"De:"/"Von:"/"Da:"/"Van:"/...) that begins a message.
 *
 * Sender labels that merely open a header block (e.g. a "De:" recipient list
 * following the "From:" of the same message) do NOT start a new message: a
 * sender label is a message start only when the previous meaningful line was
 * body content (or nothing), not another header block.
 * Returns the messages in the same order as the text (newest first).
 */
function splitMessages(text: string): string[] {
  const lines = text.split('\n');
  const starts: number[] = [];
  let lastWasHeader = false; // the previous meaningful (non-blank) line was header content

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue; // blank lines keep the header state

    if (SEPARATOR_LINE_RE.test(trimmed) || WROTE_LINE_RE.test(trimmed)) {
      starts.push(i);
      lastWasHeader = true; // a quoted header block follows a separator
      continue;
    }

    if (SENDER_LABEL_RE.test(trimmed)) {
      if (!lastWasHeader) starts.push(i);
      lastWasHeader = true;
      continue;
    }

    if (HEADER_LABEL_RE.test(trimmed)) {
      lastWasHeader = true;
      continue;
    }

    // A plain line: header value if still in a header block, body otherwise.
    lastWasHeader = isBodyLikeLine(trimmed) ? false : lastWasHeader;
  }

  if (starts.length === 0) return [text];

  const bounds = [0, ...starts, lines.length];
  const messages: string[] = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    messages.push(lines.slice(bounds[k], bounds[k + 1]).join('\n'));
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Per-message cleaning
// ---------------------------------------------------------------------------

/** Index of the last disclaimer-start line within the final 6 lines, or -1. */
function lastDisclaimerLine(lines: string[]): number {
  const nonEmpty = lines.map((l, i) => ({ line: l.trim(), index: i })).filter((x) => x.line.length > 0);
  let last = -1;
  for (let j = 0; j < nonEmpty.length; j++) {
    if (DISCLAIMER_LINE_RE.test(nonEmpty[j].line) && j >= nonEmpty.length - 6) {
      last = nonEmpty[j].index;
    }
  }
  return last;
}

function removeTailFromIndex(lines: string[], index: number): string[] {
  if (index < 0) return lines;
  return lines.slice(0, index);
}

/** True when a line reads as body content (greeting, sentence, or long text). */
function isBodyLikeLine(line: string): boolean {
  const s = line.trim();
  if (!s) return false;
  if (GREETING_RE.test(s)) return true;
  if (/[.!?。！？]$/.test(s)) return true;
  return s.length > 60;
}

/**
 * Collect a header block starting at `start` (a header-label line). The block
 * spans the label plus the following value lines (which may be a multi-line
 * recipient list). Stops at a blank line, the next header label, or body-like
 * content so it never swallows the message body. Returns the block merged into
 * one line and the index just past the block.
 */
function collectHeaderBlock(lines: string[], start: number): { merged: string; next: number } {
  const valueLines: string[] = [];
  let i = start + 1;
  while (i < lines.length) {
    const l = lines[i].trim();
    if (!l) break;
    if (HEADER_LABEL_RE.test(l)) break;
    if (isBodyLikeLine(l)) break;
    valueLines.push(l);
    i++;
  }
  const labelLine = lines[start].trim();
  const merged = valueLines.length ? `${labelLine} ${valueLines.join(' ')}` : labelLine;
  return { merged, next: i };
}

/** Clean a single message: headers, separators, markers, signature, disclaimer, placeholders. */
export function cleanEmailMessage(message: string): string {
  const lines = message.split('\n');

  const kept: string[] = [];
  let i = 0;
  let sawSender = false;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) {
      kept.push('');
      i++;
      continue;
    }
    if (SEPARATOR_LINE_RE.test(line)) {
      i++;
      continue;
    }
    if (MARKER_LINE_RE.test(line)) {
      i++;
      continue;
    }
    if (ATTACHMENT_LINE_RE.test(line)) {
      i++;
      continue;
    }
    // Header block (label may sit alone on the line, value(s) follow).
    if (HEADER_LABEL_RE.test(line)) {
      const { merged, next } = collectHeaderBlock(lines, i);
      // Keep only the FIRST sender block; strip everything else (incl. the
      // multi-line recipient lists of other header blocks).
      if (SENDER_LABEL_RE.test(line) && !sawSender) {
        kept.push(merged.replace(PLACEHOLDER_RE, '').trim());
        sawSender = true;
      }
      i = next;
      continue;
    }
    // Body content.
    kept.push(line.replace(PLACEHOLDER_RE, '').trim());
    i++;
  }

  // Cut from the first signature feature line to the end of the message segment.
  const sigStart = findSignatureStart(kept);
  let body = sigStart >= 0 ? kept.slice(0, sigStart) : kept;
  // Disclaimers that reach the very end are dropped.
  body = removeTailFromIndex(body, lastDisclaimerLine(body));

  return body.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Clean a flattened conversation-thread email message-by-message.
 *
 * - `keepReplies` (optional): keep only the newest `keepReplies` messages
 *   (the current email plus the newest N-1 replies). Omit to clean all.
 * - Non-sender headers (Cc/抄送, Sent/发送时间/Enviado, Subject, To, Date, ...),
 *   quoted separators and markers, signatures, confidentiality disclaimers and
 *   image/attachment placeholders are removed from every message.
 * - The sender line ("From: ...", "De: ...", "On ..., X wrote:") is kept.
 */
export function cleanThreadEmails(text: string, keepReplies?: number): string {
  if (!text) return text;

  const messages = splitMessages(text);
  const capped = keepReplies !== undefined ? messages.slice(0, Math.max(1, keepReplies)) : messages;

  const cleaned = capped.map(cleanEmailMessage).filter((m) => m.length > 0);
  return cleaned.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

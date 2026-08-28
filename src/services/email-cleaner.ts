/**
 * AI Compose — Email Cleaner
 *
 * Cleans a flattened conversation-thread email message-by-message so the AI
 * receives only the meaningful content. Email headers, quoted separators,
 * "wrote:" attribution lines, signatures, confidentiality disclaimers and
 * image/attachment placeholders are removed, while a compact
 * "Reply from X:" attribution keeps who-said-what visible for the model.
 *
 * © Rizonetech (Pty) Ltd. — https://rizonesoft.com
 */

// ---------------------------------------------------------------------------
// Header label lines (multi-language)
// ---------------------------------------------------------------------------

const HEADER_LINE_RE =
  /^(?:From|发件人|De|Von|Da|Sender|寄件人|Sent|发送时间|发送|Envoyé le|Gesendet am|Enviado el|Inviato il|Enviada em|Verzonden|Date|日期|Datum|Fecha|Data|Received|接收时间|Delivered-To|To|收件人|À|An|Para|Cc|CC|抄送|Copie|Bcc|BCC|密送|Cci|CCO|Subject|主题|Objet|Betreff|Asunto|Oggetto|Assunto|Onderwerp|Importance|优先级|Priority|X-Priority|Wichtigkeit|Importancia|Importanza|Importância|Reply-To|回复地址|Message-ID|In-Reply-To|References|MIME-Version|Content-Type|Content-Transfer-Encoding|DKIM-Signature|Authentication-Results|Return-Path|List-Unsubscribe|List-Id)\s*[：:]/i;

// ---------------------------------------------------------------------------
// Quoted separators / "wrote:" attribution lines
// ---------------------------------------------------------------------------

const SEPARATOR_LINE_RE =
  /^-{3,}\s*(?:Original Message|Message d'origine|Ursprüngliche Nachricht|Mensaje original|Messaggio originale|Mensagem original|原始邮件|转发的消息|Odpowiedź|Odpowiedz|Oorspronkelijk bericht|Alkuperäinen viesti|Ursprungligt meddelande|Meddelande)\s*-{3,}$|^_{3,}\s*(?:Original Message|Message d'origine|Ursprüngliche Nachricht|Mensaje original|Messaggio originale|Mensagem original|原始邮件|转发的消息)\s*_{3,}$|^_{3,}$/i;

const WROTE_LINE_RE =
  /^(?:On|Le|Am|El|Il|Em|在)\s+.+?(?:wrote|a écrit|schrieb|escribió|ha scritto|escreveu|写道)\s*[：:]?$/i;

/** Captures the sender from a "On ..., X wrote:" line. */
const WROTE_NAME_RE =
  /,\s*([^,]+?)\s+(?:wrote|a écrit|schrieb|escribió|ha scritto|escreveu|写道)\s*[：:]?$/i;

/** A "From: Name <email>" sender line. */
const FROM_LINE_RE = /^(?:From|发件人|De|Von|Da|Sender|寄件人)\s*[：:]\s*(.*)$/i;

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/**
 * Exact sign-off phrases (lowercased). A line is a sign-off when it starts
 * with one of these phrases, optionally followed by a comma and a name.
 * Body sentences like "Thanks for your patience." do NOT match because the
 * phrase must match exactly.
 */
const SIGN_OFF_PHRASES = new Set([
  'Angelina Liu', 'regards', 'best regards', 'kind regards', 'warm regards', 'many regards',
  'sincerely', 'sincerely yours', 'yours sincerely', 'yours faithfully', 'yours truly',
  'truly', 'thanks', 'thank you', 'cheers', 'respectfully', 'best', 'appreciated',
  'take care', 'all the best', 'wishes', 'best wishes', 'with regards',
  'with kind regards', 'many thanks',
  '此致敬礼', '此致', '敬礼', '祝好', '祝一切顺利', '顺颂商祺', '商祺', '谢谢', '感谢',
  '谨上', '敬上', '敬启',
  'cordialement', 'bien à vous', 'bien a vous', 'salutations', 'meilleures salutations',
  'bien cordialement', 'merci', 'amitiés',
  'mit freundlichen grüßen', 'mit freundlichem gruß', 'viele grüße',
  'freundliche grüße', 'beste grüße', 'grüße', 'grüsse', 'hochachtungsvoll', 'danke',
  'saludos', 'un saludo', 'atentamente', 'cordialmente', 'muchas gracias', 'gracias',
  'reciba un cordial saludo',
  'cordiali saluti', 'saluti', 'distinti saluti', 'un caro saluto', 'grazie',
  'atenciosamente', 'cordialmente', 'obrigado', 'obrigada', 'cumprimentos',
  'com os melhores cumprimentos',
  'met vriendelijke groet', 'met vriendelijke groeten', 'groeten', 'hartelijke groet',
  'bedankt', 'dank je',
]);

/** A name word: capitalized Latin, or a short CJK run. */
const NAME_WORD_RE = /^(?:[A-ZÀ-ÖØ-öø-ÿ][\w'.-]*|[\u4e00-\u9fff]{1,6})$/;

function isSignOffLine(line: string): boolean {
  const s = line.trim();
  if (!s) return false;

  const commaIndex = s.search(/[,，]/);
  const phraseRaw = commaIndex < 0 ? s : s.slice(0, commaIndex);
  const tail = commaIndex < 0 ? '' : s.slice(commaIndex + 1);

  const phrase = phraseRaw.replace(/[.!。！]+$/, '').toLowerCase();
  if (!SIGN_OFF_PHRASES.has(phrase)) return false;

  if (!tail) return true;
  const words = tail.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 3) return false;
  return words.every((w) => NAME_WORD_RE.test(w));
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
 * Split flattened thread text into individual messages. A new message starts
 * at a quoted separator line, an "On ... wrote:" line, or a "From:" sender
 * line that is not part of the header block right after a separator.
 * Returns the messages in the same order as the text (newest first).
 */
function splitMessages(text: string): string[] {
  const lines = text.split('\n');
  const starts: number[] = [];
  let lastStart = -10;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (SEPARATOR_LINE_RE.test(line) || WROTE_LINE_RE.test(line)) {
      starts.push(i);
      lastStart = i;
    } else if (FROM_LINE_RE.test(line) && i - lastStart > 2) {
      starts.push(i);
      lastStart = i;
    }
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

function cleanSenderName(raw: string): string {
  let s = raw.trim();
  const lt = s.indexOf('<');
  if (lt > 0) {
    const name = s.slice(0, lt).replace(/^mailto:/i, '').trim();
    if (name) return name;
  }
  const email = s.match(/[\w.+-]+@[\w.-]+/);
  if (email) return email[0];
  return s.replace(/^mailto:/i, '').trim();
}

function extractSenderName(lines: string[]): string | null {
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const line = lines[i];
    const from = line.match(FROM_LINE_RE);
    if (from) return cleanSenderName(from[1]);
    const wrote = line.match(WROTE_NAME_RE);
    if (wrote && wrote[1].trim()) return wrote[1].trim();
  }
  return null;
}

/** Index of the last sign-off line, or -1. */
function lastSignOffLine(lines: string[]): number {
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isSignOffLine(lines[i].trim())) last = i;
  }
  return last;
}

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

/** Clean a single message: headers, separators, signature, disclaimer, placeholders. */
function cleanMessage(message: string): string {
  const lines = message.split('\n');
  const sender = extractSenderName(lines);

  const kept: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      kept.push('');
      continue;
    }
    if (HEADER_LINE_RE.test(line)) continue;
    if (SEPARATOR_LINE_RE.test(line)) continue;
    if (WROTE_LINE_RE.test(line)) continue;
    if (ATTACHMENT_LINE_RE.test(line)) continue;
    kept.push(line.replace(PLACEHOLDER_RE, '').trim());
  }

  // Signatures and disclaimers both run to the end of the message.
  let body = removeTailFromIndex(kept, lastSignOffLine(kept));
  body = removeTailFromIndex(body, lastDisclaimerLine(body));

  const text = body.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return '';

  return sender ? `Reply from ${sender}:\n${text}` : text;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Clean a flattened conversation-thread email message-by-message.
 *
 * - `keepReplies` (optional): keep only the newest `keepReplies` messages
 *   (the current email plus the newest N-1 replies). Omit to clean all.
 * - Headers (Cc/抄送, Sent/发送时间, From/To/Subject/Date, ...), quoted
 *   separators, "wrote:" lines, signatures, confidentiality disclaimers and
 *   image/attachment placeholders are removed from every message.
 * - Each message with a known sender is prefixed with "Reply from X:".
 */
export function cleanThreadEmails(text: string, keepReplies?: number): string {
  if (!text) return text;

  const messages = splitMessages(text);
  const capped = keepReplies !== undefined ? messages.slice(0, Math.max(1, keepReplies)) : messages;

  const cleaned = capped.map(cleanMessage).filter((m) => m.length > 0);
  return cleaned.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

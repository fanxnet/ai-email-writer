const THREAD_BLOCK_STARTERS = [
    // English
    'From', 'Sender',
    // German
    'Von',
    // Spanish
    'De', 'Remitente',
    // French
    'Expéditeur',
    // Portuguese
    'Remetente',
    // Italian
    'Mittente', 'Da',
    // Korean
    '보낸 사람', '보낸사람',
    // Japanese
    '差出人', '送信者',
    // Chinese
    '发件人', '来自', '寄件人', '寄件者',
    // Russian
    'От', 'От кого',
];

// Header keyword names only. Do not add ':' or '：' here.
// The matcher accepts both ASCII ':' and full-width '：', with optional spaces.
const HEADER_REMOVE_LIST = [
    // English
    'Subject', 'To', 'Cc', 'Bcc', 'Sent', 'Date',
    'Reply-To', 'Message-ID', 'MIME-Version', 'Content-Type',
    'Content-Transfer-Encoding', 'References', 'In-Reply-To',
    // German
    'Betreff', 'An', 'Kopie', 'Cc', 'Bcc', 'Gesendet', 'Gesendet am', 'Datum',
    // French
    'Objet', 'À', 'Cc', 'Cci', 'Envoyé', 'Envoyé le', 'Date',
    // Spanish
    'Asunto', 'Para', 'Copia', 'CC', 'CCO', 'Enviado', 'Enviado el', 'Enviada el',
    'Fecha', 'Fecha de envío', 'Fecha de enviado',
    // Portuguese
    'Assunto', 'Para', 'Cc', 'Cópia', 'CC', 'CCO', 'Enviado', 'Enviado em',
    'Enviada em', 'Data', 'Data de envio',
    // Italian
    'Oggetto', 'A', 'Cc', 'Ccn', 'Inviato', 'Inviato il', 'Data',
    // Dutch
    'Onderwerp', 'Aan', 'Kopie', 'Cc', 'Bcc', 'Verzonden', 'Verzonden op', 'Datum',
    // Polish
    'Temat', 'Do', 'DW', 'UDW', 'Wysłano', 'Wysłano dnia', 'Data',
    // Turkish
    'Konu', 'Alıcı', 'Bilgi', 'Gizli', 'Gönderildi', 'Gönderilme tarihi', 'Tarih',
    // Russian
    'Тема', 'Кому', 'Копия', 'Скрытая копия', 'Отправлено', 'Отправлено в', 'Дата',
    // Japanese
    '件名', '宛先', '送信先', 'Cc', 'Bcc', '送信日時', '送信日', '日付',
    // Korean
    '제목', '받는 사람', '참조', '숨은참조', '보낸 시간', '보낸 날짜', '날짜',
    // Chinese
    '主题', '收件人', '抄送', '密送', '发送时间', '发送日期', '日期',
];

const TECHNICAL_HEADER_NAMES = [
    'Reply-To', 'Bcc', 'Message-ID', 'MIME-Version', 'Content-Type',
    'Content-Transfer-Encoding', 'References', 'In-Reply-To', 'Return-Path',
    'Delivered-To', 'Auto-Submitted', 'Disposition-Notification-To',
    'List-Unsubscribe',
];

const SIGNATURE_TRIGGERS = [
    // English
    'Best regards', 'Kind regards', 'Regards', 'Best wishes', 'Warm regards',
    'Sincerely', 'Respectfully', 'Thanks', 'Thank you',
    // Portuguese
    'Atenciosamente', 'Atencionalmente', 'Saudações', 'Obrigado', 'Cordialmente', 'Grato', 'Grata',
    // Spanish
    'Saludos', 'Saludos cordiales', 'Un cordial saludo', 'Atentamente', 'Saludos atentos', 'Muchas gracias', 'Quedo atento', 
    // French
    'Cordialement', 'Bien cordialement', 'Bien à vous', 'Respectueusement', 'Avec mes salutations distinguées', 'Merci',
    // German
    'Mit freundlichen Grüßen', 'Viele Grüße', 'Liebe Grüße', 'Beste Grüße', 'Hochachtungsvoll',
    // Italian
    'Cordiali saluti', 'Grazie',
    // Korean
    '감사합니다.', '감사드립니다', '고맙습니다',
    // Japanese
    'よろしくお願いいたします', '宜しくお願い致します', '何卒よろしくお願い申し上げます',
    // Russian
    'С уважением', 'Спасибо',
    // Common shorthand
    'Tks', 'Thks', 'B. Rgds', 'B.Rgds', 'B rgds', 'BRgds', 'Tks n rgds',
    'Yours sincerely', 'Yours truly', 'Yours respectfully', 'Yours kindly', 'Yours faithfully', 'All the best',
    // Chinese
    '顺颂商祺', '祝好', '此致', '敬礼',
];

const SIGNATURE_NAMES = [
    'Thank you so much',
    'Thank you very much',
    'Thank you in advance',
    'Excited to work on this',
    'Angelina Liu',
    'Parisi Grand Smooth Logistics Ltd.',
    'With appreciation','Cordial Saludo','Best regard',
];

type MailBlock = {
    type: 'mail';
    text: string;
};

type RawLine = {
    line: string;
    raw: string;
};

function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const starterKeywords = THREAD_BLOCK_STARTERS
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(s => escapeRegExp(s))
    .join('|');

// Sender headers accept optional whitespace before ':' and both ':' / '：'.
const mailStartRx = new RegExp(
    `^[\\s\\u00A0]*(?:${starterKeywords})[\\s\\u00A0]*[:：]`,
    'i'
);

const emailRx = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

const salutePattern = SIGNATURE_TRIGGERS
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');

const multiSaluteRx = new RegExp(
    `(${salutePattern})\\s*(?:\\/|&|,|and|\\|)\\s*(${salutePattern})\\s*[,.!~;]*`,
    'i'
);

function normalizeHeaderName(name: string): string {
    return name
        .replace(/\u00A0/g, ' ')
        .replace(/[ \t]+/g, '')
        .toLowerCase();
}

function normalizeHeaderProbe(line: string): string {
    return line
        .replace(/\u00A0/g, ' ')
        .replace(/[：]/g, ':')
        .replace(/[ \t]+/g, '')
        .toLowerCase();
}

function headerNameOf(text: string): string | null {
    const colonMatch = /[:：]/.exec(text);
    if (!colonMatch || colonMatch.index === undefined) return null;
    return normalizeHeaderName(text.slice(0, colonMatch.index));
}

const removableHeaderNames = new Set(
    HEADER_REMOVE_LIST.map(normalizeHeaderName)
);

const technicalHeaderNames = new Set(
    TECHNICAL_HEADER_NAMES.map(normalizeHeaderName)
);

function isMailStartLine(line: string): boolean {
    return mailStartRx.test(line);
}

function isExtraHeaderLine(line: string): boolean {
    const name = headerNameOf(line);
    return name !== null && removableHeaderNames.has(name);
}

function isTechnicalHeaderLine(line: string): boolean {
    const name = headerNameOf(line.trim());
    if (name !== null && technicalHeaderNames.has(name)) return true;

    const normalized = normalizeHeaderProbe(line.trim());
    return /^x-[a-z0-9-]+:/.test(normalized);
}

function isKnownHeaderLine(line: string): boolean {
    return isExtraHeaderLine(line) || isTechnicalHeaderLine(line);
}

function isHorizontalRuleLine(line: string): boolean {
    const trimmed = line.trim();
    if (trimmed.length < 5) return false;

    const firstChar = trimmed[0];
    if (!['-', '=', '_', '—', '―', '~'].includes(firstChar)) return false;

    let sameCount = 0;
    for (const ch of trimmed) {
        if (ch === firstChar) sameCount++;
    }
    return sameCount / trimmed.length >= 0.9;
}

function splitPreserveNewline(text: string): RawLine[] {
    const result: RawLine[] = [];
    if (text.length === 0) return result;

    text = text.replace(/\u00A0/g, ' ');

    let pos = 0;
    while (pos < text.length) {
        const nlIndex = text.indexOf('\n', pos);

        if (nlIndex === -1) {
            const lineContent = text.slice(pos);
            result.push({ line: lineContent, raw: lineContent });
            break;
        }

        const isCrLf = nlIndex > 0 && text[nlIndex - 1] === '\r';
        const lineEnd = isCrLf ? nlIndex - 1 : nlIndex;
        const lineContent = text.slice(pos, lineEnd);
        const newlineStr = isCrLf ? '\r\n' : '\n';

        result.push({
            line: lineContent,
            raw: lineContent + newlineStr,
        });

        pos = nlIndex + 1;
    }

    return result;
}

function looksLikeRealMailStart(
    lines: RawLine[],
    index: number,
    lookAheadMax = 5
): boolean {
    const line = lines[index]?.line ?? '';
    if (!isMailStartLine(line)) return false;

    // Best case: sender line itself contains an email address.
    if (emailRx.test(line)) return true;

    // Some mail clients split the email onto the next line.
    for (let offset = 1; offset <= lookAheadMax; offset++) {
        const idx = index + offset;
        if (idx >= lines.length) break;

        const candidate = lines[idx].line;

        if (emailRx.test(candidate)) return true;
        if (isKnownHeaderLine(candidate)) return true;
        if (isMailStartLine(candidate)) break;
    }

    return false;
}

function lineTriggerSignature(line: string): boolean {
    if (!line) return false;

    const trimmed = line.trim();
    if (trimmed.length === 0) return false;
    if (trimmed.length > 80) return false;
    if (trimmed.includes('?')) return false;

    const lowerLine = trimmed.toLowerCase();
    if (lowerLine.startsWith('dear ')) return false;

    const MAX_PREFIX = 2;
    const MAX_TAIL_CHARS = 5;

    for (const keyword of SIGNATURE_TRIGGERS) {
        const kw = keyword.toLowerCase();
        const pos = lowerLine.indexOf(kw);
        if (pos === -1 || pos > MAX_PREFIX) continue;

        const tailLength = trimmed.length - (pos + kw.length);
        if (tailLength <= MAX_TAIL_CHARS) return true;
    }

    if (multiSaluteRx.test(lowerLine)) return true;

    for (const name of SIGNATURE_NAMES) {
        const nameLower = name.toLowerCase();
        if (!lowerLine.startsWith(nameLower)) continue;

        const tailLength = trimmed.length - nameLower.length;
        if (tailLength <= MAX_TAIL_CHARS) return true;
    }

    return false;
}

/**
 * Detect a header split across two physical lines, e.g.
 *
 *   Assun
 *   to: RE: Quote
 *
 * The returned index count tells the caller how many raw lines belong to the
 * header so the following line is not accidentally treated as body text.
 */
function getHeaderSpan(
    lines: RawLine[],
    index: number
): number {
    if (index < 0 || index >= lines.length) return 0;

    const current = lines[index].line;
    if (isKnownHeaderLine(current)) return 1;

    if (index + 1 < lines.length) {
        const next = lines[index + 1].line;
        const joined = current.trimEnd() + next.trimStart();

        // Examples:
        //   Assun + to: RE: Quote  -> Assunto:
        //   Subject + : RE: Quote  -> Subject:
        if (isKnownHeaderLine(joined)) return 2;

        const joinedProbe = normalizeHeaderProbe(joined);
        const colon = joinedProbe.indexOf(':');
        if (colon >= 0) {
            const name = joinedProbe.slice(0, colon);
            if (removableHeaderNames.has(name)) return 2;
        }
    }

    return 0;
}


function splitMailBlocks(threadText: string): MailBlock[] {
    const rawLines = splitPreserveNewline(threadText);
    const blocks: string[][] = [];
    let currentBlock: string[] | null = null;
    const MAX_LOOK_AHEAD = 5;

    for (let i = 0; i < rawLines.length; i++) {
        const item = rawLines[i];
        const textLine = item.line;

        if (isHorizontalRuleLine(textLine)) {
            if (currentBlock === null) currentBlock = [];
            currentBlock.push(item.raw);
            continue;
        }

        if (isMailStartLine(textLine)) {
            const isValidMailHeader = looksLikeRealMailStart(
                rawLines,
                i,
                MAX_LOOK_AHEAD
            );

            if (isValidMailHeader) {
                if (currentBlock !== null && currentBlock.length > 0) {
                    blocks.push(currentBlock);
                }

                currentBlock = [item.raw];
                continue;
            }
        }

        if (currentBlock === null) {
            currentBlock = [item.raw];
        } else {
            currentBlock.push(item.raw);
        }
    }

    if (currentBlock !== null && currentBlock.length > 0) {
        blocks.push(currentBlock);
    }

    const result: MailBlock[] = blocks
        .map(b => b.join(''))
        .filter(mailText => mailText.trim().length > 0)
        .map(text => ({ type: 'mail', text }));

    if (result.length === 0 && threadText.trim().length > 0) {
        result.push({ type: 'mail', text: threadText });
    }

    return result;
}

export function buildThreadBodyText(
    bodytext: string,
    keepReplies: number
): string {
    const blocks = splitMailBlocks(bodytext);
    if (blocks.length === 0) return bodytext;

    const safeKeep = Math.max(0, keepReplies);
    const takeCount = 1 + safeKeep;
    const selectedMails = blocks.slice(0, takeCount);

    return selectedMails.map(b => b.text).join('');
}

function cleanOneMailBlock(
    blockText: string,
    removeSignature: boolean
): string {
    const rawLines = splitPreserveNewline(blockText);
    const outLines: string[] = [];

    let fromFound = false;
    let inHeader = false;
    let afterRemovableHeader = false;
    let pendingWrappedHeader = false;
    let headerLineCount = 0;

    const MAX_HEADER_LINES = 20;

    for (let i = 0; i < rawLines.length; i++) {
        if (!fromFound && isMailStartLine(rawLines[i].line)) {
            if (looksLikeRealMailStart(rawLines, i, 5)) {
                fromFound = true;
                inHeader = true;
                afterRemovableHeader = false;
                pendingWrappedHeader = false;
                headerLineCount = 0;

                outLines.push(rawLines[i].raw);
                continue;
            }
        }

        if (fromFound && inHeader) {
            const line = rawLines[i].line;
            const trimmed = line.trim();

            // Important: your real mail data has blank lines between header
            // fields. Do NOT use the first blank line as the end of headers.
            // We simply skip blank separators while header mode is active.
            if (trimmed === '') {
                continue;
            }

            const headerSpan = getHeaderSpan(rawLines, i);

            if (headerSpan > 0) {
                // Remove To / Cc / Sent / Subject / Date / Assunto / Data...
                // and their split/folded physical lines.
                headerLineCount += headerSpan;
                afterRemovableHeader = true;
                const logicalHeader = rawLines.slice(i, i + headerSpan).map(x => x.line).join('');
                const headerValue = logicalHeader.replace(/^[^:：]*[:：]/, '').trim();

                // Empty value: many clients put the actual value on the next
                // physical line, even when that line is not indented.
                pendingWrappedHeader =
                    headerValue.length === 0 || /[,;\/-]$/.test(headerValue);

                i += headerSpan - 1;
                continue;
            }

            // Folded continuation of a removed header.
            if (
                afterRemovableHeader &&
                (
                    (/^[ \t]+\S/.test(line) || pendingWrappedHeader) &&
                    !isMailStartLine(line) &&
                    !isKnownHeaderLine(line)
                )
            ) {
                headerLineCount++;
                pendingWrappedHeader = /[,;\/-]$/.test(trimmed);
                continue;
            }

            // Another sender line normally means a new mail block. Keep it
            // rather than swallowing it as body text.
            if (
                isMailStartLine(line) &&
                looksLikeRealMailStart(rawLines, i, 5)
            ) {
                fromFound = true;
                inHeader = true;
                afterRemovableHeader = false;
                pendingWrappedHeader = false;
                headerLineCount = 0;

                outLines.push(rawLines[i].raw);
                continue;
            }

            // First normal non-header line = body starts here.
            inHeader = false;
            afterRemovableHeader = false;
            pendingWrappedHeader = false;
        }

        if (removeSignature && lineTriggerSignature(rawLines[i].line)) {
            break;
        }

        outLines.push(rawLines[i].raw);

        if (headerLineCount >= MAX_HEADER_LINES) {
            inHeader = false;
            afterRemovableHeader = false;
            pendingWrappedHeader = false;
        }
    }

    return outLines.join('');
}

function compressBlankLines(text: string): string {
    return text.replace(/(\r?\n)(\s*\1)+/g, '$1$1');
}

export function cleanThreadEmails(
    bodytext: string,
    removeSignature = true
): string {
    if (!bodytext) return bodytext;

    const blocks = splitMailBlocks(bodytext);
    if (blocks.length === 0) return bodytext;

    const cleaned: string[] = [];

    for (let i = 0; i < blocks.length; i++) {
        let blockContent = cleanOneMailBlock(
            blocks[i].text,
            removeSignature
        );

        if (i > 0) {
            const mailNumber = i + 1;
            blockContent =
                `\n--MAIL SPLIT MARKER-- #${mailNumber}\n` +
                blockContent;
        }

        blockContent += '\n';
        blockContent = compressBlankLines(blockContent);
        cleaned.push(blockContent);
    }

    const finalResult = cleaned.join('');
    return finalResult.length ? finalResult : bodytext;
}


// ============================================================
// 头部字段名（不含冒号，冒号由正则统一处理）
// ============================================================

const THREAD_BLOCK_STARTERS = [
    // English
    'From', 'Sender',
    // German
    'Von',
    // Spanish / French / Portuguese
    'De', 'Remitente', 'Expéditeur', 'Remetente',
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

const HEADER_REMOVE_LIST = [
    // English
    'Subject', 'To', 'Cc', 'Bcc', 'Sent', 'Date',
    'Reply-To', 'Message-ID', 'MIME-Version', 'Content-Type',
    'Content-Transfer-Encoding', 'References', 'In-Reply-To',
    // German
    'Betreff', 'An', 'Kopie', 'Gesendet', 'Gesendet am', 'Datum',
    // French
    'Objet', 'À', 'Cci', 'Envoyé', 'Envoyé le',
    // Spanish
    'Asunto', 'Para', 'Copia', 'CC', 'CCO', 'Enviado', 'Enviado el', 'Enviada el',
    'Fecha', 'Fecha de envío', 'Fecha de enviado',
    // Portuguese
    'Assunto', 'Cópia', 'Enviado em', 'Enviada em', 'Data', 'Data de envio',
    // Italian
    'Oggetto', 'A', 'Ccn', 'Inviato', 'Inviato il',
    // Dutch
    'Onderwerp', 'Aan', 'Verzonden', 'Verzonden op',
    // Polish
    'Temat', 'Do', 'DW', 'UDW', 'Wysłano', 'Wysłano dnia',
    // Turkish
    'Konu', 'Alıcı', 'Bilgi', 'Gizli', 'Gönderildi', 'Gönderilme tarihi', 'Tarih',
    // Russian
    'Тема', 'Кому', 'Копия', 'Скрытая копия', 'Отправлено', 'Отправлено в', 'Дата',
    // Japanese
    '件名', '宛先', '送信先', '送信日時', '送信日', '日付',
    // Korean
    '제목', '받는 사람', '참조', '숨은참조', '보낸 시간', '보낸 날짜', '날짜',
    // Chinese
    '主题', '收件人', '抄送', '密送', '发送时间', '发送日期', '日期',
];

// 技术性 header（永远与业务无关，永远应被移除）
const TECHNICAL_HEADER_RX =
    /^\s*(?:Reply-To|Bcc|Message-ID|MIME-Version|Content-Type|Content-Transfer-Encoding|References|In-Reply-To|Return-Path|Delivered-To|Auto-Submitted|Disposition-Notification-To|List-Unsubscribe|X-[A-Za-z0-9-]+)\s*[:：]/i;

// ============================================================
// 签名触发词
// ============================================================

const SIGNATURE_TRIGGERS = [
    // English
    'Best regards', 'Kind regards', 'Regards', 'Best wishes', 'Warm regards',
    'Sincerely', 'Respectfully', 'Thanks', 'Thank you',
    // Portuguese
    'Atenciosamente', 'Atencionalmente', 'Saudações', 'Obrigado', 'Cordialmente', 'Grato', 'Grata',
    // Spanish
    'Saludos', 'Saludos cordiales', 'Un cordial saludo', 'Atentamente', 'Saludos atentos',
    'Muchas gracias', 'Quedo atento', 
    // French
    'Cordialement', 'Bien cordialement', 'Bien à vous', 'Respectueusement',
    'Avec mes salutations distinguées', 'Merci',
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
    'Yours sincerely', 'Yours truly', 'Yours respectfully', 'Yours kindly',
    'Yours faithfully', 'All the best',
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
    'With appreciation',
    'Best regard','Cordial Saludo',
];

// ============================================================
// 类型 & 工具
// ============================================================

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

// ============================================================
// ★ 核心改动：冒号统一由正则处理
// ============================================================

// 冒号类：半角 + 全角
const COLON_CLASS = '[:：]';

// 字段名与冒号之间允许出现任意空白（半角 / 全角 / 不换行空格）
const HEADER_SEP_RX = `[\\s\\u00A0]*${COLON_CLASS}`;

// 去重（安全兜底，防止手工合并时有重复）
const UNIQUE_STARTERS = [...new Set(THREAD_BLOCK_STARTERS)];
const UNIQUE_REMOVABLES = [...new Set(HEADER_REMOVE_LIST)];

// mail 块起始（From 家族）
const starterKeywords = UNIQUE_STARTERS
    .slice()
    .sort((a, b) => b.length - a.length)   // 长词优先，避免短词抢先
    .map(escapeRegExp)
    .join('|');

const mailStartRx = new RegExp(
    `^[\\s\\u00A0]*(?:${starterKeywords})${HEADER_SEP_RX}`,
    'i'
);

// 可移除 header（Subject / To / Cc / Date / ...）
const extraHeaderKeywords = UNIQUE_REMOVABLES
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');

const extraHeaderRegex = new RegExp(
    `^[\\s\\u00A0]*(?:${extraHeaderKeywords})${HEADER_SEP_RX}`,
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

// ============================================================
// header 名归一化（用于集合查找 / 跨行拼接）
// ============================================================

function normalizeHeaderProbe(line: string): string {
    return line
        .replace(/\u00A0/g, ' ')
        .replace(/[：]/g, ':')
        .replace(/[ \t]+/g, '')
        .toLowerCase();
}

function headerNameOf(text: string): string {
    const normalized = normalizeHeaderProbe(text);
    const colon = normalized.indexOf(':');
    return colon >= 0 ? normalized.slice(0, colon) : normalized;
}

// 集合里现在是纯字段名（无冒号）
const removableHeaderNames = new Set(
    UNIQUE_REMOVABLES.map(headerNameOf)
);

// ============================================================
// 行级判定
// ============================================================

function isMailStartLine(line: string): boolean {
    return mailStartRx.test(line);
}

function isExtraHeaderLine(line: string): boolean {
    return extraHeaderRegex.test(line);
}

function isTechnicalHeaderLine(line: string): boolean {
    return TECHNICAL_HEADER_RX.test(line.trim());
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

// ★ 新增：判断某行是不是"几乎就是邮箱"的 From 续行
function looksLikeEmailContinuation(line: string): boolean {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.length > 200) return false;
    // <addr@domain> 单独成行
    if (/^<[^>]+>\s*$/.test(trimmed) && emailRx.test(trimmed)) return true;
    // addr@domain 单独成行（无空格）
    if (!/\s/.test(trimmed) && emailRx.test(trimmed)) return true;
    return false;
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

    if (emailRx.test(line)) return true;

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
 * 识别跨两行的 header，例如：
 *   Assun
 *   to: RE: Quote
 * 或：
 *   Envia
 *   do el: ...
 *
 * 返回本次占用的原始行数（1 或 2），0 表示不是 header。
 */
function getHeaderSpan(lines: RawLine[], index: number): number {
    if (index < 0 || index >= lines.length) return 0;

    const current = lines[index].line;
    if (isKnownHeaderLine(current)) return 1;

    if (index + 1 < lines.length) {
        const next = lines[index + 1].line;
        const joined = current.trimEnd() + next.trimStart();

        if (isKnownHeaderLine(joined)) return 2;

        // 字段名在词中间被拆开：'Assun' + 'to:' = 'Assunto:'
        const joinedProbe = normalizeHeaderProbe(joined);
        for (const name of removableHeaderNames) {
            if (joinedProbe.startsWith(name + ':')) return 2;
        }
    }

    return 0;
}

// ============================================================
// 切块
// ============================================================

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
                rawLines, i, MAX_LOOK_AHEAD
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

// ============================================================
// 对外 API
// ============================================================

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

function cleanOneMailBlock(blockText: string, removeSignature: boolean): string {
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

                // ★ From 邮箱续行
                let extra = 0;
                while (
                    extra < 3 &&
                    i + extra + 1 < rawLines.length &&
                    looksLikeEmailContinuation(rawLines[i + extra + 1].line)
                ) {
                    extra++;
                    outLines.push(rawLines[i + extra].raw);
                    headerLineCount++;
                }
                i += extra;
                continue;
            }
        }

        if (fromFound && inHeader) {
            const line = rawLines[i].line;
            const trimmed = line.trim();

            if (trimmed === '') {
                pendingWrappedHeader = false;
                continue;
            }

            const headerSpan = getHeaderSpan(rawLines, i);

            if (headerSpan > 0) {
                headerLineCount += headerSpan;
                afterRemovableHeader = true;
                const logicalHeader = rawLines
                    .slice(i, i + headerSpan).map(x => x.line).join('');
                const headerValue = logicalHeader
                    .replace(/^[^:：]*[:：]/, '').trim();
                pendingWrappedHeader =
                    headerValue === '' || /[,;\/-]$/.test(headerValue);
                i += headerSpan - 1;
                continue;
            }

            if (
                afterRemovableHeader &&
                ((/^[ \t]+\S/.test(line) || pendingWrappedHeader) &&
                 !isMailStartLine(line) &&
                 !isKnownHeaderLine(line))
            ) {
                headerLineCount++;
                continue;
            }

            if (isMailStartLine(line) && looksLikeRealMailStart(rawLines, i, 5)) {
                fromFound = true;
                inHeader = true;
                afterRemovableHeader = false;
                pendingWrappedHeader = false;
                headerLineCount = 0;

                outLines.push(rawLines[i].raw);

                // ★ 同样处理 header 区内再次出现的 From 邮箱续行
                let extra = 0;
                while (
                    extra < 3 &&
                    i + extra + 1 < rawLines.length &&
                    looksLikeEmailContinuation(rawLines[i + extra + 1].line)
                ) {
                    extra++;
                    outLines.push(rawLines[i + extra].raw);
                    headerLineCount++;
                }
                i += extra;
                continue;
            }

            inHeader = false;
            afterRemovableHeader = false;
            pendingWrappedHeader = false;
        }

        if (removeSignature && lineTriggerSignature(rawLines[i].line)) break;

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

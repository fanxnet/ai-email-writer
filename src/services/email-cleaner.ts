// ============================================================
// 头部关键词语义表：加语言只需改这里
// ============================================================

type HeaderKind = 'from' | 'subject' | 'to' | 'cc' | 'date';

const HEADER_TABLE: Record<HeaderKind, string[]> = {
    from: [
        // English
        'From', 'Sender',
        // German
        'Von',
        // Spanish / French / Portuguese (De 通用)
        'De', 'Remitente', 'Expéditeur', 'Remetente',
        // Italian
        'Mittente', 'Da',
        // Korean
        '보낸 사람', '보낸사람',
        // Japanese
        '差出人', '送信者',
        // Chinese (Simplified / Traditional)
        '发件人', '来自', '寄件人', '寄件者',
        // Russian
        'От', 'От кого',
    ],
    subject: [
        'Subject',
        'Betreff',
        'Objet',
        'Asunto',
        'Assunto',
        'Oggetto',
        'Тема',
        '件名',
        '제목',
        '主题',
    ],
    to: [
        'To', 'An', 'À', 'Para', 'A',
        'Кому', '宛先', '받는 사람', '收件人',
    ],
    cc: [
        'Cc', 'Kopie', 'Cópia', 'Копия', '참조', '抄送',
    ],
    date: [
        'Date', 'Datum', 'Fecha', 'Data', 'Дата',
        '日付', '날짜', '日期',
        'Sent', 'Envoyé', 'Gesendet', 'Enviada em',
    ],
};

const HEADER_KINDS: HeaderKind[] = ['from', 'subject', 'to', 'cc', 'date'];

// ============================================================
// 正则构建
// ============================================================

function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 半角 + 全角冒号，且允许 keyword 与冒号之间存在空白
function buildHeaderRegex(items: string[]): RegExp {
    const alt = items.map(escapeRegExp).join('|');
    return new RegExp(`^[\\s\\u00A0]*(?:${alt})[\\s\\u00A0]*[:：]`, 'i');
}

const HEADER_RX: Record<HeaderKind, RegExp> = {
    from:    buildHeaderRegex(HEADER_TABLE.from),
    subject: buildHeaderRegex(HEADER_TABLE.subject),
    to:      buildHeaderRegex(HEADER_TABLE.to),
    cc:      buildHeaderRegex(HEADER_TABLE.cc),
    date:    buildHeaderRegex(HEADER_TABLE.date),
};

function classifyHeader(line: string): HeaderKind | null {
    for (const kind of HEADER_KINDS) {
        if (HEADER_RX[kind].test(line)) return kind;
    }
    return null;
}

function isMailStartLine(line: string): boolean {
    return HEADER_RX.from.test(line);
}

// ============================================================
// 关键新增：折叠行 header 识别
// 处理形如：
//   Assun
//   to: RE: xxx
// 或
//   Subject
//   : hello
// 这类被邮件客户端拆断的字段名
// ============================================================

type HeaderHit = {
    kind: HeaderKind;
    /** 本次命中共消费了多少个原始行（1 或 2） */
    consumed: number;
};

function peekJoinHeader(
    lines: Array<{ line: string; raw: string }>,
    i: number
): HeaderHit | null {
    const cur = lines[i].line;

    // 1) 单行直接命中
    const k0 = classifyHeader(cur);
    if (k0) return { kind: k0, consumed: 1 };

    // 2) 尝试与下一行拼接
    if (i + 1 >= lines.length) return null;

    const next = lines[i + 1].line;

    // 避免把两行正文误拼成 header：要求当前行不含冒号、非空；
    // 下一行也不能是完全空白
    if (cur.trim().length === 0) return null;
    if (next.trim().length === 0) return null;
    // 如果当前行本身已经含冒号，说明它自成一个（可能是其它 header 或正文），
    // 不再尝试与下一行拼接
    if (/[:：]/.test(cur)) return null;

    // 2a) 无空格直接拼接："Assun" + "to:" = "Assunto:"
    const joined = cur + next;
    const kj = classifyHeader(joined);
    if (kj) return { kind: kj, consumed: 2 };

    // 2b) 中间加空格拼接（少数客户端会在折行处留一个空格的等价物）
    const joinedSpace = cur + ' ' + next;
    const ks = classifyHeader(joinedSpace);
    if (ks) return { kind: ks, consumed: 2 };

    return null;
}

// ============================================================
// 签名触发词 / 姓名
// ============================================================

const SIGNATURE_TRIGGERS = [
    // English
    'Best regards',
    'Kind regards',
    'Regards',
    'Best wishes',
    'Warm regards',
    'Sincerely',
    'Respectfully',
    'Thanks',
    'Thank you',
    // Portuguese
    'Atenciosamente',
    'Atencionalmente',
    'Saudações',
    'Obrigado',
    'Cordialmente',
    'Grato',
    'Grata',
    // Spanish
    'Saludos',
    'Saludos cordiales',
    'Un cordial saludo',
    'Atentamente',
    'Saludos atentos',
    'Muchas gracias',
    'Quedo atento',
    'Cordial Saludo',
    // French
    'Cordialement',
    'Bien cordialement',
    'Bien à vous',
    'Respectueusement',
    'Avec mes salutations distinguées',
    'Merci',
    // German
    'Mit freundlichen Grüßen',
    'Viele Grüße',
    'Liebe Grüße',
    'Beste Grüße',
    'Hochachtungsvoll',
    // Italian
    'Cordiali saluti',
    'Grazie',
    // Korean
    '감사합니다.',
    '감사드립니다',
    '고맙습니다',
    // Japanese
    'よろしくお願いいたします',
    '宜しくお願い致します',
    '何卒よろしくお願い申し上げます',
    // Russian
    'С уважением',
    'Спасибо',
    // Common shorthand (shipping/logistics)
    'Tks',
    'Thks',
    'B. Rgds',
    'B.Rgds',
    'B rgds',
    'BRgds',
    'Tks n rgds',
    'Yours sincerely',
    'Yours truly',
    'Yours respectfully',
    'Yours kindly',
    'Yours faithfully',
    'All the best',
    // Chinese
    '顺颂商祺',
    '祝好',
    '此致',
    '敬礼',
];

const SIGNATURE_NAMES = [
    'Thank you so much',
    'Thank you very much',
    'Thank you in advance',
    'Excited to work on this',
    'Angelina Liu',
    'Parisi Grand Smooth Logistics Ltd.',
    'With appreciation',
];

// 不排序；/i 忽略大小写
const salutePattern = SIGNATURE_TRIGGERS.map(escapeRegExp).join('|');

// 复合链式签名：关键词 (/|&|,|and|\|) 关键词
const multiSaluteRx = new RegExp(
    `(${salutePattern})\\s*(?:\\/|&|,|and|\\|)\\s*(${salutePattern})\\s*[,.!~;]*`,
    'i'
);

function lineTriggerSignature(line: string): boolean {
    if (!line) return false;
    const trimmed = line.trim();
    if (trimmed.length === 0) return false;

    const MAX_SIGNATURE_LINE = 80;
    if (trimmed.length > MAX_SIGNATURE_LINE) return false;
    if (trimmed.includes('?')) return false;

    const lowerLine = trimmed.toLowerCase();
    if (lowerLine.startsWith('dear ')) return false;

    const MAX_PREFIX = 2;
    const MAX_TAIL_CHARS = 5;

    // 1. 单行问候关键词
    for (const keyword of SIGNATURE_TRIGGERS) {
        const kw = keyword.toLowerCase();
        const pos = lowerLine.indexOf(kw);
        if (pos === -1) continue;
        if (pos > MAX_PREFIX) continue;
        const kwEnd = pos + kw.length;
        const tailLength = trimmed.length - kwEnd;
        if (tailLength <= MAX_TAIL_CHARS) {
            return true;
        }
    }

    // 2. 复合链式签名
    if (multiSaluteRx.test(lowerLine)) {
        return true;
    }

    // 3. 人名签名（严格行首）
    for (const name of SIGNATURE_NAMES) {
        const nameLower = name.toLowerCase();
        if (lowerLine.startsWith(nameLower)) {
            const tailLength = trimmed.length - nameLower.length;
            if (tailLength <= MAX_TAIL_CHARS) {
                return true;
            }
        }
    }

    return false;
}

// ============================================================
// 基础工具
// ============================================================

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

function splitPreserveNewline(text: string): Array<{ line: string; raw: string }> {
    const result: Array<{ line: string; raw: string }> = [];
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
        result.push({ line: lineContent, raw: lineContent + newlineStr });
        pos = nlIndex + 1;
    }
    return result;
}

// 判定 From 是否像一封真实的邮件头：向后 N 行内出现邮箱线索（<...> 或 @）
function looksLikeMailHeader(
    lines: Array<{ line: string; raw: string }>,
    currentIndex: number,
    lookAheadMax: number
): boolean {
    for (let i = 0; i <= lookAheadMax; i++) {
        const idx = currentIndex + i;
        if (idx >= lines.length) break;
        const l = lines[idx].line;
        if (l.includes('@') || l.includes('<')) return true;
    }
    return false;
}

// ============================================================
// 邮件块切分
// ============================================================

type MailBlock = {
    type: 'mail';
    text: string;
};

function splitMailBlocks(threadText: string): MailBlock[] {
    const rawLines = splitPreserveNewline(threadText);
    const blocks: string[][] = [];
    let currentBlock: string[] | null = null;
    const MAX_LOOK_AHEAD = 5;

    for (let i = 0; i < rawLines.length; i++) {
        const item = rawLines[i];
        const textLine = item.line;

        if (isMailStartLine(textLine) &&
            looksLikeMailHeader(rawLines, i, MAX_LOOK_AHEAD)) {
            if (currentBlock !== null && currentBlock.length > 0) {
                blocks.push(currentBlock);
            }
            currentBlock = [item.raw];
            continue;
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
// 单块清洗（状态机 + 折叠行识别）
// ============================================================

const MAX_HEADER_LINES = 20;

/**
 * 头部区只保留 From 行，其余 Header（Subject/To/Cc/Date/...）一律丢弃。
 * 支持被邮件客户端拆断的字段名，例如：
 *     Assun
 *     to: RE: xxx
 * 遇到 Subject 或第一个非 Header 行即进入正文；正文区可选做签名过滤。
 */
function cleanOneBlock(blockText: string, removeSignature: boolean): string {
    const rawLines = splitPreserveNewline(blockText);
    const out: string[] = [];
    let state: 'scan' | 'header' | 'body' = 'scan';
    let headerLineCount = 0;
    let signatureHit = false;

    let i = 0;
    while (i < rawLines.length) {
        const item = rawLines[i];
        const { line, raw } = item;

        if (signatureHit) {
            i++;
            continue;
        }

        // ---------- scan ----------
        if (state === 'scan') {
            const hit = peekJoinHeader(rawLines, i);
            if (hit && hit.kind === 'from') {
                for (let k = 0; k < hit.consumed; k++) {
                    out.push(rawLines[i + k].raw);
                }
                i += hit.consumed;
                state = 'header';
                headerLineCount = 1;
                continue;
            }
            // 不是 from 头，正常输出
            out.push(raw);
            i++;
            continue;
        }

        // ---------- header ----------
        if (state === 'header') {
            const hit = peekJoinHeader(rawLines, i);

            if (hit && hit.kind === 'from') {
                for (let k = 0; k < hit.consumed; k++) {
                    out.push(rawLines[i + k].raw);
                }
                i += hit.consumed;
                headerLineCount++;
                continue;
            }

            if (hit && hit.kind === 'subject') {
                // Subject 出现 = 头部结束，该行及其续行全部丢弃
                i += hit.consumed;
                state = 'body';
                continue;
            }

            if (hit) {
                // 其它 header 一律丢弃（含 Data / Para / Cc ...）
                i += hit.consumed;
                headerLineCount++;
                if (headerLineCount > MAX_HEADER_LINES) {
                    // 兜底：头部过长，退出 header 状态；但不输出当前行
                    state = 'body';
                }
                continue;
            }

            // 当前行不是 header：进入正文，本行按正文规则处理
            state = 'body';
            // 不 continue，让下方 body 分支处理这一行
        }

        // ---------- body ----------
        if (removeSignature && lineTriggerSignature(line)) {
            signatureHit = true;
            i++;
            continue;
        }
        out.push(raw);
        i++;
    }

    return out.join('');
}

// ============================================================
// 对外 API
// ============================================================

export function buildThreadBodyText(bodytext: string, keepReplies: number): string {
    const blocks = splitMailBlocks(bodytext);
    if (blocks.length === 0) return bodytext;
    const safeKeep = Math.max(0, keepReplies);
    const takeCount = 1 + safeKeep;
    const selectedMails = blocks.slice(0, takeCount);
    return selectedMails.map(b => b.text).join('');
}

function compressBlankLines(text: string): string {
    // 之前用 \s 会吞正文，这里只压缩连续的换行
    return text.replace(/(?:\r?\n){3,}/g, '\n\n');
}

export function cleanThreadEmails(bodytext: string, removeSignature = true): string {
    if (!bodytext) return bodytext;
    const blocks = splitMailBlocks(bodytext);
    const cleaned: string[] = [];

    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        let blockContent = cleanOneBlock(block.text, removeSignature);
        if (!blockContent) blockContent = block.text;

        if (i > 0) {
            const mailNumber = i + 1;
            const separator = `\n--MAIL SPLIT MARKER-- #${mailNumber}\n`;
            blockContent = separator + blockContent;
        }
        blockContent += '\n';
        blockContent = compressBlankLines(blockContent);
        cleaned.push(blockContent);
    }

    const finalResult = cleaned.join('');
    return finalResult.length ? finalResult : bodytext;
}

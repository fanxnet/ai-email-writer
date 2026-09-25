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
    'Meilleures Salutations',
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

// ========== 正则构建：统一处理全角/半角冒号 + 前置空格 ==========
// 发件人起始正则：按长度降序避免短词抢先匹配
const starterKeywords = [...THREAD_BLOCK_STARTERS]
    .sort((a, b) => b.length - a.length)
    .map(s => escapeRegExp(s))
    .join('|');
const mailStartRx = new RegExp(`^[\\s\\u00A0]*(${starterKeywords})\\s*[:：]`, 'i');

// 头部移除正则：统一兼容空格 + 全角/半角冒号
const extraHeaderKeywords = [...HEADER_REMOVE_LIST]
    .sort((a, b) => b.length - a.length)
    .map(s => escapeRegExp(s))
    .join('|');
const extraHeaderRegex = new RegExp(`^[\\s\\u00A0]*(${extraHeaderKeywords})\\s*[:：]`, 'i');

// 主题行正则，多语种主题头：英/中/德/法/西/葡/意/俄/日/韩
const subjectRx = /^\s*(subject|主题|betreff|objet|asunto|assunto|oggetto|тема|件名|제목)\s*[:：]/i;


type MailBlock = {
    type: 'mail';
    text: string;
};

function isMailStartLine(line: string): boolean {
    return mailStartRx.test(line);
}

function isExtraHeaderLine(line: string): boolean {
    return extraHeaderRegex.test(line);
}

function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 签名关键词正则：不排序，/i 负责忽略大小写匹配
const salutePattern = SIGNATURE_TRIGGERS
    .map(escapeRegExp)
    .join('|');
// 复合链式签名：2个关键词由 / 或 & | and , - 等分隔符隔开即命中
const multiSaluteRx = new RegExp(
    `(${salutePattern})\\s*(?:\\/|&|,|and|-|\\|)\\s*(${salutePattern})\\s*[,.!~;]*`,
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

    // 1.普通单行问候关键词检测
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

    // 2.复合链式签名检测
    if (multiSaluteRx.test(lowerLine)) {
        return true;
    }

    // 3.人名签名：严格行首匹配
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

/**
 * 标准判定：发件人行后续是否出现 <邮箱> 尖括号特征
 */
function peekHasEmailBracket(
    lines: Array<{ line: string, raw: string }>,
    currentIndex: number,
    lookAheadMax: number
): boolean {
    for (let i = 0; i <= lookAheadMax; i++) {
        const idx = currentIndex + i;
        if (idx >= lines.length) break;
        if (lines[idx].line.includes('<')) {
            return true;
        }
    }
    return false;
}

/**
 * 兜底判定：发件人行后续是否出现足够多的邮件头部字段
 * 用于兼容没有<邮箱尖括号>的纯内网/非标准邮件头格式
 */
function peekHasHeaderPattern(
    lines: Array<{ line: string, raw: string }>,
    currentIndex: number,
    lookAheadMax: number
): boolean {
    const MIN_HEADER_COUNT = 2; // 至少再出现2个头部字段，才判定为有效邮件头
    let headerCount = 0;

    // 从发件人的下一行开始统计，当前行已经是发件人本身
    for (let i = 1; i <= lookAheadMax; i++) {
        const idx = currentIndex + i;
        if (idx >= lines.length) break;
        if (isExtraHeaderLine(lines[idx].line)) {
            headerCount++;
            if (headerCount >= MIN_HEADER_COUNT) return true;
        }
    }
    return false;
}

function splitMailBlocks(threadText: string): MailBlock[] {
    console.debug('[splitMailBlocks] input length:', threadText.length);
    const rawLines = splitPreserveNewline(threadText);
    const blocks: string[][] = [];
    let currentBlock: string[] | null = null;
    const MAX_LOOK_AHEAD = 5; // 扫描窗口从3放宽至5

    for (let i = 0; i < rawLines.length; i++) {
        const item = rawLines[i];
        const textLine = item.line;

        if (isHorizontalRuleLine(textLine)) {
            if (currentBlock === null) currentBlock = [];
            currentBlock.push(item.raw);
            continue;
        }

        if (isMailStartLine(textLine)) {
            // 两种判定方式并联：邮箱尖括号 或 连续头部字段，满足其一即判定有效邮件头
            const isValidMailHeader =
                peekHasEmailBracket(rawLines, i, MAX_LOOK_AHEAD) ||
                peekHasHeaderPattern(rawLines, i, MAX_LOOK_AHEAD);

            if (isValidMailHeader) {
                if (currentBlock !== null && currentBlock.length > 0) {
                    blocks.push(currentBlock);
                }
                currentBlock = [item.raw];
                continue;
            } else {
                if (currentBlock === null) {
                    currentBlock = [item.raw];
                } else {
                    currentBlock.push(item.raw);
                }
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
        console.debug('[splitMailBlocks] fallback-all-to-mail');
        result.push({ type: 'mail', text: threadText });
    }

    console.debug('[splitMailBlocks] blocks count =', result.length);
    return result;
}

export function buildThreadBodyText(bodytext: string, keepReplies: number): string {
    const blocks = splitMailBlocks(bodytext);
    if (blocks.length === 0) return bodytext;
    const safeKeep = Math.max(0, keepReplies);
    const takeCount = 1 + safeKeep;
    const selectedMails = blocks.slice(0, takeCount);
    return selectedMails.map(b => b.text).join('');
}

function compressBlankLines(text: string): string {
    return text.replace(/(\r?\n)(\s*\1)+/g, '$1$1');
}

/**
 * 扫描主题续行：返回主题块的最后一行索引
 * 用于处理长主题硬换行折行的场景，避免主题续行残留为正文尾巴
 */
function findSubjectEndIndex(
    rawLines: Array<{ line: string, raw: string }>,
    subjectStartIndex: number,
    maxContinueLines: number = 3
): number {
    let endIndex = subjectStartIndex;
    const scanEnd = Math.min(subjectStartIndex + maxContinueLines, rawLines.length - 1);

    for (let k = subjectStartIndex + 1; k <= scanEnd; k++) {
        const line = rawLines[k].line.trim();
        // 遇到空行、分隔线、新邮件头 → 主题结束
        if (line === '' || isHorizontalRuleLine(rawLines[k].line) || isMailStartLine(rawLines[k].line)) {
            break;
        }
        // 遇到正文问候语开头 → 主题结束
        if (/^(hi|dear|hello|你好|您好|hi\s+|dear\s+)/i.test(line)) {
            break;
        }
        // 包含冒号 → 大概率是下一个头部字段 → 主题结束
        if (line.includes(':')) {
            break;
        }
        // 符合续行特征，更新结束索引
        endIndex = k;
    }
    return endIndex;
}

export function cleanThreadEmails(bodytext: string, removeSignature = true): string {
    if (!bodytext) return bodytext;
    const blocks = splitMailBlocks(bodytext);
    const cleaned: string[] = [];
    const MAX_HEADER_LINES = 20;

    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const rawLines = splitPreserveNewline(block.text);
        const outLines: string[] = [];
        let signatureHit = false;

        // ---------- 优先路径：扫描From/发件人 → Subject/主题，最多向后20行 ----------
        let fromIndex = -1;
        for (let j = 0; j < rawLines.length; j++) {
            if (isMailStartLine(rawLines[j].line)) {
                fromIndex = j;
                break;
            }
        }

        let foundSubjectWithinLimit = false;
        let subjectLineIndex = -1;
        let subjectEndIndex = -1;
        if (fromIndex !== -1) {
            const scanEnd = Math.min(fromIndex + MAX_HEADER_LINES, rawLines.length - 1);
            for (let j = fromIndex + 1; j <= scanEnd; j++) {
                // 原有单行匹配
                if (subjectRx.test(rawLines[j].line)) {
                    foundSubjectWithinLimit = true;
                    subjectLineIndex = j;
                    subjectEndIndex = findSubjectEndIndex(rawLines, j);
                    break;
                }
                // 新增：相邻两行拼接，处理单词被换行打断场景（Assun\nto:）
                const nextJ = j + 1;
                if(nextJ <= scanEnd){
                    const combined = rawLines[j].line.trim() + rawLines[nextJ].line.trim();
                    if(subjectRx.test(combined)){
                        foundSubjectWithinLimit = true;
                        subjectLineIndex = j; // 主题起始行是当前j（Assun那一行）
                        subjectEndIndex = findSubjectEndIndex(rawLines, nextJ);
                        break;
                    }
                }
            }
        }

        if (fromIndex !== -1 && foundSubjectWithinLimit && subjectEndIndex > fromIndex) {
            // 优先分支：保留发件人行，发件人+1 ~ 主题最后一行全部丢弃
            for (let j = 0; j < rawLines.length; j++) {
                if (signatureHit) continue;
                const item = rawLines[j];
                if (j === fromIndex) {
                    outLines.push(item.raw);
                    continue;
                }
                // 发件人与主题结束之间的所有头部（含主题断字跨行、主题续行）全部跳过
                if (j > fromIndex && j <= subjectEndIndex) {
                    continue;
                }
                // 正文区开始，执行签名过滤
                if (removeSignature && lineTriggerSignature(item.line)) {
                    signatureHit = true;
                    continue;
                }
                outLines.push(item.raw);
            }
        } else {
            // ---------- 兜底降级：原有insideHeaderBlock方案 ----------
            let insideHeaderBlock = false;
            let headerLineCount = 0;
            for (const item of rawLines) {
                if (signatureHit) continue;
                const line = item.line;

                if (insideHeaderBlock) {
                    headerLineCount++;
                    if (subjectRx.test(line)) {
                        insideHeaderBlock = false;
                        headerLineCount = 0;
                        continue;
                    }
                    if (line.trim() === '' || isHorizontalRuleLine(line) || headerLineCount >= MAX_HEADER_LINES) {
                        insideHeaderBlock = false;
                        headerLineCount = 0;
                        outLines.push(item.raw);
                        continue;
                    }
                    continue;
                }

                if (isMailStartLine(line)) {
                    outLines.push(item.raw);
                    continue;
                }
                if (isExtraHeaderLine(line)) {
                    insideHeaderBlock = true;
                    headerLineCount = 1;
                    continue;
                }
                if (removeSignature && lineTriggerSignature(line)) {
                    signatureHit = true;
                    continue;
                }
                outLines.push(item.raw);
            }
        }

        let blockContent = outLines.length ? outLines.join('') : block.text;
        if (i > 0) {
            const mailNumber = i + 1;
            const separator = `\n==Mail #${mailNumber}==\n`;
            blockContent = separator + blockContent;
        }
        blockContent += "\n";
        blockContent = compressBlankLines(blockContent);
        cleaned.push(blockContent);
    }

    const finalResult = cleaned.join('');
    return finalResult.length ? finalResult : bodytext;
}


const THREAD_BLOCK_STARTERS = [
    // English
    'From:',
    'From :',
    'Sender:',
    'Sender :',
    // German
    'Von:',
    'Von :',
    // Spanish
    'De:',
    'De :',
    'Remitente:',
    'Remitente :',
    // French
    'Expéditeur:',
    'Expéditeur :',
    'De:',
    'De :',
    // Portuguese
    'Remetente:',
    'Remetente :',
    'De:',
    'De :',
    // Italian
    'Mittente:',
    'Mittente :',
    'Da:',
    'Da :',
    // Korean
    '보낸 사람:',
    '보낸 사람 :',
    '보낸사람:',
    '보낸사람 :',
    // Japanese
    '差出人：',
    '差出人:',
    '送信者：',
    '送信者:',
    // Chinese (Simplified)
    '发件人：',
    '发件人:',
    '来自：',
    '寄件人：',
    // Chinese (Traditional / Taiwan)
    '寄件者：',
    '寄件者:',
    // Russian
    'От:',
    'От :',
    'От кого:',
    'От кого :',
];

const HEADER_REMOVE_LIST = [
    'Subject:', 'To:', 'Cc:', 'Sent:', 'Date:',
    'Betreff:', 'An:', 'Kopie:', 'Gesendet:', 'Datum:',
    'Objet :', 'À :', 'Cc :', 'Envoyé :', 'Date :',
    'Asunto:', 'Para:', 'Copia:', 'Enviado:', 'Fecha:',
    'Assunto:', 'Para:', 'Cópia:', 'Enviado:', 'Data:',
    'Oggetto:', 'A:', 'Cc:', 'Inviato:', 'Data:',
    'Тема:', 'Кому:', 'Копия:', 'Отправлено:', 'Дата:',
    '件名：', '宛先：', 'Cc：', '送信日時：', '日付：',
    '제목:', '받는 사람:', '참조:', '보낸 시간:', '날짜:',
    '主题：', '主题:', '收件人：', '收件人:', '抄送：', '抄送:', '发送时间：', '发送时间:', '日期：', '日期:',
    'Enviada em:'
];
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

const starterKeywords = THREAD_BLOCK_STARTERS.map(s=>escapeRegExp(s)).join('|');
const mailStartRx = new RegExp(`^[\\s\\u00A0]*(${starterKeywords})`, 'i');

const extraHeaderRxItems = HEADER_REMOVE_LIST.filter(item => item !== 'Expéditeur :')
    .map(s => escapeRegExp(s));
extraHeaderRxItems.unshift('Expéditeur\\s*:');
const extraHeaderRegex = new RegExp(`^[\\s\\u00A0]*(${extraHeaderRxItems.join('|')})`, 'i');


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

// 不排序；/i 负责忽略大小写匹配
const salutePattern = SIGNATURE_TRIGGERS
    .map(escapeRegExp)
    .join('|');

/*/ 长词优先排序，防止短词抢先匹配长词组
const salutePattern = [...SIGNATURE_TRIGGERS]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
*/
// 关键修复：移除末尾 $ 行尾锚点！
// 只要存在一对 关键词 (/ & , and | 分隔符)关键词，后面还可以有更多链式内容
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

    // 2.复合链式签名：2个关键词由 / 或 & 隔开即命中
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
    if(trimmed.length < 5) return false;
    const firstChar = trimmed[0];
    if(!['-','=','_','—','―','~'].includes(firstChar)) return false;
    let sameCount = 0;
    for(const ch of trimmed){
        if(ch === firstChar) sameCount++;
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

function peekHasEmailBracket(lines:Array<{line:string,raw:string}>, currentIndex:number, lookAheadMax:number):boolean{
    for(let i = 0; i <= lookAheadMax; i++){
        const idx = currentIndex + i;
        if(idx >= lines.length) break;
        if(lines[idx].line.includes('<')){
            return true;
        }
    }
    return false;
}

function splitMailBlocks(threadText: string): MailBlock[] {
    console.debug('[splitMailBlocks] input length:', threadText.length);
    const rawLines = splitPreserveNewline(threadText);
    const blocks: string[][] = [];
    let currentBlock: string[] | null = null;
    const MAX_LOOK_AHEAD = 3;

    for (let i = 0; i < rawLines.length; i++) {
        const item = rawLines[i];
        const textLine = item.line;

        if (isHorizontalRuleLine(textLine)) {
            if (currentBlock === null) currentBlock = [];
            currentBlock.push(item.raw);
            continue;
        }

        if (isMailStartLine(textLine)) {
            const isValidMailHeader = peekHasEmailBracket(rawLines, i, MAX_LOOK_AHEAD);
            if(isValidMailHeader){
                if (currentBlock !== null && currentBlock.length > 0) {
                    blocks.push(currentBlock);
                }
                currentBlock = [item.raw];
                continue;
            }else{
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

function compressBlankLines(text: string): string {
    return text.replace(/(\r?\n)(\s*\1)+/g, '$1$1');
}

function isTechnicalHeaderLine(line: string): boolean {
    const trimmed = line.trim();
    return /^(Reply-To|Bcc|Message-ID|MIME-Version|Content-Type|Content-Transfer-Encoding|References|In-Reply-To|Return-Path|Delivered-To|Auto-Submitted|X-[\w-]+)\s*[:：]/i.test(trimmed);
}

function isHeaderContinuation(line: string): boolean {
    return /^[ \t]+\S/.test(line);
}

/**
 * Header rule:
 * - keep From / equivalent sender line
 * - remove To / Cc / Sent / Subject / Date and known technical headers
 * - remove folded continuation lines belonging to a removed header
 * - Subject is NOT required as the end marker
 */
function cleanMailHeaderLines(
    rawLines: Array<{ line: string; raw: string }>
): Array<{ line: string; raw: string }> {
    const outLines: Array<{ line: string; raw: string }> = [];
    let fromFound = false;
    let insideHeader = false;
    let removingFoldedHeader = false;
    let headerLineCount = 0;
    const MAX_HEADER_LINES = 20;

    for (let i = 0; i < rawLines.length; i++) {
        const item = rawLines[i];
        const line = item.line;
        const trimmed = line.trim();

        // Keep the sender line only.
        if (isMailStartLine(line) && !fromFound) {
            outLines.push(item);
            fromFound = true;
            insideHeader = true;
            removingFoldedHeader = false;
            headerLineCount = 0;
            continue;
        }

        if (fromFound && insideHeader) {
            // Empty line is the normal end of the mail header.
            if (trimmed === '') {
                insideHeader = false;
                removingFoldedHeader = false;
                outLines.push(item);
                continue;
            }

            // Remove known visible headers: To / Cc / Sent / Subject / Date...
            if (isExtraHeaderLine(line) || isTechnicalHeaderLine(line)) {
                headerLineCount++;
                // If there is no value after ':' the next indented line can be
                // a folded continuation of this header.
                // Any immediately following indented line belongs to this header.
                removingFoldedHeader = true;
                continue;
            }

            // Remove folded continuation lines of a removed header.
            if (removingFoldedHeader && isHeaderContinuation(line)) {
                headerLineCount++;
                continue;
            }

            // Some clients wrap a header value without indentation, e.g.
            // Subject:\nRE: Project Cargo
            if (
                removingFoldedHeader &&
                headerLineCount < MAX_HEADER_LINES &&
                !isMailStartLine(line) &&
                !isExtraHeaderLine(line) &&
                !isTechnicalHeaderLine(line)
            ) {
                removingFoldedHeader = false;
                insideHeader = false;
                // The current line is treated as body below.
            } else if (headerLineCount >= MAX_HEADER_LINES) {
                insideHeader = false;
                removingFoldedHeader = false;
            } else {
                // First normal non-header line marks the body start.
                insideHeader = false;
                removingFoldedHeader = false;
            }
        }

        // Body: preserve text and let the existing signature logic handle it.
        outLines.push(item);
    }

    return outLines;
}

export function buildThreadBodyText(bodytext: string, keepReplies: number): string {
    const blocks = splitMailBlocks(bodytext);
    if (blocks.length === 0) return bodytext;
    const safeKeep = Math.max(0, keepReplies);
    const takeCount = 1 + safeKeep;
    const selectedMails = blocks.slice(0, takeCount);
    return selectedMails.map(b => b.text).join('');
}

export function cleanThreadEmails(bodytext: string, removeSignature = true): string {
    if (!bodytext) return bodytext;

    const blocks = splitMailBlocks(bodytext);
    if (blocks.length === 0) return bodytext;

    const cleaned: string[] = [];

    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const rawLines = splitPreserveNewline(block.text);
        const headerCleaned = cleanMailHeaderLines(rawLines);
        const outLines: string[] = [];
        let signatureHit = false;

        // Existing signature removal behavior is preserved after header cleanup.
        for (const item of headerCleaned) {
            if (signatureHit) break;

            if (removeSignature && lineTriggerSignature(item.line)) {
                signatureHit = true;
                continue;
            }

            outLines.push(item.raw);
        }

        // Important: do not restore block.text here, otherwise removed headers
        // could come back when the cleaned result is empty.
        let blockContent = outLines.join('');

        if (i > 0) {
            const mailNumber = i + 1;
            const separator = `\n--MAIL SPLIT MARKER-- #${mailNumber}\n`;
            blockContent = separator + blockContent;
        }

        blockContent += "\n";
        blockContent = compressBlankLines(blockContent);
        cleaned.push(blockContent);
    }

    const finalResult = cleaned.join('');
    return finalResult.length ? finalResult : bodytext;
}


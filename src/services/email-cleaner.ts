function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const THREAD_BLOCK_STARTERS = [
    'From:',
    'Von:',
    'De:',
    '发件人：',
    'Sender:',
    'Expéditeur :',
    'Remitente:',
    'Remetente:',
    'Mittente:',
    'От:',
    '差出人：',
    '보낸 사람:'
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
    '主题：', '收件人：', '抄送：', '发送时间：', '日期：'
];
const SIGNATURE_TRIGGERS = [
    'Regards',
    'Thanks',
    'Thank you',
    'Sincerely',
    'Wishes',
    'Mit freundlichen Grüßen',
    'Viele Grüße',
    'Liebe Grüße',
    'Cordialement',
    'Bien à vous',
    'Merci',
    'Saludos',
    'Atentamente',
    'Muchas gracias',
    'Atenciosamente',
    'Saudações',
    'Obrigado',
    'Cordiali saluti',
    'Grazie',
    'С уважением',
    'Спасибо',
    'よろしくお願いいたします',
    '宜しくお願い致します',
    '감사합니다.',
    '顺颂商祺',
    '祝好',
    '此致',
    '敬礼',
    '祝工作顺利',
    '祝万事如意',
    'Angelina Liu'
];

const starterKeywords = THREAD_BLOCK_STARTERS.map(s=>escapeRegExp(s)).join('|');

// ==========核心简化：发件人行统一判断（行首命中标记即可，不区分单行/跨行）==========
const mailStartRx = new RegExp(`^[\\s\\u00A0]*(${starterKeywords})`, 'i');

// Expéditeur兼容冒号前有无空格
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

// 签名检测：前缀≤5字符 + 尾部≤12字符
function lineTriggerSignature(line: string): boolean {
    if (!line) return false;
    const trimmed = line.trim();
    if (trimmed.length === 0) return false;
    const MAX_SIGNATURE_LINE = 30;
    if (trimmed.length > MAX_SIGNATURE_LINE) return false;
    if (trimmed.includes('?')) return false;

    const lowerLine = trimmed.toLowerCase();
    const MAX_PREFIX = 5;
    const MAX_TAIL_CHARS = 12;

    for (const keyword of SIGNATURE_TRIGGERS) {
        const kw = keyword.toLowerCase();
        const pos = lowerLine.indexOf(kw);
        if (pos === -1) continue;
        if(pos > MAX_PREFIX) continue;
        const kwEnd = pos + kw.length;
        const tailLength = trimmed.length - kwEnd;
        if (tailLength <= MAX_TAIL_CHARS) {
            return true;
        }
    }
    return false;
}

// 通用横线判断：覆盖所有HR转文本字符
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

// ===================== 分割阶段：极简逻辑，From到From就是一封邮件 =====================
function splitMailBlocks(threadText: string): MailBlock[] {
    console.debug('[splitMailBlocks] input length:', threadText.length);
    const rawLines = splitPreserveNewline(threadText);
    const blocks: string[][] = [];
    let currentBlock: string[] | null = null;

    for (const item of rawLines) {
        const textLine = item.line;

        // 优先级1：横线防御，直接归入当前块，跳过所有分割判断
        if (isHorizontalRuleLine(textLine)) {
            if (currentBlock === null) currentBlock = [];
            currentBlock.push(item.raw);
            continue;
        }

        // 优先级2：行首命中发件人标记 → 新邮件块开始
        if (isMailStartLine(textLine)) {
            // 归档上一封邮件
            if (currentBlock !== null && currentBlock.length > 0) {
                blocks.push(currentBlock);
            }
            // 开启新邮件，发件人行作为块首行
            currentBlock = [item.raw];
            continue;
        }

        // 普通内容行，直接加入当前邮件块
        if (currentBlock === null) {
            currentBlock = [item.raw];
        } else {
            currentBlock.push(item.raw);
        }
    }

    // 归档最后一封邮件
    if (currentBlock !== null && currentBlock.length > 0) {
        blocks.push(currentBlock);
    }

    // 组装结果
    const result: MailBlock[] = blocks
        .map(b => b.join(''))
        .filter(mailText => mailText.trim().length > 0)
        .map(text => ({ type: 'mail', text }));

    // 兜底：零分割标记，全文当做一封邮件
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
    text = text.replace(/\u00A0/g, ' ');
    return text.replace(/(\r?\n)(\s*\1)+/g, '$1$1');
}

// ===================== 清理阶段：分割完成后，块内做过滤 =====================
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
        let insideHeaderBlock = false;
        let headerLineCount = 0;

        for (const item of rawLines) {
            if (signatureHit) continue;
            const line = item.line;

            // 头部区块退出：空白行 / 横线 / 超过最大行数
            if (insideHeaderBlock) {
                headerLineCount++;
                if (line.trim() === '' || isHorizontalRuleLine(line) || headerLineCount >= MAX_HEADER_LINES) {
                    insideHeaderBlock = false;
                    headerLineCount = 0;
                    outLines.push(item.raw);
                    continue;
                }
                continue;
            }

            // 发件人行保留
            if (isMailStartLine(line)) {
                outLines.push(item.raw);
                continue;
            }
            // 命中其他头部字段，开启头部区块
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
        let blockContent = outLines.length ? outLines.join('') : block.text;

        // 带序号分隔符
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


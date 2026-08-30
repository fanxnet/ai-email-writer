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

// ==========修复1：孤立starter正则恢复整行匹配$，同时强制冒号后带空格==========
const lonelyStarterRx = new RegExp(`^[\\s\\u00A0]*(${starterKeywords})\\s+$`, 'i');
// 单行完整分割头
const inlineStarterRx = new RegExp(`^[\\s\\u00A0]*(${starterKeywords})`, 'i');

// Expéditeur兼容冒号前有无空格
const extraHeaderRxItems = HEADER_REMOVE_LIST.filter(item => item !== 'Expéditeur :')
    .map(s => escapeRegExp(s));
extraHeaderRxItems.unshift('Expéditeur\\s*:');
const extraHeaderRegex = new RegExp(`^[\\s\\u00A0]*(${extraHeaderRxItems.join('|')})`, 'i');

type MailBlock = {
    type: 'mail';
    text: string;
};
function isLonelyStarterLine(line: string): boolean {
    return lonelyStarterRx.test(line);
}
function isInlineMailStartLine(line: string): boolean {
    return inlineStarterRx.test(line) && line.includes('<');
}
function isExtraHeaderLine(line: string): boolean {
    return extraHeaderRegex.test(line);
}

// ==========修复2：签名检测 前缀≤5字符 + 尾部≤12字符==========
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

// ==========工具：判断一行是不是横线分割线（覆盖所有常见HR转文本字符）==========
function isHorizontalRuleLine(line: string): boolean {
    const trimmed = line.trim();
    if(trimmed.length < 5) return false;
    const firstChar = trimmed[0];
    // 常见横线字符：减号、等号、下划线、全角破折号、长破折号、波浪线
    if(!['-','=','_','—','―','~'].includes(firstChar)) return false;
    // 该行90%以上都是同一个字符，判定为横线
    let sameCount = 0;
    for(const ch of trimmed){
        if(ch === firstChar) sameCount++;
    }
    return sameCount / trimmed.length >= 0.9;
}

function splitPreserveNewline(text: string): Array<{ line: string; raw: string }> {
    const result: Array<{ line: string; raw: string }> = [];
    if (text.length === 0) return result;
    // NBSP不间断空格清理
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

function splitMailBlocks(threadText: string): MailBlock[] {
    console.debug('[splitMailBlocks] input length:', threadText.length);
    const rawLines = splitPreserveNewline(threadText);
    const blocks: string[][] = [];
    let currentBlock: string[] | null = null;
    let pendingStarterRaw: string | null = null;

    for (const item of rawLines) {
        const textLine = item.line;

        // ==========修复3：全字符横线防御，跳过所有分割检测==========
        if (isHorizontalRuleLine(textLine)) {
            if (currentBlock === null) {
                currentBlock = [item.raw];
            } else {
                currentBlock.push(item.raw);
            }
            pendingStarterRaw = null;
            continue;
        }

        // ---------- 情况A：上一行缓存了孤立starter ----------
        if (pendingStarterRaw !== null) {
            if (textLine.includes('<')) {
                if (currentBlock !== null && currentBlock.length > 0) {
                    blocks.push(currentBlock);
                }
                currentBlock = [];
                currentBlock.push(pendingStarterRaw);
                currentBlock.push(item.raw);
                pendingStarterRaw = null;
            } else {
                if (currentBlock === null) {
                    currentBlock = [pendingStarterRaw, item.raw];
                } else {
                    currentBlock.push(pendingStarterRaw);
                    currentBlock.push(item.raw);
                }
                pendingStarterRaw = null;
            }
            continue;
        }
        // ---------- 情况B：本行就是完整单行分割头 ----------
        if (isInlineMailStartLine(textLine)) {
            if (currentBlock !== null && currentBlock.length > 0) {
                blocks.push(currentBlock);
            }
            currentBlock = [item.raw];
            continue;
        }
        // ---------- 情况C：命中孤立 From:/De:，先缓存，看下一行 ----------
        if (isLonelyStarterLine(textLine)) {
            pendingStarterRaw = item.raw;
            continue;
        }
        // ---------- 普通文本行 ----------
        if (currentBlock === null) {
            currentBlock = [item.raw];
        } else {
            currentBlock.push(item.raw);
        }
    }
    // 循环结束，残留未匹配的孤立starter，归入当前邮件块
    if (pendingStarterRaw !== null) {
        if (currentBlock === null) {
            currentBlock = [pendingStarterRaw];
        } else {
            currentBlock.push(pendingStarterRaw);
        }
    }
    if (currentBlock !== null && currentBlock.length > 0) {
        blocks.push(currentBlock);
    }
    // 组装结果，全部为 mail 块
    const result: MailBlock[] = blocks
        .map(b => b.join(''))
        .filter(mailText => mailText.trim().length > 0)
        .map(text => ({ type: 'mail', text }));
    // 兜底：零分割标记，全文当做一封邮件
    if (result.length === 0 && threadText.trim().length > 0) {
        console.debug('[splitMailBlocks] fallback‑all‑to‑mail');
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

export function cleanThreadEmails(bodytext: string, removeSignature = true): string {
    if (!bodytext) return bodytext;
    const blocks = splitMailBlocks(bodytext);
    const cleaned: string[] = [];
    // 头部区块最大行数保护，防止无限删正文
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

            // ==========修复4：头部区块退出条件 + 行数兜底==========
            if (insideHeaderBlock) {
                headerLineCount++;
                // 退出条件：空白行 / 横线 / 超过最大行数
                if (line.trim() === '' || isHorizontalRuleLine(line) || headerLineCount >= MAX_HEADER_LINES) {
                    insideHeaderBlock = false;
                    headerLineCount = 0;
                    outLines.push(item.raw);
                    continue;
                }
                continue;
            }

            if (isInlineMailStartLine(line) || isLonelyStarterLine(line)) {
                outLines.push(item.raw);
                continue;
            }
            // 命中头部字段，开启头部区块
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


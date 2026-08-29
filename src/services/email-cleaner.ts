// ===== 先定义工具函数 =====
function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ===== 常量定义 =====
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
    'Regards,',
    'Best regards,',
    'Kind regards,',
    'Thanks,',
    'Thank you,',
    'Thank you very much,',
    'Sincerely,',
    'Best,',
    'Cheers,',
    'Mit freundlichen Grüßen',
    'Viele Grüße',
    'Liebe Grüße',
    'Cordialement,',
    'Bien à vous,',
    'Merci,',
    'Saludos,',
    'Atentamente,',
    'Muchas gracias,',
    'Atenciosamente,',
    'Saudações,',
    'Obrigado,',
    'Cordiali saluti,',
    'Grazie,',
    'С уважением,',
    'Спасибо,',
    'よろしくお願いいたします。',
    '宜しくお願い致します。',
    '감사합니다.',
    '顺颂商祺',
    '祝好',
    '此致',
    '敬礼',
    '祝工作顺利',
    '祝万事如意',
    'Angelina Liu'
];

const blockStartRegex = new RegExp(`^\\s*(${THREAD_BLOCK_STARTERS.map(s=>escapeRegExp(s)).join('|')})`, 'i');
const extraHeaderRegex = new RegExp(`^\\s*(${HEADER_REMOVE_LIST.map(s=>escapeRegExp(s)).join('|')})`, 'i');

// ===== 类型定义 =====
type MailBlock = {
    type: 'prefix' | 'mail';
    text: string;
};

// ===== 辅助判断函数 =====
function isBlockStartLine(line: string): boolean {
    return blockStartRegex.test(line);
}
function isExtraHeaderLine(line: string): boolean {
    return extraHeaderRegex.test(line);
}
function lineTriggerSignature(line: string): boolean {
    const lower = line.toLowerCase();
    return SIGNATURE_TRIGGERS.some(keyword => lower.includes(keyword.toLowerCase()));
}

/**
 * 工具函数：分割文本，同时保留每行原始换行符 \r\n / \n
 */
function splitPreserveNewline(text: string): Array<{ line: string; raw: string }> {
    const result: Array<{ line: string; raw: string }> = [];
    if (text.length === 0) return result;

    let pos = 0;
    while (pos < text.length) {
        const nlIndex = text.indexOf('\n', pos);
        if (nlIndex === -1) {
            const lineContent = text.slice(pos);
            result.push({
                line: lineContent,
                raw: lineContent
            });
            break;
        }
        const isCrLf = nlIndex > 0 && text[nlIndex - 1] === '\r';
        const lineEnd = isCrLf ? nlIndex - 1 : nlIndex;
        const lineContent = text.slice(pos, lineEnd);
        const newlineStr = isCrLf ? '\r\n' : '\n';
        result.push({
            line: lineContent,
            raw: lineContent + newlineStr
        });
        pos = nlIndex + 1;
    }
    return result;
}

/**
 * 切割邮件块，返回带类型标记的块数组
 * prefix：第一个From之前的前置内容，原样保留不清洗
 * mail：标准From开头邮件块，执行header、签名过滤
 */
function splitMailBlocks(threadText: string): MailBlock[] {
    const rawLines = splitPreserveNewline(threadText);
    const blocks: string[][] = [];
    let preBuffer: string[] = [];
    let currentBlock: string[] | null = null;

    for (const item of rawLines) {
        const textLine = item.line;
        if (currentBlock === null) {
            if (isBlockStartLine(textLine)) {
                currentBlock = [];
                currentBlock.push(item.raw);
            } else {
                preBuffer.push(item.raw);
            }
        } else {
            if (isBlockStartLine(textLine)) {
                if (currentBlock.length > 0) {
                    blocks.push(currentBlock);
                }
                currentBlock = [];
                currentBlock.push(item.raw);
            } else {
                currentBlock.push(item.raw);
            }
        }
    }
    if (currentBlock !== null && currentBlock.length > 0) {
        blocks.push(currentBlock);
    }

    const result: MailBlock[] = [];
    const preStr = preBuffer.join('');
    if (preStr.trim().length > 0) {
        result.push({ type: 'prefix', text: preStr });
    }
    for (const b of blocks) {
        const mailText = b.join('');
        if (mailText.trim().length > 0) {
            result.push({ type: 'mail', text: mailText });
        }
    }
    return result;
}

/**
 * 截取邮件线程：保留最新邮件 + keepReplies层历史回复
 */
export function buildThreadBodyText(bodytext: string, keepReplies: number): string {
    const blocks = splitMailBlocks(bodytext);
    if (blocks.length === 0) return bodytext;
    const safeKeep = Math.max(0, keepReplies);
    const takeCount = 1 + safeKeep;
    const selectedBlocks = blocks.slice(0, takeCount);
    return selectedBlocks.map(b => b.text).join('');
}

/**
 * 清洗线程文本：块之间完全隔离，prefix‑块原样输出不经过任何过滤
 */
export function cleanThreadEmails(bodytext: string, removeSignature = true): string {
    const blocks = splitMailBlocks(bodytext);
    const cleaned: string[] = [];

    for (const block of blocks) {
        if (block.type === 'prefix') {
            // 前置块：原样输出，完全跳过header删除、签名截断，零过滤
            cleaned.push(block.text);
            continue;
        }

        // 标准邮件块：独立清洗，每个块拥有独立的signatureHit，绝不跨块污染
        const rawLines = splitPreserveNewline(block.text);
        const outLines: string[] = [];
        let signatureHit = false;

        for (const item of rawLines) {
            if (signatureHit) continue;
            const line = item.line;
            if (isBlockStartLine(line)) {
                outLines.push(item.raw);
                continue;
            }
            if (isExtraHeaderLine(line)) {
                continue;
            }
            if (removeSignature && lineTriggerSignature(line)) {
                signatureHit = true;
                continue;
            }
            outLines.push(item.raw);
        }
        cleaned.push(outLines.join(''));
    }

    return cleaned.join('');
}


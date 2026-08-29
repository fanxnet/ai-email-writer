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

const starterRx = new RegExp(`^[\\s\\u00A0]*(${THREAD_BLOCK_STARTERS.map(s=>escapeRegExp(s)).join('|')})`, 'i');
const extraHeaderRegex = new RegExp(`^[\\s\\u00A0]*(${HEADER_REMOVE_LIST.map(s=>escapeRegExp(s)).join('|')})`, 'i');

type MailBlock = {
    type: 'prefix' | 'mail';
    text: string;
};

/**
 * 判断一行是否为邮件分割起点（预处理合并完成后，From:/De: 与邮箱在同一行）
 */
function isMailBlockStartLine(line: string): boolean {
    return starterRx.test(line) && line.includes('<');
}

function isExtraHeaderLine(line: string): boolean {
    return extraHeaderRegex.test(line);
}

function lineTriggerSignature(line: string): boolean {
    const lower = line.toLowerCase();
    return SIGNATURE_TRIGGERS.some(keyword => lower.includes(keyword.toLowerCase()));
}

function splitPreserveNewline(text: string): Array<{ line: string; raw: string }> {
    const result: Array<{ line: string; raw: string }> = [];
    if (text.length === 0) return result;
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
    let preBuffer: string[] = [];
    let currentBlock: string[] | null = null;

    for (const item of rawLines) {
        const textLine = item.line;
        if (isMailBlockStartLine(textLine)) {
            if (currentBlock !== null && currentBlock.length > 0) {
                blocks.push(currentBlock);
            }
            currentBlock = [item.raw];
            continue;
        }
        if (currentBlock === null) {
            preBuffer.push(item.raw);
        } else {
            currentBlock.push(item.raw);
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
    if (result.length === 0 && threadText.trim().length > 0) {
        console.debug('[splitMailBlocks] fallback‑all‑to‑prefix');
        result.push({ type: 'prefix', text: threadText });
    }
    console.debug('[splitMailBlocks] blocks count =', result.length);
    return result;
}

export function buildThreadBodyText(bodytext: string, keepReplies: number): string {
    const blocks = splitMailBlocks(bodytext);
    if (blocks.length === 0) return bodytext;
    const prefixBlocks = blocks.filter(b => b.type === 'prefix');
    const mailBlocks = blocks.filter(b => b.type === 'mail');
    const safeKeep = Math.max(0, keepReplies);
    const takeCount = 1 + safeKeep;
    const selectedMails = mailBlocks.slice(0, takeCount);
    return [...prefixBlocks, ...selectedMails].map(b => b.text).join('');
}

export function cleanThreadEmails(bodytext: string, removeSignature = true): string {
    if (!bodytext) return bodytext;
    const blocks = splitMailBlocks(bodytext);
    const cleaned: string[] = [];

    for (const block of blocks) {
        if (block.type === 'prefix') {
            cleaned.push(block.text);
            continue;
        }
        const rawLines = splitPreserveNewline(block.text);
        const outLines: string[] = [];
        let signatureHit = false;
        for (const item of rawLines) {
            if (signatureHit) continue;
            const line = item.line;
            if (isMailBlockStartLine(line)) {
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
        cleaned.push(outLines.length ? outLines.join('') : block.text);
    }

    const finalResult = cleaned.join('');
    return finalResult.length ? finalResult : bodytext;
}


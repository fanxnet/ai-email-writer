// ===== 先定义工具函数 =====
function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// ===== 常量定义 =====
/**
 * 多语种：邮件回复块起始标记（From类头部）
 * 覆盖：英 / 中 / 德 / 法 / 西 / 葡 / 意 / 俄 / 日 / 韩
 */
const THREAD_BLOCK_STARTERS = [
    'From:',
    'Von:',          // 德语
    'De:',           // 法语、西班牙语
    '发件人：',      // 中文 Outlook
    'Sender:',       // 英文备选
    'Expéditeur :',  // 法语
    'Remitente:',    // 西班牙语
    'Remetente:',    // 葡萄牙语
    'Mittente:',     // 意大利语
    'От:',           // 俄语
    '差出人：',      // 日语
    '보낸 사람:'     // 韩语
];
/**
 * 需要删除的邮件头前缀列表（多语种）
 * Subject / To / Cc / Date / Sent 各国语言头部
 */
const HEADER_REMOVE_LIST = [
    // 英文
    'Subject:',
    'To:',
    'Cc:',
    'Sent:',
    'Date:',
    // 德语
    'Betreff:',
    'An:',
    'Kopie:',
    'Gesendet:',
    'Datum:',
    // 法语
    'Objet :',
    'À :',
    'Cc :',
    'Envoyé :',
    'Date :',
    // 西班牙语
    'Asunto:',
    'Para:',
    'Copia:',
    'Enviado:',
    'Fecha:',
    // 葡萄牙语
    'Assunto:',
    'Para:',
    'Cópia:',
    'Enviado:',
    'Data:',
    // 意大利语
    'Oggetto:',
    'A:',
    'Cc:',
    'Inviato:',
    'Data:',
    // 俄语
    'Тема:',
    'Кому:',
    'Копия:',
    'Отправлено:',
    'Дата:',
    // 日语
    '件名：',
    '宛先：',
    'Cc：',
    '送信日時：',
    '日付：',
    // 韩语
    '제목:',
    '받는 사람:',
    '참조:',
    '보낸 시간:',
    '날짜:',
    // 中文
    '主题：',
    '收件人：',
    '抄送：',
    '发送时间：',
    '日期：'
];
/**
 * 多语种签名截断关键词，命中后删除该行至本邮件块末尾
 */
const SIGNATURE_TRIGGERS = [
    // English
    'Regards,',
    'Best regards,',
    'Kind regards,',
    'Thanks,',
    'Thank you,',
    'Thank you very much,',
    'Sincerely,',
    'Best,',
    'Cheers,',
    // 德语
    'Mit freundlichen Grüßen',
    'Viele Grüße',
    'Liebe Grüße',
    // 法语
    'Cordialement,',
    'Bien à vous,',
    'Merci,',
    // 西班牙语
    'Saludos,',
    'Atentamente,',
    'Muchas gracias,',
    // 葡萄牙语
    'Atenciosamente,',
    'Saudações,',
    'Obrigado,',
    // 意大利语
    'Cordiali saluti,',
    'Grazie,',
    // 俄语
    'С уважением,',
    'Спасибо,',
    // 日语
    'よろしくお願いいたします。',
    '宜しくお願い致します。',
    // 韩语
    '감사합니다.',
    // 中文
    '顺颂商祺',
    '祝好',
    '此致',
    '敬礼',
    '祝工作顺利',
    '祝万事如意',
    // 自定义
    'Angelina Liu'
];
// 构建正则（此时 escapeRegExp 已定义）
const blockStartRegex = new RegExp(`^\\s*(${THREAD_BLOCK_STARTERS.map(s=>escapeRegExp(s)).join('|')})`, 'i');
const extraHeaderRegex = new RegExp(`^\\s*(${HEADER_REMOVE_LIST.map(s=>escapeRegExp(s)).join('|')})`, 'i');
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
// ===== 核心处理函数 =====
/**
 * 工具函数：分割文本，同时保留每行原始换行符 \r\n / \n
 * 修复：废弃/g正则循环，消除死循环、invalid‑array‑length报错
 */
function splitPreserveNewline(text: string): Array<{ line: string; raw: string }> {
    const result: Array<{ line: string; raw: string }> = [];
    if (text.length === 0) return result;

    let pos = 0;
    while (pos < text.length) {
        // 查找下一处换行位置
        const nlIndex = text.indexOf('\n', pos);
        if (nlIndex === -1) {
            // 剩余最后一行，无换行
            const lineContent = text.slice(pos);
            result.push({
                line: lineContent,
                raw: lineContent
            });
            break;
        }
        // 判断是否 \r\n
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
 * 切割邮件块，保留原始换行符与原文格式，只做拆分不修改内容
 */
function splitMailBlocks(threadText: string): string[] {
    const rawLines = splitPreserveNewline(threadText);
    const blocks: string[][] = [];
    let currentBlock: string[] = [];
    for (const item of rawLines) {
        const textLine = item.line;
        if (isBlockStartLine(textLine)) {
            if (currentBlock.length > 0) {
                blocks.push(currentBlock);
                currentBlock = [];
            }
            currentBlock.push(item.raw);
        } else {
            currentBlock.push(item.raw);
        }
    }
    if (currentBlock.length > 0) {
        blocks.push(currentBlock);
    }
    return blocks.map(b => b.join(''));
}

/**
 * 截取邮件线程：保留最新邮件 + keepReplies层历史回复
 * @param bodytext 原始邮件纯文本（经 emailHtmlToText 转换后的完整线程）
 * @param keepReplies 需要保留往上多少层历史回复
 * @returns 截取后的线程文本（格式与输入完全一致，仅裁切块数）
 */
export function buildThreadBodyText(bodytext: string, keepReplies: number): string {
    const blocks = splitMailBlocks(bodytext);
    if (blocks.length === 0) return bodytext;
    const safeKeep = Math.max(0, keepReplies);
    const takeCount = 1 + safeKeep;
    const selectedBlocks = blocks.slice(0, takeCount);
    // 直接拼接，不添加额外分隔符，保留原始格式
    return selectedBlocks.join('').trimEnd();
}

/**
 * 清洗线程文本：只保留From类头部，删除其余邮件头；移除邮件签名（从特征词如"regards"开始到本邮件结束全部删除）
 * @param bodytext buildThreadBodyText 输出文本
 * @param removeSignature 是否开启签名删除，默认true
 * @returns 清洗后的文本（格式不变，仅删除指定内容）
 */
export function cleanThreadEmails(bodytext: string, removeSignature = true): string {
    const blocks = splitMailBlocks(bodytext);
    const cleanedBlocks: string[] = [];

    for (const block of blocks) {
        const rawLines = splitPreserveNewline(block);
        const outLines: string[] = [];
        let signatureHit = false;
        for (const item of rawLines) {
            if (signatureHit) continue;
            const line = item.line;
            // From‑头部行 → 保留
            if (isBlockStartLine(line)) {
                outLines.push(item.raw);
                continue;
            }
            // 多余邮件头 → 跳过删除
            if (isExtraHeaderLine(line)) {
                continue;
            }
            // 签名命中，开启截断标记
            if (removeSignature && lineTriggerSignature(line)) {
                signatureHit = true;
                continue;
            }
            outLines.push(item.raw);
        }
        cleanedBlocks.push(outLines.join(''));
    }
    // 直接拼接，不添加额外分隔符
    return cleanedBlocks.join('').trimEnd();
}


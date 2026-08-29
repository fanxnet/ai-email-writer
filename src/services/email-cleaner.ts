/**
 * AI Compose — Email bodytext Cleaner
 *
 * 多语种：邮件回复块起始标记（From类头部）
 */
const THREAD_BLOCK_STARTERS = [
    'From:',
    'Von:',
    'De:',
    '发件人：',
    'Sender:',
    'Expéditeur :',
    'Remitente:'
];

/**
 * 需要删除的邮件头前缀列表（多语种）
 */
const HEADER_REMOVE_LIST = [
    'Subject:',
    'Betreff:',
    'Objet :',
    '主题：',
    'To:',
    'An:',
    'À :',
    '收件人：',
    'Cc:',
    'Kopie:',
    'Cc :',
    '抄送：',
    'Sent:',
    'Gesendet:',
    'Envoyé :',
    '发送时间：',
    'Date:',
    'Datum:',
    'Date :',
    '日期：'
];

/**
 * 多语种签名截断关键词，命中后删除该行至本邮件块末尾
 */
const SIGNATURE_TRIGGERS = [
    // English
    'Regards,',
    'Best regards,',
    'Thanks,',
    'Thank you,',
    'Sincerely,',
    // 德语
    'Mit freundlichen Grüßen',
    // 法语
    'Cordialement,',
    // 中文
    '顺颂商祺',
    '祝好',
    '此致',
    '敬礼'
];

/**
 * 判断一行文本是否为邮件块起始行(From/发件人：...)
 */
function isBlockStartLine(line: string): boolean {
    const trimmed = line.trimStart();
    return THREAD_BLOCK_STARTERS.some(starter =>
        trimmed.toLowerCase().startsWith(starter.toLowerCase())
    );
}

/**
 * 判断一行是否属于待删除的多余邮件头
 */
function isExtraHeaderLine(line: string): boolean {
    const trimmed = line.trimStart();
    return HEADER_REMOVE_LIST.some(prefix =>
        trimmed.toLowerCase().startsWith(prefix.toLowerCase())
    );
}

/**
 * 判断该行命中签名截断关键词（不区分大小写）
 */
function lineTriggerSignature(line: string): boolean {
    const lower = line.toLowerCase();
    return SIGNATURE_TRIGGERS.some(keyword => lower.includes(keyword.toLowerCase()));
}

/**
 * 将完整线程纯文本，切割成一封一封邮件块数组
 * @param threadText emailHtmlToText输出结果（每封邮件均以From‑头部开头）
 */
function splitMailBlocks(threadText: string): string[] {
    const lines = threadText.split(/\r?\n/);
    const blocks: string[][] = [];

    for (const line of lines) {
        if (isBlockStartLine(line)) {
            blocks.push([line]);
        } else if (blocks.length > 0) {
            blocks[blocks.length - 1].push(line);
        }
    }
    return blocks.map(b => b.join('\n'));
}

/**
 * 截取邮件线程：保留最新邮件 + keepReplies层历史回复
 * @param bodytext 原始邮件HTML
 * @param keepReplies 需要保留往上多少层历史回复
 * @returns 截取后的线程文本
 */
export function buildThreadBodyText(bodytext: string, keepReplies: number): string {
    const blocks = splitMailBlocks(bodytext);

    if (blocks.length === 0) return bodytext;

    // 负数保护：最多只保留最新一封
    const safeKeep = Math.max(0, keepReplies);
    const takeCount = 1 + safeKeep;

    const selectedBlocks = blocks.slice(0, takeCount);
    return selectedBlocks.join('\n\n').trim();
}

/**
 * 清洗线程文本：只保留From类头部，删除其余邮件头；移除邮件签名
 * @param bodyText buildThreadBodyText输出文本
 * @param removeSignature 是否开启签名删除，默认true
 */
export function cleanThreadEmails(bodyText: string, removeSignature = true): string {
    const blocks = splitMailBlocks(bodyText);
    const cleanedBlocks: string[] = [];

    for (const block of blocks) {
        const lines = block.split(/\r?\n/);
        const outLines: string[] = [];
        let signatureHit = false;

        for (const line of lines) {
            if (signatureHit) continue;

            // From‑头部行 → 保留
            if (isBlockStartLine(line)) {
                outLines.push(line);
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
            outLines.push(line);
        }
        cleanedBlocks.push(outLines.join('\n'));
    }

    return cleanedBlocks.join('\n\n').trim();
}


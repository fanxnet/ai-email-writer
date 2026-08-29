/**
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
    'Regards,',
    'Best regards,',
    'Thanks,',
    'Thank you,',
    'Sincerely,',
    'Mit freundlichen Grüßen',
    'Cordialement,',
    '顺颂商祺',
    '祝好',
    '此致',
    '敬礼',
    'Angelina Liu',
];

// 构建正则：邮件块起始锚点 (不区分大小写)
const blockStartRegex = new RegExp(`^\\s*(${THREAD_BLOCK_STARTERS.map(s=>escapeRegExp(s)).join('|')})`, 'i');

// 多余头部字段正则
const extraHeaderRegex = new RegExp(`^\\s*(${HEADER_REMOVE_LIST.map(s=>escapeRegExp(s)).join('|')})`, 'i');

function escapeRegExp(str:string):string{
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
function splitPreserveNewline(text: string): Array<{line: string, raw: string}> {
    const result: Array<{line: string, raw: string}> = [];
    const regex = /([^\r\n]*)(\r?\n|$)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
        const content = match[1];
        const newline = match[2];
        result.push({
            line: content,
            raw: content + newline
        });
    }
    return result;
}

/**
 * 切割邮件块，保留原始换行符
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

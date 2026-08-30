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
    '祝万事如意'
];
const SIGNATURE_NAMES = [
    'Angelina Liu'
];

const starterKeywords = THREAD_BLOCK_STARTERS.map(s=>escapeRegExp(s)).join('|');
const mailStartRx = new RegExp(`^[\\s\\u00A0]*(${starterKeywords})`, 'i');

// ==========修复1：通用头部正则构建，自动兼容全角/半角冒号、冒号前空格==========
function buildHeaderRegex(items: string[]): RegExp {
    const patterns = items.map(item => {
        // 提取纯标签，去掉末尾的冒号和空格
        const label = item.replace(/\s*[：:]\s*$/, '');
        const escapedLabel = escapeRegExp(label);
        // 标签 + 可选空格 + 全角/半角冒号
        return `${escapedLabel}\\s*[：:]`;
    });
    return new RegExp(`^[\\s\\u00A0]*(${patterns.join('|')})`, 'i');
}
const extraHeaderRegex = buildHeaderRegex(HEADER_REMOVE_LIST);

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

// 签名检测：Dear豁免 + 普通词前缀≤5 + 人名强制行首
function lineTriggerSignature(line: string): boolean {
    if (!line) return false;
    const trimmed = line.trim();
    if (trimmed.length === 0) return false;
    const MAX_SIGNATURE_LINE = 30;
    if (trimmed.length > MAX_SIGNATURE_LINE) return false;
    if (trimmed.includes('?')) return false;

    const lowerLine = trimmed.toLowerCase();
    // Dear开头的称呼行直接豁免
    if (lowerLine.startsWith('dear ')) return false;

    const MAX_PREFIX = 5;
    const MAX_TAIL_CHARS = 12;

    // 普通问候语关键词
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

    // 人名类关键词强制行首匹配
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

// 通用横线判断
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
        const lineEnd = isCrLf ? nlIndex - 1 : nl;
        const lineContent = text.slice(pos, lineEnd);
        const newlineStr = isCrLf ? '\r\n' : '\n';
        result.push({ line: lineContent, raw: lineContent + newlineStr });
        pos = nlIndex + 1;
    }
    return result;
}

// 前瞻邮箱校验
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

// 分割阶段：From‑From + 3行前瞻校验
function splitMailBlocks(threadText: string): MailBlock[] {
    console.debug('[splitMailBlocks] input length:', threadText.length);
    const rawLines = splitPreserveNewline(threadText);
    const blocks: string[][] = [];
    let currentBlock: string[] | null = null;
    const MAX_LOOK_AHEAD = 3;

    for (let i = 0; i < rawLines.length; i++) {
        const item = rawLines[i];
        const textLine = item.line;

        // 横线防御
        if (isHorizontalRuleLine(textLine)) {
            if (currentBlock === null) currentBlock = [];
            currentBlock.push(item.raw);
            continue;
        }

        // 发件标记 + 前瞻邮箱校验
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

        // 普通内容行
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
    text = text.replace(/\u00A0/g, ' ');
    return text.replace(/(\r?\n)(\s*\1)+/g, '$1$1');
}

// ==========修复2：优化头部区块逻辑，精准清理不删正文==========
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

            if (insideHeaderBlock) {
                headerLineCount++;
                // 强制退出：空行、横线、超最大行数
                if (line.trim() === '' || isHorizontalRuleLine(line) || headerLineCount >= MAX_HEADER_LINES) {
                    insideHeaderBlock = false;
                    headerLineCount = 0;
                    outLines.push(item.raw);
                    continue;
                }
                // 仍在头部范围内：是头部标签 或 包含邮箱< → 继续删除
                if (isExtraHeaderLine(line) || line.includes('<')) {
                    continue;
                }
                // 其他情况：遇到正文，立刻退出，保留本行
                insideHeaderBlock = false;
                headerLineCount = 0;
                outLines.push(item.raw);
                continue;
            }

            // 发件人行保留
            if (isMailStartLine(line)) {
                outLines.push(item.raw);
                continue;
            }
            // 命中头部字段，开启头部区块，删除本行
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


const THREAD_BLOCK_STARTERS = [
    'From:',
    'Von:',
    'De:',
    '发件人：',
    '发件人:',
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
    '主题：', '主题:', '收件人：', '收件人:', '抄送：', '抄送:', '发送时间：', '发送时间:', '日期：', '日期:',
    'Enviada em:'
];
const SIGNATURE_TRIGGERS = [
    'Best regards',
    'Kind regards',
    'Regards',
    'Best Wishes',
    'Wishes',
    'Thanks',
    'Thank you',
    'Sincerely',
    'Mit freundlichen Grüßen',
    'Saludos',
    'Saludos cordiales',
    'Atentamente',
    'Atenciosamente',
    'atencionalmente',
    'Salutos',
    'Viele Grüße',
    'Liebe Grüße',
    'Cordialement',
    'Bien à vous',
    'Merci',
    'Muchas gracias',
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
    'Tks',
    'Tks and B. Rgds',
    'Tks & B rgds',
    'Tks n rgds',
    'BRgds',
    
];

const SIGNATURE_NAMES = [
    'Angelina Liu',
    'Excited to work on this',
    'Thank you so much,
    'Thank you very much,
];

const starterKeywords = THREAD_BLOCK_STARTERS.map(s=>escapeRegExp(s)).join('|');
const mailStartRx = new RegExp(`^[\\s\\u00A0]*(${starterKeywords})`, 'i');

const extraHeaderRxItems = HEADER_REMOVE_LIST.filter(item => item !== 'Expéditeur :')
    .map(s => escapeRegExp(s));
extraHeaderRxItems.unshift('Expéditeur\\s*:');
const extraHeaderRegex = new RegExp(`^[\\s\\u00A0]*(${extraHeaderRxItems.join('|')})`, 'i');

// ===== 新增：多语种主题终止正则，兼容中英文、全角/半角冒号 =====
const subjectRx = /^\s*(subject|主题)\s*[:：]/i;

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

// 长词优先，保留原始大小写；/i 负责忽略大小写匹配
const salutePattern = SIGNATURE_TRIGGERS
    .map(escapeRegExp)
    .join('|');

// 移除 \b 单词边界！解决葡萄牙语、德语重音字符匹配失败
const multiSaluteRx = new RegExp(
    `(${salutePattern})\\s*(?:\\/|&)\\s*(${salutePattern})\\s*[,.!~;]?$`,
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
    const MAX_TAIL_CHARS = 8;

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
            if (tailLength <= 2) {
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
        for(let j=0;j<rawLines.length;j++){
            if(isMailStartLine(rawLines[j].line)){
                fromIndex = j;
                break;
            }
        }

        let foundSubjectWithinLimit = false;
        let subjectLineIndex = -1;
        if(fromIndex !== -1){
            // 在发件人行之后最多扫描20行查找主题标记
            const scanEnd = Math.min(fromIndex + MAX_HEADER_LINES, rawLines.length - 1);
            for(let j = fromIndex + 1; j <= scanEnd; j++){
                if(subjectRx.test(rawLines[j].line)){
                    foundSubjectWithinLimit = true;
                    subjectLineIndex = j;
                    break;
                }
            }
        }

        if(fromIndex !== -1 && foundSubjectWithinLimit && subjectLineIndex > fromIndex){
            // 优先分支生效：保留发件人行，发件人+1 ~ 主题行全部丢弃
            for(let j=0;j<rawLines.length;j++){
                if(signatureHit) continue;
                const item = rawLines[j];
                if(j === fromIndex){
                    outLines.push(item.raw);
                    continue;
                }
                // 发件人与主题之间的头部直接跳过
                if(j > fromIndex && j <= subjectLineIndex){
                    continue;
                }
                // 正文区开始，执行签名过滤
                if (removeSignature && lineTriggerSignature(item.line)) {
                    signatureHit = true;
                    continue;
                }
                outLines.push(item.raw);
            }
        }else{
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


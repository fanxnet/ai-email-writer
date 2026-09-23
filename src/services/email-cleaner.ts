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

        // ========== 新增：跨行header预合并，用于header识别判断，不修改输出原文 ==========
        type MergedLineItem = {
            originalIndices: number[], // 对应rawLines下标
            combinedText: string,      // 拼接后的文本，用于header检测
        };
        const mergedForDetect: MergedLineItem[] = [];
        let j = 0;
        while (j < rawLines.length) {
            const currLine = rawLines[j].line.trimEnd();
            // 如果当前行末尾无冒号，并且下一行存在，尝试拼接
            if (j + 1 < rawLines.length && !currLine.includes(':')) {
                const nextLine = rawLines[j + 1].line.trimStart();
                const combined = currLine + nextLine;
                // 拼接后命中header关键词，则合并
                if (HEADER_REMOVE_LIST.some(h => combined.toLowerCase().startsWith(h.toLowerCase()))) {
                    mergedForDetect.push({
                        originalIndices: [j, j + 1],
                        combinedText: combined
                    });
                    j += 2;
                    continue;
                }
            }
            // 不满足合并，单行保留
            mergedForDetect.push({
                originalIndices: [j],
                combinedText: rawLines[j].line
            });
            j += 1;
        }
        // ========== 跨行header预合并结束 ==========


        // ---------- 优先路径：扫描From/发件人 → Subject/主题，最多向后20行 ----------
        let fromIndex = -1;
        // 遍历合并后的行找From
        for(let mj=0;mj<mergedForDetect.length;mj++){
            if(isMailStartLine(mergedForDetect[mj].combinedText)){
                fromIndex = mj;
                break;
            }
        }
        let foundSubjectWithinLimit = false;
        let subjectMergedIndex = -1;
        if(fromIndex !== -1){
            const scanEnd = Math.min(fromIndex + MAX_HEADER_LINES, mergedForDetect.length - 1);
            for(let mj = fromIndex + 1; mj <= scanEnd; mj++){
                if(subjectRx.test(mergedForDetect[mj].combinedText)){
                    foundSubjectWithinLimit = true;
                    subjectMergedIndex = mj;
                    break;
                }
            }
        }

        if(fromIndex !== -1 && foundSubjectWithinLimit && subjectMergedIndex > fromIndex){
            // 优先分支：使用mergedForDetect判断哪些原始行要跳过
            const skipRawIndexSet = new Set<number>();
            for(let mj = fromIndex +1; mj <= subjectMergedIndex; mj++){
                for(const rawIdx of mergedForDetect[mj].originalIndices){
                    skipRawIndexSet.add(rawIdx);
                }
            }
            const fromRawIdx = mergedForDetect[fromIndex].originalIndices[0];

            for(let rIdx=0;rIdx<rawLines.length;rIdx++){
                if(signatureHit) continue;
                const item = rawLines[rIdx];
                if(rIdx === fromRawIdx){
                    outLines.push(item.raw);
                    continue;
                }
                if(skipRawIndexSet.has(rIdx)){
                    continue;
                }
                // 正文区，签名过滤
                if (removeSignature && lineTriggerSignature(item.line)) {
                    signatureHit = true;
                    continue;
                }
                outLines.push(item.raw);
            }
        }else{
            // ---------- 兜底降级：原有insideHeaderBlock方案，改成基于mergedForDetect识别header ----------
            let insideHeaderBlock = false;
            let headerLineCount = 0;
            let rawPtr = 0;
            for (const mItem of mergedForDetect) {
                if (signatureHit) break;
                const detectLine = mItem.combinedText;
                const rawIndices = mItem.originalIndices;
                const firstRawIdx = rawIndices[0];
                if (insideHeaderBlock) {
                    headerLineCount++;
                    if (subjectRx.test(detectLine)) {
                        insideHeaderBlock = false;
                        headerLineCount = 0;
                        // 这个合并行包含subject，全部原始行跳过
                        rawPtr += rawIndices.length;
                        continue;
                    }
                    const trimmed = detectLine.trim();
                    if (trimmed === '' || isHorizontalRuleLine(detectLine) || headerLineCount >= MAX_HEADER_LINES) {
                        insideHeaderBlock = false;
                        headerLineCount = 0;
                        // 退出header块，把当前行全部推入输出
                        for(const ri of rawIndices){
                            outLines.push(rawLines[ri].raw);
                        }
                        rawPtr += rawIndices.length;
                        continue;
                    }
                    // header内部，跳过
                    rawPtr += rawIndices.length;
                    continue;
                }
                if (isMailStartLine(detectLine)) {
                    // From行，全部原始行保留
                    for(const ri of rawIndices){
                        outLines.push(rawLines[ri].raw);
                    }
                    rawPtr += rawIndices.length;
                    continue;
                }
                if (isExtraHeaderLine(detectLine)) {
                    insideHeaderBlock = true;
                    headerLineCount = 1;
                    rawPtr += rawIndices.length;
                    continue;
                }
                // 正文，签名检测按原始单行
                for(const ri of rawIndices){
                    if(signatureHit) break;
                    const item = rawLines[ri];
                    if (removeSignature && lineTriggerSignature(item.line)) {
                        signatureHit = true;
                        continue;
                    }
                    outLines.push(item.raw);
                }
                rawPtr += rawIndices.length;
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


/**
 * AI Compose — Draft Reply Feature
 *
 * Orchestrates the "Draft a Reply" workflow:
 *   1. Auto-read the current email's body, subject, and sender.
 *   2. Collect reply instructions and tone from the user.
 *   3. Build a prompt from the REPLY_PROMPT template.
 *   4. Send to Gemini via generateText().
 *   5. Allow inserting the reply into the active compose window.
 *
 * © Rizonetech (Pty) Ltd. — https://rizonesoft.com
 */

/* global Office */

import { generateText } from '../services/ai-service';
import { buildPrompt, truncateContext } from '../prompts/builder';
import { REPLY_PROMPT } from '../prompts/templates';
import { getSetting, ReasoningMode, buildGoalText, buildRulesText, buildProfileText } from './settings';
import { extractTextStyleFromHtml, buildStyledBodyHtml } from '../services/style-extractor';
import {
  getCurrentEmailBodyHtml,
  getCurrentEmailSubject,
  getOriginalSender,
  getItemMode,
  emailHtmlToText,
  EmailContact,
} from '../services/outlook';
import { truncateHtmlThread } from '../services/thread-truncate';
import { getSessionKey } from './auto-save';
import {
  appendTurn,
  getConversation,
  getLastAssistantReply,
  rememberLastRequest,
} from './conversation-memory';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DraftReplyOptions {
  instructions: string;
  tone: string;
  includeOriginal: boolean;
  language?: string;
  reasoningMode?: ReasoningMode;
  goalText?: string;
  includeThread?: boolean;
}

export interface EmailContext {
  subject: string;
  body: string;
  bodyHtml?: string;
  sender: EmailContact;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max tokens of original email to include in the reply prompt. */
const MAX_CONTENT_TOKENS = 6000;

/**
 * How many most-recent messages to keep when the thread is truncated before
 * building the reply prompt (the current email plus the newest N-1 replies).
 */
const KEEP_REPLIES = 3;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let lastReplyOptions: DraftReplyOptions | null = null;
let lastReply: string = '';
let cachedContext: EmailContext | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the current email context (subject, body, sender).
 * Reads the raw HTML once and derives the plain-text body from it, so the
 * reply pipeline can re-process the HTML (thread truncation) without a second
 * Office round-trip. Caches the result to avoid re-reading for regenerate/refine.
 */
export async function loadEmailContext(): Promise<EmailContext> {
  const [bodyHtml, subject, sender] = await Promise.all([
    getCurrentEmailBodyHtml(),
    getCurrentEmailSubject(),
    getOriginalSender(),
  ]);

  cachedContext = {
    subject,
    body: emailHtmlToText(bodyHtml),
    bodyHtml,
    sender,
  };
  return cachedContext;
}

/**
 * Get the cached email context, or load it if needed.
 */
export async function getEmailContext(): Promise<EmailContext> {
  if (cachedContext) return cachedContext;
  return loadEmailContext();
}

/**
 * Clear the cached context (e.g. when switching emails).
 */
export function clearEmailContext(): void {
  cachedContext = null;
}

/**
 * Regex markers that indicate the start of quoted/replied history content.
 * Patterns do NOT consume trailing content — matching position is used to cut.
 * Header labels are localized for EN/ZH plus common European languages
 * (FR/DE/ES/IT/PT); a generic label:value block marker covers other languages.
 */
const QUOTE_MARKERS: RegExp[] = [
  // "wrote:" equivalents (Gmail / Apple Mail / localized clients)
  // EN: "On Mon, Jan 15, 2024 at 3:00 PM, Alice wrote:"
  // FR: "Le 15 janvier 2024 à 15:00, Alice a écrit :"
  // DE: "Am Montag, 15. Januar 2024 um 15:00 schrieb Alice:"
  /(?:On|Le|Am|El|Il|Em|在)\s+.{10,}?\s*(?:wrote|a écrit|schrieb|escribió|ha scritto|escreveu|写道)\s*[：:]/gi,
  // Multi-line From/Sent/To/Subject header block (localized labels)
  /^(?:From|发件人|De|Von|Da)\s*[：:][^\n]*\n(?:(?:To|收件人|À|An|Para|A|CC|Cc|抄送|Sent|发送时间|Envoyé le|Gesendet am|Enviado el|Inviato il|Enviada em|Date|日期|Datum|Fecha|Data|Importance|Wichtigkeit|Importancia|Importanza|Importância|Created|创建时间|Reply-To)\s*[：:][^\n]*\n)*(?:Subject|主题|Objet|Betreff|Asunto|Oggetto|Assunto)\s*[：:][^\n]*\n/gim,
  // Generic language-neutral fallback: 3+ consecutive "Label: value" lines
  // (same-line value, short lines) — catches languages not in the alias table.
  /^(?:[^\s:：]{1,30}[：:][ \t]+[^\n]{1,200}\n){3,}/gm,
  // Single-line compact format
  /^From:.*(?:Sent|发送时间):.*(?:To|收件人):.*(?:Subject|主题):.*$/gim,
  // Quoted-message separators (localized)
  /^-{3,}\s*(?:Original Message|Message d'origine|Ursprüngliche Nachricht|Mensaje original|Messaggio originale|Mensagem original|原始邮件|Forwarded message|Message transféré|Weitergeleitete Nachricht|Mensaje reenviado|Messaggio inoltrato|Mensagem encaminhada|转发的消息)\s*-{3,}/gi,
  /_{3,}\s*(?:Original Message|Message d'origine|Ursprüngliche Nachricht|Mensaje original|Messaggio originale|Mensagem original|原始邮件|Forwarded message|Message transféré|Weitergeleitete Nachricht|Mensaje reenviado|Messaggio inoltrato|Mensagem encaminhada|转发的消息)\s*_{3,}/gi,
  /-----+\s*(?:Original Message|Message d'origine|Ursprüngliche Nachricht|Mensaje original|Messaggio originale|Mensagem original|原始邮件)\s*-----+/gi,
];

/**
 * Find the index where quoted/history content starts.
 * Returns -1 when no quoted content is found, or when the only marker sits at
 * the very top of the body (e.g. a forwarded email that begins with a
 * "From:...Sent:...To:...Subject:..." block). Such a body is the message's own
 * content, so it is preserved rather than stripped.
 */
function findQuotedStart(text: string): number {
  let earliest = -1;
  for (const re of QUOTE_MARKERS) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m && text.slice(0, m.index).trim().length > 0) {
      if (earliest === -1 || m.index < earliest) {
        earliest = m.index;
      }
    }
  }
  return earliest;
}

/**
 * Filter quoted/replied content from email body text.
 * Handles Classic Outlook, Outlook Web, and Gmail quoted-content formats.
 * Exposed for unit testing.
 */
export function filterQuotedContent(text: string): string {
  let result = text;

  // 1) Remove standalone separator lines (underscores/dashes) — Classic Outlook
  result = result.replace(/^[_-]{3,}\s*$/gm, '\n');

  // 2) Merge header-label-only lines with the following value line
  //    "From:\nAlice" → "From: Alice" (language-neutral)
  result = result.replace(
    /^([^\s:：]{1,30})[：:]\s*\n(?=\S)/gim,
    '$1: '
  );

  // 3) Cut everything from the first quoted-content marker onward, but ONLY
  //    when the marker is preceded by real content (reply-email pattern).
  //    Markers at the very top (e.g. forwarded email) are preserved.
  const quoteStart = findQuotedStart(result);
  if (quoteStart > 0) {
    result = result.slice(0, quoteStart);
  }

  // 4) Remove "> " prefixed quoted lines (line-by-line, safe)
  result = result.replace(/^>.*$/gm, '');

  // 5) Clean up excessive blank lines
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

/**
 * Generate a reply to the current email.
 */
export async function generateReply(
  options: DraftReplyOptions,
  onStream?: (delta: string) => void,
): Promise<string> {
  if (!options.instructions || !options.instructions.trim()) {
    throw new Error('Please enter your reply instructions.');
  }

  const context = await getEmailContext();
  const sessionKey = getSessionKey();

  // Build the original email string for the prompt (pre-truncated for safety)
  let originalEmail = `From: ${context.sender.name} <${context.sender.email}>\n`;
  originalEmail += `Subject: ${context.subject}\n\n`;

  // Resolve the body to include based on the Thread toggle:
  // - Thread off (default): truncate the raw HTML to the newest KEEP_REPLIES
  //   messages first (structural, client-agnostic), then convert to text and
  //   run the text-level quoted-content filter as a secondary guard.
  // - Thread on: keep the full conversation, preserving quoted containers.
  let emailBody: string;
  if (options.includeThread) {
  // include Thread completely
  //     emailBody = emailHtmlToText(context.bodyHtml ?? '', { stripQuoted: false });
    const truncatedHtml = truncateHtmlThread(context.bodyHtml ?? '', 9);
    emailBody = filterQuotedContent(emailHtmlToText(truncatedHtml));
  } else {
    const truncatedHtml = truncateHtmlThread(context.bodyHtml ?? '', KEEP_REPLIES);
    emailBody = filterQuotedContent(emailHtmlToText(truncatedHtml));
  }

  originalEmail += emailBody;
  originalEmail = truncateContext(originalEmail, MAX_CONTENT_TOKENS);

  // Resolve language: 'auto' means match the original email's language
  let language: string;
  if (!options.language || options.language === 'auto') {
  language = 'the same language as the original email';
  } else {
  language = options.language;
  }


  // Build Goal, Profile, and Rules as separate prompt sections
  const goalText = options.goalText || '';
  const profileText = buildProfileText();
  const rulesText = buildRulesText();

  const prompt = buildPrompt(REPLY_PROMPT, {
    PROFILE: profileText,
    GOAL: goalText,
    ORIGINAL_EMAIL: originalEmail,
    REPLY_INSTRUCTIONS: options.instructions,
    TONE: options.tone || 'professional',
    LANGUAGE: language,
    REPLY_TO_NAME: context.sender.name || context.sender.email || 'the sender',
    RULES: rulesText,
  });

  const reply = await generateText(prompt, {
    temperature: 0.7,
    maxOutputTokens: 8192,
    reasoningMode: options.reasoningMode,
    onStream,
  });

  lastReplyOptions = { ...options };
  lastReply = reply;

  // Record the exchange for local storage only (not injected into prompts)
  appendTurn(sessionKey, 'user', options.instructions);
  appendTurn(sessionKey, 'assistant', reply);
  rememberLastRequest(sessionKey, {
    instructions: options.instructions,
    tone: options.tone || 'professional',
    includeOriginal: options.includeOriginal !== false,
    language: options.language,
    reasoningMode: options.reasoningMode,
  });

  return reply;
}

/**
 * Restore the most recent reply (and the request that produced it) from the
 * per-email conversation history. Used when the user returns to an email so
 * Insert / Regenerate / Refine work again after a reload.
 *
 * Returns `null` when the conversation has no reply to restore.
 */
export function restoreFromHistory(key: string): { reply: string; options: DraftReplyOptions } | null {
  const record = getConversation(key);
  if (record.entries.length === 0) return null;

  const reply = getLastAssistantReply(key);
  if (!reply) return null;

  const lastUser = [...record.entries].reverse().find((e) => e.role === 'user');
  const options: DraftReplyOptions = record.lastRequest
    ? {
        instructions: record.lastRequest.instructions,
        tone: record.lastRequest.tone || 'professional',
        includeOriginal: record.lastRequest.includeOriginal !== false,
        language: record.lastRequest.language || 'auto',
        reasoningMode: (record.lastRequest.reasoningMode as ReasoningMode) || 'off',
      }
    : {
        instructions: lastUser?.content || '',
        tone: 'professional',
        includeOriginal: true,
        language: 'auto',
        reasoningMode: 'off',
      };

  lastReply = reply;
  lastReplyOptions = { ...options };
  return { reply, options };
}

/**
 * Regenerate the last reply with the same inputs.
 */
export async function regenerateReply(onStream?: (delta: string) => void): Promise<string> {
  if (!lastReplyOptions) {
    throw new Error('No previous reply to regenerate. Please generate a reply first.');
  }
  return generateReply(lastReplyOptions, onStream);
}

/**
 * Refine the last generated reply with follow-up instructions.
 */
export async function refineReply(
  refinement: string,
  onStream?: (delta: string) => void,
): Promise<string> {
  if (!lastReply) {
    throw new Error('No reply to refine. Please generate a reply first.');
  }

  if (!refinement || !refinement.trim()) {
//    throw new Error('Please enter your refinement instructions.');
  if (!options.instructions || !options.instructions.trim()) {
    throw new Error('Please enter your refinement or reply instructions.');
  }
//  share reply instructions without refinement
    refinement = options.instructions;
  }

  const prompt = `You are a professional email assistant.
Requirements:
- Keep the same general format (without signature)
- Apply the requested changes while maintaining quality
- Return only the revised reply, no explanations

Here is the current draft reply:
---
${lastReply}
---

Please revise the draft reply based on these instructions:${refinement}`;

  const refined = await generateText(prompt, {
    temperature: 0.6,
    maxOutputTokens: 8192,
    reasoningMode: lastReplyOptions?.reasoningMode,
    onStream,
  });

  // Record the refinement round for local storage only
  const sessionKey = getSessionKey();
  appendTurn(sessionKey, 'user', refinement);
  appendTurn(sessionKey, 'assistant', refined);

  lastReply = refined;
  return refined;
}

/**
 * Insert the reply text into the currently active compose window.
 * Works when the user has already clicked Reply or Reply All in Outlook.
 */
export async function insertIntoReply(replyText: string): Promise<void> {
  const html = await buildReplyHtml(replyText);
  const mode = getItemMode();

  if (mode !== 'compose') {
    const item = Office.context.mailbox.item as any;
    if (item && typeof item.displayReplyForm === 'function') {
      item.displayReplyForm(html);
      return;
    }
    throw new Error('Cannot insert reply — no compose window is open. Please click Reply first.');
  }

  const item = Office.context.mailbox.item as any;
  if (item && item.body && typeof item.body.setAsync === 'function') {
    return new Promise((resolve, reject) => {
      item.body.setAsync(
        html,
        { coercionType: Office.CoercionType.Html },
        (result: Office.AsyncResult<void>) => {
          if (result.status === Office.AsyncResultStatus.Succeeded) {
            resolve();
          } else {
            reject(new Error(`Failed to insert reply: ${result.error?.message || 'Unknown error'}`));
          }
        },
      );
    });
  }
  throw new Error('Cannot insert reply — compose body is not accessible.');
}

/**
 * Open a Reply window for the current email with the generated text.
 * In compose mode: inserts the text directly into the active compose body.
 * In read mode: opens a Reply compose window via displayReplyForm.
 */
export async function openReply(replyText: string): Promise<void> {
  const html = await buildReplyHtml(replyText);
  const mode = getItemMode();
  const item = Office.context.mailbox.item as any;

  if (mode === 'compose') {
    if (item && item.body && typeof item.body.prependAsync === 'function') {
      item.body.prependAsync(html, { coercionType: Office.CoercionType.Html });
    } else {
      throw new Error('Cannot insert reply — compose body is not accessible.');
    }
  } else {
    if (item && typeof item.displayReplyForm === 'function') {
      item.displayReplyForm(html);
    } else {
      throw new Error('Cannot open reply window. Please make sure an email is selected.');
    }
  }
}

/**
 * Open a Reply All window for the current email with the generated text.
 * In compose mode: inserts the text directly into the active compose body.
 * In read mode: opens a Reply All compose window via displayReplyAllForm.
 */
export async function openReplyAll(replyText: string): Promise<void> {
  const html = await buildReplyHtml(replyText);
  const mode = getItemMode();
  const item = Office.context.mailbox.item as any;

  if (mode === 'compose') {
    if (item && item.body && typeof item.body.prependAsync === 'function') {
      item.body.prependAsync(html, { coercionType: Office.CoercionType.Html });
    } else {
      throw new Error('Cannot insert reply — compose body is not accessible.');
    }
  } else {
    if (item && typeof item.displayReplyAllForm === 'function') {
      item.displayReplyAllForm(html);
    } else {
      throw new Error('Cannot open Reply All window. Please make sure an email is selected.');
    }
  }
}

/**
 * Returns the last generated reply.
 */
export function getLastReply(): string {
  return lastReply;
}

/**
 * Returns whether a previous reply exists.
 */
export function hasPreviousReply(): boolean {
  return !!lastReply;
}

// ---------------------------------------------------------------------------
// Style resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the reply font style based on user settings.
 *
 * - 'match-original': extract font-family/size/color from the original email
 *   HTML (works in both read and compose-reply modes where the body contains
 *   the quoted original). Falls back to `null` when extraction fails.
 * - 'plain': no styling, returns `null`.
 */
async function resolveReplyStyle(): Promise<import('../services/style-extractor').TextStyle | null> {
  const mode = getSetting('replyStyleMode');
  if (mode === 'plain') return null;

  try {
    const html = await getCurrentEmailBodyHtml();
    return extractTextStyleFromHtml(html);
  } catch {
    return null;
  }
}

/**
 * Build the HTML body for a reply, applying the resolved style.
 * Convenience wrapper combining resolveReplyStyle + buildStyledBodyHtml.
 */
async function buildReplyHtml(text: string): Promise<string> {
  const style = await resolveReplyStyle();
  return buildStyledBodyHtml(text, style);
}

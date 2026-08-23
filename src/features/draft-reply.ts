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
  getCurrentEmailBody,
  getCurrentEmailBodyHtml,
  getCurrentEmailSubject,
  getOriginalSender,
  getItemMode,
  EmailContact,
} from '../services/outlook';
import { getSessionKey } from './auto-save';
import {
  getConversation,
  getLastAssistantReply,
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
}

export interface EmailContext {
  subject: string;
  body: string;
  sender: EmailContact;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max tokens of original email to include in the reply prompt. */
const MAX_CONTENT_TOKENS = 6000;

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
 * Caches the result to avoid re-reading for regenerate/refine.
 */
export async function loadEmailContext(): Promise<EmailContext> {
  const [body, subject, sender] = await Promise.all([
    getCurrentEmailBody(),
    getCurrentEmailSubject(),
    getOriginalSender(),
  ]);

  cachedContext = { subject, body, sender };
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
  originalEmail += context.body;
  originalEmail = truncateContext(originalEmail, MAX_CONTENT_TOKENS);

  // Resolve language: use the dropdown value, or 'auto' by default
  const language = options.language || 'auto';

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
    throw new Error('Please enter your refinement instructions.');
  }

  const prompt = `You are a professional email assistant.

Here is the current draft reply:

---
${lastReply}
---

Please revise the reply based on these instructions: ${refinement}

Requirements:
- Keep the same general format (greeting, body, sign-off)
- Apply the requested changes while maintaining quality
- Return only the revised reply, no explanations`;

  const refined = await generateText(prompt, {
    temperature: 0.6,
    maxOutputTokens: 8192,
    reasoningMode: lastReplyOptions?.reasoningMode,
    onStream,
  });

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

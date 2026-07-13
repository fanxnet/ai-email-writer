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
import {
  getCurrentEmailBody,
  getCurrentEmailSubject,
  getOriginalSender,
  getItemMode,
  EmailContact,
} from '../services/outlook';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DraftReplyOptions {
  instructions: string;
  tone: string;
  includeOriginal: boolean;
  language?: string;
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
export async function generateReply(options: DraftReplyOptions): Promise<string> {
  if (!options.instructions || !options.instructions.trim()) {
    throw new Error('Please enter your reply instructions.');
  }

  const context = await getEmailContext();

  // Build the original email string for the prompt (truncated for safety)
  let originalEmail = `From: ${context.sender.name} <${context.sender.email}>\n`;
  originalEmail += `Subject: ${context.subject}\n\n`;
  originalEmail += context.body;
  originalEmail = truncateContext(originalEmail, MAX_CONTENT_TOKENS);

  // Resolve language: 'auto' means match the original email's language
  const language = (!options.language || options.language === 'auto')
    ? 'Reply in the same language as the original email'
    : options.language;

  const prompt = buildPrompt(REPLY_PROMPT, {
    ORIGINAL_EMAIL: originalEmail,
    REPLY_INSTRUCTIONS: options.instructions,
    TONE: options.tone || 'professional',
    LANGUAGE: language,
    REPLY_TO_NAME: context.sender.name || context.sender.email || 'the sender',
  }, true);

  const reply = await generateText(prompt, {
    temperature: 0.7,
    maxOutputTokens: 2048,
  });

  lastReplyOptions = { ...options };
  lastReply = reply;

  return reply;
}

/**
 * Regenerate the last reply with the same inputs.
 */
export async function regenerateReply(): Promise<string> {
  if (!lastReplyOptions) {
    throw new Error('No previous reply to regenerate. Please generate a reply first.');
  }
  return generateReply(lastReplyOptions);
}

/**
 * Refine the last generated reply with follow-up instructions.
 */
export async function refineReply(refinement: string): Promise<string> {
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
    maxOutputTokens: 2048,
  });

  lastReply = refined;
  return refined;
}

/**
 * Insert the reply text into the currently active compose window.
 * Works when the user has already clicked Reply or Reply All in Outlook.
 */
export function insertIntoReply(replyText: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const mode = getItemMode();

    if (mode !== 'compose') {
      // Not in compose mode — open a reply window instead
      // We'll use displayReplyForm which opens a reply compose
      const item = Office.context.mailbox.item as any;
      if (item && typeof item.displayReplyForm === 'function') {
        item.displayReplyForm(bodyToHtml(replyText));
        resolve();
        return;
      }
      reject(new Error('Cannot insert reply — no compose window is open. Please click Reply first.'));
      return;
    }

    // In compose mode — insert into the body
    const item = Office.context.mailbox.item as any;
    if (item && item.body && typeof item.body.setAsync === 'function') {
      item.body.setAsync(
        bodyToHtml(replyText),
        { coercionType: Office.CoercionType.Html },
        (result: Office.AsyncResult<void>) => {
          if (result.status === Office.AsyncResultStatus.Succeeded) {
            resolve();
          } else {
            reject(new Error(`Failed to insert reply: ${result.error?.message || 'Unknown error'}`));
          }
        },
      );
    } else {
      reject(new Error('Cannot insert reply — compose body is not accessible.'));
    }
  });
}

/**
 * Open a Reply window for the current email with the generated text.
 * In compose mode: inserts the text directly into the active compose body.
 * In read mode: opens a Reply compose window via displayReplyForm.
 */
export function openReply(replyText: string): void {
  const mode = getItemMode();
  const item = Office.context.mailbox.item as any;

  if (mode === 'compose') {
    // Insert directly into the active compose body
    if (item && item.body && typeof item.body.prependAsync === 'function') {
      item.body.prependAsync(
        bodyToHtml(replyText),
        { coercionType: Office.CoercionType.Html },
      );
    } else {
      throw new Error('Cannot insert reply — compose body is not accessible.');
    }
  } else {
    // Read mode — open a reply window
    if (item && typeof item.displayReplyForm === 'function') {
      item.displayReplyForm(bodyToHtml(replyText));
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
export function openReplyAll(replyText: string): void {
  const mode = getItemMode();
  const item = Office.context.mailbox.item as any;

  if (mode === 'compose') {
    // In compose mode, Reply All is the same as Reply — prepend inline
    if (item && item.body && typeof item.body.prependAsync === 'function') {
      item.body.prependAsync(
        bodyToHtml(replyText),
        { coercionType: Office.CoercionType.Html },
      );
    } else {
      throw new Error('Cannot insert reply — compose body is not accessible.');
    }
  } else {
    // Read mode — open a Reply All window
    if (item && typeof item.displayReplyAllForm === 'function') {
      item.displayReplyAllForm(bodyToHtml(replyText));
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
// Helpers
// ---------------------------------------------------------------------------

function bodyToHtml(text: string): string {
  return text
    .split('\n\n')
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

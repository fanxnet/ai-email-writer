/**
 * AI Compose — Draft Email Feature
 *
 * Orchestrates the "Draft a New Email" workflow:
 *   1. Collect user instructions, tone, and length preferences.
 *   2. Build a prompt from the DRAFT_EMAIL_PROMPT template.
 *   3. Send to Gemini via generateText().
 *   4. Display the result and allow regenerate / refine / copy-to-compose.
 *
 * © Rizonetech (Pty) Ltd. — https://rizonesoft.com
 */

/* global Office */

import { generateText } from '../services/ai-service';
import { buildPrompt } from '../prompts/builder';
import { DRAFT_EMAIL_PROMPT } from '../prompts/templates';
import { getItemMode } from '../services/outlook';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DraftEmailOptions {
  instructions: string;
  tone: string;
  length: string;
  language?: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let lastOptions: DraftEmailOptions | null = null;
let lastDraft: string = '';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate an email draft from user instructions.
 * Returns the generated draft text (including "Subject: ..." on the first line).
 */
export async function generateDraft(options: DraftEmailOptions): Promise<string> {
  if (!options.instructions || !options.instructions.trim()) {
    throw new Error('Please enter your instructions or bullet points.');
  }

  // Map length preference to a prompt hint
  const lengthHint = getLengthHint(options.length);

  // Build the prompt from the template
  const prompt = buildPrompt(DRAFT_EMAIL_PROMPT, {
    INSTRUCTIONS: `${options.instructions}\n\nDesired length: ${lengthHint}`,
    TONE: options.tone || 'professional',
    LANGUAGE: options.language || 'English',
  }, true);

  // Call Gemini
  const draft = await generateText(prompt, {
    temperature: 0.7,
    maxOutputTokens: getMaxTokensForLength(options.length),
  });

  // Store for regenerate/refine
  lastOptions = { ...options };
  lastDraft = draft;

  return draft;
}

/**
 * Regenerate the last draft with the same inputs.
 */
export async function regenerateDraft(): Promise<string> {
  if (!lastOptions) {
    throw new Error('No previous draft to regenerate. Please generate a draft first.');
  }
  return generateDraft(lastOptions);
}

/**
 * Refine the last generated draft with follow-up instructions.
 */
export async function refineDraft(refinement: string): Promise<string> {
  if (!lastDraft) {
    throw new Error('No draft to refine. Please generate a draft first.');
  }

  if (!refinement || !refinement.trim()) {
    throw new Error('Please enter your refinement instructions.');
  }

  const prompt = `You are a professional email assistant.

Here is the current draft email:

---
${lastDraft}
---

Please revise the draft based on these instructions: ${refinement}

Requirements:
- Keep the same general format (Subject line on first line, greeting, body, sign-off)
- Apply the requested changes while maintaining quality
- Return only the revised email, no explanations`;

  const refined = await generateText(prompt, {
    temperature: 0.6,
    maxOutputTokens: 2048,
  });

  lastDraft = refined;
  return refined;
}

/**
 * Insert the generated draft into the current compose window (inline),
 * or open a new compose window if in read mode.
 *
 * In compose mode: sets the subject and body directly in the active editor.
 * In read mode: falls back to displayNewMessageForm (opens new window).
 */
export function copyToCompose(draft: string): void {
  const { subject, body } = parseSubjectAndBody(draft);
  const mode = getItemMode();

  if (mode === 'compose') {
    // Insert directly into the active compose window
    const item = Office.context.mailbox.item as any;

    // Prepend to body (preserves signature)
    if (item && item.body && typeof item.body.prependAsync === 'function') {
      item.body.prependAsync(
        bodyToHtml(body),
        { coercionType: Office.CoercionType.Html },
      );
    }

    // Set the subject inline (if the draft has one)
    if (subject && item && item.subject && typeof item.subject.setAsync === 'function') {
      item.subject.setAsync(subject);
    }
  } else {
    // Read mode — open a new compose window
    Office.context.mailbox.displayNewMessageForm({
      subject: subject,
      htmlBody: bodyToHtml(body),
    });
  }
}

/**
 * Returns the last generated draft (for UI state restoration).
 */
export function getLastDraft(): string {
  return lastDraft;
}

/**
 * Returns whether a previous draft exists (for UI state).
 */
export function hasPreviousDraft(): boolean {
  return !!lastDraft;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLengthHint(length: string): string {
  switch (length) {
    case 'short':
      return 'Keep it brief — 2-4 sentences maximum.';
    case 'detailed':
      return 'Write a thorough, detailed email covering all points.';
    case 'medium':
    default:
      return 'Standard length — a few short paragraphs.';
  }
}

function getMaxTokensForLength(length: string): number {
  switch (length) {
    case 'short':
      return 512;
    case 'detailed':
      return 4096;
    case 'medium':
    default:
      return 2048;
  }
}

/**
 * Parse "Subject: ..." from the first line of the draft.
 */
function parseSubjectAndBody(draft: string): { subject: string; body: string } {
  const lines = draft.split('\n');
  let subject = '';
  let bodyStartIndex = 0;

  if (lines.length > 0 && lines[0].toLowerCase().startsWith('subject:')) {
    subject = lines[0].replace(/^subject:\s*/i, '').trim();
    bodyStartIndex = 1;
    // Skip blank line after subject
    if (bodyStartIndex < lines.length && lines[bodyStartIndex].trim() === '') {
      bodyStartIndex++;
    }
  }

  const body = lines.slice(bodyStartIndex).join('\n').trim();
  return { subject, body };
}

/**
 * Convert plain text body to basic HTML for the compose window.
 */
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

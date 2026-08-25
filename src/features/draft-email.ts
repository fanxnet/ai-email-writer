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
import { getItemMode, getCurrentEmailBodyHtml } from '../services/outlook';
import { buildGoalText, buildRulesText, buildProfileText } from './settings';
import { extractTextStyleFromHtml, buildStyledBodyHtml } from '../services/style-extractor';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DraftEmailOptions {
  instructions: string;
  tone: string;
  length: string;
  language?: string;
  goalText?: string;
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
export async function generateDraft(
  options: DraftEmailOptions,
  onStream?: (delta: string) => void,
): Promise<string> {
  if (!options.instructions || !options.instructions.trim()) {
    throw new Error('Please enter your instructions or bullet points.');
  }

  // Map length preference to a prompt hint
  const lengthHint = getLengthHint(options.length);

  // Build Goal, Profile, and Rules as separate prompt sections
  const goalText = options.goalText || '';
  const profileText = buildProfileText();
  const rulesText = buildRulesText();

  // Build the prompt from the template
  const prompt = buildPrompt(DRAFT_EMAIL_PROMPT, {
    PROFILE: profileText,
    GOAL: goalText,
    INSTRUCTIONS: `${options.instructions}\n\nDesired length: ${lengthHint}`,
    TONE: options.tone || 'professional',
    LANGUAGE: options.language || 'English',
    RULES: rulesText,
  });

  // Call Gemini
  const draft = await generateText(prompt, {
    temperature: 0.7,
    maxOutputTokens: getMaxTokensForLength(options.length),
    onStream,
  });

  // Store for regenerate/refine
  lastOptions = { ...options };
  lastDraft = draft;

  return draft;
}

/**
 * Regenerate the last draft with the same inputs.
 */
export async function regenerateDraft(onStream?: (delta: string) => void): Promise<string> {
  if (!lastOptions) {
    throw new Error('No previous draft to regenerate. Please generate a draft first.');
  }
  return generateDraft(lastOptions, onStream);
}

/**
 * Refine the last generated draft with follow-up instructions.
 */
export async function refineDraft(
  refinement: string,
  onStream?: (delta: string) => void,
): Promise<string> {
  if (!lastDraft) {
    throw new Error('No draft to refine. Please generate a draft first.');
  }

  if (!refinement || !refinement.trim()) {
    throw new Error('Please enter either your refinement or draft instructions.');
  }

  const prompt = `You are a professional email assistant.
Requirements:
- Keep the same general format (Subject line on first line, greeting, body, sign-off)
- Apply the requested changes while maintaining quality
- Return only the revised email, no explanations

Here is the current draft email:
---
${lastDraft}
---

Please revise the draft email based on these instructions: ${refinement}`;

  const refined = await generateText(prompt, {
    temperature: 0.6,
    maxOutputTokens: 2048,
    onStream,
  });

  lastDraft = refined;
  return refined;
}

/**
 * Insert the generated draft into the current compose window (inline),
 * or open a new compose window if in read mode.
 *
 * In compose mode: extracts the signature's font style from the current
 * body, then prepends the styled draft above it.
 * In read mode: falls back to displayNewMessageForm (opens new window).
 */
export async function copyToCompose(draft: string): Promise<void> {
  const { subject, body } = parseSubjectAndBody(draft);
  const mode = getItemMode();

  // Extract font style from the compose body (signature with Outlook's
  // auto-signature has inline styles; plain text does not).
  let style: import('../services/style-extractor').TextStyle | null = null;
  if (mode === 'compose') {
    try {
      const html = await getCurrentEmailBodyHtml();
      style = extractTextStyleFromHtml(html);
    } catch {
      // Read failed — fall back to plain
    }
  }

  const html = buildStyledBodyHtml(body, style);

  if (mode === 'compose') {
    const item = Office.context.mailbox.item as any;

    // Prepend to body (preserves signature below the draft)
    if (item?.body?.prependAsync) {
      item.body.prependAsync(html, { coercionType: Office.CoercionType.Html });
    }

    // Set the subject inline (if the draft has one)
    if (subject && item?.subject?.setAsync) {
      item.subject.setAsync(subject);
    }
  } else {
    // Read mode — open a new compose window
    Office.context.mailbox.displayNewMessageForm({
      subject: subject,
      htmlBody: html,
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


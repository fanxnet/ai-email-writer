/**
 * AI Compose — Summarize Email Thread Feature
 *
 * Orchestrates the "Summarize Email Thread" workflow:
 *   1. Read the current email / conversation via the Outlook service.
 *   2. Let the user pick summary style and length.
 *   3. Build a prompt from the SUMMARIZE_THREAD_PROMPT template.
 *   4. Call Gemini and display the summary.
 *
 * © Rizonetech (Pty) Ltd. — https://rizonesoft.com
 */

import { generateText, FAST_MODEL } from '../services/ai-service';
import { buildPrompt, truncateContext } from '../prompts/builder';
import { SUMMARIZE_THREAD_PROMPT } from '../prompts/templates';
import {
  getCurrentEmailBody,
  getCurrentEmailSubject,
  getEmailSender,
  getConversationMessages,
  EmailMessage,
} from '../services/outlook';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SummaryStyle = 'bullets' | 'paragraph' | 'tldr';
export type SummaryLength = 'brief' | 'standard' | 'detailed';

export interface SummarizeOptions {
  style: SummaryStyle;
  length: SummaryLength;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max tokens of email thread to send for summarization (larger than other features). */
const MAX_CONTENT_TOKENS = 8000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let lastSummary: string = '';
let lastOptions: SummarizeOptions | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Summarize the current email or conversation thread.
 */
export async function summarizeThread(options: SummarizeOptions): Promise<string> {
  // Try to load the full conversation thread
  let rawThread: string;

  try {
    const messages = await getConversationMessages();
    rawThread = formatThread(messages);
  } catch {
    // Fallback: read only the current email
    const [body, subject, sender] = await Promise.all([
      getCurrentEmailBody(),
      getCurrentEmailSubject(),
      getEmailSender(),
    ]);

    rawThread = `From: ${sender.name} <${sender.email}>\nSubject: ${subject}\n\n${body}`;
  }

  if (!rawThread.trim()) {
    throw new Error('No email content to summarize. Please make sure an email is open.');
  }

  const emailThread = truncateContext(rawThread, MAX_CONTENT_TOKENS);

  // Build length + style instructions
  const lengthAndStyle = buildLengthStyleHint(options.length, options.style);

  const prompt = buildPrompt(SUMMARIZE_THREAD_PROMPT, {
    EMAIL_THREAD: emailThread,
    SUMMARY_LENGTH: lengthAndStyle,
  });

  const summary = await generateText(prompt, {
    temperature: 0.4, // Lower temperature for factual summaries
    maxOutputTokens: getMaxTokensForLength(options.length),
    model: FAST_MODEL,
  });

  lastSummary = summary;
  lastOptions = { ...options };

  return summary;
}

/**
 * Re-summarize with the same options (different phrasing).
 */
export async function regenerateSummary(): Promise<string> {
  if (!lastOptions) {
    throw new Error('No previous summary to regenerate. Please summarize first.');
  }
  return summarizeThread(lastOptions);
}

/**
 * Copy text to the clipboard.
 * Uses the Clipboard API with a fallback for older environments.
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  // Fallback: use a temporary textarea
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

/**
 * Returns the last generated summary.
 */
export function getLastSummary(): string {
  return lastSummary;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatThread(messages: EmailMessage[]): string {
  return messages
    .map((msg, i) => {
      let header = `--- Message ${i + 1} ---\n`;
      header += `From: ${msg.sender.name} <${msg.sender.email}>\n`;
      header += `Subject: ${msg.subject}\n`;
      if (msg.dateTime) {
        header += `Date: ${msg.dateTime}\n`;
      }
      header += `\n${msg.body}`;
      return header;
    })
    .join('\n\n');
}

function buildLengthStyleHint(length: SummaryLength, style: SummaryStyle): string {
  const lengthHint = {
    brief: 'brief (2-3 sentences)',
    standard: 'standard (1 paragraph)',
    detailed: 'detailed (multiple paragraphs)',
  }[length];

  const styleHint = {
    bullets: 'Format the summary as bullet points.',
    paragraph: 'Format the summary as flowing prose paragraphs.',
    tldr: 'Provide a single TL;DR sentence first, followed by key points.',
  }[style];

  return `${lengthHint}. ${styleHint}`;
}

function getMaxTokensForLength(length: SummaryLength): number {
  switch (length) {
    case 'brief':
      return 256;
    case 'detailed':
      return 2048;
    case 'standard':
    default:
      return 1024;
  }
}

/**
 * AI Compose — Extract Action Items Feature
 *
 * Reads the current email or thread, sends it to Gemini to extract
 * tasks, owners, and deadlines, then renders a checklist UI.
 *
 * © Rizonetech (Pty) Ltd. — https://rizonesoft.com
 */

import { generateText, FAST_MODEL } from '../services/ai-service';
import { buildPrompt, truncateContext } from '../prompts/builder';
import { EXTRACT_ACTION_ITEMS_PROMPT } from '../prompts/templates';
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

export interface ActionItem {
  task: string;
  owner: string;
  deadline: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max tokens of email content to send for action-item extraction. */
const MAX_CONTENT_TOKENS = 6000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let lastItems: ActionItem[] = [];
let lastRawResponse: string = '';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract action items from the current email or thread.
 */
export async function extractActionItems(): Promise<ActionItem[]> {
  const rawContent = await readEmailContent();

  if (!rawContent.trim()) {
    throw new Error('No email content found. Please open an email first.');
  }

  const emailContent = truncateContext(rawContent, MAX_CONTENT_TOKENS);

  const prompt = buildPrompt(EXTRACT_ACTION_ITEMS_PROMPT, {
    EMAIL_CONTENT: emailContent,
  });

  const raw = await generateText(prompt, {
    temperature: 0.2, // Low temperature for factual extraction
    maxOutputTokens: 2048,
    model: FAST_MODEL,
  });

  lastRawResponse = raw;
  lastItems = parseActionItems(raw);
  return lastItems;
}

/**
 * Re-extract action items from the same email.
 */
export async function regenerateActions(): Promise<ActionItem[]> {
  return extractActionItems();
}

/**
 * Get the last extracted items.
 */
export function getLastItems(): ActionItem[] {
  return lastItems;
}

/**
 * Format action items as a plain-text task list for clipboard.
 */
export function formatAsTaskList(items: ActionItem[]): string {
  if (items.length === 0) return 'No action items found.';

  return items
    .map((item, i) => {
      let line = `${i + 1}. ${item.task}`;
      if (item.owner && item.owner !== '—') line += ` (Owner: ${item.owner})`;
      if (item.deadline && item.deadline !== '—') line += ` [Due: ${item.deadline}]`;
      return line;
    })
    .join('\n');
}

/**
 * Copy text to clipboard.
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

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
 * Render action items as HTML checklist.
 */
export function renderChecklistHtml(items: ActionItem[]): string {
  if (items.length === 0) {
    return '<p class="aic-hint">No action items found in this email.</p>';
  }

  const rows = items
    .map(
      (item, i) => `
      <div class="aic-task-item">
        <label class="aic-task-item__check">
          <input type="checkbox" data-index="${i}" />
          <span class="aic-task-item__checkmark"></span>
        </label>
        <div class="aic-task-item__body">
          <div class="aic-task-item__text">${escapeHtml(item.task)}</div>
          <div class="aic-task-item__meta">
            ${item.owner && item.owner !== '—' ? `<span class="aic-task-item__owner"><strong>Owner:</strong> ${escapeHtml(item.owner)}</span>` : ''}
            ${item.deadline && item.deadline !== '—' ? `<span class="aic-task-item__deadline"><strong>Due:</strong> ${escapeHtml(item.deadline)}</span>` : ''}
          </div>
        </div>
      </div>`,
    )
    .join('');

  return `<div class="aic-task-list">${rows}</div>`;
}

// ---------------------------------------------------------------------------
// Email content reader
// ---------------------------------------------------------------------------

async function readEmailContent(): Promise<string> {
  // Try full thread first
  try {
    const messages = await getConversationMessages();
    return formatThread(messages);
  } catch {
    // Fallback to current email
    const [body, subject, sender] = await Promise.all([
      getCurrentEmailBody(),
      getCurrentEmailSubject(),
      getEmailSender(),
    ]);

    return `From: ${sender.name} <${sender.email}>\nSubject: ${subject}\n\n${body}`;
  }
}

function formatThread(messages: EmailMessage[]): string {
  return messages
    .map((msg, i) => {
      let header = `--- Message ${i + 1} ---\n`;
      header += `From: ${msg.sender.name} <${msg.sender.email}>\n`;
      header += `Subject: ${msg.subject}\n`;
      if (msg.dateTime) header += `Date: ${msg.dateTime}\n`;
      header += `\n${msg.body}`;
      return header;
    })
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

/**
 * Parse Gemini's response into structured action items.
 * Handles bullet-point format with Task/Owner/Deadline labels.
 */
function parseActionItems(raw: string): ActionItem[] {
  const noItemsPattern = /no action items found/i;
  if (noItemsPattern.test(raw)) return [];

  const items: ActionItem[] = [];

  // Split by bullet points or numbered items
  const blocks = raw.split(/(?:^|\n)(?:[-•*]|\d+\.)\s+/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const item: ActionItem = {
      task: '',
      owner: '—',
      deadline: '—',
    };

    // Try to extract structured fields
    const taskMatch = trimmed.match(/\*\*Task\*\*:\s*(.+?)(?:\n|$)/i);
    const ownerMatch = trimmed.match(/\*\*Owner\*\*:\s*(.+?)(?:\n|$)/i);
    const deadlineMatch = trimmed.match(/\*\*Deadline\*\*:\s*(.+?)(?:\n|$)/i);

    if (taskMatch) {
      item.task = taskMatch[1].trim();
      if (ownerMatch) item.owner = ownerMatch[1].trim();
      if (deadlineMatch) item.deadline = deadlineMatch[1].trim();
    } else {
      // Fallback: treat the whole block as the task
      item.task = trimmed
        .replace(/\*\*/g, '')
        .replace(/\n/g, ' ')
        .trim();
    }

    // Skip items that are just labels or empty
    if (item.task && item.task.length > 2) {
      items.push(item);
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

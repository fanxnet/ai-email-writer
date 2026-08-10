/**
 * AI Compose — Auto-save Service
 *
 * Automatically persists user instructions (Draft / Reply) on sidebar
 * exit/close. Saved content is restored when the add-in reopens on the
 * same email conversation.
 *
 * Auto-saved templates are stored in the shared template store
 * (`aic_templates`, see settings.ts) with the name `auto-YYYYMMDDHHMMSS`,
 * and a separate session index keys each entry to its conversation.
 * At most 5 auto-saved templates are kept (oldest evicted first), and
 * each conversation keeps at most one per type (draft / reply).
 *
 * © Rizonetech (Pty) Ltd. — https://rizonesoft.com
 */

/* global Office, localStorage */

import { getTemplates, saveTemplate, deleteTemplate } from './settings';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum instructions length (characters, after trimming) to autosave. */
const MIN_LENGTH = 20;

/** Maximum number of auto-saved templates to keep. */
const MAX_AUTO_TEMPLATES = 5;

/** localStorage key for the conversation → template index. */
const AUTO_SESSIONS_KEY = 'aic_auto_sessions';

/** Template name prefix for auto-saved entries. */
const AUTO_PREFIX = 'auto-';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutoSaveType = 'draft' | 'reply';

/** Per-conversation index to the auto-saved template id for each type. */
interface AutoSessionIndex {
  [sessionKey: string]: { draft?: string; reply?: string };
}

// ---------------------------------------------------------------------------
// Session key
// ---------------------------------------------------------------------------

/**
 * Derive a stable identifier for the current email conversation.
 *
 * - Read mode: prefers `conversationId` so the whole thread shares one entry.
 * - Falls back to the message `itemId`.
 * - Last resort: a fixed key so one last entry is kept for unidentifiable items.
 */
export function getSessionKey(): string {
  const item = Office.context?.mailbox?.item as any;
  if (!item) return 'default';

  const conversationId = item?.conversationId as string | undefined;
  if (conversationId) return `conv:${conversationId}`;

  const itemId = (item.itemId as string) || undefined;
  if (itemId) return `item:${itemId}`;

  return 'default';
}

// ---------------------------------------------------------------------------
// Index helpers
// ---------------------------------------------------------------------------

function loadIndex(): AutoSessionIndex {
  try {
    const raw = localStorage.getItem(AUTO_SESSIONS_KEY);
    return raw ? (JSON.parse(raw) as AutoSessionIndex) : {};
  } catch {
    return {};
  }
}

function persistIndex(index: AutoSessionIndex): void {
  try {
    localStorage.setItem(AUTO_SESSIONS_KEY, JSON.stringify(index));
  } catch {
    // localStorage might be unavailable in some sandboxed environments
  }
}

/**
 * Drop stale index entries that reference templates that no longer exist
 * (e.g. the user deleted the auto template manually).
 */
function pruneIndex(): AutoSessionIndex {
  const index = loadIndex();
  const templates = getTemplates();
  let changed = false;

  for (const sessionKey of Object.keys(index)) {
    const entry = index[sessionKey];
    for (const type of ['draft', 'reply'] as AutoSaveType[]) {
      const id = entry[type];
      if (id && !templates.some((t) => t.id === id)) {
        delete entry[type];
        changed = true;
      }
    }
    if (!entry.draft && !entry.reply) {
      delete index[sessionKey];
      changed = true;
    }
  }

  if (changed) persistIndex(index);
  return index;
}

// ---------------------------------------------------------------------------
// Auto template management
// ---------------------------------------------------------------------------

/** Format a Date as `YYYYMMDDHHMMSS` (year, month, day, hour, minute, second). */
function formatTimestamp(date: Date): string {
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return (
    `${date.getFullYear()}` +
    `${pad(date.getMonth() + 1)}` +
    `${pad(date.getDate())}` +
    `${pad(date.getHours())}` +
    `${pad(date.getMinutes())}` +
    `${pad(date.getSeconds())}`
  );
}

/**
 * Parse the timestamp from an auto template name (`auto-YYYYMMDDHHMMSS`).
 * Returns 0 when the name is malformed so those sort as oldest.
 */
function parseTimestamp(name: string): number {
  const match = name.match(/^auto-(\d{14})$/);
  return match ? Number(match[1]) : 0;
}

/** Keep at most MAX_AUTO_TEMPLATES auto templates, evicting the oldest. */
function enforceAutoLimit(): void {
  const templates = getTemplates();
  const autos = templates
    .filter((t) => t.name.startsWith(AUTO_PREFIX))
    .sort((a, b) => parseTimestamp(a.name) - parseTimestamp(b.name));

  if (autos.length <= MAX_AUTO_TEMPLATES) return;

  const excess = autos.slice(0, autos.length - MAX_AUTO_TEMPLATES);
  for (const t of excess) deleteTemplate(t.id);

  // Drop now-invalid index references
  pruneIndex();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Auto-save the user's instructions for the given type (draft/reply) and
 * conversation. The previous auto-saved entry for the same conversation/type
 * is replaced, and the global auto template count is capped.
 *
 * Content shorter than MIN_LENGTH characters (after trimming) is ignored.
 */
export function autoSaveEntry(
  type: AutoSaveType,
  text: string,
  sessionKey: string,
): void {
  const trimmed = (text || '').trim();
  if (trimmed.length < MIN_LENGTH) return;

  const index = pruneIndex();

  // Replace the previous entry for this (conversation, type)
  const previousId = index[sessionKey]?.[type];
  if (previousId) deleteTemplate(previousId);

  const entry = saveTemplate({
    name: `${AUTO_PREFIX}${formatTimestamp(new Date())}`,
    instructions: trimmed,
    type,
  });

  index[sessionKey] = { ...index[sessionKey], [type]: entry.id };
  persistIndex(index);

  enforceAutoLimit();
}

/**
 * Retrieve the auto-saved instructions for the given type and conversation,
 * or null when none is available.
 */
export function getAutoInstructions(
  type: AutoSaveType,
  sessionKey: string,
): string | null {
  const index = pruneIndex();
  const id = index[sessionKey]?.[type];
  if (!id) return null;

  const template = getTemplates().find((t) => t.id === id && t.type === type);
  return template ? template.instructions : null;
}
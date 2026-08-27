/**
 * AI Compose — Auto-save Service
 *
 * Automatically persists user instructions (Draft / Reply) on sidebar
 * exit/close. Saved content is restored when the add-in reopens on the
 * same email conversation.
 *
 * Auto-saved templates are stored in the shared template store
 * (`aic_templates`, see settings.ts) with the name `autod-YYYYMMDDHHMMSS`
 * (draft) or `autor-YYYYMMDDHHMMSS` (reply), and a separate session index
 * keys each entry to its conversation.
 * At most 5 auto-saved templates are kept per type (draft / reply; oldest
 * evicted first), each conversation keeps at most one reply entry, and the
 * draft history keeps the 5 most recent distinct instruction sets globally.
 *
 * © Rizonetech (Pty) Ltd. — https://rizonesoft.com
 */

/* global Office, localStorage */

import { getTemplates, saveTemplate, deleteTemplate, EmailTemplate } from './settings';
import type { DraftEmailOptions } from './draft-email';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum instructions length (characters, after trimming) to autosave. */
const MIN_LENGTH = 20;

/** Maximum number of auto-saved templates to keep. */
const MAX_AUTO_TEMPLATES = 5;

/** localStorage key for the conversation → template index. */
const AUTO_SESSIONS_KEY = 'aic_auto_sessions';

/** Template name prefix for auto-saved reply entries. */
const REPLY_AUTO_PREFIX = 'autor-';

/** Template name prefix for auto-saved draft entries. */
const DRAFT_AUTO_PREFIX = 'autod-';

/** Name prefix for auto-saved entries of the given type. */
function autoPrefix(type: AutoSaveType): string {
  return type === 'draft' ? DRAFT_AUTO_PREFIX : REPLY_AUTO_PREFIX;
}

/** localStorage key holding the single latest generated draft output. */
const DRAFT_OUTPUT_KEY = 'aic_draft_output';

/** How long a saved draft item stays valid before it is discarded (24 hours). */
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

/** The persisted shape of the latest generated draft. */
export interface SavedDraftOutput {
  draft: string;
  options: DraftEmailOptions;
  savedAt: number;
}

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
 * Parse the timestamp from an auto template name (`autod-YYYYMMDDHHMMSS` or
 * `autor-YYYYMMDDHHMMSS`). Returns 0 when the name is malformed so those
 * sort as oldest.
 */
function parseTimestamp(name: string): number {
  const match = name.match(/^(?:autod|autor)-(\d{14})$/);
  return match ? Number(match[1]) : 0;
}

/** Keep at most MAX_AUTO_TEMPLATES auto templates per type, evicting the
 * oldest within each type. Draft and reply each keep their own 5-entry
 * history so one type never evicts the other's auto-saved entries. */
function enforceAutoLimit(type: AutoSaveType): void {
  const templates = getTemplates();
  const autos = templates
    .filter((t) => t.name.startsWith(autoPrefix(type)))
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
    name: `${autoPrefix(type)}${formatTimestamp(new Date())}`,
    instructions: trimmed,
    type,
  });

  index[sessionKey] = { ...index[sessionKey], [type]: entry.id };
  persistIndex(index);

  enforceAutoLimit(type);
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

// ---------------------------------------------------------------------------
// Draft output persistence (single global slot, 24h TTL)
// ---------------------------------------------------------------------------

/**
 * Persist the latest generated draft output into a single global slot so the
 * result (and Regenerate / Refine / Copy actions) can be restored when the
 * taskpane reopens. Drafts correspond to composing a new email, so they are
 * NOT keyed to any conversation thread. Overwrites any previous value.
 */
export function saveDraftOutput(draft: string, options: DraftEmailOptions): void {
  try {
    const payload: SavedDraftOutput = {
      draft,
      options,
      savedAt: Date.now(),
    };
    localStorage.setItem(DRAFT_OUTPUT_KEY, JSON.stringify(payload));
  } catch {
    // localStorage might be unavailable in some sandboxed environments
  }
}

/**
 * Read the latest generated draft output, or `null` when none is available.
 * Entries older than the 24h window are discarded (removed) and reported as
 * absent.
 */
export function getDraftOutput(): SavedDraftOutput | null {
  try {
    const raw = localStorage.getItem(DRAFT_OUTPUT_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as SavedDraftOutput;
    if (!parsed || !parsed.draft || !parsed.options || !parsed.savedAt) {
      localStorage.removeItem(DRAFT_OUTPUT_KEY);
      return null;
    }

    if (Date.now() - parsed.savedAt > DRAFT_TTL_MS) {
      localStorage.removeItem(DRAFT_OUTPUT_KEY);
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/** Clear the persisted draft output. */
export function clearDraftOutput(): void {
  try {
    localStorage.removeItem(DRAFT_OUTPUT_KEY);
  } catch {
    // Ignore
  }
}

// ---------------------------------------------------------------------------
// Draft instructions persistence (shared template store, 24h TTL, ≤5 distinct)
// ---------------------------------------------------------------------------

/**
 * Convert an auto template name (`autod-YYYYMMDDHHMMSS` or
 * `autor-YYYYMMDDHHMMSS`) into an epoch timestamp in milliseconds. Returns 0
 * when the name is malformed.
 */
function autoTemplateAgeMs(name: string): number {
  const match = name.match(/^(?:autod|autor)-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!match) return 0;
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  );
  return Date.now() - date.getTime();
}

/** Auto-saved draft templates (name prefix `autod-`), newest first. */
function getDraftAutoTemplates(): EmailTemplate[] {
  return getTemplates()
    .filter((t) => t.name.startsWith(DRAFT_AUTO_PREFIX))
    .sort((a, b) => parseTimestamp(b.name) - parseTimestamp(a.name));
}

/**
 * Delete auto-saved draft templates that are stale (expired beyond the 24h
 * window) or a duplicate of `instructions` (when non-empty).
 */
function pruneDraftAutos(instructions: string): void {
  const stale = getDraftAutoTemplates().filter(
    (t) => autoTemplateAgeMs(t.name) > DRAFT_TTL_MS ||
      (instructions !== '' && t.instructions === instructions),
  );
  for (const t of stale) deleteTemplate(t.id);
}

/**
 * Auto-save the draft instructions into the shared template store (type
 * 'draft', name `autod-<timestamp>`) so they appear in the Draft "Templates…"
 * dropdown exactly like reply autos. Drafts are new emails, so this is NOT
 * keyed to any conversation thread. Distinct values are de-duplicated, stale
 * (24h) entries are discarded, and at most 5 draft autos are kept. Content
 * shorter than MIN_LENGTH characters (after trimming) is ignored.
 */
export function saveDraftInstructions(text: string): void {
  try {
    const trimmed = (text || '').trim();
    if (trimmed.length < MIN_LENGTH) return;

    pruneDraftAutos(trimmed);

    saveTemplate({
      name: `${DRAFT_AUTO_PREFIX}${formatTimestamp(new Date())}`,
      instructions: trimmed,
      type: 'draft',
    });

    enforceAutoLimit('draft');
  } catch {
    // localStorage might be unavailable in some sandboxed environments
  }
}

/**
 * Read the most recent draft instructions, or `null` when none is available
 * (nothing saved, all entries expired, or malformed data). Stale (24h) entries
 * are discarded as a side effect.
 */
export function getDraftInstructions(): string | null {
  try {
    pruneDraftAutos('');
    const autos = getDraftAutoTemplates();
    return autos.length > 0 ? autos[0].instructions : null;
  } catch {
    return null;
  }
}

/** Clear the persisted draft instructions history. */
export function clearDraftInstructions(): void {
  try {
    const autos = getDraftAutoTemplates();
    for (const t of autos) deleteTemplate(t.id);
  } catch {
    // Ignore
  }
}

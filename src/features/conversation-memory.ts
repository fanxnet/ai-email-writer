/**
 * AI Compose — Conversation Memory
 *
 * Per-email-conversation memory for the Reply feature, modeled on opencode's
 * compaction: the full Q&A history is stored in localStorage, but only a
 * bounded window (a structured summary + the most recent turns) is ever
 * injected into a prompt. This keeps per-turn token cost roughly constant
 * regardless of conversation length.
 *
 * History is swept lazily (on every read/write): records untouched for more
 * than TTL_MS are dropped, then a record-count cap and a total-byte budget
 * act as hard safety nets.
 *
 * © Rizonetech (Pty) Ltd. — https://rizonesoft.com
 */

import { generateText } from '../services/ai-service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
}

export interface ConversationRecord {
  key: string;
  entries: ConversationTurn[];
  /** Compaction anchor: a model-written summary of older exchanges. */
  summary: string;
  /** Cached summary of a long original email (bound to an email ref). */
  emailSummary?: { ref: string; content: string };
  /** The request that produced the latest reply (for Regenerate after reload). */
  lastRequest?: LastRequest;
  updatedAt: number;
}

/** The reply-generation options that produced the most recent reply. */
export interface LastRequest {
  instructions: string;
  tone: string;
  includeOriginal: boolean;
  language?: string;
  reasoningMode?: string;
}

export interface ReplyContextBlock {
  summary: string;
  recent: string;
}

export interface EmailContextBlock {
  text: string;
  ref: string;
}

type Store = Record<string, ConversationRecord>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'aic_conversations';

/** Records untouched for this long are evicted (lazy sweep). */
const TTL_MS = 72 * 60 * 60 * 1000;

/** Hard cap on the number of conversation records kept. */
const MAX_RECORDS = 50;

/** Hard cap on the serialized store size (≈1 MB, ~20% of localStorage quota). */
const BUDGET_CHARS = 1_000_000;

/** Number of most-recent turns injected verbatim into prompts (turn pair = 2). */
const WINDOW_TURNS = 2;

/** When a record holds more entries than this, older ones become a summary. */
const COMPACT_AFTER = 16;

const SUMMARY_MAX_TOKENS = 300;
const EMAIL_SUMMARY_MAX_TOKENS = 400;

/** Emails longer than this (chars, after pre-truncation) get an AI summary. */
const LONG_EMAIL_CHARS = 8000;

const MAX_ENTRIES = 20;
// User instructions are high-density text (e.g. Chinese); the reply-instructions
// input already caps at 1000 chars, and refine input has no cap, so keep a
// generous ceiling that still guards against pathological input.
const STORE_USER_MAX_CHARS = 1500;
// Assistant replies are kept in full (up to ~4k tokens of text) so the reply
// can be restored/refined/displayed without losing the tail of long drafts.
const STORE_ASSISTANT_MAX_CHARS = 16000;
const INJECT_USER_MAX_CHARS = 1500;
const INJECT_ASSISTANT_MAX_CHARS = 3000;
const EMAIL_REF_SUBJECT_CHARS = 120;

/** Session keys falling back to this value are not persisted across reloads. */
const RESERVED_KEY = 'default';

// ---------------------------------------------------------------------------
// Low-level store helpers
// ---------------------------------------------------------------------------

function loadStore(): Store {
  if (!canPersist()) return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

function saveStore(store: Store): void {
  if (!canPersist()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage unavailable or quota exceeded — best effort
  }
}

function canPersist(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

function shouldPersist(key: string): boolean {
  return key !== RESERVED_KEY;
}

function estimateSize(store: Store): number {
  try {
    return JSON.stringify(store).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function emptyRecord(key: string): ConversationRecord {
  return { key, entries: [], summary: '', updatedAt: Date.now() };
}

function cloneRecord(record: ConversationRecord): ConversationRecord {
  return { ...record, entries: record.entries.map((e) => ({ ...e })) };
}

// ---------------------------------------------------------------------------
// Sweeping (lazy cleanup)
// ---------------------------------------------------------------------------

/**
 * Evict expired records (TTL), then enforce the record-count and byte-budget
 * caps by dropping the oldest records first. Persists only when something
 * changed.
 */
function sweep(store: Store): Store {
  const now = Date.now();
  let changed = false;

  for (const key of Object.keys(store)) {
    if (now - store[key].updatedAt > TTL_MS) {
      delete store[key];
      changed = true;
    }
  }

  let keys = Object.keys(store);
  if (keys.length > MAX_RECORDS || estimateSize(store) > BUDGET_CHARS) {
    keys.sort((a, b) => store[a].updatedAt - store[b].updatedAt);
    let idx = 0;
    while (idx < keys.length && (Object.keys(store).length > MAX_RECORDS || estimateSize(store) > BUDGET_CHARS)) {
      delete store[keys[idx]];
      changed = true;
      idx++;
    }
  }

  if (changed) saveStore(store);
  return store;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a conversation record for the given session key. Returns a working
 * copy; a fresh (empty) record is returned when none exists.
 */
export function getConversation(key: string): ConversationRecord {
  const store = sweep(loadStore());
  const existing = store[key];
  if (existing) return cloneRecord(existing);
  return emptyRecord(key);
}

/**
 * Append a turn to the conversation. Regenerate and duplicate-question
 * heuristics keep Q&A pairs unique:
 * - a user turn identical to the last stored user turn drops the duplicate;
 * - a user turn identical to the user turn right before a trailing assistant
 *   reply drops that whole previous pair (a "regenerate" of the last reply).
 */
export function appendTurn(key: string, role: 'user' | 'assistant', content: string): void {
  const store = sweep(loadStore());
  const record = store[key] ? cloneRecord(store[key]) : emptyRecord(key);
  const max = role === 'user' ? STORE_USER_MAX_CHARS : STORE_ASSISTANT_MAX_CHARS;
  const stored = truncate(content.trim(), max);

  if (role === 'user' && record.entries.length > 0) {
    const last = record.entries[record.entries.length - 1];
    if (last.role === 'user' && last.content === stored) {
      // Same instruction typed twice in a row — drop the duplicate
      record.entries.pop();
    } else if (
      last.role === 'assistant' &&
      record.entries.length >= 2 &&
      record.entries[record.entries.length - 2].role === 'user' &&
      record.entries[record.entries.length - 2].content === stored
    ) {
      // Regenerate: same question already produced a reply — replace that pair
      record.entries.pop();
      record.entries.pop();
    }
  }

  record.entries.push({ role, content: stored, ts: Date.now() });
  if (record.entries.length > MAX_ENTRIES) {
    record.entries = record.entries.slice(-MAX_ENTRIES);
  }
  record.updatedAt = Date.now();

  if (shouldPersist(key)) {
    store[key] = record;
    saveStore(sweep(store));
  }
}

/**
 * Remove the conversation record for the given session key.
 */
export function clearConversation(key: string): void {
  if (!shouldPersist(key)) return;
  const store = sweep(loadStore());
  delete store[key];
  saveStore(store);
}

/**
 * Wipe all stored conversation history (used by "Clear All Data").
 */
export function clearAllConversations(): void {
  if (!canPersist()) return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // best effort
  }
}

/**
 * Remember the request that produced the latest reply so the user can
 * Regenerate it after leaving and returning to the same email.
 */
export function rememberLastRequest(key: string, request: LastRequest): void {
  if (!shouldPersist(key)) return;
  const store = sweep(loadStore());
  const record = store[key] ? cloneRecord(store[key]) : emptyRecord(key);
  record.lastRequest = { ...request };
  record.updatedAt = Date.now();
  store[key] = record;
  saveStore(sweep(store));
}

/**
 * Return the content of the most recent assistant turn (the latest reply),
 * or null when the conversation has no assistant turns yet.
 */
export function getLastAssistantReply(key: string): string | null {
  const record = getConversation(key);
  for (let i = record.entries.length - 1; i >= 0; i--) {
    if (record.entries[i].role === 'assistant') {
      return record.entries[i].content;
    }
  }
  return null;
}

/**
 * Build the bounded reply-context block: the compaction summary plus the
 * most recent turns verbatim (truncated). Pure function of the store so it
 * is easy to test.
 */
export function buildReplyContext(key: string): ReplyContextBlock {
  const record = getConversation(key);
  const recent = record.entries.slice(-WINDOW_TURNS * 2);

  let recentText = '';
  if (recent.length > 0) {
    recentText = recent
      .map((turn) => {
        const max = turn.role === 'user' ? INJECT_USER_MAX_CHARS : INJECT_ASSISTANT_MAX_CHARS;
        const label = turn.role === 'user' ? 'You' : 'Assistant';
        return `${label}: ${truncate(turn.content, max)}`;
      })
      .join('\n');
  }

  return { summary: record.summary, recent: recentText };
}

/**
 * Serialize the reply-context block into the text appended to a prompt.
 */
export function buildReplyContextText(block: ReplyContextBlock): string {
  const parts: string[] = [];
  if (block.summary.trim()) parts.push(`Summary: ${block.summary.trim()}`);
  if (block.recent.trim()) parts.push(`Most recent exchanges (newest last):\n${block.recent.trim()}`);
  if (parts.length === 0) return '';
  return `\n\nConversation so far on this email:\n${parts.join('\n\n')}\n\n`;
}

/**
 * Build a stable reference for an email (short subject + body length).
 * Used to detect when the original email changes so cached summaries are
 * regenerated.
 */
export function buildEmailRef(subject: string, body: string): string {
  const s = (subject || '').slice(0, EMAIL_REF_SUBJECT_CHARS);
  return `${s}|${(body || '').length}`;
}

/**
 * Get the email text to embed in a reply prompt. Long emails (beyond
 * LONG_EMAIL_CHARS) are summarized once per email ref and cached; shorter
 * emails are returned verbatim.
 */
export async function getEmailContextBlock(
  key: string,
  emailRef: string,
  emailText: string,
): Promise<EmailContextBlock> {
  const store = sweep(loadStore());
  const record = store[key];

  if (record?.emailSummary?.ref === emailRef) {
    return { text: record.emailSummary.content, ref: emailRef };
  }

  if (emailText.length <= LONG_EMAIL_CHARS) {
    return { text: emailText, ref: emailRef };
  }

  try {
    const prompt = `Summarize this email in a few concise sentences for an AI that must write a reply. Keep every key fact: participants, dates, numbers, requests, and action items. Preserve the overall tone. Return only the summary, no preamble.\n\n---\n${emailText}`;
    const content = await generateText(prompt, {
      temperature: 0.2,
      maxOutputTokens: EMAIL_SUMMARY_MAX_TOKENS,
    });

    if (shouldPersist(key)) {
      const updated = record ? cloneRecord(record) : emptyRecord(key);
      updated.emailSummary = { ref: emailRef, content };
      updated.updatedAt = Date.now();
      store[key] = updated;
      saveStore(sweep(store));
    }
    return { text: content, ref: emailRef };
  } catch {
    // Summary generation failed — fall back to the (truncated) original text
    return { text: emailText, ref: emailRef };
  }
}

/**
 * Fold older turns into a model-written summary when a conversation grows
 * past COMPACT_AFTER entries. On failure this silently degrades to
 * recent-window-only memory. Best-effort; callers should not await strictly.
 */
export async function compactIfNeeded(key: string): Promise<void> {
  const store = sweep(loadStore());
  const record = store[key];
  if (!shouldPersist(key) || !record || record.entries.length <= COMPACT_AFTER) return;

  const older = record.entries.slice(0, record.entries.length - WINDOW_TURNS * 2);
  // Frequency control: only fold when enough new older turns have
  // accumulated since the last compaction (≈ every 10 interactions), so a
  // single generation does not trigger a compaction round every time.
  if (older.length < COMPACT_AFTER) return;

  try {
    const prompt = buildCompactionPrompt(record.summary, older);
    const summary = await generateText(prompt, {
      temperature: 0.2,
      maxOutputTokens: SUMMARY_MAX_TOKENS,
    });

    record.summary = summary;
    record.entries = record.entries.slice(-WINDOW_TURNS * 2);
    record.updatedAt = Date.now();
    store[key] = record;
    saveStore(sweep(store));
  } catch {
    // Fail silently — memory degrades to the recent-window only
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function buildCompactionPrompt(previousSummary: string, older: ConversationTurn[]): string {
  const olderText = older
    .map((turn) => {
      const label = turn.role === 'user' ? 'You' : 'Assistant';
      return `${label}: ${turn.content}`;
    })
    .join('\n');

  return `You are compacting an email-writing conversation carried on by an AI assistant and its user.

Keep the following so future turns remain consistent:
- key decisions and the user's preferences (tone, format, constraints)
- what the latest reply draft looks like (its structure and sign-off)
- any unresolved requests or open questions

Produce one concise paragraph. Return only the summary.

Previous summary:
${previousSummary.trim() || '(none)'}

Older exchanges to fold into the summary:
${olderText}`;
}
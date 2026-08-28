/**
 * AI Compose — Task Pane Controller
 *
 * Wires up the task pane HTML with the feature modules.
 * Handles Office.js initialization, DOM event binding, and tab switching.
 *
 * © Rizonetech (Pty) Ltd. — https://rizonesoft.com
 */

/* global document, Office */

import '../styles/main.css';
import './taskpane.css';
import { initGeminiClient } from '../services/gemini';
import { initDeepSeekClient, abortDeepSeekRequest } from '../services/deepseek';
import { generateText } from '../services/ai-service';
import { getItemMode } from '../services/outlook';
import { buildGoalText, getTemplates, saveTemplate, deleteTemplate, getCareers, saveCareer, deleteCareer } from '../features/settings';
import {
  generateDraft,
  regenerateDraft,
  refineDraft,
  copyToCompose,
  restoreDraftFromStorage,
  DraftEmailOptions,
} from '../features/draft-email';
import {
  generateReply,
  regenerateReply,
  refineReply,
  openReply,
  openReplyAll,
  loadEmailContext,
  clearEmailContext,
  restoreFromHistory,
  DraftReplyOptions,
} from '../features/draft-reply';
import {
  summarizeThread,
  regenerateSummary,
  copyToClipboard,
  SummarizeOptions,
  SummaryStyle,
  SummaryLength,
} from '../features/summarize-thread';
import {
  improveWriting,
  regenerateImprovement,
  acceptChanges,
  generateDiffHtml,
  ImproveOptions,
  ImprovementFocus,
} from '../features/improve-writing';
import {
  extractActionItems,
  regenerateActions,
  getLastItems,
  formatAsTaskList,
  copyToClipboard as copyTasksToClipboard,
  renderChecklistHtml,
} from '../features/extract-actions';
import {
  translateEmail,
  regenerateTranslation,
  getLastResult as getLastTranslation,
  renderTranslationHtml,
  copyToClipboard as copyTranslationToClipboard,
} from '../features/translate';
import {
  loadSettings,
  saveSettings,
  resetSettings,
  getSetting,
  AIComposeSettings,
  ReasoningMode,
} from '../features/settings';
import {
  autoSaveEntry,
  getAutoInstructions,
  saveDraftInstructions,
  getDraftInstructions,
  getSessionKey,
} from '../features/auto-save';
import {
  clearConversation,
  clearAllConversations,
  getConversation,
} from '../features/conversation-memory';

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const $ = (id: string) => document.getElementById(id);

/** Validate API key format based on selected provider. */
function isValidApiKeyFormat(key: string, provider: 'gemini' | 'deepseek'): boolean {
  if (provider === 'gemini') {
    return /^(?:AIza|AQ)/.test(key);
  }
  return /^sk-/.test(key.trim());
}

function showElement(id: string): void {
  const el = $(id);
  if (el) el.classList.remove('hidden');
}

function hideElement(id: string): void {
  const el = $(id);
  if (el) el.classList.add('hidden');
}

/**
 * Display name of the currently selected AI provider for user-facing
 * loading messages ("Generating with Gemini..." vs "...with DeepSeek...").
 */
function providerDisplayName(): string {
  return getSetting('aiProvider') === 'deepseek' ? 'DeepSeek' : 'Gemini';
}

let loadingTimer: number | undefined;

let loadingElapsed = 0;

function showLoading(message?: string, _inputLength?: number): void {
  const overlay = $('loading-overlay');
  if (!overlay) return;
  const text = overlay.querySelector('.aic-loading__text') as HTMLElement;
  if (text && message) text.textContent = message;

  const estimate = overlay.querySelector('.aic-loading__estimate') as HTMLElement;
  if (estimate) {
    if (loadingTimer !== undefined) window.clearInterval(loadingTimer);
    loadingElapsed = 0;
    estimate.textContent = 'Elapsed: 0s';
    estimate.classList.remove('hidden');
    loadingTimer = window.setInterval(() => {
      loadingElapsed += 1;
      estimate.textContent = `Elapsed: ${loadingElapsed}s`;
    }, 1000);
  }

  overlay.classList.remove('aic-loading--fade-out');
  showElement('loading-overlay');
}

function hideLoading(): void {
  if (loadingTimer !== undefined) {
    window.clearInterval(loadingTimer);
    loadingTimer = undefined;
  }
  const overlay = $('loading-overlay');
  if (!overlay || overlay.classList.contains('hidden')) return;

  overlay.classList.add('aic-loading--fade-out');

  const cleanup = () => {
    overlay.classList.remove('aic-loading--fade-out');
    hideElement('loading-overlay');
  };

  overlay.addEventListener('transitionend', cleanup, { once: true });
  // Fallback in case transitionend doesn't fire
  setTimeout(cleanup, 350);
}

function showError(message: string): void {
  const el = $('error-message');
  if (el) el.textContent = message;
  showElement('error-banner');
}

function hideError(): void {
  hideElement('error-banner');
}

function setPreview(elementId: string, text: string): void {
  const preview = $(elementId);
  if (!preview) return;

  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const lines = escaped.split('\n');
  const html = lines
    .map((line) => {
      if (line.toLowerCase().startsWith('subject:')) {
        return `<div class="aic-preview__subject">${line}</div>`;
      }
      if (line.trim() === '') {
        return '<br>';
      }
      return `<div>${line}</div>`;
    })
    .join('');

  preview.innerHTML = html;
  updatePreviewStats(elementId);
}

function updatePreviewStats(previewId: string): void {
  const preview = $(previewId);
  // Map preview ID to its stats element
  const statsId = previewId.replace('-preview', '-stats');
  const stats = $(statsId);
  if (!preview || !stats) return;

  const text = (preview.innerText || preview.textContent || '').trim();
  if (!text) {
    stats.classList.add('hidden');
    return;
  }

  const words = text.split(/\s+/).filter((w) => w.length > 0).length;
  const readingMinutes = Math.max(1, Math.round(words / 200));
  stats.textContent = `${words} words · ${readingMinutes} min read`;
  stats.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Streaming output writer
// ---------------------------------------------------------------------------

/**
 * Prepare a result element to receive streamed text deltas.
 *
 * The previous content is left untouched until the first delta actually
 * arrives (so a failed early-validation call never wipes the prior result).
 * Once streaming starts, a blinking caret is inserted ahead of the incoming
 * text. The caller can:
 *  - `onFirst(fn)` to run something (e.g. reveal the result section, dismiss
 *    the loading overlay) the moment the first delta arrives,
 *  - `append(delta)` for each incoming chunk,
 *  - `finish()` to remove the caret once generation completes,
 *  - `clear()` to wipe any partial streamed text (e.g. on error).
 *
 * Returns `null` when the target element doesn't exist, so callers can safely
 * fall back to the non-streaming path.
 */
function streamInto(previewId: string) {
  const preview = $(previewId) as HTMLElement | null;
  if (!preview) return null;

  let caret: HTMLSpanElement | null = null;
  let started = false;
  let firstCb: (() => void) | null = null;

  return {
    onFirst(fn: () => void) {
      firstCb = fn;
    },
    append(delta: string) {
      if (!started) {
        started = true;
        preview.textContent = '';
        caret = document.createElement('span');
        caret.className = 'aic-stream-caret';
        caret.textContent = '▍';
        preview.appendChild(caret);
        if (firstCb) firstCb();
      }
      caret?.insertAdjacentText('beforebegin', delta);
    },
    finish() {
      caret?.remove();
      caret = null;
    },
    clear() {
      if (started) {
        preview.textContent = '';
        caret = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Email Scoring
// ---------------------------------------------------------------------------

function updateModelDropdown(provider: string, currentModel?: string): void {
  const modelSelect = $('settings-model') as HTMLSelectElement | null;
  if (!modelSelect) return;
  modelSelect.innerHTML = '';

  const models = provider === 'deepseek'
    ? [
        { value: 'deepseek-v4-flash', text: 'deepseek-v4-flash' },
        { value: 'deepseek-v4-pro', text: 'deepseek-v4-pro' }
      ]
    : [
        { value: 'gemini-3.5-flash', text: 'gemini-3.5-flash' },
        { value: 'gemini-flash-latest', text: 'gemini-flash-latest' },
        { value: 'gemini-flash-lite-latest', text: 'gemini-flash-lite-latest' },
        { value: 'gemini-2.5-pro', text: 'gemini-2.5-pro' }
      ];

  models.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.value;
    opt.textContent = m.text;
    modelSelect.appendChild(opt);
  });

  if (currentModel) {
    modelSelect.value = currentModel;
  } else {
    modelSelect.value = provider === 'deepseek' ? 'deepseek-v4-flash' : 'gemini-flash-latest';
  }
}

// ---------------------------------------------------------------------------
// Compose-mode UI adaptation
// ---------------------------------------------------------------------------

type UIMode = 'read' | 'compose' | 'unknown';

function adaptUIForMode(mode: UIMode): void {
  if (mode === 'compose') {
    // Draft section: "Copy to Compose" → "Insert into Email"
    const copyComposeBtn = $('btn-copy-compose');
    if (copyComposeBtn) {
      copyComposeBtn.innerHTML =
        '<i class="ms-Icon ms-Icon--Edit"></i> Insert into Email';
      copyComposeBtn.title = 'Insert the draft into the current email';
    }

    // Reply section: "Reply" → "Insert Reply", hide "Reply All"
    const insertReplyBtn = $('btn-insert-reply');
    if (insertReplyBtn) {
      insertReplyBtn.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>' +
        ' Insert Reply';
      insertReplyBtn.title = 'Insert the reply into the current email';
    }

    const insertReplyAllBtn = $('btn-insert-reply-all');
    if (insertReplyAllBtn) {
      insertReplyAllBtn.classList.add('hidden');
    }

    // Reply context banner: load the original sender and subject
    const senderEl = $('reply-sender');
    const subjectEl = $('reply-subject');
    if (senderEl) senderEl.textContent = 'Loading…';

    // Use getOriginalSender to get the person being replied to
    import('../services/outlook').then(async ({ getOriginalSender, getCurrentEmailSubject }) => {
      try {
        const [sender, subject] = await Promise.all([
          getOriginalSender(),
          (async () => {
            const item = Office.context.mailbox.item as any;
            if (item && item.subject && typeof item.subject.getAsync === 'function') {
              return new Promise<string>((resolve) => {
                item.subject.getAsync((result: any) => {
                  resolve(result.status === Office.AsyncResultStatus.Succeeded
                    ? result.value || '(new email)'
                    : '(new email)');
                });
              });
            }
            return '(new email)';
          })(),
        ]);

        if (senderEl) {
          senderEl.textContent = sender.name
            ? `${sender.name} <${sender.email}>`
            : sender.email || 'Unknown sender';
        }
        if (subjectEl) {
          subjectEl.textContent = subject;
        }
      } catch {
        if (senderEl) senderEl.textContent = 'Could not read email';
        if (subjectEl) subjectEl.textContent = '—';
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------

const TAB_CONFIG: Record<string, string[]> = {
  draft: ['draft-section', 'result-section'],
  reply: ['reply-section', 'reply-result-section'],
  summarize: ['summarize-section', 'summarize-result-section'],
  improve: ['improve-section', 'improve-result-section'],
  extract: ['extract-section', 'extract-result-section'],
  translate: ['translate-section', 'translate-result-section'],
  settings: ['settings-section'],
  rules: ['rules-section'],
};

function switchTab(tabName: string): void {
  // Update tab buttons
  document.querySelectorAll('.aic-tab').forEach((tab) => {
    tab.classList.toggle('aic-tab--active', (tab as HTMLElement).dataset.tab === tabName);
  });

  // Show/hide sections
  for (const [name, sectionIds] of Object.entries(TAB_CONFIG)) {
    const isActive = name === tabName;
    for (const id of sectionIds) {
      const el = $(id);
      if (!el) continue;

      if (isActive) {
        // For form sections, always show. For result sections, only show if they have content.
        if (id.includes('result')) {
          // Keep current display state (only shown after generation)
        } else {
          el.classList.remove('hidden');
        }
      } else {
        el.classList.add('hidden');
      }
    }
  }

  hideError();

  // Restore auto-saved instructions when entering an input tab
  if (tabName === 'draft' || tabName === 'reply') {
    restoreActiveInstructions();
  }

  // Restore the latest generated draft output when returning to the Draft tab
  if (tabName === 'draft') {
    restoreDraftFromHistory();
  }

  // Auto-load email context when switching to Reply tab
  if (tabName === 'reply') {
    loadReplyContext();
    restoreReplyFromHistory();
  }
}

// ---------------------------------------------------------------------------
// Reply context loader
// ---------------------------------------------------------------------------

/** Save both instruction inputs. Draft uses a global slot (not conversation
 * threaded); reply stays keyed to the current email conversation. */
function autoSaveSession(): void {
  try {
    const sessionKey = getSessionKey();
    const draft = ($('draft-instructions') as HTMLTextAreaElement)?.value || '';
    const reply = ($('reply-instructions') as HTMLTextAreaElement)?.value || '';
    saveDraftInstructions(draft);
    autoSaveEntry('reply', reply, sessionKey);
  } catch {
    // Best-effort autosave — never block closing the panel
  }
}

/** Restore the auto-saved instructions into the currently active tab.
 * Draft reads the global slot; reply reads the per-conversation entry. */
function restoreActiveInstructions(): void {
  try {
    const activeTab = document.querySelector('.aic-tab--active') as HTMLElement | null;
    const tabName = activeTab?.dataset.tab;
    if (tabName !== 'draft' && tabName !== 'reply') return;

    const textarea = $(`${tabName}-instructions`) as HTMLTextAreaElement;
    if (!textarea || textarea.value.trim()) return;

    const saved =
      tabName === 'draft'
        ? getDraftInstructions()
        : getAutoInstructions('reply', getSessionKey());
    if (saved) {
      textarea.value = saved;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } catch {
    // Best-effort restore
  }
}

async function loadReplyContext(): Promise<void> {
  const senderEl = $('reply-sender');
  const subjectEl = $('reply-subject');

  try {
    clearEmailContext();
    const ctx = await loadEmailContext();
    if (senderEl) {
      senderEl.textContent = ctx.sender.name
        ? `${ctx.sender.name} <${ctx.sender.email}>`
        : ctx.sender.email || 'Unknown sender';
    }
    if (subjectEl) {
      subjectEl.textContent = ctx.subject || '(no subject)';
    }
  } catch {
    if (senderEl) senderEl.textContent = 'Could not read email';
    if (subjectEl) subjectEl.textContent = '—';
  }
}

// ---------------------------------------------------------------------------
// Conversation memory (reply reuse)
// ---------------------------------------------------------------------------

/**
 * Show or hide the conversation controls and panel based on the
 * "Conversation context" toggle. The checkbox itself stays visible so the
 * feature can always be re-enabled.
 */
function applyConversationFeatureVisibility(): void {
  const enabled = getSetting('conversationContextEnabled');
  const control = $('conversation-control');
  if (control) control.classList.toggle('hidden', !enabled);
  const panel = $('reply-conversation-panel');
  if (panel && !enabled) panel.classList.add('hidden');
}

/**
 * Restore the most recent generated reply for the current email so all
 * result actions (Insert / Regenerate / Refine) work again after the user
 * leaves the email and returns.
 */
function restoreReplyFromHistory(): void {
  if (!getSetting('conversationContextEnabled')) return;
  try {
    const key = getSessionKey();
    const restored = restoreFromHistory(key);

    if (!restored) {
      hideElement('reply-result-section');
      return;
    }

    setPreview('reply-preview', restored.reply);
    scrollToBottom($('reply-preview'));
    showElement('reply-result-section');

    // In compose mode, Reply All is redundant — user already chose reply type
    if (getItemMode() === 'compose') {
      hideElement('btn-insert-reply-all');
    }
  } catch {
    // Best-effort restore — never block the panel on history issues
  }
}

/**
 * Restore the most recent generated draft output (within the 24h window) so
 * the draft result and its actions (Regenerate / Refine / Copy) work again
 * after the taskpane reopens or the user returns to the Draft tab.
 */
function restoreDraftFromHistory(): void {
  try {
    const restored = restoreDraftFromStorage();
    const draftTabActive =
      document.querySelector('.aic-tab--active')?.getAttribute('data-tab') === 'draft';
    if (!restored) {
      hideElement('result-section');
      return;
    }
    setPreview('draft-preview', restored.draft);
    scrollToBottom($('draft-preview'));
    // Only reveal the result section when the Draft tab is active, so the
    // restored output never shows on another tab.
    if (draftTabActive) showElement('result-section');
  } catch {
    // Best-effort restore — never block the panel
  }
}

/** Render the per-email conversation into the "Show" panel. */
function renderConversationPanel(): void {
  const key = getSessionKey();
  const rec = getConversation(key);
  const list = $('reply-conv-list');
  if (!list) return;

  const summaryEl = $('reply-conv-summary');
  if (summaryEl) {
    summaryEl.textContent = rec.summary || '';
    summaryEl.classList.toggle('hidden', !rec.summary);
  }

  const emptyEl = $('reply-conv-empty');
  list.innerHTML = '';
  if (rec.entries.length === 0) {
    if (emptyEl) {
      emptyEl.textContent = 'No conversation saved for this email yet.';
      emptyEl.classList.remove('hidden');
    }
    return;
  }
  if (emptyEl) emptyEl.classList.add('hidden');

  for (const turn of rec.entries) {
    const isUser = turn.role === 'user';
    const row = document.createElement('div');
    row.className = 'flex flex-col gap-[2px]';

    const label = document.createElement('div');
    label.className = 'text-xs font-medium ' + (isUser ? 'text-aic-text-secondary' : 'text-aic-blue');
    label.textContent = isUser ? 'You' : 'Assistant';

    const body = document.createElement('div');
    body.className = 'text-sm text-aic-text whitespace-pre-wrap';
    body.textContent = turn.content;

    row.appendChild(label);
    row.appendChild(body);
    list.appendChild(row);
  }
}

/** Scroll an element so its own bottom is visible (its overflow scroll). */
function scrollToBottom(el: HTMLElement | null): void {
  if (el) el.scrollTop = el.scrollHeight;
}

// ---------------------------------------------------------------------------
// Draft Email handlers
// ---------------------------------------------------------------------------

async function handleGenerate(): Promise<void> {
  const instructions = ($('draft-instructions') as HTMLTextAreaElement)?.value || '';
  const tone = ($('draft-tone') as HTMLSelectElement)?.value || 'professional';
  const length = ($('draft-length') as HTMLSelectElement)?.value || 'medium';
  const language = ($('draft-language') as HTMLSelectElement)?.value || 'English';
  const goal = ($('draft-goal') as HTMLSelectElement)?.value || 'none';
  const customGoal = ($('draft-goal-custom') as HTMLInputElement)?.value || '';
  const goalText = buildGoalText(goal, customGoal);

  const options: DraftEmailOptions = {
    instructions,
    tone, length, language,
    goalText,
  };

  hideError();
  showLoading(`Generating with ${providerDisplayName()}...`, instructions.length);

  const writer = streamInto('draft-preview');
  writer?.onFirst(() => {
    showElement('result-section');
    hideLoading();
  });

  try {
    const draft = await generateDraft(options, (delta) => writer?.append(delta));
    writer?.finish();
    setPreview('draft-preview', draft);
    scrollToBottom($('draft-preview'));
    $('result-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err: any) {
    writer?.clear();
    writer?.finish();
    showError(err.message || 'Failed to generate draft. Please try again.');
  } finally {
    hideLoading();
  }
}

async function handleRegenerate(): Promise<void> {
  hideError();
  showLoading('Regenerating...');

  const writer = streamInto('draft-preview');
  writer?.onFirst(() => {
    showElement('result-section');
    hideLoading();
  });

  try {
    const draft = await regenerateDraft((delta) => writer?.append(delta));
    writer?.finish();
    setPreview('draft-preview', draft);
    scrollToBottom($('draft-preview'));
  } catch (err: any) {
    writer?.clear();
    writer?.finish();
    showError(err.message || 'Failed to regenerate. Please try again.');
  } finally {
    hideLoading();
  }
}

async function handleRefine(): Promise<void> {
  const input = $('refine-input') as HTMLInputElement;
  const refinement = input?.value || ($('draft-instructions') as HTMLTextAreaElement)?.value || '';

  if (!refinement.trim()) {
    showError('Please enter either refinement or instructions.');
    return;
  }

  hideError();
  showLoading('Refining...');

  const writer = streamInto('draft-preview');
  writer?.onFirst(() => {
    showElement('result-section');
    hideLoading();
  });

  try {
    const draft = await refineDraft(refinement, (delta) => writer?.append(delta));
    writer?.finish();
    setPreview('draft-preview', draft);
    scrollToBottom($('draft-preview'));
    if (input) input.value = '';
  } catch (err: any) {
    writer?.clear();
    writer?.finish();
    showError(err.message || 'Failed to refine. Please try again.');
  } finally {
    hideLoading();
  }
}

function handleCopyToCompose(): void {
  const preview = $('draft-preview');
  if (!preview) return;

  const draft = preview.innerText || preview.textContent || '';
  if (!draft.trim()) {
    showError('No draft to copy. Please generate one first.');
    return;
  }

  try {
    copyToCompose(draft);
  } catch (err: any) {
    showError(err.message || 'Failed to open compose window.');
  }
}

// ---------------------------------------------------------------------------
// Reply handlers
// ---------------------------------------------------------------------------

// Reply operations are serialized: only one generate/regenerate/refine may run
// at a time, and the action buttons are disabled while one is in flight. This
// prevents duplicate DeepSeek requests stacking up on repeated clicks.
let replyRequestInFlight = false;

const REPLY_ACTION_BUTTONS = ['btn-generate-reply', 'btn-regenerate-reply', 'btn-refine-reply'];

function setReplyButtonsDisabled(disabled: boolean): void {
  for (const id of REPLY_ACTION_BUTTONS) {
    const btn = $(id) as HTMLButtonElement | null;
    if (btn) btn.disabled = disabled;
  }
}

function withReplyGuard(action: () => Promise<void>): () => Promise<void> {
  return async () => {
    if (replyRequestInFlight) return;
    replyRequestInFlight = true;
    setReplyButtonsDisabled(true);
    abortDeepSeekRequest();
    try {
      await action();
    } finally {
      replyRequestInFlight = false;
      setReplyButtonsDisabled(false);
    }
  };
}

// Cancel any in-flight DeepSeek request when the taskpane is unloaded
window.addEventListener('beforeunload', () => abortDeepSeekRequest());

async function handleGenerateReply(): Promise<void> {
  const instructions = ($('reply-instructions') as HTMLTextAreaElement)?.value || '';
  const tone = ($('reply-tone') as HTMLSelectElement)?.value || 'professional';
  const reasoningMode = ($('reply-reasoning') as HTMLSelectElement)?.value as ReasoningMode || 'off';
  const language = ($('reply-language') as HTMLSelectElement)?.value || 'auto';
  const goal = ($('reply-goal') as HTMLSelectElement)?.value || 'none';
  const customGoal = ($('reply-goal-custom') as HTMLInputElement)?.value || '';
  const goalText = buildGoalText(goal, customGoal);
  const includeThread = ($('reply-include-thread') as HTMLInputElement)?.checked ?? false;

  const options: DraftReplyOptions = {
    instructions,
    tone, includeOriginal: true, language, reasoningMode,
    goalText,
    includeThread,
  };

  hideError();
  showLoading(`Generating reply with ${providerDisplayName()}...`, instructions.length);

  const writer = streamInto('reply-preview');
  writer?.onFirst(() => {
    showElement('reply-result-section');
    hideLoading();
  });

  try {
    const reply = await generateReply(options, (delta) => writer?.append(delta));
    writer?.finish();
    setPreview('reply-preview', reply);
    scrollToBottom($('reply-preview'));
    renderConversationPanel();
    scrollToBottom($('reply-conversation-panel'));
    $('reply-result-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // In compose mode, Reply All is redundant — user already chose reply type
    if (getItemMode() === 'compose') {
      hideElement('btn-insert-reply-all');
    }
  } catch (err: any) {
    writer?.clear();
    writer?.finish();
    showError(err.message || 'Failed to generate reply. Please try again.');
  } finally {
    hideLoading();
  }
}

async function handleRegenerateReply(): Promise<void> {
  hideError();
  showLoading('Regenerating reply...');

  const writer = streamInto('reply-preview');
  writer?.onFirst(() => {
    showElement('reply-result-section');
    hideLoading();
  });

  try {
    const reply = await regenerateReply((delta) => writer?.append(delta));
    writer?.finish();
    setPreview('reply-preview', reply);
    scrollToBottom($('reply-preview'));
    renderConversationPanel();
    scrollToBottom($('reply-conversation-panel'));
  } catch (err: any) {
    writer?.clear();
    writer?.finish();
    showError(err.message || 'Failed to regenerate reply. Please try again.');
  } finally {
    hideLoading();
  }
}

async function handleRefineReply(): Promise<void> {
  const input = $('reply-refine-input') as HTMLInputElement;
  const refinement = input?.value || ($('reply-instructions') as HTMLTextAreaElement)?.value || '';
//  redirect reply instructions if no refinement instructions.
 
//  if (!refinement || !refinement.trim()) {
//    throw new Error('Please enter your refinement instructions.');}
  
  hideError();
  showLoading('Refining reply...');

  const writer = streamInto('reply-preview');
  writer?.onFirst(() => {
    showElement('reply-result-section');
    hideLoading();
  });

  try {
    const reply = await refineReply(refinement, (delta) => writer?.append(delta));
    writer?.finish();
    setPreview('reply-preview', reply);
    scrollToBottom($('reply-preview'));
    renderConversationPanel();
    scrollToBottom($('reply-conversation-panel'));
    if (input) input.value = '';
  } catch (err: any) {
    writer?.clear();
    writer?.finish();
    showError(err.message || 'Failed to refine reply. Please try again.');
  } finally {
    hideLoading();
  }
}

async function handleSuggestReplies(): Promise<void> {
  const btn = $('btn-suggest-replies') as HTMLButtonElement;
  const textSpan = $('suggest-replies-text');
  const container = $('reply-suggestions');
  if (!btn || !container) return;

  // Show loading state
  btn.disabled = true;
  if (textSpan) textSpan.textContent = 'Thinking...';
  container.classList.remove('hidden');
  container.innerHTML = '';
  container.classList.add('aic-suggestions--streaming');

  const writer = streamInto('reply-suggestions');

  try {
    const { getEmailContext, buildThreadBodyText, MIN_KEEP_REPLIES } = await import('../features/draft-reply');
    const context = await getEmailContext();

    const body = buildThreadBodyText(context.bodyHtml ?? '', MIN_KEEP_REPLIES);
    const emailSummary = `From: ${context.sender.name} <${context.sender.email}>\nSubject: ${context.subject}\n\n${body}`.slice(0, 2000);

    const isDouble = ($('reply-double') as HTMLInputElement)?.checked;
    const wordRange = isDouble ? '10-24' : '5-12';

    const prompt = `Read this email and suggest exactly 3 short reply sentences (${wordRange} words each) that the user could send back as a response.
Each suggestion should be an actual reply message, NOT an email client action like archiving or unsubscribing.
Return ONLY 3 lines, one suggestion per line. No numbering, no bullets, no quotes, no extra text.

Email:
${emailSummary}`;

    const result = await generateText(prompt, {
      temperature: 0.9,
      maxOutputTokens: 1024,
      onStream: (delta) => {
        writer?.append(delta);
      },
    });

    console.log('[Suggest replies] Raw response:', result);

    writer?.finish();
    container.innerHTML = '';

    // Parse line-separated suggestions — strip any numbering, bullets, or quotes
    const maxLen = isDouble ? 240 : 120;
    const suggestions = result
      .split('\n')
      .map((line) => line.replace(/^\d+[\.\)\-]\s*/, '').replace(/^[-•*]\s*/, '').replace(/^["']|["']$/g, '').trim())
      .filter((line) => line.length > 5 && line.length < maxLen)
      .slice(0, 3);

    if (suggestions.length === 0) throw new Error('No suggestions returned. Please try again.');

    // Render chips
    suggestions.slice(0, 3).forEach((text) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'aic-suggestion-chip';
      chip.textContent = text;
      chip.addEventListener('click', () => {
        const textarea = $('reply-instructions') as HTMLTextAreaElement;
        if (textarea) {
          textarea.value = text;
          textarea.focus();
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
        // Highlight the selected chip
        container.querySelectorAll('.aic-suggestion-chip').forEach((c) =>
          c.classList.remove('aic-suggestion-chip--active'));
        chip.classList.add('aic-suggestion-chip--active');
      });
      container.appendChild(chip);
    });

    container.classList.remove('aic-suggestions--streaming');
  } catch (err: any) {
    writer?.clear();
    writer?.finish();
    container.classList.remove('aic-suggestions--streaming');
    hideElement('reply-suggestions');
    showError(err.message || 'Failed to generate suggestions.');
  } finally {
    btn.disabled = false;
    if (textSpan) textSpan.textContent = 'Suggest replies';
  }
}

function handleInsertReply(): void {
  const preview = $('reply-preview');
  if (!preview) return;

  const text = preview.innerText || preview.textContent || '';
  if (!text.trim()) {
    showError('No reply to insert. Please generate one first.');
    return;
  }

  try {
    openReply(text);
  } catch (err: any) {
    showError(err.message || 'Failed to open reply window.');
  }
}

function handleInsertReplyAll(): void {
  const preview = $('reply-preview');
  if (!preview) return;

  const text = preview.innerText || preview.textContent || '';
  if (!text.trim()) {
    showError('No reply to insert. Please generate one first.');
    return;
  }

  try {
    openReplyAll(text);
  } catch (err: any) {
    showError(err.message || 'Failed to open Reply All window.');
  }
}

// ---------------------------------------------------------------------------
// Summarize handlers
// ---------------------------------------------------------------------------

function getSelectedStyle(): SummaryStyle {
  const checked = document.querySelector('input[name="summary-style"]:checked') as HTMLInputElement;
  return (checked?.value as SummaryStyle) || 'bullets';
}

async function handleSummarize(): Promise<void> {
  const style = getSelectedStyle();
  const length = ($('summary-length') as HTMLSelectElement)?.value as SummaryLength || 'standard';
  const language = ($('summary-language') as HTMLSelectElement)?.value || 'auto';

  const options: SummarizeOptions = { style, length, language };

  hideError();
  showLoading(`Summarizing with ${providerDisplayName()}...`);

  const writer = streamInto('summary-preview');
  writer?.onFirst(() => {
    showElement('summarize-result-section');
    hideLoading();
  });

  try {
    const summary = await summarizeThread(options, (delta) => writer?.append(delta));
    writer?.finish();
    setPreview('summary-preview', summary);
    $('summarize-result-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err: any) {
    writer?.clear();
    writer?.finish();
    showError(err.message || 'Failed to summarize. Please try again.');
  } finally {
    hideLoading();
  }
}

async function handleRegenerateSummary(): Promise<void> {
  hideError();
  showLoading('Regenerating summary...');

  const writer = streamInto('summary-preview');
  writer?.onFirst(() => {
    showElement('summarize-result-section');
    hideLoading();
  });

  try {
    const summary = await regenerateSummary((delta) => writer?.append(delta));
    writer?.finish();
    setPreview('summary-preview', summary);
  } catch (err: any) {
    writer?.clear();
    writer?.finish();
    showError(err.message || 'Failed to regenerate summary. Please try again.');
  } finally {
    hideLoading();
  }
}

async function handleCopySummary(): Promise<void> {
  const preview = $('summary-preview');
  if (!preview) return;

  const text = preview.innerText || preview.textContent || '';
  if (!text.trim()) {
    showError('No summary to copy.');
    return;
  }

  try {
    await copyToClipboard(text);
    // Brief visual feedback
    const btn = $('btn-copy-summary');
    if (btn) {
      const original = btn.innerHTML;
      btn.innerHTML = '<i class="ms-Icon ms-Icon--CheckMark"></i> Copied!';
      btn.classList.add('aic-btn--success');
      setTimeout(() => {
        btn.innerHTML = original;
        btn.classList.remove('aic-btn--success');
      }, 1500);
    }
  } catch (err: any) {
    showError(err.message || 'Failed to copy to clipboard.');
  }
}

// ---------------------------------------------------------------------------
// Improve Writing handlers
// ---------------------------------------------------------------------------

function getSelectedFocus(): ImprovementFocus {
  const checked = document.querySelector('input[name="improve-focus"]:checked') as HTMLInputElement;
  return (checked?.value as ImprovementFocus) || 'fix_grammar';
}

async function handleImprove(): Promise<void> {
  const focus = getSelectedFocus();
  const options: ImproveOptions = { focus };

  hideError();
  showLoading(`Improving with ${providerDisplayName()}...`);

  const writer = streamInto('improve-diff');
  writer?.onFirst(() => {
    showElement('improve-result-section');
    hideLoading();
  });

  try {
    const result = await improveWriting(options, (delta) => writer?.append(delta));
    writer?.finish();
    const diffContainer = $('improve-diff');
    if (diffContainer) {
      diffContainer.innerHTML = generateDiffHtml(result.original, result.improved);
    }
    $('improve-result-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err: any) {
    writer?.clear();
    writer?.finish();
    showError(err.message || 'Failed to improve text. Please try again.');
  } finally {
    hideLoading();
  }
}

async function handleRegenerateImprove(): Promise<void> {
  hideError();
  showLoading('Regenerating improvement...');

  const writer = streamInto('improve-diff');
  writer?.onFirst(() => {
    showElement('improve-result-section');
    hideLoading();
  });

  try {
    const result = await regenerateImprovement((delta) => writer?.append(delta));
    writer?.finish();
    const diffContainer = $('improve-diff');
    if (diffContainer) {
      diffContainer.innerHTML = generateDiffHtml(result.original, result.improved);
    }
  } catch (err: any) {
    writer?.clear();
    writer?.finish();
    showError(err.message || 'Failed to regenerate. Please try again.');
  } finally {
    hideLoading();
  }
}

async function handleAcceptChanges(): Promise<void> {
  hideError();

  try {
    const action = await acceptChanges();
    const btn = $('btn-accept-changes');
    if (btn) {
      const original = btn.innerHTML;
      const msg = action === 'replaced'
        ? '<i class="ms-Icon ms-Icon--CheckMark"></i> Replaced!'
        : '<i class="ms-Icon ms-Icon--CheckMark"></i> Copied!';
      btn.innerHTML = msg;
      btn.classList.add('aic-btn--success');
      setTimeout(() => {
        btn.innerHTML = original;
        btn.classList.remove('aic-btn--success');
      }, 1500);
    }
  } catch (err: any) {
    showError(err.message || 'Failed to accept changes.');
  }
}

// ---------------------------------------------------------------------------
// Extract Action Items handlers
// ---------------------------------------------------------------------------

async function handleExtract(): Promise<void> {
  hideError();
  showLoading('Scanning for action items...');

  const writer = streamInto('extract-checklist');
  writer?.onFirst(() => {
    showElement('extract-result-section');
    hideLoading();
  });

  try {
    const items = await extractActionItems((delta) => writer?.append(delta));
    writer?.finish();
    const container = $('extract-checklist');
    if (container) {
      container.innerHTML = renderChecklistHtml(items);
    }
    $('extract-result-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err: any) {
    writer?.clear();
    writer?.finish();
    showError(err.message || 'Failed to extract action items.');
  } finally {
    hideLoading();
  }
}

async function handleRegenerateExtract(): Promise<void> {
  hideError();
  showLoading('Re-scanning for action items...');

  const writer = streamInto('extract-checklist');
  writer?.onFirst(() => {
    showElement('extract-result-section');
    hideLoading();
  });

  try {
    const items = await regenerateActions((delta) => writer?.append(delta));
    writer?.finish();
    const container = $('extract-checklist');
    if (container) {
      container.innerHTML = renderChecklistHtml(items);
    }
  } catch (err: any) {
    writer?.clear();
    writer?.finish();
    showError(err.message || 'Failed to re-extract.');
  } finally {
    hideLoading();
  }
}

async function handleCopyTasks(): Promise<void> {
  const items = getLastItems();
  if (items.length === 0) {
    showError('No action items to copy.');
    return;
  }

  try {
    const text = formatAsTaskList(items);
    await copyTasksToClipboard(text);
    const btn = $('btn-copy-tasks');
    if (btn) {
      const original = btn.innerHTML;
      btn.innerHTML = '<i class="ms-Icon ms-Icon--CheckMark"></i> Copied!';
      btn.classList.add('aic-btn--success');
      setTimeout(() => {
        btn.innerHTML = original;
        btn.classList.remove('aic-btn--success');
      }, 1500);
    }
  } catch (err: any) {
    showError(err.message || 'Failed to copy tasks.');
  }
}

// ---------------------------------------------------------------------------
// Translate handlers
// ---------------------------------------------------------------------------

async function handleTranslate(): Promise<void> {
  const langSelect = $('translate-language') as HTMLSelectElement;
  if (!langSelect) return;

  hideError();
  showLoading('Translating email...');

  const writer = streamInto('translate-output');
  writer?.onFirst(() => {
    showElement('translate-result-section');
    hideLoading();
  });

  try {
    const result = await translateEmail(langSelect.value, (delta) => writer?.append(delta));
    writer?.finish();
    const container = $('translate-output');
    if (container) {
      container.innerHTML = renderTranslationHtml(result);
    }
    $('translate-result-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err: any) {
    writer?.clear();
    writer?.finish();
    showError(err.message || 'Failed to translate.');
  } finally {
    hideLoading();
  }
}

async function handleRegenerateTranslate(): Promise<void> {
  const langSelect = $('translate-language') as HTMLSelectElement;
  if (!langSelect) return;

  hideError();
  showLoading('Re-translating email...');

  const writer = streamInto('translate-output');
  writer?.onFirst(() => {
    showElement('translate-result-section');
    hideLoading();
  });

  try {
    const result = await regenerateTranslation(langSelect.value, (delta) => writer?.append(delta));
    writer?.finish();
    const container = $('translate-output');
    if (container) {
      container.innerHTML = renderTranslationHtml(result);
    }
  } catch (err: any) {
    writer?.clear();
    writer?.finish();
    showError(err.message || 'Failed to re-translate.');
  } finally {
    hideLoading();
  }
}

async function handleCopyTranslation(): Promise<void> {
  const result = getLastTranslation();
  if (!result) {
    showError('No translation to copy.');
    return;
  }

  try {
    await copyTranslationToClipboard(result.translated);
    const btn = $('btn-copy-translation');
    if (btn) {
      const original = btn.innerHTML;
      btn.innerHTML = '<i class="ms-Icon ms-Icon--CheckMark"></i> Copied!';
      btn.classList.add('aic-btn--success');
      setTimeout(() => {
        btn.innerHTML = original;
        btn.classList.remove('aic-btn--success');
      }, 1500);
    }
  } catch (err: any) {
    showError(err.message || 'Failed to copy translation.');
  }
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

Office.onReady((info) => {
  if (info.host === Office.HostType.Outlook) {
    hideElement('sideload-msg');
    showElement('app-body');

    // Detect compose mode and adapt UI
    const currentMode = getItemMode();
    adaptUIForMode(currentMode);

    // Auto-switch tab based on mode
    if (currentMode === 'read') {
      // Reading an email — default to Reply tab
      loadReplyContext();
    } else if (currentMode === 'compose') {
      // Compose mode — check if replying (has To recipients) or drafting (new email)
      const item = Office.context.mailbox.item as any;
      if (item && item.to && typeof item.to.getAsync === 'function') {
        item.to.getAsync((result: any) => {
          if (result.status === Office.AsyncResultStatus.Succeeded &&
              result.value && result.value.length > 0) {
            // Has recipients — this is a reply, stay on Reply tab
            switchTab('reply');
          } else {
            // No recipients — new email, switch to Draft tab
            switchTab('draft');
          }
        });
      } else {
        // Can't check recipients — default to Draft for compose
        switchTab('draft');
      }
    }

    // Refresh context when user switches to a different email
    if (Office.context.mailbox) {
      Office.context.mailbox.addHandlerAsync(
        Office.EventType.ItemChanged,
        () => {
          // Persist the outgoing conversation before switching
          autoSaveSession();
          loadReplyContext();
          restoreActiveInstructions();
          restoreReplyFromHistory();
        },
      );
    }

    // Load settings and initialize clients
    const settings = loadSettings();
    try {
      if (settings.aiProvider === 'deepseek') {
        const apiKey = settings.deepseekApiKey || '';
        if (apiKey) {
          initDeepSeekClient(apiKey);
        }
      } else {
        const apiKey = settings.geminiApiKey || (window as any).__AICompose_API_KEY__ || '';
        if (apiKey) {
          initGeminiClient(apiKey);
        }
      }
    } catch {
      // Client will be initialized when settings are saved
    }

    // Populate feature defaults from settings
    const applySettingsToForms = (s: AIComposeSettings): void => {
      // Tone selects
      const draftTone = $('draft-tone') as HTMLSelectElement | null;
      const replyTone = $('reply-tone') as HTMLSelectElement | null;
      if (draftTone) draftTone.value = s.defaultTone;
      if (replyTone) replyTone.value = s.defaultTone;

      // Reasoning mode select (defaults to persisted setting)
      const replyReasoning = $('reply-reasoning') as HTMLSelectElement | null;
      if (replyReasoning) replyReasoning.value = s.reasoningMode || 'off';

      // Summary style radio buttons
      const summaryRadio = document.querySelector(
        `input[name="summary-style"][value="${s.defaultSummaryStyle}"]`,
      ) as HTMLInputElement | null;
      if (summaryRadio) summaryRadio.checked = true;

      // Reply language (persisted; 'auto' = match original email by default)
      const replyLang = $('reply-language') as HTMLSelectElement | null;
      if (replyLang) replyLang.value = s.replyLanguage || 'auto';

      // Draft language (persisted; defaults to 'English')
      const draftLang = $('draft-language') as HTMLSelectElement | null;
      if (draftLang) draftLang.value = s.draftLanguage || 'English';

      // Translation language (shared with Summarize via defaultLanguage)
      const langSelect = $('translate-language') as HTMLSelectElement | null;
      if (langSelect) langSelect.value = s.defaultLanguage || 'English';

      // Summary language (shared with Translate via defaultLanguage)
      const summaryLang = $('summary-language') as HTMLSelectElement | null;
      if (summaryLang) summaryLang.value = s.defaultLanguage || 'English';

      // Settings form itself
      const sProvider = $('settings-provider') as HTMLSelectElement | null;
      if (sProvider) sProvider.value = s.aiProvider;

      updateModelDropdown(s.aiProvider, s.defaultModel);

      const sApiKey = $('settings-api-key') as HTMLInputElement | null;
      if (sApiKey) {
        sApiKey.value = s.aiProvider === 'deepseek' ? s.deepseekApiKey : s.geminiApiKey;
      }

      const sTone = $('settings-tone') as HTMLSelectElement | null;
      const sStyle = $('settings-summary-style') as HTMLSelectElement | null;
      const sLang = $('settings-language') as HTMLSelectElement | null;
      const sReplyStyle = $('settings-reply-style') as HTMLSelectElement | null;
      if (sTone) sTone.value = s.defaultTone;
      if (sStyle) sStyle.value = s.defaultSummaryStyle;
      if (sLang) sLang.value = s.defaultLanguage;
      if (sReplyStyle) sReplyStyle.value = s.replyStyleMode || 'match-original';

      // Rules form
      for (const [key, enabled] of Object.entries(s.presetRules)) {
        const cb = $(`rule-${key}`) as HTMLInputElement | null;
        if (cb) cb.checked = enabled;
      }
      const customRulesEl = $('custom-rules') as HTMLTextAreaElement | null;
      if (customRulesEl) customRulesEl.value = s.customRules;

      // Conversation context toggle (Reply toolbar)
      const ctxToggle = $('conversation-context-toggle') as HTMLInputElement | null;
      if (ctxToggle) ctxToggle.checked = s.conversationContextEnabled;
      applyConversationFeatureVisibility();
    };

    applySettingsToForms(settings);

    // Restore auto-saved instructions for the current conversation
    restoreActiveInstructions();
    restoreReplyFromHistory();
    restoreDraftFromHistory();

    // Persist instructions when the sidebar is closed / the add-in is unloaded
    window.addEventListener('pagehide', autoSaveSession);
    window.addEventListener('beforeunload', autoSaveSession);

    // Persist the user's language choices immediately so
    // they survive reloads and become the default on the next use.
    const persistReplyLanguage = (): void => {
      const sel = $('reply-language') as HTMLSelectElement | null;
      if (!sel) return;
      saveSettings({ ...loadSettings(), replyLanguage: sel.value || 'auto' });
    };
    const persistDraftLanguage = (): void => {
      const sel = $('draft-language') as HTMLSelectElement | null;
      if (!sel) return;
      saveSettings({ ...loadSettings(), draftLanguage: sel.value || 'English' });
    };
    const persistTranslateLanguage = (): void => {
      const sel = $('translate-language') as HTMLSelectElement | null;
      if (!sel) return;
      saveSettings({ ...loadSettings(), defaultLanguage: sel.value || 'English' });
    };
    const persistReplyReasoning = (): void => {
      const sel = $('reply-reasoning') as HTMLSelectElement | null;
      if (!sel) return;
      saveSettings({ ...loadSettings(), reasoningMode: sel.value as AIComposeSettings['reasoningMode'] });
    };
    $('reply-language')?.addEventListener('change', persistReplyLanguage);
    $('draft-language')?.addEventListener('change', persistDraftLanguage);
    $('translate-language')?.addEventListener('change', persistTranslateLanguage);
    $('reply-reasoning')?.addEventListener('change', persistReplyReasoning);

    // Summary language persistence (writes to shared defaultLanguage)
    const persistSummaryLanguage = (): void => {
      const sel = $('summary-language') as HTMLSelectElement | null;
      if (!sel) return;
      saveSettings({ ...loadSettings(), defaultLanguage: sel.value || 'English' });
    };
    $('summary-language')?.addEventListener('change', persistSummaryLanguage);

    // --- Outlook theme detection (light/dark) ---
    try {
      const theme = (Office.context as any).officeTheme;
      if (theme?.bodyBackgroundColor) {
        const bg = theme.bodyBackgroundColor.replace('#', '');
        const r = parseInt(bg.substring(0, 2), 16);
        const g = parseInt(bg.substring(2, 4), 16);
        const b = parseInt(bg.substring(4, 6), 16);
        // Relative luminance: dark if below 128
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b);
        if (luminance < 128) {
          document.documentElement.setAttribute('data-theme', 'dark');
        }
      }
    } catch {
      // Theme detection not available — default to light
    }

    // --- Tab switching + dropdown ---
    const DROPDOWN_TABS = new Set(['summarize', 'improve', 'extract']);
    const moreBtn = $('tab-more');
    const dropdown = $('more-dropdown');
    const splitContainer = moreBtn?.closest('.aic-split');

    const toggleDropdown = (show?: boolean): void => {
      if (!dropdown || !splitContainer) return;
      const isOpen = show !== undefined ? show : dropdown.classList.contains('hidden');
      dropdown.classList.toggle('hidden', !isOpen);
      splitContainer.classList.toggle('aic-split--open', isOpen);
    }

    // Regular tab buttons (Draft, Reply)
    document.querySelectorAll('.aic-tabs > .aic-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const tabName = (tab as HTMLElement).dataset.tab;
        if (tabName && tabName !== 'more') {
          switchTab(tabName);
          // Clear More button highlight
          moreBtn?.classList.remove('aic-tab--active');
          document.querySelectorAll('.aic-dropdown__item').forEach((item) =>
            item.classList.remove('aic-dropdown__item--active'),
          );
          toggleDropdown(false);
        }
      });
    });

    // More button — toggle dropdown
    moreBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDropdown();
    });

    // Dropdown items
    document.querySelectorAll('.aic-dropdown__item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const tabName = (item as HTMLElement).dataset.tab;
        if (tabName) {
          switchTab(tabName);
          // Highlight the More button and the selected item
          document.querySelectorAll('.aic-tab').forEach((t) =>
            t.classList.remove('aic-tab--active'),
          );
          moreBtn?.classList.add('aic-tab--active');
          document.querySelectorAll('.aic-dropdown__item').forEach((di) =>
            di.classList.remove('aic-dropdown__item--active'),
          );
          item.classList.add('aic-dropdown__item--active');
          toggleDropdown(false);
        }
      });
    });

    // Close dropdown on outside click
    document.addEventListener('click', () => toggleDropdown(false));

    // --- Character counters + auto-grow + clear buttons ---
    document.querySelectorAll('.aic-char-count[data-for]').forEach((counter) => {
      const textareaId = counter.getAttribute('data-for');
      if (!textareaId) return;
      const textarea = $(textareaId) as HTMLTextAreaElement | null;
      if (!textarea) return;
      const max = textarea.maxLength || 1000;
      const clearBtn = document.querySelector(`.aic-btn-clear[data-clear="${textareaId}"]`);
      textarea.addEventListener('input', () => {
        counter.textContent = `${textarea.value.length} / ${max}`;
        // Auto-grow
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
        // Toggle clear button
        if (clearBtn) {
          if (textarea.value.length > 0) clearBtn.classList.remove('hidden');
          else clearBtn.classList.add('hidden');
        }
      });
    });

    // Clear button click handlers
    document.querySelectorAll('.aic-btn-clear[data-clear]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-clear');
        if (!targetId) return;
        const textarea = $(targetId) as HTMLTextAreaElement | null;
        if (!textarea) return;
        textarea.value = '';
        textarea.style.height = '';
        textarea.dispatchEvent(new Event('input'));
        textarea.focus();
      });
    });

    // --- Draft Email ---
    $('btn-generate')?.addEventListener('click', handleGenerate);
    $('btn-regenerate')?.addEventListener('click', handleRegenerate);
    $('btn-refine')?.addEventListener('click', handleRefine);
    $('btn-copy-compose')?.addEventListener('click', handleCopyToCompose);

    $('refine-input')?.addEventListener('keydown', (e: Event) => {
      if ((e as KeyboardEvent).key === 'Enter') handleRefine();
    });

    // --- Reply ---
    $('btn-generate-reply')?.addEventListener('click', withReplyGuard(handleGenerateReply));
    $('btn-suggest-replies')?.addEventListener('click', handleSuggestReplies);
    $('btn-regenerate-reply')?.addEventListener('click', withReplyGuard(handleRegenerateReply));
    $('btn-refine-reply')?.addEventListener('click', withReplyGuard(handleRefineReply));
    $('btn-insert-reply')?.addEventListener('click', handleInsertReply);
    $('btn-insert-reply-all')?.addEventListener('click', handleInsertReplyAll);

    $('reply-refine-input')?.addEventListener('keydown', (e: Event) => {
      if ((e as KeyboardEvent).key === 'Enter') withReplyGuard(handleRefineReply)();
    });

    // ------------------------------------------------------------------
    // Show / Hide / Clear conversation composite dropdown
    // ------------------------------------------------------------------
    const conversationPanel = () => $('reply-conversation-panel');
    const conversationDropdown = () => $('conversation-dropdown');
    const conversationToggleBtn = () => $('btn-conversation-toggle') as HTMLButtonElement | null;

    const setConversationLabel = (label: string): void => {
      const btn = conversationToggleBtn();
      if (btn) btn.textContent = label;
    };

    const closeConversationDropdown = (): void => {
      const dd = conversationDropdown();
      if (dd) dd.classList.add('hidden');
    };

    const openConversationPanel = (): void => {
      renderConversationPanel();
      const panel = conversationPanel();
      if (panel) panel.classList.remove('hidden');
      scrollToBottom(panel);
      setConversationLabel('Hide');
      closeConversationDropdown();
    };

    const closeConversationPanel = (): void => {
      const panel = conversationPanel();
      if (panel) panel.classList.add('hidden');
      setConversationLabel('Show');
      closeConversationDropdown();
    };

    const clearConversationAndRefresh = (): void => {
      clearConversation(getSessionKey());
      hideElement('reply-result-section');
      const panel = conversationPanel();
      if (panel && !panel.classList.contains('hidden')) {
        renderConversationPanel();
      }
      const msg = $('reply-conv-cleared-msg');
      if (msg) {
        msg.classList.remove('hidden');
        setTimeout(() => { msg.classList.add('hidden'); }, 2000);
      }
      closeConversationDropdown();
    };

    // Primary button toggles between Show and Hide on consecutive clicks
    $('btn-conversation-toggle')?.addEventListener('click', () => {
      const panel = conversationPanel();
      if (!panel) return;
      if (panel.classList.contains('hidden')) {
        openConversationPanel();
      } else {
        closeConversationPanel();
      }
    });

    // Caret opens/closes the menu (Clear is only reachable from here)
    $('btn-conversation-caret')?.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      const dd = conversationDropdown();
      if (!dd) return;
      const willShow = dd.classList.contains('hidden');
      dd.classList.toggle('hidden', !willShow);
    });

    // Menu items
    document
      .querySelectorAll('#conversation-dropdown .aic-dropdown__item')
      .forEach((item) => {
        item.addEventListener('click', () => {
          const action = (item as HTMLElement).dataset.action;
          if (action === 'show') openConversationPanel();
          else if (action === 'hide') closeConversationPanel();
          else if (action === 'clear') clearConversationAndRefresh();
          else closeConversationDropdown();
        });
      });

    // Close the conversation menu when clicking anywhere else
    document.addEventListener('click', () => closeConversationDropdown());

    // "Conversation context" toggle — applies immediately
    $('conversation-context-toggle')?.addEventListener('change', (e: Event) => {
      const enabled = (e.target as HTMLInputElement).checked;
      const settings = loadSettings();
      settings.conversationContextEnabled = enabled;
      saveSettings(settings);
      applyConversationFeatureVisibility();
    });

    // --- Summarize ---
    $('btn-summarize')?.addEventListener('click', handleSummarize);
    $('btn-regenerate-summary')?.addEventListener('click', handleRegenerateSummary);
    $('btn-copy-summary')?.addEventListener('click', handleCopySummary);

    // --- Improve ---
    $('btn-improve')?.addEventListener('click', handleImprove);
    $('btn-regenerate-improve')?.addEventListener('click', handleRegenerateImprove);
    $('btn-accept-changes')?.addEventListener('click', handleAcceptChanges);

    // --- Extract ---
    $('btn-extract')?.addEventListener('click', handleExtract);
    $('btn-regenerate-extract')?.addEventListener('click', handleRegenerateExtract);
    $('btn-copy-tasks')?.addEventListener('click', handleCopyTasks);

    // --- Translate ---
    $('btn-translate')?.addEventListener('click', handleTranslate);
    $('btn-regenerate-translate')?.addEventListener('click', handleRegenerateTranslate);
    $('btn-copy-translation')?.addEventListener('click', handleCopyTranslation);

    // --- Settings ---
    $('tab-settings')?.addEventListener('click', () => {
      switchTab('settings');
      // Highlight settings button
      document.querySelectorAll('.aic-tab').forEach((t) =>
        t.classList.remove('aic-tab--active'),
      );
      $('tab-settings')?.classList.add('aic-tab--active');
      document.querySelectorAll('.aic-dropdown__item').forEach((di) =>
        di.classList.remove('aic-dropdown__item--active'),
      );
      toggleDropdown(false);
    });

    // --- Rules ---
    $('tab-rules')?.addEventListener('click', () => {
      switchTab('rules');
      document.querySelectorAll('.aic-tab').forEach((t) =>
        t.classList.remove('aic-tab--active'),
      );
      $('tab-rules')?.classList.add('aic-tab--active');
      document.querySelectorAll('.aic-dropdown__item').forEach((di) =>
        di.classList.remove('aic-dropdown__item--active'),
      );
      toggleDropdown(false);
    });

    $('btn-save-rules')?.addEventListener('click', () => {
      const current = loadSettings();
      const presetRules: Record<string, boolean> = {};
      for (const key of Object.keys(current.presetRules)) {
        const cb = $(`rule-${key}`) as HTMLInputElement | null;
        presetRules[key] = cb?.checked ?? false;
      }
      const customRules = ($('custom-rules') as HTMLTextAreaElement)?.value || '';
      saveSettings({ ...current, presetRules, customRules });

      const msg = $('rules-saved-msg');
      if (msg) {
        msg.classList.remove('hidden');
        setTimeout(() => { msg.classList.add('hidden'); }, 2500);
      }
    });

    // API Provider change handler
    $('settings-provider')?.addEventListener('change', () => {
      const provider = ($('settings-provider') as HTMLSelectElement).value;
      const currentSettings = loadSettings();
      const apiKeyInput = $('settings-api-key') as HTMLInputElement | null;
      if (apiKeyInput) {
        apiKeyInput.value = provider === 'deepseek' ? currentSettings.deepseekApiKey : currentSettings.geminiApiKey;
      }
      updateModelDropdown(provider);
    });

    // API key show/hide toggle
    $('btn-toggle-api-key')?.addEventListener('click', () => {
      const input = $('settings-api-key') as HTMLInputElement | null;
      const showIcon = $('icon-eye-show');
      const hideIcon = $('icon-eye-hide');
      if (!input) return;

      if (input.type === 'password') {
        input.type = 'text';
        if (showIcon) showIcon.classList.add('hidden');
        if (hideIcon) hideIcon.classList.remove('hidden');
      } else {
        input.type = 'password';
        if (showIcon) showIcon.classList.remove('hidden');
        if (hideIcon) hideIcon.classList.add('hidden');
      }
    });

    // Save settings
    $('btn-save-settings')?.addEventListener('click', () => {
      const provider = ($('settings-provider') as HTMLSelectElement)?.value as 'gemini' | 'deepseek' || 'gemini';
      const apiKey = ($('settings-api-key') as HTMLInputElement)?.value?.trim() || '';
      const model = ($('settings-model') as HTMLSelectElement)?.value || (provider === 'deepseek' ? 'deepseek-v4-flash' : 'gemini-flash-latest');
      const tone = ($('settings-tone') as HTMLSelectElement)?.value || 'professional';
      const summaryStyle = ($('settings-summary-style') as HTMLSelectElement)?.value || 'bullets';
      const replyStyle = ($('settings-reply-style') as HTMLSelectElement)?.value || 'match-original';

      // Validate API key format
      const keyError = $('api-key-error');
      if (apiKey && !isValidApiKeyFormat(apiKey, provider)) {
        if (keyError) {
          keyError.textContent = provider === 'gemini'
            ? 'Invalid API key format. Keys typically start with "AIza" or "AQ".'
            : 'Invalid API key format. DeepSeek keys must start with "sk-".';
          keyError.classList.remove('hidden');
        }
        return;
      }
      if (keyError) keyError.classList.add('hidden');

      const existing = loadSettings();
      const newSettings: AIComposeSettings = {
        ...existing,
        aiProvider: provider,
        geminiApiKey: provider === 'gemini' ? apiKey : existing.geminiApiKey,
        deepseekApiKey: provider === 'deepseek' ? apiKey : existing.deepseekApiKey,
        apiKey: provider === 'gemini' ? apiKey : existing.apiKey,
        defaultModel: model,
        defaultTone: tone as any,
        defaultSummaryStyle: summaryStyle as any,
        replyStyleMode: replyStyle as 'match-original' | 'plain',
        activeCareerId: ($('career-active') as HTMLSelectElement)?.value || '',
      };

      saveSettings(newSettings);
      applySettingsToForms(newSettings);

      // Show confirmation
      const msg = $('settings-saved-msg');
      if (msg) {
        msg.classList.remove('hidden');
        setTimeout(() => { msg.classList.add('hidden'); }, 2000);
      }

      // Flash the save button green
      const btn = $('btn-save-settings');
      if (btn) {
        btn.classList.add('aic-btn--success');
        setTimeout(() => btn.classList.remove('aic-btn--success'), 1500);
      }
    });

    // Test Connection button
    $('btn-test-connection')?.addEventListener('click', async () => {
      const provider = ($('settings-provider') as HTMLSelectElement)?.value as 'gemini' | 'deepseek' || 'gemini';
      const apiKey = ($('settings-api-key') as HTMLInputElement)?.value?.trim() || '';
      const resultEl = $('test-connection-result');
      const keyError = $('api-key-error');
      const btn = $('btn-test-connection');

      if (!resultEl) return;

      // Validate format first
      if (!apiKey) {
        if (keyError) {
          keyError.textContent = 'Please enter an API key first.';
          keyError.classList.remove('hidden');
        }
        return;
      }
      if (!isValidApiKeyFormat(apiKey, provider)) {
        if (keyError) {
          keyError.textContent = provider === 'gemini'
            ? 'Invalid API key format. Keys typically start with "AIza" or "AQ".'
            : 'Invalid API key format. DeepSeek keys must start with "sk-".';
          keyError.classList.remove('hidden');
        }
        return;
      }
      if (keyError) keyError.classList.add('hidden');

      // Show testing state
      resultEl.classList.remove('hidden');
      resultEl.style.color = 'var(--color-aic-text-secondary)';
      resultEl.textContent = 'Testing connection…';
      if (btn) btn.setAttribute('disabled', 'true');

      try {
        if (provider === 'gemini') {
          initGeminiClient(apiKey);
        } else {
          initDeepSeekClient(apiKey);
        }
        try {
          await generateText('Say hello in one word.', {
            maxOutputTokens: 20,
            temperature: 0.5,
          });
        } catch (testErr: any) {
          // If error is CONTENT_FILTERED, the API key and connection are still valid
          if (testErr?.code === 'CONTENT_FILTERED') {
            // Connection works — content filter is a non-issue for a test
          } else {
            throw testErr;
          }
        }
        resultEl.style.color = 'var(--color-aic-success)';
        resultEl.textContent = '✓ Connection successful! API key is valid.';
        if (btn) {
          btn.classList.add('aic-btn--success');
          setTimeout(() => btn.classList.remove('aic-btn--success'), 2000);
        }
      } catch (err: any) {
        resultEl.style.color = 'var(--color-aic-error-text)';
        resultEl.textContent = `✗ ${err.message || 'Connection failed. Please check your API key.'}`;
      } finally {
        if (btn) btn.removeAttribute('disabled');
      }
    });

    // Clear All Data button
    $('btn-clear-all-data')?.addEventListener('click', () => {
      resetSettings();
      clearAllConversations();
      try {
        localStorage.removeItem('aic_templates');
        localStorage.removeItem('aic_careers');
        localStorage.removeItem('aic_auto_sessions');
      } catch {
        // Best-effort — storage may be unavailable
      }

      // Reset all form fields to defaults
      const defaults = loadSettings();
      applySettingsToForms(defaults);
      refreshTemplateDropdowns();
      refreshCareerDropdown();

      // Show confirmation
      const msg = $('clear-data-msg');
      if (msg) {
        msg.classList.remove('hidden');
        setTimeout(() => { msg.classList.add('hidden'); }, 2500);
      }
    });

    // --- Scroll to top ---
    const scrollTopBtn = $('btn-scroll-top');
    if (scrollTopBtn) {
      window.addEventListener('scroll', () => {
        if (window.scrollY > 300) scrollTopBtn.classList.remove('hidden');
        else scrollTopBtn.classList.add('hidden');
      });
      scrollTopBtn.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }

    // --- Error banner ---
    // --- Template system ---
    const refreshTemplateDropdowns = (): void => {
      const templates = getTemplates();
      ['draft', 'reply'].forEach((prefix) => {
        const select = $(`${prefix}-template`) as HTMLSelectElement;
        if (!select) return;
        const currentVal = select.value;
        select.innerHTML = '<option value="">Templates...</option>';
        const type = prefix as 'draft' | 'reply';
        templates
          .filter((t) => t.type === type || t.type === 'both')
          .forEach((t) => {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = t.name;
            select.appendChild(opt);
          });
        select.value = currentVal;
      });
    }

    refreshTemplateDropdowns();

    // Load template on select
    ['draft', 'reply'].forEach((prefix) => {
      const select = $(`${prefix}-template`) as HTMLSelectElement;
      const textarea = $(`${prefix}-instructions`) as HTMLTextAreaElement;
      const deleteBtn = $(`btn-delete-${prefix}-template`) as HTMLButtonElement;

      select?.addEventListener('change', () => {
        const id = select.value;
        if (!id) {
          deleteBtn?.classList.add('hidden');
          return;
        }
        const template = getTemplates().find((t) => t.id === id);
        if (template && textarea) {
          textarea.value = template.instructions;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
        deleteBtn?.classList.remove('hidden');
      });

      // Save template — show inline input
      $(`btn-save-${prefix}-template`)?.addEventListener('click', () => {
        const instructions = textarea?.value?.trim();
        if (!instructions) {
          showError('Write some instructions first before saving as a template.');
          return;
        }

        // Create inline name input
        const row = select?.parentElement;
        if (!row) return;

        // Check if input already showing
        if (row.querySelector('.aic-template-name-input')) return;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'aic-select aic-template-select flex-1 aic-template-name-input';
        input.placeholder = 'Template name...';
        input.maxLength = 50;

        // Hide select, show input
        select.classList.add('hidden');
        row.insertBefore(input, select);
        input.focus();

        const finish = (save: boolean): void => {
          const name = input.value.trim();
          input.remove();
          select.classList.remove('hidden');
          if (save && name) {
            saveTemplate({
              name,
              instructions,
              type: prefix as 'draft' | 'reply',
            });
            refreshTemplateDropdowns();
          }
        };

        input.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === 'Enter') finish(true);
          if (e.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(true));
      });

      // Delete template
      $(`btn-delete-${prefix}-template`)?.addEventListener('click', () => {
        const id = select?.value;
        if (!id) return;
        deleteTemplate(id);
        select.value = '';
        deleteBtn?.classList.add('hidden');
        refreshTemplateDropdowns();
      });
    });

    // --- Career profile system ---
    const loadCareerIntoTextarea = (id: string): void => {
      const textarea = $('career-description') as HTMLTextAreaElement | null;
      if (!textarea) return;
      const career = getCareers().find((c) => c.id === id);
      textarea.value = career ? career.description : '';
      textarea.dispatchEvent(new Event('input'));
    };

    const refreshCareerDropdown = (): void => {
      const select = $('career-active') as HTMLSelectElement | null;
      const deleteBtn = $('btn-delete-career') as HTMLButtonElement | null;
      if (!select) return;
      const careers = getCareers();
      select.innerHTML = '<option value="">Career profiles...</option>';
      careers.forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        select.appendChild(opt);
      });
      const activeId = loadSettings().activeCareerId;
      select.value = careers.some((c) => c.id === activeId) ? activeId : '';
      deleteBtn?.classList.toggle('hidden', !select.value);
      loadCareerIntoTextarea(select.value);
    };

    refreshCareerDropdown();

    $('career-active')?.addEventListener('change', () => {
      const select = $('career-active') as HTMLSelectElement | null;
      const deleteBtn = $('btn-delete-career') as HTMLButtonElement | null;
      deleteBtn?.classList.toggle('hidden', !select?.value);
      loadCareerIntoTextarea(select?.value || '');
    });

    $('btn-save-career')?.addEventListener('click', () => {
      const description = ($('career-description') as HTMLTextAreaElement)?.value?.trim() || '';
      if (!description) {
        showError('Write a description first before saving as a career profile.');
        return;
      }

      // Create inline name input (same flow as saving a template)
      const select = $('career-active') as HTMLSelectElement;
      const row = select?.parentElement;
      if (!row) return;

      // Check if input already showing
      if (row.querySelector('.aic-template-name-input')) return;

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'aic-select aic-template-select flex-1 aic-template-name-input';
      input.placeholder = 'Career name...';
      input.maxLength = 50;

      // Hide select, show input
      select.classList.add('hidden');
      row.insertBefore(input, select);
      input.focus();

      const finish = (save: boolean): void => {
        const name = input.value.trim();
        input.remove();
        select.classList.remove('hidden');
        if (save && name) {
          const career = saveCareer({ name, description });
          const current = loadSettings();
          saveSettings({ ...current, activeCareerId: career.id });
          refreshCareerDropdown();
        }
      };

      input.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(true));
    });

    $('btn-delete-career')?.addEventListener('click', () => {
      const select = $('career-active') as HTMLSelectElement | null;
      const id = select?.value;
      if (!id) return;
      deleteCareer(id);
      refreshCareerDropdown();
    });

    // Custom goal field toggle
    ['draft', 'reply'].forEach((prefix) => {
      const goalSelect = $(`${prefix}-goal`) as HTMLSelectElement;
      const customInput = $(`${prefix}-goal-custom`) as HTMLInputElement;
      if (goalSelect && customInput) {
        goalSelect.addEventListener('change', () => {
          if (goalSelect.value === 'custom') {
            customInput.classList.remove('hidden');
            customInput.focus();
          } else {
            customInput.classList.add('hidden');
            customInput.value = '';
          }
        });
      }
    });

    // Live word count updates on contenteditable previews
    ['draft-preview', 'reply-preview'].forEach((id) => {
      $(id)?.addEventListener('input', () => updatePreviewStats(id));
    });

    // Copy-to-clipboard floating buttons
    document.querySelectorAll('.aic-copy-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const targetId = (btn as HTMLElement).dataset.copyTarget;
        if (!targetId) return;
        const target = $(targetId);
        if (!target) return;

        const text = target.innerText || target.textContent || '';
        if (!text.trim()) return;

        try {
          await navigator.clipboard.writeText(text);
          // Show success: swap icon to checkmark
          const originalSvg = btn.innerHTML;
          btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
          btn.classList.add('aic-copy-btn--success');
          setTimeout(() => {
            btn.innerHTML = originalSvg;
            btn.classList.remove('aic-copy-btn--success');
          }, 1500);
        } catch {
          showError('Failed to copy to clipboard.');
        }
      });
    });

    $('btn-dismiss-error')?.addEventListener('click', hideError);
  }
});

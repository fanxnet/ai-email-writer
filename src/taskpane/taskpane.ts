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
import { initGeminiClient, Type } from '../services/gemini';
import { initDeepSeekClient } from '../services/deepseek';
import { generateText, generateJson } from '../services/ai-service';
import { getItemMode } from '../services/outlook';
import { buildGoalText, getTemplates, saveTemplate, deleteTemplate } from '../features/settings';
import {
  generateDraft,
  regenerateDraft,
  refineDraft,
  copyToCompose,
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
  AIComposeSettings,
} from '../features/settings';

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

function showLoading(message?: string, inputLength?: number): void {
  const overlay = $('loading-overlay');
  if (!overlay) return;
  const text = overlay.querySelector('.aic-loading__text') as HTMLElement;
  if (text && message) text.textContent = message;

  const estimate = overlay.querySelector('.aic-loading__estimate') as HTMLElement;
  if (estimate) {
    if (inputLength && inputLength > 0) {
      const seconds = Math.min(30, Math.round(8 + inputLength / 100));
      estimate.textContent = `Estimated time: ~${seconds}s`;
      estimate.classList.remove('hidden');
    } else {
      estimate.classList.add('hidden');
    }
  }

  overlay.classList.remove('aic-loading--fade-out');
  showElement('loading-overlay');
}

function hideLoading(): void {
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
// Email Scoring
// ---------------------------------------------------------------------------

interface EmailScores {
  clarity: number;
  tone: number;
  conciseness: number;
  cta: number;
}

async function scoreEmail(text: string, scoreCardId: string): Promise<void> {
  const card = $(scoreCardId);
  if (!card) return;

  // Show card with loading state
  card.classList.remove('hidden');
  const valueEl = card.querySelector('.aic-score-card__value') as HTMLElement;
  if (valueEl) valueEl.textContent = '...';

  // Small delay to avoid rate-limiting with the generation call
  await new Promise((r) => setTimeout(r, 500));

  try {
    console.log('[Score] Requesting score...');
    const provider = loadSettings().aiProvider;
    const scoreModel = provider === 'deepseek' ? 'deepseek-v4-flash' : 'gemini-2.5-flash';

    const parsed = await generateJson<EmailScores>(
      `Score this email:\n\n${text.slice(0, 1500)}`,
      {
        model: scoreModel,
        systemInstruction: 'You are an email quality scorer. Score emails on clarity, tone, conciseness, and call-to-action, each from 1 to 10.',
        temperature: 0.1,
        maxOutputTokens: 100,
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            clarity: { type: Type.NUMBER },
            tone: { type: Type.NUMBER },
            conciseness: { type: Type.NUMBER },
            cta: { type: Type.NUMBER },
          },
          required: ['clarity', 'tone', 'conciseness', 'cta'],
        },
      },
    );

    console.log('[Score] Parsed:', parsed);

    const clamp = (v: number): number => Math.min(10, Math.max(1, Math.round(v)));
    const scores = {
      clarity: clamp(Number(parsed.clarity) || 7),
      tone: clamp(Number(parsed.tone) || 7),
      conciseness: clamp(Number(parsed.conciseness) || 7),
      cta: clamp(Number(parsed.cta) || 7),
    };

    const overall = Math.round(
      (scores.clarity + scores.tone + scores.conciseness + scores.cta) / 4
    );

    // Color based on score
    const scoreColor = (s: number): string =>
      s >= 7 ? '#22c55e' : s >= 5 ? '#eab308' : '#ef4444';

    // Update circle
    const color = scoreColor(overall);
    card.style.setProperty('--aic-score-color', color);
    if (valueEl) valueEl.textContent = `${overall}`;

    // Update bars
    const dims: Record<string, number> = scores;
    card.querySelectorAll('.aic-score-bar').forEach((bar) => {
      const dim = (bar as HTMLElement).dataset.dim || '';
      const val = dims[dim];
      if (val === undefined) return;
      const fill = bar.querySelector('.aic-score-bar__fill') as HTMLElement;
      const valEl = bar.querySelector('.aic-score-bar__val') as HTMLElement;
      if (fill) {
        fill.style.width = `${val * 10}%`;
        fill.style.background = scoreColor(val);
      }
      if (valEl) valEl.textContent = `${val}`;
    });
  } catch (err) {
    console.warn('[Score] Failed:', err);
    if (valueEl) valueEl.textContent = '—';
  }
}

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

  // Auto-load email context when switching to Reply tab
  if (tabName === 'reply') {
    loadReplyContext();
  }
}

// ---------------------------------------------------------------------------
// Reply context loader
// ---------------------------------------------------------------------------

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
    instructions: instructions + goalText,
    tone, length, language,
  };

  hideError();
  showLoading('Generating with Gemini...', instructions.length);

  try {
    const draft = await generateDraft(options);
    setPreview('draft-preview', draft);
    void scoreEmail(draft, 'draft-score');
    showElement('result-section');
    $('result-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err: any) {
    showError(err.message || 'Failed to generate draft. Please try again.');
  } finally {
    hideLoading();
  }
}

async function handleRegenerate(): Promise<void> {
  hideError();
  showLoading('Regenerating...');

  try {
    const draft = await regenerateDraft();
    setPreview('draft-preview', draft);
    void scoreEmail(draft, 'draft-score');
  } catch (err: any) {
    showError(err.message || 'Failed to regenerate. Please try again.');
  } finally {
    hideLoading();
  }
}

async function handleRefine(): Promise<void> {
  const input = $('refine-input') as HTMLInputElement;
  const refinement = input?.value || '';

  if (!refinement.trim()) {
    showError('Please enter refinement instructions.');
    return;
  }

  hideError();
  showLoading('Refining...');

  try {
    const draft = await refineDraft(refinement);
    setPreview('draft-preview', draft);
    void scoreEmail(draft, 'draft-score');
    if (input) input.value = '';
  } catch (err: any) {
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

async function handleGenerateReply(): Promise<void> {
  const instructions = ($('reply-instructions') as HTMLTextAreaElement)?.value || '';
  const tone = ($('reply-tone') as HTMLSelectElement)?.value || 'professional';
  const includeOriginal = ($('reply-include-original') as HTMLInputElement)?.checked ?? true;
  const language = ($('reply-language') as HTMLSelectElement)?.value || 'auto';
  const goal = ($('reply-goal') as HTMLSelectElement)?.value || 'none';
  const customGoal = ($('reply-goal-custom') as HTMLInputElement)?.value || '';
  const goalText = buildGoalText(goal, customGoal);

  const options: DraftReplyOptions = {
    instructions: instructions + goalText,
    tone, includeOriginal, language,
  };

  hideError();
  showLoading('Generating reply with Gemini...', instructions.length);

  try {
    const reply = await generateReply(options);
    setPreview('reply-preview', reply);
    void scoreEmail(reply, 'reply-score');
    showElement('reply-result-section');
    $('reply-result-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // In compose mode, Reply All is redundant — user already chose reply type
    if (getItemMode() === 'compose') {
      hideElement('btn-insert-reply-all');
    }
  } catch (err: any) {
    showError(err.message || 'Failed to generate reply. Please try again.');
  } finally {
    hideLoading();
  }
}

async function handleRegenerateReply(): Promise<void> {
  hideError();
  showLoading('Regenerating reply...');

  try {
    const reply = await regenerateReply();
    setPreview('reply-preview', reply);
    void scoreEmail(reply, 'reply-score');
  } catch (err: any) {
    showError(err.message || 'Failed to regenerate reply. Please try again.');
  } finally {
    hideLoading();
  }
}

async function handleRefineReply(): Promise<void> {
  const input = $('reply-refine-input') as HTMLInputElement;
  const refinement = input?.value || '';

  if (!refinement.trim()) {
    showError('Please enter refinement instructions.');
    return;
  }

  hideError();
  showLoading('Refining reply...');

  try {
    const reply = await refineReply(refinement);
    setPreview('reply-preview', reply);
    void scoreEmail(reply, 'reply-score');
    if (input) input.value = '';
  } catch (err: any) {
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
  container.classList.add('hidden');
  container.innerHTML = '';

  try {
    const { getEmailContext } = await import('../features/draft-reply');
    const context = await getEmailContext();

    const emailSummary = `From: ${context.sender.name} <${context.sender.email}>\nSubject: ${context.subject}\n\n${context.body}`.slice(0, 2000);

    const prompt = `Read this email and suggest exactly 3 short reply sentences (5-12 words each) that the user could send back as a response.
Each suggestion should be an actual reply message, NOT an email client action like archiving or unsubscribing.
Return ONLY 3 lines, one suggestion per line. No numbering, no bullets, no quotes, no extra text.

Email:
${emailSummary}`;

    const result = await generateText(prompt, {
      temperature: 0.9,
      maxOutputTokens: 1024,
    });

    console.log('[Suggest replies] Raw response:', result);

    // Parse line-separated suggestions — strip any numbering, bullets, or quotes
    const suggestions = result
      .split('\n')
      .map((line) => line.replace(/^\d+[\.\)\-]\s*/, '').replace(/^[-•*]\s*/, '').replace(/^["']|["']$/g, '').trim())
      .filter((line) => line.length > 5 && line.length < 120)
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

    container.classList.remove('hidden');
  } catch (err: any) {
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

  const options: SummarizeOptions = { style, length };

  hideError();
  showLoading('Summarizing with Gemini...');

  try {
    const summary = await summarizeThread(options);
    setPreview('summary-preview', summary);
    showElement('summarize-result-section');
    $('summarize-result-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err: any) {
    showError(err.message || 'Failed to summarize. Please try again.');
  } finally {
    hideLoading();
  }
}

async function handleRegenerateSummary(): Promise<void> {
  hideError();
  showLoading('Regenerating summary...');

  try {
    const summary = await regenerateSummary();
    setPreview('summary-preview', summary);
  } catch (err: any) {
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
  showLoading('Improving with Gemini...');

  try {
    const result = await improveWriting(options);
    const diffContainer = $('improve-diff');
    if (diffContainer) {
      diffContainer.innerHTML = generateDiffHtml(result.original, result.improved);
    }
    showElement('improve-result-section');
    $('improve-result-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err: any) {
    showError(err.message || 'Failed to improve text. Please try again.');
  } finally {
    hideLoading();
  }
}

async function handleRegenerateImprove(): Promise<void> {
  hideError();
  showLoading('Regenerating improvement...');

  try {
    const result = await regenerateImprovement();
    const diffContainer = $('improve-diff');
    if (diffContainer) {
      diffContainer.innerHTML = generateDiffHtml(result.original, result.improved);
    }
  } catch (err: any) {
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

  try {
    const items = await extractActionItems();
    const container = $('extract-checklist');
    if (container) {
      container.innerHTML = renderChecklistHtml(items);
    }
    showElement('extract-result-section');
    $('extract-result-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err: any) {
    showError(err.message || 'Failed to extract action items.');
  } finally {
    hideLoading();
  }
}

async function handleRegenerateExtract(): Promise<void> {
  hideError();
  showLoading('Re-scanning for action items...');

  try {
    const items = await regenerateActions();
    const container = $('extract-checklist');
    if (container) {
      container.innerHTML = renderChecklistHtml(items);
    }
  } catch (err: any) {
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

  try {
    const result = await translateEmail(langSelect.value);
    const container = $('translate-output');
    if (container) {
      container.innerHTML = renderTranslationHtml(result);
    }
    showElement('translate-result-section');
    $('translate-result-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err: any) {
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

  try {
    const result = await regenerateTranslation(langSelect.value);
    const container = $('translate-output');
    if (container) {
      container.innerHTML = renderTranslationHtml(result);
    }
  } catch (err: any) {
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
        () => { loadReplyContext(); },
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

      // Summary style radio buttons
      const summaryRadio = document.querySelector(
        `input[name="summary-style"][value="${s.defaultSummaryStyle}"]`,
      ) as HTMLInputElement | null;
      if (summaryRadio) summaryRadio.checked = true;

      // Translation language
      const langSelect = $('translate-language') as HTMLSelectElement | null;
      if (langSelect) langSelect.value = s.defaultLanguage;

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
      if (sTone) sTone.value = s.defaultTone;
      if (sStyle) sStyle.value = s.defaultSummaryStyle;
      if (sLang) sLang.value = s.defaultLanguage;

      // Rules form
      for (const [key, enabled] of Object.entries(s.presetRules)) {
        const cb = $(`rule-${key}`) as HTMLInputElement | null;
        if (cb) cb.checked = enabled;
      }
      const customRulesEl = $('custom-rules') as HTMLTextAreaElement | null;
      if (customRulesEl) customRulesEl.value = s.customRules;
    };

    applySettingsToForms(settings);

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
    $('btn-generate-reply')?.addEventListener('click', handleGenerateReply);
    $('btn-suggest-replies')?.addEventListener('click', handleSuggestReplies);
    $('btn-regenerate-reply')?.addEventListener('click', handleRegenerateReply);
    $('btn-refine-reply')?.addEventListener('click', handleRefineReply);
    $('btn-insert-reply')?.addEventListener('click', handleInsertReply);
    $('btn-insert-reply-all')?.addEventListener('click', handleInsertReplyAll);

    $('reply-refine-input')?.addEventListener('keydown', (e: Event) => {
      if ((e as KeyboardEvent).key === 'Enter') handleRefineReply();
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
      const language = ($('settings-language') as HTMLSelectElement)?.value || 'English';

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
        defaultLanguage: language,
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

      // Reset all form fields to defaults
      const defaults = loadSettings();
      applySettingsToForms(defaults);

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

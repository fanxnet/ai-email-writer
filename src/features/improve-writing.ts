/**
 * AI Compose — Improve Writing Feature
 *
 * Reads selected text or the full compose body, sends it to Gemini
 * with an improvement focus, and displays a before/after diff.
 * Supports "Accept Changes" to replace the original text.
 *
 * © Rizonetech (Pty) Ltd. — https://rizonesoft.com
 */

/* global Office */

import { generateText } from '../services/ai-service';
import { buildPrompt } from '../prompts/builder';
import { IMPROVE_WRITING_PROMPT } from '../prompts/templates';
import { getCurrentEmailBody, getItemMode } from '../services/outlook';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ImprovementFocus =
  | 'fix_grammar'
  | 'improve_clarity'
  | 'make_concise'
  | 'make_professional';

export interface ImproveOptions {
  focus: ImprovementFocus;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let originalText: string = '';
let improvedText: string = '';
let lastOptions: ImproveOptions | null = null;

// ---------------------------------------------------------------------------
// Focus label mapping
// ---------------------------------------------------------------------------

const FOCUS_LABELS: Record<ImprovementFocus, string> = {
  fix_grammar: 'Fix grammar, spelling, and punctuation errors',
  improve_clarity: 'Improve clarity and readability',
  make_concise: 'Make the text more concise — remove unnecessary words',
  make_professional: 'Make the tone more professional and polished',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the current text and generate an improved version.
 * Tries to read selected text first; falls back to the full body.
 */
export async function improveWriting(options: ImproveOptions): Promise<{
  original: string;
  improved: string;
}> {
  const text = await readSourceText();

  if (!text.trim()) {
    throw new Error(
      'No text to improve. Select some text or open an email in compose mode.',
    );
  }

  const focusLabel = FOCUS_LABELS[options.focus] || options.focus;

  const prompt = buildPrompt(IMPROVE_WRITING_PROMPT, {
    TEXT: text,
    IMPROVEMENT_FOCUS: focusLabel,
  });

  const result = await generateText(prompt, {
    temperature: 0.3,
    maxOutputTokens: 2048,
  });

  originalText = text;
  improvedText = result;
  lastOptions = { ...options };

  return { original: text, improved: result };
}

/**
 * Re-run the improvement with the same options.
 */
export async function regenerateImprovement(): Promise<{
  original: string;
  improved: string;
}> {
  if (!lastOptions) {
    throw new Error('No previous improvement to regenerate.');
  }
  return improveWriting(lastOptions);
}

/**
 * Accept the improved text — replace the body in compose mode.
 * In read mode, copies to clipboard instead.
 */
export async function acceptChanges(): Promise<'replaced' | 'copied'> {
  if (!improvedText) {
    throw new Error('No improved text to accept.');
  }

  const mode = getItemMode();

  if (mode === 'compose') {
    await replaceComposeBody(improvedText);
    return 'replaced';
  } else {
    // Read mode — copy to clipboard
    await copyToClipboard(improvedText);
    return 'copied';
  }
}

/**
 * Returns the current original and improved text.
 */
export function getTexts(): { original: string; improved: string } {
  return { original: originalText, improved: improvedText };
}

// ---------------------------------------------------------------------------
// Text reading
// ---------------------------------------------------------------------------

async function readSourceText(): Promise<string> {
  // Try to get selected text in compose mode first
  const mode = getItemMode();

  if (mode === 'compose') {
    try {
      const selected = await getSelectedText();
      if (selected.trim()) return selected;
    } catch {
      // Fall through to full body
    }
  }

  // Fall back to full body
  return getCurrentEmailBody();
}

function getSelectedText(): Promise<string> {
  return new Promise((resolve, reject) => {
    const item = Office.context.mailbox.item;
    if (!item) {
      reject(new Error('No mailbox item'));
      return;
    }

    // getSelectedDataAsync is available in compose mode
    if (typeof (item as any).getSelectedDataAsync === 'function') {
      (item as any).getSelectedDataAsync(
        Office.CoercionType.Text,
        (result: Office.AsyncResult<any>) => {
          if (result.status === Office.AsyncResultStatus.Succeeded) {
            resolve(result.value.data || '');
          } else {
            reject(new Error(result.error?.message || 'Failed to get selected text'));
          }
        },
      );
    } else {
      resolve('');
    }
  });
}

// ---------------------------------------------------------------------------
// Body replacement
// ---------------------------------------------------------------------------

function replaceComposeBody(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const item = Office.context.mailbox.item;
    if (!item || !('body' in item)) {
      reject(new Error('Cannot access compose body'));
      return;
    }

    (item as any).body.setAsync(
      text,
      { coercionType: Office.CoercionType.Text },
      (result: Office.AsyncResult<void>) => {
        if (result.status === Office.AsyncResultStatus.Succeeded) {
          resolve();
        } else {
          reject(new Error(result.error?.message || 'Failed to replace body'));
        }
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

async function copyToClipboard(text: string): Promise<void> {
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

// ---------------------------------------------------------------------------
// Simple diff — highlights changes between original and improved
// ---------------------------------------------------------------------------

/**
 * Generate a lightweight HTML diff view.
 * Uses word-level comparison to mark additions and removals.
 */
export function generateDiffHtml(original: string, improved: string): string {
  const origWords = tokenize(original);
  const impWords = tokenize(improved);

  const { added, removed, unchanged } = diffWords(origWords, impWords);

  // Build original side (with removed highlights)
  const origHtml = buildSideHtml(origWords, removed, 'aic-diff__del');
  const impHtml = buildSideHtml(impWords, added, 'aic-diff__ins');

  return `
    <div class="aic-diff">
      <div class="aic-diff__panel">
        <div class="aic-diff__label">Original</div>
        <div class="aic-diff__content">${origHtml}</div>
      </div>
      <div class="aic-diff__panel aic-diff__panel--improved">
        <div class="aic-diff__label">Improved</div>
        <div class="aic-diff__content">${impHtml}</div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Diff internals
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  // Split into words, preserving whitespace and punctuation as tokens
  return text.match(/\S+|\s+/g) || [];
}

interface DiffResult {
  added: Set<number>;
  removed: Set<number>;
  unchanged: Set<number>;
}

/**
 * Simple LCS-based word diff (good enough for typical email text).
 */
function diffWords(origTokens: string[], impTokens: string[]): DiffResult {
  const m = origTokens.length;
  const n = impTokens.length;

  // Build LCS table (bounded for performance)
  const MAX = 500;
  if (m > MAX || n > MAX) {
    // For very long texts, mark everything as changed
    return {
      removed: new Set(Array.from({ length: m }, (_, i) => i)),
      added: new Set(Array.from({ length: n }, (_, i) => i)),
      unchanged: new Set(),
    };
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (origTokens[i - 1] === impTokens[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find LCS members
  const origInLCS = new Set<number>();
  const impInLCS = new Set<number>();
  let i = m;
  let j = n;

  while (i > 0 && j > 0) {
    if (origTokens[i - 1] === impTokens[j - 1]) {
      origInLCS.add(i - 1);
      impInLCS.add(j - 1);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  const removed = new Set<number>();
  const added = new Set<number>();
  const unchanged = new Set<number>();

  for (let idx = 0; idx < m; idx++) {
    if (origInLCS.has(idx)) {
      unchanged.add(idx);
    } else {
      removed.add(idx);
    }
  }

  for (let idx = 0; idx < n; idx++) {
    if (!impInLCS.has(idx)) {
      added.add(idx);
    }
  }

  return { added, removed, unchanged };
}

function buildSideHtml(
  tokens: string[],
  highlighted: Set<number>,
  cls: string,
): string {
  return tokens
    .map((token, i) => {
      const escaped = escapeHtml(token);
      if (highlighted.has(i)) {
        return `<span class="${cls}">${escaped}</span>`;
      }
      return escaped;
    })
    .join('');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

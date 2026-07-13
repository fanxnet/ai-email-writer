/**
 * AI Compose — Quick Translate Feature
 *
 * Reads the current email body, translates it to the selected language
 * using Gemini, and displays the result side-by-side with the original.
 *
 * © Rizonetech (Pty) Ltd. — https://rizonesoft.com
 */

import { generateText, FAST_MODEL } from '../services/ai-service';
import { buildPrompt } from '../prompts/builder';
import { TRANSLATE_PROMPT } from '../prompts/templates';
import { getCurrentEmailBody } from '../services/outlook';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranslateResult {
  original: string;
  translated: string;
  targetLanguage: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LANGUAGES = [
  { code: 'af', name: 'Afrikaans' },
  { code: 'ar', name: 'Arabic' },
  { code: 'zh', name: 'Chinese (Simplified)' },
  { code: 'zh-TW', name: 'Chinese (Traditional)' },
  { code: 'nl', name: 'Dutch' },
  { code: 'en', name: 'English' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'hi', name: 'Hindi' },
  { code: 'it', name: 'Italian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'pl', name: 'Polish' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ru', name: 'Russian' },
  { code: 'es', name: 'Spanish' },
  { code: 'sw', name: 'Swahili' },
  { code: 'tr', name: 'Turkish' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'zu', name: 'Zulu' },
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let lastResult: TranslateResult | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Translate the current email body to the target language.
 */
export async function translateEmail(targetLanguage: string): Promise<TranslateResult> {
  const body = await getCurrentEmailBody();

  if (!body.trim()) {
    throw new Error('No email content found. Please open an email first.');
  }

  const prompt = buildPrompt(TRANSLATE_PROMPT, {
    TEXT: body,
    TARGET_LANGUAGE: targetLanguage,
  });

  const translated = await generateText(prompt, {
    temperature: 0.3,
    maxOutputTokens: 4096,
    model: FAST_MODEL,
  });

  lastResult = {
    original: body,
    translated,
    targetLanguage,
  };

  return lastResult;
}

/**
 * Re-translate with the same or different language.
 */
export async function regenerateTranslation(targetLanguage: string): Promise<TranslateResult> {
  return translateEmail(targetLanguage);
}

/**
 * Get the last translation result.
 */
export function getLastResult(): TranslateResult | null {
  return lastResult;
}

/**
 * Render side-by-side translation HTML.
 */
export function renderTranslationHtml(result: TranslateResult): string {
  return `
    <div class="aic-translate-view">
      <div class="aic-translate-panel">
        <div class="aic-translate-panel__label">Original</div>
        <div class="aic-translate-panel__text">${escapeHtml(result.original)}</div>
      </div>
      <div class="aic-translate-panel aic-translate-panel--target">
        <div class="aic-translate-panel__label">${escapeHtml(result.targetLanguage)}</div>
        <div class="aic-translate-panel__text">${escapeHtml(result.translated)}</div>
      </div>
    </div>`;
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

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

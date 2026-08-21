/**
 * AI Compose — Prompt Builder
 *
 * Utilities for constructing prompts from templates with variable
 * substitution and safe context truncation.
 *
 * © Rizonetech (Pty) Ltd. — https://rizonesoft.com
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A record of placeholder names (without braces) to their values. */
export type PromptVariables = Record<string, string>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Rough estimate: 1 token ≈ 4 characters for English text.
 * This is a conservative approximation used for truncation.
 */
const CHARS_PER_TOKEN = 4;

/** Suffix appended when text is truncated. */
const TRUNCATION_SUFFIX = '\n\n[Content truncated due to length…]';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Replace `{{PLACEHOLDER}}` markers in a template with the provided values.
 *
 * - Placeholders are case-sensitive and matched exactly.
 * - Missing variables are left as-is (e.g. `{{UNKNOWN}}` stays in the output).
 * - Extra variables not present in the template are silently ignored.
 *
 * @param template  - The prompt template string with `{{VAR}}` placeholders.
 * @param variables - A key-value map of placeholder names to replacement values.
 * @returns The fully interpolated prompt string.
 *
 * @example
 * ```ts
 * buildPrompt('Hello {{NAME}}, your order {{ID}} is ready.', {
 *   NAME: 'Alice',
 *   ID: '12345',
 * });
 * // → 'Hello Alice, your order 12345 is ready.'
 * ```
 */
export function buildPrompt(template: string, variables: PromptVariables): string {
  if (!template) {
    throw new Error('Prompt template cannot be empty.');
  }

  let result = template;

  for (const [key, value] of Object.entries(variables)) {
    const placeholder = `{{${key}}}`;
    result = result.split(placeholder).join(value);
  }

  return result;
}

/**
 * Safely truncate text to fit within an approximate token budget.
 *
 * Truncation is performed at sentence boundaries when possible to avoid
 * cutting mid-sentence. A suffix is appended to indicate that content
 * was removed.
 *
 * @param text      - The text to truncate.
 * @param maxTokens - The maximum number of tokens allowed.
 * @returns The (possibly truncated) text.
 *
 * @example
 * ```ts
 * truncateContext('A very long email body...', 500);
 * // → First ~2000 chars, ending at a sentence boundary + truncation notice
 * ```
 */
export function truncateContext(text: string, maxTokens: number): string {
  if (!text) return text;
  if (maxTokens <= 0) {
    throw new Error('maxTokens must be a positive number.');
  }

  const maxChars = maxTokens * CHARS_PER_TOKEN;

  // No truncation needed
  if (text.length <= maxChars) {
    return text;
  }

  // Reserve space for the truncation suffix
  const availableChars = maxChars - TRUNCATION_SUFFIX.length;

  if (availableChars <= 0) {
    return TRUNCATION_SUFFIX.trim();
  }

  // Try to truncate at a sentence boundary
  const slice = text.slice(0, availableChars);
  const lastSentenceEnd = findLastSentenceBoundary(slice);

  const truncated = lastSentenceEnd > 0 ? slice.slice(0, lastSentenceEnd) : slice;

  return truncated.trimEnd() + TRUNCATION_SUFFIX;
}

/**
 * List all placeholder names found in a template.
 *
 * @param template - The prompt template string.
 * @returns An array of unique placeholder names (without braces).
 *
 * @example
 * ```ts
 * listPlaceholders('Hello {{NAME}}, your {{ITEM}} is {{STATUS}}.');
 * // → ['NAME', 'ITEM', 'STATUS']
 * ```
 */
export function listPlaceholders(template: string): string[] {
  const matches = template.match(/\{\{([A-Z_][A-Z0-9_]*)\}\}/g);
  if (!matches) return [];

  const names = matches.map((m) => m.slice(2, -2));
  return Array.from(new Set(names));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Find the index just after the last sentence-ending punctuation
 * (., !, or ?) in the given text.
 * Returns -1 if no sentence boundary is found.
 */
function findLastSentenceBoundary(text: string): number {
  // Match period, exclamation, or question mark followed by space or end-of-string
  for (let i = text.length - 1; i >= 0; i--) {
    const char = text[i];
    if (char === '.' || char === '!' || char === '?') {
      return i + 1;
    }
  }
  return -1;
}

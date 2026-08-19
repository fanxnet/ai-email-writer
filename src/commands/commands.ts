/**
 * AI Compose — Add-in Commands (Function Commands)
 *
 * Registers ExecuteFunction handlers for compose-mode ribbon buttons.
 * These run silently (no taskpane) on the user's selected text:
 *   - Fix Grammar & Spelling
 *   - Improve Clarity
 *   - Make Concise
 *   - Make Professional
 *
 * © Rizonetech (Pty) Ltd. — https://rizonesoft.com
 */

/* global Office */

import { generateText } from '../services/ai-service';
import { buildPrompt } from '../prompts/builder';
import { IMPROVE_WRITING_PROMPT } from '../prompts/templates';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ImprovementFocus =
  | 'fix_grammar'
  | 'improve_clarity'
  | 'make_concise'
  | 'make_professional';

const FOCUS_LABELS: Record<ImprovementFocus, string> = {
  fix_grammar: 'Fix grammar, spelling, and punctuation errors',
  improve_clarity: 'Improve clarity and readability',
  make_concise: 'Make the text more concise — remove unnecessary words',
  make_professional: 'Make the tone more professional and polished',
};

// ---------------------------------------------------------------------------
// Core helper — improve selected text in-place
// ---------------------------------------------------------------------------

/**
 * Read the selected text in compose mode, send it to the configured AI
 * provider with the given improvement focus, and replace the selection with
 * the improved version.
 */
async function improveSelectedText(
  focus: ImprovementFocus,
  event: Office.AddinCommands.Event,
): Promise<void> {
  const item = Office.context.mailbox.item;

  if (!item) {
    showNotification('No email is open.', event);
    return;
  }

  try {
    // 1. Read the selected text
    const selectedText = await getSelectedText(item);

    if (!selectedText.trim()) {
      showNotification('Please select some text first.', event);
      return;
    }

    // 2. Build the prompt and call the selected AI provider
    const focusLabel = FOCUS_LABELS[focus];
    const prompt = buildPrompt(IMPROVE_WRITING_PROMPT, {
      TEXT: selectedText,
      IMPROVEMENT_FOCUS: focusLabel,
    });

    const improved = await generateText(prompt, {
      temperature: 0.3,
      maxOutputTokens: 2048,
    });

    // 3. Replace the selected text with the improved version
    await setSelectedText(item, improved);

    showNotification('✓ Text improved', event);
  } catch (err: any) {
    const message = err?.message || 'Failed to improve text.';
    showNotification(`Error: ${message}`, event);
  }
}

// ---------------------------------------------------------------------------
// Office.js helpers
// ---------------------------------------------------------------------------

function getSelectedText(item: any): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof item.getSelectedDataAsync !== 'function') {
      reject(new Error('Selection API not available. Ensure you are in compose mode.'));
      return;
    }

    item.getSelectedDataAsync(
      Office.CoercionType.Text,
      (result: Office.AsyncResult<any>) => {
        if (result.status === Office.AsyncResultStatus.Succeeded) {
          resolve(result.value?.data || '');
        } else {
          reject(new Error(result.error?.message || 'Failed to read selected text'));
        }
      },
    );
  });
}

function setSelectedText(item: any, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!item.body || typeof item.body.setSelectedDataAsync !== 'function') {
      reject(new Error('Cannot write to compose body.'));
      return;
    }

    item.body.setSelectedDataAsync(
      text,
      { coercionType: Office.CoercionType.Text },
      (result: Office.AsyncResult<void>) => {
        if (result.status === Office.AsyncResultStatus.Succeeded) {
          resolve();
        } else {
          reject(new Error(result.error?.message || 'Failed to replace text'));
        }
      },
    );
  });
}

function showNotification(message: string, event: Office.AddinCommands.Event): void {
  const item = Office.context.mailbox.item;

  if (item) {
    item.notificationMessages.replaceAsync('AIComposeNotification', {
      type: Office.MailboxEnums.ItemNotificationMessageType.InformationalMessage,
      message,
      icon: 'Icon.16x16',
      persistent: false,
    } as Office.NotificationMessageDetails);
  }

  event.completed();
}

// ---------------------------------------------------------------------------
// Function command handlers
// ---------------------------------------------------------------------------

function fixGrammar(event: Office.AddinCommands.Event): void {
  improveSelectedText('fix_grammar', event);
}

function improveClarity(event: Office.AddinCommands.Event): void {
  improveSelectedText('improve_clarity', event);
}

function makeConcise(event: Office.AddinCommands.Event): void {
  improveSelectedText('make_concise', event);
}

function makeProfessional(event: Office.AddinCommands.Event): void {
  improveSelectedText('make_professional', event);
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

Office.onReady(() => {
  // Register all function commands with Office
  Office.actions.associate('fixGrammar', fixGrammar);
  Office.actions.associate('improveClarity', improveClarity);
  Office.actions.associate('makeConcise', makeConcise);
  Office.actions.associate('makeProfessional', makeProfessional);
});

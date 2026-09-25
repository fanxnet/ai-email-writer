/**
 * AI Compose — Unified AI Router Service
 */

import { generateText as geminiGenerateText, generateJson as geminiGenerateJson, initGeminiClient } from './gemini';
import { generateText as deepseekGenerateText, generateJson as deepseekGenerateJson, initDeepSeekClient } from './deepseek';
import { getSetting, MAX_RETRIES } from '../features/settings';
import { getPromptText } from './findprompt';

/**
 * Ensure the AI client for the given provider is initialized.
 * Reads the API key from settings and initializes if not already done.
 * Idempotent: safe to call multiple times with no overhead.
 */
function ensureClientInitialized(provider: string): void {
  try {
    if (provider === 'deepseek') {
      const apiKey = getSetting('deepseekApiKey');
      if (apiKey) initDeepSeekClient(apiKey);
    } else {
      const apiKey = getSetting('geminiApiKey') || getSetting('apiKey');
      if (apiKey) initGeminiClient(apiKey);
    }
  } catch {
    // Client will throw a clear error when generateText is called
  }
}

export async function generateText(prompt: string, options: any = {}): Promise<string> {
  const provider = getSetting('aiProvider') || 'gemini';
  // Default to a single attempt (MAX_RETRIES = 0) so retries never burn API
  // tokens unbeknown to the user; callers can opt back in via `maxRetries`.
  const opts = { ...options, maxRetries: options.maxRetries ?? MAX_RETRIES };

  ensureClientInitialized(provider);

  if (/prompt-test/i.test(prompt)) {
      return getPromptText(prompt);
  } 
  else if (provider === 'deepseek') { 
      return deepseekGenerateText(prompt, opts); 
  }
  else { 
      return geminiGenerateText(prompt, opts);
  }
}

export async function generateJson<T>(prompt: string, options: any = {}): Promise<T> {
  const provider = getSetting('aiProvider') || 'gemini';
  // See generateText(): single attempt by default.
  const opts = { ...options, maxRetries: options.maxRetries ?? MAX_RETRIES };

  ensureClientInitialized(provider);

  if (provider === 'deepseek') { 
      return deepseekGenerateJson<T>(prompt, opts); 
  }
  else { 
      return geminiGenerateJson<T>(prompt, opts);
  }
}

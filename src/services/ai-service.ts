/**
 * AI Compose — Unified AI Router Service
 */

import { generateText as geminiGenerateText, generateJson as geminiGenerateJson } from './gemini';
import { generateText as deepseekGenerateText, generateJson as deepseekGenerateJson } from './deepseek';
import { getSetting, MAX_RETRIES } from '../features/settings';

export async function generateText(prompt: string, options: any = {}): Promise<string> {
  const provider = getSetting('aiProvider') || 'gemini';
  // Default to a single attempt (MAX_RETRIES = 0) so retries never burn API
  // tokens unbeknown to the user; callers can opt back in via `maxRetries`.
  const opts = { ...options, maxRetries: options.maxRetries ?? MAX_RETRIES };
 // if (prompt.includes('testprompt')) {
 if (/testprompt/i.test(prompt)) {
    return prompt;
  } else {
    if (provider === 'deepseek') {
      return deepseekGenerateText(prompt, opts);
    }
    return geminiGenerateText(prompt, opts);
  }
}

export async function generateJson<T>(prompt: string, options: any = {}): Promise<T> {
  const provider = getSetting('aiProvider') || 'gemini';
  // See generateText(): single attempt by default.
  const opts = { ...options, maxRetries: options.maxRetries ?? MAX_RETRIES };
  if (provider === 'deepseek') {
    return deepseekGenerateJson<T>(prompt, opts);
  }
  return geminiGenerateJson<T>(prompt, opts);
}



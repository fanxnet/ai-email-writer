/**
 * AI Compose — Unified AI Router Service
 */

import { generateText as geminiGenerateText, generateJson as geminiGenerateJson } from './gemini';
import { generateText as deepseekGenerateText, generateJson as deepseekGenerateJson } from './deepseek';
import { getSetting } from '../features/settings';

export async function generateText(prompt: string, options: any = {}): Promise<string> {
  const provider = getSetting('aiProvider') || 'gemini';
  if (provider === 'deepseek') {
    return deepseekGenerateText(prompt, options);
  }
  return geminiGenerateText(prompt, options);
}

export async function generateJson<T>(prompt: string, options: any = {}): Promise<T> {
  const provider = getSetting('aiProvider') || 'gemini';
  if (provider === 'deepseek') {
    return deepseekGenerateJson<T>(prompt, options);
  }
  return geminiGenerateJson<T>(prompt, options);
}

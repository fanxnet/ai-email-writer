/**
 * AI Compose — DeepSeek Client Service
 *
 * Provides a typed interface to the DeepSeek API.
 */

import { getSetting } from '../features/settings';

let deepseekApiKey = '';

export function initDeepSeekClient(apiKey: string): void {
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error('API key is required for DeepSeek.');
  }
  deepseekApiKey = apiKey;
}

export class DeepSeekError extends Error {
  code: string;
  retryable: boolean;
  statusCode?: number;

  constructor(message: string, code: string, retryable = false, statusCode?: number) {
    super(message);
    this.name = 'DeepSeekError';
    this.code = code;
    this.retryable = retryable;
    this.statusCode = statusCode;
  }
}

export async function generateText(
  prompt: string,
  options: any = {},
): Promise<string> {
  if (!deepseekApiKey) {
    throw new Error('DeepSeek client not initialised. Call initDeepSeekClient first.');
  }
  const modelName = options.model ?? getSetting('defaultModel') ?? 'deepseek-v4-flash';

  const callFn = async () => {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${deepseekApiKey}`
      },
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: prompt }],
        temperature: options.temperature ?? 1.0,
        max_tokens: options.maxOutputTokens ?? 2048,
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new DeepSeekError(`DeepSeek API error: ${response.status} - ${errText}`, 'API_ERROR', response.status >= 500, response.status);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error('The model returned an empty response.');
    }
    return text;
  };

  return retryWithBackoff(callFn);
}

export async function generateJson<T = Record<string, unknown>>(
  prompt: string,
  options: any = {},
): Promise<T> {
  if (!deepseekApiKey) {
    throw new Error('DeepSeek client not initialised. Call initDeepSeekClient first.');
  }
  const modelName = options.model ?? getSetting('defaultModel') ?? 'deepseek-v4-flash';

  const callFn = async () => {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${deepseekApiKey}`
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          ...(options.systemInstruction ? [{ role: 'system', content: options.systemInstruction }] : []),
          { role: 'user', content: prompt }
        ],
        temperature: options.temperature ?? 0.1,
        max_tokens: options.maxOutputTokens ?? 1024,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new DeepSeekError(`DeepSeek API error: ${response.status} - ${errText}`, 'API_ERROR', response.status >= 500, response.status);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error('The model returned an empty response.');
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]) as T;
      }
      throw new Error(`Model returned invalid JSON: ${text.slice(0, 100)}`);
    }
  };

  return retryWithBackoff(callFn);
}

async function retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
  let delay = 1000;
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      if (attempt === 3 || (error instanceof DeepSeekError && !error.retryable)) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
  throw new Error('Failed after retries');
}

/**
 * AI Compose — Settings Service Unit Tests
 *
 * Covers persistence and the automatic client (re)initialization on save.
 * The key regression this guards: switching providers must initialize the
 * newly active provider's client even when the stored API key is unchanged.
 */

import { saveSettings, loadSettings, resetSettings, getSetting, AIComposeSettings } from './settings';
import { initGeminiClient } from '../services/gemini';
import { initDeepSeekClient } from '../services/deepseek';

jest.mock('../services/gemini', () => ({
  initGeminiClient: jest.fn(),
}));

jest.mock('../services/deepseek', () => ({
  initDeepSeekClient: jest.fn(),
}));

type Provider = AIComposeSettings['aiProvider'];

const mockInitGemini = initGeminiClient as jest.Mock;
const mockInitDeepSeek = initDeepSeekClient as jest.Mock;

// ---------------------------------------------------------------------------
// localStorage mock (jest testEnvironment is node, not jsdom)
// ---------------------------------------------------------------------------

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  get length(): number {
    return this.store.size;
  }
}

function makeSettings(overrides: Partial<AIComposeSettings> = {}): AIComposeSettings {
  return {
    aiProvider: 'gemini' as Provider,
    geminiApiKey: '',
    deepseekApiKey: '',
    apiKey: '',
    defaultModel: 'gemini-flash-latest',
    defaultTone: 'professional',
    defaultSummaryStyle: 'bullets',
    defaultLanguage: 'English',
    replyLanguage: 'auto',
    draftLanguage: 'English',
    presetRules: {
      noPlaceholders: true,
      noSignature: true,
      noSubjectLine: false,
      keepShort: false,
      useSimpleLanguage: false,
    },
    customRules: '',
    activeCareerId: '',
    conversationContextEnabled: true,
    reasoningMode: 'off',
    replyStyleMode: 'match-original',
    ...overrides,
  };
}

beforeEach(() => {
  (global as unknown as { localStorage: Storage }).localStorage = new MemoryStorage() as unknown as Storage;
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('saveSettings / loadSettings', () => {
  test('persists and reads back the saved settings', () => {
    saveSettings(makeSettings({ defaultTone: 'friendly', defaultLanguage: '中文' }));
    const loaded = loadSettings();
    expect(loaded.defaultTone).toBe('friendly');
    expect(loaded.defaultLanguage).toBe('中文');
  });

  test('getSetting returns the stored value for a key', () => {
    saveSettings(makeSettings({ aiProvider: 'deepseek' }));
    expect(getSetting('aiProvider')).toBe('deepseek');
  });

  test('resetSettings clears persisted settings and falls back to defaults', () => {
    saveSettings(makeSettings({ defaultTone: 'friendly' }));
    resetSettings();
    expect(loadSettings().defaultTone).toBe('professional');
  });

  test('replyLanguage defaults to auto and persists a round-trip', () => {
    const s1 = loadSettings();
    expect(s1.replyLanguage).toBe('auto');

    saveSettings(makeSettings({ replyLanguage: 'Chinese (Simplified)' }));
    const s2 = loadSettings();
    expect(s2.replyLanguage).toBe('Chinese (Simplified)');
  });

  test('draftLanguage defaults to English and persists a round-trip', () => {
    const s1 = loadSettings();
    expect(s1.draftLanguage).toBe('English');

    saveSettings(makeSettings({ draftLanguage: 'Japanese' }));
    const s2 = loadSettings();
    expect(s2.draftLanguage).toBe('Japanese');
  });

  test('legacy stored settings without the new fields fall back to defaults', () => {
    const legacy = makeSettings({ defaultTone: 'friendly' }) as unknown as Record<string, unknown>;
    delete legacy.replyLanguage;
    delete legacy.draftLanguage;
    (global as unknown as { localStorage: Storage }).localStorage.setItem(
      'ai_compose_settings',
      JSON.stringify(legacy),
    );

    // Fresh module instance → cold cache → reads the legacy raw storage.
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fresh = require('./settings') as typeof import('./settings');
      const loaded = fresh.loadSettings();
      expect(loaded.replyLanguage).toBe('auto');
      expect(loaded.draftLanguage).toBe('English');
      expect(loaded.defaultTone).toBe('friendly');
    });
  });
});

// ---------------------------------------------------------------------------
// Client (re)initialization on save
// ---------------------------------------------------------------------------

describe('client initialization on save', () => {
  test('initializes the Gemini client when provider is gemini and a key is present', () => {
    saveSettings(makeSettings({ aiProvider: 'gemini', geminiApiKey: 'AIza-valid-key' }));
    expect(mockInitGemini).toHaveBeenCalledWith('AIza-valid-key');
    expect(mockInitDeepSeek).not.toHaveBeenCalled();
  });

  test('initializes the DeepSeek client when provider is deepseek and a key is present', () => {
    saveSettings(makeSettings({ aiProvider: 'deepseek', deepseekApiKey: 'sk-deepseek-key' }));
    expect(mockInitDeepSeek).toHaveBeenCalledWith('sk-deepseek-key');
    expect(mockInitGemini).not.toHaveBeenCalled();
  });

  test('re-initializes the DeepSeek client even when the key is unchanged (provider switch)', () => {
    // Simulate a previous session having stored the DeepSeek key already.
    saveSettings(makeSettings({ aiProvider: 'deepseek', deepseekApiKey: 'sk-existing-key' }));
    mockInitDeepSeek.mockClear();

    // Switch provider back to deepseek with the same (unchanged) key.
    saveSettings(makeSettings({ aiProvider: 'deepseek', deepseekApiKey: 'sk-existing-key' }));
    expect(mockInitDeepSeek).toHaveBeenCalledWith('sk-existing-key');
  });

  test('re-initializes the Gemini client even when the key is unchanged', () => {
    saveSettings(makeSettings({ aiProvider: 'gemini', geminiApiKey: 'AIza-same-key' }));
    mockInitGemini.mockClear();

    saveSettings(makeSettings({ aiProvider: 'gemini', geminiApiKey: 'AIza-same-key' }));
    expect(mockInitGemini).toHaveBeenCalledWith('AIza-same-key');
  });

  test('does not initialize a client when no API key is configured', () => {
    saveSettings(makeSettings({ aiProvider: 'deepseek', deepseekApiKey: '' }));
    expect(mockInitDeepSeek).not.toHaveBeenCalled();
    expect(mockInitGemini).not.toHaveBeenCalled();
  });
});

/**
 * AI Compose — Settings Service
 *
 * Manages user preferences and API configuration.
 * Persists settings to localStorage (syncs automatically across sessions).
 *
 * © Rizonetech (Pty) Ltd. — https://rizonesoft.com
 */

import { initGeminiClient } from "../services/gemini";
import { initDeepSeekClient } from "../services/deepseek";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Tone options available across Draft and Reply features. */
export type Tone = "professional" | "formal" | "friendly" | "casual";

/** Summary style options for the Summarize feature. */
export type SummaryStyle = "bullets" | "paragraph" | "tldr";

/** Reasoning effort for generation. 'off' disables model thinking (fast,
 * cheap, avoids the empty-response bug); 'balanced' uses default/dynamic
 * thinking; 'high' requests maximum reasoning depth. */
export type ReasoningMode = "off" | "balanced" | "high";

/** All persisted user preferences. */
export interface AIComposeSettings {
  /** Selected AI Provider: 'gemini' | 'deepseek' */
  aiProvider: 'gemini' | 'deepseek';
  /** Google Gemini API key (stored in plain text in localStorage). */
  geminiApiKey: string;
  /** DeepSeek API key (stored in plain text in localStorage). */
  deepseekApiKey: string;
  /** Legacy API key fallback. */
  apiKey: string;
  /** Active model to use for all features. */
  defaultModel: string;
  /** Default tone for Draft Email and Reply. */
  defaultTone: Tone;
  /** Default summary style for Summarize. */
  defaultSummaryStyle: SummaryStyle;
  /** Default target language for Translate. */
  defaultLanguage: string;
  /**
   * Persisted Reply-language dropdown value.
   * 'auto' = match the original email's language (the system default).
   * Any other value is the user's chosen language and is reused on the
   * next reply. Empty/missing falls back to 'auto'.
   */
  replyLanguage: string;
  /**
   * Persisted Translate-language dropdown value.
   * '' = unset → falls back to `defaultLanguage`. Once the user changes
   * the Translate dropdown this value is stored and reused.
   */
  translateLanguage: string;
  /**
   * Persisted Summary-language dropdown value.
   * 'auto' = match the original email's language (the system default).
   */
  summaryLanguage: string;
  /** Preset rules toggled on/off by the user. */
  presetRules: Record<string, boolean>;
  /** Free-text custom rules supplied by the user. */
  customRules: string;
  /** ID of the active career profile (see getCareers / saveCareer). Empty = none. */
  activeCareerId: string;
  /** Whether the Reply feature keeps per-email conversation context. */
  conversationContextEnabled: boolean;
  /** Reasoning mode for generation. Defaults to 'off' so model thinking
   * (which shares the maxOutputTokens budget) cannot swallow the output. */
  reasoningMode: ReasoningMode;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const STORAGE_KEY = "ai_compose_settings";
const LEGACY_STORAGE_KEY = "glide_settings";

const DEFAULT_SETTINGS: AIComposeSettings = {
  aiProvider: "gemini",
  geminiApiKey: "",
  deepseekApiKey: "",
  apiKey: "",
  defaultModel: "gemini-flash-latest",
  defaultTone: "professional",
  defaultSummaryStyle: "bullets",
  defaultLanguage: "English",
  replyLanguage: "auto",
  translateLanguage: "",
  summaryLanguage: "auto",
  presetRules: {
    noPlaceholders: true,
    noSignature: true,
    noSubjectLine: false,
    keepShort: false,
    useSimpleLanguage: false,
  },
  customRules: "",
  activeCareerId: "",
  conversationContextEnabled: true,
  reasoningMode: "off",
};

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

let cached: AIComposeSettings | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load settings from localStorage (or return defaults).
 */
export function loadSettings(): AIComposeSettings {
  if (cached) return { ...cached };

  try {
    let raw = localStorage.getItem(STORAGE_KEY);

    // One-time migration from legacy "glide_settings" key
    if (!raw) {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy) {
        raw = legacy;
        localStorage.setItem(STORAGE_KEY, legacy);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
    }

    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AIComposeSettings>;
      // 迁移旧版单一 API Key
      if (parsed.apiKey && !parsed.geminiApiKey) {
        parsed.geminiApiKey = parsed.apiKey;
      }
      cached = { ...DEFAULT_SETTINGS, ...parsed };
    } else {
      cached = { ...DEFAULT_SETTINGS };
    }
  } catch {
    cached = { ...DEFAULT_SETTINGS };
  }

  return { ...cached };
}

/**
 * Save settings to localStorage and update the in-memory cache.
 * Re-initializes the underlying client for the active provider so that
 * switching providers takes effect immediately — even when the API key
 * itself did not change (e.g. selecting DeepSeek with a previously saved
 * key would otherwise leave its client uninitialized).
 */
export function saveSettings(settings: AIComposeSettings): void {
  cached = { ...settings };

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
  } catch {
    // localStorage might be unavailable in some sandboxed environments
  }

  // 根据当前配置对应初始化底层模型客户端
  if (settings.aiProvider === "gemini" && settings.geminiApiKey) {
    try {
      initGeminiClient(settings.geminiApiKey);
    } catch {
      // Will be retried on next action
    }
  } else if (settings.aiProvider === "deepseek" && settings.deepseekApiKey) {
    try {
      initDeepSeekClient(settings.deepseekApiKey);
    } catch {
      // Will be retried on next action
    }
  }
}

/**
 * Get the current API key (loads settings if not cached).
 */
export function getApiKey(): string {
  const s = loadSettings();
  return s.aiProvider === 'deepseek' ? s.deepseekApiKey : s.geminiApiKey;
}

/**
 * Update just the API key (convenience method).
 */
export function setApiKey(key: string): void {
  const settings = loadSettings();
  settings.apiKey = key;
  saveSettings(settings);
}

/**
 * Get a single setting value.
 */
export function getSetting<K extends keyof AIComposeSettings>(key: K): AIComposeSettings[K] {
  return loadSettings()[key];
}

/**
 * Reset all settings to defaults and clear localStorage.
 */
export function resetSettings(): void {
  cached = { ...DEFAULT_SETTINGS };
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore
  }
}

// ---------------------------------------------------------------------------
// Rules helpers
// ---------------------------------------------------------------------------

/** Human-readable labels for each preset rule. */
const PRESET_RULE_LABELS: Record<string, string> = {
  noPlaceholders:
    '请使用真实公司,姓名(勿使用占位符).',
  noSignature:
    '请勿添加结束语或签名.',
  noSubjectLine:
    "Do not include a subject line in the output",
  keepShort:
    "Keep the output concise — no more than 5 sentences",
  useSimpleLanguage:
    "Use simple, easy-to-understand language (avoid jargon)",
};

export { PRESET_RULE_LABELS };

/**
 * Build a combined rules string from preset + custom rules.
 * Returns an empty string if no rules are active.
 */
export function buildRulesText(): string {
  const settings = loadSettings();
  const lines: string[] = [];

  for (const [key, enabled] of Object.entries(settings.presetRules)) {
    if (enabled && PRESET_RULE_LABELS[key]) {
      lines.push(`- ${PRESET_RULE_LABELS[key]}`);
    }
  }

  if (settings.customRules.trim()) {
    lines.push(`- ${settings.customRules.trim()}`);
  }

  return lines.length > 0 ? `\n\nAdditional rules:\n${lines.join("\n")}` : "";
}

// ---------------------------------------------------------------------------
// Goal-oriented email strategies
// ---------------------------------------------------------------------------

/** Strategic prompt instructions for each email goal. */
export const GOAL_PROMPTS: Record<string, string> = {
  'close-deal':
    '撰写时应以“促成交易”为目标。营造适当的紧迫感，强调价值与优势，主动化解潜在异议，并以清晰具体的行动号召收尾。用语应自信而不强硬。',
  'get-approval':
    '撰写时应以“获得报价或提案批准”为目标。简明扼要地总结关键价值主张，预先化解可能的顾虑，营造势头，并通过明确的下一步行动让对方轻松说“好”。',
  'schedule-meeting':
    '撰写时应以“安排会议”为目标。提出具体时间，强调会议的价值，保持简洁且注重行动，并让确认会议变得轻而易举。',
  'follow-up':
    '撰写时以“跟进逾期事项”为目标。态度要坚定但专业，提及原定时间表，在表达理解的同时保持紧迫感，并要求在明确的截止日期前给予具体回复或采取行动。',
  'request-intro':
    '撰写时以“请求帮助或引荐”为目标。尊重收件人的时间，清晰阐述互利之处，提供可转发的背景信息以便对方轻松答应，并表达真诚的谢意。',
  'resolve-complaint':
    '撰写时以“解决投诉”为目标。以同理心承认问题，在适当情况下承担责任，提出具体的解决方案，并致力于将负面体验转化为正面体验。',
  'service-feathure':
    '撰写时以 “优质服务” 为导向。秉持耐心尊重沟通，精准捕捉用户诉求，规范落实服务流程，并持续优化服务感受，打造稳定可靠的服务体验。',
};

/**
 * Build goal context text to append to prompts.
 * Returns empty string if goal is 'none' or not recognized.
 */
export function buildGoalText(goal: string, customGoalText?: string): string {
  if (!goal || goal === 'none') return '';

  if (goal === 'custom' && customGoalText?.trim()) {
    return `\n\nStrategic goal: ${customGoalText.trim()}. Write the email with this specific outcome in mind — use appropriate persuasion, structure, and a clear call to action.`;
  }

  const prompt = GOAL_PROMPTS[goal];
  return prompt ? `\n\n${prompt}` : '';
}

// ---------------------------------------------------------------------------
// Email Templates
// ---------------------------------------------------------------------------

const TEMPLATES_KEY = 'aic_templates';

export interface EmailTemplate {
  id: string;
  name: string;
  instructions: string;
  type: 'draft' | 'reply' | 'both';
}

export function getTemplates(): EmailTemplate[] {
  try {
    const raw = localStorage.getItem(TEMPLATES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveTemplate(template: Omit<EmailTemplate, 'id'>): EmailTemplate {
  const templates = getTemplates();
  const newTemplate: EmailTemplate = {
    ...template,
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
  };
  templates.push(newTemplate);
  localStorage.setItem(TEMPLATES_KEY, JSON.stringify(templates));
  return newTemplate;
}

export function deleteTemplate(id: string): void {
  const templates = getTemplates().filter((t) => t.id !== id);
  localStorage.setItem(TEMPLATES_KEY, JSON.stringify(templates));
}

// ---------------------------------------------------------------------------
// Career Profiles
// ---------------------------------------------------------------------------

const CAREERS_KEY = 'aic_careers';

/** A saved career profile used to personalize drafted emails and replies. */
export interface CareerProfile {
  id: string;
  name: string;
  description: string;
}

export function getCareers(): CareerProfile[] {
  try {
    const raw = localStorage.getItem(CAREERS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveCareer(career: Omit<CareerProfile, 'id'>): CareerProfile {
  const careers = getCareers();
  const newCareer: CareerProfile = {
    ...career,
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
  };
  careers.push(newCareer);
  localStorage.setItem(CAREERS_KEY, JSON.stringify(careers));
  return newCareer;
}

export function deleteCareer(id: string): void {
  const careers = getCareers().filter((c) => c.id !== id);
  localStorage.setItem(CAREERS_KEY, JSON.stringify(careers));
  const settings = loadSettings();
  if (settings.activeCareerId === id) {
    saveSettings({ ...settings, activeCareerId: '' });
  }
}

/**
 * Build a "sender profile" section for composition prompts (draft/reply).
 * Uses the active career profile's description. Returns '' when no profile
 * is selected or the description is empty.
 */
export function buildProfileText(): string {
  const settings = loadSettings();
  if (!settings.activeCareerId) return '';

  const career = getCareers().find((c) => c.id === settings.activeCareerId);
  if (!career || !career.description.trim()) return '';

  return `\n\nRole and profile:\n${career.description.trim()}`;
}

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
  /** Preset rules toggled on/off by the user. */
  presetRules: Record<string, boolean>;
  /** Free-text custom rules supplied by the user. */
  customRules: string;
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
  presetRules: {
    noPlaceholders: true,
    noSignature: true,
    noSubjectLine: false,
    keepShort: false,
    useSimpleLanguage: false,
  },
  customRules: "",
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
 * If the API key changed, automatically re-initializes the Gemini client.
 */
export function saveSettings(settings: AIComposeSettings): void {
  const previousGeminiKey = cached?.geminiApiKey || "";
  const previousDeepseekKey = cached?.deepseekApiKey || "";

  cached = { ...settings };

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
  } catch {
    // localStorage might be unavailable in some sandboxed environments
  }

  // 根据当前配置对应初始化底层模型客户端
  if (settings.aiProvider === "gemini" && settings.geminiApiKey && settings.geminiApiKey !== previousGeminiKey) {
    try {
      initGeminiClient(settings.geminiApiKey);
    } catch {
      // Will be retried on next action
    }
  } else if (settings.aiProvider === "deepseek" && settings.deepseekApiKey && settings.deepseekApiKey !== previousDeepseekKey) {
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
    'Do not include placeholder tokens like [Your Name], [Company], or [Recipient]. Use real names from context or omit the sign-off entirely instead of using placeholders',
  noSignature:
    'Do not add a sign-off or signature (e.g. "Best regards", "Kind regards", "Sincerely") — the email client will add the signature automatically',
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
    'Write with the strategic goal of CLOSING A DEAL. Create appropriate urgency, reinforce value and benefits, proactively address potential objections, and end with a clear, specific call to action. Use confident but not pushy language.',
  'get-approval':
    'Write with the strategic goal of GETTING A QUOTE OR PROPOSAL APPROVED. Summarize key value propositions concisely, address any likely concerns preemptively, create a sense of momentum, and make it easy to say yes with a clear next step.',
  'schedule-meeting':
    'Write with the strategic goal of SCHEDULING A MEETING. Propose specific times (if context allows), emphasize the value of the meeting, keep it brief and action-oriented, and make it effortless to confirm.',
  'follow-up':
    'Write with the strategic goal of FOLLOWING UP ON AN OVERDUE ITEM. Be firm but professional, reference the original timeline, express understanding while maintaining urgency, and request a specific response or action by a clear date.',
  'request-intro':
    'Write with the strategic goal of REQUESTING A FAVOR OR INTRODUCTION. Be respectful of the recipient\'s time, clearly explain the mutual benefit, make it easy to say yes by providing context they can forward, and express genuine appreciation.',
  'resolve-complaint':
    'Write with the strategic goal of RESOLVING A COMPLAINT. Acknowledge the issue with empathy, take ownership where appropriate, propose a concrete resolution, and aim to turn a negative experience into a positive one.',
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

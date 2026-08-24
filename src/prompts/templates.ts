/**
 * AI Compose — Prompt Templates
 *
 * Reusable prompt templates for all AI Compose features.
 * Each template uses {{PLACEHOLDER}} syntax for variable substitution
 * via the `buildPrompt` function in builder.ts.
 *
 * © Rizonetech (Pty) Ltd. — https://rizonesoft.com
 */

// ---------------------------------------------------------------------------
// Draft Email
// ---------------------------------------------------------------------------

/**
 * Compose a new email from bullet points or brief instructions.
 *
 * Placeholders: {{PROFILE}}, {{GOAL}}, {{INSTRUCTIONS}}, {{TONE}},
 *               {{LANGUAGE}}, {{RULES}}
 */
export const DRAFT_EMAIL_PROMPT = `Role:As a professional email assistant,{{PROFILE}}
{{GOAL}}
Requirements:
- Tone: {{TONE}}
- Language：{{LANGUAGE}},(unless overridden by explicit request in Reply instructions)
- Include a subject line on the first line prefixed with "Subject: "
- Use an appropriate greeting
- Keep the email concise and to the point
- Do not add any commentary outside the email itself
{{RULES}}

Draft a complete email based on the following instructions:
{{INSTRUCTIONS}}`;

// ---------------------------------------------------------------------------
// Reply
// ---------------------------------------------------------------------------

/**
 * Generate a reply to an existing email.
 *
 * Placeholders: {{PROFILE}}, {{GOAL}}, {{ORIGINAL_EMAIL}},
 *               {{REPLY_INSTRUCTIONS}}, {{TONE}}, {{LANGUAGE}},
 *               {{REPLY_TO_NAME}}, {{RULES}}
 *discard {{RULES}}
 */
export const REPLY_PROMPT = `[1.Base Requirements]
Role:As a professional email assistant,{{PROFILE}}
{{GOAL}}
Tone: {{TONE}}
Language：{{LANGUAGE}}
Address the reply to: {{REPLY_TO_NAME}} 
Write only the reply body (without subject,regards and signature).
Reference relevant points from the original email naturally.
Keep the reply focused and professional,no commentary outside the reply.

[2.Original Email]
{{ORIGINAL_EMAIL}}

[3.Reply Instructions(strictly)]
{{REPLY_INSTRUCTIONS}}

[4.Execution Instructions]
请参考原始邮件内容,遵循基本要求(除非回复说明中另有明确要求),重点围绕回复说明,起草回复.`;

// ---------------------------------------------------------------------------
// Summarize Thread
// ---------------------------------------------------------------------------

/**
 * Summarize a multi-message email thread.
 *
 * Placeholders: {{EMAIL_THREAD}}, {{SUMMARY_LENGTH}}, {{SUMMARIZE_LANGUAGE}}
 */
export const SUMMARIZE_THREAD_PROMPT = `You are a professional email assistant.

Summarize the following email thread:

---
{{EMAIL_THREAD}}
---

Requirements:
- Length: {{SUMMARY_LENGTH}} (brief = 2-3 sentences, standard = 1 paragraph, detailed = multiple paragraphs)
- Language: {{SUMMARIZE_LANGUAGE}}
- Identify the key discussion points and decisions made
- Note any action items or deadlines mentioned
- List the participants and their main positions
- Use bullet points for clarity where appropriate
- Do not add opinions or information not present in the thread`;

// ---------------------------------------------------------------------------
// Improve Writing
// ---------------------------------------------------------------------------

/**
 * Improve grammar, clarity, and tone of selected text.
 *
 * Placeholders: {{TEXT}}, {{IMPROVEMENT_FOCUS}}
 */
export const IMPROVE_WRITING_PROMPT = `You are a professional writing assistant.

Improve the following text:

---
{{TEXT}}
---

Focus on: {{IMPROVEMENT_FOCUS}}

Requirements:
- Fix grammar, spelling, and punctuation errors
- Improve clarity and readability
- Maintain the original meaning and intent
- Keep the same general length unless brevity improves the text
- Return only the improved text, no explanations or annotations`;

// ---------------------------------------------------------------------------
// Extract Action Items
// ---------------------------------------------------------------------------

/**
 * Pull tasks, deadlines, and responsibilities from emails.
 *
 * Placeholders: {{EMAIL_CONTENT}}
 */
export const EXTRACT_ACTION_ITEMS_PROMPT = `You are a professional email assistant.

Extract all action items, tasks, and deadlines from the following email:

---
{{EMAIL_CONTENT}}
---

Requirements:
- List each action item as a bullet point
- For each item, identify:
  - **Task**: What needs to be done
  - **Owner**: Who is responsible (if mentioned)
  - **Deadline**: When it's due (if mentioned)
- If no action items are found, respond with "No action items found."
- Only extract items explicitly stated or clearly implied in the email
- Do not invent tasks that are not present`;

// ---------------------------------------------------------------------------
// Translate
// ---------------------------------------------------------------------------

/**
 * Translate email content to a target language.
 *
 * Placeholders: {{TEXT}}, {{TARGET_LANGUAGE}}
 */
export const TRANSLATE_PROMPT = `You are a professional translator.

Translate the following text to {{TARGET_LANGUAGE}}:

---
{{TEXT}}
---

Requirements:
- Maintain the original formatting (paragraphs, bullet points, etc.)
- Preserve the original tone and register
- Use natural, fluent phrasing in the target language (not literal word-for-word)
- Keep proper nouns, brand names, and technical terms as-is unless they have
  well-known translations
- The output MUST be written entirely in {{TARGET_LANGUAGE}} — do not leave
  any word or phrase in the original language
- Return only the translated text, no explanations`;

// ---------------------------------------------------------------------------
// Change Tone
// ---------------------------------------------------------------------------

/**
 * Rewrite text in a different tone.
 *
 * Placeholders: {{TEXT}}, {{TARGET_TONE}}
 *
 * Supported tones: formal, casual, friendly, professional, assertive, empathetic
 */
export const CHANGE_TONE_PROMPT = `You are a professional writing assistant.

Rewrite the following text in a {{TARGET_TONE}} tone:

---
{{TEXT}}
---

Requirements:
- Maintain the original meaning and all key information
- Adjust vocabulary, sentence structure, and phrasing to match the target tone
- Keep approximately the same length
- Return only the rewritten text, no explanations or annotations`;

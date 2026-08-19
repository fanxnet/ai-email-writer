# Privacy Policy

**AI Compose** (AI Email Writer) is an open-source Outlook add-in that uses Google's Gemini API
to provide AI-powered email features. Your privacy is important — here's exactly what happens
with your data.

## What Data Is Sent to Google

When you use any AI feature (Draft, Reply, Summarize, Improve, Extract, Translate),
the following is sent to the **Google Gemini API**:

| Feature             | Data Sent                                                            |
| ------------------- | -------------------------------------------------------------------- |
| **Draft Email**     | Your instructions, selected tone, and length preference              |
| **Draft Reply**     | The original email body, subject, sender name, and your instructions |
| **Summarize**       | The full email body (or thread)                                      |
| **Improve Writing** | The selected text or full email body                                 |
| **Extract Actions** | The full email body                                                  |
| **Translate**       | The full email body and target language                              |

> [!IMPORTANT]
> Email content is sent **directly** from your browser to Google's servers.
> There is **no intermediate server** — AI Compose does not operate or relay through any backend.

## What Data Is Stored Locally

AI Compose stores the following in your browser's `localStorage`:

- **API Key** — Your Google Gemini API key (stored in plain text)
- **Preferences** — Default tone, summary style, translation language, and selected model
- **Career profiles** — Saved career descriptions (profiles you create in Settings); the active
  profile is used as context when drafting emails/replies
- **Conversation memory** — Per-email Q&A history and summaries for the Reply feature, kept in
  `localStorage`. Records not used for 72 hours are automatically deleted, and the store is
  capped by record count and total size. <br>
  Use **Clear conversation** in the Reply tab to erase a single email's history, or
  **Clear All Data** to wipe everything.

This data **never leaves your device** unless you explicitly use a feature that calls the API.

You can clear all stored data at any time using the **Clear All Data** button in Settings.

## What Is NOT Collected

- ❌ No telemetry or usage analytics
- ❌ No tracking pixels or third-party scripts
- ❌ No email content is stored, cached, or logged by AI Compose
- ❌ No data is sent to Rizonetech or any server other than Google's API
- ❌ No cookies are used

## Google's Data Handling

When data is sent to the Gemini API, it is subject to
[Google's API Terms of Service](https://ai.google.dev/gemini-api/terms) and
[Privacy Policy](https://policies.google.com/privacy).

Per Google's Gemini API data usage policy, prompts sent via the API are:

- **Not used to train models** (when using API keys, not the free AI Studio tier)
- Processed in real time and not retained beyond the request lifecycle

## Your Rights

- You can **delete all local data** at any time via Settings → Clear All Data
- You can **revoke your API key** in the [Google AI Studio](https://aistudio.google.com/apikey)
- The source code is fully auditable at [github.com/rizonesoft/ai-email-writer](https://github.com/rizonesoft/ai-email-writer)

---

© Rizonetech (Pty) Ltd. • [rizonesoft.com](https://rizonesoft.com)

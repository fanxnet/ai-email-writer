<h1 align="center">AI Email Writer (AI Compose)</h1>
<p align="center">
  <strong>An open-source AI email writer and composer for Microsoft Outlook, powered by Google Gemini.</strong>
</p>
<p align="center">
  <a href="https://github.com/rizonesoft/ai-email-writer/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue.svg"></a>
  <a href="https://github.com/rizonesoft/ai-email-writer/actions/workflows/deploy.yml"><img alt="Deploy" src="https://github.com/rizonesoft/ai-email-writer/actions/workflows/deploy.yml/badge.svg"></a>
</p>

---

**AI Compose** is a lightweight, privacy-focused Outlook add-in developed by [Rizonesoft](https://rizonesoft.com). It leverages the **Google Gemini API** to help you draft, reply, and refine professional emails directly within the Outlook interface — without ever leaving your inbox.

## ✨ Features

| Feature                    | Description                                                             |
| -------------------------- | ----------------------------------------------------------------------- |
| **📝 AI-Powered Drafting** | Generate full professional emails from short prompts and a desired tone |
| **↩️ Contextual Replies**  | Analyze incoming mail to suggest relevant, context-aware responses      |
| **📋 Summarize**           | Condense long email threads into bullet points, paragraphs, or TL;DR    |
| **✍️ Improve Writing**     | Fix grammar, improve clarity, make concise, or make professional        |
| **✅ Extract Actions**     | Pull out action items, deadlines, and tasks from emails                 |
| **🌐 Translate**           | Translate email content into 20+ languages                              |
| **🔒 Privacy-First**       | Open-source architecture ensures your API keys stay local               |

## 🚀 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v20 or higher
- A [Google Gemini API key](https://aistudio.google.com/apikey) (free tier available)
- Microsoft Outlook (desktop, web, or Microsoft 365)

### Installation

**Option A — Install from GitHub Pages (recommended)**

1. Download the manifest: **[manifest.xml](https://rizonesoft.github.io/ai-email-writer/manifest.xml)** (right-click → Save As)
2. Visit **[aka.ms/olksideload](https://aka.ms/olksideload)** — this opens Outlook on the web and the Add-Ins dialog
3. In the **"Custom Addins"** section at the bottom, click **Add a custom add-in** → **Add from File**
4. Select the downloaded `manifest.xml` and click **Install**
5. Open any email → click the **AI Compose** button in the ribbon
6. Enter your Gemini API key in **Settings** (gear icon)

> **Tip:** In classic Outlook on Windows, you can also access this via **File → Info → Manage Add-ins**.

**Option B — Organization-wide deployment (M365 Admin)**

1. Go to [admin.microsoft.com](https://admin.microsoft.com) → **Settings** → **Integrated Apps**
2. Click **Upload custom apps** → **Provide link to manifest file**
3. Enter: `https://rizonesoft.github.io/ai-email-writer/manifest.xml`
4. Click **Validate** → assign to users or groups → **Deploy**

> **Note:** Updates are automatic — when we deploy new code to GitHub Pages, the add-in updates for all users on the next load. No reinstallation needed.

**Option C — Install the Dev/Nightly build**

For early access to the latest features:

1. Download the dev manifest: **[manifest.xml](https://rizonesoft.github.io/ai-email-writer/dev/manifest.xml)** (right-click → Save As)
2. Follow the same steps as Option A using [aka.ms/olksideload](https://aka.ms/olksideload)
3. The dev build appears as **"AI Compose (Dev)"** in Outlook so it won't conflict with the production version

## 🛠️ Development

### Setup

```bash
# Clone the repository
git clone https://github.com/rizonesoft/ai-email-writer.git
cd ai-email-writer

# Install dependencies
npm install

# Create a .env file with your Gemini API key
echo "GEMINI_API_KEY=your-key-here" > .env

# Start the development server
npm run dev-server
```

### Sideload for Development

1. Start the dev server (`npm run dev-server`) — runs on `https://localhost:3000`
2. Open Outlook on the web
3. **Get Add-ins** → **My add-ins** → **Add a custom add-in** → **Add from file**
4. Upload `manifest.xml` from the project root
5. The add-in will hot-reload as you make changes

### Build

```bash
# Production build (outputs to dist/)
npm run build

# Run linting
npm run lint
```

### Project Structure

```
ai-email-writer/
├── src/
│   ├── features/          # Feature modules (draft, reply, summarize, etc.)
│   ├── services/          # Gemini API client, Outlook service
│   ├── prompts/           # Prompt templates and builder
│   ├── styles/            # Design tokens and global CSS
│   ├── taskpane/          # Main UI (HTML, TypeScript, CSS)
│   └── commands/          # Outlook ribbon command handlers
├── assets/
│   └── tool-icons/        # Ribbon control icons (PNG, multiple sizes)
├── manifest.xml           # Add-in manifest (GitHub Pages production)
└── .github/workflows/     # CI/CD deployment workflows
```

## 🔄 Deployment

AI Compose is hosted on **GitHub Pages** with a single `manifest.xml` in the repository. The CI pipeline automatically patches the manifest for the dev environment at build time (different App ID, `/dev/` URLs, and "(Dev)" label).

| Environment    | URL                                                                                            | Trigger                          |
| -------------- | ---------------------------------------------------------------------------------------------- | -------------------------------- |
| **Dev**        | [rizonesoft.github.io/ai-email-writer/dev/](https://rizonesoft.github.io/ai-email-writer/dev/) | Auto on every push to `main`     |
| **Production** | [rizonesoft.github.io/ai-email-writer/](https://rizonesoft.github.io/ai-email-writer/)         | Manual trigger in GitHub Actions |

To promote to production: go to **[GitHub Actions](https://github.com/rizonesoft/ai-email-writer/actions)** → **Deploy** → **Run workflow** → check **Deploy to production** → **Run workflow**. Users receive updates automatically on their next add-in load.

### Updating in MS365 Admin Centre

If you need to update or re-deploy the add-in for your organization:

1. Go to [admin.microsoft.com](https://admin.microsoft.com) → **Settings** → **Integrated Apps**
2. Find **AI Compose** → click **Update app** (or remove and re-add)
3. Select **Provide link to manifest file**
4. Enter: `https://rizonesoft.github.io/ai-email-writer/manifest.xml`
5. Click **Validate** → **Update** / **Deploy**
6. Changes propagate to assigned users within 24 hours

## ⚙️ Settings

Access settings via the **gear icon** in the add-in:

- **API Key** — Your Google Gemini API key (stored locally in your browser)
- **Model** — Choose between Gemini 3.1 Pro (latest), Gemini 3 Flash/Pro, or Gemini 2.5 Flash/Pro (stable)
- **Default Tone** — Set the default writing tone (Professional, Formal, Friendly, Casual)
- **Summary Style** — Default format for summaries (Bullets, Paragraph, TL;DR)
- **Language** — Default translation target language

## 🔒 Privacy

- Your **API key** is stored locally in your browser's `localStorage` — it never leaves your device
- Email content is sent directly to the **Google Gemini API** for processing
- **No data** is stored on our servers — AI Compose is entirely client-side
- The add-in only requests **ReadWriteItem** permissions (the minimum needed)

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'feat: add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

---

<p align="center">
  Thanks to ❤️  <a href="https://rizonesoft.com">Rizonesoft</a>
</p>

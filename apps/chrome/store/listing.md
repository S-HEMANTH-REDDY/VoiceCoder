# Chrome Web Store Listing — VoiceCoder

## Short Description (132 chars max)
Talk directly into your code editor. Natural language → real code at your cursor, across LeetCode, VS Code Web, Replit, and more.

## Category
Developer Tools

## Tags
coding, voice, productivity, code editor, AI, LeetCode, VS Code, speech

---

## Long Description

**VoiceCoder** lets you speak code instead of type it. Say "write binary search" or "create an async function called fetchData" — the extension converts your voice into syntactically correct code and inserts it at your cursor, instantly.

Works across every major online editor:

- **VS Code Web / vscode.dev / GitHub Codespaces**
- **LeetCode** (Monaco + CodeMirror)
- **Replit** (Ace editor)
- **GitHub** editor
- **CodeSandbox, StackBlitz, CodePen, JSFiddle**
- **HackerRank, Codeforces, AtCoder**
- Any `<textarea>` or `contenteditable` on any page

**Supported languages:** Python · JavaScript · TypeScript · C++ · Java · Go · Rust · Swift · Kotlin · Ruby · C#

---

### How it works

1. Press **Option+Space** (or click the toolbar icon) to start listening
2. Say your command: *"create a for loop from 0 to n"* or *"write binary search"*
3. The code appears at your cursor with correct indentation — no copy-paste needed

### Rewrite & Refactor

Select any code, then say *"refactor this"*, *"simplify this function"*, *"add comments"*, or *"optimize this"* — VoiceCoder will rewrite the selection in place.

---

### Shortcuts

| Action | Shortcut |
|--------|----------|
| Start / stop listening | Option+Space |
| Switch language | Option+L |
| Undo last insertion | Option+Z |

---

### Privacy & Security

- **Your API key never leaves the background worker.** Page scripts and content scripts cannot read it.
- **No code or transcripts are stored or logged.** Code leaves your browser only in the model call.
- Model traffic goes directly from the extension's service worker to `api.anthropic.com` or `api.openai.com` over HTTPS
- Minimal permissions: `activeTab`, `storage`, `scripting`; host access only to the two model APIs

---

### Setup

1. Install the extension
2. Click the VoiceCoder icon → **Settings (⚙)**
3. Choose Anthropic or OpenAI and paste your API key
4. Click **Save** — you're ready

Bring Your Own Key (BYOK). You control your API usage and costs.

---

## Privacy Policy (required for Chrome Web Store)

**VoiceCoder Privacy Policy**

Last updated: May 2026

VoiceCoder does not collect, store, or transmit any personal data to its own servers.

- **API Key:** Stored locally in `chrome.storage.local` and read only by the extension's background worker. Sent only to the provider you choose (`api.anthropic.com` or `api.openai.com`) as an authentication header.
- **Voice / Audio:** Recognised by the browser's Web Speech API (Chrome uses its own speech service). Audio is never sent to VoiceCoder servers.
- **Code:** When a command needs the model, the editor context (code around the cursor, or the file if small, plus your selection) is sent to the chosen provider as part of the prompt, governed by that provider's privacy policy. VoiceCoder itself does not store or log this data.
- **No analytics, no tracking, no third-party scripts.**

For questions: [your email here]

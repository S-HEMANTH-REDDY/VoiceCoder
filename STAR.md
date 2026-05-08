# VoiceCoder — Interview STAR Story

## One-liner
Built a Chrome extension that converts voice commands into syntactically correct code and injects it directly at the cursor across Monaco, CodeMirror, Ace, and textarea editors on LeetCode, VS Code Web, Replit, and 20+ other sites.

---

## STAR: "Tell me about a project you built"

**Situation**
I wanted a tool that lets you speak code instead of type it — useful during interviews, pair programming, and rapid prototyping where context-switching to type boilerplate breaks your flow. No existing extension handled the breadth of online editors people actually use.

**Task**
Design and ship a browser extension end-to-end: voice capture, LLM code generation, and cursor-accurate injection into any editor a user might have open — without bundlers, without a backend, and without storing any user code.

**Action**
- Built the editor detection layer to fingerprint Monaco, CodeMirror 6, CodeMirror 5, Ace, textarea, and contenteditable by DOM signatures and global window objects, with priority ordering to handle sites that load multiple editors
- Solved the hardest part: each editor has a completely different insertion API. Monaco needs `executeEdits()` for undo-safe inserts; CM6 listens to browser `InputEvent(beforeinput)`, not DOM mutations; Ace uses `session.insert()`; textarea falls back to `execCommand`. Had to reverse-engineer each
- Designed the LLM prompt pipeline: system prompt with few-shot examples per language at temperature 0.2 for deterministic output, user prompt includes 10 lines of surrounding code for indentation and context
- Kept the security model tight: API key in `chrome.storage.local` (sandboxed, page JS cannot read it), all traffic goes from service worker directly to `api.openai.com` over HTTPS, zero persistence of user code
- Added a rewrite/refactor flow: when the user selects code and says "refactor this" or "add comments", it reads the selection, sends it to the LLM with a different system prompt, and replaces the selection in place

**Result**
Working extension that handles 20+ sites and 11 languages with sub-2-second generation time (GPT-4.1, BYOK). The rewrite feature required no changes to the manifest or permissions — selection reading was already available through each editor's existing API.

---

## Follow-up Q&A

**Q: Why not use a bundler?**
Chrome MV3 service workers support ES modules natively. Content scripts don't support `import`, so each content file is a flat file. The build step is literally a `cp` — zero transpilation, fast iteration, no Webpack config to debug.

**Q: How do you handle sites that load multiple editor libraries?**
Detection runs in priority order: Monaco first (most feature-rich), then CM6, CM5, Ace, textarea. The first match wins. Monaco detection checks both `window.monaco.editor` and DOM class `.monaco-editor`, with a third fallback on `[data-uri]` attributes that vscode.dev uses.

**Q: What was the hardest part?**
CodeMirror 6's insertion. CM6 doesn't listen to direct DOM manipulation or `value` assignment — it re-renders from its own state. The only way to inject text that CM6 accepts is to fire `InputEvent('beforeinput', { inputType: 'insertText', data: text })` on the focused element, which triggers CM6's own event handler. If the event isn't cancelled, fall back to `execCommand('insertText')`.

**Q: How is the API key protected?**
`chrome.storage.local` is only accessible to extension code (background service worker and popups), not to page JavaScript. Even if a malicious site script runs in the same tab, it cannot call `chrome.storage.local.get()`. The key is never injected into the DOM or passed to content scripts.

**Q: What would you build next?**
Deepgram WebSocket for real-time streaming transcription (faster than Web Speech API on slow connections), and a "voice cursor movement" feature ("go to line 42", "select this function") that maps phrases to Monaco's `editor.setPosition()` and `editor.setSelection()`.

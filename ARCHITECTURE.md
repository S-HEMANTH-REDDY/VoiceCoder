# VoiceCoder — Architecture

## Pipeline (the full data flow)

```
Mic → Web Speech API (streaming)
         ↓  interim results → Indicator updates live
         ↓  final result (1.5s silence or isFinal)
         ↓
   content.js: REQUEST_GENERATION message
         ↓
   service-worker.js:
      buildSystemPrompt(language) + buildUserPrompt(transcript, editorContext)
         ↓
   OpenAI GPT-4.1 API → raw code string
         ↓
   stripMarkdownFences() → clean code
         ↓
   content.js: insertCodeAtCursor(editorType, code)
         ↓
   Editor Bridge:
      Monaco   → editor.executeEdits()    ← undo-safe, native
      CM6      → InputEvent + execCommand ← event-driven
      CM5      → cm.replaceSelection()
      Ace      → session.insert()
      Textarea → document.execCommand('insertText')
      CE       → Range + TextNode
         ↓
   Code appears at cursor with correct indentation
```

## File Map

```
VoiceCoder/
├── manifest.json              # MV3 manifest
├── icons/                     # 16/32/48/128 PNG
├── src/
│   ├── background/
│   │   └── service-worker.js  # State, commands, LLM calls
│   ├── content/
│   │   ├── content.js         # Entry: speech → generate → inject
│   │   ├── speech-engine.js   # Web Speech API wrapper
│   │   ├── editor-bridge.js   # Detect + inject into any editor
│   │   ├── indicator.js       # Minimal corner badge
│   │   └── content.css        # Badge styles
│   ├── popup/
│   │   ├── popup.html/css/js  # Toggle + language picker
│   └── settings/
│       ├── settings.html/css/js # API key, model, speech lang
│   └── shared/
│       ├── constants.js       # MSG types, LANGUAGES, STORAGE_KEYS
│       └── prompts.js         # System + user prompt builders
├── scripts/
│   ├── build.js               # Copy src → dist
│   └── zip.js                 # Pack dist → voicecoder.zip
└── dist/                      # Load this folder in Chrome
```

## Editor Detection Priority

1. **Monaco** — `.monaco-editor` DOM class, `window.monaco.editor`, or `[data-uri]`
   - Injection via `editor.executeEdits()` — full undo/redo integration, cursor-aware
   - Context via `model.getValueInRange()` — last 10 lines above cursor

2. **CodeMirror 6** — `.cm-editor`, `.cm-content`
   - Injection via `InputEvent(beforeinput)` + `execCommand('insertText')`
   - CM6 listens to browser input events, not DOM mutations

3. **CodeMirror 5** — `.CodeMirror`, `window.CodeMirror`
   - Injection via `cm.replaceSelection()`

4. **Ace** — `window.ace`, `.ace_editor`
   - Injection via `aceEditor.session.insert(cursor, code)`

5. **Textarea** — `document.activeElement.tagName === 'TEXTAREA'`
   - Injection via `execCommand('insertText')` — preserves undo stack

6. **ContentEditable** — `el.isContentEditable`
   - Injection via DOM `Range` + `TextNode`

## LLM Prompt Design

### System prompt
- Instructs model to output ONLY code (no prose, no markdown fences)
- Names the target language explicitly
- Provides 2-3 language-specific examples inline (few-shot)
- Temperature: 0.2 (deterministic, correct syntax)

### User prompt
- Includes last 10 lines of code above cursor (context window)
- Reports current indentation level
- States the voice command verbatim

### Post-processing
- `stripMarkdownFences()` handles models that ignore the no-fence instruction
- Trailing newline appended to leave cursor on a fresh line

## Why No Bundler?

Chrome MV3 service workers support ES modules natively. Content scripts loaded
via `manifest.json` do not support `import` — the content script uses a single
file that imports from relative paths. The build step is just a `cp` — zero
transpilation, fast iteration.

## Security

- API key stored in `chrome.storage.local` (sandboxed per extension, not accessible to page JS)
- No user code is persisted anywhere
- All LLM traffic goes directly from the service worker to `api.openai.com` over HTTPS
- Content script has no access to `storage` — only the service worker reads the key
- Minimal permissions: `activeTab`, `storage`, `scripting`

## Monetization Roadmap

| Phase | Model |
|-------|-------|
| MVP   | BYOK (bring your own OpenAI key) — zero cost to ship |
| v1.1  | Freemium: 50 free generations/day, paid plan for unlimited |
| v1.2  | Teams: shared key management, usage dashboard |
| v2    | SaaS: hosted inference, proprietary fine-tuned model on coding data |

## Phase 2 Features (Architecture Notes)

- **"Rewrite this function"** — read selection via `editor.getSelection()`, send as context
- **"Add comments"** — same flow, different prompt template
- **"Undo last generation"** — Monaco: `editor.trigger('undo')`, CM: `cm.undo()`, textarea: `execCommand('undo')`
- **Voice cursor movement** — map phrases like "go to line 42" to `editor.setPosition()`
- **Deepgram fallback** — replace `SpeechEngine` with a WebSocket to `api.deepgram.com`
- **Whisper fallback** — `MediaRecorder` → blob → `POST /audio/transcriptions`

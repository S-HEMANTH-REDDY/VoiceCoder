# Architecture

VoiceCoder is a monorepo with one shared TypeScript core and two hosts.

```
packages/core/src
  intent/      schema.ts (Intent union + flat LLM schema), local-parser.ts (grammar),
               heuristic.ts (offline fallback), engine.ts (hybrid router + cache)
  speech/      normalize.ts (dev vocabulary, spoken numbers), web-speech.ts (controller),
               utterance-gate.ts (dedupe), vad.ts (energy VAD + WAV), transcribe.ts
  llm/         types.ts (LLMProvider), anthropic.ts (official SDK), openai.ts (fetch),
               json-schema.ts (strict schema + JSON extraction), registry.ts
  prompts/     prompt builders (static system prompts → cacheable; tagged data sections)
  context/     EditorContext + budgeted rendering
  edit/        schema.ts (EditPlan), patch.ts (anchored edits, diff, streaming preview),
               transactions.ts (undo/redo with verification)
  memory/      SessionMemory (turns + focus region)
  safety/      command-policy.ts (block/label commands, workspace path guards)
  agent/       VoiceAgent (plan → approve → typed tools → observe), defineTool
  metrics/     MetricsRecorder (p50/p95), Stopwatch
  util/        CommandCoordinator (lanes, cancel, dedupe, timeout), rankFiles

apps/vscode/src
  extension.ts            activation, commands
  orchestrator.ts         pipeline, UI state, metrics persistence
  context/collector.ts    EditorContext from native APIs (symbols, diagnostics, project)
  editor/changes.ts       ChangeManager: propose/accept/reject/undo/redo, preview diffs
  executors/              editing, navigation, explain, shell (tests/terminal/git), agent
  services/               approvals, process runner (pty + capture), project detection
  speech/                 browser-bridge.ts (loopback mic page), native.ts (ffmpeg + VAD)
  ui/                     assistant webview (vanilla DOM), mic page, protocol

apps/chrome/src
  content/page-bridge.ts  MAIN-world editor adapters (Monaco, CM5, CM6, Ace, fields)
  content/content.ts      isolated world: speech, local intents, verified apply, undo
  content/overlay.ts      shadow-DOM floating assistant
  background/             service worker: model calls over cancellable ports, memory
```

## Command lifecycle (VS Code)

1. **Capture.** The speech source emits `interim`, `final`, `level` and `state` events. Finals pass through the `UtteranceGate`.
2. **Snapshot.** Before anything slow runs, the orchestrator records the active document URI, version and selection, plus cheap context (cursor window, imports, diagnostics). Language-server symbols are added later, and only for intents that need them, so local commands never wait on a language server.
3. **Classify.** `IntentEngine.classify` normalizes the transcript and tries the local grammar. On a miss it calls the model's fast tier with structured output (`LlmIntentSchema`), maps the result, and re-validates it against `IntentSchema`. On error it falls back to the offline heuristic. Results are cached for 30 s.
4. **Route.** Control and navigation intents run immediately. Everything else goes through the `CommandCoordinator`: one lane for edits, one for the agent. A new command supersedes (aborts) the previous one in its lane unless that command has committed (for example, an approved process). Identical commands within 1.2 s are dropped, and every task has a timeout.
5. **Execute.**
   - *Edits:* build a budgeted prompt (target region resolved from selection → memory focus → enclosing symbol), stream an `EditPlan`, show a live preview, then `ChangeManager.propose`. That re-resolves anchors against the current text, refuses cursor inserts if the document changed, applies minimal ranges and records a transaction.
   - *Shell:* project detection → policy → approval → pty-mirrored run with capture, timeout and cancel → summary. The last failure is kept for "explain this error" and "fix the failing test".
   - *Agent:* plan (structured) → plan approval → loop up to `maxSteps`: the model picks a tool and JSON args → zod validation → per-action approval when consequential → run with timeout → truncated observation → next step. Transient model errors are retried with backoff; identical failing calls are flagged; token and wall-clock budgets apply.
6. **Record.** The outcome goes to `SessionMemory` (with the resolved instruction and the changed region as the new focus). Metrics record stage latencies and counters. UI state is pushed, coalesced to one update per ~16 ms.

## Edit protocol

The model returns `{ summary, edits: [{ search, replace }] }`. `resolveEdits` works as follows:

- Exact match first. Then a line-based match that ignores indentation and trailing whitespace, re-indenting the replacement to the file's indentation.
- `search: ""` inserts at the cursor offset captured when the command was spoken.
- Ambiguous (more than one match), missing (stale) and overlapping edits are refused with a user-facing reason.
- Results become `{ start, end, text }` changes, applied as small `WorkspaceEdit` ranges.

## Why two microphone paths in VS Code

VS Code webviews don't grant microphone access, and the extension host has no audio API.

- **Browser bridge (default):** the extension serves a small page on `127.0.0.1:<random>/<token>/mic`. The page runs Web Speech, gives real-time interim results and supports `hi-IN`/`te-IN`. It posts validated events back; the extension sends start/stop/config over SSE. No native dependencies.
- **Native:** `ffmpeg` captures 16 kHz mono PCM from the OS default device. `EnergyVad` (adaptive noise floor, pre-roll, hangover) segments utterances automatically, and each segment is transcribed by OpenAI with a developer-vocabulary prompt. No browser involved.

## Chrome host

Content scripts can't see page globals, so a MAIN-world bridge does the editor work. The isolated content script owns speech, the local fast path and the overlay. It talks to the bridge through `CustomEvent`s carrying JSON, and to the service worker through a long-lived port per command (disconnecting the port cancels the request). Edits carry the exact text they expect, and undo verifies before restoring.

## Testing layers

| Layer | Tooling | What it proves |
|---|---|---|
| Core unit tests (161) | vitest | Grammar, normalization, speech lifecycle (fake recognition), VAD on synthetic audio, patching, transactions, memory, policy, coordinator, agent, schemas |
| VS Code integration (18) | @vscode/test-electron + mocha in a real VS Code | Navigation latency, generate/modify/follow-up, wrong-editor protection, stale rebase/refusal, undo/redo safety, preview mode, duplicate and cancel handling, dictation, approvals for tests/terminal/git, blocked commands, agent with approvals, mic-bridge security |
| Browser compatibility (43 checks) | puppeteer-core + Chrome + real editors from CDNs | Detection, verified edits, stale refusal, safe undo, goto line and target binding on Monaco, CodeMirror 5/6, Ace, textarea and contenteditable |
| Evaluation | `eval/run.ts` | Intent accuracy and coverage, latency, duplicate execution vs. the original engine, edit robustness, agent recovery; with `--live`, model accuracy, tokens and executed code-edit tasks |

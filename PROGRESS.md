# VoiceCoder 2.0: progress log

Branch: `feat/voice-platform` (local only; nothing has been pushed).

## Plan (prioritised)

1. ✅ **Audit** the original extension → [docs/AUDIT.md](docs/AUDIT.md)
2. ✅ **Shared core** (`packages/core`): intent engine, speech lifecycle, providers, edit protocol, transactions, memory, policy, agent, metrics
3. ✅ **VS Code extension** with a full voice → intent → action loop (top priority per brief)
4. ✅ **Chrome extension** rebuilt on the core, with root-cause fixes for detection, undo, duplicates, wrong-editor writes and key exposure
5. ✅ **Premium UI**: assistant panel, mic page, overlay; light/dark/high-contrast; onboarding walkthrough
6. ✅ **Tests**: unit, real-VS-Code integration, real-browser compatibility
7. ✅ **Evaluation**: 144-command dataset, offline harness, live harness (model path not yet run; see below)
8. ✅ **Docs and presentation**: README, architecture, security, demo script, screenshots, CI

## Status by requirement

| Area | Status | Evidence |
|---|---|---|
| Editor detection and insertion (browser) | Fixed at the root (MAIN-world bridge) | `npm run test:browser` 43/43 on Monaco, CM5, CM6, Ace, textarea, contenteditable |
| Duplicate speech events and races | Fixed | Eval: 33.3% → 0% duplicates, 0 missed (600 utterances); unit tests for stale instances, promotion and restart |
| Undo / rollback | Transactional, verified, refuses to clobber manual edits | VS Code integration + browser tests |
| Async results hitting the wrong editor | Bound to the spoken-in target; stale protection | Integration tests (editor switch, concurrent typing) |
| Permissions and logging | Narrowed; no transcript/code logging; keys isolated | docs/AUDIT.md S1–S6 |
| Native VS Code extension | Done | 18 integration tests in VS Code 1.145.2 |
| Microphone in VS Code | Browser bridge (streaming, hi/te) + native ffmpeg/VAD | Bridge security integration test; VAD unit tests on synthetic audio |
| Intent engine (13 kinds, structured output) | Done | Unit tests; offline eval 90.3%; local precision 100% |
| Context-aware minimal edits | Done | Patch eval 10/10; integration tests |
| Conversational memory | Done (instructions + focus region) | Follow-up integration test |
| Voice editing commands | Done | Integration tests |
| Debugging (diagnostics, failing output → patch → diff) | Done | Executor implemented; exercised with a scripted provider in tests. **Live model quality not yet measured.** |
| Voice agent (plan, approvals, typed tools, bounds) | Done | Unit tests, 8/8 fault scenarios, integration test with approvals and denial |
| Terminal and git with approvals and policy | Done | Integration tests: denied run, approved run, blocked command, approved commit |
| Performance | Local commands p50 0.54 ms / p95 0.84 ms in VS Code | `eval/results/vscode-local-latency.json` |
| CI | GitHub Actions workflow added | Not yet run on GitHub (the branch is unpushed) |

## Not done / not verified (honest list)

- **Model-path metrics were not measured**: intent accuracy with a model, model latency p50/p95, tokens per command, live code-edit success. No API key was available in this environment. Run `ANTHROPIC_API_KEY=… npm run eval -- --live` (or `OPENAI_API_KEY`, with `VOICECODER_PROVIDER=openai`).
- **Real microphone audio was not exercised in automated tests.** Speech lifecycles are tested with fake recognition and a virtual clock; VAD is tested with synthetic audio. The ffmpeg command line was checked against the installed ffmpeg's device list, but capture was not run (it would trigger a macOS permission prompt).
- The **Chrome extension end to end** (popup → service worker → content script → model) was not run in a browser with the extension loaded. The page bridge was tested in real Chrome against real editors. The extension builds and typechecks.
- **vscode.dev / github.dev** don't expose `window.monaco`. There, the browser extension falls back to dictation-style insertion.
- **Hindi/Telugu:** speech recognition depends on the browser engine. Open-ended commands need the model; only "go to line N" is in the offline grammar.
- The offline heuristic was tuned while building the dataset (no held-out split).
- **No license file**: choosing one is the owner's decision.

## Log

- **Audit**: read every file; documented 9 correctness and 6 security/privacy findings.
- **Monorepo + core**: npm workspaces, TS strict, vitest. Core with 155 tests.
- **VS Code extension**: orchestrator, executors, ChangeManager, mic providers, webview. 16 integration tests in real VS Code. Found and fixed a redo bug (redo could pick an older undone change) and lost follow-up context (memory stored raw transcripts instead of resolved instructions).
- **Perf**: moved language-server symbol lookup off the local-command path (local p95 330 ms → sub-millisecond).
- **Mic bridge security test**: token, Host (DNS rebinding), Origin, schema.
- **Chrome**: page bridge, content script, overlay, worker. Real-browser tests found CodeMirror 6's newer `cmTile` internals and a test caret bug; fixed. Split zod out of the content bundle (824 KB → 47 KB).
- **Eval**: dataset + harness. Found a gate window that swallowed deliberate repeats; fixed (1 missed → 0).
- **UI polish** from rendered screenshots (logo mark, redundant agent card, invisible borders).
- **Docs, CI, demo project**.

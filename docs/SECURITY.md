# Security and privacy

VoiceCoder turns speech into actions on a developer's machine. The design assumes that the model can be wrong and that file contents and speech can be adversarial (prompt injection). Safety therefore lives in code paths the model cannot bypass.

## Trust boundaries

| Boundary | Control |
|---|---|
| Model output → executor | Structured output parsed with zod; anything invalid is rejected or falls back. Intents map to a fixed set of executors; there is no "eval" path. |
| Model output → files | Search/replace edits must match existing text exactly once (or be a cursor insert). Every change is a reversible transaction, applied only to the document the command was spoken in. Agent writes are confined to the workspace (`isInsideWorkspace`) and may not touch `.git/`, `.env*`, `node_modules/`, keys or certificates (`isProtectedPath`). |
| Model output → processes | `assessCommand` blocks privilege escalation, recursive deletion of `/`, `~`, `..` or `*`, disk tools, `curl … \| sh`, decoded payload execution, fork bombs, credential reads, environment exfiltration and reverse shells. Everything else is labelled (deletes files, network, installs, rewrites history, writes outside the workspace, …) and needs **explicit approval**. Multi-line and control-character commands are rejected. |
| Git | Read-only operations run without approval. Stage, commit and push need approval. Git is invoked with argv (`execFile`), so commit messages cannot inject shell syntax. |
| Workspace trust | In untrusted workspaces, commands, test runs, git writes and agent mode are disabled. |
| Browser microphone bridge (VS Code) | Loopback only (`127.0.0.1`), random port, 256-bit token in every path, exact `Host` header check (blocks DNS rebinding), `Origin` check on POSTs, strict CSP, 16 KB body limit, schema-validated events. All covered by an integration test. |
| Chrome page ↔ extension | The MAIN-world bridge exposes a narrow, verified edit API. Edits carry the expected text and are refused if it differs. The page can at most influence its own editor. API keys never enter content scripts. |
| Chrome messages | Only this extension's contexts are accepted. Settings and keys are writable only from extension pages. No message returns key material. |

## Human approval

`ApprovalBroker` is the only path to these actions. It can be resolved by voice ("approve" / "deny"), by the panel buttons or from the notification. A new request denies a stale one, cancellation denies, and there is no auto-approve setting.

| Action | Approval |
|---|---|
| Run tests / build / any terminal command | Required, showing the command and risk labels |
| Install dependencies | Required (labelled "installs packages") |
| Git stage, commit, push | Required, showing the exact commit message |
| Agent plan | Required before any step runs |
| Agent file writes and edits | Required per action (each one is undoable) |
| Agent commands | Required per command, with policy checks |
| Code edits from voice commands | Not gated (reversible and reviewable). `preview-first` mode gates them too. |

## Data handling

- **Keys:** VS Code `SecretStorage` (OS keychain). In Chrome, `chrome.storage.local`, readable only by the background worker. Never in settings, logs, workspace files or page context.
- **Logs:** the `VoiceCoder` output channel records event kinds, model purposes, latencies, token counts and error categories. Never transcripts, code, prompts or responses.
- **Metrics:** stage name + duration + counters only, stored in extension global state; resettable.
- **Sent to the model provider:** only when the command needs it — the cursor window or a small file, the selection, the enclosing function, diagnostics, a budgeted list of project paths, and short summaries of recent turns. Context is capped by `voicecoder.context.budgetTokens`.
- **Speech:** the browser path uses the browser's speech service (Chrome sends audio to Google's service); the native path sends VAD-segmented audio to OpenAI transcription. No audio is stored by VoiceCoder.
- **Conversation memory:** in memory only, expires after 45 minutes idle, and can be cleared with *VoiceCoder: Forget Conversation*.

## Reporting

Please report vulnerabilities privately to the repository owner rather than in a public issue.

// Isolated-world content script: speech capture, local intent fast path, and verified
// application of model results through the MAIN-world page bridge.
//
// Fixes vs. the original extension:
//   * Duplicate commands: shared WebSpeechController (per-result-index commit) + UtteranceGate.
//   * Wrong editor: the target editor and its exact text are captured when the command is
//     spoken; results are applied only to that editor and only if its text is unchanged.
//   * Undo: transactional — restores the previous text only if the editor still holds
//     VoiceCoder's output (no crash, no clobbering manual edits).
//   * No transcripts or code are logged to the page console.

import { WebSpeechController, browserRecognitionFactory, type ListenMode } from '@voicecoder/core/speech/web-speech';
import { UtteranceGate } from '@voicecoder/core/speech/utterance-gate';
import { normalizeTranscript } from '@voicecoder/core/speech/normalize';
import { parseLocalIntent } from '@voicecoder/core/intent/local-parser';
import { applyChanges, PatchError, resolveEdits } from '@voicecoder/core/edit/patch';
import { detectIndent, extractImports, windowAround, type EditorContext } from '@voicecoder/core/context/context';
import { REQUEST_EVENT, RESPONSE_EVENT, type BridgeRequest, type BridgeResponse, type EditorState } from './bridge-protocol.js';
import { Overlay } from './overlay.js';
import { PORT_COMMAND, type CommandEvent, type CommandRequest, type ToContent, type ToWorker } from './messages.js';

declare global {
  interface Window {
    __voicecoderContent?: boolean;
  }
}

if (!window.__voicecoderContent) {
  window.__voicecoderContent = true;
  main();
}

function main(): void {
  // ── Page bridge RPC ─────────────────────────────────────────────────────
  let rpcSeq = 0;
  const pending = new Map<number, (r: BridgeResponse) => void>();
  document.addEventListener(RESPONSE_EVENT, (e) => {
    let res: BridgeResponse;
    try {
      res = JSON.parse((e as CustomEvent<string>).detail);
    } catch {
      return;
    }
    pending.get(res.id)?.(res);
    pending.delete(res.id);
  });
  type Req = BridgeRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;
  function bridge(req: Req, timeoutMs = 1500): Promise<BridgeResponse> {
    const id = ++rpcSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ id, ok: false, code: 'failed', error: 'The page editor did not respond.' });
      }, timeoutMs);
      pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      document.dispatchEvent(new CustomEvent(REQUEST_EVENT, { detail: JSON.stringify({ ...req, id }) }));
    });
  }

  // ── State ───────────────────────────────────────────────────────────────
  interface Tx {
    targetId: string;
    before: string;
    after: string;
    label: string;
  }
  const history: Tx[] = [];
  const gate = new UtteranceGate();
  let listening = false;
  let mode: ListenMode = 'continuous';
  let activePort: chrome.runtime.Port | null = null;
  let commandSeq = 0;

  const overlay = new Overlay({
    onClose: () => {
      stop();
      void send({ type: 'listening-changed', listening: false });
    },
    onUndo: () => void undo(),
  });

  const speech = new WebSpeechController(
    browserRecognitionFactory(),
    {
      onInterim: (text) => overlay.interim(text),
      onFinal: (text) => {
        const d = gate.offer(text);
        if (d.accept) void handle(text);
      },
      onState: (s) => {
        if (s === 'listening') overlay.show('listening', 'Listening', { chip: mode === 'push-to-talk' ? 'push-to-talk' : undefined });
        if (s === 'idle' && !listening) overlay.hide(600);
      },
      onError: (code, message) => {
        overlay.show('error', 'Microphone', { message });
        if (code === 'not-allowed' || code === 'unsupported' || code === 'audio-capture') {
          listening = false;
          void send({ type: 'listening-changed', listening: false });
        }
      },
    },
    { lang: 'en-US', mode },
  );

  function start(lang: string, m: ListenMode): void {
    mode = m;
    speech.setLanguage(lang);
    speech.setMode(m);
    if (listening) return;
    listening = true;
    gate.reset();
    speech.start();
  }

  function stop(): void {
    if (!listening) return;
    listening = false;
    speech.stop();
    overlay.hide(300);
  }

  function send(msg: ToWorker): Promise<unknown> {
    return chrome.runtime.sendMessage(msg).catch(() => undefined);
  }

  chrome.runtime.onMessage.addListener((msg: ToContent, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    switch (msg.type) {
      case 'start':
        start(msg.lang, msg.mode);
        reply({ listening });
        break;
      case 'stop':
        stop();
        reply({ listening });
        break;
      case 'toggle':
        if (listening) stop();
        else start(msg.lang, msg.mode);
        reply({ listening });
        break;
      case 'undo':
        void undo();
        reply({ ok: true });
        break;
      case 'ping':
        reply({ listening });
        break;
    }
  });

  // ── Pipeline ────────────────────────────────────────────────────────────
  async function handle(raw: string): Promise<void> {
    const transcript = normalizeTranscript(raw);
    if (!transcript) return;
    const seq = ++commandSeq;
    const parsed = parseLocalIntent(transcript);
    // Explanations are recognised locally but answered by the model.
    const local = parsed && parsed.kind !== 'explain' ? parsed : null;

    // Snapshot the target editor *now* — this is what the developer was looking at.
    const stateRes = await bridge({ op: 'state' });
    const state = stateRes.ok ? stateRes.state : undefined;

    if (local) {
      await runLocal(local.kind === 'control' ? local.action : local.kind, local, state, transcript);
      return;
    }
    if (!state) {
      overlay.show('error', 'No editor focused', { transcript, message: stateRes.ok ? '' : stateRes.error });
      return;
    }

    activePort?.disconnect(); // a newer command supersedes (and cancels) an older one
    overlay.show('thinking', 'Thinking', { transcript });
    const port = chrome.runtime.connect({ name: PORT_COMMAND });
    activePort = port;
    const request: CommandRequest = { transcript, context: buildContext(state), prose: state.prose };
    port.postMessage(request);
    let kindLabel = '';

    port.onMessage.addListener(async (ev: CommandEvent) => {
      if (seq !== commandSeq) return; // stale: a newer command is running
      switch (ev.type) {
        case 'intent':
          kindLabel = ev.kind;
          overlay.show('thinking', ev.kind === 'explain' ? 'Explaining' : 'Writing', { transcript, chip: `${ev.kind} · ${ev.source === 'llm' ? 'model' : ev.source}` });
          break;
        case 'preview':
          overlay.preview(ev.text);
          break;
        case 'edits':
          port.disconnect();
          await applyPlan(state, ev.edits, ev.summary, transcript, kindLabel);
          break;
        case 'insert':
          port.disconnect();
          await insertText(state, ev.text, transcript);
          break;
        case 'text':
          port.disconnect();
          overlay.show('done', ev.title, { transcript, message: ev.text });
          void send({ type: 'record-turn', transcript, kind: kindLabel, outcome: ev.title, ok: true });
          break;
        case 'unsupported':
        case 'error':
          port.disconnect();
          overlay.show('error', ev.type === 'unsupported' ? 'Not available here' : 'Could not complete', { transcript, message: ev.message });
          void send({ type: 'record-turn', transcript, kind: kindLabel || 'unknown', outcome: ev.message, ok: false });
          break;
      }
    });
    port.onDisconnect.addListener(() => {
      if (activePort === port) activePort = null;
    });
  }

  async function applyPlan(state: EditorState, edits: CommandRequestEdits, summary: string, transcript: string, kind: string): Promise<void> {
    if (state.text === null) {
      // Opaque editors (rich text): fall back to inserting the new code at the cursor.
      const code = edits.map((e) => e.replace).join('\n');
      await insertText(state, code, transcript);
      return;
    }
    let after: string;
    let changes;
    try {
      changes = resolveEdits(state.text, edits, state.selectionStart);
      after = applyChanges(state.text, changes);
    } catch (err) {
      overlay.show('error', 'Could not apply', { transcript, message: err instanceof PatchError ? err.message : String(err) });
      return;
    }
    const last = changes.at(-1)!;
    let shift = 0;
    for (const c of changes.slice(0, -1)) shift += c.text.length - (c.end - c.start);
    const caret = last.start + shift + last.text.length;
    const res = await bridge({ op: 'apply', targetId: state.targetId, expectedText: state.text, changes, select: { start: caret, end: caret } });
    if (!res.ok) {
      overlay.show('error', 'Not applied', { transcript, message: res.error });
      return;
    }
    const finalText = res.text ?? after;
    history.push({ targetId: state.targetId, before: state.text, after: finalText, label: summary });
    if (history.length > 30) history.shift();
    const lines = (s: string) => s.split('\n').length;
    const firstLine = state.text.slice(0, changes[0]!.start).split('\n').length;
    void send({ type: 'set-focus', startLine: firstLine, endLine: firstLine + lines(changes.map((c) => c.text).join('\n')) });
    void send({ type: 'record-turn', transcript, kind, outcome: summary, ok: true });
    overlay.show('done', summary, { transcript, undo: true, chip: kind });
    overlay.hide(6000);
  }

  async function insertText(state: EditorState, text: string, transcript: string): Promise<void> {
    const res = await bridge({ op: 'insert', targetId: state.targetId, text });
    if (!res.ok) {
      overlay.show('error', 'Not inserted', { transcript, message: res.error });
      return;
    }
    if (state.text !== null && res.text !== null && res.text !== undefined) history.push({ targetId: state.targetId, before: state.text, after: res.text, label: 'Insert' });
    void send({ type: 'record-turn', transcript, kind: 'dictation', outcome: 'Inserted text', ok: true });
    overlay.show('done', 'Inserted', { transcript, undo: state.text !== null });
    overlay.hide(3000);
  }

  async function undo(): Promise<void> {
    const tx = history.at(-1);
    if (!tx) {
      overlay.show('error', 'Nothing to undo');
      overlay.hide(2000);
      return;
    }
    const res = await bridge({ op: 'revert', targetId: tx.targetId, expectedText: tx.after, restoreText: tx.before });
    if (!res.ok) {
      overlay.show('error', 'Undo refused', { message: res.error });
      return;
    }
    history.pop();
    overlay.show('done', `Undid: ${tx.label}`);
    overlay.hide(2500);
  }

  async function runLocal(action: string, intent: NonNullable<ReturnType<typeof parseLocalIntent>>, state: EditorState | undefined, transcript: string): Promise<void> {
    switch (action) {
      case 'undo':
        return undo();
      case 'cancel':
        activePort?.disconnect();
        commandSeq++;
        overlay.show('done', 'Cancelled');
        overlay.hide(1500);
        return;
      case 'stop-listening':
        stop();
        void send({ type: 'listening-changed', listening: false });
        return;
      case 'accept':
        overlay.show('done', 'Kept');
        overlay.hide(1200);
        return;
      case 'reject':
        return undo();
      case 'dictation':
        if (!state || intent.kind !== 'dictation') return;
        return insertText(state, intent.text, transcript);
      case 'navigate':
        if (intent.kind === 'navigate' && intent.target.type === 'line' && state) {
          const r = await bridge({ op: 'goto-line', targetId: state.targetId, line: intent.target.line });
          overlay.show(r.ok ? 'listening' : 'error', r.ok ? `Line ${intent.target.line}` : 'Cannot navigate', { message: r.ok ? '' : r.error });
          return;
        }
        overlay.show('error', 'Not available in the browser', { transcript, message: 'File, symbol and error navigation are available in the VS Code extension.' });
        return;
      default:
        overlay.show('error', 'Not available in the browser', { transcript, message: 'Terminal, git, tests and agent mode run in the VoiceCoder VS Code extension.' });
    }
  }
}

type CommandRequestEdits = Array<{ search: string; replace: string }>;

const LANG_BY_EDITOR: Record<string, string> = { python: 'python', javascript: 'javascript', typescript: 'typescript', cpp: 'cpp', java: 'java', go: 'go', rust: 'rust' };

function buildContext(state: EditorState): EditorContext {
  const text = state.text ?? '';
  const before = text.slice(0, state.selectionStart);
  const line = before.split('\n').length;
  const column = before.length - before.lastIndexOf('\n');
  const lines = text.split('\n');
  const ctx: EditorContext = {
    host: 'browser',
    fileName: location.hostname + location.pathname.slice(0, 60),
    languageId: (state.languageId && LANG_BY_EDITOR[state.languageId]) || state.languageId || guessLanguage(text),
    lineCount: lines.length,
    cursor: { line, column },
    window: windowAround(lines, line, 40, 20),
    document: text.length <= 40_000 ? text : undefined,
    indentUnit: detectIndent(text),
    eol: '\n',
    imports: extractImports(text),
  };
  if (state.selectionEnd > state.selectionStart && state.text) {
    const startLine = line;
    const selText = state.text.slice(state.selectionStart, state.selectionEnd);
    ctx.selection = { startLine, endLine: startLine + selText.split('\n').length - 1, text: selText };
  }
  return ctx;
}

function guessLanguage(text: string): string {
  if (/^\s*(def |import \w+$|from \w+ import)/m.test(text)) return 'python';
  if (/#include\s*</.test(text)) return 'cpp';
  if (/\bpublic\s+(static\s+)?\w+.*\(/.test(text)) return 'java';
  if (/\bfunc\s+\w+\(/.test(text)) return 'go';
  if (/\bfn\s+\w+\(|let mut /.test(text)) return 'rust';
  if (/:\s*(string|number|boolean)\b|interface \w+/.test(text)) return 'typescript';
  return 'javascript';
}

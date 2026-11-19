// The voice → intent → action pipeline.
//
//   speech final ─► UtteranceGate (dedupe) ─► approval shortcut? ─► IntentEngine
//        └─► CommandCoordinator lane (cancel/supersede, timeout) ─► executor ─► memory, metrics, UI
//
// Local commands (navigation, undo, accept, …) never touch the network. Each command is
// bound to the editor snapshot taken when it was spoken, so late results cannot land in
// the wrong file or selection.

import * as vscode from 'vscode';
import {
  CommandCoordinator,
  createProvider,
  IntentEngine,
  isConsequential,
  LLMError,
  MetricsRecorder,
  OpenAITranscriber,
  PatchError,
  SessionMemory,
  Stopwatch,
  UtteranceGate,
  newId,
  type Intent,
  type LLMProvider,
  type Sample,
} from '@voicecoder/core';
import { getApiKey, readSettings, type Settings } from './config.js';
import { enrichSnapshot, snapshotActiveEditor, type TargetSnapshot } from './context/collector.js';
import { ChangeManager } from './editor/changes.js';
import { runAgent } from './executors/agent.js';
import { runDictation, runEdit, runTestGeneration } from './executors/editing.js';
import { runExplain } from './executors/explain.js';
import { runNavigation } from './executors/navigation.js';
import { UserFacingError, type ExecResult, type Runtime } from './executors/runtime.js';
import { runGit, runTerminal, runTests } from './executors/shell.js';
import { ApprovalBroker } from './services/approvals.js';
import { ProcessRunner } from './services/process.js';
import { describeProject, detectProject } from './services/project.js';
import { BrowserSpeechBridge } from './speech/browser-bridge.js';
import { NativeMicSource } from './speech/native.js';
import type { SpeechEvent, SpeechSource } from './speech/types.js';
import type { AgentView, CommandView, HostMessage, Phase, UiState } from './ui/protocol.js';

const METRICS_KEY = 'voicecoder.metrics.v1';

/** Resolved instruction per in-flight command, recorded into conversational memory. */
const instructions = new Map<string, string>();

function instructionOf(intent: Intent): string {
  switch (intent.kind) {
    case 'generate':
    case 'modify':
    case 'refactor':
    case 'debug':
      return intent.instruction;
    case 'agent':
      return intent.goal;
    case 'terminal':
      return intent.description;
    default:
      return intent.transcript;
  }
}
const HISTORY_LIMIT = 40;

export class Orchestrator implements vscode.Disposable {
  readonly changes = new ChangeManager();
  readonly approvals = new ApprovalBroker();
  readonly runner = new ProcessRunner();
  readonly memory = new SessionMemory();
  readonly metrics = new MetricsRecorder();
  private readonly engine = new IntentEngine();
  private readonly gate = new UtteranceGate();
  private readonly coordinator = new CommandCoordinator(1200);
  private readonly log: vscode.LogOutputChannel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly uiEmitter = new vscode.EventEmitter<HostMessage>();
  readonly onUi = this.uiEmitter.event;

  private provider: LLMProvider | null = null;
  private providerError: string | null = null;
  private speech: SpeechSource | null = null;
  private speechSub: vscode.Disposable | null = null;
  private settings: Settings = readSettings();
  private hasKey = false;
  private listening = false;
  private phase: Phase = 'idle';
  private phaseDetail: string | undefined;
  private interim = '';
  private current: CommandView | null = null;
  private history: CommandView[] = [];
  private agent: AgentView | null = null;
  private statusBar: vscode.StatusBarItem;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly micAssets: { html: () => Promise<string>; script: () => Promise<string> },
  ) {
    this.log = vscode.window.createOutputChannel('VoiceCoder', { log: true });
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
    this.statusBar.command = 'voicecoder.toggleListening';
    this.statusBar.show();
    this.metrics.restore(ctx.globalState.get(METRICS_KEY) ?? {});
    this.disposables.push(
      this.log,
      this.statusBar,
      this.changes,
      this.approvals,
      this.runner,
      this.uiEmitter,
      this.approvals.onDidChange(() => {
        if (this.approvals.pending) this.setPhase('awaiting-approval', this.approvals.pending.title);
        this.push();
      }),
      this.changes.onDidChange(() => this.push()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('voicecoder')) void this.reconfigure();
      }),
      ctx.secrets.onDidChange((e) => {
        if (e.key.startsWith('voicecoder.')) void this.reconfigure();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.push()),
    );
    void this.reconfigure();
  }

  // ── Configuration ────────────────────────────────────────────────────────
  async reconfigure(): Promise<void> {
    const prevSpeech = this.settings.speechProvider;
    this.settings = readSettings();
    const key = await getApiKey(this.ctx.secrets, this.settings.provider);
    this.hasKey = !!key;
    this.provider = null;
    this.providerError = null;
    if (key) {
      try {
        this.provider = createProvider({
          provider: this.settings.provider,
          apiKey: key,
          model: this.settings.model || undefined,
          fastModel: this.settings.fastModel || undefined,
          observer: (e) => {
            this.metrics.increment(`llm.calls.${e.ok ? 'ok' : 'error'}`);
            if (!e.ok) this.log.warn(`model call failed: purpose=${e.purpose} kind=${e.errorKind} ms=${Math.round(e.latencyMs)}`);
            else this.log.info(`model call: purpose=${e.purpose} model=${e.model} ms=${Math.round(e.latencyMs)} in=${e.usage?.inputTokens} out=${e.usage?.outputTokens}`);
          },
        });
      } catch (err) {
        this.providerError = err instanceof Error ? err.message : String(err);
      }
    }
    this.engine.setProvider(this.provider);
    if (this.speech && prevSpeech !== this.settings.speechProvider) {
      this.disposeSpeech();
    }
    this.speech?.setLanguage(this.settings.language);
    this.speech?.setMode(this.settings.mode);
    this.push();
  }

  /**
   * Replace the model provider (tests, evaluation harness, embedding hosts). The next
   * configuration change restores the provider from settings.
   */
  useProvider(provider: LLMProvider | null): void {
    this.provider = provider;
    this.hasKey = provider !== null;
    this.engine.setProvider(provider);
    this.push();
  }

  // ── Speech ───────────────────────────────────────────────────────────────
  private ensureSpeech(): SpeechSource {
    if (this.speech) return this.speech;
    const s = this.settings;
    this.speech =
      s.speechProvider === 'native'
        ? new NativeMicSource(
            async () => {
              const key = await getApiKey(this.ctx.secrets, 'openai');
              return key ? new OpenAITranscriber(key) : null;
            },
            { ffmpegPath: s.ffmpegPath, device: s.nativeInputDevice, lang: s.language, mode: s.mode },
          )
        : new BrowserSpeechBridge(this.micAssets.html, this.micAssets.script, { lang: s.language, mode: s.mode });
    this.speechSub = this.speech.onEvent((e) => this.onSpeech(e));
    return this.speech;
  }

  private disposeSpeech(): void {
    this.speechSub?.dispose();
    this.speech?.dispose();
    this.speech = null;
    this.listening = false;
  }

  async toggleListening(): Promise<void> {
    if (this.listening) this.stopListening();
    else await this.startListening();
  }

  async startListening(): Promise<void> {
    this.listening = true;
    this.gate.reset();
    this.setPhase('connecting');
    await this.ensureSpeech().start();
    this.push();
  }

  stopListening(): void {
    this.listening = false;
    this.speech?.stop();
    this.interim = '';
    if (this.phase === 'listening' || this.phase === 'connecting') this.setPhase('idle');
    this.push();
  }

  openMicPage(): void {
    const s = this.ensureSpeech();
    if (s instanceof BrowserSpeechBridge && s.connected) return;
    void s.start();
    this.listening = true;
  }

  private onSpeech(e: SpeechEvent): void {
    switch (e.type) {
      case 'state':
        if (e.state === 'listening') {
          this.listening = true;
          if (this.phase === 'idle' || this.phase === 'connecting' || this.phase === 'error') this.setPhase('listening');
        } else if (e.state === 'idle') {
          this.listening = false;
          this.interim = '';
          if (this.phase === 'listening' || this.phase === 'connecting') this.setPhase('idle', e.detail);
        } else if (e.state === 'connecting') {
          this.setPhase('connecting', e.detail);
        } else if (e.state === 'error') {
          this.listening = false;
          this.setPhase('error', e.detail);
        }
        this.push();
        return;
      case 'interim':
        this.interim = e.text;
        this.uiEmitter.fire({ type: 'interim', text: e.text });
        return;
      case 'level':
        this.uiEmitter.fire({ type: 'level', rms: e.rms });
        return;
      case 'speech-start':
        return;
      case 'error':
        this.log.warn(`speech error: ${e.code}`);
        if (e.code !== 'network') void vscode.window.showWarningMessage(`VoiceCoder: ${e.message}`);
        this.setPhase('error', e.message);
        this.push();
        return;
      case 'final': {
        this.interim = '';
        this.uiEmitter.fire({ type: 'interim', text: '' });
        if (e.latencyMs) this.metrics.record('speech.transcribe', e.latencyMs);
        const decision = this.gate.offer(e.text);
        if (!decision.accept) {
          this.metrics.increment('speech.duplicates-suppressed');
          this.log.info(`suppressed ${decision.reason} utterance`);
          return;
        }
        void this.handleUtterance(e.text, 'voice');
      }
    }
  }

  // ── Pipeline ─────────────────────────────────────────────────────────────
  async handleUtterance(text: string, origin: 'voice' | 'typed'): Promise<void> {
    const transcript = text.trim();
    if (!transcript) return;
    const sw = new Stopwatch();
    this.metrics.increment('commands.total');

    // Snapshot BEFORE anything slow: this is the editor/selection the developer meant.
    // Language-server symbols are added later, only for intents that need them, so
    // local commands never wait on a language server.
    const snap = await snapshotActiveEditor({ withSymbols: false });
    sw.lap('context');

    const cmd: CommandView = { id: newId('cmd'), transcript, status: 'running', title: 'Understanding…', at: Date.now() };
    this.current = cmd;
    this.setPhase('thinking', 'Understanding…');
    this.push();

    let intent: Intent;
    try {
      const res = await this.engine.classify(transcript, {
        history: this.memory.render(),
        fileName: snap?.context.relativePath,
        languageId: snap?.context.languageId,
        hasSelection: !!snap?.context.selection?.text,
        cursorLine: snap?.context.cursor.line,
        diagnosticsCount: snap?.context.diagnostics?.length,
        lastGeneratedSymbol: this.memory.getFocus(snap?.context.relativePath)?.symbol,
        proseTarget: snap ? /^(markdown|plaintext|git-commit|scminput)$/.test(snap.context.languageId) : false,
      });
      intent = res.intent;
      this.metrics.record(`intent.${intent.source}`, res.latencyMs);
      this.metrics.increment(`intent.source.${intent.source}`);
      if (res.usage) {
        this.metrics.increment('tokens.input', res.usage.inputTokens);
        this.metrics.increment('tokens.output', res.usage.outputTokens);
      }
      if (res.fallbackReason && this.provider) this.log.warn(`intent fallback: ${res.fallbackReason}`);
      Object.assign(cmd, { intent: intent.kind, source: intent.source, transcript: res.normalized });
      instructions.set(cmd.id, instructionOf(intent));
    } catch (err) {
      this.finish(cmd, sw, { ok: false, title: 'Cancelled', outcome: 'Cancelled', status: 'cancelled' }, transcript);
      return;
    }
    sw.lap('intent');
    this.log.info(`command: kind=${intent.kind} source=${intent.source} origin=${origin}`);

    // Voice approvals: "approve"/"yes"/"accept" or "deny"/"no" resolve a pending approval.
    if (this.approvals.pending && intent.kind === 'control' && (intent.action === 'accept' || intent.action === 'reject' || intent.action === 'cancel')) {
      this.approvals.resolve(intent.action === 'accept');
      this.finish(cmd, sw, { ok: true, title: intent.action === 'accept' ? 'Approved' : 'Denied', outcome: intent.action === 'accept' ? 'Approved action' : 'Denied action', status: 'done' }, transcript, true);
      return;
    }

    if (intent.kind === 'control') {
      const result = await this.safe(() => this.runControl(intent as Extract<Intent, { kind: 'control' }>));
      this.finish(cmd, sw, result, transcript, true);
      return;
    }
    if (intent.kind === 'navigate') {
      const result = await this.safe(() => runNavigation(intent as Extract<Intent, { kind: 'navigate' }>));
      this.finish(cmd, sw, result, transcript, true);
      return;
    }

    const lane = intent.kind === 'agent' ? 'agent' : 'main';
    const timeoutMs = intent.kind === 'agent' ? 30 * 60_000 : isConsequential(intent) ? 20 * 60_000 : 180_000;
    const key = `${intent.kind}:${cmd.transcript}`;
    const outcome = await this.coordinator.run(lane, key, (task) => this.execute(intent, snap, task.signal, task.commit), { timeoutMs });
    if (outcome.status === 'duplicate') {
      this.metrics.increment('commands.duplicates-dropped');
      this.current = this.history[0] ?? null;
      this.setPhase(this.listening ? 'listening' : 'idle');
      this.push();
      return;
    }
    if (outcome.status === 'cancelled') {
      this.finish(cmd, sw, { ok: false, title: 'Cancelled', outcome: 'Cancelled', status: 'cancelled' }, transcript);
      return;
    }
    if (outcome.status === 'error') {
      this.finish(cmd, sw, this.errorResult(outcome.error), transcript);
      return;
    }
    this.finish(cmd, sw, outcome.value, transcript);
  }

  private async execute(intent: Intent, snap: TargetSnapshot | null, signal: AbortSignal, commit: () => void): Promise<ExecResult> {
    const rt = this.runtime();
    if (snap) await enrichSnapshot(snap);
    const needEditor = () => {
      if (!snap) throw new UserFacingError('Open a file and place the cursor where you want the change.');
      return snap;
    };
    switch (intent.kind) {
      case 'generate':
      case 'modify':
      case 'refactor':
      case 'debug':
        return runEdit(rt, intent, needEditor(), signal);
      case 'dictation':
        return runDictation(rt, intent, needEditor());
      case 'rename':
        return this.runRename(intent.newName, needEditor());
      case 'explain':
        return runExplain(rt, intent, snap, signal);
      case 'test':
        if (intent.action === 'generate') {
          const root = rt.workspaceRoot();
          const summary = root ? describeProject(await detectProject(root)) : '';
          return runTestGeneration(rt, intent, needEditor(), signal, summary);
        }
        commit();
        return runTests(rt, signal);
      case 'terminal':
        commit();
        return runTerminal(rt, intent, signal);
      case 'git':
        if (intent.action === 'commit' || intent.action === 'push') commit();
        return runGit(rt, intent, signal);
      case 'agent':
        return runAgent(rt, intent, signal);
      default:
        throw new UserFacingError('Unsupported command.');
    }
  }

  private async runControl(intent: Extract<Intent, { kind: 'control' }>): Promise<ExecResult> {
    const editor = vscode.window.activeTextEditor;
    const done = (title: string, message?: string): ExecResult => ({ ok: true, title, message, outcome: title, status: 'done' });
    switch (intent.action) {
      case 'undo':
        return done('Undo', await this.changes.undo());
      case 'redo':
        return done('Redo', await this.changes.redo());
      case 'accept':
        return done('Accepted', await this.changes.accept());
      case 'reject':
        return done('Rejected', await this.changes.reject());
      case 'cancel': {
        const any = this.coordinator.cancel();
        this.approvals.resolve(false);
        return done('Cancelled', any ? 'Stopped the running command.' : 'Nothing was running.');
      }
      case 'stop-listening':
        this.stopListening();
        return done('Stopped listening');
      case 'save':
        await vscode.commands.executeCommand('workbench.action.files.save');
        return done('Saved');
      case 'format':
        await vscode.commands.executeCommand('editor.action.formatDocument');
        return done('Formatted');
      case 'select-function': {
        if (!editor) throw new UserFacingError('Open a file first.');
        const snap = await snapshotActiveEditor({ withSymbols: true });
        const s = snap?.context.enclosingSymbol;
        if (!s) throw new UserFacingError('The cursor is not inside a function.');
        editor.selection = new vscode.Selection(s.startLine - 1, 0, s.endLine - 1, editor.document.lineAt(s.endLine - 1).text.length);
        return done(`Selected ${s.name}`);
      }
      case 'select-line':
        if (!editor) throw new UserFacingError('Open a file first.');
        await vscode.commands.executeCommand('expandLineSelection');
        return done('Selected line');
      case 'select-all':
        await vscode.commands.executeCommand('editor.action.selectAll');
        return done('Selected all');
      case 'new-line':
        if (!editor) throw new UserFacingError('Open a file first.');
        await vscode.commands.executeCommand('editor.action.insertLineAfter');
        return done('New line');
      case 'repeat': {
        const last = this.memory.lastRepeatable();
        if (!last) throw new UserFacingError('Nothing to repeat yet.');
        this.coordinator.forget('main', `${last.kind}:${last.transcript}`);
        setTimeout(() => void this.handleUtterance(last.transcript, 'typed'), 0);
        return done('Repeating', `“${last.transcript}”`);
      }
      case 'show-history':
        await vscode.commands.executeCommand('voicecoder.assistant.focus');
        return done('History');
    }
  }

  private async runRename(newName: string | undefined, snap: TargetSnapshot): Promise<ExecResult> {
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === snap.uri.toString());
    if (!newName) {
      if (editor) await vscode.window.showTextDocument(editor.document, editor.viewColumn);
      await vscode.commands.executeCommand('editor.action.rename');
      return { ok: true, title: 'Rename', message: 'Type or say the new name.', outcome: 'Opened rename', status: 'done' };
    }
    const pos = snap.selection.active;
    const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>('vscode.executeDocumentRenameProvider', snap.uri, pos, newName);
    if (!edit || edit.size === 0) throw new UserFacingError('Nothing to rename at the cursor (or the language has no rename support).');
    // Snapshot every touched document so the rename is one undoable transaction.
    const docs = await Promise.all(edit.entries().map(async ([uri]) => ({ uri, before: (await vscode.workspace.openTextDocument(uri)).getText() })));
    if (!(await vscode.workspace.applyEdit(edit))) throw new UserFacingError('VS Code rejected the rename.');
    const snapshots = await Promise.all(docs.map(async (d) => ({ uri: d.uri.toString(), before: d.before, after: (await vscode.workspace.openTextDocument(d.uri)).getText() })));
    this.changes.log.record(`Rename to ${newName}`, snapshots);
    const occurrences = edit.entries().reduce((n, [, edits]) => n + edits.length, 0);
    return { ok: true, title: `Renamed to ${newName}`, message: `${occurrences} occurrence${occurrences === 1 ? '' : 's'} in ${docs.length} file${docs.length === 1 ? '' : 's'}.`, outcome: `Renamed symbol to ${newName}`, status: 'done' };
  }

  cancel(): void {
    this.coordinator.cancel();
    this.approvals.resolve(false);
  }

  // ── Results, errors, metrics ─────────────────────────────────────────────
  private async safe(fn: () => Promise<ExecResult>): Promise<ExecResult> {
    try {
      return await fn();
    } catch (err) {
      return this.errorResult(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private errorResult(err: Error): ExecResult {
    let message = err.message;
    if (err instanceof LLMError) {
      if (err.kind === 'auth') message = `${err.message} Run “VoiceCoder: Set API Key…”.`;
      if (err.kind === 'config' && !this.provider) message = 'No model configured. Run “VoiceCoder: Set API Key…”.';
    } else if (!(err instanceof UserFacingError) && !(err instanceof PatchError)) {
      this.log.error(`unexpected error: ${err.name}: ${err.message}`);
    }
    return { ok: false, title: 'Could not complete', message, outcome: `Failed: ${message}`, status: 'error' };
  }

  private finish(cmd: CommandView, sw: Stopwatch, result: ExecResult, transcript: string, local = false): void {
    // End-to-end: from receiving the final transcript to the action completing (or the
    // change reaching review). For approval-gated commands this includes human wait time,
    // so they are recorded under e2e.model and should not be read as system latency.
    const total = sw.total();
    const stage = local ? 'e2e.local' : cmd.source === 'local' ? 'e2e.local-intent' : 'e2e.model';
    this.metrics.record(stage, total);
    this.metrics.increment(result.ok ? 'commands.ok' : result.status === 'cancelled' ? 'commands.cancelled' : 'commands.failed');

    Object.assign(cmd, {
      status: result.status ?? (result.ok ? 'done' : 'error'),
      title: result.title,
      message: result.message,
      body: result.body ?? cmd.body,
      file: result.file ?? cmd.file,
      latencyMs: Math.round(total),
      preview: undefined,
    });
    if (cmd.intent) {
      this.memory.record({ id: cmd.id, transcript, kind: cmd.intent as Intent['kind'], instruction: instructions.get(cmd.id) ?? transcript, outcome: result.outcome, file: result.file, ok: result.ok });
      instructions.delete(cmd.id);
    }
    this.history = [cmd, ...this.history.filter((h) => h.id !== cmd.id)].slice(0, HISTORY_LIMIT);
    this.current = cmd;
    this.setPhase(this.changes.hasPending ? 'review' : this.listening ? 'listening' : 'idle');
    this.push();
    void this.ctx.globalState.update(METRICS_KEY, this.trimmedMetrics());
  }

  private trimmedMetrics(): { samples: Sample[]; counters: Record<string, number> } {
    const snap = this.metrics.snapshot();
    return { samples: snap.samples.slice(-2000), counters: snap.counters };
  }

  resetMetrics(): void {
    this.metrics.reset();
    void this.ctx.globalState.update(METRICS_KEY, undefined);
    this.push();
  }

  // ── Runtime handed to executors ──────────────────────────────────────────
  private runtime(): Runtime {
    return {
      provider: () => {
        if (!this.provider) throw new UserFacingError(this.providerError ?? 'No model configured. Run “VoiceCoder: Set API Key…” to enable code changes.');
        return this.provider;
      },
      settings: () => this.settings,
      memory: this.memory,
      metrics: this.metrics,
      changes: this.changes,
      approvals: this.approvals,
      runner: this.runner,
      log: this.log,
      workspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri,
      trusted: () => vscode.workspace.isTrusted,
      update: (patch) => {
        if (this.current) Object.assign(this.current, patch);
        this.push();
      },
      preview: (text) => {
        if (this.current) this.uiEmitter.fire({ type: 'preview', id: this.current.id, text });
      },
      setAgent: (view) => {
        this.agent = view;
        this.push();
      },
      setPhase: (phase, detail) => {
        this.setPhase(phase, detail);
        this.push();
      },
    };
  }

  // ── UI state ─────────────────────────────────────────────────────────────
  private setPhase(phase: Phase, detail?: string): void {
    this.phase = phase;
    this.phaseDetail = detail;
    void vscode.commands.executeCommand('setContext', 'voicecoder.busy', phase === 'thinking' || phase === 'applying' || phase === 'running');
  }

  state(): UiState {
    return {
      phase: this.approvals.pending ? 'awaiting-approval' : this.phase,
      phaseDetail: this.phaseDetail,
      listening: this.listening,
      speechProvider: this.settings.speechProvider,
      speechLabel: this.settings.speechProvider === 'native' ? 'Native mic' : 'Browser mic',
      language: this.settings.language,
      mode: this.settings.mode,
      review: this.settings.review,
      interim: this.interim,
      current: this.current,
      history: this.history,
      approval: this.approvals.pending
        ? { ...this.approvals.pending, labels: this.approvals.pending.labels.map(String) }
        : null,
      agent: this.agent,
      hasPendingChange: this.changes.hasPending,
      provider: this.settings.provider === 'anthropic' ? 'Claude' : 'OpenAI',
      model: this.settings.model || (this.settings.provider === 'anthropic' ? 'claude-opus-5-5' : 'gpt-4.1'),
      hasKey: this.hasKey,
      trusted: vscode.workspace.isTrusted,
      metrics: this.metrics.stats(),
      counters: this.metrics.counters_(),
      platform: process.platform,
    };
  }

  /** Coalesces state pushes to one per animation-ish frame. */
  push(): void {
    this.updateStatusBar();
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.uiEmitter.fire({ type: 'state', state: this.state() });
    }, 16);
  }

  private updateStatusBar(): void {
    const p = this.approvals.pending ? 'awaiting-approval' : this.phase;
    const icon =
      p === 'thinking' || p === 'applying' || p === 'running' || p === 'connecting'
        ? '$(loading~spin)'
        : p === 'awaiting-approval'
          ? '$(question)'
          : p === 'review'
            ? '$(diff)'
            : p === 'error'
              ? '$(warning)'
              : this.listening
                ? '$(record)'
                : '$(mic)';
    const label = { idle: 'VoiceCoder', listening: 'Listening', connecting: 'Connecting', thinking: 'Thinking', applying: 'Applying', review: 'Review', 'awaiting-approval': 'Approve?', running: 'Running', error: 'VoiceCoder' }[p];
    this.statusBar.text = `${icon} ${label}`;
    this.statusBar.tooltip = this.listening ? 'VoiceCoder is listening — Alt+Space to stop' : 'VoiceCoder — Alt+Space to start listening';
    this.statusBar.backgroundColor = p === 'awaiting-approval' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  }

  dispose(): void {
    void this.ctx.globalState.update(METRICS_KEY, this.trimmedMetrics());
    this.coordinator.cancel();
    this.disposeSpeech();
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.disposables.forEach((d) => d.dispose());
  }
}

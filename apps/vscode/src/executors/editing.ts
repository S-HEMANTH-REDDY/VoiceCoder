// Code-changing intents: generate, modify, refactor, debug, dictation, test generation.
// All go through the minimal-edit protocol and the ChangeManager, so every result is a
// reviewable, reversible transaction bound to the document the command was spoken in.

import * as vscode from 'vscode';
import {
  buildEditSystem,
  buildEditUserPrompt,
  DebugPlanSchema,
  EditPlanSchema,
  isInsideWorkspace,
  isProtectedPath,
  PatchError,
  previewFromPartialJson,
  TestPlanSchema,
  type EditBlock,
  type IntentOf,
} from '@voicecoder/core';
import { findSymbolByName, documentSymbols, type TargetSnapshot } from '../context/collector.js';
import { UserFacingError, type ExecResult, type Runtime } from './runtime.js';

type EditIntent = IntentOf<'generate'> | IntentOf<'modify'> | IntentOf<'refactor'> | IntentOf<'debug'>;

interface Target {
  description: string;
  startLine: number;
  endLine: number;
}

/** Decide which code "it"/"this" refers to for a modification. */
async function resolveTarget(rt: Runtime, intent: EditIntent, snap: TargetSnapshot): Promise<Target | undefined> {
  const ctx = snap.context;
  if (ctx.selection?.text) return { description: 'the selected code', startLine: ctx.selection.startLine, endLine: ctx.selection.endLine };
  if (intent.kind === 'generate') return undefined;
  const scope = 'scope' in intent ? intent.scope : 'function';
  if (scope === 'file') return { description: 'the whole file', startLine: 1, endLine: ctx.lineCount };

  // Follow-ups ("make it async") refer to what VoiceCoder just changed in this file.
  const focus = rt.memory.getFocus(ctx.relativePath);
  if (focus) {
    if (focus.symbol) {
      const doc = await vscode.workspace.openTextDocument(snap.uri);
      const sym = findSymbolByName(await documentSymbols(doc), focus.symbol);
      if (sym) return { description: `\`${sym.name}\` (the code changed most recently)`, startLine: sym.range.start.line + 1, endLine: sym.range.end.line + 1 };
    }
    return { description: 'the code changed most recently', startLine: focus.startLine, endLine: Math.min(ctx.lineCount, focus.endLine) };
  }
  if (ctx.enclosingSymbol) {
    return { description: `the ${ctx.enclosingSymbol.kind} \`${ctx.enclosingSymbol.name}\` at the cursor`, startLine: ctx.enclosingSymbol.startLine, endLine: ctx.enclosingSymbol.endLine };
  }
  return undefined;
}

export async function runEdit(rt: Runtime, intent: EditIntent, snap: TargetSnapshot, signal: AbortSignal): Promise<ExecResult> {
  const provider = rt.provider();
  const settings = rt.settings();
  const ctx = snap.context;
  const target = await resolveTarget(rt, intent, snap);
  const history = rt.memory.render();

  let extra: string | undefined;
  if (intent.kind === 'debug') {
    const failure = rt.runner.lastFailure;
    if (failure) extra = `Most recent failing command output:\n${failure.slice(-6000)}`;
    if (!ctx.diagnostics?.length && !failure) {
      rt.update({ message: 'No diagnostics or failing output found; reasoning from the code alone.' });
    }
  }

  const system = buildEditSystem(intent.kind);
  const user = buildEditUserPrompt({
    instruction: intent.kind === 'debug' ? intent.instruction || 'Find and fix the bug.' : intent.instruction,
    transcript: intent.transcript,
    context: ctx,
    history,
    target,
    extra,
    budgetTokens: settings.contextBudget,
  });

  rt.setPhase('thinking', intent.kind === 'debug' ? 'Diagnosing…' : 'Writing code…');
  const handlers = {
    onFirstToken: (ms: number) => rt.metrics.record('llm.first-token', ms),
    onText: (_d: string, acc: string) => rt.preview(previewFromPartialJson(acc)),
  };

  let edits: EditBlock[];
  let summary: string;
  let body: string | undefined;
  if (intent.kind === 'debug') {
    const res = await provider.structured({ purpose: 'debug', system, messages: [{ role: 'user', content: user }], schema: DebugPlanSchema, schemaName: 'debug_plan', signal }, handlers);
    rt.metrics.record('llm.debug', res.latencyMs);
    track(rt, res.usage);
    edits = res.value.edits;
    summary = res.value.summary;
    body = `**Diagnosis.** ${res.value.diagnosis}\n\n**Root cause.** ${res.value.rootCause}`;
    if (edits.length === 0) {
      return { ok: true, title: 'Diagnosis', message: 'No code change proposed.', outcome: `Diagnosed: ${res.value.diagnosis}`, file: ctx.relativePath, status: 'done' };
    }
  } else {
    const res = await provider.structured({ purpose: intent.kind, system, messages: [{ role: 'user', content: user }], schema: EditPlanSchema, schemaName: 'edit_plan', signal }, handlers);
    rt.metrics.record(`llm.${intent.kind}`, res.latencyMs);
    track(rt, res.usage);
    edits = res.value.edits;
    summary = res.value.summary;
  }

  if (signal.aborted) throw new PatchError('Cancelled', 'empty');
  rt.setPhase('applying');
  const doc = await vscode.workspace.openTextDocument(snap.uri);
  const cursorOffset = doc.version === snap.version ? doc.offsetAt(snap.selection.active) : -1;
  const result = await rt.changes.propose(
    { uri: snap.uri, version: snap.version, edits, cursorOffset: cursorOffset < 0 ? 0 : cursorOffset, label: summary },
    settings.review,
  );

  // Remember what changed so follow-ups ("make it async") can refer to it.
  const after = await vscode.workspace.openTextDocument(snap.uri);
  const symbols = await documentSymbols(after);
  const sym = symbols.length ? innermostByLine(symbols, result.firstLine) : undefined;
  rt.memory.setFocus({ file: ctx.relativePath ?? ctx.fileName, startLine: result.firstLine, endLine: result.lastLine, symbol: sym?.name });

  rt.update({ diff: result.diff.slice(0, 400), stats: { added: result.added, removed: result.removed }, body, preview: undefined });
  const where = `${ctx.relativePath}:${result.firstLine}`;
  const verb = result.pending === 'preview' ? 'Proposed' : 'Applied';
  return {
    ok: true,
    title: summary,
    message: `${verb} +${result.added} −${result.removed} in ${where}${result.rebased ? ' (rebased onto your latest edits)' : ''}. Say “accept” or “reject”.`,
    outcome: `${summary} (${where}, +${result.added} −${result.removed})`,
    file: ctx.relativePath,
    status: 'review',
  };
}

function innermostByLine(symbols: vscode.DocumentSymbol[], line1: number): vscode.DocumentSymbol | undefined {
  const pos = new vscode.Position(line1 - 1, 0);
  for (const s of symbols) {
    if (s.range.contains(pos)) return innermostByLine(s.children, line1) ?? s;
  }
  return undefined;
}

export async function runDictation(rt: Runtime, intent: IntentOf<'dictation'>, snap: TargetSnapshot): Promise<ExecResult> {
  const doc = await vscode.workspace.openTextDocument(snap.uri);
  const offset = doc.offsetAt(snap.selection.active);
  await rt.changes.propose({ uri: snap.uri, version: snap.version, edits: [{ search: '', replace: intent.text }], cursorOffset: offset, label: 'Dictation' }, 'apply-and-review');
  await rt.changes.accept();
  const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === snap.uri.toString());
  if (editor) {
    const end = doc.positionAt(offset + intent.text.length);
    editor.selection = new vscode.Selection(end, end);
  }
  return { ok: true, title: 'Typed', message: `Inserted ${intent.text.length} characters.`, outcome: 'Dictated text', file: snap.context.relativePath, status: 'done' };
}

export async function runTestGeneration(rt: Runtime, intent: IntentOf<'test'>, snap: TargetSnapshot, signal: AbortSignal, projectSummary: string): Promise<ExecResult> {
  const provider = rt.provider();
  const root = rt.workspaceRoot();
  if (!root) throw new UserFacingError('Open a folder to generate tests.');
  rt.setPhase('thinking', 'Writing tests…');
  const user = buildEditUserPrompt({
    instruction: `${intent.instruction ?? 'Write unit tests for the code at the cursor.'}\n\nProject:\n${projectSummary}\nReturn the test file path (workspace-relative, following existing conventions) and its full content.`,
    transcript: intent.transcript,
    context: snap.context,
    history: rt.memory.render(),
    budgetTokens: rt.settings().contextBudget,
  });
  const res = await provider.structured(
    { purpose: 'test-generate', system: buildEditSystem('test'), messages: [{ role: 'user', content: user }], schema: TestPlanSchema, schemaName: 'test_plan', signal },
    { onText: (_d, acc) => rt.preview(previewFromPartialJson(acc)) },
  );
  rt.metrics.record('llm.test-generate', res.latencyMs);
  track(rt, res.usage);
  const plan = res.value;
  const rel = plan.testFilePath.replace(/^\.?\//, '');
  if (!isInsideWorkspace(root.fsPath, rel) || isProtectedPath(rel)) throw new UserFacingError(`Refusing to write tests to ${plan.testFilePath}.`);
  const uri = vscode.Uri.joinPath(root, rel);

  let content = plan.content;
  try {
    const existing = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    content = `${existing.replace(/\s*$/, '')}\n\n${plan.content.trim()}\n`;
  } catch {
    // new file
  }
  rt.setPhase('applying');
  const written = await rt.changes.writeFile(uri, content, plan.summary);
  await vscode.window.showTextDocument(uri, { preview: false });
  rt.update({ diff: written.diff.slice(0, 400), preview: undefined });
  return {
    ok: true,
    title: plan.summary,
    message: `${written.created ? 'Created' : 'Updated'} ${rel}. Say “run the tests” to execute them${plan.runCommand ? ` (${plan.runCommand})` : ''}.`,
    outcome: `${plan.summary} in ${rel}`,
    file: rel,
    status: 'done',
  };
}

export function track(rt: Runtime, usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number }): void {
  rt.metrics.increment('tokens.input', usage.inputTokens);
  rt.metrics.increment('tokens.output', usage.outputTokens);
  if (usage.cacheReadTokens) rt.metrics.increment('tokens.cached', usage.cacheReadTokens);
}

// Transactional, reviewable editing on top of native WorkspaceEdit.
//
// Guarantees:
//  * A command's result is applied to the document it was issued against (by URI), even
//    if the developer switched editors while the model was thinking.
//  * If that document changed in the meantime, content-anchored edits are re-resolved
//    against the current text; cursor-relative inserts are refused rather than landing
//    in the wrong place.
//  * Every applied change is one transaction with exact before/after text. Undo/reject
//    restore it only if the document still matches — never clobbering manual edits.
//  * Edits are minimal ranges, so VS Code's own undo stack, markers and folding behave.

import * as vscode from 'vscode';
import {
  applyChanges,
  diffStats,
  lineDiff,
  PatchError,
  resolveEdits,
  TransactionLog,
  type DiffLine,
  type EditBlock,
  type Transaction,
} from '@voicecoder/core';

export const PROPOSED_SCHEME = 'voicecoder-proposed';

export interface ChangeRequest {
  uri: vscode.Uri;
  /** Document version when the command was issued. */
  version: number;
  edits: EditBlock[];
  /** Offset for empty-search (insert at cursor) edits, valid for `version`. */
  cursorOffset: number;
  label: string;
}

export interface ChangeResult {
  tx?: Transaction;
  diff: DiffLine[];
  added: number;
  removed: number;
  /** 1-based line range of the change in the new document. */
  firstLine: number;
  lastLine: number;
  pending: 'review' | 'preview';
  rebased: boolean;
}

interface Pending {
  kind: 'review' | 'preview';
  uri: vscode.Uri;
  tx?: Transaction;
  request?: ChangeRequest;
  proposedText?: string;
  baseText?: string;
  result: ChangeResult;
}

export class ChangeManager implements vscode.Disposable {
  readonly log = new TransactionLog(100);
  private pending: Pending | null = null;
  private readonly proposed = new Map<string, string>();
  private readonly proposedEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly highlight: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor() {
    this.highlight = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.disposables.push(
      this.highlight,
      vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, {
        onDidChange: this.proposedEmitter.event,
        provideTextDocumentContent: (uri) => this.proposed.get(uri.toString()) ?? '',
      }),
    );
  }

  get hasPending(): boolean {
    return this.pending !== null;
  }

  get pendingResult(): ChangeResult | null {
    return this.pending?.result ?? null;
  }

  /** Resolve the request against the document's CURRENT text, rebasing if it changed. */
  private async resolve(req: ChangeRequest): Promise<{ doc: vscode.TextDocument; before: string; after: string; rebased: boolean; firstOffset: number; lastOffset: number }> {
    const doc = await vscode.workspace.openTextDocument(req.uri);
    const before = doc.getText();
    const rebased = doc.version !== req.version;
    const hasCursorInsert = req.edits.some((e) => e.search === '');
    if (rebased && hasCursorInsert) {
      throw new PatchError('The file changed while VoiceCoder was working, so the insertion point is no longer reliable. Say "repeat" to try again.', 'not-found');
    }
    const changes = resolveEdits(before, req.edits, Math.min(req.cursorOffset, before.length));
    if (changes.length === 0) throw new PatchError('The proposed change is identical to the current code.', 'empty');
    const after = applyChanges(before, changes);
    // Map the first/last touched offsets into the new text for highlighting.
    let shift = 0;
    let lastOffset = 0;
    for (const c of changes) {
      lastOffset = c.start + shift + c.text.length;
      shift += c.text.length - (c.end - c.start);
    }
    return { doc, before, after, rebased, firstOffset: changes[0]!.start, lastOffset };
  }

  async propose(req: ChangeRequest, mode: 'apply-and-review' | 'preview-first'): Promise<ChangeResult> {
    await this.settlePending();
    const { doc, before, after, rebased, firstOffset, lastOffset } = await this.resolve(req);
    const diff = lineDiff(before, after, 3);
    const { added, removed } = diffStats(diff);
    const firstLine = doc.positionAt(firstOffset).line + 1;
    const lastLine = lineOf(after, lastOffset) + 1;

    if (mode === 'preview-first') {
      const result: ChangeResult = { diff, added, removed, firstLine, lastLine, pending: 'preview', rebased };
      const proposedUri = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: req.uri.path, query: `v=${Date.now()}` });
      this.proposed.set(proposedUri.toString(), after);
      this.pending = { kind: 'preview', uri: req.uri, request: req, proposedText: after, baseText: before, result };
      await vscode.commands.executeCommand('vscode.diff', req.uri, proposedUri, `VoiceCoder: ${req.label} — say "accept" or "reject"`, { preview: true });
      this.fire();
      return result;
    }

    const tx = await this.applyText(doc, before, after, req.label);
    const result: ChangeResult = { tx, diff, added, removed, firstLine, lastLine, pending: 'review', rebased };
    this.pending = { kind: 'review', uri: req.uri, tx, result };
    await this.reveal(req.uri, firstLine, lastLine);
    this.fire();
    return result;
  }

  /** Accept the pending change (keep it / apply the preview). */
  async accept(): Promise<string> {
    const p = this.pending;
    if (!p) return 'Nothing to accept.';
    if (p.kind === 'review') {
      this.clearPending();
      return 'Change kept.';
    }
    // Preview: apply now, only if the document did not change since the preview.
    const doc = await vscode.workspace.openTextDocument(p.uri);
    if (doc.getText() !== p.baseText) {
      this.clearPending();
      await closeDiffTabs();
      throw new PatchError('The file changed after the preview was created. Nothing was applied; say "repeat" to regenerate.', 'not-found');
    }
    const tx = await this.applyText(doc, p.baseText!, p.proposedText!, p.request!.label);
    p.result.tx = tx;
    this.clearPending();
    await closeDiffTabs();
    await this.reveal(p.uri, p.result.firstLine, p.result.lastLine, false);
    return 'Change applied.';
  }

  async reject(): Promise<string> {
    const p = this.pending;
    if (!p) return 'Nothing to reject.';
    this.clearPending();
    if (p.kind === 'preview') {
      await closeDiffTabs();
      return 'Preview discarded; nothing changed.';
    }
    await this.revert(p.tx!);
    return 'Change reverted.';
  }

  /** Undo the most recent VoiceCoder transaction. */
  async undo(): Promise<string> {
    if (this.pending?.kind === 'preview') return this.reject();
    const tx = this.log.peek();
    if (!tx) return 'No VoiceCoder change to undo.';
    this.clearPending();
    await this.revert(tx);
    return `Undid “${tx.label}”.`;
  }

  async redo(): Promise<string> {
    const tx = this.log.peekRedo();
    if (!tx) return 'Nothing to redo.';
    const check = await this.log.canRedo(tx, docStore);
    if (!check.ok) throw new PatchError(check.reason, 'not-found');
    for (const d of tx.docs) {
      const uri = vscode.Uri.parse(d.uri);
      if (d.created) await this.writeNewFile(uri, d.after);
      else await replaceDocument(await vscode.workspace.openTextDocument(uri), d.after);
    }
    this.log.markApplied(tx);
    this.fire();
    return `Redid “${tx.label}”.`;
  }

  async revert(tx: Transaction): Promise<void> {
    const check = await this.log.canUndo(tx, docStore);
    if (!check.ok) throw new PatchError(check.reason, 'not-found');
    for (const d of [...tx.docs].reverse()) {
      const uri = vscode.Uri.parse(d.uri);
      if (d.created) {
        const we = new vscode.WorkspaceEdit();
        we.deleteFile(uri, { ignoreIfNotExists: true });
        await vscode.workspace.applyEdit(we);
      } else {
        await replaceDocument(await vscode.workspace.openTextDocument(uri), d.before);
      }
    }
    this.log.markUndone(tx);
    this.clearHighlights();
    this.fire();
  }

  /** Writes a whole file (agent/test generation) as one transaction. */
  async writeFile(uri: vscode.Uri, content: string, label: string): Promise<{ tx: Transaction; created: boolean; diff: DiffLine[] }> {
    let existing: vscode.TextDocument | undefined;
    try {
      await vscode.workspace.fs.stat(uri);
      existing = await vscode.workspace.openTextDocument(uri);
    } catch {
      existing = undefined;
    }
    if (existing) {
      const before = existing.getText();
      const tx = await this.applyText(existing, before, content, label);
      return { tx, created: false, diff: lineDiff(before, content, 3) };
    }
    await this.writeNewFile(uri, content);
    const tx = this.log.record(label, [{ uri: uri.toString(), before: '', after: content, created: true }]);
    this.fire();
    return { tx, created: true, diff: lineDiff('', content, 3) };
  }

  /** Applies search/replace edits to any workspace file as one transaction (agent tool). */
  async editFile(uri: vscode.Uri, edits: EditBlock[], label: string): Promise<{ tx: Transaction; diff: DiffLine[] }> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const before = doc.getText();
    const changes = resolveEdits(before, edits, before.length);
    if (changes.length === 0) throw new PatchError('The edit does not change the file.', 'empty');
    const after = applyChanges(before, changes);
    const tx = await this.applyText(doc, before, after, label);
    return { tx, diff: lineDiff(before, after, 3) };
  }

  private async writeNewFile(uri: vscode.Uri, content: string): Promise<void> {
    const we = new vscode.WorkspaceEdit();
    we.createFile(uri, { ignoreIfExists: false, contents: Buffer.from(content, 'utf8') });
    const ok = await vscode.workspace.applyEdit(we);
    if (!ok) throw new Error(`Could not create ${vscode.workspace.asRelativePath(uri)}.`);
  }

  private async applyText(doc: vscode.TextDocument, before: string, after: string, label: string): Promise<Transaction> {
    await replaceDocument(doc, after, before);
    const actual = doc.getText();
    if (actual !== after) {
      // Another edit raced us (format-on-type, an extension). Record what is there so
      // undo still restores `before` exactly.
      return this.record(doc, before, actual, label);
    }
    return this.record(doc, before, after, label);
  }

  private record(doc: vscode.TextDocument, before: string, after: string, label: string): Transaction {
    const tx = this.log.record(label, [{ uri: doc.uri.toString(), before, after }]);
    this.fire();
    return tx;
  }

  private async reveal(uri: vscode.Uri, firstLine: number, lastLine: number, highlight = true): Promise<void> {
    const editor = await vscode.window.showTextDocument(uri, { preserveFocus: false, preview: false });
    const range = new vscode.Range(Math.max(0, firstLine - 1), 0, Math.max(0, lastLine - 1), 0);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    if (highlight) editor.setDecorations(this.highlight, [range]);
  }

  private async settlePending(): Promise<void> {
    // A new change implicitly accepts a reviewed change, and discards an unaccepted preview.
    if (this.pending?.kind === 'preview') await closeDiffTabs();
    this.clearPending();
  }

  private clearPending(): void {
    this.pending = null;
    this.clearHighlights();
    this.fire();
  }

  private clearHighlights(): void {
    for (const e of vscode.window.visibleTextEditors) e.setDecorations(this.highlight, []);
  }

  private fire(): void {
    void vscode.commands.executeCommand('setContext', 'voicecoder.hasPendingChange', this.pending !== null);
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.proposedEmitter.dispose();
    this.changeEmitter.dispose();
  }
}

const docStore = {
  async read(uriString: string): Promise<string | undefined> {
    const uri = vscode.Uri.parse(uriString);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uriString);
      return open && !open.isClosed ? open.getText() : undefined;
    }
    return (await vscode.workspace.openTextDocument(uri)).getText();
  },
};

/** Replaces the document content with `target` using the smallest single range. */
export async function replaceDocument(doc: vscode.TextDocument, target: string, current = doc.getText()): Promise<void> {
  if (current === target) return;
  let start = 0;
  const max = Math.min(current.length, target.length);
  while (start < max && current.charCodeAt(start) === target.charCodeAt(start)) start++;
  let endA = current.length;
  let endB = target.length;
  while (endA > start && endB > start && current.charCodeAt(endA - 1) === target.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  const we = new vscode.WorkspaceEdit();
  we.replace(doc.uri, new vscode.Range(doc.positionAt(start), doc.positionAt(endA)), target.slice(start, endB));
  const ok = await vscode.workspace.applyEdit(we);
  if (!ok) throw new Error('VS Code rejected the edit (the file may be read-only).');
}

function lineOf(text: string, offset: number): number {
  let n = 0;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

async function closeDiffTabs(): Promise<void> {
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.scheme === PROPOSED_SCHEME);
  if (tabs.length) await vscode.window.tabGroups.close(tabs);
}

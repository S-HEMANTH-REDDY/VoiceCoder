// Navigation runs entirely locally through native editor commands — no model call.

import * as vscode from 'vscode';
import { rankFiles, type IntentOf } from '@voicecoder/core';
import { documentSymbols, findSymbolByName, projectFiles } from '../context/collector.js';
import { UserFacingError, type ExecResult } from './runtime.js';

export async function runNavigation(intent: IntentOf<'navigate'>): Promise<ExecResult> {
  const t = intent.target;
  const editor = vscode.window.activeTextEditor;
  const requireEditor = () => {
    if (!editor) throw new UserFacingError('Open a file first.');
    return editor;
  };

  switch (t.type) {
    case 'line': {
      const ed = requireEditor();
      const line = Math.min(Math.max(1, t.line), ed.document.lineCount);
      const lineText = ed.document.lineAt(line - 1);
      const col = t.column ? Math.min(t.column - 1, lineText.text.length) : lineText.firstNonWhitespaceCharacterIndex;
      const pos = new vscode.Position(line - 1, col);
      ed.selection = new vscode.Selection(pos, pos);
      ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      const clamped = line !== t.line ? ` (file has ${ed.document.lineCount} lines)` : '';
      return { ok: true, title: `Line ${line}`, outcome: `Moved to line ${line}`, status: 'done', message: clamped || undefined };
    }
    case 'top':
    case 'bottom': {
      const ed = requireEditor();
      const pos = t.type === 'top' ? new vscode.Position(0, 0) : ed.document.lineAt(ed.document.lineCount - 1).range.end;
      ed.selection = new vscode.Selection(pos, pos);
      ed.revealRange(new vscode.Range(pos, pos));
      return { ok: true, title: t.type === 'top' ? 'Top of file' : 'End of file', outcome: `Moved to ${t.type}`, status: 'done' };
    }
    case 'file': {
      const match = await findFile(t.query);
      if (!match) throw new UserFacingError(`No file matching “${t.query}”.`);
      await vscode.window.showTextDocument(match, { preview: false });
      const rel = vscode.workspace.asRelativePath(match, false);
      return { ok: true, title: `Opened ${rel}`, outcome: `Opened ${rel}`, file: rel, status: 'done' };
    }
    case 'symbol': {
      const name = t.query.replace(/\s+/g, '').toLowerCase();
      if (editor) {
        const syms = await documentSymbols(editor.document);
        const local = findSymbolByName(syms, t.query) ?? flatten(syms).find((s) => s.name.toLowerCase().replace(/[_\s]/g, '') === name.replace(/_/g, ''));
        if (local) {
          editor.selection = new vscode.Selection(local.selectionRange.start, local.selectionRange.start);
          editor.revealRange(local.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
          return { ok: true, title: `Jumped to ${local.name}`, outcome: `Moved to ${local.name}`, status: 'done' };
        }
      }
      const ws = (await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', t.query)) ?? [];
      const best = ws.find((s) => s.name.toLowerCase().replace(/[_\s]/g, '') === name.replace(/_/g, '')) ?? ws[0];
      if (!best) throw new UserFacingError(`No symbol named “${t.query}”.`);
      const ed = await vscode.window.showTextDocument(best.location.uri, { preview: false });
      ed.selection = new vscode.Selection(best.location.range.start, best.location.range.start);
      ed.revealRange(best.location.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      return { ok: true, title: `Jumped to ${best.name}`, outcome: `Moved to ${best.name}`, status: 'done' };
    }
    case 'definition':
      requireEditor();
      await vscode.commands.executeCommand('editor.action.revealDefinition');
      return { ok: true, title: 'Go to definition', outcome: 'Went to definition', status: 'done' };
    case 'references':
      requireEditor();
      await vscode.commands.executeCommand('editor.action.goToReferences');
      return { ok: true, title: 'References', outcome: 'Showed references', status: 'done' };
    case 'next-error':
      await vscode.commands.executeCommand('editor.action.marker.nextInFiles');
      return { ok: true, title: 'Next problem', outcome: 'Moved to next problem', status: 'done' };
    case 'previous-error':
      await vscode.commands.executeCommand('editor.action.marker.prevInFiles');
      return { ok: true, title: 'Previous problem', outcome: 'Moved to previous problem', status: 'done' };
    case 'back':
      await vscode.commands.executeCommand('workbench.action.navigateBack');
      return { ok: true, title: 'Back', outcome: 'Navigated back', status: 'done' };
  }
}

function flatten(s: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
  return s.flatMap((x) => [x, ...flatten(x.children)]);
}

/** Fuzzy file lookup: "authentication" finds auth.ts / authController.ts / authentication/index.ts. */
export async function findFile(query: string): Promise<vscode.Uri | undefined> {
  const files = await projectFiles(2000);
  const scored = rankFiles(files, query);
  if (scored.length === 0) return undefined;
  const top = scored[0]!;
  const ties = scored.filter((s) => s.score === top.score);
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return undefined;
  if (ties.length > 1 && ties.length <= 12) {
    const pick = await vscode.window.showQuickPick(ties.map((t) => t.path), { placeHolder: `Several files match “${query}”` });
    return pick ? vscode.Uri.joinPath(root, pick) : undefined;
  }
  return vscode.Uri.joinPath(root, top.path);
}

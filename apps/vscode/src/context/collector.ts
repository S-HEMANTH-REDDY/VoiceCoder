// Collects EditorContext from native VS Code APIs: document, selection, cursor,
// document symbols (language server), diagnostics, imports, related files and a
// shallow project listing. Expensive parts (symbols, project files) are cached per
// document version / workspace and bounded by timeouts so a slow language server
// never stalls a voice command.

import * as vscode from 'vscode';
import { detectIndent, extractImports, windowAround, type DiagnosticInfo, type EditorContext, type SymbolInfo } from '@voicecoder/core';

const MAX_DOC_CHARS = 60_000;
const SYMBOL_TIMEOUT_MS = 400;

export interface TargetSnapshot {
  /** The document this command is bound to. Results are applied here, never to "whatever is active now". */
  uri: vscode.Uri;
  version: number;
  selection: vscode.Selection;
  context: EditorContext;
}

const symbolCache = new Map<string, { version: number; symbols: vscode.DocumentSymbol[] }>();
let projectFilesCache: { at: number; files: string[] } | null = null;

export async function snapshotActiveEditor(opts: { withSymbols?: boolean; withProject?: boolean } = {}): Promise<TargetSnapshot | null> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;
  return snapshotEditor(editor, opts);
}

/**
 * Adds language-server symbols (enclosing function, symbol list) to a snapshot taken
 * earlier. Only applied if the document is still at the snapshot's version.
 */
export async function enrichSnapshot(snap: TargetSnapshot): Promise<TargetSnapshot> {
  if (snap.context.symbols) return snap;
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === snap.uri.toString());
  if (!doc || doc.version !== snap.version) return snap;
  const symbols = await documentSymbols(doc);
  if (symbols.length) {
    snap.context.symbols = flatten(symbols).map(toInfo);
    const enclosing = innermost(symbols, snap.selection.active);
    if (enclosing) snap.context.enclosingSymbol = { ...toInfo(enclosing), text: doc.getText(enclosing.range) };
  }
  return snap;
}

export async function snapshotEditor(editor: vscode.TextEditor, opts: { withSymbols?: boolean; withProject?: boolean } = {}): Promise<TargetSnapshot> {
  const doc = editor.document;
  const sel = editor.selection;
  const text = doc.getText();
  const lines = text.split(/\r?\n/);
  const cursorLine = sel.active.line + 1;

  const ctx: EditorContext = {
    host: 'vscode',
    fileName: doc.fileName.split(/[\\/]/).pop() ?? doc.fileName,
    relativePath: vscode.workspace.asRelativePath(doc.uri, false),
    languageId: doc.languageId,
    lineCount: doc.lineCount,
    cursor: { line: cursorLine, column: sel.active.character + 1 },
    window: windowAround(lines, cursorLine, 40, 20),
    document: text.length <= MAX_DOC_CHARS ? text : undefined,
    indentUnit: editorIndent(editor, text),
    eol: doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
    imports: extractImports(text),
    diagnostics: diagnosticsFor(doc.uri),
  };
  if (!sel.isEmpty) {
    ctx.selection = { startLine: sel.start.line + 1, endLine: sel.end.line + 1, text: doc.getText(sel) };
  }

  if (opts.withSymbols !== false) {
    const symbols = await documentSymbols(doc);
    if (symbols.length) {
      ctx.symbols = flatten(symbols).map(toInfo);
      const enclosing = innermost(symbols, sel.active);
      if (enclosing) ctx.enclosingSymbol = { ...toInfo(enclosing), text: doc.getText(enclosing.range) };
    }
  }
  if (opts.withProject) {
    ctx.projectFiles = await projectFiles();
    ctx.conventions = await projectConventions();
  }
  return { uri: doc.uri, version: doc.version, selection: sel, context: ctx };
}

function editorIndent(editor: vscode.TextEditor, text: string): string {
  const { insertSpaces, tabSize } = editor.options;
  if (insertSpaces === false) return '\t';
  const detected = detectIndent(text);
  if (detected !== '    ' || text.length > 0) return detected;
  return ' '.repeat(typeof tabSize === 'number' ? tabSize : 4);
}

export function diagnosticsFor(uri: vscode.Uri, max = 30): DiagnosticInfo[] {
  return vscode.languages
    .getDiagnostics(uri)
    .sort((a, b) => a.severity - b.severity || a.range.start.line - b.range.start.line)
    .slice(0, max)
    .map((d) => ({
      line: d.range.start.line + 1,
      severity: (['error', 'warning', 'info', 'hint'] as const)[d.severity] ?? 'info',
      message: d.message,
      source: d.source,
      code: typeof d.code === 'object' ? String(d.code.value) : d.code !== undefined ? String(d.code) : undefined,
    }));
}

export async function documentSymbols(doc: vscode.TextDocument): Promise<vscode.DocumentSymbol[]> {
  const key = doc.uri.toString();
  const cached = symbolCache.get(key);
  if (cached && cached.version === doc.version) return cached.symbols;
  try {
    const result = await Promise.race([
      vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>('vscode.executeDocumentSymbolProvider', doc.uri),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), SYMBOL_TIMEOUT_MS)),
    ]);
    const symbols = (result ?? []).filter((s): s is vscode.DocumentSymbol => 'children' in s);
    symbolCache.set(key, { version: doc.version, symbols });
    if (symbolCache.size > 50) symbolCache.delete(symbolCache.keys().next().value!);
    return symbols;
  } catch {
    return [];
  }
}

const CALLABLE = new Set([vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor, vscode.SymbolKind.Class]);

/** Innermost function/method/class containing a position. */
export function innermost(symbols: vscode.DocumentSymbol[], pos: vscode.Position, kinds = CALLABLE): vscode.DocumentSymbol | undefined {
  for (const s of symbols) {
    if (s.range.contains(pos)) {
      return innermost(s.children, pos, kinds) ?? (kinds.has(s.kind) ? s : undefined);
    }
  }
  return undefined;
}

export function findSymbolByName(symbols: vscode.DocumentSymbol[], name: string): vscode.DocumentSymbol | undefined {
  for (const s of flatten(symbols)) if (s.name === name) return s;
  return undefined;
}

function flatten(symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
  return symbols.flatMap((s) => [s, ...flatten(s.children)]);
}

function toInfo(s: vscode.DocumentSymbol): SymbolInfo {
  return { name: s.name, kind: vscode.SymbolKind[s.kind]?.toLowerCase() ?? 'symbol', startLine: s.range.start.line + 1, endLine: s.range.end.line + 1 };
}

const EXCLUDE = '**/{node_modules,.git,dist,out,build,.next,.venv,venv,__pycache__,target,coverage}/**';

export async function projectFiles(limit = 400): Promise<string[]> {
  if (projectFilesCache && Date.now() - projectFilesCache.at < 30_000) return projectFilesCache.files;
  const uris = await vscode.workspace.findFiles('**/*', EXCLUDE, limit);
  const files = uris.map((u) => vscode.workspace.asRelativePath(u, false)).sort();
  projectFilesCache = { at: Date.now(), files };
  return files;
}

export function invalidateProjectCache(): void {
  projectFilesCache = null;
}

/** Cheap convention hints derived from the workspace (test framework, module system, scripts). */
export async function projectConventions(): Promise<string[]> {
  const notes: string[] = [];
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return notes;
  try {
    const pkgRaw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, 'package.json'));
    const pkg = JSON.parse(Buffer.from(pkgRaw).toString('utf8')) as { type?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (pkg.type === 'module') notes.push('ESM modules');
    for (const fw of ['vitest', 'jest', 'mocha', 'express', 'fastify', 'react', 'next', 'typescript', 'zod', 'prisma', 'pg']) if (deps[fw]) notes.push(`uses ${fw}`);
    if (pkg.scripts) notes.push(`npm scripts: ${Object.keys(pkg.scripts).slice(0, 12).join(', ')}`);
  } catch {
    // not a node project
  }
  for (const [file, note] of [
    ['pyproject.toml', 'Python project (pyproject)'],
    ['pytest.ini', 'uses pytest'],
    ['go.mod', 'Go module'],
    ['Cargo.toml', 'Rust crate'],
  ] as const) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, file));
      notes.push(note);
    } catch {
      // absent
    }
  }
  return notes;
}

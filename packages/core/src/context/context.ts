// Editor context: what the developer is looking at when they speak. Collected by each
// host (VS Code via native APIs, the browser via the page bridge) into this shape, and
// rendered into prompts under an explicit token budget so cost stays predictable.

export interface Position {
  /** 1-based */
  line: number;
  /** 1-based */
  column: number;
}

export interface CodeRegion {
  startLine: number;
  endLine: number;
  text: string;
}

export interface SymbolInfo {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}

export interface DiagnosticInfo {
  line: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
  code?: string;
}

export interface RelatedFile {
  path: string;
  excerpt: string;
  reason: string;
}

export interface EditorContext {
  host: 'vscode' | 'browser';
  fileName: string;
  relativePath?: string;
  languageId: string;
  lineCount: number;
  cursor: Position;
  /** Text of the active selection, if any. */
  selection?: CodeRegion;
  /** Window of lines around the cursor (always present). */
  window: CodeRegion;
  /** The whole document when it is small enough to send. */
  document?: string;
  enclosingSymbol?: SymbolInfo & { text: string };
  symbols?: SymbolInfo[];
  imports?: string[];
  diagnostics?: DiagnosticInfo[];
  relatedFiles?: RelatedFile[];
  projectFiles?: string[];
  indentUnit: string;
  eol: '\n' | '\r\n';
  /** Short notes such as "uses ESM imports", "tests live in __tests__". */
  conventions?: string[];
}

/** Rough token estimate (~4 chars/token for code). Good enough for budgeting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface RenderOptions {
  /** Budget for the rendered context block, in tokens. */
  budgetTokens: number;
  includeDocument?: boolean;
  includeDiagnostics?: boolean;
  includeRelated?: boolean;
}

/**
 * Renders the context into a compact prompt section. Sections are added in priority
 * order and the lowest-priority ones are dropped first when the budget is exceeded,
 * so the cursor neighbourhood and selection are always present.
 */
export function renderContext(ctx: EditorContext, opts: RenderOptions): string {
  const sections: Array<{ priority: number; text: string }> = [];
  const path = ctx.relativePath ?? ctx.fileName;
  sections.push({
    priority: 0,
    text: `File: ${path} (${ctx.languageId}, ${ctx.lineCount} lines, indent=${JSON.stringify(ctx.indentUnit)})\nCursor: line ${ctx.cursor.line}, column ${ctx.cursor.column}`,
  });
  if (ctx.selection?.text) {
    sections.push({ priority: 1, text: `Selected code (lines ${ctx.selection.startLine}-${ctx.selection.endLine}):\n${fence(ctx.selection.text)}` });
  }
  if (ctx.enclosingSymbol && !ctx.selection?.text) {
    const s = ctx.enclosingSymbol;
    sections.push({ priority: 2, text: `Enclosing ${s.kind} \`${s.name}\` (lines ${s.startLine}-${s.endLine}):\n${fence(numbered(s.text, s.startLine))}` });
  }
  const docFits = opts.includeDocument !== false && ctx.document !== undefined && estimateTokens(ctx.document) < opts.budgetTokens * 0.6;
  if (docFits) {
    sections.push({ priority: 3, text: `Full file with line numbers (cursor marked ⟨CURSOR⟩):\n${fence(numbered(markCursor(ctx.document!, ctx.cursor), 1))}` });
  } else {
    sections.push({ priority: 3, text: `Code around cursor (cursor marked ⟨CURSOR⟩):\n${fence(numbered(markCursorInWindow(ctx), ctx.window.startLine))}` });
  }
  if (ctx.imports?.length && !docFits) sections.push({ priority: 4, text: `Imports:\n${ctx.imports.join('\n')}` });
  if (opts.includeDiagnostics !== false && ctx.diagnostics?.length) {
    sections.push({
      priority: 2,
      text: `Diagnostics:\n${ctx.diagnostics
        .slice(0, 20)
        .map((d) => `- line ${d.line} [${d.severity}${d.source ? `/${d.source}` : ''}${d.code ? ` ${d.code}` : ''}] ${d.message}`)
        .join('\n')}`,
    });
  }
  if (ctx.symbols?.length && !docFits) {
    sections.push({ priority: 5, text: `Symbols in file: ${ctx.symbols.slice(0, 40).map((s) => `${s.kind} ${s.name}@${s.startLine}`).join(', ')}` });
  }
  if (ctx.conventions?.length) sections.push({ priority: 5, text: `Conventions: ${ctx.conventions.join('; ')}` });
  if (opts.includeRelated !== false && ctx.relatedFiles?.length) {
    for (const [i, f] of ctx.relatedFiles.entries()) {
      sections.push({ priority: 6 + i, text: `Related file ${f.path} (${f.reason}):\n${fence(f.excerpt)}` });
    }
  }
  if (ctx.projectFiles?.length) sections.push({ priority: 9, text: `Project files:\n${ctx.projectFiles.slice(0, 60).join('\n')}` });

  // Drop lowest-priority sections until under budget.
  const ordered = sections.map((s, i) => ({ ...s, i }));
  let total = ordered.reduce((n, s) => n + estimateTokens(s.text), 0);
  const byPriorityDesc = [...ordered].sort((a, b) => b.priority - a.priority);
  const dropped = new Set<number>();
  for (const s of byPriorityDesc) {
    if (total <= opts.budgetTokens || s.priority <= 1) break;
    dropped.add(s.i);
    total -= estimateTokens(s.text);
  }
  return ordered
    .filter((s) => !dropped.has(s.i))
    .map((s) => s.text)
    .join('\n\n');
}

function fence(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const f = '`'.repeat(longest + 1);
  return `${f}\n${text}\n${f}`;
}

function numbered(text: string, startLine: number): string {
  const lines = text.split('\n');
  const width = String(startLine + lines.length).length;
  return lines.map((l, i) => `${String(startLine + i).padStart(width)}| ${l}`).join('\n');
}

function markCursor(doc: string, cursor: Position): string {
  const lines = doc.split('\n');
  const idx = cursor.line - 1;
  const line = lines[idx];
  if (line === undefined) return doc;
  lines[idx] = line.slice(0, cursor.column - 1) + '⟨CURSOR⟩' + line.slice(cursor.column - 1);
  return lines.join('\n');
}

function markCursorInWindow(ctx: EditorContext): string {
  return markCursor(ctx.window.text, { line: ctx.cursor.line - ctx.window.startLine + 1, column: ctx.cursor.column });
}

/** Lines of a document around a position, clamped to the document. */
export function windowAround(lines: string[], line: number, before: number, after: number): CodeRegion {
  const start = Math.max(1, line - before);
  const end = Math.min(lines.length, line + after);
  return { startLine: start, endLine: end, text: lines.slice(start - 1, end).join('\n') };
}

/** Detects the indentation unit used in a document. */
export function detectIndent(text: string): string {
  const lines = text.split('\n');
  let tabs = 0;
  const widths = new Map<number, number>();
  let prev = 0;
  for (const l of lines) {
    if (!l.trim()) continue;
    if (l.startsWith('\t')) {
      tabs++;
      continue;
    }
    const w = l.match(/^ */)![0].length;
    const delta = Math.abs(w - prev);
    if (delta > 0 && delta <= 8) widths.set(delta, (widths.get(delta) ?? 0) + 1);
    prev = w;
  }
  const spaceVotes = [...widths.values()].reduce((a, b) => a + b, 0);
  if (tabs > spaceVotes) return '\t';
  let best = 4;
  let bestCount = -1;
  for (const [w, c] of widths) {
    if (c > bestCount || (c === bestCount && w < best)) {
      best = w;
      bestCount = c;
    }
  }
  return ' '.repeat(bestCount < 0 ? 4 : best);
}

/** Extracts import/require/include/use lines from the top of a file. */
export function extractImports(text: string, max = 40): string[] {
  const out: string[] = [];
  for (const line of text.split('\n').slice(0, 200)) {
    if (/^\s*(?:import\s|from\s+\S+\s+import\s|const\s+\w+\s*=\s*require\(|#include\s|using\s+[\w.]+;|use\s+[\w:]+|package\s|require\s)/.test(line)) {
      out.push(line.trim());
      if (out.length >= max) break;
    }
  }
  return out;
}

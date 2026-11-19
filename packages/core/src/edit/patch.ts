// Minimal-edit protocol. Instead of asking the model to rewrite a file, we ask for
// search/replace pairs anchored on existing text. Each pair becomes a small, precise
// range edit, which (a) keeps diffs reviewable, (b) cuts output tokens, and (c) lets us
// detect when the document changed underneath an in-flight request.

import type { EditBlock } from './schema.js';

export type { EditBlock, EditPlan } from './schema.js';

/** A replacement expressed as offsets into the ORIGINAL text. */
export interface TextChange {
  start: number;
  end: number;
  text: string;
}

export class PatchError extends Error {
  constructor(
    message: string,
    readonly reason: 'not-found' | 'ambiguous' | 'overlap' | 'empty',
  ) {
    super(message);
    this.name = 'PatchError';
  }
}

/**
 * Resolves edit blocks against `text`.
 * @param cursorOffset where empty-search blocks insert.
 * @returns non-overlapping changes sorted by start offset.
 */
export function resolveEdits(text: string, edits: EditBlock[], cursorOffset: number): TextChange[] {
  if (edits.length === 0) throw new PatchError('The model proposed no changes.', 'empty');
  const changes: TextChange[] = [];
  for (const edit of edits) {
    if (edit.search === '') {
      changes.push({ start: cursorOffset, end: cursorOffset, text: edit.replace });
      continue;
    }
    const range = locate(text, edit.search);
    let replacement = edit.replace;
    if (range.reindent) replacement = reindent(replacement, range.reindent.from, range.reindent.to);
    changes.push({ start: range.start, end: range.end, text: replacement });
  }
  changes.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < changes.length; i++) {
    if (changes[i]!.start < changes[i - 1]!.end) throw new PatchError('Two proposed edits overlap.', 'overlap');
  }
  return changes.filter((c) => !(c.start === c.end && c.text === '') && text.slice(c.start, c.end) !== c.text);
}

/** Applies resolved changes to text. */
export function applyChanges(text: string, changes: TextChange[]): string {
  let out = '';
  let pos = 0;
  for (const c of changes) {
    out += text.slice(pos, c.start) + c.text;
    pos = c.end;
  }
  return out + text.slice(pos);
}

interface Located {
  start: number;
  end: number;
  reindent?: { from: string; to: string };
}

function locate(text: string, search: string): Located {
  // 1. Exact match.
  const exact = allIndexes(text, search);
  if (exact.length === 1) return { start: exact[0]!, end: exact[0]! + search.length };
  if (exact.length > 1) throw new PatchError(`The text to change appears ${exact.length} times; the edit is ambiguous.`, 'ambiguous');

  // 2. Trailing-whitespace / CRLF tolerant match.
  const norm = (s: string) => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');
  const searchLines = norm(search).replace(/^\n+|\n+$/g, '').split('\n');
  const textLines = text.split('\n');
  const lineStarts: number[] = [];
  let acc = 0;
  for (const l of textLines) {
    lineStarts.push(acc);
    acc += l.length + 1;
  }

  // 3. Indentation-insensitive line match (models often re-indent the anchor).
  const matches: Array<{ line: number; from: string; to: string }> = [];
  for (let i = 0; i + searchLines.length <= textLines.length; i++) {
    let ok = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (textLines[i + j]!.replace(/\r$/, '').trim() !== searchLines[j]!.trim()) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const firstNonEmpty = searchLines.findIndex((l) => l.trim() !== '');
      const idx = firstNonEmpty < 0 ? 0 : firstNonEmpty;
      const from = searchLines[idx]!.match(/^\s*/)![0];
      const to = textLines[i + idx]!.match(/^\s*/)![0];
      matches.push({ line: i, from, to });
    }
  }
  if (matches.length === 1) {
    const m = matches[0]!;
    const start = lineStarts[m.line]!;
    const lastLine = m.line + searchLines.length - 1;
    const end = lineStarts[lastLine]! + textLines[lastLine]!.replace(/\r$/, '').length;
    return { start, end, reindent: m.from !== m.to ? { from: m.from, to: m.to } : undefined };
  }
  if (matches.length > 1) throw new PatchError(`The text to change appears ${matches.length} times; the edit is ambiguous.`, 'ambiguous');
  throw new PatchError('Could not find the code the model wanted to change. The file may have changed — try again.', 'not-found');
}

function reindent(text: string, from: string, to: string): string {
  return text
    .split('\n')
    .map((line) => (line.startsWith(from) ? to + line.slice(from.length) : line.trim() === '' ? line : to + line.trimStart()))
    .join('\n');
}

function allIndexes(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let i = haystack.indexOf(needle);
  while (i >= 0) {
    out.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return out;
}

/** Converts a character offset into a 0-based line/character position. */
export function offsetToPosition(text: string, offset: number): { line: number; character: number } {
  let line = 0;
  let last = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      last = i + 1;
    }
  }
  return { line, character: offset - last };
}

export function positionToOffset(text: string, line0: number, character: number): number {
  let line = 0;
  let i = 0;
  while (line < line0 && i < text.length) {
    if (text.charCodeAt(i) === 10) line++;
    i++;
  }
  return Math.min(text.length, i + character);
}

// ── Line diff (for previews and change summaries) ─────────────────────────────

export interface DiffLine {
  type: 'context' | 'add' | 'remove';
  text: string;
  oldLine?: number;
  newLine?: number;
}

/** LCS line diff with context trimming. Bounded to keep the UI responsive. */
export function lineDiff(before: string, after: string, context = 3, maxLines = 4000): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // Trim common prefix/suffix first — most voice edits touch a small region.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  let middle: DiffLine[];
  if (am.length * bm.length > maxLines * maxLines) {
    middle = [...am.map((t) => ({ type: 'remove' as const, text: t })), ...bm.map((t) => ({ type: 'add' as const, text: t }))];
  } else {
    middle = lcsDiff(am, bm);
  }
  const all: DiffLine[] = [
    ...a.slice(0, pre).map((t) => ({ type: 'context' as const, text: t })),
    ...middle,
    ...a.slice(a.length - suf).map((t) => ({ type: 'context' as const, text: t })),
  ];
  // Number lines.
  let o = 1;
  let n = 1;
  for (const d of all) {
    if (d.type !== 'add') d.oldLine = o++;
    if (d.type !== 'remove') d.newLine = n++;
  }
  // Keep only `context` lines around changes.
  const keep = new Array<boolean>(all.length).fill(false);
  all.forEach((d, i) => {
    if (d.type !== 'context') for (let k = Math.max(0, i - context); k <= Math.min(all.length - 1, i + context); k++) keep[k] = true;
  });
  return all.filter((_, i) => keep[i]);
}

function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const m = a.length;
  const n = b.length;
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: 'context', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: 'remove', text: a[i++]! });
    } else {
      out.push({ type: 'add', text: b[j++]! });
    }
  }
  while (i < m) out.push({ type: 'remove', text: a[i++]! });
  while (j < n) out.push({ type: 'add', text: b[j++]! });
  return out;
}

export function diffStats(diff: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const d of diff) {
    if (d.type === 'add') added++;
    else if (d.type === 'remove') removed++;
  }
  return { added, removed };
}

/** Strips markdown fences from a code-only completion. */
export function stripFences(text: string): string {
  const m = text.match(/^\s*```[\w+-]*\n([\s\S]*?)\n?```\s*$/);
  return (m ? m[1]! : text).replace(/^\n+/, '').replace(/\s+$/, '');
}

/**
 * Best-effort live preview from a partially streamed EditPlan JSON: returns the
 * decoded content of the last (possibly unterminated) "replace" string.
 */
export function previewFromPartialJson(partial: string): string {
  const key = /"(?:replace|content)"\s*:\s*"/g;
  let lastIdx = -1;
  let m: RegExpExecArray | null;
  while ((m = key.exec(partial))) lastIdx = m.index + m[0].length;
  if (lastIdx < 0) return '';
  let out = '';
  for (let i = lastIdx; i < partial.length; i++) {
    const ch = partial[i]!;
    if (ch === '"') break;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = partial[++i];
    if (next === undefined) break;
    if (next === 'n') out += '\n';
    else if (next === 't') out += '\t';
    else if (next === 'r') out += '';
    else if (next === 'u') {
      const hex = partial.slice(i + 1, i + 5);
      if (hex.length < 4) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else out += next;
  }
  return out;
}

// MAIN-world editor bridge. Detects the focused editor using each editor's real API and
// applies verified, transactional edits:
//   * every edit names the target editor (by id) — never "whatever has focus now";
//   * every edit carries the text it expects; if the editor changed, the edit is refused;
//   * undo restores the previous text only if the editor still holds what we wrote.
// This file must stay dependency-free and small: it runs inside arbitrary pages.

import { REQUEST_EVENT, RESPONSE_EVENT, type BridgeRequest, type BridgeResponse, type Change, type EditorKind, type EditorState } from './bridge-protocol.js';

declare global {
  interface Window {
    __voicecoderBridge?: boolean;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyEditor = any;

interface Adapter {
  kind: EditorKind;
  root: HTMLElement;
  getText(): string | null;
  getSelection(): { start: number; end: number };
  apply(changes: Change[], select?: { start: number; end: number }): void;
  insert(text: string): void;
  gotoLine(line: number): void;
  focus(): void;
  languageId?: string;
}

const ID_ATTR = 'data-voicecoder-id';
let idSeq = 0;
let lastFocused: Element | null = null;

function targetIdOf(el: HTMLElement): string {
  let id = el.getAttribute(ID_ATTR);
  if (!id) {
    id = `vc-${Date.now().toString(36)}-${++idSeq}`;
    el.setAttribute(ID_ATTR, id);
  }
  return id;
}

// ── Adapters ─────────────────────────────────────────────────────────────────

function monacoAdapter(el: Element): Adapter | null {
  const root = el.closest('.monaco-editor') as HTMLElement | null;
  const monaco = (window as any).monaco;
  if (!root || !monaco?.editor?.getEditors) return null;
  const editor: AnyEditor = monaco.editor.getEditors().find((e: AnyEditor) => e.getContainerDomNode?.()?.contains(root) || root.contains(e.getContainerDomNode?.()));
  if (!editor) return null;
  const model = () => editor.getModel();
  return {
    kind: 'monaco',
    root,
    languageId: model()?.getLanguageId?.(),
    getText: () => model()?.getValue() ?? null,
    getSelection: () => {
      const m = model();
      const s = editor.getSelection();
      if (!m || !s) return { start: 0, end: 0 };
      return { start: m.getOffsetAt(s.getStartPosition()), end: m.getOffsetAt(s.getEndPosition()) };
    },
    apply(changes, select) {
      const m = model();
      const ops = changes.map((c) => {
        const a = m.getPositionAt(c.start);
        const b = m.getPositionAt(c.end);
        return { range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), text: c.text, forceMoveMarkers: true };
      });
      editor.pushUndoStop();
      editor.executeEdits('voicecoder', ops);
      editor.pushUndoStop();
      if (select) {
        const a = m.getPositionAt(select.start);
        const b = m.getPositionAt(select.end);
        editor.setSelection(new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column));
        editor.revealRangeInCenterIfOutsideViewport(new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column));
      }
    },
    insert(text) {
      const s = this.getSelection();
      this.apply([{ start: s.start, end: s.end, text }], { start: s.start + text.length, end: s.start + text.length });
    },
    gotoLine(line) {
      const n = Math.min(Math.max(1, line), model().getLineCount());
      editor.setPosition({ lineNumber: n, column: model().getLineFirstNonWhitespaceColumn(n) || 1 });
      editor.revealLineInCenter(n);
      editor.focus();
    },
    focus: () => editor.focus(),
  };
}

function cm6Adapter(el: Element): Adapter | null {
  const root = el.closest('.cm-editor') as HTMLElement | null;
  const content = root?.querySelector('.cm-content') as any;
  // @codemirror/view exposes the view through `cmView` (≤6.35) or `cmTile` (newer).
  const view: AnyEditor = content?.cmView?.view ?? content?.cmView?.rootView?.view ?? content?.cmTile?.view ?? content?.cmTile?.root?.view;
  if (!root || !view?.state || typeof view.dispatch !== 'function') return null;
  return {
    kind: 'codemirror6',
    root,
    getText: () => view.state.doc.toString(),
    getSelection: () => ({ start: view.state.selection.main.from, end: view.state.selection.main.to }),
    apply(changes, select) {
      view.dispatch({
        changes: changes.map((c) => ({ from: c.start, to: c.end, insert: c.text })),
        selection: select ? { anchor: select.start, head: select.end } : undefined,
        scrollIntoView: true,
        userEvent: 'input.voicecoder',
      });
    },
    insert(text) {
      const s = this.getSelection();
      this.apply([{ start: s.start, end: s.end, text }], { start: s.start + text.length, end: s.start + text.length });
    },
    gotoLine(line) {
      const n = Math.min(Math.max(1, line), view.state.doc.lines);
      const pos = view.state.doc.line(n).from;
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      view.focus();
    },
    focus: () => view.focus(),
  };
}

function cm5Adapter(el: Element): Adapter | null {
  const root = el.closest('.CodeMirror') as any;
  const cm: AnyEditor = root?.CodeMirror;
  if (!root || !cm) return null;
  return {
    kind: 'codemirror5',
    root,
    languageId: cm.getOption?.('mode')?.name ?? cm.getOption?.('mode'),
    getText: () => cm.getValue(),
    getSelection: () => ({ start: cm.indexFromPos(cm.getCursor('from')), end: cm.indexFromPos(cm.getCursor('to')) }),
    apply(changes, select) {
      cm.operation(() => {
        for (const c of [...changes].sort((a, b) => b.start - a.start)) cm.replaceRange(c.text, cm.posFromIndex(c.start), cm.posFromIndex(c.end), '+voicecoder');
        if (select) cm.setSelection(cm.posFromIndex(select.start), cm.posFromIndex(select.end));
      });
    },
    insert(text) {
      cm.replaceSelection(text, 'end', '+voicecoder');
    },
    gotoLine(line) {
      cm.setCursor({ line: Math.max(0, line - 1), ch: 0 });
      cm.scrollIntoView(null, 120);
      cm.focus();
    },
    focus: () => cm.focus(),
  };
}

function aceAdapter(el: Element): Adapter | null {
  const root = el.closest('.ace_editor') as any;
  const editor: AnyEditor = root?.env?.editor ?? ((window as any).ace?.edit && root ? (window as any).ace.edit(root) : null);
  if (!root || !editor?.session) return null;
  const doc = () => editor.session.getDocument();
  return {
    kind: 'ace',
    root,
    languageId: editor.session.getMode?.()?.$id?.split('/').pop(),
    getText: () => editor.getValue(),
    getSelection: () => {
      const r = editor.getSelectionRange();
      return { start: doc().positionToIndex(r.start), end: doc().positionToIndex(r.end) };
    },
    apply(changes, select) {
      const AceRange = (window as any).ace?.require?.('ace/range')?.Range;
      for (const c of [...changes].sort((a, b) => b.start - a.start)) {
        const a = doc().indexToPosition(c.start);
        const b = doc().indexToPosition(c.end);
        editor.session.replace(AceRange ? new AceRange(a.row, a.column, b.row, b.column) : { start: a, end: b }, c.text);
      }
      if (select) {
        const a = doc().indexToPosition(select.start);
        editor.moveCursorToPosition(a);
        editor.clearSelection();
      }
    },
    insert(text) {
      editor.insert(text);
    },
    gotoLine(line) {
      editor.gotoLine(line, 0, true);
      editor.focus();
    },
    focus: () => editor.focus(),
  };
}

function textFieldAdapter(el: Element): Adapter | null {
  const field = el as HTMLTextAreaElement | HTMLInputElement;
  const isText = el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && /^(text|search|url|email|)$/.test(el.type));
  if (!isText) return null;
  const fire = () => field.dispatchEvent(new Event('input', { bubbles: true }));
  return {
    kind: 'textarea',
    root: field,
    getText: () => field.value,
    getSelection: () => ({ start: field.selectionStart ?? 0, end: field.selectionEnd ?? 0 }),
    apply(changes, select) {
      // Single change on a focused field: execCommand keeps the native undo stack.
      if (changes.length === 1 && document.activeElement === field) {
        const c = changes[0]!;
        field.setSelectionRange(c.start, c.end);
        if (document.execCommand('insertText', false, c.text)) {
          if (select) field.setSelectionRange(select.start, select.end);
          return;
        }
      }
      for (const c of [...changes].sort((a, b) => b.start - a.start)) field.setRangeText(c.text, c.start, c.end, 'preserve');
      if (select) field.setSelectionRange(select.start, select.end);
      fire();
    },
    insert(text) {
      const s = this.getSelection();
      this.apply([{ start: s.start, end: s.end, text }], { start: s.start + text.length, end: s.start + text.length });
    },
    gotoLine(line) {
      const lines = field.value.split('\n');
      const n = Math.min(Math.max(1, line), lines.length);
      const offset = lines.slice(0, n - 1).reduce((acc, l) => acc + l.length + 1, 0);
      field.focus();
      field.setSelectionRange(offset, offset);
    },
    focus: () => field.focus(),
  };
}

function contentEditableAdapter(el: Element): Adapter | null {
  const root = (el as HTMLElement).closest('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]') as HTMLElement | null;
  if (!root) return null;
  return {
    kind: 'contenteditable',
    root,
    getText: () => null,
    getSelection: () => ({ start: 0, end: 0 }),
    apply() {
      throw new Error('unsupported');
    },
    insert(text) {
      root.focus();
      // execCommand fires beforeinput/input, which rich editors (ProseMirror, Lexical,
      // Slate) handle natively — and it participates in their undo history.
      if (!document.execCommand('insertText', false, text)) throw new Error('The page rejected the text.');
    },
    gotoLine() {
      throw new Error('unsupported');
    },
    focus: () => root.focus(),
  };
}

function adapterFor(el: Element | null): Adapter | null {
  if (!el) return null;
  return monacoAdapter(el) ?? cm6Adapter(el) ?? cm5Adapter(el) ?? aceAdapter(el) ?? textFieldAdapter(el) ?? contentEditableAdapter(el);
}

function activeAdapter(): Adapter | null {
  const active = deepActiveElement();
  return adapterFor(active && active !== document.body ? active : lastFocused);
}

function adapterById(id: string): Adapter | null {
  const el = document.querySelector(`[${ID_ATTR}="${CSS.escape(id)}"]`);
  if (!el || !el.isConnected) return null;
  // Re-resolve through the element itself (or a focusable descendant) to the live editor.
  const probe = (el.matches('textarea, input, [contenteditable]') ? el : el.querySelector('textarea, .cm-content, .ace_text-input, [contenteditable]')) ?? el;
  const a = adapterFor(probe);
  return a && a.root === el ? a : a && (el.contains(a.root) || a.root.contains(el)) ? a : null;
}

function deepActiveElement(): Element | null {
  let a: Element | null = document.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

function isProse(a: Adapter): boolean {
  if (a.kind === 'contenteditable') return true;
  if (a.kind !== 'textarea') return false;
  const el = a.root as HTMLTextAreaElement;
  const hint = `${el.name} ${el.id} ${el.placeholder} ${el.getAttribute('aria-label') ?? ''} ${el.className}`.toLowerCase();
  return !/code|editor|source|query|sql|script|snippet/.test(hint);
}

// ── Request handling ─────────────────────────────────────────────────────────

function handle(req: BridgeRequest): BridgeResponse {
  try {
    if (req.op === 'state') {
      const a = activeAdapter();
      if (!a) return { id: req.id, ok: false, code: 'no-editor', error: 'Click into an editor or text field first.' };
      const sel = a.getSelection();
      const state: EditorState = { kind: a.kind, targetId: targetIdOf(a.root), text: a.getText(), selectionStart: sel.start, selectionEnd: sel.end, languageId: a.languageId, prose: isProse(a) };
      return { id: req.id, ok: true, state };
    }
    const a = adapterById(req.targetId);
    if (!a) return { id: req.id, ok: false, code: 'target-gone', error: 'The editor this command was spoken in is no longer on the page.' };
    switch (req.op) {
      case 'apply': {
        if (req.expectedText !== null && a.getText() !== req.expectedText) {
          return { id: req.id, ok: false, code: 'stale', error: 'The code changed while VoiceCoder was working. Nothing was applied.' };
        }
        a.apply(req.changes, req.select);
        return { id: req.id, ok: true, text: a.getText() };
      }
      case 'insert':
        a.insert(req.text);
        return { id: req.id, ok: true, text: a.getText() };
      case 'revert': {
        const current = a.getText();
        if (current !== req.expectedText) return { id: req.id, ok: false, code: 'stale', error: 'The editor changed after VoiceCoder\'s edit, so undo could overwrite your work.' };
        const change = minimalChange(current, req.restoreText);
        a.apply([change], { start: change.start + change.text.length, end: change.start + change.text.length });
        return { id: req.id, ok: true, text: a.getText() };
      }
      case 'goto-line':
        a.gotoLine(req.line);
        return { id: req.id, ok: true };
      case 'focus':
        a.focus();
        return { id: req.id, ok: true };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { id: req.id, ok: false, code: msg === 'unsupported' ? 'unsupported' : 'failed', error: msg === 'unsupported' ? 'This editor only supports dictation.' : msg };
  }
}

function minimalChange(from: string, to: string): Change {
  let start = 0;
  const max = Math.min(from.length, to.length);
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++;
  let a = from.length;
  let b = to.length;
  while (a > start && b > start && from.charCodeAt(a - 1) === to.charCodeAt(b - 1)) {
    a--;
    b--;
  }
  return { start, end: a, text: to.slice(start, b) };
}

if (!window.__voicecoderBridge) {
  window.__voicecoderBridge = true;
  document.addEventListener(
    'focusin',
    (e) => {
      const t = e.composedPath()[0];
      if (t instanceof Element && !t.closest('#voicecoder-overlay-host')) lastFocused = t;
    },
    true,
  );
  document.addEventListener(REQUEST_EVENT, (e) => {
    const detail = (e as CustomEvent<string>).detail;
    let req: BridgeRequest;
    try {
      req = JSON.parse(detail);
    } catch {
      return;
    }
    if (typeof req?.id !== 'number') return;
    const res = handle(req);
    document.dispatchEvent(new CustomEvent(RESPONSE_EVENT, { detail: JSON.stringify(res) }));
  });
}

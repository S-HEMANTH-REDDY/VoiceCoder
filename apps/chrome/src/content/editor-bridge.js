// Editor Bridge — detects Monaco, CodeMirror, Ace, textarea, contenteditable
// and provides context extraction + cursor-accurate code insertion

import { EDITOR_TYPES } from '../shared/constants.js';

// ── Detection ──────────────────────────────────────────────────────────────────

export function detectEditor() {
  // Monaco (VS Code Web, GitHub Codespaces, vscode.dev, StackBlitz)
  if (isMonacoPresent()) return EDITOR_TYPES.MONACO;

  // CodeMirror 6 (LeetCode, many modern editors)
  if (isCodeMirror6Present()) return EDITOR_TYPES.CODEMIRROR;

  // CodeMirror 5
  if (isCodeMirror5Present()) return EDITOR_TYPES.CODEMIRROR;

  // Ace Editor (Replit, HackerRank)
  if (isAcePresent()) return EDITOR_TYPES.ACE;

  // Focused textarea
  const focused = document.activeElement;
  if (focused?.tagName === 'TEXTAREA') return EDITOR_TYPES.TEXTAREA;

  // Focused contenteditable
  if (focused?.isContentEditable) return EDITOR_TYPES.CONTENTEDITABLE;

  return EDITOR_TYPES.TEXTAREA; // fallback — try textarea insertion anyway
}

function isMonacoPresent() {
  return !!(
    window.monaco?.editor ||
    document.querySelector('.monaco-editor') ||
    document.querySelector('[data-uri]') // vscode.dev
  );
}

function isCodeMirror6Present() {
  return !!(
    document.querySelector('.cm-editor') ||
    document.querySelector('.cm-content')
  );
}

function isCodeMirror5Present() {
  return !!(
    document.querySelector('.CodeMirror') ||
    window.CodeMirror
  );
}

function isAcePresent() {
  return !!(
    window.ace ||
    document.querySelector('.ace_editor')
  );
}

// ── Context Extraction ─────────────────────────────────────────────────────────

export function getEditorContext(editorType) {
  try {
    switch (editorType) {
      case EDITOR_TYPES.MONACO: return getMonacoContext();
      case EDITOR_TYPES.CODEMIRROR: return getCodeMirrorContext();
      case EDITOR_TYPES.ACE: return getAceContext();
      default: return getTextareaContext();
    }
  } catch {
    return {};
  }
}

function getMonacoContext() {
  const editor = getMonacoEditor();
  if (!editor) return {};

  const model = editor.getModel();
  const position = editor.getPosition();
  if (!model || !position) return {};

  const currentLine = model.getLineContent(position.lineNumber);
  const indentation = currentLine.match(/^(\s*)/)?.[1] ?? '';

  // Grab 10 lines above cursor for context
  const startLine = Math.max(1, position.lineNumber - 10);
  const endLine = position.lineNumber;
  const surroundingCode = model.getValueInRange({
    startLineNumber: startLine,
    startColumn: 1,
    endLineNumber: endLine,
    endColumn: model.getLineMaxColumn(endLine),
  });

  return { surroundingCode, indentation, editorType: EDITOR_TYPES.MONACO };
}

function getCodeMirrorContext() {
  // CM6
  const cmContent = document.querySelector('.cm-content');
  if (cmContent) {
    const selection = window.getSelection();
    const range = selection?.getRangeAt(0);
    return {
      indentation: getLineIndentation(range),
      editorType: EDITOR_TYPES.CODEMIRROR,
    };
  }

  // CM5
  const cm = document.querySelector('.CodeMirror')?.CodeMirror;
  if (cm) {
    const cursor = cm.getCursor();
    const line = cm.getLine(cursor.line) ?? '';
    const indentation = line.match(/^(\s*)/)?.[1] ?? '';
    const from = { line: Math.max(0, cursor.line - 10), ch: 0 };
    const surroundingCode = cm.getRange(from, cursor);
    return { surroundingCode, indentation, editorType: EDITOR_TYPES.CODEMIRROR };
  }

  return { editorType: EDITOR_TYPES.CODEMIRROR };
}

function getAceContext() {
  const aceEl = document.querySelector('.ace_editor');
  if (!aceEl) return {};
  const aceEditor = ace?.edit(aceEl);
  if (!aceEditor) return {};

  const cursor = aceEditor.getCursorPosition();
  const session = aceEditor.getSession();
  const line = session.getLine(cursor.row) ?? '';
  const indentation = line.match(/^(\s*)/)?.[1] ?? '';

  const startRow = Math.max(0, cursor.row - 10);
  const surroundingCode = session.getLines(startRow, cursor.row).join('\n');

  return { surroundingCode, indentation, editorType: EDITOR_TYPES.ACE };
}

function getTextareaContext() {
  const el = document.activeElement;
  if (!el || el.tagName !== 'TEXTAREA') return {};

  const value = el.value;
  const cursorPos = el.selectionStart;
  const beforeCursor = value.slice(0, cursorPos);
  const lastNewline = beforeCursor.lastIndexOf('\n');
  const currentLine = beforeCursor.slice(lastNewline + 1);
  const indentation = currentLine.match(/^(\s*)/)?.[1] ?? '';

  const lines = beforeCursor.split('\n');
  const surroundingCode = lines.slice(Math.max(0, lines.length - 10)).join('\n');

  return { surroundingCode, indentation, editorType: EDITOR_TYPES.TEXTAREA };
}

function getLineIndentation(range) {
  if (!range) return '';
  const node = range.startContainer;
  const text = node?.textContent ?? '';
  return text.match(/^(\s*)/)?.[1] ?? '';
}

// ── Selection Reading ──────────────────────────────────────────────────────────

export function getEditorSelection(editorType) {
  try {
    switch (editorType) {
      case EDITOR_TYPES.MONACO: return getMonacoSelection();
      case EDITOR_TYPES.CODEMIRROR: return getCodeMirrorSelection();
      case EDITOR_TYPES.ACE: return getAceSelection();
      default: return getTextareaSelection();
    }
  } catch {
    return '';
  }
}

function getMonacoSelection() {
  const editor = getMonacoEditor();
  if (!editor) return '';
  const sel = editor.getSelection();
  if (!sel || sel.isEmpty()) return '';
  return editor.getModel()?.getValueInRange(sel) ?? '';
}

function getCodeMirrorSelection() {
  const cm = document.querySelector('.CodeMirror')?.CodeMirror;
  if (cm) return cm.getSelection();
  return window.getSelection()?.toString() ?? '';
}

function getAceSelection() {
  const aceEl = document.querySelector('.ace_editor');
  if (!aceEl) return '';
  return ace?.edit(aceEl)?.getSelectedText() ?? '';
}

function getTextareaSelection() {
  const el = document.activeElement;
  if (!el || el.tagName !== 'TEXTAREA') return '';
  return el.value.slice(el.selectionStart, el.selectionEnd);
}

// ── Selection Replacement ──────────────────────────────────────────────────────

export function replaceEditorSelection(editorType, code) {
  switch (editorType) {
    case EDITOR_TYPES.MONACO: return replaceMonacoSelection(code);
    case EDITOR_TYPES.CODEMIRROR: return replaceCodeMirrorSelection(code);
    case EDITOR_TYPES.ACE: return replaceAceSelection(code);
    case EDITOR_TYPES.TEXTAREA: return replaceTextareaSelection(code);
    case EDITOR_TYPES.CONTENTEDITABLE: return insertIntoContentEditable(code);
    default: return replaceTextareaSelection(code);
  }
}

function replaceMonacoSelection(code) {
  const editor = getMonacoEditor();
  if (!editor) return false;
  const sel = editor.getSelection();
  if (!sel) return false;
  editor.executeEdits('voicecoder', [{ range: sel, text: code, forceMoveMarkers: true }]);
  editor.focus();
  return true;
}

function replaceCodeMirrorSelection(code) {
  const cm = document.querySelector('.CodeMirror')?.CodeMirror;
  if (cm) {
    cm.replaceSelection(code, 'end');
    cm.focus();
    return true;
  }
  return insertViaNativeInput(code);
}

function replaceAceSelection(code) {
  const aceEl = document.querySelector('.ace_editor');
  if (!aceEl) return false;
  const aceEditor = ace?.edit(aceEl);
  if (!aceEditor) return false;
  aceEditor.session.replace(aceEditor.getSelectionRange(), code);
  aceEditor.focus();
  return true;
}

function replaceTextareaSelection(code) {
  const el = document.activeElement;
  if (!el || el.tagName !== 'TEXTAREA') return false;
  el.focus();
  document.execCommand('insertText', false, code);
  return true;
}

// ── Code Insertion ─────────────────────────────────────────────────────────────

export function insertCodeAtCursor(editorType, code) {
  switch (editorType) {
    case EDITOR_TYPES.MONACO: return insertIntoMonaco(code);
    case EDITOR_TYPES.CODEMIRROR: return insertIntoCodeMirror(code);
    case EDITOR_TYPES.ACE: return insertIntoAce(code);
    case EDITOR_TYPES.TEXTAREA: return insertIntoTextarea(code);
    case EDITOR_TYPES.CONTENTEDITABLE: return insertIntoContentEditable(code);
    default: return insertIntoTextarea(code);
  }
}

function insertIntoMonaco(code) {
  const editor = getMonacoEditor();
  if (!editor) return false;

  editor.focus();
  const position = editor.getPosition();
  if (!position) return false;

  editor.executeEdits('voicecoder', [
    {
      range: {
        startLineNumber: position.lineNumber,
        startColumn: position.column,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      },
      text: code + '\n',
      forceMoveMarkers: true,
    },
  ]);

  // Move cursor to end of inserted code
  const lines = code.split('\n');
  const newLine = position.lineNumber + lines.length - 1;
  const newCol = lines[lines.length - 1].length + 1;
  editor.setPosition({ lineNumber: newLine + 1, column: 1 });
  editor.focus();
  return true;
}

function insertIntoCodeMirror(code) {
  // Try CM6 first
  const cmContent = document.querySelector('.cm-content');
  if (cmContent) {
    return insertViaNativeInput(code + '\n');
  }

  // CM5
  const cm = document.querySelector('.CodeMirror')?.CodeMirror;
  if (cm) {
    cm.replaceSelection(code + '\n', 'end');
    cm.focus();
    return true;
  }

  return false;
}

function insertIntoAce(code) {
  const aceEl = document.querySelector('.ace_editor');
  if (!aceEl) return false;
  const aceEditor = ace?.edit(aceEl);
  if (!aceEditor) return false;

  aceEditor.session.insert(aceEditor.getCursorPosition(), code + '\n');
  aceEditor.focus();
  return true;
}

function insertIntoTextarea(code) {
  const el = document.activeElement;
  if (!el || el.tagName !== 'TEXTAREA') {
    // Try to find the most recently focused textarea
    const areas = document.querySelectorAll('textarea');
    if (areas.length === 0) return false;
    areas[areas.length - 1].focus();
    return insertIntoTextarea(code);
  }

  const start = el.selectionStart;
  const end = el.selectionEnd;
  const value = el.value;
  const insertText = code + '\n';

  // Use execCommand for undo support
  el.focus();
  el.setSelectionRange(start, end);
  document.execCommand('insertText', false, insertText);

  return true;
}

function insertIntoContentEditable(code) {
  const el = document.activeElement;
  if (!el?.isContentEditable) return false;

  el.focus();
  const selection = window.getSelection();
  if (!selection?.rangeCount) return false;

  const range = selection.getRangeAt(0);
  range.deleteContents();

  // Insert as preformatted text preserving newlines
  const textNode = document.createTextNode(code + '\n');
  range.insertNode(textNode);

  // Move cursor after insertion
  range.setStartAfter(textNode);
  range.setEndAfter(textNode);
  selection.removeAllRanges();
  selection.addRange(range);

  return true;
}

// Simulate native input events for editors that rely on browser input events (CM6)
// Must target the CM6 element directly — dispatching to document.activeElement fails
// if the editor lost focus (e.g. after the popup closed).
function insertViaNativeInput(text) {
  const el = document.querySelector('.cm-content') || document.activeElement;
  if (!el) return false;

  el.focus();

  const inputEvent = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertText',
    data: text,
  });
  el.dispatchEvent(inputEvent);

  if (!inputEvent.defaultPrevented) {
    el.focus();
    document.execCommand('insertText', false, text);
  }

  return true;
}

// ── Monaco Instance Helper ─────────────────────────────────────────────────────

export function getMonacoEditor() {
  // monaco.editor.getEditors() — standard API
  if (window.monaco?.editor?.getEditors) {
    const editors = window.monaco.editor.getEditors();
    if (editors.length > 0) {
      // Prefer focused editor
      return editors.find(e => e.hasTextFocus()) ?? editors[0];
    }
  }

  // Fallback: walk DOM for _modelData (internal but stable)
  const monacoEls = document.querySelectorAll('.monaco-editor');
  for (const el of monacoEls) {
    // Try to find the editor instance attached to the element
    for (const key of Object.keys(el)) {
      if (key.startsWith('__monaco')) {
        return el[key];
      }
    }
  }

  return null;
}

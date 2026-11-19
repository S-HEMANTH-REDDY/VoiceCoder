// Protocol between the isolated-world content script and the MAIN-world page bridge.
//
// Why a page bridge: content scripts run in an isolated JavaScript world. They share the
// DOM with the page but NOT its globals or DOM expando properties, so `window.monaco`,
// `window.ace`, `el.CodeMirror` and CodeMirror 6's `cmView` are invisible there. The
// original extension relied on exactly those, which is why editor detection and
// insertion were unreliable. The bridge runs in the page's world and exposes a narrow,
// verified editing API over DOM CustomEvents.

export const REQUEST_EVENT = 'voicecoder:request';
export const RESPONSE_EVENT = 'voicecoder:response';

export type EditorKind = 'monaco' | 'codemirror6' | 'codemirror5' | 'ace' | 'textarea' | 'contenteditable' | 'none';

export interface EditorState {
  kind: EditorKind;
  /** Stable id of the editor root (data attribute), used to bind results to it. */
  targetId: string;
  /** Full text when the editor exposes it (null for contenteditable / opaque editors). */
  text: string | null;
  selectionStart: number;
  selectionEnd: number;
  languageId?: string;
  /** True for prose fields (chat boxes, comments) where dictation is the default. */
  prose: boolean;
}

export interface Change {
  start: number;
  end: number;
  text: string;
}

export type BridgeRequest =
  | { id: number; op: 'state' }
  | { id: number; op: 'apply'; targetId: string; expectedText: string | null; changes: Change[]; select?: { start: number; end: number } }
  | { id: number; op: 'insert'; targetId: string; text: string }
  | { id: number; op: 'revert'; targetId: string; expectedText: string; restoreText: string }
  | { id: number; op: 'goto-line'; targetId: string; line: number }
  | { id: number; op: 'focus'; targetId: string };

export type BridgeResponse =
  | { id: number; ok: true; state?: EditorState; text?: string | null }
  | { id: number; ok: false; error: string; code: 'no-editor' | 'target-gone' | 'stale' | 'unsupported' | 'failed' };

// VoiceCoder Content Script
// Handles speech recognition, editor detection, code injection, and the mic indicator

import { MSG, EDITOR_TYPES } from '../shared/constants.js';
import { detectEditor, getEditorContext, insertCodeAtCursor, getEditorSelection, replaceEditorSelection } from './editor-bridge.js';
import { SpeechEngine } from './speech-engine.js';
import { createIndicator, setIndicatorState, removeIndicator } from './indicator.js';

// ── State ──────────────────────────────────────────────────────────────────────
let speechEngine = null;
let currentLanguage = 'python';
let lastInsertedCode = null;
let lastInsertedRange = null;
let isListening = false;
let savedFocusTarget = null;

// ── Message Router ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case MSG.START_LISTENING:
      currentLanguage = message.data?.language ?? currentLanguage;
      startListening();
      sendResponse({ ok: true });
      break;

    case MSG.STOP_LISTENING:
      stopListening();
      sendResponse({ ok: true });
      break;

    case MSG.UNDO_LAST:
      undoLastInsertion();
      sendResponse({ ok: true });
      break;

    case MSG.LANGUAGE_CHANGED:
      currentLanguage = message.data.language;
      sendResponse({ ok: true });
      break;

    default:
      sendResponse({ ok: false });
  }
  return true;
});

// ── Rewrite Intent Detection ───────────────────────────────────────────────────
const REWRITE_KEYWORDS = ['rewrite', 'refactor', 'optimize', 'simplify', 'clean up', 'add comments', 'improve', 'fix this'];

function isRewriteIntent(transcript) {
  const lower = transcript.toLowerCase();
  return REWRITE_KEYWORDS.some(kw => lower.includes(kw));
}

// ── Listening Lifecycle ────────────────────────────────────────────────────────
function restoreEditorFocus() {
  if (savedFocusTarget && document.contains(savedFocusTarget)) {
    savedFocusTarget.focus();
  }
}

function startListening() {
  if (isListening) return;
  isListening = true;

  // Save whatever had focus before the indicator appears (likely the editor).
  // The popup closing can briefly steal focus — we restore it after 150ms.
  savedFocusTarget = document.activeElement;
  createIndicator();
  setIndicatorState('listening');
  setTimeout(restoreEditorFocus, 150);

  speechEngine = new SpeechEngine({
    onInterim(transcript) {
      setIndicatorState('listening', transcript);
    },
    async onFinal(transcript) {
      if (!transcript.trim()) return;
      console.log('[VoiceCoder] onFinal fired:', transcript);
      setIndicatorState('generating', transcript);

      try {
        const editorType = detectEditor();
        const context = gatherEditorContext();
        const selection = getEditorSelection(editorType);
        const useRewrite = isRewriteIntent(transcript) && selection.trim().length > 0;

        const response = await chrome.runtime.sendMessage(
          useRewrite
            ? { type: MSG.REQUEST_REWRITE, data: { transcript, selectedCode: selection, context } }
            : { type: MSG.REQUEST_GENERATION, data: { transcript, context } }
        );

        console.log('[VoiceCoder] LLM response:', response);
        if (response.ok && response.code) {
          // Restore editor focus before injecting — it may have been lost
          // when the popup closed or when Alt+Space briefly shifted focus.
          restoreEditorFocus();
          const ok = useRewrite
            ? replaceEditorSelection(editorType, response.code)
            : injectCode(response.code);
          if (ok) {
            lastInsertedCode = response.code;
            setIndicatorState('listening');
          } else {
            setIndicatorState('error', 'Could not find cursor position');
            setTimeout(() => setIndicatorState('listening'), 2000);
          }
        } else {
          console.error('[VoiceCoder] Generation failed:', response?.error);
          setIndicatorState('error', response?.error || 'Generation failed');
          setTimeout(() => setIndicatorState('listening'), 4000);
        }
      } catch (err) {
        console.error('[VoiceCoder] Error:', err);
        setIndicatorState('error', err.message);
        setTimeout(() => setIndicatorState('listening'), 4000);
      }
    },
    onError(err) {
      console.error('[VoiceCoder] Speech error:', err);
      setIndicatorState('error', 'Mic error');
    },
  });

  speechEngine.start();
}

function stopListening() {
  if (!isListening) return;
  isListening = false;
  // Flush any buffered interim transcript so the last command isn't lost.
  speechEngine?.flush();
  speechEngine?.stop();
  speechEngine = null;
  removeIndicator();
}

// ── Editor Integration ─────────────────────────────────────────────────────────
function gatherEditorContext() {
  try {
    const editorType = detectEditor();
    return getEditorContext(editorType);
  } catch {
    return {};
  }
}

function injectCode(code) {
  try {
    const editorType = detectEditor();
    return insertCodeAtCursor(editorType, code);
  } catch (err) {
    console.error('[VoiceCoder] Injection error:', err);
    return false;
  }
}

// ── Undo ───────────────────────────────────────────────────────────────────────
function undoLastInsertion() {
  if (!lastInsertedCode) return;

  const editorType = detectEditor();

  if (editorType === EDITOR_TYPES.MONACO) {
    const editor = getMonacoEditor();
    if (editor) {
      editor.trigger('voicecoder', 'undo', null);
    }
  } else {
    // For textarea/contenteditable, use document.execCommand undo
    document.execCommand('undo');
  }

  lastInsertedCode = null;
}

// Messages between content script, popup/settings and the service worker.

import type { EditorContext } from '@voicecoder/core/context/context';
import type { EditBlock } from '@voicecoder/core/edit/schema';

export const PORT_COMMAND = 'voicecoder-command';

export type ToWorker =
  | { type: 'get-state' }
  | { type: 'toggle'; tabId?: number }
  | { type: 'listening-changed'; listening: boolean }
  | { type: 'record-turn'; transcript: string; kind: string; outcome: string; ok: boolean }
  | { type: 'set-focus'; startLine: number; endLine: number }
  | { type: 'save-settings'; settings: Partial<StoredSettings> }
  | { type: 'save-key'; provider: 'anthropic' | 'openai'; key: string }
  | { type: 'clear-keys' };

export type ToContent =
  | { type: 'start'; lang: string; mode: 'continuous' | 'push-to-talk' }
  | { type: 'stop' }
  | { type: 'toggle'; lang: string; mode: 'continuous' | 'push-to-talk' }
  | { type: 'undo' }
  | { type: 'ping' };

export interface StoredSettings {
  provider: 'anthropic' | 'openai';
  model: string;
  speechLang: string;
  mode: 'continuous' | 'push-to-talk';
}

export const DEFAULT_SETTINGS: StoredSettings = { provider: 'anthropic', model: '', speechLang: 'en-US', mode: 'continuous' };

/** Sent over a long-lived port; disconnecting the port cancels the request. */
export interface CommandRequest {
  transcript: string;
  context: EditorContext;
  prose: boolean;
}

export type CommandEvent =
  | { type: 'intent'; kind: string; source: string }
  | { type: 'preview'; text: string }
  | { type: 'edits'; summary: string; edits: EditBlock[]; kind: string }
  | { type: 'text'; text: string; title: string }
  | { type: 'insert'; text: string }
  | { type: 'unsupported'; message: string }
  | { type: 'error'; message: string };

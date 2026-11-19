import type * as vscode from 'vscode';

export type SpeechEvent =
  | { type: 'state'; state: 'idle' | 'connecting' | 'listening' | 'error'; detail?: string }
  | { type: 'interim'; text: string }
  | { type: 'final'; text: string; promoted?: boolean; latencyMs?: number }
  | { type: 'speech-start' }
  | { type: 'level'; rms: number }
  | { type: 'error'; code: string; message: string };

export interface SpeechSource extends vscode.Disposable {
  readonly id: 'browser' | 'native';
  readonly label: string;
  start(): Promise<void>;
  stop(opts?: { flush?: boolean }): void;
  setLanguage(lang: string): void;
  setMode(mode: 'continuous' | 'push-to-talk'): void;
  onEvent(listener: (e: SpeechEvent) => void): vscode.Disposable;
}

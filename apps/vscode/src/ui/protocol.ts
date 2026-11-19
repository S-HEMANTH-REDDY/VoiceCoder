// Messages between the extension host and the assistant webview. Plain data only.

import type { DiffLine, StageStats } from '@voicecoder/core';

export type Phase = 'idle' | 'connecting' | 'listening' | 'thinking' | 'applying' | 'review' | 'awaiting-approval' | 'running' | 'error';

export interface CommandView {
  id: string;
  transcript: string;
  intent?: string;
  source?: 'local' | 'llm' | 'heuristic';
  status: 'running' | 'done' | 'error' | 'cancelled' | 'review';
  title: string;
  message?: string;
  /** Long-form markdown-ish text (explanations, diagnoses). */
  body?: string;
  preview?: string;
  diff?: DiffLine[];
  stats?: { added: number; removed: number };
  file?: string;
  latencyMs?: number;
  at: number;
}

export interface ApprovalView {
  id: number;
  title: string;
  detail: string;
  subject?: string;
  labels: string[];
  severity: 'low' | 'medium' | 'high';
  approveLabel?: string;
}

export interface AgentStepView {
  step: number;
  tool: string;
  description: string;
  status: 'running' | 'ok' | 'failed' | 'awaiting-approval';
  summary?: string;
  durationMs?: number;
}

export interface AgentView {
  goal: string;
  status: 'planning' | 'awaiting-plan-approval' | 'running' | 'done' | 'failed' | 'cancelled';
  plan: Array<{ title: string; detail: string }>;
  steps: AgentStepView[];
  report?: string;
}

export interface UiState {
  phase: Phase;
  phaseDetail?: string;
  listening: boolean;
  speechProvider: 'browser' | 'native';
  speechLabel: string;
  language: string;
  mode: 'continuous' | 'push-to-talk';
  review: 'apply-and-review' | 'preview-first';
  interim: string;
  current: CommandView | null;
  history: CommandView[];
  approval: ApprovalView | null;
  agent: AgentView | null;
  hasPendingChange: boolean;
  provider: string;
  model: string;
  hasKey: boolean;
  trusted: boolean;
  metrics: StageStats[];
  counters: Record<string, number>;
  platform: NodeJS.Platform;
}

export type HostMessage =
  | { type: 'state'; state: UiState }
  | { type: 'level'; rms: number }
  | { type: 'preview'; id: string; text: string }
  | { type: 'interim'; text: string };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'toggle-listening' }
  | { type: 'submit'; text: string }
  | { type: 'accept' }
  | { type: 'reject' }
  | { type: 'undo' }
  | { type: 'cancel' }
  | { type: 'approve'; id: number; ok: boolean }
  | { type: 'set-key' }
  | { type: 'set'; key: 'language' | 'mode' | 'speechProvider' | 'review'; value: string }
  | { type: 'open-settings' }
  | { type: 'reset-metrics' }
  | { type: 'open-mic-page' }
  | { type: 'open-file'; file: string; line?: number };

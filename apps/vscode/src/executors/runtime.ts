import type * as vscode from 'vscode';
import type { LLMProvider, MetricsRecorder, SessionMemory } from '@voicecoder/core';
import type { Settings } from '../config.js';
import type { ChangeManager } from '../editor/changes.js';
import type { ApprovalBroker } from '../services/approvals.js';
import type { ProcessRunner } from '../services/process.js';
import type { AgentView, CommandView } from '../ui/protocol.js';

/** Everything an executor may use. Executors never touch UI state directly. */
export interface Runtime {
  provider(): LLMProvider;
  settings(): Settings;
  memory: SessionMemory;
  metrics: MetricsRecorder;
  changes: ChangeManager;
  approvals: ApprovalBroker;
  runner: ProcessRunner;
  log: vscode.LogOutputChannel;
  workspaceRoot(): vscode.Uri | undefined;
  trusted(): boolean;
  /** Update the visible command card. */
  update(patch: Partial<CommandView>): void;
  /** Stream preview text into the command card (high frequency). */
  preview(text: string): void;
  setAgent(view: AgentView | null): void;
  setPhase(phase: 'thinking' | 'applying' | 'running' | 'awaiting-approval', detail?: string): void;
}

export interface ExecResult {
  ok: boolean;
  title: string;
  message?: string;
  body?: string;
  /** One-line outcome recorded in conversational memory. */
  outcome: string;
  file?: string;
  status?: CommandView['status'];
}

export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserFacingError';
  }
}

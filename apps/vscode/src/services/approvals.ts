// Human-in-the-loop approvals. A consequential action (terminal command, dependency
// install, git commit/push, agent plan, agent file write) waits here until the developer
// approves or denies it — by voice ("accept"/"approve", "reject"/"deny"), by the button in
// the assistant panel, or from the notification. There is no auto-approve.

import * as vscode from 'vscode';
import type { RiskLabel } from '@voicecoder/core';

export interface ApprovalRequest {
  id: number;
  title: string;
  detail: string;
  /** Exact command or content being approved, shown verbatim. */
  subject?: string;
  labels: RiskLabel[] | string[];
  severity: 'low' | 'medium' | 'high';
  approveLabel?: string;
}

export class ApprovalBroker implements vscode.Disposable {
  private seq = 0;
  private current: { req: ApprovalRequest; resolve: (ok: boolean) => void } | null = null;
  private readonly emitter = new vscode.EventEmitter<ApprovalRequest | null>();
  readonly onDidChange = this.emitter.event;

  get pending(): ApprovalRequest | null {
    return this.current?.req ?? null;
  }

  request(req: Omit<ApprovalRequest, 'id'>, signal?: AbortSignal): Promise<boolean> {
    // Only one approval at a time; a new request denies a stale one.
    this.resolve(false);
    const full: ApprovalRequest = { ...req, id: ++this.seq };
    return new Promise<boolean>((resolve) => {
      this.current = { req: full, resolve };
      void vscode.commands.executeCommand('setContext', 'voicecoder.awaitingApproval', true);
      this.emitter.fire(full);
      signal?.addEventListener('abort', () => this.resolve(false, full.id), { once: true });
      const approve = full.approveLabel ?? 'Approve';
      void vscode.window
        .showInformationMessage(`VoiceCoder: ${full.title}`, { detail: full.subject ?? full.detail }, approve, 'Deny')
        .then((choice) => {
          if (choice) this.resolve(choice === approve, full.id);
        });
    });
  }

  /** Resolve the current approval (optionally only if it is still `id`). */
  resolve(ok: boolean, id?: number): boolean {
    const c = this.current;
    if (!c || (id !== undefined && c.req.id !== id)) return false;
    this.current = null;
    void vscode.commands.executeCommand('setContext', 'voicecoder.awaitingApproval', false);
    this.emitter.fire(null);
    c.resolve(ok);
    return true;
  }

  dispose(): void {
    this.resolve(false);
    this.emitter.dispose();
  }
}

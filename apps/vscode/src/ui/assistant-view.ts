import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { Orchestrator } from '../orchestrator.js';
import { updateSetting } from '../config.js';
import type { WebviewMessage } from './protocol.js';

export class AssistantViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly id = 'voicecoder.assistant';
  private view: vscode.WebviewView | undefined;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly orch: Orchestrator,
  ) {
    this.subs.push(this.orch.onUi((m) => void this.view?.webview.postMessage(m)));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'out', 'webview');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = randomBytes(16).toString('base64');
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'assistant.css'));
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'assistant.js'));
    view.webview.html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${view.webview.cspSource} data:; font-src ${view.webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}"></head>
<body><div id="app" role="application" aria-label="VoiceCoder assistant"></div>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
    view.webview.onDidReceiveMessage((m: WebviewMessage) => void this.onMessage(m), undefined, this.subs);
    view.onDidChangeVisibility(() => {
      if (view.visible) void view.webview.postMessage({ type: 'state', state: this.orch.state() });
    });
  }

  private async onMessage(m: WebviewMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        void this.view?.webview.postMessage({ type: 'state', state: this.orch.state() });
        return;
      case 'toggle-listening':
        return this.orch.toggleListening();
      case 'submit':
        if (typeof m.text === 'string' && m.text.trim()) await this.orch.handleUtterance(m.text.slice(0, 2000), 'typed');
        return;
      case 'accept':
        return void vscode.commands.executeCommand('voicecoder.accept');
      case 'reject':
        return void vscode.commands.executeCommand('voicecoder.reject');
      case 'undo':
        return void vscode.commands.executeCommand('voicecoder.undo');
      case 'cancel':
        return this.orch.cancel();
      case 'approve':
        this.orch.approvals.resolve(m.ok === true, m.id);
        return;
      case 'set-key':
        return void vscode.commands.executeCommand('voicecoder.setApiKey');
      case 'open-settings':
        return void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:voicecoder.voicecoder-vscode');
      case 'reset-metrics':
        return this.orch.resetMetrics();
      case 'open-mic-page':
        return this.orch.openMicPage();
      case 'set': {
        const allowed: Record<string, { key: string; values: string[] }> = {
          language: { key: 'speech.language', values: ['en-US', 'en-GB', 'en-IN', 'hi-IN', 'te-IN'] },
          mode: { key: 'speech.mode', values: ['continuous', 'push-to-talk'] },
          speechProvider: { key: 'speech.provider', values: ['browser', 'native'] },
          review: { key: 'edits.review', values: ['apply-and-review', 'preview-first'] },
        };
        const spec = allowed[m.key];
        if (spec && spec.values.includes(m.value)) await updateSetting(spec.key, m.value);
        return;
      }
      case 'open-file': {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!root || typeof m.file !== 'string' || m.file.includes('..')) return;
        const ed = await vscode.window.showTextDocument(vscode.Uri.joinPath(root, m.file), { preview: false });
        if (m.line) {
          const pos = new vscode.Position(Math.max(0, m.line - 1), 0);
          ed.selection = new vscode.Selection(pos, pos);
          ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        }
      }
    }
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
  }
}

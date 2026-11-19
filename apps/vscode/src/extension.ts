import * as vscode from 'vscode';
import { SECRET_KEYS } from './config.js';
import { Orchestrator } from './orchestrator.js';
import { AssistantViewProvider } from './ui/assistant-view.js';
import type { ProviderId } from '@voicecoder/core';

let orchestrator: Orchestrator | undefined;

export function activate(context: vscode.ExtensionContext): { orchestrator: Orchestrator } {
  const read = (rel: string) => async () => Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, rel))).toString('utf8');
  const orch = new Orchestrator(context, { html: read('media/mic.html'), script: read('out/mic.js') });
  orchestrator = orch;
  const view = new AssistantViewProvider(context.extensionUri, orch);

  const cmd = (id: string, fn: (...args: unknown[]) => unknown) => vscode.commands.registerCommand(id, fn);
  const report = async (fn: () => Promise<string>) => {
    try {
      const msg = await fn();
      vscode.window.setStatusBarMessage(`VoiceCoder: ${msg}`, 3000);
    } catch (err) {
      void vscode.window.showWarningMessage(`VoiceCoder: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  context.subscriptions.push(
    orch,
    view,
    vscode.window.registerWebviewViewProvider(AssistantViewProvider.id, view, { webviewOptions: { retainContextWhenHidden: true } }),
    cmd('voicecoder.toggleListening', () => orch.toggleListening()),
    cmd('voicecoder.startListening', () => orch.startListening()),
    cmd('voicecoder.stopListening', () => orch.stopListening()),
    cmd('voicecoder.typeCommand', async (text?: unknown) => {
      const value =
        typeof text === 'string'
          ? text
          : await vscode.window.showInputBox({ prompt: 'Say it in words — VoiceCoder runs it like a spoken command', placeHolder: 'e.g. add input validation to this function', ignoreFocusOut: true });
      if (value?.trim()) await orch.handleUtterance(value, 'typed');
    }),
    cmd('voicecoder.accept', () => report(() => orch.changes.accept())),
    cmd('voicecoder.reject', () => report(() => orch.changes.reject())),
    cmd('voicecoder.undo', () => report(() => orch.changes.undo())),
    cmd('voicecoder.cancel', () => orch.cancel()),
    cmd('voicecoder.showPanel', () => vscode.commands.executeCommand('voicecoder.assistant.focus')),
    cmd('voicecoder.resetMetrics', () => orch.resetMetrics()),
    cmd('voicecoder.clearMemory', () => {
      orch.memory.clear();
      vscode.window.setStatusBarMessage('VoiceCoder: conversation forgotten', 2500);
    }),
    cmd('voicecoder.setApiKey', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'Anthropic (Claude)', id: 'anthropic' as ProviderId, detail: 'Intent understanding, code changes, debugging and agent mode' },
          { label: 'OpenAI', id: 'openai' as ProviderId, detail: 'Alternative model provider; also used for native-microphone transcription' },
        ],
        { placeHolder: 'Which provider key do you want to store?' },
      );
      if (!pick) return;
      const key = await vscode.window.showInputBox({
        prompt: `${pick.label} API key — stored in VS Code Secret Storage, never in settings or logs`,
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim().length < 20 ? 'That does not look like an API key.' : /\s/.test(v.trim()) ? 'API keys contain no spaces.' : undefined),
      });
      if (!key) return;
      await context.secrets.store(SECRET_KEYS[pick.id], key.trim());
      const current = vscode.workspace.getConfiguration('voicecoder').get<string>('llm.provider');
      if (current !== pick.id) {
        const use = await vscode.window.showInformationMessage(`Use ${pick.label} for code changes?`, 'Use it', 'Keep current');
        if (use === 'Use it') await vscode.workspace.getConfiguration('voicecoder').update('llm.provider', pick.id, vscode.ConfigurationTarget.Global);
      }
      await orch.reconfigure();
      vscode.window.setStatusBarMessage(`VoiceCoder: ${pick.label} key saved`, 3000);
    }),
    cmd('voicecoder.clearApiKeys', async () => {
      await Promise.all(Object.values(SECRET_KEYS).map((k) => context.secrets.delete(k)));
      await orch.reconfigure();
      vscode.window.setStatusBarMessage('VoiceCoder: API keys removed', 3000);
    }),
  );

  return { orchestrator: orch };
}

export function deactivate(): void {
  // Disposed through context.subscriptions.
  orchestrator = undefined;
}

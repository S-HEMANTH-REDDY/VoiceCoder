// Voice Agent Mode in VS Code: typed workspace tools on top of the core VoiceAgent.
// Read-only tools run freely; anything that writes files, runs processes or touches git
// goes through the ApprovalBroker. All file writes are transactions (undoable).

import * as vscode from 'vscode';
import { z } from 'zod';
import {
  assessCommand,
  defineTool,
  isInsideWorkspace,
  isProtectedPath,
  VoiceAgent,
  type AgentTool,
  type IntentOf,
  type Transaction,
} from '@voicecoder/core';
import { diagnosticsFor, invalidateProjectCache, projectFiles } from '../context/collector.js';
import { describeProject, detectProject } from '../services/project.js';
import { git } from '../services/process.js';
import type { AgentView } from '../ui/protocol.js';
import { approveAndRun } from './shell.js';
import { UserFacingError, type ExecResult, type Runtime } from './runtime.js';

const MAX_READ = 40_000;

export async function runAgent(rt: Runtime, intent: IntentOf<'agent'>, signal: AbortSignal): Promise<ExecResult> {
  const root = rt.workspaceRoot();
  if (!root) throw new UserFacingError('Open a folder to use agent mode.');
  if (!rt.trusted()) throw new UserFacingError('Agent mode is disabled in untrusted workspaces.');
  const provider = rt.provider();
  const transactions: Transaction[] = [];

  const resolvePath = (p: string): vscode.Uri => {
    const rel = p.replace(/^\.?\//, '');
    if (!isInsideWorkspace(root.fsPath, rel)) throw new Error(`Path ${p} is outside the workspace.`);
    return vscode.Uri.joinPath(root, rel);
  };

  const tools: AgentTool[] = [
    defineTool({
      name: 'list_files',
      description: 'List workspace files (relative paths), optionally filtered by a substring.',
      input: z.object({ filter: z.string().nullable() }),
      consequential: false,
      run: async ({ filter }) => {
        invalidateProjectCache();
        const files = (await projectFiles(1500)).filter((f) => !filter || f.toLowerCase().includes(filter.toLowerCase()));
        return { ok: true, output: files.slice(0, 400).join('\n') || '(no files)', summary: `${files.length} files` };
      },
    }),
    defineTool({
      name: 'read_file',
      description: 'Read a workspace file. Returns numbered lines.',
      input: z.object({ path: z.string() }),
      consequential: false,
      run: async ({ path }) => {
        const data = Buffer.from(await vscode.workspace.fs.readFile(resolvePath(path))).toString('utf8');
        const numbered = data
          .slice(0, MAX_READ)
          .split('\n')
          .map((l, i) => `${i + 1}| ${l}`)
          .join('\n');
        return { ok: true, output: data.length > MAX_READ ? `${numbered}\n… (truncated)` : numbered, summary: `Read ${path}` };
      },
    }),
    defineTool({
      name: 'search_text',
      description: 'Search workspace files for a regular expression. Returns path:line: text matches (max 100).',
      input: z.object({ pattern: z.string(), glob: z.string().nullable() }),
      consequential: false,
      run: async ({ pattern, glob }) => {
        let re: RegExp;
        try {
          re = new RegExp(pattern, 'i');
        } catch {
          return { ok: false, output: 'Invalid regular expression.' };
        }
        const uris = await vscode.workspace.findFiles(glob || '**/*', '**/{node_modules,.git,dist,out,build,.venv,venv,target}/**', 800);
        const hits: string[] = [];
        for (const uri of uris) {
          if (hits.length >= 100) break;
          let text: string;
          try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            if (bytes.byteLength > 500_000) continue;
            text = Buffer.from(bytes).toString('utf8');
          } catch {
            continue;
          }
          text.split('\n').forEach((line, i) => {
            if (hits.length < 100 && re.test(line)) hits.push(`${vscode.workspace.asRelativePath(uri, false)}:${i + 1}: ${line.trim().slice(0, 200)}`);
          });
        }
        return { ok: true, output: hits.join('\n') || 'No matches.', summary: `${hits.length} matches` };
      },
    }),
    defineTool({
      name: 'write_file',
      description: 'Create a file or overwrite it with full content. Prefer edit_file for existing files.',
      input: z.object({ path: z.string(), content: z.string() }),
      consequential: true,
      describe: ({ path, content }) => `Write ${path} (${content.split('\n').length} lines)`,
      run: async ({ path, content }) => {
        if (isProtectedPath(path)) return { ok: false, output: `Refusing to write protected path ${path}.` };
        const res = await rt.changes.writeFile(resolvePath(path), content, `Agent: write ${path}`);
        transactions.push(res.tx);
        invalidateProjectCache();
        return { ok: true, output: `${res.created ? 'Created' : 'Overwrote'} ${path}.`, summary: `${res.created ? 'Created' : 'Wrote'} ${path}` };
      },
    }),
    defineTool({
      name: 'edit_file',
      description: 'Apply minimal search/replace edits to an existing file. Each search must match the file exactly once.',
      input: z.object({ path: z.string(), edits: z.array(z.object({ search: z.string().min(1), replace: z.string() })).min(1) }),
      consequential: true,
      describe: ({ path, edits }) => `Edit ${path} (${edits.length} change${edits.length === 1 ? '' : 's'})`,
      run: async ({ path, edits }) => {
        if (isProtectedPath(path)) return { ok: false, output: `Refusing to edit protected path ${path}.` };
        try {
          const res = await rt.changes.editFile(resolvePath(path), edits, `Agent: edit ${path}`);
          transactions.push(res.tx);
          const added = res.diff.filter((d) => d.type === 'add').length;
          const removed = res.diff.filter((d) => d.type === 'remove').length;
          return { ok: true, output: `Edited ${path} (+${added} −${removed}).`, summary: `Edited ${path} +${added} −${removed}` };
        } catch (err) {
          return { ok: false, output: `Edit failed: ${err instanceof Error ? err.message : String(err)} Read the file again and use exact text.` };
        }
      },
    }),
    defineTool({
      name: 'get_diagnostics',
      description: 'Compiler/linter diagnostics for a file, or for all open files when path is null.',
      input: z.object({ path: z.string().nullable() }),
      consequential: false,
      run: async ({ path }) => {
        // Give language servers a moment to re-analyse after edits.
        await new Promise((r) => setTimeout(r, 600));
        const uris = path ? [resolvePath(path)] : vscode.languages.getDiagnostics().map(([u]) => u);
        const lines: string[] = [];
        for (const u of uris) {
          for (const d of diagnosticsFor(u, 40)) {
            if (d.severity === 'error' || d.severity === 'warning') lines.push(`${vscode.workspace.asRelativePath(u, false)}:${d.line} [${d.severity}] ${d.message}`);
          }
        }
        return { ok: true, output: lines.join('\n') || 'No errors or warnings.', summary: `${lines.length} problems` };
      },
    }),
    defineTool({
      name: 'run_command',
      description: 'Run a shell command in the workspace root (tests, builds, installs). The developer must approve it; dangerous commands are blocked.',
      input: z.object({ command: z.string(), reason: z.string() }),
      // Approval is handled inside approveAndRun (with risk labels), not by the runtime.
      consequential: false,
      timeoutMs: 15 * 60_000,
      describe: ({ command }) => `$ ${command}`,
      run: async ({ command, reason }, { signal: s }) => {
        const a = assessCommand(command, { workspaceRoot: root.fsPath });
        if (!a.allowed) return { ok: false, output: `Blocked by safety policy: ${a.reasons.join(' ')}`, summary: 'Blocked' };
        if (a.labels.includes('long-running')) return { ok: false, output: 'Long-running servers cannot be observed by the agent. Run tests or builds instead.', summary: 'Rejected' };
        const res = await approveAndRun(rt, command, { title: 'Agent wants to run a command', signal: s, reason });
        rt.setPhase('running', 'Agent working…');
        if (!res.approved) return { ok: false, output: 'The developer DENIED running this command.', summary: 'Denied' };
        return {
          ok: res.exitCode === 0,
          output: `exit code ${res.exitCode}${res.timedOut ? ' (timed out)' : ''}\n${res.output ?? ''}`,
          summary: `exit ${res.exitCode}`,
        };
      },
    }),
    defineTool({
      name: 'git_status',
      description: 'Show git status and a diff stat of uncommitted changes.',
      input: z.object({}),
      consequential: false,
      run: async () => {
        const s = await git(['status', '--short'], root.fsPath);
        const d = await git(['diff', '--stat'], root.fsPath);
        return { ok: s.code === 0, output: `${s.stdout}\n${d.stdout}`.trim() || 'Clean.', summary: 'git status' };
      },
    }),
  ];

  const project = await detectProject(root);
  const files = await projectFiles(300);
  const environment = `${describeProject(project)}\nOS: ${process.platform}\nFiles (${files.length}):\n${files.slice(0, 200).join('\n')}\nActive file: ${vscode.window.activeTextEditor ? vscode.workspace.asRelativePath(vscode.window.activeTextEditor.document.uri, false) : 'none'}\nConversation so far:\n${rt.memory.render(400) || '(none)'}`;

  const view: AgentView = { goal: intent.goal, status: 'planning', plan: [], steps: [] };
  const push = () => rt.setAgent({ ...view, plan: [...view.plan], steps: view.steps.map((s) => ({ ...s })) });
  push();

  const agent = new VoiceAgent({
    provider,
    tools,
    environment,
    maxSteps: rt.settings().agentMaxSteps,
    signal,
    approvePlan: async (plan) => {
      view.plan = plan.steps;
      view.status = 'awaiting-plan-approval';
      push();
      rt.setPhase('awaiting-approval', 'Approve the plan');
      const ok = await rt.approvals.request(
        {
          title: `Agent plan (${plan.steps.length} steps)`,
          detail: plan.goal,
          subject: plan.steps.map((s, i) => `${i + 1}. ${s.title}`).join('\n'),
          labels: ['Multi-step changes', 'Each file write and command still needs approval'],
          severity: 'medium',
          approveLabel: 'Start',
        },
        signal,
      );
      view.status = ok ? 'running' : 'cancelled';
      push();
      rt.setPhase('running', 'Agent working…');
      return ok;
    },
    approveAction: async ({ description, tool }) => {
      rt.setPhase('awaiting-approval', description);
      const ok = await rt.approvals.request(
        { title: `Agent: ${description}`, detail: `Tool ${tool}`, subject: description, labels: ['Changes files in your workspace (undoable)'], severity: 'low', approveLabel: 'Allow' },
        signal,
      );
      rt.setPhase('running', 'Agent working…');
      return ok;
    },
    onEvent: (e) => {
      switch (e.type) {
        case 'plan':
          view.plan = e.plan.steps;
          break;
        case 'step-start':
          view.steps.push({ step: e.step, tool: e.tool, description: e.description, status: 'running' });
          rt.log.info(`agent step ${e.step}: ${e.tool}`);
          break;
        case 'approval-needed': {
          const s = view.steps.find((x) => x.step === e.step);
          if (s) s.status = 'awaiting-approval';
          break;
        }
        case 'step-end': {
          const s = view.steps.find((x) => x.step === e.step);
          if (s) Object.assign(s, { status: e.ok ? 'ok' : 'failed', summary: e.summary, durationMs: e.durationMs });
          rt.metrics.record(`agent.tool.${e.tool}`, e.durationMs);
          break;
        }
        case 'retry':
          rt.update({ message: `Retrying model call (${e.attempt})…` });
          break;
        case 'done':
          view.status = e.ok ? 'done' : signal.aborted ? 'cancelled' : 'failed';
          view.report = e.report;
          break;
        case 'error':
          view.status = 'failed';
          view.report = e.message;
          break;
      }
      push();
    },
  });

  const result = await agent.run(intent.goal);
  rt.metrics.increment(result.ok ? 'agent.completed' : 'agent.incomplete');
  return {
    ok: result.ok,
    title: result.ok ? 'Agent finished' : 'Agent stopped',
    body: result.report,
    message: transactions.length ? `${transactions.length} file change${transactions.length === 1 ? '' : 's'} — say “undo” to revert the last one.` : undefined,
    outcome: `Agent: ${result.report.split('\n')[0]?.slice(0, 160)}`,
    status: result.ok ? 'done' : 'error',
  };
}

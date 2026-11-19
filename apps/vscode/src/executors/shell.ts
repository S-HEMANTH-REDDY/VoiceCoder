// Terminal, test and git intents. Every process launch passes the command policy and an
// explicit approval; git writes use argv (no shell), so commit messages cannot inject.

import * as vscode from 'vscode';
import { assessCommand, COMMAND_SYSTEM, COMMIT_SYSTEM, CommandProposalSchema, type IntentOf } from '@voicecoder/core';
import { describeProject, detectProject, type ProjectCommands } from '../services/project.js';
import { git } from '../services/process.js';
import { track } from './editing.js';
import { UserFacingError, type ExecResult, type Runtime } from './runtime.js';

function root(rt: Runtime): vscode.Uri {
  const r = rt.workspaceRoot();
  if (!r) throw new UserFacingError('Open a folder first.');
  return r;
}

function requireTrust(rt: Runtime, what: string): void {
  if (!rt.trusted()) throw new UserFacingError(`${what} is disabled in untrusted workspaces. Trust this folder to enable it.`);
}

/** Policy check + human approval + run. Shared by tests, terminal intents and the agent. */
export async function approveAndRun(
  rt: Runtime,
  command: string,
  opts: { title: string; signal: AbortSignal; interactive?: boolean; reason?: string },
): Promise<{ approved: boolean; exitCode?: number | null; output?: string; durationMs?: number; timedOut?: boolean }> {
  const r = root(rt);
  const assessment = assessCommand(command, { workspaceRoot: r.fsPath });
  if (!assessment.allowed) {
    throw new UserFacingError(`Blocked by safety policy: ${assessment.reasons.join(' ')} Command: ${command}`);
  }
  rt.setPhase('awaiting-approval', opts.title);
  const ok = await rt.approvals.request(
    {
      title: opts.title,
      detail: opts.reason ?? 'VoiceCoder wants to run a command in your workspace.',
      subject: command,
      labels: assessment.reasons,
      severity: assessment.severity,
      approveLabel: 'Run',
    },
    opts.signal,
  );
  if (!ok) return { approved: false };
  if (opts.interactive || assessment.labels.includes('long-running')) {
    rt.runner.runInteractive(command, r.fsPath);
    return { approved: true, exitCode: null, output: '', durationMs: 0 };
  }
  rt.setPhase('running', command);
  const res = await rt.runner.run(command, { cwd: r.fsPath, timeoutMs: rt.settings().terminalTimeoutMs, signal: opts.signal });
  return { approved: true, ...res };
}

export async function runTests(rt: Runtime, signal: AbortSignal): Promise<ExecResult> {
  requireTrust(rt, 'Running tests');
  const project = await detectProject(root(rt));
  if (!project.test) throw new UserFacingError('No test command found (package.json "test" script, pytest, go test, cargo test or a Makefile test target).');
  const res = await approveAndRun(rt, project.test, { title: 'Run tests', signal, reason: 'Runs the project test suite.' });
  if (!res.approved) return { ok: false, title: 'Tests not run', message: 'You declined.', outcome: 'Declined to run tests', status: 'cancelled' };
  const summary = summarizeTestOutput(res.output ?? '');
  const passed = res.exitCode === 0;
  return {
    ok: passed,
    title: passed ? 'Tests passed' : res.timedOut ? 'Tests timed out' : 'Tests failed',
    message: `${summary || (passed ? 'All tests passed.' : 'See the VoiceCoder terminal.')}${passed ? '' : ' Say “fix the failing test” or “explain this error”.'}`,
    outcome: `${passed ? 'Tests passed' : 'Tests failed'}${summary ? `: ${summary}` : ''}`,
    status: passed ? 'done' : 'error',
  };
}

/** Pulls a one-line summary out of common test runners' output. */
export function summarizeTestOutput(output: string): string {
  const lines = output.split(/\r?\n/).map((l) => l.trim());
  const patterns = [
    /^Tests?:?\s+.*(passed|failed).*/i, // jest / vitest
    /^\d+ (passed|failed).*/i, // pytest short
    /^=+ .*(passed|failed).* =+$/i, // pytest
    /^(ok|FAIL)\s+\S+\s+[\d.]+s$/, // go
    /^test result: .*/, // cargo
    /^\s*\d+ passing.*/i, // mocha
    /^Ran \d+ tests? in .*/, // unittest
  ];
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (patterns.some((p) => p.test(l))) return l.replace(/^=+\s*|\s*=+$/g, '').slice(0, 160);
  }
  return '';
}

export async function runTerminal(rt: Runtime, intent: IntentOf<'terminal'>, signal: AbortSignal): Promise<ExecResult> {
  requireTrust(rt, 'Running commands');
  const r = root(rt);
  const project = await detectProject(r);
  let command = intent.command?.trim();
  if (!command && intent.purpose === 'run-app') command = project.run;
  if (!command) command = await proposeCommand(rt, intent.description || intent.transcript, project, signal);
  const res = await approveAndRun(rt, command, {
    title: intent.purpose === 'run-app' ? 'Run the application' : 'Run command',
    signal,
    interactive: intent.purpose === 'run-app',
    reason: intent.description,
  });
  if (!res.approved) return { ok: false, title: 'Not run', message: 'You declined.', outcome: `Declined: ${command}`, status: 'cancelled' };
  if (res.exitCode === null && !res.output) {
    return { ok: true, title: 'Started', message: `Running \`${command}\` in a terminal.`, outcome: `Started ${command}`, status: 'done' };
  }
  const ok = res.exitCode === 0;
  return {
    ok,
    title: ok ? 'Command succeeded' : 'Command failed',
    message: `\`${command}\` ${res.timedOut ? 'timed out' : `exited ${res.exitCode}`} in ${((res.durationMs ?? 0) / 1000).toFixed(1)}s.${ok ? '' : ' Say “explain this error”.'}`,
    outcome: `${ok ? 'Ran' : 'Failed'}: ${command}`,
    status: ok ? 'done' : 'error',
  };
}

async function proposeCommand(rt: Runtime, request: string, project: ProjectCommands, signal: AbortSignal): Promise<string> {
  rt.setPhase('thinking', 'Choosing a command…');
  const res = await rt.provider().structured({
    purpose: 'command',
    tier: 'fast',
    system: COMMAND_SYSTEM,
    messages: [{ role: 'user', content: `<context>\n${describeProject(project)}\nOS: ${process.platform}\n</context>\n<transcript>${request}</transcript>` }],
    schema: CommandProposalSchema,
    schemaName: 'command_proposal',
    signal,
    maxTokens: 600,
  });
  track(rt, res.usage);
  return res.value.command;
}

export async function runGit(rt: Runtime, intent: IntentOf<'git'>, signal: AbortSignal): Promise<ExecResult> {
  const cwd = root(rt).fsPath;
  const status = await git(['status', '--porcelain=v1', '--branch'], cwd);
  if (status.code !== 0) throw new UserFacingError('This folder is not a git repository.');
  const changed = status.stdout.split('\n').filter((l) => l && !l.startsWith('##'));
  const branch = status.stdout.split('\n')[0]?.replace(/^## /, '') ?? '';

  switch (intent.action) {
    case 'status':
      return {
        ok: true,
        title: 'Git status',
        body: changed.length ? '```\n' + changed.slice(0, 80).join('\n') + '\n```' : 'Working tree clean.',
        message: `${branch} · ${changed.length} changed file${changed.length === 1 ? '' : 's'}`,
        outcome: `Git status: ${changed.length} changed`,
        status: 'done',
      };
    case 'diff': {
      const stat = await git(['diff', 'HEAD', '--stat'], cwd);
      await vscode.commands.executeCommand('workbench.view.scm');
      return {
        ok: true,
        title: 'Changes',
        body: stat.stdout.trim() ? '```\n' + stat.stdout.trim().split('\n').slice(-40).join('\n') + '\n```' : 'No changes against HEAD.',
        message: `${changed.length} changed file${changed.length === 1 ? '' : 's'} on ${branch}. Opened Source Control.`,
        outcome: 'Showed git changes',
        status: 'done',
      };
    }
    case 'log': {
      const log = await git(['log', '--oneline', '-n', '15'], cwd);
      return { ok: true, title: 'Recent commits', body: '```\n' + log.stdout.trim() + '\n```', outcome: 'Showed git log', status: 'done' };
    }
    case 'commit-message': {
      const msg = await generateCommitMessage(rt, cwd, signal);
      setScmInput(msg);
      return { ok: true, title: 'Commit message', body: '```\n' + msg + '\n```', message: 'Placed in the Source Control message box. Say “create a git commit” to commit.', outcome: 'Generated commit message', status: 'done' };
    }
    case 'stage':
    case 'commit': {
      requireTrust(rt, 'Git commits');
      if (changed.length === 0) throw new UserFacingError('Nothing to commit — the working tree is clean.');
      const staged = changed.filter((l) => l[0] !== ' ' && l[0] !== '?');
      const stageAll = staged.length === 0;
      if (intent.action === 'stage') {
        rt.setPhase('awaiting-approval', 'Stage changes');
        const ok = await rt.approvals.request({ title: 'Stage all changes', detail: `${changed.length} files`, subject: 'git add -A', labels: ['Modifies the git index'], severity: 'low', approveLabel: 'Stage' }, signal);
        if (!ok) return { ok: false, title: 'Not staged', outcome: 'Declined staging', status: 'cancelled' };
        await git(['add', '-A'], cwd);
        return { ok: true, title: 'Staged', message: `Staged ${changed.length} files.`, outcome: 'Staged all changes', status: 'done' };
      }
      const message = intent.message?.trim() || (await generateCommitMessage(rt, cwd, signal));
      rt.setPhase('awaiting-approval', 'Create commit');
      const ok = await rt.approvals.request(
        {
          title: stageAll ? `Stage all ${changed.length} files and commit` : `Commit ${staged.length} staged file${staged.length === 1 ? '' : 's'}`,
          detail: `On ${branch}`,
          subject: message,
          labels: ['Creates a git commit', ...(stageAll ? ['Stages every changed file'] : [])],
          severity: 'medium',
          approveLabel: 'Commit',
        },
        signal,
      );
      if (!ok) return { ok: false, title: 'Not committed', message: 'You declined.', outcome: 'Declined commit', status: 'cancelled' };
      if (stageAll) await git(['add', '-A'], cwd);
      const res = await git(['commit', '-m', message], cwd);
      if (res.code !== 0) throw new UserFacingError(`git commit failed: ${(res.stderr || res.stdout).trim().split('\n').pop()}`);
      const head = await git(['log', '--oneline', '-n', '1'], cwd);
      return { ok: true, title: 'Committed', message: head.stdout.trim(), outcome: `Committed: ${message.split('\n')[0]}`, status: 'done' };
    }
    case 'push': {
      requireTrust(rt, 'Git push');
      rt.setPhase('awaiting-approval', 'Push');
      const ok = await rt.approvals.request(
        { title: 'Push to remote', detail: branch, subject: 'git push', labels: ['Talks to a git remote', 'Publishes your commits'], severity: 'high', approveLabel: 'Push' },
        signal,
      );
      if (!ok) return { ok: false, title: 'Not pushed', outcome: 'Declined push', status: 'cancelled' };
      rt.setPhase('running', 'git push');
      const res = await git(['push'], cwd, 120_000);
      if (res.code !== 0) throw new UserFacingError(`git push failed: ${(res.stderr || res.stdout).trim().split('\n').pop()}`);
      return { ok: true, title: 'Pushed', message: res.stderr.trim().split('\n').pop(), outcome: 'Pushed to remote', status: 'done' };
    }
  }
}

async function generateCommitMessage(rt: Runtime, cwd: string, signal: AbortSignal): Promise<string> {
  let diff = (await git(['diff', '--cached'], cwd)).stdout;
  if (!diff.trim()) diff = (await git(['diff', 'HEAD'], cwd)).stdout;
  const untracked = (await git(['ls-files', '--others', '--exclude-standard'], cwd)).stdout.trim();
  if (!diff.trim() && !untracked) throw new UserFacingError('There are no changes to describe.');
  rt.setPhase('thinking', 'Writing commit message…');
  const res = await rt.provider().complete({
    purpose: 'commit-message',
    tier: 'fast',
    system: COMMIT_SYSTEM,
    messages: [{ role: 'user', content: `<diff>\n${diff.slice(0, 24_000)}${untracked ? `\nNew files:\n${untracked}` : ''}\n</diff>` }],
    signal,
    maxTokens: 500,
  });
  track(rt, res.usage);
  return res.text.trim().replace(/^```\w*\n?|```$/g, '').trim();
}

function setScmInput(message: string): void {
  try {
    const gitExt = vscode.extensions.getExtension<{ getAPI(v: 1): { repositories: Array<{ inputBox: { value: string } }> } }>('vscode.git');
    const api = gitExt?.isActive ? gitExt.exports.getAPI(1) : undefined;
    const repo = api?.repositories[0];
    if (repo) repo.inputBox.value = message;
  } catch {
    // Git extension unavailable; message is still shown in the panel.
  }
}

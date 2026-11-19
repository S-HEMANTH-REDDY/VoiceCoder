// Runs approved commands. Output is mirrored live into a VS Code terminal (a
// Pseudoterminal, so the developer sees exactly what runs) and captured, bounded,
// for the model to observe. Commands are killed on timeout or cancellation,
// including their process group.

import * as vscode from 'vscode';
import { spawn, execFile } from 'node:child_process';

export interface RunResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

const MAX_CAPTURE = 200_000;

class OutputTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;
  private buffer: string[] = [];
  private opened = false;
  onInterrupt?: () => void;

  open(): void {
    this.opened = true;
    for (const b of this.buffer) this.writeEmitter.fire(b);
    this.buffer = [];
  }
  close(): void {
    this.opened = false;
  }
  handleInput(data: string): void {
    if (data === '\x03') this.onInterrupt?.();
  }
  write(text: string): void {
    const t = text.replace(/\r?\n/g, '\r\n');
    if (this.opened) this.writeEmitter.fire(t);
    else this.buffer.push(t);
  }
}

export class ProcessRunner implements vscode.Disposable {
  private terminal: vscode.Terminal | undefined;
  private pty: OutputTerminal | undefined;
  private lastFailureOutput: string | null = null;

  /** Output of the most recent failed command — used by "explain this error" / debug. */
  get lastFailure(): string | null {
    return this.lastFailureOutput;
  }

  private ensureTerminal(): OutputTerminal {
    if (!this.terminal || this.terminal.exitStatus !== undefined || !this.pty) {
      this.pty = new OutputTerminal();
      this.terminal = vscode.window.createTerminal({ name: 'VoiceCoder', pty: this.pty, iconPath: new vscode.ThemeIcon('mic') });
    }
    return this.pty;
  }

  async run(command: string, opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; show?: boolean; onOutput?: (chunk: string) => void }): Promise<RunResult> {
    const pty = this.ensureTerminal();
    if (opts.show !== false) this.terminal!.show(true);
    pty.write(`\x1b[2m$ ${command}\x1b[0m\n`);
    const started = Date.now();
    return new Promise<RunResult>((resolve) => {
      const child = spawn(command, {
        cwd: opts.cwd,
        shell: true,
        detached: process.platform !== 'win32',
        env: { ...process.env, FORCE_COLOR: '0', CI: process.env.CI ?? '1' },
      });
      let output = '';
      let timedOut = false;
      let cancelled = false;
      const capture = (buf: Buffer) => {
        const s = buf.toString('utf8');
        pty.write(s);
        opts.onOutput?.(s);
        if (output.length < MAX_CAPTURE) output += s.slice(0, MAX_CAPTURE - output.length);
      };
      child.stdout?.on('data', capture);
      child.stderr?.on('data', capture);
      const kill = () => {
        try {
          if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
          else child.kill('SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
        setTimeout(() => {
          try {
            if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }, 2000);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, opts.timeoutMs);
      const onAbort = () => {
        cancelled = true;
        kill();
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      pty.onInterrupt = onAbort;
      const finish = (code: number | null) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        const durationMs = Date.now() - started;
        const status = timedOut ? 'timed out' : cancelled ? 'cancelled' : `exit ${code}`;
        pty.write(`\x1b[2m[${status} · ${(durationMs / 1000).toFixed(1)}s]\x1b[0m\n\n`);
        if (code !== 0 || timedOut) this.lastFailureOutput = `$ ${command}\n${output}`;
        resolve({ exitCode: code, output, timedOut, cancelled, durationMs });
      };
      child.on('error', (err) => {
        output += `\n${err.message}`;
        finish(null);
      });
      child.on('close', finish);
    });
  }

  /** Long-running processes (dev servers) go to a regular, interactive terminal. */
  runInteractive(command: string, cwd: string): void {
    const t = vscode.window.createTerminal({ name: 'VoiceCoder · app', cwd, iconPath: new vscode.ThemeIcon('play') });
    t.show();
    t.sendText(command, true);
  }

  dispose(): void {
    this.terminal?.dispose();
  }
}

/** Runs git with an argument vector (no shell, so messages can never inject commands). */
export function git(args: string[], cwd: string, timeoutMs = 20_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : 1) : 0;
      resolve({ stdout: stdout.toString(), stderr: stderr.toString(), code });
    });
  });
}

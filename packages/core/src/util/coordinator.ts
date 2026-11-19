// Request coordination for voice commands.
//
//  * One command runs at a time per lane. A new command in the same lane cancels the
//    previous one (speaking a correction should win over a stale request), unless the
//    previous command is past its point of no return (e.g. a terminal process approved
//    by the user), in which case the new one queues.
//  * Identical command keys arriving within the dedupe window are dropped.
//  * Every task gets an AbortSignal and a hard timeout.

export interface TaskHandle {
  id: number;
  signal: AbortSignal;
  /** Mark the task as no longer cancellable by newer commands. */
  commit(): void;
}

export class CancelledError extends Error {
  constructor(reason = 'Cancelled') {
    super(reason);
    this.name = 'CancelledError';
  }
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Timed out after ${Math.round(ms / 1000)}s`);
    this.name = 'TimeoutError';
  }
}

interface Running {
  id: number;
  key: string;
  controller: AbortController;
  committed: boolean;
  done: Promise<unknown>;
}

export class CommandCoordinator {
  private seq = 0;
  private running = new Map<string, Running>();
  private recentKeys = new Map<string, number>();

  constructor(
    private readonly dedupeWindowMs = 1500,
    private readonly clock: () => number = Date.now,
  ) {}

  /**
   * Runs `fn` in `lane`. Returns `{ status: 'duplicate' }` without running when an
   * identical key was submitted within the dedupe window.
   */
  async run<T>(
    lane: string,
    key: string,
    fn: (task: TaskHandle) => Promise<T>,
    opts: { timeoutMs?: number } = {},
  ): Promise<{ status: 'ok'; value: T } | { status: 'duplicate' } | { status: 'cancelled' } | { status: 'error'; error: Error }> {
    const now = this.clock();
    for (const [k, t] of this.recentKeys) if (now - t > this.dedupeWindowMs) this.recentKeys.delete(k);
    const dedupeKey = `${lane}:${key}`;
    if (this.recentKeys.has(dedupeKey)) return { status: 'duplicate' };
    this.recentKeys.set(dedupeKey, now);

    const prev = this.running.get(lane);
    if (prev) {
      if (prev.committed) await prev.done.catch(() => undefined);
      else prev.controller.abort(new CancelledError('Superseded by a newer command'));
    }

    const controller = new AbortController();
    const id = ++this.seq;
    const entry: Running = { id, key, controller, committed: false, done: Promise.resolve() };
    const handle: TaskHandle = {
      id,
      signal: controller.signal,
      commit: () => {
        entry.committed = true;
      },
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const task = (async () => {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new TimeoutError(timeoutMs));
          reject(new TimeoutError(timeoutMs));
        }, timeoutMs);
      });
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason ?? new CancelledError()), { once: true });
      });
      return Promise.race([fn(handle), timeout, aborted]);
    })();
    entry.done = task;
    this.running.set(lane, entry);
    try {
      const value = await task;
      return { status: 'ok', value };
    } catch (err) {
      if (err instanceof CancelledError || (controller.signal.aborted && !(controller.signal.reason instanceof TimeoutError))) return { status: 'cancelled' };
      return { status: 'error', error: err instanceof Error ? err : new Error(String(err)) };
    } finally {
      clearTimeout(timer);
      if (this.running.get(lane)?.id === id) this.running.delete(lane);
    }
  }

  cancel(lane?: string): boolean {
    let any = false;
    for (const [l, r] of this.running) {
      if (lane && l !== lane) continue;
      r.controller.abort(new CancelledError('Cancelled by user'));
      any = true;
    }
    return any;
  }

  isBusy(lane?: string): boolean {
    return lane ? this.running.has(lane) : this.running.size > 0;
  }

  /** Allow an identical command again (e.g. explicit "repeat"). */
  forget(lane: string, key: string): void {
    this.recentKeys.delete(`${lane}:${key}`);
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new CancelledError();
}

export function newId(prefix = 'id'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

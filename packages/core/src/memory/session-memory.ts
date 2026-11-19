// Conversational memory. Lets developers talk the way they talk to a colleague:
//   "Create a login API." → "Add JWT authentication." → "Actually, use PostgreSQL."
// Each turn records what was asked and what changed (never full file contents), and the
// last touched code region is tracked so "make it async" knows what "it" is.

import { estimateTokens } from '../context/context.js';
import type { IntentKind } from '../intent/schema.js';

export interface Turn {
  id: string;
  at: number;
  transcript: string;
  kind: IntentKind;
  instruction: string;
  /** Short outcome, e.g. "Added async login() to auth.ts (+18 −2)". */
  outcome: string;
  file?: string;
  ok: boolean;
}

export interface FocusRegion {
  file: string;
  startLine: number;
  endLine: number;
  at: number;
  /** Symbol name when known — survives line shifts better than numbers. */
  symbol?: string;
}

export interface MemoryOptions {
  maxTurns?: number;
  /** How long a focus region stays the implicit referent of "it"/"this". */
  focusTtlMs?: number;
  /** Idle time after which the conversation is considered a new session. */
  sessionIdleMs?: number;
}

export class SessionMemory {
  private turns: Turn[] = [];
  private focus: FocusRegion | null = null;
  private readonly maxTurns: number;
  private readonly focusTtlMs: number;
  private readonly sessionIdleMs: number;

  constructor(opts: MemoryOptions = {}, private readonly clock: () => number = Date.now) {
    this.maxTurns = opts.maxTurns ?? 30;
    this.focusTtlMs = opts.focusTtlMs ?? 10 * 60_000;
    this.sessionIdleMs = opts.sessionIdleMs ?? 45 * 60_000;
  }

  record(turn: Omit<Turn, 'at'>): void {
    this.expireIfIdle();
    this.turns.push({ ...turn, at: this.clock() });
    if (this.turns.length > this.maxTurns) this.turns.splice(0, this.turns.length - this.maxTurns);
  }

  setFocus(region: Omit<FocusRegion, 'at'>): void {
    this.focus = { ...region, at: this.clock() };
  }

  /** The region "it"/"this" most likely refers to, if still fresh. */
  getFocus(file?: string): FocusRegion | null {
    if (!this.focus) return null;
    if (this.clock() - this.focus.at > this.focusTtlMs) return null;
    if (file && this.focus.file !== file) return null;
    return this.focus;
  }

  /** Shift the focus region when lines are inserted/removed above or inside it. */
  adjustFocus(file: string, atLine: number, delta: number): void {
    const f = this.focus;
    if (!f || f.file !== file || delta === 0) return;
    if (atLine < f.startLine) {
      f.startLine += delta;
      f.endLine += delta;
    } else if (atLine <= f.endLine) {
      f.endLine = Math.max(f.startLine, f.endLine + delta);
    }
  }

  lastTurn(): Turn | undefined {
    return this.turns.at(-1);
  }

  lastRepeatable(): Turn | undefined {
    return [...this.turns].reverse().find((t) => t.ok && t.kind !== 'control' && t.kind !== 'navigate');
  }

  history(): readonly Turn[] {
    return this.turns;
  }

  clear(): void {
    this.turns = [];
    this.focus = null;
  }

  /**
   * Renders recent turns for a prompt, newest last, under a token budget. Older turns
   * are dropped first; this keeps follow-up resolution cheap (typically < 300 tokens).
   */
  render(budgetTokens = 600): string {
    this.expireIfIdle();
    const lines: string[] = [];
    let used = 0;
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const t = this.turns[i]!;
      const asked = t.instruction && t.instruction !== t.transcript ? `"${t.transcript}" (understood as: ${t.instruction})` : `"${t.transcript}"`;
      const line = `- [${t.kind}] ${asked} → ${t.ok ? t.outcome : `failed: ${t.outcome}`}${t.file ? ` (${t.file})` : ''}`;
      const cost = estimateTokens(line);
      if (used + cost > budgetTokens) break;
      lines.unshift(line);
      used += cost;
    }
    return lines.join('\n');
  }

  private expireIfIdle(): void {
    const last = this.turns.at(-1);
    if (last && this.clock() - last.at > this.sessionIdleMs) this.clear();
  }
}

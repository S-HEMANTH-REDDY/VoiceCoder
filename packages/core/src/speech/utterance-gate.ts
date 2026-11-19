// Duplicate-command prevention for speech input.
//
// The original Chrome extension could fire the same command twice:
//   1. a 1.5 s silence timer promoted an interim transcript to "final", then
//   2. the engine delivered the real final result for the same utterance moments later
//   (plus auto-restart after `onend` could replay the tail of a result list).
//
// UtteranceGate sits between any speech provider and the command pipeline. It
// suppresses a final that is identical to, or a near-duplicate of, one committed
// within a short window. Interim promotions and engine finals share one gate, so
// whichever arrives first wins and the other is dropped.

export interface GateDecision {
  accept: boolean;
  reason?: 'empty' | 'duplicate' | 'subsumed';
}

export interface UtteranceGateOptions {
  /** Window in which an equivalent final is treated as a duplicate. */
  windowMs?: number;
  /** Token-overlap ratio above which two finals count as the same utterance. */
  similarity?: number;
}

export class UtteranceGate {
  private recent: Array<{ key: string; tokens: string[]; at: number }> = [];
  private readonly windowMs: number;
  private readonly similarity: number;

  constructor(opts: UtteranceGateOptions = {}, private readonly clock: () => number = Date.now) {
    // Long enough to catch engine restart echoes (~<1 s), short enough that a developer
    // deliberately repeating a command ("undo" … "undo") is not swallowed.
    this.windowMs = opts.windowMs ?? 1200;
    this.similarity = opts.similarity ?? 0.85;
  }

  /** Call for every candidate final. Records it when accepted. */
  offer(text: string): GateDecision {
    const key = canonical(text);
    if (!key) return { accept: false, reason: 'empty' };
    const now = this.clock();
    this.recent = this.recent.filter((r) => now - r.at <= this.windowMs);
    const tokens = key.split(' ');
    for (const r of this.recent) {
      if (r.key === key) return { accept: false, reason: 'duplicate' };
      // A promoted interim is usually a prefix of the engine's final ("go to line" →
      // "go to line 45") or vice-versa. Treat high overlap as the same utterance.
      if (overlap(tokens, r.tokens) >= this.similarity) return { accept: false, reason: 'subsumed' };
      if (isPrefixOf(tokens, r.tokens) || isPrefixOf(r.tokens, tokens)) {
        const ratio = Math.min(tokens.length, r.tokens.length) / Math.max(tokens.length, r.tokens.length);
        if (ratio >= 0.6) return { accept: false, reason: 'subsumed' };
      }
    }
    this.recent.push({ key, tokens, at: now });
    return { accept: true };
  }

  reset(): void {
    this.recent = [];
  }
}

function canonical(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPrefixOf(short: string[], long: string[]): boolean {
  if (short.length > long.length) return false;
  return short.every((t, i) => long[i] === t);
}

/** |A ∩ B| / max(|A|, |B|) over token multisets. */
function overlap(a: string[], b: string[]): number {
  const counts = new Map<string, number>();
  for (const t of a) counts.set(t, (counts.get(t) ?? 0) + 1);
  let shared = 0;
  for (const t of b) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      shared++;
      counts.set(t, c - 1);
    }
  }
  return shared / Math.max(a.length, b.length);
}

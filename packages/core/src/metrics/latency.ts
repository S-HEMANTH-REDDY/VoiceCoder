// Latency + usage metrics. Records numbers only (stage names, durations, token counts) —
// never transcripts or code — so it is safe to persist and display.

export interface Sample {
  stage: string;
  ms: number;
  at: number;
}

export interface StageStats {
  stage: string;
  count: number;
  p50: number;
  p95: number;
  mean: number;
  max: number;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  // Nearest-rank method.
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

export class MetricsRecorder {
  private samples: Sample[] = [];
  private counters = new Map<string, number>();

  constructor(private readonly maxSamples = 5000) {}

  record(stage: string, ms: number): void {
    this.samples.push({ stage, ms, at: Date.now() });
    if (this.samples.length > this.maxSamples) this.samples.splice(0, this.samples.length - this.maxSamples);
  }

  increment(counter: string, by = 1): void {
    this.counters.set(counter, (this.counters.get(counter) ?? 0) + by);
  }

  counter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  counters_(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }

  stats(): StageStats[] {
    const byStage = new Map<string, number[]>();
    for (const s of this.samples) {
      const arr = byStage.get(s.stage) ?? [];
      arr.push(s.ms);
      byStage.set(s.stage, arr);
    }
    return [...byStage.entries()]
      .map(([stage, values]) => {
        const sorted = [...values].sort((a, b) => a - b);
        return {
          stage,
          count: sorted.length,
          p50: round(percentile(sorted, 50)),
          p95: round(percentile(sorted, 95)),
          mean: round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
          max: round(sorted.at(-1)!),
        };
      })
      .sort((a, b) => a.stage.localeCompare(b.stage));
  }

  snapshot(): { samples: Sample[]; counters: Record<string, number> } {
    return { samples: [...this.samples], counters: this.counters_() };
  }

  restore(snapshot: { samples?: Sample[]; counters?: Record<string, number> }): void {
    this.samples = (snapshot.samples ?? []).filter((s) => typeof s.ms === 'number' && typeof s.stage === 'string').slice(-this.maxSamples);
    this.counters = new Map(Object.entries(snapshot.counters ?? {}).filter(([, v]) => typeof v === 'number'));
  }

  reset(): void {
    this.samples = [];
    this.counters.clear();
  }
}

/** Measures named phases of one command, e.g. speech-final → intent → edit-applied. */
export class Stopwatch {
  private readonly start: number;
  private last: number;
  readonly marks: Array<{ stage: string; ms: number }> = [];

  constructor(private readonly clock: () => number = defaultClock) {
    this.start = clock();
    this.last = this.start;
  }

  lap(stage: string): number {
    const t = this.clock();
    const ms = t - this.last;
    this.last = t;
    this.marks.push({ stage, ms });
    return ms;
  }

  total(): number {
    return this.clock() - this.start;
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

const defaultClock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

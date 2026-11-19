import { describe, expect, it, vi } from 'vitest';
import { normalizeTranscript, parseSpokenNumber } from '../src/speech/normalize.js';
import { UtteranceGate } from '../src/speech/utterance-gate.js';
import { WebSpeechController, type RecognitionEventLike, type RecognitionLike } from '../src/speech/web-speech.js';
import { EnergyVad, encodeWav } from '../src/speech/vad.js';

describe('normalizeTranscript', () => {
  it.each([
    ['add jay w t authentication', 'add JWT authentication'],
    ['actually use post gress', 'actually use PostgreSQL'],
    ['parse the jason response', 'parse the JSON response'],
    ['um create a uh type script interface', 'create a TypeScript interface'],
    ['add a use effect hook', 'add a useEffect hook'],
    ['write a sink function to fetch users', 'write async function to fetch users'],
    ['show get diff', 'show git diff'],
    ['get status of the order', 'get status of the order'],
    ['run pie test', 'run pytest'],
    ['add add error handling.', 'add error handling'],
  ])('%s → %s', (input, out) => {
    expect(normalizeTranscript(input)).toBe(out);
  });
});

describe('parseSpokenNumber', () => {
  it.each([
    ['45', 45],
    ['forty five', 45],
    ['forty-five', 45],
    ['one hundred and two', 102],
    ['two thousand', 2000],
    ['४५', 45],
    ['౪౫', 45],
  ])('%s', (input, n) => expect(parseSpokenNumber(input)).toBe(n));
  it('rejects non-numbers', () => {
    expect(parseSpokenNumber('banana')).toBeNull();
    expect(parseSpokenNumber('to')).toBeNull();
  });
});

describe('UtteranceGate', () => {
  it('suppresses exact and near duplicates within the window', () => {
    let t = 0;
    const gate = new UtteranceGate({ windowMs: 2000 }, () => t);
    expect(gate.offer('Go to line 45').accept).toBe(true);
    expect(gate.offer('go to line 45.').reason).toBe('duplicate');
    expect(gate.offer('go to line').reason).toBe('subsumed');
    t = 3000;
    expect(gate.offer('go to line 45').accept).toBe(true);
  });
  it('allows different commands', () => {
    const gate = new UtteranceGate();
    expect(gate.offer('go to line 4').accept).toBe(true);
    expect(gate.offer('go to line 5').accept).toBe(true);
    expect(gate.offer('').reason).toBe('empty');
  });
});

class FakeRecognition implements RecognitionLike {
  continuous = false;
  interimResults = false;
  lang = '';
  maxAlternatives = 1;
  onstart: (() => void) | null = null;
  onresult: ((e: RecognitionEventLike) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = 0;
  stopped = 0;
  start() {
    this.started++;
    queueMicrotask(() => this.onstart?.());
  }
  stop() {
    this.stopped++;
  }
  abort() {
    this.stopped++;
  }
  emit(resultIndex: number, results: Array<{ text: string; final: boolean }>) {
    const list = results.map((r) => Object.assign([{ transcript: r.text, confidence: 0.9 }], { isFinal: r.final }));
    this.onresult?.({ resultIndex, results: list as unknown as RecognitionEventLike['results'] });
  }
}

function setup(opts: { mode?: 'continuous' | 'push-to-talk' } = {}) {
  const instances: FakeRecognition[] = [];
  const finals: Array<{ text: string; promoted: boolean }> = [];
  const errors: string[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const ctl = new WebSpeechController(
    () => {
      const r = new FakeRecognition();
      instances.push(r);
      return r;
    },
    {
      onInterim: () => {},
      onFinal: (text, meta) => finals.push({ text, promoted: meta.promoted }),
      onState: () => {},
      onError: (code) => errors.push(code),
    },
    {
      lang: 'hi-IN',
      mode: opts.mode,
      setTimeout: (fn, ms) => {
        const t = { fn, ms, cleared: false };
        timers.push(t);
        return t;
      },
      clearTimeout: (h) => {
        (h as { cleared: boolean }).cleared = true;
      },
    },
  );
  const runTimers = () => {
    for (const t of timers.splice(0)) if (!t.cleared) t.fn();
  };
  return { ctl, instances, finals, errors, runTimers };
}

describe('WebSpeechController', () => {
  it('uses the configured language', () => {
    const { ctl, instances } = setup();
    ctl.start();
    expect(instances[0]!.lang).toBe('hi-IN');
  });

  it('never emits the same utterance twice when the silence timer promotes an interim', () => {
    const { ctl, instances, finals, runTimers } = setup();
    ctl.start();
    const r = instances[0]!;
    r.emit(0, [{ text: 'go to line 45', final: false }]);
    runTimers(); // silence → promoted
    r.emit(0, [{ text: 'go to line 45', final: true }]); // engine's late final for the same index
    expect(finals).toEqual([{ text: 'go to line 45', promoted: true }]);
  });

  it('emits engine finals once and clears the pending interim', () => {
    const { ctl, instances, finals, runTimers } = setup();
    ctl.start();
    const r = instances[0]!;
    r.emit(0, [{ text: 'undo', final: false }]);
    r.emit(0, [{ text: 'undo', final: true }]);
    runTimers();
    expect(finals).toEqual([{ text: 'undo', promoted: false }]);
  });

  it('ignores events from a stopped instance (race)', () => {
    const { ctl, instances, finals } = setup();
    ctl.start();
    const r = instances[0]!;
    ctl.stop({ flush: false });
    r.emit(0, [{ text: 'stale', final: true }]);
    r.onend?.();
    expect(finals).toEqual([]);
    expect(instances).toHaveLength(1); // no restart after stop
  });

  it('restarts with backoff after the engine ends while listening', () => {
    const { ctl, instances, runTimers } = setup();
    ctl.start();
    instances[0]!.onend?.();
    runTimers();
    expect(instances).toHaveLength(2);
    instances[1]!.onend?.();
    runTimers();
    expect(instances).toHaveLength(3);
  });

  it('flushes the pending interim on push-to-talk release', () => {
    const { ctl, instances, finals } = setup({ mode: 'push-to-talk' });
    ctl.start();
    instances[0]!.emit(0, [{ text: 'make it async', final: false }]);
    ctl.stop();
    expect(finals).toEqual([{ text: 'make it async', promoted: true }]);
  });

  it('stops retrying when the mic is denied', () => {
    const { ctl, instances, errors, runTimers } = setup();
    ctl.start();
    instances[0]!.onerror?.({ error: 'not-allowed' });
    instances[0]!.onend?.();
    runTimers();
    expect(errors).toEqual(['not-allowed']);
    expect(instances).toHaveLength(1);
  });

  it('reports unsupported browsers', () => {
    const errors: string[] = [];
    const ctl = new WebSpeechController(() => null, { onInterim() {}, onFinal() {}, onState() {}, onError: (c) => errors.push(c) });
    ctl.start();
    expect(errors).toEqual(['unsupported']);
  });

  it('handles multiple results in one event without duplication', () => {
    const { ctl, instances, finals } = setup();
    ctl.start();
    const r = instances[0]!;
    r.emit(0, [
      { text: 'first', final: true },
      { text: 'second', final: false },
    ]);
    r.emit(1, [
      { text: 'first', final: true },
      { text: 'second', final: true },
    ]);
    expect(finals.map((f) => f.text)).toEqual(['first', 'second']);
  });
});

describe('EnergyVad', () => {
  const rate = 16000;
  const tone = (ms: number, amp: number) => {
    const n = (rate * ms) / 1000;
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * amp * 32767);
    return out;
  };
  const noise = (ms: number, amp: number) => {
    const n = (rate * ms) / 1000;
    const out = new Int16Array(n);
    let seed = 42;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      out[i] = Math.round(((seed / 0x7fffffff) * 2 - 1) * amp * 32767);
    }
    return out;
  };

  it('detects a speech segment between silences', () => {
    const vad = new EnergyVad();
    const events = [...vad.push(noise(600, 0.002)), ...vad.push(tone(800, 0.3)), ...vad.push(noise(1000, 0.002))];
    expect(events.filter((e) => e.type === 'speech-start')).toHaveLength(1);
    const seg = events.find((e) => e.type === 'segment');
    expect(seg).toBeDefined();
    if (seg?.type === 'segment') expect(seg.durationMs).toBeGreaterThan(800);
  });

  it('ignores short clicks and steady background noise', () => {
    const vad = new EnergyVad();
    const events = [...vad.push(noise(1500, 0.01)), ...vad.push(tone(100, 0.5)), ...vad.push(noise(1500, 0.01))];
    expect(events.some((e) => e.type === 'segment')).toBe(false);
  });

  it('flush closes an open segment (push-to-talk)', () => {
    const vad = new EnergyVad();
    vad.push(noise(300, 0.002));
    vad.push(tone(600, 0.3));
    expect(vad.flush().some((e) => e.type === 'segment')).toBe(true);
  });

  it('encodes a valid WAV header', () => {
    const wav = encodeWav(new Int16Array([0, 1, -1]), 16000);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe('WAVE');
    expect(wav.length).toBe(44 + 6);
  });
});

vi.useRealTimers();

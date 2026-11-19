// Web Speech API controller shared by the Chrome extension (content script) and the
// VS Code microphone bridge page. Fixes the lifecycle bugs of the original engine:
//
//  * Duplicate finals — the silence timer could promote an interim result to final and
//    the engine would later deliver the real final for the same result index. Results
//    are now tracked per index; a promoted index is never committed twice.
//  * Restart races — Chrome ends recognition after silence/network blips and the old
//    code restarted from `onend` even mid-`stop()`, and events from a dead instance
//    could still arrive. Every instance gets a generation number; stale events are
//    ignored and restarts back off exponentially.
//  * Configurable language (en-US, hi-IN, te-IN, …) instead of a hard-coded en-US.
//  * Push-to-talk and continuous modes, with flush-on-release.

export type ListenMode = 'continuous' | 'push-to-talk';
export type SpeechState = 'idle' | 'starting' | 'listening' | 'stopping' | 'error';

export interface SpeechCallbacks {
  onInterim(text: string): void;
  onFinal(text: string, meta: { promoted: boolean; confidence?: number }): void;
  onState(state: SpeechState, detail?: string): void;
  onError(code: SpeechErrorCode, message: string): void;
}

export type SpeechErrorCode = 'unsupported' | 'not-allowed' | 'no-speech' | 'audio-capture' | 'network' | 'language-not-supported' | 'aborted' | 'unknown';

/** Minimal structural types so this module needs no DOM lib and is unit-testable. */
export interface RecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: { transcript: string; confidence: number };
}
export interface RecognitionEventLike {
  readonly resultIndex: number;
  readonly results: { readonly length: number; [index: number]: RecognitionResultLike };
}
export interface RecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((e: RecognitionEventLike) => void) | null;
  onerror: ((e: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export type RecognitionFactory = () => RecognitionLike | null;

export interface WebSpeechOptions {
  lang?: string;
  mode?: ListenMode;
  /** Promote a stable interim result to final after this much silence (continuous mode). */
  silenceMs?: number;
  /** Optional vocabulary hints; ignored by engines that do not support them. */
  maxRestartDelayMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
}

export function browserRecognitionFactory(): RecognitionFactory {
  return () => {
    const g = globalThis as unknown as { SpeechRecognition?: new () => RecognitionLike; webkitSpeechRecognition?: new () => RecognitionLike };
    const Ctor = g.SpeechRecognition ?? g.webkitSpeechRecognition;
    return Ctor ? new Ctor() : null;
  };
}

export class WebSpeechController {
  private rec: RecognitionLike | null = null;
  private generation = 0;
  private wanted = false;
  private state: SpeechState = 'idle';
  private silenceTimer: unknown = null;
  private restartTimer: unknown = null;
  private restartAttempts = 0;
  private noSpeechCount = 0;
  /** Result indexes (per generation) already committed as final. */
  private committed = new Set<number>();
  private pendingInterim: { index: number; text: string } | null = null;
  private lang: string;
  private mode: ListenMode;
  private readonly silenceMs: number;
  private readonly maxRestartDelayMs: number;
  private readonly st: (fn: () => void, ms: number) => unknown;
  private readonly ct: (h: unknown) => void;

  constructor(
    private readonly factory: RecognitionFactory,
    private readonly cb: SpeechCallbacks,
    opts: WebSpeechOptions = {},
  ) {
    this.lang = opts.lang ?? 'en-US';
    this.mode = opts.mode ?? 'continuous';
    this.silenceMs = opts.silenceMs ?? 1200;
    this.maxRestartDelayMs = opts.maxRestartDelayMs ?? 4000;
    this.st = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.ct = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get currentState(): SpeechState {
    return this.state;
  }

  setLanguage(lang: string): void {
    if (lang === this.lang) return;
    this.lang = lang;
    if (this.wanted) this.restartNow();
  }

  setMode(mode: ListenMode): void {
    this.mode = mode;
  }

  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.restartAttempts = 0;
    this.noSpeechCount = 0;
    this.spawn();
  }

  /** Stops listening. In push-to-talk mode the pending interim is committed first. */
  stop(opts: { flush?: boolean } = {}): void {
    const flush = opts.flush ?? this.mode === 'push-to-talk';
    if (flush) this.flushPending();
    this.wanted = false;
    this.clearTimers();
    this.setState('stopping');
    const rec = this.rec;
    this.rec = null;
    this.generation++; // invalidate any events still in flight from `rec`
    try {
      rec?.stop();
    } catch {
      // already stopped
    }
    this.pendingInterim = null;
    this.setState('idle');
  }

  /** Immediately commit whatever interim text is pending (e.g. push-to-talk release). */
  flushPending(): void {
    this.clearSilence();
    const p = this.pendingInterim;
    if (!p || !p.text.trim()) return;
    this.pendingInterim = null;
    this.committed.add(p.index);
    this.cb.onFinal(p.text.trim(), { promoted: true });
  }

  private spawn(): void {
    const rec = this.factory();
    if (!rec) {
      this.wanted = false;
      this.setState('error', 'unsupported');
      this.cb.onError('unsupported', 'Speech recognition is not available in this browser. Use Chrome or Edge.');
      return;
    }
    const gen = ++this.generation;
    this.committed = new Set();
    this.pendingInterim = null;
    this.rec = rec;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = this.lang;
    rec.maxAlternatives = 1;
    this.setState('starting');

    rec.onstart = () => {
      if (gen !== this.generation) return;
      this.restartAttempts = 0;
      this.setState('listening');
    };
    rec.onresult = (e) => {
      if (gen !== this.generation) return;
      this.handleResult(e);
    };
    rec.onerror = (e) => {
      if (gen !== this.generation) return;
      this.handleError(e.error);
    };
    rec.onend = () => {
      if (gen !== this.generation) return;
      // Chrome ends sessions on silence and network hiccups; restart while wanted.
      this.flushPending();
      this.rec = null;
      if (!this.wanted) {
        this.setState('idle');
        return;
      }
      const delay = Math.min(this.maxRestartDelayMs, this.restartAttempts === 0 ? 0 : 250 * 2 ** (this.restartAttempts - 1));
      this.restartAttempts++;
      this.restartTimer = this.st(() => {
        this.restartTimer = null;
        if (this.wanted && !this.rec) this.spawn();
      }, delay);
    };

    try {
      rec.start();
    } catch (err) {
      this.setState('error', 'start-failed');
      this.cb.onError('unknown', err instanceof Error ? err.message : 'Could not start speech recognition.');
    }
  }

  private handleResult(e: RecognitionEventLike): void {
    let interim = '';
    let interimIndex = -1;
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i]!;
      const alt = result[0];
      if (!alt) continue;
      if (result.isFinal) {
        if (this.committed.has(i)) continue; // already promoted from interim
        this.committed.add(i);
        if (this.pendingInterim?.index === i) {
          this.pendingInterim = null;
          this.clearSilence();
        }
        const text = alt.transcript.trim();
        if (text) {
          this.noSpeechCount = 0;
          this.cb.onFinal(text, { promoted: false, confidence: alt.confidence });
        }
      } else if (!this.committed.has(i)) {
        interim += alt.transcript;
        interimIndex = i;
      }
    }
    if (interim.trim()) {
      this.pendingInterim = { index: interimIndex, text: interim };
      this.cb.onInterim(interim.trim());
      if (this.mode === 'continuous') this.armSilence();
    }
  }

  private handleError(code: string): void {
    switch (code) {
      case 'no-speech':
        // Normal during pauses; only surface after repeated occurrences.
        if (++this.noSpeechCount >= 3) {
          this.noSpeechCount = 0;
          this.cb.onError('no-speech', 'No speech detected. Check that the right microphone is selected.');
        }
        return;
      case 'aborted':
        return;
      case 'not-allowed':
      case 'service-not-allowed':
        this.wanted = false;
        this.setState('error', 'not-allowed');
        this.cb.onError('not-allowed', 'Microphone access was denied. Allow the microphone for this page and try again.');
        return;
      case 'audio-capture':
        this.wanted = false;
        this.setState('error', 'audio-capture');
        this.cb.onError('audio-capture', 'No microphone was found.');
        return;
      case 'language-not-supported':
        this.wanted = false;
        this.setState('error', 'language-not-supported');
        this.cb.onError('language-not-supported', `Speech language ${this.lang} is not supported by this browser.`);
        return;
      case 'network':
        this.cb.onError('network', 'Speech service unreachable; retrying.');
        return; // onend will restart with backoff
      default:
        this.cb.onError('unknown', `Speech error: ${code}`);
    }
  }

  private armSilence(): void {
    this.clearSilence();
    this.silenceTimer = this.st(() => {
      this.silenceTimer = null;
      this.flushPending();
    }, this.silenceMs);
  }

  private clearSilence(): void {
    if (this.silenceTimer !== null) {
      this.ct(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearSilence();
    if (this.restartTimer !== null) {
      this.ct(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private restartNow(): void {
    const rec = this.rec;
    this.rec = null;
    this.generation++;
    this.clearTimers();
    try {
      rec?.abort();
    } catch {
      // ignore
    }
    this.spawn();
  }

  private setState(s: SpeechState, detail?: string): void {
    if (s === this.state && !detail) return;
    this.state = s;
    this.cb.onState(s, detail);
  }
}

/** Speech languages VoiceCoder exposes. Availability depends on the engine. */
export const SPEECH_LANGUAGES = [
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'en-IN', label: 'English (India)' },
  { code: 'hi-IN', label: 'हिन्दी (Hindi)' },
  { code: 'te-IN', label: 'తెలుగు (Telugu)' },
] as const;

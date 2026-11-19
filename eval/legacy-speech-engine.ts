// Faithful port of the ORIGINAL VoiceCoder speech engine (src/content/speech-engine.js at
// commit ff9a998), with timers injected so it can run on a virtual clock. Used only as the
// baseline in the duplicate-execution benchmark. Do not use in product code.

import type { RecognitionEventLike, RecognitionFactory, RecognitionLike } from '../packages/core/src/speech/web-speech.js';

export class LegacySpeechEngine {
  recognition: RecognitionLike | null = null;
  active = false;
  private silenceTimer: unknown = null;
  private currentTranscript = '';

  constructor(
    private readonly factory: RecognitionFactory,
    private readonly cb: { onInterim(t: string): void; onFinal(t: string): void },
    private readonly st: (fn: () => void, ms: number) => unknown,
    private readonly ct: (h: unknown) => void,
  ) {}

  start(): void {
    const rec = this.factory()!;
    this.recognition = rec;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onstart = () => {
      this.active = true;
    };
    rec.onresult = (event: RecognitionEventLike) => {
      let interimTranscript = '';
      let finalTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]!;
        if (result.isFinal) finalTranscript += result[0]!.transcript;
        else interimTranscript += result[0]!.transcript;
      }
      if (interimTranscript) {
        this.currentTranscript = interimTranscript;
        this.cb.onInterim(interimTranscript);
        this.resetSilenceTimer();
      }
      if (finalTranscript.trim()) {
        this.clearSilenceTimer();
        this.currentTranscript = '';
        this.cb.onFinal(finalTranscript.trim());
      }
    };
    rec.onend = () => {
      if (this.active) {
        try {
          rec.start();
        } catch {
          // already started
        }
      }
    };
    rec.start();
  }

  stop(): void {
    this.active = false;
    this.clearSilenceTimer();
    this.recognition?.stop();
    this.recognition = null;
  }

  flush(): void {
    this.clearSilenceTimer();
    const t = this.currentTranscript.trim();
    this.currentTranscript = '';
    if (t) this.cb.onFinal(t);
  }

  private resetSilenceTimer(): void {
    this.clearSilenceTimer();
    this.silenceTimer = this.st(() => {
      if (this.currentTranscript.trim()) {
        const t = this.currentTranscript.trim();
        this.currentTranscript = '';
        this.cb.onFinal(t);
      }
    }, 1500);
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) {
      this.ct(this.silenceTimer);
      this.silenceTimer = null;
    }
  }
}

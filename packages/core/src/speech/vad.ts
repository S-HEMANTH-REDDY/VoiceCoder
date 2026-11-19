// Energy-based voice activity detection over 16-bit PCM, used by the native microphone
// path (ffmpeg → PCM stream) for automatic speech detection. Adaptive noise floor makes
// it robust to fans/keyboards: speech must exceed the tracked floor by a margin.

export interface VadOptions {
  sampleRate?: number;
  frameMs?: number;
  /** Speech threshold as a multiple of the noise floor RMS. */
  ratio?: number;
  /** Absolute minimum RMS (0..1) to count as speech. */
  minRms?: number;
  /** Consecutive speech frames needed to open a segment. */
  startFrames?: number;
  /** Silence needed to close a segment. */
  hangoverMs?: number;
  /** Discard segments shorter than this (clicks, coughs). */
  minSpeechMs?: number;
  /** Force-close very long segments. */
  maxSegmentMs?: number;
  /** Audio kept before the detected start so first syllables are not clipped. */
  preRollMs?: number;
}

export type VadEvent =
  | { type: 'speech-start' }
  | { type: 'level'; rms: number; speaking: boolean }
  | { type: 'segment'; pcm: Int16Array; durationMs: number }
  | { type: 'discarded'; durationMs: number };

export class EnergyVad {
  private readonly frameSamples: number;
  private readonly o: Required<VadOptions>;
  private carry = new Int16Array(0);
  private noiseFloor = 0.004;
  private speaking = false;
  private speechRun = 0;
  private silenceMs = 0;
  private segment: Int16Array[] = [];
  private segmentMs = 0;
  private voicedMs = 0;
  private preRoll: Int16Array[] = [];

  constructor(opts: VadOptions = {}) {
    this.o = {
      sampleRate: 16000,
      frameMs: 30,
      ratio: 3,
      minRms: 0.012,
      startFrames: 3,
      hangoverMs: 700,
      minSpeechMs: 250,
      maxSegmentMs: 30_000,
      preRollMs: 300,
      ...opts,
    };
    this.frameSamples = Math.round((this.o.sampleRate * this.o.frameMs) / 1000);
  }

  /** Feed raw PCM (any chunk size). Returns events produced by complete frames. */
  push(chunk: Int16Array): VadEvent[] {
    const events: VadEvent[] = [];
    const data = concat(this.carry, chunk);
    let offset = 0;
    while (offset + this.frameSamples <= data.length) {
      const frame = data.slice(offset, offset + this.frameSamples);
      offset += this.frameSamples;
      this.processFrame(frame, events);
    }
    this.carry = data.slice(offset);
    return events;
  }

  /** Close any open segment (e.g. push-to-talk release). */
  flush(): VadEvent[] {
    const events: VadEvent[] = [];
    if (this.speaking) this.closeSegment(events);
    this.reset();
    return events;
  }

  reset(): void {
    this.carry = new Int16Array(0);
    this.speaking = false;
    this.speechRun = 0;
    this.silenceMs = 0;
    this.segment = [];
    this.segmentMs = 0;
    this.preRoll = [];
  }

  private processFrame(frame: Int16Array, events: VadEvent[]): void {
    const rms = frameRms(frame);
    const threshold = Math.max(this.o.minRms, this.noiseFloor * this.o.ratio);
    const isSpeech = rms >= threshold;
    events.push({ type: 'level', rms, speaking: this.speaking });

    if (!this.speaking) {
      // Track noise floor only while not speaking (slow attack, fast decay).
      this.noiseFloor = rms < this.noiseFloor ? this.noiseFloor * 0.9 + rms * 0.1 : this.noiseFloor * 0.995 + rms * 0.005;
      this.preRoll.push(frame);
      const maxPre = Math.ceil(this.o.preRollMs / this.o.frameMs);
      if (this.preRoll.length > maxPre) this.preRoll.shift();
      this.speechRun = isSpeech ? this.speechRun + 1 : 0;
      if (this.speechRun >= this.o.startFrames) {
        this.speaking = true;
        this.segment = [...this.preRoll];
        this.segmentMs = this.segment.length * this.o.frameMs;
        this.voicedMs = this.o.startFrames * this.o.frameMs;
        this.preRoll = [];
        this.silenceMs = 0;
        events.push({ type: 'speech-start' });
      }
      return;
    }

    this.segment.push(frame);
    this.segmentMs += this.o.frameMs;
    this.silenceMs = isSpeech ? 0 : this.silenceMs + this.o.frameMs;
    if (isSpeech) this.voicedMs += this.o.frameMs;
    if (this.silenceMs >= this.o.hangoverMs || this.segmentMs >= this.o.maxSegmentMs) {
      this.closeSegment(events);
    }
  }

  private closeSegment(events: VadEvent[]): void {
    const speechMs = this.voicedMs;
    this.voicedMs = 0;
    const pcm = concat(...this.segment);
    this.speaking = false;
    this.speechRun = 0;
    this.segment = [];
    this.segmentMs = 0;
    this.silenceMs = 0;
    if (speechMs < this.o.minSpeechMs) {
      events.push({ type: 'discarded', durationMs: speechMs });
      return;
    }
    events.push({ type: 'segment', pcm, durationMs: Math.round((pcm.length / this.o.sampleRate) * 1000) });
  }
}

export function frameRms(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i]! / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / frame.length);
}

function concat(...parts: Int16Array[]): Int16Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Int16Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Wraps mono 16-bit PCM in a WAV container for upload to transcription APIs. */
export function encodeWav(pcm: Int16Array, sampleRate = 16000): Uint8Array {
  const dataBytes = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

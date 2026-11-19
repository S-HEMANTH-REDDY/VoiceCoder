// Native microphone: ffmpeg captures 16 kHz mono PCM from the OS default input, the
// core EnergyVad detects utterances automatically, and each utterance is transcribed by
// the configured Transcriber. No browser involved; works in remote-less desktop VS Code.

import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'node:child_process';
import { EnergyVad, encodeWav, type Transcriber } from '@voicecoder/core';
import type { SpeechEvent, SpeechSource } from './types.js';

export function ffmpegInputArgs(platform: NodeJS.Platform, device: string): string[] {
  switch (platform) {
    case 'darwin':
      return ['-f', 'avfoundation', '-i', device || ':default'];
    case 'win32':
      return ['-f', 'dshow', '-i', device ? `audio=${device}` : 'audio=default'];
    default:
      return ['-f', 'pulse', '-i', device || 'default'];
  }
}

export class NativeMicSource implements SpeechSource {
  readonly id = 'native' as const;
  readonly label = 'Native microphone (ffmpeg)';
  private proc: ChildProcess | null = null;
  private vad = new EnergyVad();
  private readonly emitter = new vscode.EventEmitter<SpeechEvent>();
  private lang: string;
  private mode: 'continuous' | 'push-to-talk';
  private inflight = new Set<AbortController>();
  private lastLevelAt = 0;

  constructor(
    private readonly transcriber: () => Promise<Transcriber | null>,
    private readonly opts: { ffmpegPath: string; device: string; lang: string; mode: 'continuous' | 'push-to-talk' },
  ) {
    this.lang = opts.lang;
    this.mode = opts.mode;
  }

  onEvent(listener: (e: SpeechEvent) => void): vscode.Disposable {
    return this.emitter.event(listener);
  }

  async start(): Promise<void> {
    if (this.proc) return;
    const t = await this.transcriber();
    if (!t) {
      this.emitter.fire({ type: 'error', code: 'no-transcriber', message: 'The native microphone needs an OpenAI API key for transcription (VoiceCoder: Set API Key…).' });
      this.emitter.fire({ type: 'state', state: 'error' });
      return;
    }
    const args = ['-hide_banner', '-loglevel', 'error', ...ffmpegInputArgs(process.platform, this.opts.device), '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'];
    this.vad = new EnergyVad();
    const proc = spawn(this.opts.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    let stderr = '';
    let carry: Buffer = Buffer.alloc(0);
    this.emitter.fire({ type: 'state', state: 'connecting', detail: 'Starting microphone…' });

    proc.stdout!.on('data', (chunk: Buffer) => {
      if (this.proc !== proc) return;
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % 2);
      carry = buf.subarray(usable);
      const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + usable));
      for (const e of this.vad.push(pcm)) this.handleVad(e, t);
    });
    proc.stdout!.once('data', () => this.emitter.fire({ type: 'state', state: 'listening' }));
    proc.stderr!.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    proc.on('error', (err) => {
      this.proc = null;
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      this.emitter.fire({
        type: 'error',
        code: missing ? 'ffmpeg-missing' : 'ffmpeg-error',
        message: missing ? 'ffmpeg was not found. Install it (e.g. `brew install ffmpeg`) or set voicecoder.speech.ffmpegPath.' : err.message,
      });
      this.emitter.fire({ type: 'state', state: 'error' });
    });
    proc.on('close', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (code && code !== 255) {
        const denied = /permission|not authorized|denied/i.test(stderr);
        this.emitter.fire({
          type: 'error',
          code: denied ? 'not-allowed' : 'ffmpeg-exit',
          message: denied
            ? 'Microphone access was denied. Allow VS Code under System Settings → Privacy & Security → Microphone.'
            : `ffmpeg stopped (exit ${code}). ${stderr.split('\n').filter(Boolean).pop() ?? ''}`.trim(),
        });
      }
      this.emitter.fire({ type: 'state', state: 'idle' });
    });
  }

  private handleVad(e: ReturnType<EnergyVad['push']>[number], t: Transcriber): void {
    switch (e.type) {
      case 'level': {
        const now = Date.now();
        if (now - this.lastLevelAt > 60) {
          this.lastLevelAt = now;
          this.emitter.fire({ type: 'level', rms: Math.min(1, e.rms) });
        }
        return;
      }
      case 'speech-start':
        this.emitter.fire({ type: 'speech-start' });
        this.emitter.fire({ type: 'interim', text: '…' });
        return;
      case 'discarded':
        this.emitter.fire({ type: 'interim', text: '' });
        return;
      case 'segment':
        void this.transcribe(e.pcm, t);
    }
  }

  private async transcribe(pcm: Int16Array, t: Transcriber): Promise<void> {
    const ac = new AbortController();
    this.inflight.add(ac);
    this.emitter.fire({ type: 'interim', text: 'Transcribing…' });
    try {
      const res = await t.transcribe(encodeWav(pcm), { language: this.lang, signal: ac.signal });
      if (res.text) this.emitter.fire({ type: 'final', text: res.text, latencyMs: res.latencyMs });
      else this.emitter.fire({ type: 'interim', text: '' });
    } catch (err) {
      if (!ac.signal.aborted) this.emitter.fire({ type: 'error', code: 'transcription', message: err instanceof Error ? err.message : String(err) });
    } finally {
      this.inflight.delete(ac);
    }
  }

  stop(opts: { flush?: boolean } = {}): void {
    const proc = this.proc;
    this.proc = null;
    if (opts.flush ?? this.mode === 'push-to-talk') {
      void this.transcriber().then((t) => {
        if (!t) return;
        for (const e of this.vad.flush()) this.handleVad(e, t);
      });
    } else {
      this.vad.reset();
    }
    proc?.kill('SIGTERM');
    this.emitter.fire({ type: 'state', state: 'idle' });
  }

  setLanguage(lang: string): void {
    this.lang = lang;
  }

  setMode(mode: 'continuous' | 'push-to-talk'): void {
    this.mode = mode;
  }

  dispose(): void {
    this.stop({ flush: false });
    for (const ac of this.inflight) ac.abort();
    this.emitter.dispose();
  }
}

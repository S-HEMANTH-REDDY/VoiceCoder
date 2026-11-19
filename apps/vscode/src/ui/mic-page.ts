// Runs in the developer's browser, served by BrowserSpeechBridge over loopback.
// Uses the shared WebSpeechController (duplicate-safe, race-safe) and streams events
// back to VS Code. Audio never leaves the browser except to the browser's own speech
// service; this page only forwards text and a level meter value.

import { WebSpeechController, browserRecognitionFactory, type ListenMode } from '@voicecoder/core/speech/web-speech';

const base = location.pathname.replace(/\/mic$/, '');
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const card = $('card');
const stateEl = $('state');
const transcriptEl = $('transcript');
const lastEl = $('last');
const msgEl = $('msg');
const toggle = $<HTMLButtonElement>('toggle');
const hint = $('hint');
const canvas = $<HTMLCanvasElement>('wave');

let mode: ListenMode = 'continuous';
let listening = false;

function post(event: object): void {
  void fetch(`${base}/event`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event), keepalive: true }).catch(() => {});
}

const speech = new WebSpeechController(
  browserRecognitionFactory(),
  {
    onInterim(text) {
      transcriptEl.innerHTML = '';
      const span = document.createElement('span');
      span.className = 'interim';
      span.textContent = text;
      transcriptEl.append(span);
      post({ type: 'interim', text: text.slice(0, 2000) });
    },
    onFinal(text, meta) {
      transcriptEl.textContent = text;
      lastEl.textContent = 'Sent to VS Code';
      post({ type: 'final', text: text.slice(0, 2000), promoted: meta.promoted });
    },
    onState(state, detail) {
      listening = state === 'listening' || state === 'starting';
      card.className = `card ${state === 'listening' ? 'listening' : state === 'error' ? 'error' : ''}`;
      stateEl.textContent = state === 'listening' ? 'Listening' : state === 'starting' ? 'Starting…' : state === 'error' ? 'Microphone unavailable' : 'Paused';
      toggle.textContent = listening ? 'Stop' : 'Start listening';
      if (state === 'listening' || state === 'idle' || state === 'error') post({ type: 'state', state: state === 'listening' ? 'listening' : state, detail });
      if (state === 'listening') void startMeter();
      if (state === 'idle') stopMeter();
    },
    onError(code, message) {
      msgEl.textContent = message;
      post({ type: 'error', code, message: message.slice(0, 300) });
    },
  },
  { lang: 'en-US', mode },
);

// ── Level meter / waveform ───────────────────────────────────────────────────
let audioCtx: AudioContext | null = null;
let stream: MediaStream | null = null;
let raf = 0;
const history: number[] = new Array(96).fill(0);

async function startMeter(): Promise<void> {
  if (audioCtx) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    audioCtx = new AudioContext();
    const src = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    let lastPost = 0;
    const tick = (t: number) => {
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += v * v;
      const rms = Math.sqrt(sum / data.length);
      history.push(rms);
      history.shift();
      draw();
      if (t - lastPost > 80) {
        lastPost = t;
        post({ type: 'level', rms: Math.min(1, rms) });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  } catch {
    // The waveform is optional; recognition works without it.
  }
}

function stopMeter(): void {
  cancelAnimationFrame(raf);
  stream?.getTracks().forEach((t) => t.stop());
  void audioCtx?.close();
  audioCtx = null;
  stream = null;
  history.fill(0);
  draw();
}

function draw(): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  const styles = getComputedStyle(document.documentElement);
  ctx.fillStyle = listening ? styles.getPropertyValue('--accent').trim() : styles.getPropertyValue('--muted').trim();
  const bar = width / history.length;
  history.forEach((v, i) => {
    const h = Math.max(4, Math.min(height, Math.sqrt(v) * height * 2.2));
    ctx.fillRect(i * bar + bar * 0.25, (height - h) / 2, bar * 0.5, h);
  });
}
draw();

// ── Control channel from VS Code ─────────────────────────────────────────────
const events = new EventSource(`${base}/events`);
events.onopen = () => {
  msgEl.textContent = '';
  if (!listening) stateEl.textContent = 'Connected to VS Code';
};
events.onerror = () => {
  stateEl.textContent = 'VS Code disconnected';
};
events.onmessage = (m) => {
  let cmd: { type: string; lang?: string; mode?: ListenMode; flush?: boolean };
  try {
    cmd = JSON.parse(m.data);
  } catch {
    return;
  }
  if (cmd.lang) speech.setLanguage(cmd.lang);
  if (cmd.mode) {
    mode = cmd.mode;
    speech.setMode(mode);
    hint.innerHTML = mode === 'push-to-talk' ? 'Push-to-talk: hold <kbd>Space</kbd> here, or toggle <kbd>⌥ Space</kbd> in VS Code.' : 'Keep this tab open while you work in VS Code.';
  }
  if (cmd.type === 'start') speech.start();
  if (cmd.type === 'stop') speech.stop({ flush: cmd.flush });
};

toggle.addEventListener('click', () => {
  if (listening) speech.stop({ flush: mode === 'push-to-talk' });
  else speech.start();
});

// Push-to-talk on this page: hold Space.
let spaceHeld = false;
addEventListener('keydown', (e) => {
  if (mode !== 'push-to-talk' || e.code !== 'Space' || e.repeat || spaceHeld) return;
  e.preventDefault();
  spaceHeld = true;
  speech.start();
});
addEventListener('keyup', (e) => {
  if (mode !== 'push-to-talk' || e.code !== 'Space') return;
  e.preventDefault();
  spaceHeld = false;
  speech.stop({ flush: true });
});
addEventListener('pagehide', () => post({ type: 'state', state: 'idle', detail: 'Microphone page closed' }));

// Browser microphone bridge.
//
// Why: VS Code webviews cannot capture the microphone (no media permission handler in the
// webview host), and the extension host has no audio APIs. The most reliable real-time
// option without native binaries is to run speech recognition in the developer's
// browser and stream results back over loopback.
//
// Security model:
//   * Binds to 127.0.0.1 only, on a random port.
//   * Every URL carries a 256-bit random token; requests without it get 404.
//   * The Host header must be exactly 127.0.0.1:<port> (defeats DNS rebinding), and POSTs
//     must come from the page's own origin.
//   * Events are size-limited, schema-checked JSON. Transcripts are never logged.

import * as vscode from 'vscode';
import * as http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { SpeechEvent, SpeechSource } from './types.js';

type PageCommand = { type: 'start'; lang: string; mode: string } | { type: 'stop'; flush: boolean } | { type: 'config'; lang: string; mode: string };

export class BrowserSpeechBridge implements SpeechSource {
  readonly id = 'browser' as const;
  readonly label = 'Browser microphone';
  private server: http.Server | null = null;
  private port = 0;
  private readonly token = randomBytes(32).toString('hex');
  private clients = new Set<http.ServerResponse>();
  private readonly emitter = new vscode.EventEmitter<SpeechEvent>();
  private wantListening = false;
  private lang: string;
  private mode: string;
  private openedAt = 0;

  constructor(
    private readonly pageHtml: () => Promise<string>,
    private readonly pageScript: () => Promise<string>,
    opts: { lang: string; mode: string },
  ) {
    this.lang = opts.lang;
    this.mode = opts.mode;
  }

  onEvent(listener: (e: SpeechEvent) => void): vscode.Disposable {
    return this.emitter.event(listener);
  }

  get connected(): boolean {
    return this.clients.size > 0;
  }

  async start(): Promise<void> {
    this.wantListening = true;
    await this.ensureServer();
    if (this.connected) {
      this.broadcast({ type: 'start', lang: this.lang, mode: this.mode });
      return;
    }
    this.emitter.fire({ type: 'state', state: 'connecting', detail: 'Opening the VoiceCoder microphone page in your browser…' });
    // Avoid opening a second tab if the page is still loading.
    if (Date.now() - this.openedAt > 8000) {
      this.openedAt = Date.now();
      const ok = await vscode.env.openExternal(vscode.Uri.parse(this.pageUrl()));
      if (!ok) {
        this.emitter.fire({ type: 'error', code: 'open-failed', message: 'Could not open the browser microphone page.' });
        this.emitter.fire({ type: 'state', state: 'error' });
      }
    }
  }

  stop(opts: { flush?: boolean } = {}): void {
    this.wantListening = false;
    this.broadcast({ type: 'stop', flush: opts.flush ?? this.mode === 'push-to-talk' });
    this.emitter.fire({ type: 'state', state: 'idle' });
  }

  setLanguage(lang: string): void {
    this.lang = lang;
    this.broadcast({ type: 'config', lang: this.lang, mode: this.mode });
  }

  setMode(mode: 'continuous' | 'push-to-talk'): void {
    this.mode = mode;
    this.broadcast({ type: 'config', lang: this.lang, mode: this.mode });
  }

  pageUrl(): string {
    return `http://127.0.0.1:${this.port}/${this.token}/mic`;
  }

  private broadcast(cmd: PageCommand): void {
    const payload = `data: ${JSON.stringify(cmd)}\n\n`;
    for (const c of this.clients) c.write(payload);
  }

  private async ensureServer(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const deny = (code = 404) => {
      res.writeHead(code).end();
    };
    if (req.headers.host !== `127.0.0.1:${this.port}`) return deny(421);
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    const [token, route] = url.pathname.split('/').filter(Boolean);
    if (token !== this.token) return deny();

    const security = {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
    };

    if (req.method === 'GET' && route === 'mic') {
      res.writeHead(200, {
        ...security,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'Permissions-Policy': 'microphone=(self)',
      });
      res.end(await this.pageHtml());
      return;
    }
    if (req.method === 'GET' && route === 'mic.js') {
      res.writeHead(200, { ...security, 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(await this.pageScript());
      return;
    }
    if (req.method === 'GET' && route === 'events') {
      res.writeHead(200, { ...security, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      res.write(`retry: 1500\n\n`);
      this.clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ping);
        this.clients.delete(res);
        if (this.clients.size === 0) {
          this.emitter.fire({ type: 'state', state: 'idle', detail: 'Microphone page closed' });
        }
      });
      // Bring the new page up to date.
      res.write(`data: ${JSON.stringify(this.wantListening ? { type: 'start', lang: this.lang, mode: this.mode } : { type: 'config', lang: this.lang, mode: this.mode })}\n\n`);
      return;
    }
    if (req.method === 'POST' && route === 'event') {
      if (req.headers.origin !== `http://127.0.0.1:${this.port}`) return deny(403);
      let body = '';
      let tooBig = false;
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
        if (body.length > 16_384) {
          tooBig = true;
          req.destroy();
        }
      });
      req.on('end', () => {
        if (tooBig) return;
        const event = parseEvent(body);
        if (!event) return deny(400);
        res.writeHead(204, security).end();
        if (event.type === 'state' && event.state === 'idle' && this.wantListening) {
          // The page stopped on its own (e.g. user clicked stop there): mirror it.
          this.wantListening = false;
        }
        if (event.type === 'state' && event.state === 'listening') this.wantListening = true;
        this.emitter.fire(event);
      });
      return;
    }
    deny();
  }

  dispose(): void {
    this.broadcast({ type: 'stop', flush: false });
    for (const c of this.clients) c.end();
    this.clients.clear();
    this.server?.close();
    this.server = null;
    this.emitter.dispose();
  }
}

/** Strictly validates events coming from the page. */
export function parseEvent(body: string): SpeechEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const str = (v: unknown, max = 2000) => (typeof v === 'string' && v.length <= max ? v : null);
  switch (e.type) {
    case 'interim': {
      const text = str(e.text);
      return text === null ? null : { type: 'interim', text };
    }
    case 'final': {
      const text = str(e.text);
      return text === null ? null : { type: 'final', text, promoted: e.promoted === true };
    }
    case 'level':
      return typeof e.rms === 'number' && e.rms >= 0 && e.rms <= 1 ? { type: 'level', rms: e.rms } : null;
    case 'speech-start':
      return { type: 'speech-start' };
    case 'state':
      return e.state === 'idle' || e.state === 'listening' || e.state === 'error' || e.state === 'connecting'
        ? { type: 'state', state: e.state, detail: str(e.detail, 300) ?? undefined }
        : null;
    case 'error': {
      const code = str(e.code, 64);
      const message = str(e.message, 300);
      return code && message ? { type: 'error', code, message } : null;
    }
    default:
      return null;
  }
}

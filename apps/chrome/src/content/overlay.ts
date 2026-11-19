// Floating voice assistant, rendered in a closed shadow root so page CSS cannot break it
// and page scripts cannot read its contents. Minimal by design: a pill that expands to
// show live transcript, streaming preview and the result.

export type OverlayState = 'listening' | 'thinking' | 'done' | 'error' | 'idle';

const CSS = `
:host { all: initial; }
.wrap { position: fixed; z-index: 2147483647; right: 18px; bottom: 18px; width: min(380px, calc(100vw - 36px));
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; color: #ececef;
  background: rgba(20,20,23,.96); border: 1px solid rgba(255,255,255,.09); border-radius: 12px;
  box-shadow: 0 10px 40px rgba(0,0,0,.35); overflow: hidden; transition: opacity .15s, transform .15s; }
.wrap.hidden { opacity: 0; transform: translateY(6px); pointer-events: none; }
.bar { display: flex; align-items: center; gap: 10px; padding: 10px 12px; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: #8b8b94; flex: none; }
.listening .dot { background: #ff6a50; box-shadow: 0 0 0 4px rgba(255,106,80,.18); }
.thinking .dot { background: #ff6a50; animation: p 1s ease-in-out infinite; }
.done .dot { background: #3ccf91; }
.error .dot { background: #e3a33a; }
@keyframes p { 50% { opacity: .3; } }
@media (prefers-reduced-motion: reduce) { .thinking .dot { animation: none; } }
.label { font-weight: 600; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chip { font-size: 10.5px; color: #8b8b94; border: 1px solid rgba(255,255,255,.12); border-radius: 999px; padding: 0 7px; }
button { all: unset; cursor: pointer; color: #8b8b94; padding: 2px 6px; border-radius: 5px; font-size: 12px; }
button:hover { color: #ececef; background: rgba(255,255,255,.07); }
button:focus-visible { outline: 1px solid #ff6a50; }
.body { padding: 0 12px 10px; display: none; }
.body.show { display: block; }
.transcript { color: #a9a9b2; font-style: italic; overflow-wrap: anywhere; }
.message { margin-top: 6px; overflow-wrap: anywhere; white-space: pre-wrap; }
pre { margin: 8px 0 0; padding: 8px 10px; background: rgba(255,255,255,.05); border-left: 2px solid #ff6a50; border-radius: 6px;
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; max-height: 180px; overflow: auto; white-space: pre; color: #dcdce2; }
pre:empty { display: none; }
.actions { display: flex; gap: 6px; margin-top: 8px; }
.actions:empty { display: none; }
@media (prefers-color-scheme: light) {
  .wrap { background: rgba(255,255,255,.98); color: #17171a; border-color: #e6e4df; box-shadow: 0 10px 40px rgba(0,0,0,.12); }
  .transcript { color: #6b6b73; }
  pre { background: #f6f5f2; color: #17171a; }
  button:hover { color: #17171a; background: #f0efeb; }
  .chip { border-color: #e6e4df; color: #6b6b73; }
}
`;

export class Overlay {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private els: Record<string, HTMLElement> = {};
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly handlers: { onClose(): void; onUndo(): void }) {}

  private ensure(): void {
    if (this.host?.isConnected) return;
    this.host = document.createElement('div');
    this.host.id = 'voicecoder-overlay-host';
    this.root = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const wrap = document.createElement('div');
    wrap.className = 'wrap hidden';
    wrap.setAttribute('role', 'status');
    wrap.setAttribute('aria-live', 'polite');
    wrap.innerHTML = `<div class="bar"><span class="dot"></span><span class="label"></span><span class="chip"></span><button class="close" title="Stop VoiceCoder (Alt+Space)" aria-label="Stop VoiceCoder">✕</button></div>
      <div class="body"><div class="transcript"></div><div class="message"></div><pre></pre><div class="actions"></div></div>`;
    this.root.append(style, wrap);
    document.documentElement.append(this.host);
    const q = (s: string) => wrap.querySelector(s) as HTMLElement;
    this.els = { wrap, label: q('.label'), chip: q('.chip'), body: q('.body'), transcript: q('.transcript'), message: q('.message'), pre: q('pre'), actions: q('.actions') };
    q('.close').addEventListener('click', () => this.handlers.onClose());
    // Keep the page editor focused: clicks on the overlay must not steal focus.
    wrap.addEventListener('mousedown', (e) => e.preventDefault());
  }

  show(state: OverlayState, label: string, opts: { transcript?: string; message?: string; chip?: string; preview?: string; undo?: boolean } = {}): void {
    this.ensure();
    if (this.hideTimer) clearTimeout(this.hideTimer);
    const e = this.els;
    e.wrap!.className = `wrap ${state}`;
    e.label!.textContent = label;
    e.chip!.textContent = opts.chip ?? '';
    e.chip!.style.display = opts.chip ? '' : 'none';
    e.transcript!.textContent = opts.transcript ? `“${opts.transcript}”` : '';
    e.message!.textContent = opts.message ?? '';
    e.pre!.textContent = opts.preview ? opts.preview.split('\n').slice(-12).join('\n') : '';
    e.actions!.replaceChildren();
    if (opts.undo) {
      const b = document.createElement('button');
      b.textContent = 'Undo';
      b.addEventListener('click', () => this.handlers.onUndo());
      e.actions!.append(b);
    }
    e.body!.classList.toggle('show', !!(opts.transcript || opts.message || opts.preview || opts.undo));
  }

  preview(text: string): void {
    if (this.els.pre) {
      this.els.pre.textContent = text.split('\n').slice(-12).join('\n');
      this.els.body?.classList.add('show');
    }
  }

  interim(text: string): void {
    if (!this.els.transcript) return;
    this.els.transcript.textContent = text ? `${text}…` : '';
    this.els.body?.classList.toggle('show', !!text || !!this.els.message?.textContent);
  }

  hide(afterMs = 0): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.els.wrap?.classList.add('hidden'), afterMs);
  }

  destroy(): void {
    this.host?.remove();
    this.host = null;
    this.root = null;
    this.els = {};
  }
}

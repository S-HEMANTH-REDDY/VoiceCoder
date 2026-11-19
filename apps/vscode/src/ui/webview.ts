// Assistant panel (runs inside the VS Code webview). Vanilla DOM, no framework: the
// state is small, updates are coalesced by the host, and this keeps the bundle ~15 KB.

import type { AgentView, ApprovalView, CommandView, HostMessage, UiState, WebviewMessage } from './protocol.js';

declare function acquireVsCodeApi(): { postMessage(m: WebviewMessage): void; getState<T>(): T | undefined; setState<T>(s: T): void };
const vscode = acquireVsCodeApi();
const send = (m: WebviewMessage) => vscode.postMessage(m);

type Tab = 'history' | 'performance' | 'settings';
const persisted = vscode.getState<{ tab?: Tab }>() ?? {};
let tab: Tab = persisted.tab ?? 'history';
let state: UiState | null = null;
let preview: { id: string; text: string } | null = null;
let interim = '';
const levels: number[] = new Array(48).fill(0);

// ── tiny DOM helpers ─────────────────────────────────────────────────────────
type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[] | Child[][]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of (children as Child[]).flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(c));
  return el;
}

const ICONS: Record<string, string> = {
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-7 9a7 7 0 0 0 14 0M12 19v3',
  stop: 'M7 7h10v10H7z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6L6 18',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  send: 'M5 12h14M13 6l6 6-6 6',
  dot: 'M12 12h.01',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6',
};
function icon(name: string, size = 14): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name] ?? '');
  svg.append(p);
  return svg;
}

/** Minimal, safe markdown: paragraphs, **bold**, `code`, ``` blocks, bullet lists. */
function markdown(src: string): HTMLElement {
  const root = h('div', { class: 'md' });
  const blocks = src.split(/```/);
  blocks.forEach((block, i) => {
    if (i % 2 === 1) {
      root.append(h('pre', { class: 'code' }, block.replace(/^\w*\n/, '').replace(/\n$/, '')));
      return;
    }
    for (const para of block.split(/\n{2,}/)) {
      const lines = para.split('\n').filter((l) => l.trim());
      if (!lines.length) continue;
      if (lines.every((l) => /^\s*[-*•]\s/.test(l))) {
        root.append(h('ul', {}, lines.map((l) => h('li', {}, ...inline(l.replace(/^\s*[-*•]\s/, ''))))));
      } else {
        root.append(h('p', {}, ...inline(lines.join(' '))));
      }
    }
  });
  return root;
}
function inline(text: string): Node[] {
  const out: Node[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    const t = m[0];
    out.push(t.startsWith('**') ? h('strong', {}, t.slice(2, -2)) : h('code', {}, t.slice(1, -1)));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

// ── Static shell ─────────────────────────────────────────────────────────────
const app = document.getElementById('app')!;
const micBtn = h('button', { class: 'mic', title: 'Toggle listening (⌥Space)', 'aria-label': 'Toggle listening', onclick: () => send({ type: 'toggle-listening' }) });
const phaseLabel = h('div', { class: 'phase-label' });
const phaseDetail = h('div', { class: 'phase-detail' });
const wave = h('canvas', { class: 'wave', width: 192, height: 40, 'aria-hidden': 'true' });
const interimEl = h('div', { class: 'interim', 'aria-live': 'polite' });
const main = h('div', { class: 'main' });
const tabsEl = h('div', { class: 'tabs', role: 'tablist' });
const tabBody = h('div', { class: 'tab-body' });
const input = h('input', {
  class: 'command-input',
  type: 'text',
  placeholder: 'Type a command — or just speak',
  'aria-label': 'Type a command',
  maxlength: 2000,
}) as HTMLInputElement;
const form = h(
  'form',
  {
    class: 'composer',
    onsubmit: (e: Event) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      send({ type: 'submit', text });
      input.value = '';
    },
  },
  input,
  h('button', { class: 'icon-btn', type: 'submit', title: 'Run command', 'aria-label': 'Run command' }, icon('send')),
);

app.append(
  h('header', { class: 'voicebar' }, micBtn, h('div', { class: 'phase' }, phaseLabel, phaseDetail), wave),
  interimEl,
  main,
  tabsEl,
  tabBody,
  form,
);

// ── Rendering ────────────────────────────────────────────────────────────────
const PHASE_TEXT: Record<UiState['phase'], string> = {
  idle: 'Ready',
  connecting: 'Connecting microphone',
  listening: 'Listening',
  thinking: 'Thinking',
  applying: 'Applying',
  review: 'Review the change',
  'awaiting-approval': 'Waiting for your approval',
  running: 'Running',
  error: 'Needs attention',
};

function render(): void {
  if (!state) return;
  const s = state;
  document.body.dataset.phase = s.phase;
  micBtn.replaceChildren(icon(s.listening ? 'stop' : 'mic', 16));
  micBtn.classList.toggle('on', s.listening);
  micBtn.setAttribute('aria-pressed', String(s.listening));
  phaseLabel.textContent = PHASE_TEXT[s.phase];
  phaseDetail.textContent =
    s.phaseDetail ?? (s.listening ? `${s.speechLabel} · ${s.language} · ${s.mode === 'push-to-talk' ? 'push-to-talk' : 'continuous'}` : 'Press ⌥Space or click the mic');
  renderInterim();

  const blocks: Node[] = [];
  if (!s.hasKey) blocks.push(onboarding(s));
  if (!s.trusted) blocks.push(h('div', { class: 'notice' }, 'Untrusted workspace: commands, test runs, git writes and the agent are disabled.'));
  if (s.approval) blocks.push(approvalCard(s.approval));
  if (s.agent && (s.agent.status !== 'done' || s.current?.intent === 'agent')) blocks.push(agentCard(s.agent));
  if (s.current) blocks.push(commandCard(s.current, s));
  if (!s.current && s.hasKey && !s.approval) blocks.push(emptyState());
  main.replaceChildren(...blocks);

  tabsEl.replaceChildren(
    ...(['history', 'performance', 'settings'] as Tab[]).map((t) =>
      h(
        'button',
        {
          class: `tab ${t === tab ? 'active' : ''}`,
          role: 'tab',
          'aria-selected': String(t === tab),
          onclick: () => {
            tab = t;
            vscode.setState({ tab });
            render();
          },
        },
        t === 'history' ? `History${s.history.length ? ` · ${s.history.length}` : ''}` : t === 'performance' ? 'Performance' : 'Settings',
      ),
    ),
  );
  tabBody.replaceChildren(tab === 'history' ? historyView(s) : tab === 'performance' ? perfView(s) : settingsView(s));
}

function renderInterim(): void {
  interimEl.textContent = interim;
  interimEl.classList.toggle('visible', !!interim);
}

function chip(text: string, cls = ''): HTMLElement {
  return h('span', { class: `chip ${cls}` }, text);
}

function commandCard(c: CommandView, s: UiState): HTMLElement {
  const meta = h(
    'div',
    { class: 'meta' },
    c.intent ? chip(c.intent) : null,
    c.source ? chip(c.source === 'local' ? 'local' : c.source === 'llm' ? 'model' : 'offline', `src-${c.source}`) : null,
    c.latencyMs !== undefined ? h('span', { class: 'latency' }, `${c.latencyMs} ms`) : null,
  );
  const card = h(
    'section',
    { class: `card command status-${c.status}`, 'aria-label': 'Current command' },
    h('div', { class: 'transcript' }, `“${c.transcript}”`),
    h('div', { class: 'title-row' }, h('span', { class: `status-dot ${c.status}` }), h('h2', {}, c.title)),
    meta,
    c.message ? h('p', { class: 'message' }, c.message) : null,
  );
  if (c.body) card.append(markdown(c.body));
  const live = preview && preview.id === c.id && c.status === 'running' ? preview.text : '';
  if (live) card.append(h('pre', { class: 'code streaming' }, live.split('\n').slice(-18).join('\n')));
  if (c.diff?.length) card.append(diffView(c));
  if (c.status === 'review' && s.hasPendingChange) {
    card.append(
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn primary', onclick: () => send({ type: 'accept' }) }, icon('check'), 'Accept'),
        h('button', { class: 'btn', onclick: () => send({ type: 'reject' }) }, icon('x'), 'Reject'),
        h('span', { class: 'hint' }, 'or say “accept” / “reject”'),
      ),
    );
  } else if (c.status === 'running') {
    card.append(h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => send({ type: 'cancel' }) }, 'Cancel'), h('span', { class: 'hint' }, 'Esc or say “cancel”')));
  } else if (c.status === 'done' && c.diff?.length) {
    card.append(h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => send({ type: 'undo' }) }, icon('undo'), 'Undo')));
  }
  return card;
}

function diffView(c: CommandView): HTMLElement {
  const lines = c.diff!;
  const wrap = h('div', { class: 'diff', role: 'figure', 'aria-label': 'Code changes' });
  if (c.stats) wrap.append(h('div', { class: 'diff-head' }, c.file ? h('span', { class: 'file' }, c.file) : null, h('span', { class: 'add' }, `+${c.stats.added}`), h('span', { class: 'del' }, `−${c.stats.removed}`)));
  let prev: number | undefined;
  for (const d of lines.slice(0, 160)) {
    const n = d.newLine ?? d.oldLine;
    if (prev !== undefined && n !== undefined && n > prev + 1 && d.type === 'context') wrap.append(h('div', { class: 'gap' }, '⋯'));
    if (n !== undefined) prev = n;
    wrap.append(
      h(
        'div',
        {
          class: `dl ${d.type}`,
          onclick: d.newLine && c.file ? () => send({ type: 'open-file', file: c.file!, line: d.newLine }) : undefined,
        },
        h('span', { class: 'ln' }, String(d.type === 'remove' ? (d.oldLine ?? '') : (d.newLine ?? ''))),
        h('span', { class: 'sign' }, d.type === 'add' ? '+' : d.type === 'remove' ? '−' : ' '),
        h('span', { class: 'txt' }, d.text || ' '),
      ),
    );
  }
  if (lines.length > 160) wrap.append(h('div', { class: 'gap' }, `${lines.length - 160} more lines`));
  return wrap;
}

function approvalCard(a: ApprovalView): HTMLElement {
  return h(
    'section',
    { class: `card approval sev-${a.severity}`, role: 'alertdialog', 'aria-label': 'Approval required' },
    h('div', { class: 'eyebrow' }, 'Approval required'),
    h('h2', {}, a.title),
    a.detail ? h('p', { class: 'message' }, a.detail) : null,
    a.subject ? h('pre', { class: 'code subject' }, a.subject) : null,
    a.labels.length ? h('div', { class: 'labels' }, a.labels.map((l) => chip(l, 'risk'))) : null,
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn primary', onclick: () => send({ type: 'approve', id: a.id, ok: true }) }, icon('check'), a.approveLabel ?? 'Approve'),
      h('button', { class: 'btn', onclick: () => send({ type: 'approve', id: a.id, ok: false }) }, 'Deny'),
      h('span', { class: 'hint' }, 'or say “approve” / “deny”'),
    ),
  );
}

function agentCard(a: AgentView): HTMLElement {
  const statusText = { planning: 'Planning…', 'awaiting-plan-approval': 'Plan ready', running: 'Working', done: 'Done', failed: 'Stopped', cancelled: 'Cancelled' }[a.status];
  const card = h('section', { class: 'card agent', 'aria-label': 'Agent progress' }, h('div', { class: 'eyebrow' }, `Agent · ${statusText}`), h('h2', {}, a.goal));
  if (a.plan.length) {
    card.append(
      h(
        'ol',
        { class: 'plan' },
        a.plan.map((p) => h('li', {}, h('span', { class: 'plan-title' }, p.title), h('span', { class: 'plan-detail' }, p.detail))),
      ),
    );
  }
  if (a.steps.length) {
    card.append(
      h(
        'ul',
        { class: 'steps' },
        a.steps.slice(-12).map((s) =>
          h(
            'li',
            { class: `step ${s.status}` },
            h('span', { class: `status-dot ${s.status === 'ok' ? 'done' : s.status === 'failed' ? 'error' : s.status === 'awaiting-approval' ? 'review' : 'running'}` }),
            h('span', { class: 'step-desc' }, s.description),
            h('span', { class: 'step-sum' }, s.summary ? `${s.summary}${s.durationMs ? ` · ${(s.durationMs / 1000).toFixed(1)}s` : ''}` : ''),
          ),
        ),
      ),
    );
  }
  if (a.report && (a.status === 'done' || a.status === 'failed')) card.append(markdown(a.report));
  if (a.status === 'running' || a.status === 'planning') card.append(h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => send({ type: 'cancel' }) }, 'Stop agent')));
  return card;
}

function onboarding(s: UiState): HTMLElement {
  return h(
    'section',
    { class: 'card onboarding' },
    h('div', { class: 'eyebrow' }, 'Welcome to VoiceCoder'),
    h('h2', {}, 'Speak intentions, not keystrokes.'),
    h(
      'ol',
      { class: 'onboard-steps' },
      h('li', {}, h('strong', {}, 'Connect a model. '), `VoiceCoder uses ${s.provider} to understand open-ended requests and write code. Your key stays in VS Code Secret Storage.`, h('div', {}, h('button', { class: 'btn primary small', onclick: () => send({ type: 'set-key' }) }, 'Set API key'))),
      h('li', {}, h('strong', {}, 'Turn on the mic. '), 'Press ⌥Space. The microphone page opens in your browser once; allow access.', h('div', {}, h('button', { class: 'btn small', onclick: () => send({ type: 'toggle-listening' }) }, icon('mic'), 'Start listening'))),
      h('li', {}, h('strong', {}, 'Talk. '), 'Navigation, undo, accept and git status work instantly without a key — try “go to line 20”.'),
    ),
  );
}

function emptyState(): HTMLElement {
  const examples = ['create a function that validates an email', 'make it return the reason', 'add unit tests for it', 'run the tests', 'go to line 42', 'explain this function', 'generate a commit message', 'undo'];
  return h(
    'section',
    { class: 'card empty' },
    h('div', { class: 'eyebrow' }, 'Try saying'),
    h(
      'div',
      { class: 'examples' },
      examples.map((e) => h('button', { class: 'example', title: 'Run this command', onclick: () => send({ type: 'submit', text: e }) }, `“${e}”`)),
    ),
  );
}

function historyView(s: UiState): HTMLElement {
  if (!s.history.length) return h('div', { class: 'muted pad' }, 'Commands you speak appear here.');
  return h(
    'ul',
    { class: 'history' },
    s.history.map((c) =>
      h(
        'li',
        { title: c.message ?? c.title },
        h('span', { class: `status-dot ${c.status}` }),
        h('span', { class: 'h-text' }, c.transcript),
        c.intent ? chip(c.intent) : null,
        h('span', { class: 'latency' }, c.latencyMs !== undefined ? `${c.latencyMs} ms` : ''),
      ),
    ),
  );
}

function perfView(s: UiState): HTMLElement {
  const c = s.counters;
  const total = c['commands.total'] ?? 0;
  const local = c['intent.source.local'] ?? 0;
  const llm = c['intent.source.llm'] ?? 0;
  const heur = c['intent.source.heuristic'] ?? 0;
  const pct = (n: number) => (total ? `${Math.round((n / total) * 100)}%` : '—');
  const tiles = h(
    'div',
    { class: 'tiles' },
    tile('Commands', String(total)),
    tile('Succeeded', String(c['commands.ok'] ?? 0)),
    tile('Local (no model)', pct(local)),
    tile('Duplicates blocked', String((c['speech.duplicates-suppressed'] ?? 0) + (c['commands.duplicates-dropped'] ?? 0))),
    tile('Tokens in / out', `${fmt(c['tokens.input'] ?? 0)} / ${fmt(c['tokens.output'] ?? 0)}`),
    tile('Model / offline', `${llm} / ${heur}`),
  );
  const order = (st: string) => (st.startsWith('e2e') ? 0 : st.startsWith('intent') ? 1 : st.startsWith('llm') ? 2 : 3);
  const rows = [...s.metrics].sort((a, b) => order(a.stage) - order(b.stage) || a.stage.localeCompare(b.stage));
  const table = rows.length
    ? h(
        'table',
        { class: 'perf' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Stage'), h('th', {}, 'n'), h('th', {}, 'p50'), h('th', {}, 'p95'))),
        h(
          'tbody',
          {},
          rows.map((r) =>
            h(
              'tr',
              {},
              h('td', {}, STAGE_NAMES[r.stage] ?? r.stage),
              h('td', {}, String(r.count)),
              h('td', { class: r.stage === 'e2e.local' && r.p50 > 500 ? 'warn' : '' }, ms(r.p50)),
              h('td', { class: r.stage === 'e2e.local' && r.p95 > 500 ? 'warn' : '' }, ms(r.p95)),
            ),
          ),
        ),
      )
    : h('div', { class: 'muted pad' }, 'No measurements yet. Latency is recorded for every command on this machine.');
  return h(
    'div',
    { class: 'perf-wrap' },
    tiles,
    table,
    h('p', { class: 'muted small' }, 'Measured locally from final transcript to completed action. Only timings and counts are stored — never transcripts or code. Target for local commands: under 500 ms.'),
    h('button', { class: 'btn ghost small', onclick: () => send({ type: 'reset-metrics' }) }, 'Reset metrics'),
  );
}

const STAGE_NAMES: Record<string, string> = {
  'e2e.local': 'Local command, end-to-end',
  'e2e.local-intent': 'Local intent + model action',
  'e2e.model': 'Model command, end-to-end',
  'intent.local': 'Intent · local grammar',
  'intent.llm': 'Intent · model',
  'intent.heuristic': 'Intent · offline fallback',
  'llm.first-token': 'Model · first token',
  'llm.generate': 'Model · generate',
  'llm.modify': 'Model · modify',
  'llm.refactor': 'Model · refactor',
  'llm.debug': 'Model · debug',
  'llm.explain': 'Model · explain',
  'llm.test-generate': 'Model · tests',
  'speech.transcribe': 'Speech · transcription',
};

function tile(label: string, value: string): HTMLElement {
  return h('div', { class: 'tile' }, h('div', { class: 'tile-value' }, value), h('div', { class: 'tile-label' }, label));
}
const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`);
const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

function segmented(label: string, key: 'mode' | 'speechProvider' | 'review', value: string, options: Array<[string, string]>): HTMLElement {
  return h(
    'div',
    { class: 'setting' },
    h('div', { class: 'setting-label' }, label),
    h(
      'div',
      { class: 'segmented', role: 'radiogroup', 'aria-label': label },
      options.map(([v, text]) =>
        h('button', { class: v === value ? 'on' : '', role: 'radio', 'aria-checked': String(v === value), onclick: () => send({ type: 'set', key, value: v }) }, text),
      ),
    ),
  );
}

function settingsView(s: UiState): HTMLElement {
  const lang = h(
    'select',
    { 'aria-label': 'Speech language', onchange: (e: Event) => send({ type: 'set', key: 'language', value: (e.target as HTMLSelectElement).value }) },
    [
      ['en-US', 'English (US)'],
      ['en-GB', 'English (UK)'],
      ['en-IN', 'English (India)'],
      ['hi-IN', 'हिन्दी · Hindi'],
      ['te-IN', 'తెలుగు · Telugu'],
    ].map(([v, t]) => h('option', { value: v, selected: v === s.language }, t)),
  );
  return h(
    'div',
    { class: 'settings' },
    h(
      'div',
      { class: 'setting' },
      h('div', { class: 'setting-label' }, 'Model'),
      h('div', { class: 'row' }, h('span', {}, `${s.provider} · `, h('code', {}, s.model)), h('button', { class: 'btn small', onclick: () => send({ type: 'set-key' }) }, s.hasKey ? 'Change key' : 'Set key')),
    ),
    segmented('Microphone', 'speechProvider', s.speechProvider, [
      ['browser', 'Browser'],
      ['native', 'Native (ffmpeg)'],
    ]),
    h('div', { class: 'setting' }, h('div', { class: 'setting-label' }, 'Language'), lang),
    segmented('Listening', 'mode', s.mode, [
      ['continuous', 'Continuous'],
      ['push-to-talk', 'Push-to-talk'],
    ]),
    segmented('Code changes', 'review', s.review, [
      ['apply-and-review', 'Apply, then review'],
      ['preview-first', 'Preview first'],
    ]),
    h(
      'div',
      { class: 'shortcuts' },
      h('div', { class: 'setting-label' }, 'Shortcuts'),
      shortcut(s.platform === 'darwin' ? '⌥ Space' : 'Alt+Space', 'Toggle listening'),
      shortcut(s.platform === 'darwin' ? '⌘⌥ Enter' : 'Ctrl+Alt+Enter', 'Accept change'),
      shortcut(s.platform === 'darwin' ? '⌘⌥ ⌫' : 'Ctrl+Alt+Backspace', 'Reject change'),
      shortcut(s.platform === 'darwin' ? '⌘⌥ K' : 'Ctrl+Alt+K', 'Type a command'),
      shortcut('Esc', 'Cancel running command'),
    ),
    h('div', { class: 'row' }, h('button', { class: 'btn ghost small', onclick: () => send({ type: 'open-mic-page' }) }, 'Open microphone page'), h('button', { class: 'btn ghost small', onclick: () => send({ type: 'open-settings' }) }, 'All settings')),
  );
}

function shortcut(keys: string, label: string): HTMLElement {
  return h('div', { class: 'shortcut' }, h('kbd', {}, keys), h('span', {}, label));
}

// ── Waveform ─────────────────────────────────────────────────────────────────
function drawWave(): void {
  const ctx = wave.getContext('2d');
  if (!ctx) return;
  const { width, height } = wave;
  ctx.clearRect(0, 0, width, height);
  const color = getComputedStyle(document.body).getPropertyValue(state?.listening ? '--vc-accent' : '--vc-muted').trim() || '#888';
  ctx.fillStyle = color;
  const bar = width / levels.length;
  levels.forEach((v, i) => {
    const hgt = Math.max(2, Math.min(height, Math.sqrt(v) * height * 2.4));
    ctx.fillRect(i * bar + bar * 0.3, (height - hgt) / 2, Math.max(1, bar * 0.4), hgt);
  });
}

let decay: ReturnType<typeof setInterval> | null = null;
function pushLevel(rms: number): void {
  levels.push(rms);
  levels.shift();
  drawWave();
  if (!decay) {
    decay = setInterval(() => {
      levels.push(0);
      levels.shift();
      drawWave();
      if (levels.every((l) => l < 0.001) && decay) {
        clearInterval(decay);
        decay = null;
      }
    }, 120);
  }
}

// ── Messages ─────────────────────────────────────────────────────────────────
window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const m = event.data;
  switch (m.type) {
    case 'state':
      state = m.state;
      interim = m.state.interim;
      if (preview && m.state.current?.id !== preview.id) preview = null;
      render();
      drawWave();
      break;
    case 'preview':
      preview = { id: m.id, text: m.text };
      if (state?.current?.id === m.id) {
        const pre = main.querySelector('pre.streaming');
        if (pre) pre.textContent = m.text.split('\n').slice(-18).join('\n');
        else render();
      }
      break;
    case 'interim':
      interim = m.text;
      renderInterim();
      break;
    case 'level':
      pushLevel(m.rms);
      break;
  }
});

send({ type: 'ready' });
drawWave();

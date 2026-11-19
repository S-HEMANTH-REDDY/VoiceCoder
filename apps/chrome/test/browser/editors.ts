// Real-browser compatibility test for the page bridge: loads Monaco, CodeMirror 5,
// CodeMirror 6, Ace, a textarea and a contenteditable from their public CDNs into
// headless Chrome, injects the built page-bridge.js, and drives it through the same
// CustomEvent protocol the content script uses.
//
//   npm run test:browser -w @voicecoder/chrome     (needs Chrome + network)
//   CHROME_PATH=/path/to/chrome to override the browser.

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import puppeteer, { type Page } from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(here, '../../dist/page-bridge.js');
const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean) as string[];

const SRC = 'function add(a, b) {\n  return a + b;\n}\n';

interface Result {
  editor: string;
  check: string;
  ok: boolean;
  detail?: string;
}

async function main(): Promise<void> {
  if (!existsSync(BRIDGE)) throw new Error('Build first: npm run build -w @voicecoder/chrome');
  const executablePath = CANDIDATES.find((p) => existsSync(p));
  if (!executablePath) throw new Error('Chrome not found; set CHROME_PATH.');

  const html = readFileSync(join(here, 'fixture.html'));
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
  const results: Result[] = [];
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60_000 });
    await page.waitForFunction('window.monacoReady && window.cm6Ready', { timeout: 60_000 });
    await page.addScriptTag({ content: readFileSync(BRIDGE, 'utf8') });

    const editors: Array<{ name: string; focusSel: string; kind: string; getText: string; supportsText: boolean }> = [
      { name: 'textarea', focusSel: '#ta', kind: 'textarea', getText: 'document.getElementById("ta").value', supportsText: true },
      { name: 'CodeMirror 5', focusSel: '#cm5 textarea', kind: 'codemirror5', getText: 'window.cm5.getValue()', supportsText: true },
      { name: 'CodeMirror 6', focusSel: '#cm6 .cm-content', kind: 'codemirror6', getText: 'window.cm6.state.doc.toString()', supportsText: true },
      { name: 'Ace', focusSel: '#ace textarea', kind: 'ace', getText: 'window.aceEditor.getValue()', supportsText: true },
      { name: 'Monaco', focusSel: '#monaco textarea', kind: 'monaco', getText: 'window.monacoEditor.getValue()', supportsText: true },
      { name: 'contenteditable', focusSel: '#ce', kind: 'contenteditable', getText: 'document.getElementById("ce").innerText', supportsText: false },
    ];

    for (const ed of editors) {
      const check = (name: string, ok: boolean, detail?: string) => results.push({ editor: ed.name, check: name, ok, detail });
      try {
        await page.focus(ed.focusSel);
        const state = await rpc(page, { op: 'state' });
        check('detects editor', state.ok && state.state?.kind === ed.kind, JSON.stringify(state).slice(0, 160));
        if (!state.ok) continue;
        const target = state.state.targetId as string;

        if (!ed.supportsText) {
          // Put the caret at the end of the field, as a user would before dictating.
          await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(ed.focusSel)}); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()`);
          const ins = await rpc(page, { op: 'insert', targetId: target, text: ' world' });
          const text = (await page.evaluate(ed.getText)) as string;
          check('inserts dictation', ins.ok && text.includes('Hello world'), text);
          continue;
        }
        check('reads full text', state.state.text === SRC, JSON.stringify(state.state.text));

        // Minimal edit: a + b → a * b, verified against the expected text.
        const start = SRC.indexOf('a + b');
        const after = SRC.replace('a + b', 'a * b');
        const applied = await rpc(page, { op: 'apply', targetId: target, expectedText: SRC, changes: [{ start, end: start + 5, text: 'a * b' }], select: { start: start + 5, end: start + 5 } });
        check('applies verified minimal edit', applied.ok && (await page.evaluate(ed.getText)) === after, JSON.stringify(applied).slice(0, 160));

        const stale = await rpc(page, { op: 'apply', targetId: target, expectedText: SRC, changes: [{ start: 0, end: 0, text: 'X' }] });
        check('refuses stale edit', !stale.ok && stale.code === 'stale' && (await page.evaluate(ed.getText)) === after);

        const reverted = await rpc(page, { op: 'revert', targetId: target, expectedText: after, restoreText: SRC });
        check('undo restores previous text', reverted.ok && (await page.evaluate(ed.getText)) === SRC);

        await rpc(page, { op: 'apply', targetId: target, expectedText: SRC, changes: [{ start, end: start + 5, text: 'a * b' }] });
        await page.evaluate(setTextExpr(ed.kind, after + '// manual\n'));
        const refused = await rpc(page, { op: 'revert', targetId: target, expectedText: after, restoreText: SRC });
        check('undo refuses after manual edits', !refused.ok && refused.code === 'stale' && ((await page.evaluate(ed.getText)) as string).includes('// manual'));

        await page.evaluate(setTextExpr(ed.kind, SRC));
        const goto = await rpc(page, { op: 'goto-line', targetId: target, line: 2 });
        check('go to line', goto.ok);

        // Bind-to-target: focus a different editor, then apply to the original id.
        await page.focus('#ta');
        const fresh = await rpc(page, { op: 'state' }); // state of textarea now
        void fresh;
        const bound = await rpc(page, { op: 'apply', targetId: target, expectedText: SRC, changes: [{ start: 0, end: 0, text: '// voice\n' }] });
        const targetText = (await page.evaluate(ed.getText)) as string;
        const taText = (await page.evaluate('document.getElementById("ta").value')) as string;
        const okBound = ed.kind === 'textarea' ? bound.ok && targetText.startsWith('// voice') : bound.ok && targetText.startsWith('// voice') && !taText.includes('// voice');
        check('applies to the spoken-in editor, not the focused one', okBound, JSON.stringify(bound).slice(0, 120));
        await page.evaluate(setTextExpr(ed.kind, SRC));
        if (ed.kind !== 'textarea') await page.evaluate(setTextExpr('textarea', SRC));
      } catch (err) {
        check('no exceptions', false, err instanceof Error ? err.message : String(err));
      }
    }

    // A removed editor must not receive late results.
    await page.focus('#cm5 textarea');
    const s = await rpc(page, { op: 'state' });
    await page.evaluate('document.querySelector("#cm5 .CodeMirror").remove()');
    const gone = await rpc(page, { op: 'apply', targetId: s.state.targetId, expectedText: null, changes: [{ start: 0, end: 0, text: 'x' }] });
    results.push({ editor: 'CodeMirror 5', check: 'refuses when editor removed', ok: !gone.ok && gone.code === 'target-gone' });
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✔' : '✘'} ${r.editor.padEnd(16)} ${r.check}${r.ok || !r.detail ? '' : `  — ${r.detail}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} browser compatibility checks passed`);
  if (failed.length) process.exit(1);
}

/** Expression that replaces an editor's full text through its own API (simulates manual typing). */
function setTextExpr(kind: string, text: string): string {
  const t = JSON.stringify(text);
  switch (kind) {
    case 'textarea':
      return `document.getElementById('ta').value = ${t}`;
    case 'codemirror5':
      return `window.cm5.setValue(${t})`;
    case 'codemirror6':
      return `window.cm6.dispatch({ changes: { from: 0, to: window.cm6.state.doc.length, insert: ${t} } })`;
    case 'ace':
      return `window.aceEditor.setValue(${t}, -1)`;
    case 'monaco':
      return `window.monacoEditor.setValue(${t})`;
    default:
      return 'void 0';
  }
}

let seq = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rpc(page: Page, req: Record<string, unknown>): Promise<any> {
  const id = ++seq;
  // Evaluated from a string: the TS runner injects helpers that do not exist in the page.
  const payload = JSON.stringify(JSON.stringify({ ...req, id }));
  return page.evaluate(`new Promise((resolve) => {
    const onRes = (e) => {
      const res = JSON.parse(e.detail);
      if (res.id !== ${id}) return;
      document.removeEventListener('voicecoder:response', onRes);
      resolve(res);
    };
    document.addEventListener('voicecoder:response', onRes);
    document.dispatchEvent(new CustomEvent('voicecoder:request', { detail: ${payload} }));
  })`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

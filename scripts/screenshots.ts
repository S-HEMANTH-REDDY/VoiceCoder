// Renders the REAL assistant webview bundle (apps/vscode/out/webview) and microphone page
// in headless Chrome with VS Code theme colours and a demo UI state, and saves PNGs to
// docs/images. The UI code is the shipped code; only the state object is illustrative.
//   npm run build && npx tsx scripts/screenshots.ts

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { build } from 'esbuild';

const root = join(import.meta.dirname, '..');
const out = join(root, 'docs/images');
const chrome = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find((p) => p && existsSync(p))!;

const DARK = `--vscode-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; --vscode-font-size: 13px; --vscode-foreground: #cccccc; --vscode-descriptionForeground: #9d9d9d;
  --vscode-sideBar-background: #181818; --vscode-widget-border: #313131; --vscode-editor-font-family: Menlo, Monaco, monospace; --vscode-button-background: #0078d4; --vscode-button-foreground: #fff;
  --vscode-button-hoverBackground: #026ec1; --vscode-button-secondaryBackground: #313131; --vscode-button-secondaryForeground: #ccc; --vscode-input-background: #313131; --vscode-input-foreground: #ccc;
  --vscode-input-border: #3c3c3c; --vscode-focusBorder: #0078d4; --vscode-textCodeBlock-background: #2b2b2b; --vscode-errorForeground: #f85149;
  --vscode-diffEditor-insertedLineBackground: rgba(155,185,85,.18); --vscode-diffEditor-removedLineBackground: rgba(255,0,0,.18); --vscode-dropdown-background: #313131; --vscode-dropdown-foreground: #ccc;`;
const LIGHT = `--vscode-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; --vscode-font-size: 13px; --vscode-foreground: #3b3b3b; --vscode-descriptionForeground: #717171;
  --vscode-sideBar-background: #f8f8f8; --vscode-widget-border: #e5e5e5; --vscode-editor-font-family: Menlo, Monaco, monospace; --vscode-button-background: #005fb8; --vscode-button-foreground: #fff;
  --vscode-button-secondaryBackground: #e5e5e5; --vscode-button-secondaryForeground: #3b3b3b; --vscode-input-background: #fff; --vscode-input-foreground: #3b3b3b; --vscode-input-border: #cecece;
  --vscode-focusBorder: #005fb8; --vscode-textCodeBlock-background: #f2f2f2; --vscode-errorForeground: #c72e0f; --vscode-diffEditor-insertedLineBackground: rgba(155,185,85,.25); --vscode-diffEditor-removedLineBackground: rgba(255,0,0,.15);`;

const diff = [
  { type: 'context', text: 'export function searchNotes(query) {', oldLine: 31, newLine: 31 },
  { type: 'remove', text: '  return listNotes().filter((n) => n.title.includes(query));', oldLine: 32 },
  { type: 'add', text: '  const q = query.trim().toLowerCase();', newLine: 32 },
  { type: 'add', text: '  return listNotes().filter((n) => n.title.toLowerCase().includes(q));', newLine: 33 },
  { type: 'context', text: '}', oldLine: 33, newLine: 34 },
];
const base = { listening: true, speechProvider: 'browser', speechLabel: 'Browser mic', language: 'en-US', mode: 'continuous', review: 'apply-and-review', interim: '', hasKey: true, trusted: true, provider: 'Claude', model: 'claude-opus-5-5', metrics: [], counters: {}, platform: 'darwin', approval: null, agent: null };
const history = [
  { id: 'h3', transcript: 'make it case insensitive', intent: 'modify', source: 'llm', status: 'review', title: 'Make searchNotes case-insensitive', at: 0 },
  { id: 'h2', transcript: 'create a function that searches notes by title', intent: 'generate', source: 'llm', status: 'done', title: 'Add searchNotes()', at: 0 },
  { id: 'h1', transcript: 'open the notes file', intent: 'navigate', source: 'local', status: 'done', title: 'Opened src/notes.js', at: 0 },
];
const states = {
  review: { ...base, phase: 'review', hasPendingChange: true, history, current: { ...history[0], message: 'Applied +2 −1 in src/notes.js:32. Say “accept” or “reject”.', diff, stats: { added: 2, removed: 1 }, file: 'src/notes.js' } },
  agent: {
    ...base, phase: 'awaiting-approval', hasPendingChange: false, history,
    current: { id: 'a', transcript: 'add an endpoint to update a note, validate the input, write tests and run them', intent: 'agent', source: 'llm', status: 'running', title: 'Understanding…', at: 0 },
    agent: { goal: 'Add PUT /notes/:id with validation, tests, and verify', status: 'running', plan: [
      { title: 'Add updateNote() to the store', detail: 'src/notes.js' }, { title: 'Route PUT /notes/:id with input validation', detail: 'src/server.js' },
      { title: 'Write tests for updateNote', detail: 'test/notes.test.js' }, { title: 'Run the test suite', detail: 'npm test' } ],
      steps: [ { step: 1, tool: 'read_file', description: 'read_file {"path":"src/notes.js"}', status: 'ok', summary: 'Read src/notes.js' },
        { step: 2, tool: 'edit_file', description: 'Edit src/notes.js (1 change)', status: 'ok', summary: 'Edited src/notes.js +9 −0' },
        { step: 3, tool: 'edit_file', description: 'Edit src/server.js (1 change)', status: 'ok', summary: 'Edited src/server.js +12 −0' },
        { step: 4, tool: 'run_command', description: '$ npm test', status: 'awaiting-approval' } ] },
    approval: { id: 1, title: 'Agent wants to run a command', detail: 'Verify the new endpoint with the test suite.', subject: 'npm test', labels: [], severity: 'low', approveLabel: 'Run' },
  },
};

async function main() {
  const js = readFileSync(join(root, 'apps/vscode/out/webview/assistant.js'), 'utf8');
  const css = readFileSync(join(root, 'apps/vscode/out/webview/assistant.css'), 'utf8');
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
  try {
    for (const [name, state] of Object.entries(states)) {
      for (const theme of ['dark', 'light'] as const) {
        if (name === 'agent' && theme === 'light') continue;
        const page = await browser.newPage();
        await page.setViewport({ width: 380, height: name === 'agent' ? 820 : 700, deviceScaleFactor: 2 });
        await page.setContent(`<!doctype html><html><head><style>${css}</style><style>html{${theme === 'dark' ? DARK : LIGHT}} body{background: var(--vscode-sideBar-background); color: var(--vscode-foreground);}</style></head>
          <body class="vscode-${theme}"><div id="app"></div><script>window.acquireVsCodeApi = () => ({ postMessage(){}, getState(){ return {}; }, setState(){} });</script>
          <script>${js}</script></body></html>`);
        await page.evaluate((s) => window.postMessage({ type: 'state', state: s }, '*'), state as never);
        await page.evaluate(() => { for (let i = 0; i < 40; i++) window.postMessage({ type: 'level', rms: Math.abs(Math.sin(i / 3)) * 0.08 + 0.01 }, '*'); });
        await new Promise((r) => setTimeout(r, 300));
        await page.screenshot({ path: join(out, `assistant-${name}-${theme}.png`) });
        await page.close();
      }
    }
    // Microphone page (real HTML; script replaced by a static state).
    const mic = readFileSync(join(root, 'apps/vscode/media/mic.html'), 'utf8').replace('<script src="mic.js"></script>', `<script>
      document.getElementById('card').className='card listening'; document.getElementById('state').textContent='Listening';
      document.getElementById('transcript').textContent='create a function that searches notes by title';
      document.getElementById('last').textContent='Sent to VS Code'; document.getElementById('toggle').textContent='Stop';
      const c=document.getElementById('wave'), x=c.getContext('2d'); x.fillStyle=getComputedStyle(document.documentElement).getPropertyValue('--accent');
      for(let i=0;i<96;i++){const h=Math.max(8,Math.abs(Math.sin(i/5)*Math.cos(i/11))*120);x.fillRect(i*(1040/96)+3,(144-h)/2,5,h);} </script>`);
    for (const scheme of ['dark', 'light'] as const) {
      const page = await browser.newPage();
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      await page.setViewport({ width: 640, height: 420, deviceScaleFactor: 2 });
      await page.setContent(mic);
      await page.screenshot({ path: join(out, `mic-page-${scheme}.png`) });
      await page.close();
    }
    // Chrome overlay (real Overlay class) over a CodeMirror-like editor surface.
    const overlayJs = (await build({ entryPoints: [join(root, 'apps/chrome/src/content/overlay.ts')], bundle: true, write: false, format: 'iife', globalName: 'VC', platform: 'browser' })).outputFiles[0]!.text;
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await page.setViewport({ width: 900, height: 420, deviceScaleFactor: 2 });
    await page.setContent(`<body style="margin:0;background:#1e1e1e;color:#d4d4d4;font:14px/1.6 Menlo,monospace;padding:28px">
      <pre style="margin:0">class Solution:\n    def twoSum(self, nums: List[int], target: int) -> List[int]:\n        seen = {}\n        for i, n in enumerate(nums):\n            if target - n in seen:\n                return [seen[target - n], i]\n            seen[n] = i\n        return []</pre>
      <script>${overlayJs}; const o = new VC.Overlay({ onClose(){}, onUndo(){} }); o.show('done', 'Return early when nums is empty', { transcript: 'return early if the list is empty', chip: 'modify', undo: true });</script></body>`);
    await new Promise((r) => setTimeout(r, 200));
    await page.screenshot({ path: join(out, 'chrome-overlay.png') });
  } finally {
    await browser.close();
  }
  console.log('Screenshots written to docs/images');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Bundles the extension host code (CommonJS for VS Code), the assistant webview and the
// browser microphone page (IIFE), and copies static assets into out/.
import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'out');
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = { bundle: true, sourcemap: production ? false : 'linked', minify: production, logLevel: 'info', legalComments: 'none' };

const testEntries = readdirSync(join(root, 'test/integration'))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => join(root, 'test/integration', f));

const configs = [
  { ...common, entryPoints: [join(root, 'src/extension.ts')], outfile: join(out, 'extension.js'), platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] },
  { ...common, entryPoints: [join(root, 'src/ui/webview.ts')], outfile: join(out, 'webview/assistant.js'), platform: 'browser', format: 'iife', target: 'chrome120' },
  { ...common, entryPoints: [join(root, 'src/ui/mic-page.ts')], outfile: join(out, 'mic.js'), platform: 'browser', format: 'iife', target: ['chrome110', 'safari16', 'edge110'], sourcemap: false },
  ...(production ? [] : [{ ...common, entryPoints: testEntries, outdir: join(out, 'test'), platform: 'node', format: 'cjs', target: 'node20', external: ['vscode', 'mocha', '@vscode/test-electron'] }]),
];

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'webview'), { recursive: true });
await cp(join(root, 'media/assistant.css'), join(out, 'webview/assistant.css'));

if (watch) {
  for (const c of configs) await (await context(c)).watch();
} else {
  await Promise.all(configs.map((c) => build(c)));
}

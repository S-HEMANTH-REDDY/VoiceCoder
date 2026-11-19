#!/usr/bin/env node
// Bundles the MV3 extension into dist/ (load unpacked from there).
import { build } from 'esbuild';
import { cp, copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const common = { bundle: true, platform: 'browser', target: 'chrome111', logLevel: 'info', legalComments: 'none', minify: process.argv.includes('--production') };

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });
await copyFile(join(ROOT, 'manifest.json'), join(DIST, 'manifest.json'));
await cp(join(ROOT, 'icons'), join(DIST, 'icons'), { recursive: true });
for (const page of ['popup', 'settings']) {
  await mkdir(join(DIST, page), { recursive: true });
  await copyFile(join(ROOT, 'src', page, `${page}.html`), join(DIST, page, `${page}.html`));
  await copyFile(join(ROOT, 'src', page, `${page}.css`), join(DIST, page, `${page}.css`));
}

await Promise.all([
  // Service worker is an ES module (manifest "type": "module").
  build({ ...common, entryPoints: [join(ROOT, 'src/background/service-worker.ts')], outfile: join(DIST, 'service-worker.js'), format: 'esm' }),
  // Content scripts cannot use ES module imports: bundle as IIFE.
  build({ ...common, entryPoints: [join(ROOT, 'src/content/content.ts')], outfile: join(DIST, 'content.js'), format: 'iife' }),
  build({ ...common, entryPoints: [join(ROOT, 'src/content/page-bridge.ts')], outfile: join(DIST, 'page-bridge.js'), format: 'iife' }),
  build({ ...common, entryPoints: [join(ROOT, 'src/popup/popup.ts')], outfile: join(DIST, 'popup/popup.js'), format: 'iife' }),
  build({ ...common, entryPoints: [join(ROOT, 'src/settings/settings.ts')], outfile: join(DIST, 'settings/settings.js'), format: 'iife' }),
]);
console.log('✓ Built to dist/ — load it at chrome://extensions (Developer mode → Load unpacked).');

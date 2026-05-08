#!/usr/bin/env node
import { cp, mkdir, copyFile, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { build as esbuild } from 'esbuild';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const DIST = join(ROOT, 'dist');

async function build() {
  console.log('Building VoiceCoder…');

  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  // Copy manifest and icons
  await copyFile(join(ROOT, 'manifest.json'), join(DIST, 'manifest.json'));
  await cp(join(ROOT, 'icons'), join(DIST, 'icons'), { recursive: true });

  // Copy popup and settings as-is (they run as extension pages, not content scripts)
  await cp(join(ROOT, 'src', 'popup'), join(DIST, 'src', 'popup'), { recursive: true });
  await cp(join(ROOT, 'src', 'settings'), join(DIST, 'src', 'settings'), { recursive: true });
  await mkdir(join(DIST, 'src', 'content'), { recursive: true });
  await copyFile(join(ROOT, 'src', 'content', 'content.css'), join(DIST, 'src', 'content', 'content.css'));

  // Bundle the content script — Chrome doesn't support ES module relative
  // imports in content scripts, so esbuild inlines everything into one IIFE.
  await esbuild({
    entryPoints: [join(ROOT, 'src', 'content', 'content.js')],
    bundle: true,
    outfile: join(DIST, 'src', 'content', 'content.js'),
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    logLevel: 'info',
  });

  // Bundle the service worker (already works as ES module, but bundle for consistency)
  await mkdir(join(DIST, 'src', 'background'), { recursive: true });
  await esbuild({
    entryPoints: [join(ROOT, 'src', 'background', 'service-worker.js')],
    bundle: true,
    outfile: join(DIST, 'src', 'background', 'service-worker.js'),
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    logLevel: 'info',
  });

  // Popup and settings scripts need bundling too
  for (const name of ['popup', 'settings']) {
    await esbuild({
      entryPoints: [join(ROOT, 'src', name, `${name}.js`)],
      bundle: true,
      outfile: join(DIST, 'src', name, `${name}.js`),
      format: 'iife',
      platform: 'browser',
      target: 'chrome120',
      logLevel: 'info',
    });
  }

  console.log('✓ Built to dist/');
  console.log('\nTo load in Chrome:');
  console.log('  1. Open chrome://extensions');
  console.log('  2. Enable "Developer mode"');
  console.log('  3. Click "Load unpacked"');
  console.log('  4. Select the dist/ folder');
}

build().catch((e) => {
  console.error('Build failed:', e);
  process.exit(1);
});

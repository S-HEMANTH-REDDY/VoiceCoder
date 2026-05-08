#!/usr/bin/env node
// Build script — copies files to dist/ (no bundler needed for MV3 with ES modules)

import { cp, mkdir, copyFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const DIST = join(ROOT, 'dist');

async function build() {
  console.log('Building VoiceCoder…');

  // Clean dist
  await mkdir(DIST, { recursive: true });

  // Copy manifest
  await copyFile(join(ROOT, 'manifest.json'), join(DIST, 'manifest.json'));

  // Copy src tree
  await cp(join(ROOT, 'src'), join(DIST, 'src'), { recursive: true });

  // Copy icons
  await cp(join(ROOT, 'icons'), join(DIST, 'icons'), { recursive: true });

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

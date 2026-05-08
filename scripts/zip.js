#!/usr/bin/env node
// Packages dist/ into voicecoder.zip for Chrome Web Store submission

import archiver from 'archiver';
import { createWriteStream } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');

const output = createWriteStream(join(ROOT, 'voicecoder.zip'));
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
  console.log(`✓ voicecoder.zip created (${(archive.pointer() / 1024).toFixed(1)} KB)`);
});

archive.on('error', (err) => { throw err; });
archive.pipe(output);
archive.directory(join(ROOT, 'dist'), false);
archive.finalize();

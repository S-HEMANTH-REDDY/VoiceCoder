// Launches a real VS Code instance with the extension under development and runs the
// mocha suites in suite.ts against a freshly generated fixture workspace.
//   VSCODE_PATH=/path/to/Code  → use an installed VS Code (no download)
//   (unset)                    → @vscode/test-electron downloads stable VS Code (CI)

import { runTests } from '@vscode/test-electron';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'voicecoder-fixture-'));
  const w = (rel: string, content: string) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  };
  w('package.json', JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2));
  w(
    'src/math.js',
    `export function add(a, b) {
  return a + b;
}

export function average(values) {
  let total = 0;
  for (const v of values) {
    total += v;
  }
  return total / values.length;
}
`,
  );
  w('src/auth.js', `export function login(user, password) {\n  if (!user) {\n    return null;\n  }\n  return { user };\n}\n`);
  w('src/notes.md', '# Notes\n\n');
  w('test/math.test.js', `import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { add } from '../src/math.js';\n\ntest('add', () => assert.equal(add(2, 3), 5));\n`);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@voicecoder.local');
  git('config', 'user.name', 'VoiceCoder Test');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

async function main(): Promise<void> {
  const extensionDevelopmentPath = resolve(__dirname, '../..');
  const extensionTestsPath = resolve(__dirname, 'suite.js');
  const workspace = fixture();
  const userData = mkdtempSync(join(tmpdir(), 'voicecoder-userdata-'));
  const extensionsDir = mkdtempSync(join(tmpdir(), 'voicecoder-ext-'));
  const local = process.env.VSCODE_PATH ?? (process.platform === 'darwin' && existsSync('/Applications/Visual Studio Code.app/Contents/MacOS/Code') ? '/Applications/Visual Studio Code.app/Contents/MacOS/Code' : undefined);
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    vscodeExecutablePath: local,
    launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', `--user-data-dir=${userData}`, `--extensions-dir=${extensionsDir}`, '--skip-welcome', '--skip-release-notes'],
    extensionTestsEnv: { VOICECODER_FIXTURE: workspace, VOICECODER_RESULTS: resolve(__dirname, '../../../../eval/results/vscode-local-latency.json') },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

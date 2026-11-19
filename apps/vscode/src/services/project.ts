// Detects how to test and run the current project from its manifest files, so
// "run the tests" maps to the project's real command rather than a model guess.

import * as vscode from 'vscode';

export interface ProjectCommands {
  test?: string;
  run?: string;
  build?: string;
  kind: 'node' | 'python' | 'go' | 'rust' | 'make' | 'unknown';
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun';
  scripts?: Record<string, string>;
}

async function exists(root: vscode.Uri, rel: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, rel));
    return true;
  } catch {
    return false;
  }
}

async function readText(root: vscode.Uri, rel: string): Promise<string | null> {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, rel))).toString('utf8');
  } catch {
    return null;
  }
}

export async function detectProject(root: vscode.Uri): Promise<ProjectCommands> {
  const pkgText = await readText(root, 'package.json');
  if (pkgText) {
    let scripts: Record<string, string> = {};
    try {
      scripts = (JSON.parse(pkgText) as { scripts?: Record<string, string> }).scripts ?? {};
    } catch {
      // invalid package.json
    }
    const pm = (await exists(root, 'pnpm-lock.yaml')) ? 'pnpm' : (await exists(root, 'yarn.lock')) ? 'yarn' : (await exists(root, 'bun.lockb')) ? 'bun' : 'npm';
    const run = (s: string) => (pm === 'npm' ? (s === 'test' || s === 'start' ? `npm ${s}` : `npm run ${s}`) : `${pm} ${s}`);
    const hasRealTest = scripts.test && !/no test specified/.test(scripts.test);
    return {
      kind: 'node',
      packageManager: pm,
      scripts,
      test: hasRealTest ? run('test') : undefined,
      run: scripts.dev ? run('dev') : scripts.start ? run('start') : scripts.serve ? run('serve') : undefined,
      build: scripts.build ? run('build') : undefined,
    };
  }
  if ((await exists(root, 'pyproject.toml')) || (await exists(root, 'requirements.txt')) || (await exists(root, 'setup.py'))) {
    const hasPytest = (await exists(root, 'pytest.ini')) || /pytest/.test((await readText(root, 'pyproject.toml')) ?? '') || /pytest/.test((await readText(root, 'requirements.txt')) ?? '');
    const main = (await exists(root, 'main.py')) ? 'python main.py' : (await exists(root, 'app.py')) ? 'python app.py' : (await exists(root, 'manage.py')) ? 'python manage.py runserver' : undefined;
    return { kind: 'python', test: hasPytest ? 'python -m pytest -q' : 'python -m unittest discover -v', run: main };
  }
  if (await exists(root, 'go.mod')) return { kind: 'go', test: 'go test ./...', run: 'go run .', build: 'go build ./...' };
  if (await exists(root, 'Cargo.toml')) return { kind: 'rust', test: 'cargo test', run: 'cargo run', build: 'cargo build' };
  const makefile = await readText(root, 'Makefile');
  if (makefile) {
    const has = (t: string) => new RegExp(`^${t}:`, 'm').test(makefile);
    return { kind: 'make', test: has('test') ? 'make test' : undefined, run: has('run') ? 'make run' : undefined, build: has('build') ? 'make build' : undefined };
  }
  return { kind: 'unknown' };
}

export function describeProject(p: ProjectCommands): string {
  const lines = [`Project type: ${p.kind}`];
  if (p.test) lines.push(`Test command: ${p.test}`);
  if (p.run) lines.push(`Run command: ${p.run}`);
  if (p.build) lines.push(`Build command: ${p.build}`);
  if (p.scripts) lines.push(`Scripts: ${Object.entries(p.scripts).slice(0, 15).map(([k, v]) => `${k}=${v}`).join('; ')}`);
  return lines.join('\n');
}

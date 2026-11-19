import { describe, expect, it } from 'vitest';
import { applyChanges, diffStats, lineDiff, offsetToPosition, PatchError, positionToOffset, resolveEdits, stripFences } from '../src/edit/patch.js';
import { TransactionLog } from '../src/edit/transactions.js';
import { SessionMemory } from '../src/memory/session-memory.js';
import { detectIndent, extractImports, renderContext, type EditorContext } from '../src/context/context.js';

const src = `import express from 'express';

function login(req, res) {
  const user = findUser(req.body.email);
  res.json(user);
}

function logout(req, res) {
  res.json({ ok: true });
}
`;

describe('resolveEdits / applyChanges', () => {
  it('applies an exact search/replace as a minimal range', () => {
    const changes = resolveEdits(src, [{ search: 'function login(req, res) {', replace: 'async function login(req, res) {' }], 0);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.end - changes[0]!.start).toBe('function login(req, res) {'.length);
    expect(applyChanges(src, changes)).toContain('async function login');
  });

  it('inserts at the cursor for empty search', () => {
    const at = src.length;
    const out = applyChanges(src, resolveEdits(src, [{ search: '', replace: 'export { login };\n' }], at));
    expect(out.endsWith('export { login };\n')).toBe(true);
  });

  it('tolerates indentation drift in the anchor and re-indents the replacement', () => {
    const changes = resolveEdits(src, [{ search: 'const user = findUser(req.body.email);\nres.json(user);', replace: 'const user = await findUser(req.body.email);\nif (!user) return res.status(401).end();\nres.json(user);' }], 0);
    const out = applyChanges(src, changes);
    expect(out).toContain('  const user = await findUser(req.body.email);\n  if (!user) return res.status(401).end();\n  res.json(user);');
  });

  it('rejects ambiguous anchors', () => {
    expect(() => resolveEdits(src, [{ search: 'res.json(', replace: 'x' }], 0)).toThrow(PatchError);
  });

  it('rejects anchors that no longer exist (stale request)', () => {
    try {
      resolveEdits(src, [{ search: 'function register()', replace: 'x' }], 0);
      expect.unreachable();
    } catch (e) {
      expect((e as PatchError).reason).toBe('not-found');
    }
  });

  it('rejects overlapping edits', () => {
    expect(() =>
      resolveEdits(
        src,
        [
          { search: 'function login(req, res) {\n  const user', replace: 'a' },
          { search: 'const user = findUser', replace: 'b' },
        ],
        0,
      ),
    ).toThrow(/overlap/);
  });

  it('applies multiple edits (import + body) together', () => {
    const changes = resolveEdits(
      src,
      [
        { search: "import express from 'express';", replace: "import express from 'express';\nimport jwt from 'jsonwebtoken';" },
        { search: '  res.json(user);', replace: '  res.json({ token: jwt.sign({ id: user.id }, process.env.JWT_SECRET) });' },
      ],
      0,
    );
    const out = applyChanges(src, changes);
    expect(out.split('\n')[1]).toBe("import jwt from 'jsonwebtoken';");
    expect(out).toContain('jwt.sign');
    expect(out).toContain('function logout');
  });

  it('throws on empty plans', () => {
    expect(() => resolveEdits(src, [], 0)).toThrow(/no changes/);
  });

  it('converts offsets and positions', () => {
    const off = positionToOffset(src, 2, 9);
    expect(offsetToPosition(src, off)).toEqual({ line: 2, character: 9 });
  });

  it('strips markdown fences', () => {
    expect(stripFences('```ts\nconst a = 1;\n```')).toBe('const a = 1;');
    expect(stripFences('const a = 1;')).toBe('const a = 1;');
  });
});

describe('lineDiff', () => {
  it('produces a compact diff with context', () => {
    const after = src.replace('function login', 'async function login');
    const d = lineDiff(src, after, 1);
    expect(diffStats(d)).toEqual({ added: 1, removed: 1 });
    expect(d.length).toBeLessThanOrEqual(4);
  });
});

describe('TransactionLog', () => {
  it('undoes only when the document is unchanged since the edit', async () => {
    const files = new Map([['a.ts', 'after']]);
    const store = { read: async (u: string) => files.get(u) };
    const log = new TransactionLog();
    const tx = log.record('edit', [{ uri: 'a.ts', before: 'before', after: 'after' }]);
    expect(await log.canUndo(tx, store)).toEqual({ ok: true });
    files.set('a.ts', 'after + manual typing');
    const check = await log.canUndo(tx, store);
    expect(check.ok).toBe(false);
  });

  it('tracks undo/redo order', async () => {
    const log = new TransactionLog();
    const a = log.record('a', []);
    const b = log.record('b', []);
    expect(log.peek()).toBe(b);
    log.markUndone(b);
    expect(log.peek()).toBe(a);
    expect(log.peekRedo()).toBe(b);
    log.markApplied(b);
    expect(log.peekRedo()).toBeUndefined();
  });

  it('bounds its history', () => {
    const log = new TransactionLog(3);
    for (let i = 0; i < 5; i++) log.record(String(i), []);
    expect(log.all().map((t) => t.label)).toEqual(['2', '3', '4']);
  });
});

describe('SessionMemory', () => {
  it('renders recent turns within budget and resolves focus', () => {
    let t = 0;
    const m = new SessionMemory({ focusTtlMs: 1000 }, () => t);
    m.record({ id: '1', transcript: 'create a login API', kind: 'generate', instruction: 'x', outcome: 'Added login()', ok: true, file: 'auth.ts' });
    m.record({ id: '2', transcript: 'add JWT authentication', kind: 'modify', instruction: 'x', outcome: 'Added jwt', ok: true, file: 'auth.ts' });
    m.setFocus({ file: 'auth.ts', startLine: 3, endLine: 9, symbol: 'login' });
    expect(m.render()).toContain('create a login API');
    expect(m.render(20).split('\n')).toHaveLength(1);
    expect(m.getFocus('auth.ts')?.symbol).toBe('login');
    expect(m.getFocus('other.ts')).toBeNull();
    t = 2000;
    expect(m.getFocus('auth.ts')).toBeNull();
  });

  it('shifts focus when lines are inserted above it', () => {
    const m = new SessionMemory();
    m.setFocus({ file: 'a', startLine: 10, endLine: 20 });
    m.adjustFocus('a', 2, 3);
    expect(m.getFocus()).toMatchObject({ startLine: 13, endLine: 23 });
    m.adjustFocus('a', 15, -2);
    expect(m.getFocus()).toMatchObject({ startLine: 13, endLine: 21 });
  });

  it('expires idle sessions', () => {
    let t = 0;
    const m = new SessionMemory({ sessionIdleMs: 100 }, () => t);
    m.record({ id: '1', transcript: 'a', kind: 'generate', instruction: 'a', outcome: 'ok', ok: true });
    t = 500;
    expect(m.render()).toBe('');
  });
});

describe('context', () => {
  const ctx: EditorContext = {
    host: 'vscode',
    fileName: 'auth.ts',
    languageId: 'typescript',
    lineCount: 11,
    cursor: { line: 4, column: 3 },
    window: { startLine: 1, endLine: 11, text: src },
    document: src,
    indentUnit: '  ',
    eol: '\n',
    diagnostics: [{ line: 4, severity: 'error', message: "Cannot find name 'findUser'.", source: 'ts', code: '2304' }],
    projectFiles: Array.from({ length: 500 }, (_, i) => `src/file${i}.ts`),
  };

  it('renders the cursor marker, diagnostics and line numbers', () => {
    const out = renderContext(ctx, { budgetTokens: 4000 });
    expect(out).toContain('⟨CURSOR⟩');
    expect(out).toContain("Cannot find name 'findUser'");
    expect(out).toMatch(/ 4\| /);
  });

  it('drops low-priority sections to stay within budget', () => {
    const out = renderContext(ctx, { budgetTokens: 250 });
    expect(out).not.toContain('Project files');
    expect(out).toContain('File: auth.ts');
  });

  it('detects indentation and imports', () => {
    expect(detectIndent(src)).toBe('  ');
    expect(detectIndent('def a():\n    return 1\n')).toBe('    ');
    expect(detectIndent('func a() {\n\treturn\n}\n')).toBe('\t');
    expect(extractImports("import a from 'a';\nconst b = require('b');\nfrom x import y\nfoo()")).toHaveLength(3);
  });
});

// VoiceCoder evaluation harness.
//
//   npm run eval                 offline: local grammar + offline fallback, speech
//                                duplicate simulation, patch robustness, agent recovery
//   npm run eval -- --live       additionally runs the model path (needs ANTHROPIC_API_KEY
//                                or OPENAI_API_KEY; set VOICECODER_PROVIDER=openai to pick)
//
// Writes eval/results/<mode>.json and eval/results/<mode>.md. Every number in those files
// is measured by this script on the machine that ran it.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import os from 'node:os';
import { z } from 'zod';
import {
  applyChanges,
  buildEditSystem,
  buildEditUserPrompt,
  createProvider,
  defineTool,
  EditPlanSchema,
  IntentEngine,
  LLMError,
  normalizeTranscript,
  parseLocalIntent,
  percentile,
  resolveEdits,
  UtteranceGate,
  VoiceAgent,
  WebSpeechController,
  windowAround,
  detectIndent,
  type EditBlock,
  type EditorContext,
  type Intent,
  type LLMProvider,
  type RecognitionEventLike,
  type RecognitionLike,
} from '../packages/core/src/index.js';
import { LegacySpeechEngine } from './legacy-speech-engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const live = process.argv.includes('--live');

interface Row {
  text: string;
  kind: Intent['kind'];
  expect?: Record<string, unknown>;
  tags?: string[];
}
const dataset: Row[] = readFileSync(join(here, 'commands.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const ms = (n: number) => Math.round(n * 1000) / 1000;
const pct = (a: number, b: number) => (b === 0 ? null : Math.round((a / b) * 1000) / 10);
const now = () => performance.now();

// ── 1. Intent classification ────────────────────────────────────────────────
function matchesExpect(intent: Intent, expect?: Record<string, unknown>): boolean {
  if (!expect) return true;
  const actual = intent as unknown as Record<string, unknown>;
  return Object.entries(expect).every(([k, v]) => JSON.stringify(pick(actual[k], v)) === JSON.stringify(v));
}
function pick(actual: unknown, shape: unknown): unknown {
  if (shape && typeof shape === 'object' && actual && typeof actual === 'object') {
    return Object.fromEntries(Object.keys(shape).map((k) => [k, pick((actual as Record<string, unknown>)[k], (shape as Record<string, unknown>)[k])]));
  }
  return actual;
}

async function evalIntents(provider: LLMProvider | null) {
  const engine = new IntentEngine({ provider, cacheTtlMs: 0 });
  const perKind: Record<string, { n: number; correct: number }> = {};
  const confusion: Record<string, Record<string, number>> = {};
  const latency: Record<string, number[]> = { local: [], llm: [], heuristic: [] };
  const failures: Array<{ text: string; expected: string; got: string; source: string }> = [];
  let correct = 0;
  let fieldChecks = 0;
  let fieldCorrect = 0;
  let localHits = 0;
  let localCorrect = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  for (const row of dataset) {
    const r = await engine.classify(row.text, { history: '', hasSelection: false, languageId: 'typescript', fileName: 'src/app.ts' });
    latency[r.intent.source]!.push(r.latencyMs);
    if (r.usage) {
      tokensIn += r.usage.inputTokens;
      tokensOut += r.usage.outputTokens;
    }
    const ok = r.intent.kind === row.kind;
    perKind[row.kind] ??= { n: 0, correct: 0 };
    perKind[row.kind]!.n++;
    if (ok) {
      correct++;
      perKind[row.kind]!.correct++;
    } else {
      failures.push({ text: row.text, expected: row.kind, got: r.intent.kind, source: r.intent.source });
    }
    confusion[row.kind] ??= {};
    confusion[row.kind]![r.intent.kind] = (confusion[row.kind]![r.intent.kind] ?? 0) + 1;
    if (row.expect) {
      fieldChecks++;
      if (ok && matchesExpect(r.intent, row.expect)) fieldCorrect++;
    }
    if (r.intent.source === 'local') {
      localHits++;
      if (ok && matchesExpect(r.intent, row.expect)) localCorrect++;
    }
  }
  const stats = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return { n: s.length, p50: ms(percentile(s, 50)), p95: ms(percentile(s, 95)), max: ms(s.at(-1) ?? 0) };
  };
  const byTag = (tag: string) => {
    const rows = dataset.map((r, i) => ({ r, i })).filter(({ r }) => r.tags?.includes(tag));
    const wrong = new Set(failures.map((f) => f.text));
    return { n: rows.length, accuracy: pct(rows.filter(({ r }) => !wrong.has(r.text)).length, rows.length) };
  };
  return {
    commands: dataset.length,
    accuracy: pct(correct, dataset.length),
    fieldAccuracy: { checks: fieldChecks, accuracy: pct(fieldCorrect, fieldChecks) },
    localCoverage: pct(localHits, dataset.length),
    localPrecision: pct(localCorrect, localHits),
    perKind: Object.fromEntries(Object.entries(perKind).map(([k, v]) => [k, { n: v.n, accuracy: pct(v.correct, v.n) }])),
    byTag: Object.fromEntries(['navigation', 'control', 'asr-noise', 'follow-up', 'multilingual', 'model'].map((t) => [t, byTag(t)])),
    latencyMs: Object.fromEntries(Object.entries(latency).filter(([, v]) => v.length).map(([k, v]) => [k, stats(v)])),
    tokens: { input: tokensIn, output: tokensOut, perModelCall: latency.llm!.length ? Math.round((tokensIn + tokensOut) / latency.llm!.length) : null },
    confusion,
    failures,
  };
}

// ── 2. Duplicate execution (speech pipeline simulation) ──────────────────────
class VirtualClock {
  t = 0;
  private q: Array<{ at: number; fn: () => void; id: number; cancelled: boolean }> = [];
  private seq = 0;
  setTimeout = (fn: () => void, delay: number) => {
    const h = { at: this.t + delay, fn, id: ++this.seq, cancelled: false };
    this.q.push(h);
    return h;
  };
  clearTimeout = (h: unknown) => {
    if (h) (h as { cancelled: boolean }).cancelled = true;
  };
  advance(to: number): void {
    for (;;) {
      this.q.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.q.find((x) => !x.cancelled && x.at <= to);
      if (!next) break;
      this.q = this.q.filter((x) => x !== next);
      this.t = next.at;
      next.fn();
    }
    this.t = to;
  }
}

class SimRecognition implements RecognitionLike {
  continuous = false;
  interimResults = false;
  lang = '';
  maxAlternatives = 1;
  onstart: (() => void) | null = null;
  onresult: ((e: RecognitionEventLike) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  results: Array<{ text: string; final: boolean }> = [];
  start() {
    this.onstart?.();
  }
  stop() {}
  abort() {}
  emit(index: number) {
    const list = this.results.map((r) => Object.assign([{ transcript: r.text, confidence: 0.9 }], { isFinal: r.final }));
    this.onresult?.({ resultIndex: index, results: list as unknown as RecognitionEventLike['results'] });
  }
}

type Scenario = { name: string; events: Array<{ at: number; kind: 'interim' | 'final'; index: number; text: string } | { at: number; kind: 'stop' } | { at: number; kind: 'end' }>; utterances: number };

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function scenarios(n: number): Scenario[] {
  const rand = rng(7);
  const phrases = dataset.map((d) => d.text).filter((t) => /^[\x20-\x7e]+$/.test(t));
  const out: Scenario[] = [];
  for (let i = 0; i < n; i++) {
    const type = i % 5;
    const text = phrases[Math.floor(rand() * phrases.length)]!;
    const words = text.split(' ');
    const ev: Scenario['events'] = [];
    let t = 0;
    for (let w = 1; w <= words.length; w++) {
      t += 150 + rand() * 200;
      ev.push({ at: t, kind: 'interim', index: 0, text: words.slice(0, w).join(' ') });
    }
    if (type === 0) {
      // Engine final arrives quickly (no silence timeout).
      ev.push({ at: t + 300 + rand() * 600, kind: 'final', index: 0, text });
    } else if (type === 1) {
      // Engine final arrives late, after the silence timer fired (network latency).
      ev.push({ at: t + 1600 + rand() * 1500, kind: 'final', index: 0, text });
    } else if (type === 2) {
      // The developer stops mid-utterance; the engine still delivers the final afterwards.
      ev.push({ at: t + 100, kind: 'stop' });
      ev.push({ at: t + 400 + rand() * 400, kind: 'final', index: 0, text });
    } else if (type === 3) {
      // Session ends (Chrome's silence timeout) right after the final; engine restarts.
      ev.push({ at: t + 400, kind: 'final', index: 0, text });
      ev.push({ at: t + 500, kind: 'end' });
    } else {
      // Two utterances in one session; the second event re-reports result 0 as final.
      const text2 = phrases[Math.floor(rand() * phrases.length)]!;
      ev.push({ at: t + 400, kind: 'final', index: 0, text });
      ev.push({ at: t + 1200, kind: 'interim', index: 1, text: text2.split(' ')[0]! });
      ev.push({ at: t + 1900, kind: 'final', index: 1, text: text2 });
      out.push({ name: 'two-utterances', events: ev, utterances: 2 });
      continue;
    }
    out.push({ name: ['fast-final', 'late-final', 'stop-mid-utterance', 'session-restart'][type]!, events: ev, utterances: 1 });
  }
  return out;
}

function runScenario(s: Scenario, engine: 'legacy' | 'current'): number {
  const clock = new VirtualClock();
  let rec: SimRecognition | null = null;
  const factory = () => (rec = new SimRecognition());
  let executions = 0;
  const gate = new UtteranceGate({}, () => clock.t);
  let stop: () => void;
  if (engine === 'legacy') {
    const e = new LegacySpeechEngine(factory, { onInterim() {}, onFinal: () => executions++ }, clock.setTimeout, clock.clearTimeout);
    e.start();
    stop = () => {
      e.flush();
      e.stop();
    };
  } else {
    const c = new WebSpeechController(
      factory,
      { onInterim() {}, onFinal: (t) => (gate.offer(t).accept ? executions++ : 0), onState() {}, onError() {} },
      { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, silenceMs: 1500 },
    );
    c.start();
    stop = () => c.stop({ flush: true });
  }
  const instance = rec!;
  for (const ev of s.events) {
    clock.advance(ev.at);
    if (ev.kind === 'stop') stop();
    else if (ev.kind === 'end') instance.onend?.();
    else {
      instance.results[ev.index] = { text: ev.text, final: ev.kind === 'final' };
      instance.emit(ev.kind === 'final' && s.name === 'two-utterances' && ev.index === 1 ? 0 : ev.index);
    }
  }
  clock.advance(clock.t + 5000);
  return executions;
}

function evalDuplicates(n = 500) {
  const all = scenarios(n);
  const result: Record<string, { utterances: number; executions: number; duplicates: number; missed: number; duplicateRate: number | null }> = {};
  for (const engine of ['legacy', 'current'] as const) {
    let utterances = 0;
    let executions = 0;
    let duplicates = 0;
    let missed = 0;
    const byType: Record<string, { dup: number; n: number }> = {};
    for (const s of all) {
      const ex = runScenario(s, engine);
      utterances += s.utterances;
      executions += ex;
      duplicates += Math.max(0, ex - s.utterances);
      missed += Math.max(0, s.utterances - ex);
      byType[s.name] ??= { dup: 0, n: 0 };
      byType[s.name]!.n++;
      byType[s.name]!.dup += Math.max(0, ex - s.utterances);
      if (process.env.EVAL_DEBUG && engine === 'current' && ex < s.utterances) console.error('MISSED', JSON.stringify(s));
    }
    result[engine] = { utterances, executions, duplicates, missed, duplicateRate: pct(duplicates, utterances) };
    (result[engine] as Record<string, unknown>).byScenario = byType;
  }
  return { scenarios: all.length, ...result };
}

// ── 3. Edit application robustness ──────────────────────────────────────────
function evalPatches() {
  const src = `import express from 'express';\n\nexport function login(req, res) {\n  const user = findUser(req.body.email);\n  if (!user) {\n    return res.status(401).end();\n  }\n  res.json(user);\n}\n\nexport function logout(req, res) {\n  res.json({ ok: true });\n}\n`;
  const cases: Array<{ name: string; text: string; edits: EditBlock[]; shouldApply: boolean; check?: (out: string) => boolean }> = [
    { name: 'exact anchor', text: src, edits: [{ search: 'export function login(req, res) {', replace: 'export async function login(req, res) {' }], shouldApply: true, check: (o) => o.includes('async function login') },
    { name: 'model re-indented anchor', text: src, edits: [{ search: 'const user = findUser(req.body.email);\nif (!user) {', replace: 'const user = await findUser(req.body.email);\nif (!user) {' }], shouldApply: true, check: (o) => o.includes('  const user = await findUser') },
    { name: 'trailing whitespace in file', text: src.replace('res.json(user);', 'res.json(user);   '), edits: [{ search: '  res.json(user);\n}', replace: '  res.json({ user });\n}' }], shouldApply: true, check: (o) => o.includes('res.json({ user })') },
    { name: 'CRLF file', text: src.replace(/\n/g, '\r\n'), edits: [{ search: 'export function logout(req, res) {\n  res.json({ ok: true });', replace: 'export function logout(req, res) {\n  req.session = null;\n  res.json({ ok: true });' }], shouldApply: true, check: (o) => o.includes('req.session = null') },
    { name: 'import + body in one plan', text: src, edits: [{ search: "import express from 'express';", replace: "import express from 'express';\nimport jwt from 'jsonwebtoken';" }, { search: '  res.json(user);', replace: '  res.json({ token: jwt.sign({ id: user.id }, process.env.SECRET) });' }], shouldApply: true, check: (o) => o.includes("import jwt") && o.includes('jwt.sign') },
    { name: 'insert at cursor', text: src, edits: [{ search: '', replace: '\nexport function me(req, res) {\n  res.json(req.user);\n}\n' }], shouldApply: true, check: (o) => o.endsWith('res.json(req.user);\n}\n') },
    { name: 'ambiguous anchor (must refuse)', text: src, edits: [{ search: 'res.json(', replace: 'reply(' }], shouldApply: false },
    { name: 'stale anchor (must refuse)', text: src, edits: [{ search: 'export function register(req, res) {', replace: 'x' }], shouldApply: false },
    { name: 'overlapping edits (must refuse)', text: src, edits: [{ search: 'export function login(req, res) {\n  const user', replace: 'a' }, { search: 'const user = findUser', replace: 'b' }], shouldApply: false },
    { name: 'empty plan (must refuse)', text: src, edits: [], shouldApply: false },
  ];
  const rows = cases.map((c) => {
    try {
      const out = applyChanges(c.text, resolveEdits(c.text, c.edits, c.text.length));
      const ok = c.shouldApply && (c.check ? c.check(out) : true);
      return { name: c.name, ok, outcome: 'applied' };
    } catch (err) {
      return { name: c.name, ok: !c.shouldApply, outcome: `refused: ${(err as Error).message.slice(0, 60)}` };
    }
  });
  return { cases: rows.length, correct: rows.filter((r) => r.ok).length, rows };
}

// ── 4. Agent error recovery (scripted model, real runtime) ───────────────────
async function evalAgentRecovery() {
  type Resp = unknown | Error;
  const scripted = (responses: Resp[]): LLMProvider => ({
    id: 'anthropic',
    displayName: 'scripted',
    complete: async () => ({ text: '', usage: { inputTokens: 0, outputTokens: 0 }, latencyMs: 0, model: 's' }),
    structured: async (req) => {
      const r = responses.length > 1 ? responses.shift() : responses[0];
      if (r instanceof Error) throw r;
      return { value: req.schema.parse(r), usage: { inputTokens: 0, outputTokens: 0 }, latencyMs: 0, model: 's' };
    },
  });
  const plan = { goal: 'g', steps: [{ title: 'a', detail: 'b' }] };
  const step = (tool: string | null, args: object, done = false) => ({ thought: '', planStep: 1, tool, argsJson: JSON.stringify(args), done, report: done ? 'done' : null });
  let flaky = 0;
  const tools = [
    defineTool({ name: 'write', description: '', input: z.object({ path: z.string() }), consequential: false, run: async () => ({ ok: true, output: 'ok' }) }),
    defineTool({ name: 'flaky_test', description: '', input: z.object({}), consequential: false, run: async () => (++flaky % 2 === 1 ? { ok: false, output: 'FAIL' } : { ok: true, output: 'PASS' }) }),
    defineTool({ name: 'hang', description: '', input: z.object({}), consequential: false, timeoutMs: 20, run: () => new Promise(() => {}) }),
    defineTool({ name: 'boom', description: '', input: z.object({}), consequential: false, run: async () => { throw new Error('tool crashed'); } }),
  ];
  const cases: Array<{ name: string; responses: Resp[]; expectOk: boolean }> = [
    { name: 'transient model errors (429, 5xx) then success', responses: [new LLMError('429', 'rate-limit', true), plan, new LLMError('503', 'server', true), step('write', { path: 'a' }), step(null, {}, true)], expectOk: true },
    { name: 'failing test → fix → passing test', responses: [plan, step('flaky_test', {}), step('write', { path: 'fix' }), step('flaky_test', {}), step(null, {}, true)], expectOk: true },
    { name: 'invalid tool arguments → corrected', responses: [plan, step('write', { path: 42 }), step('write', { path: 'ok' }), step(null, {}, true)], expectOk: true },
    { name: 'malformed argsJson → corrected', responses: [plan, { ...step('write', {}), argsJson: '{not json' }, step('write', { path: 'ok' }), step(null, {}, true)], expectOk: true },
    { name: 'tool timeout → alternative action', responses: [plan, step('hang', {}), step('write', { path: 'ok' }), step(null, {}, true)], expectOk: true },
    { name: 'tool exception → alternative action', responses: [plan, step('boom', {}), step('write', { path: 'ok' }), step(null, {}, true)], expectOk: true },
    { name: 'non-retryable auth error → clean failure', responses: [new LLMError('401', 'auth', false)], expectOk: false },
    { name: 'runaway loop → step bound', responses: [plan, step('write', { path: 'x' })], expectOk: false },
  ];
  const rows = [];
  for (const c of cases) {
    const agent = new VoiceAgent({ provider: scripted([...c.responses]), tools, environment: '', maxSteps: 6, approvePlan: async () => true, approveAction: async () => true, onEvent: () => {}, signal: new AbortController().signal, sleep: async () => {} });
    const r = await agent.run('goal');
    rows.push({ name: c.name, expected: c.expectOk ? 'complete' : 'fail safely', result: r.ok ? 'complete' : 'failed', ok: r.ok === c.expectOk });
  }
  return { cases: rows.length, handled: rows.filter((r) => r.ok).length, rows };
}

// ── 5. Live code-edit tasks (model required) ─────────────────────────────────
const EDIT_TASKS: Array<{ name: string; src: string; cursorLine: number; command: string; check: string }> = [
  { name: 'add a function', src: 'export function add(a, b) {\n  return a + b;\n}\n\n', cursorLine: 5, command: 'write a function called multiply that multiplies two numbers', check: 'multiply(3, 4) === 12' },
  { name: 'handle empty input', src: 'export function average(xs) {\n  return xs.reduce((s, x) => s + x, 0) / xs.length;\n}\n', cursorLine: 2, command: 'make it return zero for an empty array', check: 'average([]) === 0 && average([2, 4]) === 3' },
  { name: 'add validation', src: 'export function createUser(name, age) {\n  return { name, age };\n}\n', cursorLine: 2, command: 'throw an error if age is negative', check: '(() => { try { createUser("a", -1); return false; } catch { return createUser("a", 3).age === 3; } })()' },
  { name: 'refactor loop', src: 'export function evens(xs) {\n  const out = [];\n  for (let i = 0; i < xs.length; i++) {\n    if (xs[i] % 2 === 0) out.push(xs[i]);\n  }\n  return out;\n}\n', cursorLine: 3, command: 'refactor this to use filter', check: 'JSON.stringify(evens([1,2,3,4])) === "[2,4]" && !evens.toString().includes("for (")' },
  { name: 'fix bug', src: 'export function last(xs) {\n  return xs[xs.length];\n}\n', cursorLine: 2, command: 'fix the bug in this function', check: 'last([1, 2, 3]) === 3' },
  { name: 'regex', src: '\n', cursorLine: 1, command: 'write a function isEmail that validates an email address with a regex', check: 'isEmail("a@b.co") && !isEmail("nope")' },
  { name: 'async conversion', src: 'export function load(fetchFn) {\n  return fetchFn().then((r) => r.json());\n}\n', cursorLine: 2, command: 'convert this to async await', check: 'load.constructor.name === "AsyncFunction"' },
  { name: 'add parameter default', src: 'export function greet(name) {\n  return "Hello, " + name;\n}\n', cursorLine: 2, command: 'make name default to world', check: 'greet() === "Hello, world"' },
  { name: 'memoize', src: 'export function fib(n) {\n  return n < 2 ? n : fib(n - 1) + fib(n - 2);\n}\n', cursorLine: 2, command: 'make fib fast for n equals 80 using memoization', check: 'fib(80) === 23416728348467685' },
  { name: 'clamp helper', src: '\n', cursorLine: 1, command: 'add a clamp function that limits a value between a min and max', check: 'clamp(5, 0, 3) === 3 && clamp(-1, 0, 3) === 0 && clamp(2, 0, 3) === 2' },
];

async function evalLiveEdits(provider: LLMProvider) {
  const engine = new IntentEngine({ provider, cacheTtlMs: 0 });
  const rows = [];
  for (const task of EDIT_TASKS) {
    const t0 = now();
    let ok = false;
    let detail = '';
    let tokens = 0;
    try {
      const lines = task.src.split('\n');
      const ctx: EditorContext = {
        host: 'vscode',
        fileName: 'task.js',
        relativePath: 'src/task.js',
        languageId: 'javascript',
        lineCount: lines.length,
        cursor: { line: task.cursorLine, column: 1 },
        window: windowAround(lines, task.cursorLine, 40, 20),
        document: task.src,
        indentUnit: detectIndent(task.src),
        eol: '\n',
      };
      const c = await engine.classify(task.command, { history: '', hasSelection: false, languageId: 'javascript', fileName: 'src/task.js', cursorLine: task.cursorLine });
      tokens += (c.usage?.inputTokens ?? 0) + (c.usage?.outputTokens ?? 0);
      const kind = c.intent.kind === 'generate' || c.intent.kind === 'modify' || c.intent.kind === 'refactor' || c.intent.kind === 'debug' ? c.intent.kind : 'modify';
      const instruction = 'instruction' in c.intent && c.intent.instruction ? c.intent.instruction : task.command;
      const res = await provider.structured({ purpose: kind, system: buildEditSystem(kind), messages: [{ role: 'user', content: buildEditUserPrompt({ instruction, transcript: task.command, context: ctx, history: '' }) }], schema: EditPlanSchema, schemaName: 'edit_plan' });
      tokens += res.usage.inputTokens + res.usage.outputTokens;
      const cursorOffset = lines.slice(0, task.cursorLine - 1).join('\n').length + (task.cursorLine > 1 ? 1 : 0);
      const out = applyChanges(task.src, resolveEdits(task.src, res.value.edits, cursorOffset));
      const js = out.replace(/export\s+(async\s+)?function/g, '$1function').replace(/export\s+const/g, 'const');
      ok = runInNewContext(`${js}\n;(${task.check})`, {}, { timeout: 2000 }) === true;
      if (!ok) detail = 'check failed';
    } catch (err) {
      detail = (err as Error).message.slice(0, 120);
    }
    rows.push({ name: task.name, ok, latencyMs: Math.round(now() - t0), tokens, detail });
  }
  const lat = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
  return { tasks: rows.length, succeeded: rows.filter((r) => r.ok).length, p50Ms: percentile(lat, 50), p95Ms: percentile(lat, 95), avgTokens: Math.round(rows.reduce((s, r) => s + r.tokens, 0) / rows.length), rows };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // Warm up the local path so the first measurement is not JIT compilation.
  for (let i = 0; i < 200; i++) parseLocalIntent(normalizeTranscript('go to line 42'));

  const env = { node: process.version, platform: `${process.platform}-${process.arch}`, cpu: os.cpus()[0]?.model, date: new Date().toISOString() };
  const offline = {
    mode: 'offline' as const,
    env,
    intent: await evalIntents(null),
    duplicates: evalDuplicates(500),
    patches: evalPatches(),
    agentRecovery: await evalAgentRecovery(),
  };
  let result: Record<string, unknown> = offline;

  if (live) {
    const providerId = (process.env.VOICECODER_PROVIDER as 'anthropic' | 'openai' | undefined) ?? (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai');
    const apiKey = providerId === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('--live needs ANTHROPIC_API_KEY or OPENAI_API_KEY');
    const provider = createProvider({ provider: providerId, apiKey, model: process.env.VOICECODER_MODEL || undefined });
    result = { ...offline, mode: 'live', provider: providerId, model: process.env.VOICECODER_MODEL || '(provider default)', intent: await evalIntents(provider), liveEdits: await evalLiveEdits(provider) };
  }

  mkdirSync(join(here, 'results'), { recursive: true });
  const name = live ? 'live' : 'offline';
  writeFileSync(join(here, 'results', `${name}.json`), JSON.stringify(result, null, 2));
  writeFileSync(join(here, 'results', `${name}.md`), report(result));
  console.log(report(result));
}

function report(r: Record<string, any>): string { // eslint-disable-line @typescript-eslint/no-explicit-any
  const i = r.intent;
  const lines = [
    `# VoiceCoder evaluation — ${r.mode}`,
    '',
    `Measured ${r.env.date} on ${r.env.platform} (${r.env.cpu}), Node ${r.env.node}.${r.mode === 'live' ? ` Provider: ${r.provider}, model: ${r.model}.` : ' No model calls (offline mode).'}`,
    '',
    `## Intent classification (${i.commands} commands)`,
    '',
    `| Metric | Value |`,
    `|---|---|`,
    `| Intent accuracy (kind) | ${i.accuracy}% |`,
    `| Field accuracy (line numbers, targets, actions; ${i.fieldAccuracy.checks} checks) | ${i.fieldAccuracy.accuracy}% |`,
    `| Handled by local grammar (no model) | ${i.localCoverage}% |`,
    `| Local grammar precision | ${i.localPrecision}% |`,
    ...Object.entries(i.latencyMs as Record<string, { n: number; p50: number; p95: number }>).map(([k, v]) => `| Classification latency · ${k} (n=${v.n}) | p50 ${v.p50} ms · p95 ${v.p95} ms |`),
    ...(r.mode === 'live' ? [`| Tokens per model classification | ${i.tokens.perModelCall} |`] : []),
    '',
    `| Kind | n | accuracy |`,
    `|---|---|---|`,
    ...Object.entries(i.perKind as Record<string, { n: number; accuracy: number }>).map(([k, v]) => `| ${k} | ${v.n} | ${v.accuracy}% |`),
    '',
    `| Slice | n | accuracy |`,
    `|---|---|---|`,
    ...Object.entries(i.byTag as Record<string, { n: number; accuracy: number }>).map(([k, v]) => `| ${k} | ${v.n} | ${v.accuracy}% |`),
    '',
    `## Duplicate execution (${r.duplicates.scenarios} simulated speech sessions)`,
    '',
    `| Engine | utterances | executions | duplicates | missed | duplicate rate |`,
    `|---|---|---|---|---|---|`,
    ...(['legacy', 'current'] as const).map((e) => { const d = r.duplicates[e]; return `| ${e === 'legacy' ? 'Original engine (v1)' : 'Current (controller + gate)'} | ${d.utterances} | ${d.executions} | ${d.duplicates} | ${d.missed} | ${d.duplicateRate}% |`; }),
    '',
    `## Edit application (${r.patches.cases} cases)`,
    '',
    `${r.patches.correct}/${r.patches.cases} handled correctly (applied when valid, refused when ambiguous/stale/overlapping).`,
    '',
    ...r.patches.rows.map((x: { ok: boolean; name: string; outcome: string }) => `- ${x.ok ? '✔' : '✘'} ${x.name} — ${x.outcome}`),
    '',
    `## Agent error recovery (${r.agentRecovery.cases} scripted fault scenarios)`,
    '',
    `${r.agentRecovery.handled}/${r.agentRecovery.cases} handled as expected.`,
    '',
    ...r.agentRecovery.rows.map((x: { ok: boolean; name: string; result: string }) => `- ${x.ok ? '✔' : '✘'} ${x.name} → ${x.result}`),
  ];
  if (r.liveEdits) {
    const e = r.liveEdits;
    lines.push('', `## Live code edits (${e.tasks} tasks, executed and checked)`, '', `${e.succeeded}/${e.tasks} succeeded · latency p50 ${e.p50Ms} ms, p95 ${e.p95Ms} ms · avg ${e.avgTokens} tokens/task`, '', ...e.rows.map((x: { ok: boolean; name: string; latencyMs: number; detail: string }) => `- ${x.ok ? '✔' : '✘'} ${x.name} (${x.latencyMs} ms)${x.detail ? ` — ${x.detail}` : ''}`));
  }
  if (i.failures.length) {
    lines.push('', '## Misclassified commands', '', '| Command | Expected | Got | Path |', '|---|---|---|---|', ...i.failures.map((f: { text: string; expected: string; got: string; source: string }) => `| ${f.text} | ${f.expected} | ${f.got} | ${f.source} |`));
  }
  return lines.join('\n') + '\n';
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

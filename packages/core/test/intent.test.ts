import { describe, expect, it } from 'vitest';
import { parseLocalIntent, toIdentifier } from '../src/intent/local-parser.js';
import { classifyHeuristically } from '../src/intent/heuristic.js';
import { fromLlmIntent, IntentSchema, isConsequential, type LlmIntent } from '../src/intent/schema.js';
import { IntentEngine } from '../src/intent/engine.js';
import { LLMError } from '../src/llm/types.js';
import { FakeProvider } from './fakes.js';

const nullLlm: LlmIntent = {
  kind: 'generate',
  instruction: '',
  scope: null,
  text: null,
  newName: null,
  navigation: null,
  testAction: null,
  explainTarget: null,
  terminalPurpose: null,
  terminalCommand: null,
  gitAction: null,
  controlAction: null,
  confidence: 0.9,
};

describe('local parser', () => {
  it.each([
    ['go to line 45', { kind: 'navigate', target: { type: 'line', line: 45 } }],
    ['Go to line forty five.', { kind: 'navigate', target: { type: 'line', line: 45 } }],
    ['jump to line one hundred and twenty', { kind: 'navigate', target: { type: 'line', line: 120 } }],
    ['line 12', { kind: 'navigate', target: { type: 'line', line: 12 } }],
    ['please go to line 3 column 7', { kind: 'navigate', target: { type: 'line', line: 3, column: 7 } }],
    ['open the authentication file', { kind: 'navigate', target: { type: 'file', query: 'authentication' } }],
    ['open package.json', { kind: 'navigate', target: { type: 'file', query: 'package.json' } }],
    ['go to the function called handle login', { kind: 'navigate', target: { type: 'symbol', query: 'handle login' } }],
    ['go to definition', { kind: 'navigate', target: { type: 'definition' } }],
    ['find all references', { kind: 'navigate', target: { type: 'references' } }],
    ['next error', { kind: 'navigate', target: { type: 'next-error' } }],
    ['go to the top of the file', { kind: 'navigate', target: { type: 'top' } }],
    ['undo my last change', { kind: 'control', action: 'undo' }],
    ['scratch that', { kind: 'control', action: 'undo' }],
    ['accept these changes', { kind: 'control', action: 'accept' }],
    ['reject the changes', { kind: 'control', action: 'reject' }],
    ['cancel', { kind: 'control', action: 'cancel' }],
    ['stop listening', { kind: 'control', action: 'stop-listening' }],
    ['save the file', { kind: 'control', action: 'save' }],
    ['format the document', { kind: 'control', action: 'format' }],
    ['select this function', { kind: 'control', action: 'select-function' }],
    ['run the unit tests', { kind: 'test', action: 'run' }],
    ['run the application', { kind: 'terminal', purpose: 'run-app' }],
    ['show git changes', { kind: 'git', action: 'diff' }],
    ['generate a commit message', { kind: 'git', action: 'commit-message' }],
    ['create a git commit', { kind: 'git', action: 'commit' }],
    ['explain this function', { kind: 'explain', target: 'function' }],
    ['explain this error', { kind: 'explain', target: 'error' }],
    ['rename this variable to user count', { kind: 'rename', newName: 'userCount' }],
    ['rename this variable', { kind: 'rename' }],
  ])('%s', (input, expected) => {
    const intent = parseLocalIntent(input);
    expect(intent).not.toBeNull();
    expect(intent).toMatchObject({ ...expected, source: 'local', confidence: 1 });
    expect(IntentSchema.safeParse(intent).success).toBe(true);
  });

  it.each([
    'create a login API',
    'add JWT authentication',
    'actually use PostgreSQL',
    'make it asynchronous',
    'add error handling to this function',
    'write a function that reverses a linked list',
    'refactor this function',
    'for loop from 0 to n',
    'go to town on this function and optimize it',
  ])('defers open-ended "%s" to the model', (input) => {
    expect(parseLocalIntent(input)).toBeNull();
  });

  it('does not treat "for" or "to" as numbers', () => {
    expect(parseLocalIntent('go to line for')).toBeNull();
  });

  it('converts spoken identifiers', () => {
    expect(toIdentifier('user count')).toBe('userCount');
    expect(toIdentifier('total items snake case')).toBe('total_items');
    expect(toIdentifier('x', 'rename this to MAX_SIZE')).toBe('MAX_SIZE');
  });
});

describe('heuristic classifier', () => {
  it('detects multi-step agent requests', () => {
    const i = classifyHeuristically('create a REST API with authentication, add input validation, write unit tests, and run them', { hasSelection: false });
    expect(i.kind).toBe('agent');
  });
  it('treats follow-ups as modifications', () => {
    expect(classifyHeuristically('actually use PostgreSQL', { hasSelection: false }).kind).toBe('modify');
    expect(classifyHeuristically('make it async', { hasSelection: false }).kind).toBe('modify');
  });
  it('classifies generation, debugging, tests and explanation', () => {
    expect(classifyHeuristically('create a login API', { hasSelection: false }).kind).toBe('generate');
    expect(classifyHeuristically('fix the null pointer error', { hasSelection: false }).kind).toBe('debug');
    expect(classifyHeuristically('write unit tests for the parser', { hasSelection: false }).kind).toBe('test');
    expect(classifyHeuristically('how does this work', { hasSelection: true }).kind).toBe('explain');
  });
  it('uses dictation for prose targets', () => {
    expect(classifyHeuristically('thanks for the review see you tomorrow', { hasSelection: false, proseTarget: true }).kind).toBe('dictation');
  });
});

describe('LLM intent mapping', () => {
  it('maps and validates each kind', () => {
    expect(fromLlmIntent({ ...nullLlm, kind: 'generate', instruction: 'Create a login API' }, 'x')).toMatchObject({ kind: 'generate', source: 'llm' });
    expect(fromLlmIntent({ ...nullLlm, kind: 'modify', instruction: 'Make login async', scope: 'function' }, 'x')).toMatchObject({ kind: 'modify', scope: 'function' });
    expect(fromLlmIntent({ ...nullLlm, kind: 'navigate', navigation: { type: 'line', line: 4, query: null } }, 'x')).toMatchObject({ target: { type: 'line', line: 4 } });
  });
  it('rejects invalid shapes instead of guessing', () => {
    expect(fromLlmIntent({ ...nullLlm, kind: 'navigate', navigation: { type: 'line', line: 0, query: null } }, 'x')).toBeNull();
    expect(fromLlmIntent({ ...nullLlm, kind: 'git', gitAction: null }, 'x')).toBeNull();
    expect(fromLlmIntent({ ...nullLlm, kind: 'control', controlAction: null }, 'x')).toBeNull();
  });
  it('clamps confidence', () => {
    expect(fromLlmIntent({ ...nullLlm, instruction: 'x', confidence: 7 }, 'x')!.confidence).toBe(1);
  });
  it('flags consequential intents', () => {
    expect(isConsequential(parseLocalIntent('create a git commit')!)).toBe(true);
    expect(isConsequential(parseLocalIntent('run the application')!)).toBe(true);
    expect(isConsequential(parseLocalIntent('go to line 4')!)).toBe(false);
  });
});

describe('IntentEngine', () => {
  const ctx = { history: '', hasSelection: false };

  it('answers local commands without calling the model', async () => {
    const p = new FakeProvider([() => ({ ...nullLlm })]);
    const engine = new IntentEngine({ provider: p });
    const r = await engine.classify('go to line 45', ctx);
    expect(r.intent.source).toBe('local');
    expect(p.calls).toHaveLength(0);
  });

  it('uses the model for open-ended commands and caches the result', async () => {
    const p = new FakeProvider([() => ({ ...nullLlm, kind: 'generate', instruction: 'Create a login API endpoint' })]);
    const engine = new IntentEngine({ provider: p });
    const a = await engine.classify('create a login API', ctx);
    const b = await engine.classify('create a login API', ctx);
    expect(a.intent).toMatchObject({ kind: 'generate', source: 'llm' });
    expect(b.cached).toBe(true);
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.tier).toBe('fast');
  });

  it('normalizes speech errors before classification', async () => {
    const p = new FakeProvider([(req) => ({ ...nullLlm, instruction: req.messages[0]!.content })]);
    const engine = new IntentEngine({ provider: p });
    const r = await engine.classify('add jay w t auth with post gress', ctx);
    expect(r.normalized).toBe('add JWT auth with PostgreSQL');
  });

  it('falls back to the heuristic when the model fails', async () => {
    const p = new FakeProvider([() => new LLMError('down', 'network', true)]);
    const engine = new IntentEngine({ provider: p });
    const r = await engine.classify('write a binary search function', ctx);
    expect(r.intent.source).toBe('heuristic');
    expect(r.intent.kind).toBe('generate');
    expect(r.fallbackReason).toBe('down');
  });

  it('propagates cancellation instead of falling back', async () => {
    const p = new FakeProvider([() => new LLMError('cancelled', 'cancelled', false)]);
    const engine = new IntentEngine({ provider: p });
    await expect(engine.classify('write a binary search function', ctx)).rejects.toThrow('cancelled');
  });

  it('works with no provider at all', async () => {
    const r = await new IntentEngine().classify('create a user class', ctx);
    expect(r.intent.source).toBe('heuristic');
    expect(r.fallbackReason).toMatch(/No model/);
  });
});

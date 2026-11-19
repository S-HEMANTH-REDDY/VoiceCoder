import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CommandCoordinator } from '../src/util/coordinator.js';
import { MetricsRecorder, percentile, Stopwatch } from '../src/metrics/latency.js';
import { VoiceAgent, type AgentEvent, type AgentTool } from '../src/agent/agent.js';
import { LLMError } from '../src/llm/types.js';
import { extractJson, toStrictJsonSchema } from '../src/llm/json-schema.js';
import { LlmIntentSchema } from '../src/intent/schema.js';
import { FakeProvider } from './fakes.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('CommandCoordinator', () => {
  it('drops duplicate commands within the window', async () => {
    const c = new CommandCoordinator(1000);
    let runs = 0;
    const [a, b] = await Promise.all([
      c.run('edit', 'make it async', async () => {
        runs++;
        await sleep(5);
        return 1;
      }),
      c.run('edit', 'make it async', async () => {
        runs++;
        return 2;
      }),
    ]);
    expect(a.status).toBe('ok');
    expect(b.status).toBe('duplicate');
    expect(runs).toBe(1);
  });

  it('cancels the previous command in the same lane', async () => {
    const c = new CommandCoordinator();
    let sawAbort = false;
    const first = c.run('edit', 'a', async (t) => {
      await new Promise<void>((resolve) => t.signal.addEventListener('abort', () => resolve()));
      sawAbort = true;
      return 'late';
    });
    await sleep(1);
    const second = await c.run('edit', 'b', async () => 'b');
    expect((await first).status).toBe('cancelled');
    expect(second).toEqual({ status: 'ok', value: 'b' });
    expect(sawAbort).toBe(true);
  });

  it('queues behind committed commands instead of cancelling them', async () => {
    const c = new CommandCoordinator();
    const order: string[] = [];
    const first = c.run('term', 'a', async (t) => {
      t.commit();
      await sleep(20);
      order.push('a');
    });
    await sleep(1);
    await c.run('term', 'b', async () => {
      order.push('b');
    });
    await first;
    expect(order).toEqual(['a', 'b']);
  });

  it('times out', async () => {
    const c = new CommandCoordinator();
    const r = await c.run('x', 'slow', () => sleep(200), { timeoutMs: 20 });
    expect(r.status).toBe('error');
  });

  it('runs different lanes concurrently', async () => {
    const c = new CommandCoordinator();
    const t0 = Date.now();
    await Promise.all([c.run('a', '1', () => sleep(30)), c.run('b', '1', () => sleep(30))]);
    expect(Date.now() - t0).toBeLessThan(55);
  });
});

describe('metrics', () => {
  it('computes nearest-rank percentiles', () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 95)).toBe(95);
    expect(percentile([], 50)).toBe(0);
  });
  it('aggregates per stage and round-trips snapshots', () => {
    const m = new MetricsRecorder();
    [10, 20, 30, 40].forEach((ms) => m.record('intent', ms));
    m.increment('commands');
    const s = m.stats()[0]!;
    expect(s).toMatchObject({ stage: 'intent', count: 4, p50: 20, p95: 40 });
    const m2 = new MetricsRecorder();
    m2.restore(m.snapshot());
    expect(m2.stats()).toEqual(m.stats());
    expect(m2.counter('commands')).toBe(1);
  });
  it('stopwatch laps', () => {
    let t = 0;
    const sw = new Stopwatch(() => t);
    t = 5;
    expect(sw.lap('a')).toBe(5);
    t = 12;
    expect(sw.lap('b')).toBe(7);
    expect(sw.total()).toBe(12);
  });
});

describe('json schema + extraction', () => {
  it('produces a strict schema for the intent contract', () => {
    const s = toStrictJsonSchema(LlmIntentSchema) as { additionalProperties: boolean; required: string[]; properties: Record<string, unknown> };
    expect(s.additionalProperties).toBe(false);
    expect(s.required.sort()).toEqual(Object.keys(s.properties).sort());
    expect(JSON.stringify(s)).not.toContain('"$schema"');
  });
  it('extracts JSON from fenced or chatty output', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"a":{"b":"}"}} trailing')).toEqual({ a: { b: '}' } });
    expect(() => extractJson('nope')).toThrow();
  });
});

describe('VoiceAgent', () => {
  const files = new Map<string, string>();
  const writeFile: AgentTool = {
    name: 'write_file',
    description: 'Write a file',
    input: z.object({ path: z.string(), content: z.string() }),
    consequential: true,
    describe: (i) => `Write ${i.path}`,
    run: async (i) => {
      files.set(i.path, i.content);
      return { ok: true, output: `wrote ${i.path}`, summary: `Wrote ${i.path}` };
    },
  };
  let testRuns = 0;
  const runTests: AgentTool = {
    name: 'run_tests',
    description: 'Run tests',
    input: z.object({}),
    consequential: false,
    run: async () => {
      testRuns++;
      return testRuns === 1 ? { ok: false, output: 'FAIL: expected 2 got 3' } : { ok: true, output: 'PASS 3 tests' };
    },
  };
  const hang: AgentTool = {
    name: 'hang',
    description: 'never finishes',
    input: z.object({}),
    consequential: false,
    timeoutMs: 20,
    run: () => new Promise(() => {}),
  };

  const plan = { goal: 'g', steps: [{ title: 'write', detail: 'd' }, { title: 'test', detail: 'd' }] };
  const step = (tool: string | null, args: object, done = false, report: string | null = null) => ({
    thought: 't',
    planStep: 1,
    tool,
    argsJson: JSON.stringify(args),
    done,
    report,
  });

  function agentWith(responses: unknown[], opts: Partial<ConstructorParameters<typeof VoiceAgent>[0]> = {}) {
    const events: AgentEvent[] = [];
    const provider = new FakeProvider(responses.map((r) => () => r));
    const agent = new VoiceAgent({
      provider,
      tools: [writeFile, runTests, hang],
      environment: 'node project',
      approvePlan: async () => true,
      approveAction: async () => true,
      onEvent: (e) => events.push(e),
      signal: new AbortController().signal,
      sleep: async () => {},
      ...opts,
    });
    return { agent, events, provider };
  }

  it('plans, executes, observes a failure, recovers and reports', async () => {
    testRuns = 0;
    const { agent, events } = agentWith([
      plan,
      step('write_file', { path: 'src/a.ts', content: 'x' }),
      step('run_tests', {}),
      step('write_file', { path: 'src/a.ts', content: 'fixed' }),
      step('run_tests', {}),
      step(null, {}, true, 'Created a.ts; tests pass.'),
    ]);
    const r = await agent.run('build it and test it');
    expect(r).toMatchObject({ ok: true, report: 'Created a.ts; tests pass.' });
    expect(files.get('src/a.ts')).toBe('fixed');
    expect(events.filter((e) => e.type === 'approval-needed')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'step-end' && !e.ok)).toHaveLength(1);
  });

  it('does not execute when the plan is rejected', async () => {
    const { agent, provider } = agentWith([plan], { approvePlan: async () => false });
    const r = await agent.run('x');
    expect(r.ok).toBe(false);
    expect(provider.calls).toHaveLength(1);
  });

  it('respects action denial', async () => {
    files.clear();
    const { agent } = agentWith([plan, step('write_file', { path: 'a', content: 'b' }), step(null, {}, true, 'Stopped: denied')], {
      approveAction: async () => false,
    });
    await agent.run('x');
    expect(files.size).toBe(0);
  });

  it('rejects invalid tool arguments before execution', async () => {
    files.clear();
    const { agent, provider } = agentWith([plan, step('write_file', { path: 1 }), step(null, {}, true, 'done')]);
    await agent.run('x');
    expect(files.size).toBe(0);
    expect(provider.calls.at(-1)!.messages.some((m) => /invalid arguments/.test(m.content))).toBe(true);
  });

  it('enforces the step bound', async () => {
    const { agent } = agentWith([plan, step('run_tests', {})], { maxSteps: 3 });
    const r = await agent.run('x');
    expect(r.ok).toBe(false);
    expect(r.report).toMatch(/Stopped after 3 steps/);
  });

  it('times out hanging tools', async () => {
    const { agent, events } = agentWith([plan, step('hang', {}), step(null, {}, true, 'gave up')]);
    await agent.run('x');
    expect(events.some((e) => e.type === 'step-end' && e.summary === 'Timed out')).toBe(true);
  });

  it('retries transient model errors', async () => {
    const { agent, events } = agentWith([new LLMError('busy', 'rate-limit', true), plan, step(null, {}, true, 'ok')]);
    const r = await agent.run('x');
    expect(r.ok).toBe(true);
    expect(events.some((e) => e.type === 'retry')).toBe(true);
  });

  it('cancels cleanly', async () => {
    const ac = new AbortController();
    const { agent } = agentWith([plan, step('hang', {})], {
      signal: ac.signal,
      approvePlan: async () => {
        ac.abort();
        return true;
      },
    });
    const r = await agent.run('x');
    expect(r.report).toBe('Cancelled.');
  });
});

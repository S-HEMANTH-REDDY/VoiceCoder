import type { z } from 'zod';
import { LLMError, type CompletionRequest, type CompletionResult, type LLMProvider, type StructuredResult } from '../src/llm/types.js';

type Responder = (req: CompletionRequest & { schemaName?: string }) => unknown;

/** Scripted provider: each call pops the next responder (or reuses the last). */
export class FakeProvider implements LLMProvider {
  readonly id = 'anthropic' as const;
  readonly displayName = 'Fake';
  calls: Array<CompletionRequest & { schemaName?: string }> = [];
  constructor(private readonly responders: Responder[]) {}

  private next(req: CompletionRequest & { schemaName?: string }) {
    this.calls.push(req);
    if (req.signal?.aborted) throw new LLMError('Request cancelled.', 'cancelled', false);
    const r = this.responders.length > 1 ? this.responders.shift()! : this.responders[0]!;
    const value = r(req);
    if (value instanceof Error) throw value;
    return value;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const text = String(this.next(req));
    return { text, usage: { inputTokens: 10, outputTokens: 5 }, latencyMs: 1, model: 'fake' };
  }

  async structured<S extends z.ZodType>(req: CompletionRequest & { schema: S; schemaName: string }): Promise<StructuredResult<z.infer<S>>> {
    const raw = this.next(req);
    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) throw new LLMError('invalid', 'invalid-output', true);
    return { value: parsed.data, usage: { inputTokens: 100, outputTokens: 20 }, latencyMs: 1, model: 'fake' };
  }
}

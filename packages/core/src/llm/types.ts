// Provider-neutral LLM interface. Executors depend on this, never on a vendor SDK.

import type { z } from 'zod';

export type ProviderId = 'anthropic' | 'openai';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}

export interface CompletionRequest {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** A routing hint: "fast" for classification, "quality" for code generation. */
  tier?: 'fast' | 'quality';
  signal?: AbortSignal;
  /** Metric label, e.g. "intent", "edit", "plan". */
  purpose: string;
}

export interface CompletionResult {
  text: string;
  usage: Usage;
  latencyMs: number;
  model: string;
}

export interface StructuredResult<T> extends Omit<CompletionResult, 'text'> {
  value: T;
}

export interface StreamHandlers {
  onText?: (delta: string, accumulated: string) => void;
  /** Time to first token, measured from request start. */
  onFirstToken?: (ms: number) => void;
}

export interface LLMProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  /** Plain completion, streamed when handlers are supplied. */
  complete(req: CompletionRequest, handlers?: StreamHandlers): Promise<CompletionResult>;
  /** Schema-constrained completion; the value is validated with the zod schema. */
  structured<S extends z.ZodType>(req: CompletionRequest & { schema: S; schemaName: string }): Promise<StructuredResult<z.infer<S>>>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'rate-limit' | 'network' | 'timeout' | 'invalid-output' | 'refused' | 'cancelled' | 'server' | 'config',
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

/** Observer for every model call — feeds latency/token metrics without logging content. */
export type LLMCallObserver = (event: {
  provider: ProviderId;
  model: string;
  purpose: string;
  latencyMs: number;
  usage?: Usage;
  ok: boolean;
  errorKind?: LLMError['kind'];
}) => void;

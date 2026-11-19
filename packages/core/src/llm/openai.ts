// OpenAI provider (Chat Completions over fetch — works in Node, VS Code and MV3 workers).

import type { z } from 'zod';
import { extractJson, toStrictJsonSchema } from './json-schema.js';
import {
  LLMError,
  type CompletionRequest,
  type CompletionResult,
  type LLMCallObserver,
  type LLMProvider,
  type StreamHandlers,
  type StructuredResult,
  type Usage,
} from './types.js';

export interface OpenAIProviderOptions {
  apiKey: string;
  model?: string;
  fastModel?: string;
  baseUrl?: string;
  observer?: LLMCallObserver;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export const OPENAI_DEFAULT_MODEL = 'gpt-4.1';

export class OpenAIProvider implements LLMProvider {
  readonly id = 'openai' as const;
  readonly displayName = 'OpenAI';
  private readonly model: string;
  private readonly fastModel: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenAIProviderOptions) {
    if (!opts.apiKey) throw new LLMError('OpenAI API key is not configured.', 'config', false);
    this.model = opts.model || OPENAI_DEFAULT_MODEL;
    this.fastModel = opts.fastModel || this.model;
    this.baseUrl = (opts.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
  }

  private body(req: CompletionRequest, extra: Record<string, unknown>) {
    return {
      model: req.tier === 'fast' ? this.fastModel : this.model,
      max_completion_tokens: req.maxTokens ?? (req.tier === 'fast' ? 1024 : 8192),
      messages: [{ role: 'system', content: req.system }, ...req.messages],
      ...extra,
    };
  }

  private async post(body: object, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 60_000);
    const combined = signal ? anySignal([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (err) {
      if (signal?.aborted) throw new LLMError('Request cancelled.', 'cancelled', false);
      if (timeout.aborted) throw new LLMError('OpenAI request timed out.', 'timeout', true);
      throw new LLMError('Could not reach OpenAI.', 'network', true);
    }
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}) as { error?: { message?: string } });
      const msg = (detail as { error?: { message?: string } }).error?.message ?? `OpenAI error ${res.status}`;
      if (res.status === 401 || res.status === 403) throw new LLMError('OpenAI rejected the API key.', 'auth', false, res.status);
      if (res.status === 429) throw new LLMError('Rate limited by OpenAI. Try again shortly.', 'rate-limit', true, 429);
      if (res.status >= 500) throw new LLMError(msg, 'server', true, res.status);
      throw new LLMError(msg, 'config', false, res.status);
    }
    return res;
  }

  async complete(req: CompletionRequest, handlers?: StreamHandlers): Promise<CompletionResult> {
    const started = now();
    const model = req.tier === 'fast' ? this.fastModel : this.model;
    try {
      const res = await this.post(this.body(req, { stream: true, stream_options: { include_usage: true } }), req.signal);
      let text = '';
      let usage: Usage = { inputTokens: 0, outputTokens: 0 };
      let first = true;
      for await (const data of readSse(res, req.signal)) {
        if (data === '[DONE]') break;
        const chunk = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>;
          usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } };
        };
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          if (first) {
            first = false;
            handlers?.onFirstToken?.(now() - started);
          }
          text += delta;
          handlers?.onText?.(delta, text);
        }
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
          };
        }
      }
      const latencyMs = now() - started;
      this.opts.observer?.({ provider: this.id, model, purpose: req.purpose, latencyMs, usage, ok: true });
      return { text, usage, latencyMs, model };
    } catch (err) {
      const e = err instanceof LLMError ? err : req.signal?.aborted ? new LLMError('Request cancelled.', 'cancelled', false) : new LLMError(String(err), 'server', false);
      this.opts.observer?.({ provider: this.id, model, purpose: req.purpose, latencyMs: now() - started, ok: false, errorKind: e.kind });
      throw e;
    }
  }

  async structured<S extends z.ZodType>(req: CompletionRequest & { schema: S; schemaName: string }, handlers?: StreamHandlers): Promise<StructuredResult<z.infer<S>>> {
    const started = now();
    const model = req.tier === 'fast' ? this.fastModel : this.model;
    const responseFormat = {
      response_format: { type: 'json_schema', json_schema: { name: req.schemaName, strict: true, schema: toStrictJsonSchema(req.schema) } },
    };
    try {
      let content = '';
      let usage: Usage = { inputTokens: 0, outputTokens: 0 };
      if (handlers) {
        const res = await this.post(this.body(req, { ...responseFormat, stream: true, stream_options: { include_usage: true } }), req.signal);
        let first = true;
        for await (const data of readSse(res, req.signal)) {
          if (data === '[DONE]') break;
          const chunk = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string; refusal?: string } }>;
            usage?: { prompt_tokens: number; completion_tokens: number };
          };
          const d = chunk.choices?.[0]?.delta;
          if (d?.refusal) throw new LLMError('The model declined this request.', 'refused', false);
          if (d?.content) {
            if (first) {
              first = false;
              handlers.onFirstToken?.(now() - started);
            }
            content += d.content;
            handlers.onText?.(d.content, content);
          }
          if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
        }
      } else {
        const res = await this.post(this.body(req, responseFormat), req.signal);
        const data = (await res.json()) as {
          choices: Array<{ message: { content: string | null; refusal?: string | null } }>;
          usage: { prompt_tokens: number; completion_tokens: number };
        };
        const msg = data.choices[0]?.message;
        if (msg?.refusal) throw new LLMError('The model declined this request.', 'refused', false);
        content = msg?.content ?? '';
        usage = { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens };
      }
      let raw: unknown;
      try {
        raw = extractJson(content);
      } catch {
        throw new LLMError('Model returned malformed JSON.', 'invalid-output', true);
      }
      const parsed = req.schema.safeParse(raw);
      if (!parsed.success) throw new LLMError(`Model output failed ${req.schemaName} validation.`, 'invalid-output', true);
      const latencyMs = now() - started;
      this.opts.observer?.({ provider: this.id, model, purpose: req.purpose, latencyMs, usage, ok: true });
      return { value: parsed.data, usage, latencyMs, model };
    } catch (err) {
      const e = err instanceof LLMError ? err : req.signal?.aborted ? new LLMError('Request cancelled.', 'cancelled', false) : new LLMError(String(err), 'server', false);
      this.opts.observer?.({ provider: this.id, model, purpose: req.purpose, latencyMs: now() - started, ok: false, errorKind: e.kind });
      throw e;
    }
  }
}

/** Minimal Server-Sent-Events reader yielding each `data:` payload. */
export async function* readSse(res: Response, signal?: AbortSignal): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) throw new LLMError('Request cancelled.', 'cancelled', false);
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

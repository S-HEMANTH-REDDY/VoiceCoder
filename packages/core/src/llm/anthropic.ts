// Claude provider, built on the official Anthropic TypeScript SDK.

import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { toStrictJsonSchema, extractJson } from './json-schema.js';
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

export interface AnthropicProviderOptions {
  apiKey: string;
  /** Model for code generation, edits and planning. */
  model?: string;
  /** Model for intent classification. Defaults to `model` at low effort. */
  fastModel?: string;
  /** Required when running inside a browser extension (BYOK; key never leaves the extension). */
  browser?: boolean;
  observer?: LLMCallObserver;
  timeoutMs?: number;
}

export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic' as const;
  readonly displayName = 'Anthropic Claude';
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly fastModel: string;

  constructor(private readonly opts: AnthropicProviderOptions) {
    if (!opts.apiKey) throw new LLMError('Anthropic API key is not configured.', 'config', false);
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      dangerouslyAllowBrowser: opts.browser ?? false,
      maxRetries: 2,
      timeout: opts.timeoutMs ?? 60_000,
    });
    this.model = opts.model || ANTHROPIC_DEFAULT_MODEL;
    this.fastModel = opts.fastModel || this.model;
  }

  private params(req: CompletionRequest) {
    const fast = req.tier === 'fast';
    return {
      model: fast ? this.fastModel : this.model,
      max_tokens: req.maxTokens ?? (fast ? 1024 : 8192),
      system: [{ type: 'text' as const, text: req.system, cache_control: { type: 'ephemeral' as const } }],
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      // Voice commands are latency-sensitive: classification runs at low effort,
      // code changes at medium. Both are configurable through the model setting.
      output_config: { effort: fast ? ('low' as const) : ('medium' as const) },
      betas: [FALLBACK_BETA],
      fallbacks: 'default' as const,
    };
  }

  async complete(req: CompletionRequest, handlers?: StreamHandlers): Promise<CompletionResult> {
    const started = now();
    const params = this.params(req);
    try {
      let text = '';
      let firstTokenAt: number | null = null;
      const stream = this.client.beta.messages.stream(params, { signal: req.signal });
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          if (firstTokenAt === null) {
            firstTokenAt = now();
            handlers?.onFirstToken?.(firstTokenAt - started);
          }
          text += event.delta.text;
          handlers?.onText?.(event.delta.text, text);
        }
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === 'refusal') throw new LLMError('The model declined this request.', 'refused', false);
      const usage = toUsage(final.usage);
      const latencyMs = now() - started;
      this.opts.observer?.({ provider: this.id, model: final.model, purpose: req.purpose, latencyMs, usage, ok: true });
      return { text, usage, latencyMs, model: final.model };
    } catch (err) {
      throw this.fail(err, req, params.model, started);
    }
  }

  async structured<S extends z.ZodType>(req: CompletionRequest & { schema: S; schemaName: string }, handlers?: StreamHandlers): Promise<StructuredResult<z.infer<S>>> {
    const started = now();
    const params = this.params(req);
    const body = {
      ...params,
      output_config: { ...params.output_config, format: { type: 'json_schema' as const, schema: toStrictJsonSchema(req.schema) } },
    };
    try {
      let text = '';
      let stopReason: string | null = null;
      let model = params.model;
      let usage: Usage;
      if (handlers) {
        // Stream the JSON so the UI can show a live preview of the code being written.
        let first = true;
        const stream = this.client.beta.messages.stream(body, { signal: req.signal });
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            if (first) {
              first = false;
              handlers.onFirstToken?.(now() - started);
            }
            text += event.delta.text;
            handlers.onText?.(event.delta.text, text);
          }
        }
        const final = await stream.finalMessage();
        stopReason = final.stop_reason;
        model = final.model;
        usage = toUsage(final.usage);
      } else {
        const response = await this.client.beta.messages.create(body, { signal: req.signal });
        stopReason = response.stop_reason;
        model = response.model;
        text = response.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
        usage = toUsage(response.usage);
      }
      if (stopReason === 'refusal') throw new LLMError('The model declined this request.', 'refused', false);
      if (stopReason === 'max_tokens') throw new LLMError('The response was cut off (max tokens). Try a narrower request.', 'invalid-output', false);
      const parsed = req.schema.safeParse(extractJson(text));
      if (!parsed.success) throw new LLMError(`Model output failed ${req.schemaName} validation.`, 'invalid-output', true);
      const latencyMs = now() - started;
      this.opts.observer?.({ provider: this.id, model, purpose: req.purpose, latencyMs, usage, ok: true });
      return { value: parsed.data, usage, latencyMs, model };
    } catch (err) {
      throw this.fail(err, req, params.model, started);
    }
  }

  private fail(err: unknown, req: CompletionRequest, model: string, started: number): LLMError {
    const e = toLLMError(err);
    this.opts.observer?.({ provider: this.id, model, purpose: req.purpose, latencyMs: now() - started, ok: false, errorKind: e.kind });
    return e;
  }
}

function toUsage(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null }): Usage {
  return { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadTokens: u.cache_read_input_tokens ?? 0 };
}

export function toLLMError(err: unknown): LLMError {
  if (err instanceof LLMError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new LLMError('Request cancelled.', 'cancelled', false);
  if (err instanceof Anthropic.AuthenticationError) return new LLMError('Anthropic rejected the API key.', 'auth', false, 401);
  if (err instanceof Anthropic.PermissionDeniedError) return new LLMError('This API key cannot use the selected model.', 'auth', false, 403);
  if (err instanceof Anthropic.RateLimitError) return new LLMError('Rate limited by Anthropic. Try again shortly.', 'rate-limit', true, 429);
  if (err instanceof Anthropic.BadRequestError) return new LLMError(`Anthropic rejected the request: ${err.message}`, 'config', false, 400);
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new LLMError('Anthropic request timed out.', 'timeout', true);
  if (err instanceof Anthropic.APIConnectionError) return new LLMError('Could not reach Anthropic.', 'network', true);
  if (err instanceof Anthropic.APIError) return new LLMError(`Anthropic error ${err.status ?? ''}`.trim(), 'server', true, err.status ?? undefined);
  if (err instanceof SyntaxError) return new LLMError('Model returned malformed JSON.', 'invalid-output', true);
  if (err instanceof Error && err.name === 'AbortError') return new LLMError('Request cancelled.', 'cancelled', false);
  return new LLMError(err instanceof Error ? err.message : String(err), 'server', false);
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

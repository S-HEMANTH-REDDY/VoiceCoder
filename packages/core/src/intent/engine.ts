// Hybrid intent engine:
//   transcript → normalize → local grammar (≈0.1 ms) ─┬─ hit → Intent (source=local)
//                                                    └─ miss → LLM structured output
//                                                              ├─ valid → Intent (source=llm)
//                                                              └─ error → heuristic (source=heuristic)
// Short-lived cache: identical transcripts with identical context within 30 s reuse the
// previous classification (e.g. "repeat", retries after a cancelled edit).

import { classifyHeuristically } from './heuristic.js';
import { parseLocalIntent } from './local-parser.js';
import { fromLlmIntent, LlmIntentSchema, type Intent } from './schema.js';
import { normalizeTranscript } from '../speech/normalize.js';
import { buildIntentUserPrompt, INTENT_SYSTEM, type IntentPromptInput } from '../prompts/prompts.js';
import { LLMError, type LLMProvider, type Usage } from '../llm/types.js';

export interface ClassifyContext extends Omit<IntentPromptInput, 'transcript'> {
  proseTarget?: boolean;
}

export interface ClassifyResult {
  intent: Intent;
  normalized: string;
  latencyMs: number;
  usage?: Usage;
  /** Set when the LLM path failed and the heuristic was used. */
  fallbackReason?: string;
  cached?: boolean;
}

export interface IntentEngineOptions {
  provider?: LLMProvider | null;
  /** Below this LLM confidence, the heuristic is consulted as a tie-breaker. */
  minConfidence?: number;
  cacheTtlMs?: number;
}

export class IntentEngine {
  private provider: LLMProvider | null;
  private readonly cache = new Map<string, { at: number; intent: Intent }>();
  private readonly cacheTtlMs: number;

  constructor(opts: IntentEngineOptions = {}) {
    this.provider = opts.provider ?? null;
    this.cacheTtlMs = opts.cacheTtlMs ?? 30_000;
  }

  setProvider(provider: LLMProvider | null): void {
    this.provider = provider;
    this.cache.clear();
  }

  async classify(rawTranscript: string, ctx: ClassifyContext, signal?: AbortSignal): Promise<ClassifyResult> {
    const started = now();
    const normalized = normalizeTranscript(rawTranscript);

    const local = parseLocalIntent(normalized);
    if (local) return { intent: local, normalized, latencyMs: now() - started };

    const key = `${normalized}|${ctx.fileName ?? ''}|${ctx.hasSelection}|${ctx.history.length}`;
    const hit = this.cache.get(key);
    if (hit && now() - hit.at < this.cacheTtlMs) return { intent: hit.intent, normalized, latencyMs: now() - started, cached: true };

    if (!this.provider) {
      return {
        intent: classifyHeuristically(normalized, { hasSelection: ctx.hasSelection, proseTarget: ctx.proseTarget }),
        normalized,
        latencyMs: now() - started,
        fallbackReason: 'No model configured',
      };
    }

    try {
      const res = await this.provider.structured({
        purpose: 'intent',
        tier: 'fast',
        system: INTENT_SYSTEM,
        messages: [{ role: 'user', content: buildIntentUserPrompt({ ...ctx, transcript: normalized }) }],
        maxTokens: 800,
        schema: LlmIntentSchema,
        schemaName: 'voice_intent',
        signal,
      });
      const intent = fromLlmIntent(res.value, normalized);
      if (!intent) throw new LLMError('Model intent did not validate.', 'invalid-output', false);
      this.cache.set(key, { at: now(), intent });
      return { intent, normalized, latencyMs: now() - started, usage: res.usage };
    } catch (err) {
      if (err instanceof LLMError && err.kind === 'cancelled') throw err;
      const reason = err instanceof Error ? err.message : String(err);
      return {
        intent: classifyHeuristically(normalized, { hasSelection: ctx.hasSelection, proseTarget: ctx.proseTarget }),
        normalized,
        latencyMs: now() - started,
        fallbackReason: reason,
      };
    }
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

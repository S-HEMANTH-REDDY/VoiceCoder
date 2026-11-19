import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import type { LLMCallObserver, LLMProvider, ProviderId } from './types.js';

export interface ProviderConfig {
  provider: ProviderId;
  apiKey: string;
  model?: string;
  fastModel?: string;
  browser?: boolean;
  observer?: LLMCallObserver;
}

export function createProvider(cfg: ProviderConfig): LLMProvider {
  switch (cfg.provider) {
    case 'anthropic':
      return new AnthropicProvider({ apiKey: cfg.apiKey, model: cfg.model, fastModel: cfg.fastModel, browser: cfg.browser, observer: cfg.observer });
    case 'openai':
      return new OpenAIProvider({ apiKey: cfg.apiKey, model: cfg.model, fastModel: cfg.fastModel, observer: cfg.observer });
  }
}

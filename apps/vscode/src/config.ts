import * as vscode from 'vscode';
import type { ProviderId } from '@voicecoder/core';

export const SECRET_KEYS: Record<ProviderId, string> = {
  anthropic: 'voicecoder.anthropicApiKey',
  openai: 'voicecoder.openaiApiKey',
};

export interface Settings {
  provider: ProviderId;
  model: string;
  fastModel: string;
  speechProvider: 'browser' | 'native';
  language: string;
  mode: 'continuous' | 'push-to-talk';
  ffmpegPath: string;
  nativeInputDevice: string;
  review: 'apply-and-review' | 'preview-first';
  contextBudget: number;
  agentMaxSteps: number;
  terminalTimeoutMs: number;
}

export function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration('voicecoder');
  return {
    provider: c.get<ProviderId>('llm.provider', 'anthropic'),
    model: c.get<string>('llm.model', ''),
    fastModel: c.get<string>('llm.fastModel', ''),
    speechProvider: c.get<'browser' | 'native'>('speech.provider', 'browser'),
    language: c.get<string>('speech.language', 'en-US'),
    mode: c.get<'continuous' | 'push-to-talk'>('speech.mode', 'continuous'),
    ffmpegPath: c.get<string>('speech.ffmpegPath', 'ffmpeg'),
    nativeInputDevice: c.get<string>('speech.nativeInputDevice', ''),
    review: c.get<'apply-and-review' | 'preview-first'>('edits.review', 'apply-and-review'),
    contextBudget: c.get<number>('context.budgetTokens', 6000),
    agentMaxSteps: c.get<number>('agent.maxSteps', 16),
    terminalTimeoutMs: c.get<number>('terminal.timeoutSeconds', 300) * 1000,
  };
}

export async function updateSetting(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration('voicecoder').update(key, value, vscode.ConfigurationTarget.Global);
}

export async function getApiKey(secrets: vscode.SecretStorage, provider: ProviderId): Promise<string | undefined> {
  return (await secrets.get(SECRET_KEYS[provider])) || undefined;
}

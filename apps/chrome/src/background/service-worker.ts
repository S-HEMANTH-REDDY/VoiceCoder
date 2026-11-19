// VoiceCoder service worker: keyboard commands, per-tab listening state, and model calls.
//
// Security fixes vs. the original:
//   * API keys are readable only inside the worker. No message returns them; the old
//     GET_SETTINGS handler leaked the whole storage (including the key) to any content
//     script on any page.
//   * Settings and keys can only be changed from the extension's own pages, never from
//     content scripts.
//   * Only this extension's contexts are accepted as senders.
//   * Content scripts are injected on demand (activeTab + scripting) on sites that are not
//     known code editors, instead of running on <all_urls>.
//   * Nothing about transcripts, code or responses is logged.

import { createProvider } from '@voicecoder/core/llm/registry';
import { IntentEngine } from '@voicecoder/core/intent/engine';
import { SessionMemory } from '@voicecoder/core/memory/session-memory';
import { buildEditSystem, buildEditUserPrompt, EXPLAIN_SYSTEM } from '@voicecoder/core/prompts/prompts';
import { previewFromPartialJson } from '@voicecoder/core/edit/patch';
import { EditPlanSchema } from '@voicecoder/core/edit/schema';
import { renderContext } from '@voicecoder/core/context/context';
import type { LLMProvider } from '@voicecoder/core/llm/types';
import { DEFAULT_SETTINGS, PORT_COMMAND, type CommandEvent, type CommandRequest, type StoredSettings, type ToContent, type ToWorker } from '../content/messages.js';

const KEYS = { anthropic: 'key.anthropic', openai: 'key.openai' } as const;
const SETTINGS_KEY = 'settings';

async function settings(): Promise<StoredSettings> {
  const s = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] as Partial<StoredSettings> | undefined;
  return { ...DEFAULT_SETTINGS, ...s };
}

async function provider(): Promise<LLMProvider | null> {
  const s = await settings();
  const key = (await chrome.storage.local.get(KEYS[s.provider]))[KEYS[s.provider]] as string | undefined;
  if (!key) return null;
  return createProvider({ provider: s.provider, apiKey: key, model: s.model || undefined, browser: true });
}

// Memory per tab, kept while the worker is alive (MV3 may evict it when idle; follow-ups
// then degrade gracefully to single-turn commands).
const memories = new Map<number, SessionMemory>();
const memoryFor = (tabId: number) => {
  let m = memories.get(tabId);
  if (!m) {
    m = new SessionMemory();
    memories.set(tabId, m);
  }
  return m;
};
chrome.tabs.onRemoved.addListener((tabId) => {
  memories.delete(tabId);
  void chrome.storage.session.remove(`listening.${tabId}`);
});

// ── Content script injection ──────────────────────────────────────────────────

async function ensureInjected(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ping' } satisfies ToContent);
    return true;
  } catch {
    // Not injected on this site (not in the static match list): inject on demand. This
    // works because the user just invoked the extension (activeTab grant).
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['page-bridge.js'], world: 'MAIN' });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      return true;
    } catch {
      return false;
    }
  }
}

async function toggle(tabId: number): Promise<boolean> {
  if (!(await ensureInjected(tabId))) return false;
  const s = await settings();
  const res = (await chrome.tabs.sendMessage(tabId, { type: 'toggle', lang: s.speechLang, mode: s.mode } satisfies ToContent).catch(() => null)) as { listening?: boolean } | null;
  const listening = !!res?.listening;
  await chrome.storage.session.set({ [`listening.${tabId}`]: listening });
  await chrome.action.setBadgeText({ tabId, text: listening ? 'ON' : '' });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#e8553d' });
  return listening;
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  const tabId = tab?.id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (tabId === undefined) return;
  if (command === 'toggle-voicecoder') await toggle(tabId);
  if (command === 'undo-last') await chrome.tabs.sendMessage(tabId, { type: 'undo' } satisfies ToContent).catch(() => undefined);
});

// ── One-shot messages ─────────────────────────────────────────────────────────

const isExtensionPage = (sender: chrome.runtime.MessageSender) => sender.id === chrome.runtime.id && !sender.tab && !!sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`);

chrome.runtime.onMessage.addListener((msg: ToWorker, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  void (async () => {
    switch (msg.type) {
      case 'get-state': {
        const s = await settings();
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const listening = tab?.id !== undefined ? !!(await chrome.storage.session.get(`listening.${tab.id}`))[`listening.${tab.id}`] : false;
        const keys = await chrome.storage.local.get([KEYS.anthropic, KEYS.openai]);
        // Report only whether keys exist — never the keys themselves.
        reply({ settings: s, listening, hasKey: { anthropic: !!keys[KEYS.anthropic], openai: !!keys[KEYS.openai] } });
        return;
      }
      case 'toggle': {
        const tabId = msg.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
        reply({ listening: tabId === undefined ? false : await toggle(tabId) });
        return;
      }
      case 'listening-changed': {
        if (sender.tab?.id !== undefined) {
          await chrome.storage.session.set({ [`listening.${sender.tab.id}`]: msg.listening });
          await chrome.action.setBadgeText({ tabId: sender.tab.id, text: msg.listening ? 'ON' : '' });
        }
        reply({ ok: true });
        return;
      }
      case 'record-turn': {
        if (sender.tab?.id !== undefined) {
          memoryFor(sender.tab.id).record({ id: String(Date.now()), transcript: msg.transcript.slice(0, 500), kind: (msg.kind || 'generate') as never, instruction: msg.transcript.slice(0, 500), outcome: msg.outcome.slice(0, 300), ok: msg.ok });
        }
        reply({ ok: true });
        return;
      }
      case 'set-focus': {
        if (sender.tab?.id !== undefined) memoryFor(sender.tab.id).setFocus({ file: 'page', startLine: msg.startLine, endLine: msg.endLine });
        reply({ ok: true });
        return;
      }
      case 'save-settings': {
        if (!isExtensionPage(sender)) return reply({ ok: false, error: 'forbidden' });
        const next = { ...(await settings()), ...sanitize(msg.settings) };
        await chrome.storage.local.set({ [SETTINGS_KEY]: next });
        reply({ ok: true, settings: next });
        return;
      }
      case 'save-key': {
        if (!isExtensionPage(sender)) return reply({ ok: false, error: 'forbidden' });
        const key = String(msg.key ?? '').trim();
        if (key.length < 20 || /\s/.test(key)) return reply({ ok: false, error: 'That does not look like an API key.' });
        await chrome.storage.local.set({ [KEYS[msg.provider === 'openai' ? 'openai' : 'anthropic']]: key });
        reply({ ok: true });
        return;
      }
      case 'clear-keys': {
        if (!isExtensionPage(sender)) return reply({ ok: false, error: 'forbidden' });
        await chrome.storage.local.remove([KEYS.anthropic, KEYS.openai]);
        reply({ ok: true });
        return;
      }
    }
  })();
  return true;
});

function sanitize(s: Partial<StoredSettings>): Partial<StoredSettings> {
  const out: Partial<StoredSettings> = {};
  if (s.provider === 'anthropic' || s.provider === 'openai') out.provider = s.provider;
  if (typeof s.model === 'string' && s.model.length < 100 && /^[\w.\-:/]*$/.test(s.model)) out.model = s.model;
  if (typeof s.speechLang === 'string' && /^(en-US|en-GB|en-IN|hi-IN|te-IN)$/.test(s.speechLang)) out.speechLang = s.speechLang;
  if (s.mode === 'continuous' || s.mode === 'push-to-talk') out.mode = s.mode;
  return out;
}

// ── Commands over a port (disconnect = cancel) ───────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_COMMAND || port.sender?.id !== chrome.runtime.id || port.sender.tab?.id === undefined) {
    port.disconnect();
    return;
  }
  const tabId = port.sender.tab.id;
  const abort = new AbortController();
  let open = true;
  port.onDisconnect.addListener(() => {
    open = false;
    abort.abort();
  });
  const emit = (e: CommandEvent) => {
    if (open) port.postMessage(e);
  };
  port.onMessage.addListener((req: CommandRequest) => {
    void runCommand(req, tabId, emit, abort.signal).catch((err) => {
      if (!abort.signal.aborted) emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    });
  });
});

async function runCommand(req: CommandRequest, tabId: number, emit: (e: CommandEvent) => void, signal: AbortSignal): Promise<void> {
  if (typeof req?.transcript !== 'string' || !req.context) return emit({ type: 'error', message: 'Invalid request.' });
  const transcript = req.transcript.slice(0, 2000);
  const p = await provider();
  const memory = memoryFor(tabId);
  const engine = new IntentEngine({ provider: p });
  const ctx = req.context;
  const res = await engine.classify(
    transcript,
    { history: memory.render(), languageId: ctx.languageId, hasSelection: !!ctx.selection?.text, cursorLine: ctx.cursor.line, proseTarget: req.prose },
    signal,
  );
  const intent = res.intent;
  emit({ type: 'intent', kind: intent.kind, source: intent.source });

  if (intent.kind === 'dictation') return emit({ type: 'insert', text: intent.text });
  if (!p) return emit({ type: 'error', message: 'Add an Anthropic or OpenAI API key in VoiceCoder settings to generate code.' });

  if (intent.kind === 'explain') {
    const out = await p.complete(
      { purpose: 'explain', system: EXPLAIN_SYSTEM, messages: [{ role: 'user', content: `<context>\n${renderContext(ctx, { budgetTokens: 4000 })}\n</context>\n<transcript>${transcript}</transcript>` }], signal, maxTokens: 1200 },
      { onText: (_d, acc) => emit({ type: 'preview', text: acc }) },
    );
    return emit({ type: 'text', title: 'Explanation', text: out.text });
  }

  if (intent.kind === 'generate' || intent.kind === 'modify' || intent.kind === 'refactor' || intent.kind === 'debug') {
    const focus = memory.getFocus('page');
    const target = ctx.selection
      ? { description: 'the selected code', startLine: ctx.selection.startLine, endLine: ctx.selection.endLine }
      : intent.kind !== 'generate' && focus
        ? { description: 'the code changed most recently', startLine: focus.startLine, endLine: focus.endLine }
        : undefined;
    const instruction = intent.kind === 'debug' ? intent.instruction || 'Find and fix the bug.' : intent.instruction;
    const out = await p.structured(
      {
        purpose: intent.kind,
        system: buildEditSystem(intent.kind),
        messages: [{ role: 'user', content: buildEditUserPrompt({ instruction, transcript, context: ctx, history: memory.render(), target, budgetTokens: 6000 }) }],
        schema: EditPlanSchema,
        schemaName: 'edit_plan',
        signal,
      },
      { onText: (_d, acc) => emit({ type: 'preview', text: previewFromPartialJson(acc) }) },
    );
    return emit({ type: 'edits', summary: out.value.summary, edits: out.value.edits, kind: intent.kind });
  }

  emit({ type: 'unsupported', message: `“${transcript}” is a ${intent.kind} command. Terminal, git, tests, rename and agent mode run in the VoiceCoder VS Code extension.` });
}

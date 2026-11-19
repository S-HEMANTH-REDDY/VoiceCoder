import type { StoredSettings, ToWorker } from '../content/messages.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const send = <T>(m: ToWorker) => chrome.runtime.sendMessage(m) as Promise<T>;

interface State {
  settings: StoredSettings;
  hasKey: { anthropic: boolean; openai: boolean };
}

let state: State;

function feedback(text: string, ok: boolean): void {
  const el = $('keyFeedback');
  el.textContent = text;
  el.className = `feedback ${ok ? 'ok' : 'err'}`;
  setTimeout(() => {
    el.textContent = '';
    el.className = 'feedback';
  }, 3500);
}

function render(): void {
  const s = state.settings;
  $<HTMLSelectElement>('provider').value = s.provider;
  $<HTMLInputElement>('model').value = s.model;
  $<HTMLSelectElement>('speechLang').value = s.speechLang;
  $<HTMLSelectElement>('mode').value = s.mode;
  const saved = state.hasKey[s.provider];
  $<HTMLInputElement>('apiKey').placeholder = saved ? '•••••••••••••••• (saved)' : s.provider === 'anthropic' ? 'sk-ant-…' : 'sk-…';
  $('keyStatus').textContent = `Anthropic key: ${state.hasKey.anthropic ? 'saved' : 'not set'} · OpenAI key: ${state.hasKey.openai ? 'saved' : 'not set'}`;
}

async function save(settings: Partial<StoredSettings>): Promise<void> {
  const res = await send<{ ok: boolean; settings?: StoredSettings }>({ type: 'save-settings', settings });
  if (res.ok && res.settings) state.settings = res.settings;
  render();
}

async function init(): Promise<void> {
  state = await send<State>({ type: 'get-state' });
  render();
  $('provider').addEventListener('change', (e) => void save({ provider: (e.target as HTMLSelectElement).value as StoredSettings['provider'] }));
  $('model').addEventListener('change', (e) => void save({ model: (e.target as HTMLInputElement).value.trim() }));
  $('speechLang').addEventListener('change', (e) => void save({ speechLang: (e.target as HTMLSelectElement).value }));
  $('mode').addEventListener('change', (e) => void save({ mode: (e.target as HTMLSelectElement).value as StoredSettings['mode'] }));
  $('saveKey').addEventListener('click', async () => {
    const input = $<HTMLInputElement>('apiKey');
    const key = input.value.trim();
    if (!key) return feedback('Paste a key first.', false);
    const res = await send<{ ok: boolean; error?: string }>({ type: 'save-key', provider: state.settings.provider, key });
    if (!res.ok) return feedback(res.error ?? 'Could not save the key.', false);
    input.value = '';
    state = await send<State>({ type: 'get-state' });
    render();
    feedback('Key saved.', true);
  });
  $('clearKeys').addEventListener('click', async () => {
    await send({ type: 'clear-keys' });
    state = await send<State>({ type: 'get-state' });
    render();
    feedback('Keys removed.', true);
  });
}

void init();

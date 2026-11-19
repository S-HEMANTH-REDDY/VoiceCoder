import type { StoredSettings, ToWorker } from '../content/messages.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const send = <T>(m: ToWorker) => chrome.runtime.sendMessage(m) as Promise<T>;

interface State {
  settings: StoredSettings;
  listening: boolean;
  hasKey: { anthropic: boolean; openai: boolean };
}

function render(s: State): void {
  const hasKey = s.hasKey[s.settings.provider];
  $('statusDot').classList.toggle('active', s.listening);
  $('toggleBtn').classList.toggle('active', s.listening);
  $('toggleLabel').textContent = s.listening ? 'Stop listening' : 'Start listening';
  $('apiKeyWarning').style.display = hasKey ? 'none' : 'flex';
  $<HTMLSelectElement>('speechLang').value = s.settings.speechLang;
  $('statusBar').textContent = s.listening ? 'Listening — speak a command.' : 'Click into a code editor, then press ⌥ Space.';
}

async function init(): Promise<void> {
  let state = await send<State>({ type: 'get-state' });
  render(state);
  $('toggleBtn').addEventListener('click', async () => {
    const res = await send<{ listening: boolean }>({ type: 'toggle' });
    state = { ...state, listening: res.listening };
    render(state);
    if (res.listening) window.close();
  });
  $<HTMLSelectElement>('speechLang').addEventListener('change', async (e) => {
    await send({ type: 'save-settings', settings: { speechLang: (e.target as HTMLSelectElement).value } });
  });
  const openSettings = () => chrome.runtime.openOptionsPage();
  $('settingsBtn').addEventListener('click', openSettings);
  $('openSettingsLink').addEventListener('click', openSettings);
}

void init();

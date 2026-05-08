// VoiceCoder Popup Script

import { MSG, LANGUAGES } from '../shared/constants.js';

const $ = (id) => document.getElementById(id);

let state = {
  isListening: false,
  language: 'python',
  hasApiKey: false,
};

// ── Boot ───────────────────────────────────────────────────────────────────────
async function init() {
  const res = await chrome.runtime.sendMessage({ type: MSG.GET_STATE });
  if (res) updateUI(res);

  renderLanguageGrid();
  bindEvents();
}

// ── UI Render ──────────────────────────────────────────────────────────────────
function updateUI(data) {
  state = { ...state, ...data };

  const dot = $('statusDot');
  const btn = $('toggleBtn');
  const icon = $('toggleIcon');
  const label = $('toggleLabel');
  const warning = $('apiKeyWarning');
  const statusBar = $('statusBar');

  dot.classList.toggle('active', state.isListening);
  btn.classList.toggle('active', state.isListening);
  btn.disabled = !state.hasApiKey;

  icon.textContent = state.isListening ? '⏹' : '🎙';
  label.textContent = state.isListening ? 'Stop Listening' : 'Start Listening';

  warning.style.display = state.hasApiKey ? 'none' : 'flex';

  statusBar.textContent = !state.hasApiKey
    ? 'Add your OpenAI API key in Settings to start'
    : state.isListening
      ? `Listening in ${LANGUAGES[state.language]?.label ?? state.language}…`
      : `Ready — press ⌥ Space in your editor`;

  // Highlight selected language chip
  document.querySelectorAll('.lang-chip').forEach((chip) => {
    chip.classList.toggle('selected', chip.dataset.lang === state.language);
  });
}

function renderLanguageGrid() {
  const grid = $('langGrid');
  grid.innerHTML = '';

  Object.entries(LANGUAGES).forEach(([key, info]) => {
    const chip = document.createElement('button');
    chip.className = 'lang-chip';
    chip.dataset.lang = key;
    chip.textContent = info.label;
    chip.title = info.label;
    chip.addEventListener('click', () => setLanguage(key));
    grid.appendChild(chip);
  });
}

// ── Events ─────────────────────────────────────────────────────────────────────
function bindEvents() {
  $('toggleBtn').addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: MSG.TOGGLE_LISTENING });
    updateUI(res ?? {});
  });

  $('settingsBtn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  $('openSettingsLink').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Live state updates from service worker
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === MSG.STATE_UPDATE) {
      updateUI(message.data);
    }
  });
}

async function setLanguage(lang) {
  const res = await chrome.runtime.sendMessage({
    type: MSG.SET_LANGUAGE,
    data: { language: lang },
  });
  if (res?.ok) {
    state.language = lang;
    updateUI(state);
  }
}

init();

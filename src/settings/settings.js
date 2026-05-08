// VoiceCoder Settings Page

import { MSG, STORAGE_KEYS, DEFAULTS } from '../shared/constants.js';

const $ = (id) => document.getElementById(id);

async function init() {
  const stored = await chrome.storage.local.get(null);

  // Populate API key (show masked if exists)
  if (stored[STORAGE_KEYS.API_KEY]) {
    $('apiKeyInput').placeholder = '••••••••••••••••••••••• (saved)';
  }

  // Populate model
  const modelEl = $('modelSelect');
  modelEl.value = stored[STORAGE_KEYS.SETTINGS]?.model ?? DEFAULTS.model;

  // Populate speech lang
  const speechEl = $('speechLangSelect');
  speechEl.value = stored[STORAGE_KEYS.SETTINGS]?.speechLang ?? DEFAULTS.speechLang;

  bindEvents();
}

function bindEvents() {
  // Save API key
  $('saveApiKey').addEventListener('click', async () => {
    const key = $('apiKeyInput').value.trim();
    if (!key) {
      showFeedback('apiKeyFeedback', 'Please enter an API key', false);
      return;
    }
    if (!key.startsWith('sk-')) {
      showFeedback('apiKeyFeedback', 'Key should start with sk-', false);
      return;
    }

    await chrome.runtime.sendMessage({
      type: MSG.SET_API_KEY,
      data: { apiKey: key },
    });

    $('apiKeyInput').value = '';
    $('apiKeyInput').placeholder = '••••••••••••••••••••••• (saved)';
    showFeedback('apiKeyFeedback', 'API key saved successfully', true);
  });

  // Model change
  $('modelSelect').addEventListener('change', async (e) => {
    await saveSetting('model', e.target.value);
  });

  // Speech lang change
  $('speechLangSelect').addEventListener('change', async (e) => {
    await saveSetting('speechLang', e.target.value);
  });

  // Reset
  $('resetBtn').addEventListener('click', async () => {
    if (!confirm('Clear all VoiceCoder data? This will remove your API key and settings.')) return;
    await chrome.storage.local.clear();
    window.location.reload();
  });
}

async function saveSetting(key, value) {
  const existing = (await chrome.storage.local.get(STORAGE_KEYS.SETTINGS))[STORAGE_KEYS.SETTINGS] ?? {};
  existing[key] = value;
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: existing });
}

function showFeedback(id, message, isOk) {
  const el = $(id);
  el.textContent = message;
  el.className = `feedback ${isOk ? 'ok' : 'err'}`;
  setTimeout(() => { el.textContent = ''; el.className = 'feedback'; }, 3000);
}

init();

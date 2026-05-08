// VoiceCoder Background Service Worker
// Manages state, keyboard commands, and LLM API calls

import { MSG, STORAGE_KEYS, DEFAULTS, LANGUAGES } from '../shared/constants.js';
import { buildSystemPrompt, buildUserPrompt, buildRewriteSystemPrompt, buildRewriteUserPrompt } from '../shared/prompts.js';

// ── State ──────────────────────────────────────────────────────────────────────
const state = {
  isListening: false,
  language: DEFAULTS.language,
  activeTabId: null,
  apiKey: null,
  model: DEFAULTS.model,
};

// ── Boot ───────────────────────────────────────────────────────────────────────
async function initialize() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.API_KEY,
    STORAGE_KEYS.LANGUAGE,
    STORAGE_KEYS.SETTINGS,
  ]);
  if (stored[STORAGE_KEYS.API_KEY]) state.apiKey = stored[STORAGE_KEYS.API_KEY];
  if (stored[STORAGE_KEYS.LANGUAGE]) state.language = stored[STORAGE_KEYS.LANGUAGE];
  if (stored[STORAGE_KEYS.SETTINGS]?.model) state.model = stored[STORAGE_KEYS.SETTINGS].model;
}

initialize();

// ── Keyboard Commands ──────────────────────────────────────────────────────────
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  if (command === 'toggle-voicecoder') {
    await toggleListening(tab.id);
  } else if (command === 'switch-language') {
    sendToContent(tab.id, { type: MSG.SHOW_INDICATOR, data: { mode: 'language-picker' } });
  } else if (command === 'undo-last') {
    sendToContent(tab.id, { type: MSG.UNDO_LAST });
  }
});

// ── Message Router ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender, sendResponse);
  return true; // keep channel open for async
});

async function handleMessage(message, sender, sendResponse) {
  switch (message.type) {
    case MSG.GET_STATE: {
      sendResponse({
        isListening: state.isListening,
        language: state.language,
        hasApiKey: !!state.apiKey,
        languages: LANGUAGES,
      });
      break;
    }

    case MSG.TOGGLE_LISTENING: {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) await toggleListening(tab.id);
      sendResponse({ isListening: state.isListening });
      break;
    }

    case MSG.SET_LANGUAGE: {
      state.language = message.data.language;
      await chrome.storage.local.set({ [STORAGE_KEYS.LANGUAGE]: state.language });
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) sendToContent(tab.id, { type: MSG.LANGUAGE_CHANGED, data: { language: state.language } });
      sendResponse({ ok: true, language: state.language });
      break;
    }

    case MSG.SET_API_KEY: {
      state.apiKey = message.data.apiKey;
      await chrome.storage.local.set({ [STORAGE_KEYS.API_KEY]: state.apiKey });
      sendResponse({ ok: true });
      break;
    }

    case MSG.GET_SETTINGS: {
      const settings = await chrome.storage.local.get(null);
      sendResponse(settings);
      break;
    }

    case MSG.REQUEST_GENERATION: {
      const { transcript, context } = message.data;
      try {
        const code = await generateCode(transcript, context, state.language);
        sendResponse({ ok: true, code });
      } catch (err) {
        console.error('[VoiceCoder] Generation error:', err);
        sendResponse({ ok: false, error: err.message });
      }
      break;
    }

    case MSG.REQUEST_REWRITE: {
      const { transcript, selectedCode, context } = message.data;
      try {
        const code = await rewriteCode(transcript, selectedCode, context, state.language);
        sendResponse({ ok: true, code });
      } catch (err) {
        console.error('[VoiceCoder] Rewrite error:', err);
        sendResponse({ ok: false, error: err.message });
      }
      break;
    }

    default:
      sendResponse({ ok: false, error: 'Unknown message type' });
  }
}

// ── Toggle Listening ───────────────────────────────────────────────────────────
async function toggleListening(tabId) {
  state.isListening = !state.isListening;
  state.activeTabId = state.isListening ? tabId : null;

  if (state.isListening) {
    sendToContent(tabId, {
      type: MSG.START_LISTENING,
      data: { language: state.language },
    });
  } else {
    sendToContent(tabId, { type: MSG.STOP_LISTENING });
  }

  // Notify popup if open
  chrome.runtime.sendMessage({
    type: MSG.STATE_UPDATE,
    data: { isListening: state.isListening, language: state.language },
  }).catch(() => {}); // popup may not be open
}

// ── LLM Code Generation ────────────────────────────────────────────────────────
async function generateCode(transcript, context, language) {
  if (!state.apiKey) {
    throw new Error('No API key configured. Open VoiceCoder settings to add your OpenAI key.');
  }

  const systemPrompt = buildSystemPrompt(language);
  const userPrompt = buildUserPrompt(transcript, context);

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${state.apiKey}`,
    },
    body: JSON.stringify({
      model: state.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: DEFAULTS.maxTokens,
      temperature: DEFAULTS.temperature,
      stream: false,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `OpenAI API error ${response.status}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content?.trim() ?? '';

  // Strip markdown fences if model ignores instructions
  return stripMarkdownFences(raw);
}

async function rewriteCode(transcript, selectedCode, context, language) {
  if (!state.apiKey) {
    throw new Error('No API key configured. Open VoiceCoder settings to add your OpenAI key.');
  }

  const systemPrompt = buildRewriteSystemPrompt(language);
  const userPrompt = buildRewriteUserPrompt(selectedCode, transcript, context);

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${state.apiKey}`,
    },
    body: JSON.stringify({
      model: state.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: DEFAULTS.maxTokens,
      temperature: DEFAULTS.temperature,
      stream: false,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `OpenAI API error ${response.status}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
  return stripMarkdownFences(raw);
}

function stripMarkdownFences(text) {
  return text
    .replace(/^```[\w]*\n?/m, '')
    .replace(/\n?```$/m, '')
    .trim();
}

// ── Helpers ────────────────────────────────────────────────────────────────────
async function sendToContent(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    // Content script not injected yet on this page — silently ignore
  }
}

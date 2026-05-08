// Shared constants across background, content, and popup

export const LANGUAGES = {
  python: { label: 'Python', ext: 'py', comment: '#' },
  javascript: { label: 'JavaScript', ext: 'js', comment: '//' },
  typescript: { label: 'TypeScript', ext: 'ts', comment: '//' },
  cpp: { label: 'C++', ext: 'cpp', comment: '//' },
  java: { label: 'Java', ext: 'java', comment: '//' },
  go: { label: 'Go', ext: 'go', comment: '//' },
  rust: { label: 'Rust', ext: 'rs', comment: '//' },
  swift: { label: 'Swift', ext: 'swift', comment: '//' },
  kotlin: { label: 'Kotlin', ext: 'kt', comment: '//' },
  ruby: { label: 'Ruby', ext: 'rb', comment: '#' },
  csharp: { label: 'C#', ext: 'cs', comment: '//' },
};

export const EDITOR_TYPES = {
  MONACO: 'monaco',
  CODEMIRROR: 'codemirror',
  ACE: 'ace',
  TEXTAREA: 'textarea',
  CONTENTEDITABLE: 'contenteditable',
  UNKNOWN: 'unknown',
};

export const MSG = {
  // popup → background
  TOGGLE_LISTENING: 'TOGGLE_LISTENING',
  GET_STATE: 'GET_STATE',
  SET_LANGUAGE: 'SET_LANGUAGE',
  SET_API_KEY: 'SET_API_KEY',
  GET_SETTINGS: 'GET_SETTINGS',

  // background → content
  START_LISTENING: 'START_LISTENING',
  STOP_LISTENING: 'STOP_LISTENING',
  GENERATE_AND_INSERT: 'GENERATE_AND_INSERT',
  UNDO_LAST: 'UNDO_LAST',
  LANGUAGE_CHANGED: 'LANGUAGE_CHANGED',
  SHOW_INDICATOR: 'SHOW_INDICATOR',
  HIDE_INDICATOR: 'HIDE_INDICATOR',

  // content → background
  SPEECH_RESULT: 'SPEECH_RESULT',
  EDITOR_CONTEXT: 'EDITOR_CONTEXT',
  REQUEST_GENERATION: 'REQUEST_GENERATION',
  REQUEST_REWRITE: 'REQUEST_REWRITE',
  CONTENT_READY: 'CONTENT_READY',

  // background → popup
  STATE_UPDATE: 'STATE_UPDATE',
};

export const STORAGE_KEYS = {
  API_KEY: 'openai_api_key',
  LANGUAGE: 'current_language',
  SETTINGS: 'settings',
  ONBOARDED: 'onboarded',
};

export const DEFAULTS = {
  language: 'python',
  model: 'gpt-4.1',
  maxTokens: 512,
  temperature: 0.2,
  speechLang: 'en-US',
};

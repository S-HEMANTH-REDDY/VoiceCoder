// Mic Indicator — minimal, non-intrusive corner badge

let indicatorEl = null;

const STATES = {
  listening: { label: '🎙', color: '#3b82f6', pulse: true },
  generating: { label: '⚡', color: '#8b5cf6', pulse: false },
  error: { label: '✕', color: '#ef4444', pulse: false },
};

export function createIndicator() {
  if (indicatorEl) return;

  indicatorEl = document.createElement('div');
  indicatorEl.id = 'voicecoder-indicator';
  indicatorEl.innerHTML = `
    <div class="vc-dot"></div>
    <span class="vc-label">VoiceCoder</span>
    <span class="vc-transcript"></span>
    <button class="vc-close" title="Stop VoiceCoder (Option+Space)">✕</button>
  `;

  indicatorEl.querySelector('.vc-close').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'TOGGLE_LISTENING' });
  });

  document.body.appendChild(indicatorEl);
}

export function setIndicatorState(stateName, transcript = '') {
  if (!indicatorEl) return;

  const state = STATES[stateName];
  if (!state) return;

  const dot = indicatorEl.querySelector('.vc-dot');
  const label = indicatorEl.querySelector('.vc-label');
  const transcriptEl = indicatorEl.querySelector('.vc-transcript');

  dot.style.background = state.color;
  dot.style.boxShadow = `0 0 0 0 ${state.color}`;
  dot.classList.toggle('vc-pulse', state.pulse);

  label.textContent = stateName === 'listening'
    ? 'Listening…'
    : stateName === 'generating'
      ? 'Generating…'
      : 'Error';

  transcriptEl.textContent = transcript ? `"${transcript.slice(0, 60)}${transcript.length > 60 ? '…' : ''}"` : '';
}

export function removeIndicator() {
  if (!indicatorEl) return;
  indicatorEl.style.opacity = '0';
  indicatorEl.style.transform = 'translateY(8px)';
  setTimeout(() => {
    indicatorEl?.remove();
    indicatorEl = null;
  }, 200);
}

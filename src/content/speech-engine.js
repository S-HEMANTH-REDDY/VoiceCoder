// Speech Engine — Web Speech API with Deepgram/Whisper fallback hooks

import { DEFAULTS } from '../shared/constants.js';

export class SpeechEngine {
  constructor({ onInterim, onFinal, onError }) {
    this.onInterim = onInterim;
    this.onFinal = onFinal;
    this.onError = onError;
    this.recognition = null;
    this.active = false;
    this._silenceTimer = null;
    this._currentTranscript = '';
    this._finalBuffer = '';
  }

  start() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      this.onError('Web Speech API not supported in this browser');
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new SpeechRecognition();

    // Config for low-latency continuous dictation
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = DEFAULTS.speechLang;
    this.recognition.maxAlternatives = 1;

    this.recognition.onstart = () => {
      this.active = true;
    };

    this.recognition.onresult = (event) => {
      let interimTranscript = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript;
        } else {
          interimTranscript += result[0].transcript;
        }
      }

      if (interimTranscript) {
        console.log('[VoiceCoder] Interim:', interimTranscript);
        this._currentTranscript = interimTranscript;
        this.onInterim(interimTranscript);
        this._resetSilenceTimer();
      }

      if (finalTranscript.trim()) {
        console.log('[VoiceCoder] Final:', finalTranscript.trim());
        this._clearSilenceTimer();
        this._currentTranscript = '';
        this.onFinal(finalTranscript.trim());
      }
    };

    this.recognition.onerror = (event) => {
      console.error('[VoiceCoder] Speech error:', event.error);
      if (event.error === 'no-speech') return;
      this.onError(event.error);
    };

    this.recognition.onend = () => {
      // Auto-restart if still active (Web Speech API stops after silence)
      if (this.active) {
        try {
          this.recognition.start();
        } catch {
          // Already started
        }
      }
    };

    try {
      this.recognition.start();
    } catch (err) {
      this.onError(err.message);
    }
  }

  stop() {
    this.active = false;
    this._clearSilenceTimer();
    try {
      this.recognition?.stop();
    } catch {}
    this.recognition = null;
  }

  // Fire onFinal immediately with any buffered interim transcript.
  // Call this before stop() so the pending speech isn't lost.
  flush() {
    this._clearSilenceTimer();
    const t = this._currentTranscript.trim();
    this._currentTranscript = '';
    if (t) this.onFinal(t);
  }

  _resetSilenceTimer() {
    this._clearSilenceTimer();
    // If 1.5s passes with only interim results, treat it as final
    this._silenceTimer = setTimeout(() => {
      if (this._currentTranscript.trim()) {
        const t = this._currentTranscript.trim();
        this._currentTranscript = '';
        this.onFinal(t);
      }
    }, 1500);
  }

  _clearSilenceTimer() {
    if (this._silenceTimer) {
      clearTimeout(this._silenceTimer);
      this._silenceTimer = null;
    }
  }
}

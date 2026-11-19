## Turn on the microphone

VS Code webviews cannot access the microphone. VoiceCoder therefore offers two capture paths:

- **Browser (default):** a small VoiceCoder page served from `127.0.0.1` streams live speech recognition back to VS Code. Allow the microphone once and keep the tab open.
- **Native:** `ffmpeg` captures the system microphone, VoiceCoder detects speech automatically, and OpenAI transcribes each utterance. Turn it on with `voicecoder.speech.provider: native`.

Toggle with **⌥Space** (Alt+Space).

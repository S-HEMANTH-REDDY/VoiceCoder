// Cloud transcription for the native microphone path. Accepts a WAV segment produced
// by the VAD and returns text. A developer-vocabulary prompt biases recognition toward
// programming terms ("JWT", "PostgreSQL", "useEffect").

export interface TranscriptionResult {
  text: string;
  latencyMs: number;
}

export interface Transcriber {
  readonly id: string;
  transcribe(wav: Uint8Array, opts: { language?: string; signal?: AbortSignal }): Promise<TranscriptionResult>;
}

export const DEVELOPER_VOCABULARY_PROMPT =
  'Developer dictating code commands in an IDE. Vocabulary: function, async, await, const, let, return, class, interface, TypeScript, JavaScript, Python, JSON, API, REST, JWT, OAuth, PostgreSQL, MySQL, SQLite, MongoDB, Redis, GraphQL, useState, useEffect, npm, pytest, Jest, git commit, refactor, endpoint, middleware, schema, regex, null, undefined, boolean.';

export class OpenAITranscriber implements Transcriber {
  readonly id = 'openai';
  constructor(
    private readonly apiKey: string,
    private readonly model = 'gpt-4o-transcribe',
    private readonly baseUrl = 'https://api.openai.com/v1',
  ) {}

  async transcribe(wav: Uint8Array, opts: { language?: string; signal?: AbortSignal }): Promise<TranscriptionResult> {
    const started = Date.now();
    const form = new FormData();
    form.append('file', new Blob([wav as BlobPart], { type: 'audio/wav' }), 'speech.wav');
    form.append('model', this.model);
    form.append('prompt', DEVELOPER_VOCABULARY_PROMPT);
    form.append('response_format', 'json');
    const lang = opts.language?.split('-')[0];
    if (lang) form.append('language', lang);
    const res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: opts.signal,
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(detail.error?.message ?? `Transcription failed (${res.status})`);
    }
    const data = (await res.json()) as { text?: string };
    return { text: (data.text ?? '').trim(), latencyMs: Date.now() - started };
  }
}

// Intent model — the contract between "what the developer said" and "what VoiceCoder does".
//
// Two schemas live here:
//   * `IntentSchema`     — the strict, discriminated union every executor consumes.
//   * `LlmIntentSchema`  — a flat, all-fields-required object the LLM fills in. Flat
//                          schemas are far more reliable across providers' structured
//                          output modes than deep unions; `fromLlmIntent` maps and then
//                          re-validates against `IntentSchema`, so nothing unvalidated
//                          ever reaches an executor.

import { z } from 'zod';

export const IntentSource = z.enum(['local', 'llm', 'heuristic']);
export type IntentSource = z.infer<typeof IntentSource>;

export const EditScope = z.enum(['selection', 'function', 'file', 'cursor']);
export type EditScope = z.infer<typeof EditScope>;

export const NavigationTarget = z.discriminatedUnion('type', [
  z.object({ type: z.literal('line'), line: z.number().int().positive(), column: z.number().int().positive().optional() }),
  z.object({ type: z.literal('file'), query: z.string().min(1) }),
  z.object({ type: z.literal('symbol'), query: z.string().min(1) }),
  z.object({ type: z.literal('definition') }),
  z.object({ type: z.literal('references') }),
  z.object({ type: z.literal('top') }),
  z.object({ type: z.literal('bottom') }),
  z.object({ type: z.literal('next-error') }),
  z.object({ type: z.literal('previous-error') }),
  z.object({ type: z.literal('back') }),
]);
export type NavigationTarget = z.infer<typeof NavigationTarget>;

export const ControlAction = z.enum([
  'undo',
  'redo',
  'accept',
  'reject',
  'cancel',
  'stop-listening',
  'save',
  'format',
  'select-function',
  'select-line',
  'select-all',
  'new-line',
  'repeat',
  'show-history',
]);
export type ControlAction = z.infer<typeof ControlAction>;

export const GitAction = z.enum(['status', 'diff', 'log', 'stage', 'commit-message', 'commit', 'push']);
export type GitAction = z.infer<typeof GitAction>;

const base = {
  source: IntentSource,
  confidence: z.number().min(0).max(1),
  transcript: z.string(),
};

export const IntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dictation'), text: z.string(), ...base }),
  z.object({ kind: z.literal('generate'), instruction: z.string().min(1), ...base }),
  z.object({ kind: z.literal('modify'), instruction: z.string().min(1), scope: EditScope, ...base }),
  z.object({ kind: z.literal('refactor'), instruction: z.string().min(1), scope: EditScope, ...base }),
  z.object({ kind: z.literal('rename'), newName: z.string().optional(), ...base }),
  z.object({ kind: z.literal('debug'), instruction: z.string(), ...base }),
  z.object({ kind: z.literal('navigate'), target: NavigationTarget, ...base }),
  z.object({
    kind: z.literal('test'),
    action: z.enum(['run', 'generate']),
    instruction: z.string().optional(),
    ...base,
  }),
  z.object({ kind: z.literal('explain'), target: z.enum(['selection', 'function', 'file', 'error']), ...base }),
  z.object({
    kind: z.literal('terminal'),
    purpose: z.enum(['run-app', 'install', 'custom']),
    // Only ever a *proposal*. Every terminal command passes the command policy and
    // explicit user approval before it runs.
    command: z.string().optional(),
    description: z.string(),
    ...base,
  }),
  z.object({ kind: z.literal('git'), action: GitAction, message: z.string().optional(), ...base }),
  z.object({ kind: z.literal('agent'), goal: z.string().min(1), ...base }),
  z.object({ kind: z.literal('control'), action: ControlAction, ...base }),
]);
export type Intent = z.infer<typeof IntentSchema>;
export type IntentKind = Intent['kind'];
export type IntentOf<K extends IntentKind> = Extract<Intent, { kind: K }>;

export const INTENT_KINDS = [
  'dictation',
  'generate',
  'modify',
  'refactor',
  'rename',
  'debug',
  'navigate',
  'test',
  'explain',
  'terminal',
  'git',
  'agent',
  'control',
] as const satisfies readonly IntentKind[];

// ── Flat LLM-facing schema ────────────────────────────────────────────────────
// Every field is present and nullable so it works with strict JSON-schema modes
// (OpenAI `strict: true` and Anthropic `output_config.format`).
export const LlmIntentSchema = z.object({
  kind: z.enum(INTENT_KINDS),
  instruction: z
    .string()
    .describe('The developer request restated as a precise, self-contained instruction. Resolve follow-ups ("make it async") using the conversation.'),
  scope: EditScope.nullable().describe('For modify/refactor: what code the change applies to.'),
  text: z.string().nullable().describe('For dictation: the exact text to insert.'),
  newName: z.string().nullable().describe('For rename: the requested new identifier, if spoken.'),
  navigation: z
    .object({
      type: z.enum(['line', 'file', 'symbol', 'definition', 'references', 'top', 'bottom', 'next-error', 'previous-error', 'back']),
      line: z.number().int().nullable(),
      query: z.string().nullable(),
    })
    .nullable(),
  testAction: z.enum(['run', 'generate']).nullable(),
  explainTarget: z.enum(['selection', 'function', 'file', 'error']).nullable(),
  terminalPurpose: z.enum(['run-app', 'install', 'custom']).nullable(),
  terminalCommand: z.string().nullable().describe('A proposed shell command. It will be validated and shown to the user for approval.'),
  gitAction: GitAction.nullable(),
  controlAction: ControlAction.nullable(),
  confidence: z.number().describe('0..1 confidence in the classification.'),
});
export type LlmIntent = z.infer<typeof LlmIntentSchema>;

/** Maps the flat LLM object to a validated Intent. Returns null when it cannot be made valid. */
export function fromLlmIntent(raw: LlmIntent, transcript: string): Intent | null {
  const common = {
    source: 'llm' as const,
    confidence: clamp01(raw.confidence),
    transcript,
  };
  const instruction = raw.instruction?.trim() || transcript;
  let candidate: unknown;
  switch (raw.kind) {
    case 'dictation':
      candidate = { kind: 'dictation', text: raw.text ?? transcript, ...common };
      break;
    case 'generate':
      candidate = { kind: 'generate', instruction, ...common };
      break;
    case 'modify':
    case 'refactor':
      candidate = { kind: raw.kind, instruction, scope: raw.scope ?? 'selection', ...common };
      break;
    case 'rename':
      candidate = { kind: 'rename', newName: raw.newName ?? undefined, ...common };
      break;
    case 'debug':
      candidate = { kind: 'debug', instruction, ...common };
      break;
    case 'navigate': {
      const n = raw.navigation;
      if (!n) return null;
      const target =
        n.type === 'line'
          ? n.line && n.line > 0
            ? { type: 'line', line: n.line }
            : null
          : n.type === 'file' || n.type === 'symbol'
            ? n.query
              ? { type: n.type, query: n.query }
              : null
            : { type: n.type };
      if (!target) return null;
      candidate = { kind: 'navigate', target, ...common };
      break;
    }
    case 'test':
      candidate = { kind: 'test', action: raw.testAction ?? 'run', instruction, ...common };
      break;
    case 'explain':
      candidate = { kind: 'explain', target: raw.explainTarget ?? 'selection', ...common };
      break;
    case 'terminal':
      candidate = {
        kind: 'terminal',
        purpose: raw.terminalPurpose ?? 'custom',
        command: raw.terminalCommand ?? undefined,
        description: instruction,
        ...common,
      };
      break;
    case 'git':
      if (!raw.gitAction) return null;
      candidate = { kind: 'git', action: raw.gitAction, ...common };
      break;
    case 'agent':
      candidate = { kind: 'agent', goal: instruction, ...common };
      break;
    case 'control':
      if (!raw.controlAction) return null;
      candidate = { kind: 'control', action: raw.controlAction, ...common };
      break;
  }
  const parsed = IntentSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Intents whose execution changes files, runs processes or talks to remotes. */
export function isConsequential(intent: Intent): boolean {
  switch (intent.kind) {
    case 'terminal':
      return true;
    case 'git':
      return intent.action === 'commit' || intent.action === 'push' || intent.action === 'stage';
    case 'test':
      return intent.action === 'run';
    case 'agent':
      return true;
    default:
      return false;
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

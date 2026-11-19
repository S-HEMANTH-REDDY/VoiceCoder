// Deterministic fast path. Commands with a closed, unambiguous grammar ("go to line 45",
// "undo that", "run the tests") never need a model: parsing them locally is ~0.05 ms,
// free, private and works offline. Anything open-ended returns null and is handled by
// the LLM classifier.
//
// Design rule: this parser must be *high precision*. A wrong local match executes the
// wrong action instantly; a missed match only costs one LLM round trip.

import type { Intent } from './schema.js';
import { parseSpokenNumber, SPOKEN_NUMBER_PATTERN } from '../speech/normalize.js';

type Rule = (text: string, transcript: string) => Intent | null;

const N = SPOKEN_NUMBER_PATTERN;
const POLITE = /^(?:(?:hey )?(?:voice ?coder|computer)[,:]?\s+)?(?:(?:please|can you|could you|would you|will you|i want to|i'd like to|let's|lets|now)\s+)*/i;
const TRAILING = /\s*(?:please|for me|now|thanks|thank you)$/i;

function local<K extends Intent['kind']>(
  intent: Omit<Extract<Intent, { kind: K }>, 'source' | 'confidence' | 'transcript'>,
  transcript: string,
): Intent {
  return { ...(intent as object), source: 'local', confidence: 1, transcript } as Intent;
}

const rules: Rule[] = [
  // ── Editor control ────────────────────────────────────────────────────────
  (t, tr) =>
    /^(?:undo|undo (?:that|it|this|my last change|the last change|last change|the change|what you did)|revert (?:that|it|the last change|my last change)|take that back|scratch that)$/.test(t)
      ? local<'control'>({ kind: 'control', action: 'undo' }, tr)
      : null,
  (t, tr) => (/^redo(?: that| it)?$/.test(t) ? local<'control'>({ kind: 'control', action: 'redo' }, tr) : null),
  (t, tr) =>
    /^(?:accept|apply|keep|approve)(?: (?:it|this|that|these|those|the|all))*(?: (?:changes?|edits?|diff|patch|suggestions?))?$|^(?:looks good|ship it|lgtm|yes apply( it)?|yes|yep|go ahead|do it|run it|approved)$/.test(t)
      ? local<'control'>({ kind: 'control', action: 'accept' }, tr)
      : null,
  (t, tr) =>
    /^(?:reject|discard|decline|deny|throw away|drop)(?: (?:it|this|that|these|those|the|all))*(?: (?:changes?|edits?|diff|patch|suggestions?))?$|^(?:no don't apply( it)?|don't apply( it)?|no|nope|don't do it|don't run it)$/.test(t)
      ? local<'control'>({ kind: 'control', action: 'reject' }, tr)
      : null,
  (t, tr) =>
    /^(?:cancel|stop|abort|never ?mind|forget it)(?: (?:that|it|this|the request|everything))?$/.test(t)
      ? local<'control'>({ kind: 'control', action: 'cancel' }, tr)
      : null,
  (t, tr) =>
    /^(?:stop|pause) (?:listening|dictation|voice ?coder)$|^(?:mic|microphone) off$|^go to sleep$/.test(t)
      ? local<'control'>({ kind: 'control', action: 'stop-listening' }, tr)
      : null,
  (t, tr) => (/^save(?: (?:the|this) file| it| all| everything)?$/.test(t) ? local<'control'>({ kind: 'control', action: 'save' }, tr) : null),
  (t, tr) =>
    /^(?:format|prettify|reformat)(?: (?:the|this))?(?: (?:file|document|code))?$/.test(t)
      ? local<'control'>({ kind: 'control', action: 'format' }, tr)
      : null,
  (t, tr) =>
    /^select (?:this|the|current|whole|entire)?\s*(?:function|method)$/.test(t)
      ? local<'control'>({ kind: 'control', action: 'select-function' }, tr)
      : null,
  (t, tr) => (/^select (?:this|the|current)? ?line$/.test(t) ? local<'control'>({ kind: 'control', action: 'select-line' }, tr) : null),
  (t, tr) =>
    /^select (?:all|everything|the whole file|the entire file)$/.test(t) ? local<'control'>({ kind: 'control', action: 'select-all' }, tr) : null,
  (t, tr) => (/^(?:new line|newline|next line|enter)$/.test(t) ? local<'control'>({ kind: 'control', action: 'new-line' }, tr) : null),
  (t, tr) => (/^(?:repeat|do it again|again|repeat that|one more time)$/.test(t) ? local<'control'>({ kind: 'control', action: 'repeat' }, tr) : null),
  (t, tr) =>
    /^(?:show|open) (?:the )?(?:command |voice )?history$/.test(t) ? local<'control'>({ kind: 'control', action: 'show-history' }, tr) : null,

  // ── Navigation ────────────────────────────────────────────────────────────
  (t, tr) => {
    const m = t.match(new RegExp(`^(?:go|jump|move|navigate|scroll|take me)(?: (?:to|down to|up to))?(?: the)? line (?:number )?(${N})(?:,? (?:column|col|character) (${N}))?$`));
    const m2 = m ?? t.match(new RegExp(`^line (?:number )?(${N})$`));
    if (!m2) return null;
    const line = parseSpokenNumber(m2[1]!);
    if (!line || line < 1) return null;
    const column = m?.[2] ? parseSpokenNumber(m[2]) : null;
    return local<'navigate'>({ kind: 'navigate', target: column ? { type: 'line', line, column } : { type: 'line', line } }, tr);
  },
  // Hindi / Telugu: "लाइन 45 पर जाओ", "లైన్ 45 కు వెళ్ళు" (digits in any script).
  (t, tr) => {
    const m = t.match(/^(?:लाइन|पंक्ति|line)\s*(?:नंबर\s*)?([0-9०-९]+)\s*(?:पर|तक)\s*(?:जाओ|जाइए|जाएं|चलो|ले चलो)$/) ??
      t.match(/^(?:లైన్|లైను|line)\s*(?:నంబర్\s*)?([0-9౦-౯]+)\s*(?:కు|కి)\s*(?:వెళ్ళు|వెళ్లు|వెళ్ళండి|వెళ్లండి|పో)$/);
    if (!m) return null;
    const line = parseSpokenNumber(m[1]!);
    return line && line > 0 ? local<'navigate'>({ kind: 'navigate', target: { type: 'line', line } }, tr) : null;
  },
  (t, tr) =>
    /^(?:go|jump|move|scroll)(?: to)?(?: the)? (?:top|start|beginning)(?: of (?:the )?(?:file|document))?$/.test(t)
      ? local<'navigate'>({ kind: 'navigate', target: { type: 'top' } }, tr)
      : null,
  (t, tr) =>
    /^(?:go|jump|move|scroll)(?: to)?(?: the)? (?:bottom|end)(?: of (?:the )?(?:file|document))?$/.test(t)
      ? local<'navigate'>({ kind: 'navigate', target: { type: 'bottom' } }, tr)
      : null,
  (t, tr) =>
    /^(?:go to|jump to|show|open|peek)(?: the)? definition(?: of (?:this|it))?$|^where is (?:this|it) defined$/.test(t)
      ? local<'navigate'>({ kind: 'navigate', target: { type: 'definition' } }, tr)
      : null,
  (t, tr) =>
    /^(?:find|show|list)(?: all)?(?: the)? (?:references|usages|callers)(?: (?:of|to) (?:this|it))?$|^where is (?:this|it) used$/.test(t)
      ? local<'navigate'>({ kind: 'navigate', target: { type: 'references' } }, tr)
      : null,
  (t, tr) =>
    /^(?:go to |jump to |show )?(?:the )?next (?:error|problem|diagnostic|issue)$/.test(t)
      ? local<'navigate'>({ kind: 'navigate', target: { type: 'next-error' } }, tr)
      : null,
  (t, tr) =>
    /^(?:go to |jump to |show )?(?:the )?previous (?:error|problem|diagnostic|issue)$/.test(t)
      ? local<'navigate'>({ kind: 'navigate', target: { type: 'previous-error' } }, tr)
      : null,
  (t, tr) =>
    /^(?:go|jump|navigate) back(?: to where i was)?$/.test(t) ? local<'navigate'>({ kind: 'navigate', target: { type: 'back' } }, tr) : null,
  (t, tr) => {
    const m = t.match(/^(?:go to|jump to|find)(?: the)? (?:function|method|class|symbol|variable) (?:called |named )?(.+)$/);
    return m ? local<'navigate'>({ kind: 'navigate', target: { type: 'symbol', query: m[1]!.trim() } }, tr) : null;
  },
  (t, tr) => {
    // "open the authentication file", "open auth controller", "switch to package.json"
    const m = t.match(/^(?:open|switch to|go to|jump to|show me|show)(?: up)?(?: the| my)? (.+?)(?: file| module| component| page)$/) ??
      t.match(/^(?:open|switch to)(?: up)?(?: the| my)? (.+)$/);
    if (!m) return null;
    const query = m[1]!.trim();
    if (!query || /^(?:terminal|settings|history|panel|problems|output)$/.test(query)) return null;
    return local<'navigate'>({ kind: 'navigate', target: { type: 'file', query } }, tr);
  },

  // ── Rename (native rename provider, no model needed) ──────────────────────
  (t, tr) => {
    const m = t.match(/^rename (?:this|the|that)?\s*(?:variable|function|method|class|symbol|parameter|field|property)?\s*(?:to|as) (.+)$/);
    if (m) return local<'rename'>({ kind: 'rename', newName: toIdentifier(m[1]!, tr) }, tr);
    return /^rename (?:this|the|that)(?: (?:variable|function|method|class|symbol|parameter|field|property))?$/.test(t)
      ? local<'rename'>({ kind: 'rename' }, tr)
      : null;
  },

  // ── Tests ─────────────────────────────────────────────────────────────────
  (t, tr) =>
    /^(?:run|execute|rerun|re-run)(?: all)?(?: the| my)?(?: unit| integration)? (?:tests?|test suite|specs?)(?: again)?$/.test(t)
      ? local<'test'>({ kind: 'test', action: 'run' }, tr)
      : null,
  (t, tr) =>
    /^(?:run|execute)(?: the)? (?:pytest|jest|vitest|mocha|go test|cargo test|npm test|unittest)$/.test(t)
      ? local<'test'>({ kind: 'test', action: 'run' }, tr)
      : null,

  // ── Terminal: running the app is a recognisable, closed command ───────────
  (t, tr) =>
    /^(?:run|start|launch|boot)(?: up)?(?: the| my)? (?:app|application|server|dev server|project|program)$/.test(t)
      ? local<'terminal'>({ kind: 'terminal', purpose: 'run-app', description: 'Run the application' }, tr)
      : null,

  // ── Git ───────────────────────────────────────────────────────────────────
  (t, tr) =>
    /^(?:show|what are)(?: me)?(?: the| my)? (?:git )?(?:changes|diff|modifications)$|^git diff$|^what (?:did i|have i) change(?:d)?$/.test(t)
      ? local<'git'>({ kind: 'git', action: 'diff' }, tr)
      : null,
  (t, tr) =>
    /^(?:show )?(?:the )?git status$|^(?:what's|what is) the git status$/.test(t) ? local<'git'>({ kind: 'git', action: 'status' }, tr) : null,
  (t, tr) =>
    /^(?:show )?(?:the )?(?:git log|commit history|recent commits)$/.test(t) ? local<'git'>({ kind: 'git', action: 'log' }, tr) : null,
  (t, tr) =>
    /^(?:generate|write|suggest|draft|create)(?: me)?(?: a| the)? commit message$/.test(t)
      ? local<'git'>({ kind: 'git', action: 'commit-message' }, tr)
      : null,
  (t, tr) => {
    const m = t.match(/^(?:create|make)?(?: a| the)? ?(?:git )?commit(?: (?:the|my|these|all))?(?: changes)?(?: with (?:the )?message (.+))?$/);
    if (!m || !/commit/.test(t)) return null;
    return local<'git'>({ kind: 'git', action: 'commit', message: m[1]?.trim() }, tr);
  },
  (t, tr) => (/^(?:git )?push(?: (?:it|my changes|the changes|to remote|to origin))?$/.test(t) ? local<'git'>({ kind: 'git', action: 'push' }, tr) : null),
  (t, tr) =>
    /^(?:stage|git add)(?: all| everything| the)?(?: changes| files)?$/.test(t) ? local<'git'>({ kind: 'git', action: 'stage' }, tr) : null,

  // ── Explain (classification is local; execution still uses the model) ────
  (t, tr) => {
    const m = t.match(/^(?:explain|what does|describe|walk me through)(?: me)?(?: this| the| that)? (function|method|code|selection|file|class|error|line|block)(?: do| does)?$/);
    if (!m) return /^what does this do$|^explain(?: this| that| it)?$/.test(t) ? local<'explain'>({ kind: 'explain', target: 'selection' }, tr) : null;
    const word = m[1]!;
    const target = word === 'file' ? 'file' : word === 'error' ? 'error' : word === 'function' || word === 'method' || word === 'class' ? 'function' : 'selection';
    return local<'explain'>({ kind: 'explain', target }, tr);
  },
  (t, tr) =>
    /^(?:explain|what does|what's|what is)(?: this| the)? (?:error|problem|stack ?trace|exception)(?: mean)?$|^why (?:is this|does this) (?:failing|fail|broken|crash(?:ing)?)$/.test(t)
      ? local<'explain'>({ kind: 'explain', target: 'error' }, tr)
      : null,

  // ── Explicit dictation ────────────────────────────────────────────────────
  (_t, tr) => {
    const m = tr.match(/^(?:type|dictate|insert text|write the text|say)[:,]?\s+(.+)$/i);
    return m ? local<'dictation'>({ kind: 'dictation', text: m[1]! }, tr) : null;
  },
];

/**
 * Parses a normalized transcript with the deterministic grammar.
 * @returns a validated, high-confidence Intent, or null if the utterance needs the model.
 */
export function parseLocalIntent(transcript: string): Intent | null {
  const t = transcript.toLowerCase().replace(/[.,!?;:"]+(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim().replace(POLITE, '').replace(TRAILING, '').trim();
  if (!t) return null;
  for (const rule of rules) {
    const result = rule(t, transcript);
    if (result) return result;
  }
  return null;
}

/** "user count" → "userCount"; keeps already-valid identifiers ("user_count") intact. */
export function toIdentifier(spoken: string, original?: string): string {
  // Prefer the original casing if the speech engine produced a real identifier.
  const raw = original?.match(/(?:to|as)\s+([A-Za-z_$][\w$]*)\s*$/)?.[1];
  if (raw && /[A-Z_]/.test(raw)) return raw;
  const words = spoken.trim().replace(/[^\w\s$]/g, '').split(/\s+/).filter(Boolean);
  const snake = /\bsnake case\b/.test(spoken);
  const cleaned = words.filter((w) => !/^(?:snake|camel|case)$/.test(w));
  if (cleaned.length === 0) return spoken.trim();
  if (snake) return cleaned.join('_');
  return cleaned[0]! + cleaned.slice(1).map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');
}

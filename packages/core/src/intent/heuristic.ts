// Offline fallback classifier. Used when no model is configured, the provider is
// unreachable, or a structured response fails validation. It is intentionally simple
// and reports lower confidence; the eval suite measures it separately from the LLM path.

import type { Intent } from './schema.js';

interface HeuristicContext {
  hasSelection: boolean;
  /** True when the focused target is prose (a chat box, a markdown file, a commit message). */
  proseTarget?: boolean;
}

const has = (t: string, re: RegExp) => re.test(t);

export function classifyHeuristically(transcript: string, ctx: HeuristicContext): Intent {
  const t = transcript.toLowerCase();
  const common = { source: 'heuristic' as const, transcript };

  // Multi-step: two or more action clauses joined by "and"/"then", or an explicit
  // "build/create ... with ... and ..." request.
  const actionVerbs = t.match(/\b(?:create|add|write|build|implement|generate|run|test|fix|refactor|make|set up|install|commit|validate)\b/g) ?? [];
  const joins = (t.match(/\b(?:and then|then|and|after that|finally)\b|,/g) ?? []).length;
  if (actionVerbs.length >= 3 && joins >= 2) {
    return { kind: 'agent', goal: transcript, confidence: 0.6, ...common };
  }

  if (has(t, /\b(?:run|install|npm|pip|yarn|pnpm|cargo|make|docker)\b.*\b(?:install|start|build|dev|serve|up)\b|\binstall (?:the )?(?:package|dependency|dependencies|library|module)\b/)) {
    return { kind: 'terminal', purpose: /install/.test(t) ? 'install' : 'custom', description: transcript, confidence: 0.55, ...common };
  }

  if (has(t, /\b(?:write|generate|add|create) (?:some |a |the )?(?:unit |integration )?tests?\b|\btest cases?\b/)) {
    return { kind: 'test', action: 'generate', instruction: transcript, confidence: 0.6, ...common };
  }

  if (has(t, /\b(?:fix|debug|why (?:is|does)|what's wrong|error|bug|crash|exception|failing|stack ?trace)\b/)) {
    return { kind: 'debug', instruction: transcript, confidence: 0.55, ...common };
  }

  if (has(t, /\b(?:explain|what does|how does|walk me through|describe)\b/)) {
    return { kind: 'explain', target: ctx.hasSelection ? 'selection' : 'function', confidence: 0.6, ...common };
  }

  if (has(t, /\b(?:refactor|extract|split|restructure|clean ?up|simplify|deduplicate|inline)\b/)) {
    return { kind: 'refactor', instruction: transcript, scope: ctx.hasSelection ? 'selection' : 'function', confidence: 0.6, ...common };
  }

  // Edits that reference existing code ("this", "it", "the function") or that are
  // phrased as follow-ups ("make it async", "actually use PostgreSQL").
  const referencesExisting = /\b(?:this|it|that|these|existing|current|the (?:function|method|class|code|loop|query|handler|endpoint))\b/.test(t);
  const modifyVerb = /\b(?:add|change|update|modify|optimi[sz]e|convert|make|replace|remove|delete|rename|handle|use|switch|wrap|improve)\b/.test(t);
  if ((modifyVerb && referencesExisting) || /^(?:actually|instead|also|now)\b/.test(t)) {
    return { kind: 'modify', instruction: transcript, scope: ctx.hasSelection ? 'selection' : 'function', confidence: 0.5, ...common };
  }

  if (has(t, /\b(?:create|write|generate|implement|add|build|make|define|declare|insert)\b|\b(?:function|class|loop|interface|struct|component|endpoint|api|method|enum|query|regex)\b/)) {
    return { kind: 'generate', instruction: transcript, confidence: 0.55, ...common };
  }

  if (ctx.proseTarget) {
    return { kind: 'dictation', text: transcript, confidence: 0.6, ...common };
  }
  return { kind: 'generate', instruction: transcript, confidence: 0.3, ...common };
}

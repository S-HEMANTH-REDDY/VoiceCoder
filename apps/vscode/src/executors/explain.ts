import { EXPLAIN_SYSTEM, renderContext, type IntentOf } from '@voicecoder/core';
import type { TargetSnapshot } from '../context/collector.js';
import { track } from './editing.js';
import { UserFacingError, type ExecResult, type Runtime } from './runtime.js';

export async function runExplain(rt: Runtime, intent: IntentOf<'explain'>, snap: TargetSnapshot | null, signal: AbortSignal): Promise<ExecResult> {
  const ctx = snap?.context;
  let subject: string;
  let what: string;
  if (intent.target === 'error') {
    const diags = (ctx?.diagnostics ?? []).filter((d) => d.severity === 'error' || d.severity === 'warning');
    const failure = rt.runner.lastFailure;
    if (!diags.length && !failure) throw new UserFacingError('There is no error to explain: no diagnostics in this file and no failed command.');
    what = 'the error';
    subject = [
      diags.length ? `Diagnostics:\n${diags.map((d) => `line ${d.line}: [${d.source ?? d.severity}] ${d.message}`).join('\n')}` : '',
      failure ? `Failed command output:\n${failure.slice(-6000)}` : '',
      ctx ? renderContext(ctx, { budgetTokens: 3000, includeRelated: false }) : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  } else {
    if (!ctx) throw new UserFacingError('Open a file to explain code.');
    if (intent.target === 'selection' && ctx.selection?.text) {
      what = `lines ${ctx.selection.startLine}–${ctx.selection.endLine}`;
      subject = `Explain the selected code.\n${renderContext(ctx, { budgetTokens: rt.settings().contextBudget })}`;
    } else if (intent.target === 'file') {
      what = ctx.relativePath ?? ctx.fileName;
      subject = `Explain this file: its purpose, main parts and how they fit together.\n${renderContext(ctx, { budgetTokens: rt.settings().contextBudget })}`;
    } else {
      const s = ctx.enclosingSymbol;
      what = s ? `\`${s.name}\`` : 'the code at the cursor';
      subject = `Explain ${s ? `the ${s.kind} \`${s.name}\`` : 'the code around the cursor'}.\n${renderContext(ctx, { budgetTokens: rt.settings().contextBudget })}`;
    }
  }

  rt.setPhase('thinking', 'Explaining…');
  rt.update({ title: `Explaining ${what}`, body: '' });
  const res = await rt.provider().complete(
    {
      purpose: 'explain',
      system: EXPLAIN_SYSTEM,
      messages: [{ role: 'user', content: `<context>\n${subject}\n</context>\n<transcript>${intent.transcript}</transcript>` }],
      signal,
      maxTokens: 1500,
    },
    {
      onFirstToken: (ms) => rt.metrics.record('llm.first-token', ms),
      onText: (_d, acc) => rt.update({ body: acc }),
    },
  );
  rt.metrics.record('llm.explain', res.latencyMs);
  track(rt, res.usage);
  return { ok: true, title: `Explanation of ${what}`, body: res.text, outcome: `Explained ${what}`, file: ctx?.relativePath, status: 'done' };
}

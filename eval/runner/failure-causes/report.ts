/**
 * The weekly summary and report. gbrain's top three is ranked on failures from
 * natural-condition runs of gbrain's own arms: each source's failures give
 * every cause a share, each source weighs the same, raw counts break ties, and
 * harness_error and model_error never enter the list. Forced-condition rows
 * and stress counts go to a separate "under stress" list, other systems to a
 * contrast table and harness errors to our own fix list. Example rows come
 * only from public or synthetic sources; private sources give counts only.
 */
import { STAGES, TAXONOMY_VERSION, causeInfo, type Cause, type Stage } from './taxonomy.ts';
import type { CauseLabel, StressCount } from './types.ts';

const NOT_FOR_GBRAIN: readonly string[] = ['harness_error', 'model_error'];
const GBRAIN_ROLES = new Set(['gbrain_default', 'gbrain_variant']);
const PENDING = 'pending_label';
const showable = (l: CauseLabel) => l.visibility === 'public' || l.visibility === 'synthetic';

export interface Example { source: string; case_id: string; model: string; rule_id: string; secondary: string[]; evidence: string[] }
export interface RankedCause { cause: string; score: number; count: number; by_source: Record<string, { count: number; of: number }>; top_rules: Array<{ rule_id: string; count: number }>; examples: Example[] }
export interface Summary {
  schema: 'failure-cause-summary/1';
  taxonomy_version: string;
  failures: number;
  sources: Record<string, { failures: number; condition: string; visibility: string; gbrain_shas: string[] }>;
  ranked: RankedCause[];
  top_three: RankedCause[];
  under_stress: Array<{ source: string; cause: string; unit: string; count: number; of: number; detail: string }>;
  contrast: Array<{ system: string; arm_role: string; cause: string; count: number }>;
  harness: Array<{ rule_id: string; count: number; sources: string[] }>;
  capability: Record<string, Partial<Record<Stage, number>>>;
  pending: number;
}

const tally = <T extends string>(xs: T[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<T, number>());

export function summarize(labels: CauseLabel[], stress: StressCount[] = []): Summary {
  const versions = [...new Set(labels.map(l => l.taxonomy_version))];
  if (versions.length > 1 || (versions[0] && versions[0] !== TAXONOMY_VERSION)) throw new Error(`labels mix taxonomy versions (${versions.join(', ')}); this code is ${TAXONOMY_VERSION}, so relabel before summarizing`);
  const failed = labels.filter(l => l.rule_id !== 'passed');
  const causeOf = (l: CauseLabel) => l.cause ?? PENDING;
  const sources: Summary['sources'] = {};
  for (const l of failed) {
    const s = sources[l.source] ??= { failures: 0, condition: l.condition, visibility: l.visibility, gbrain_shas: [] };
    s.failures++;
    if (l.gbrain_sha && !s.gbrain_shas.includes(l.gbrain_sha)) s.gbrain_shas.push(l.gbrain_sha);
  }
  const natural = failed.filter(l => l.condition === 'natural' && GBRAIN_ROLES.has(l.arm_role));
  const bySource = new Map<string, CauseLabel[]>();
  for (const l of natural) bySource.set(l.source, [...(bySource.get(l.source) ?? []), l]);
  const causes = [...new Set(natural.map(causeOf))];
  const ranked: RankedCause[] = causes.map(cause => {
    const by_source = Object.fromEntries([...bySource].map(([src, ls]) => [src, { count: ls.filter(l => causeOf(l) === cause).length, of: ls.length }]));
    const shares = Object.values(by_source).map(x => x.count / x.of);
    const rows = natural.filter(l => causeOf(l) === cause);
    return {
      cause, score: shares.reduce((a, b) => a + b, 0) / shares.length, count: rows.length, by_source,
      top_rules: [...tally(rows.map(l => l.rule_id))].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([rule_id, count]) => ({ rule_id, count })),
      examples: rows.filter(showable).slice(0, 3).map(l => ({ source: l.source, case_id: l.case_id, model: l.model, rule_id: l.rule_id, secondary: l.secondary, evidence: l.evidence })),
    };
  }).sort((a, b) => b.score - a.score || b.count - a.count || a.cause.localeCompare(b.cause));
  const forced = failed.filter(l => l.condition === 'forced' && GBRAIN_ROLES.has(l.arm_role));
  const forcedRows = [...tally(forced.map(l => `${l.source}\t${causeOf(l)}`))].map(([k, count]) => {
    const [source, cause] = k.split('\t');
    return { source, cause, unit: 'episodes', count, of: forced.filter(l => l.source === source).length, detail: `${count} failed rows` };
  });
  const capability: Summary['capability'] = {};
  for (const [src, ls] of tally(failed.map(l => l.source))) {
    const rows = failed.filter(l => l.source === src);
    capability[src] = Object.fromEntries(STAGES.map(s => [s, Number((rows.filter(l => !l.unmeasured.includes(s)).length / ls).toFixed(3))]));
  }
  const harnessRows = failed.filter(l => l.cause === 'harness_error');
  return {
    schema: 'failure-cause-summary/1', taxonomy_version: TAXONOMY_VERSION, failures: failed.length, sources,
    ranked, top_three: ranked.filter(r => r.cause !== PENDING && !NOT_FOR_GBRAIN.includes(r.cause)).slice(0, 3),
    under_stress: [...forcedRows, ...stress.map(s => ({ source: s.source, cause: s.cause, unit: s.unit, count: s.count, of: s.of, detail: s.detail }))],
    contrast: [...tally(failed.filter(l => !GBRAIN_ROLES.has(l.arm_role)).map(l => `${l.system}\t${l.arm_role}\t${causeOf(l)}`))]
      .map(([k, count]) => { const [system, arm_role, cause] = k.split('\t'); return { system, arm_role, cause, count }; }).sort((a, b) => b.count - a.count),
    harness: [...tally(harnessRows.map(l => l.rule_id))].map(([rule_id, count]) => ({ rule_id, count, sources: [...new Set(harnessRows.filter(l => l.rule_id === rule_id).map(l => l.source))] })),
    capability, pending: failed.filter(l => l.cause === null).length,
  };
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const title = (cause: string) => causeInfo(cause)?.title ?? (cause === PENDING ? 'Waiting for the labeller' : cause);

/** Proposed regression test, per cause: what a check must show once gbrain fixes the cause. */
export const REGRESSION_TESTS: Record<Cause, string> = {
  harness_error: 'A keyless test in gbrain-evals that replays the failing record through the fixed runner or scorer and asserts it now scores.',
  operations: 'A nightly smoke that runs the failing operation on a fresh brain at the pinned Postgres version and asserts it exits 0 with the brain readable.',
  ingest_gap: 'A keyless ingest test that imports the source record and asserts the gold fact is stored once, verbatim, and indexed.',
  privacy_hidden: 'A visibility test that counts gold hidden from the caller by cause (private flag, alias, derived page) and asserts the count matches the intended policy.',
  tool_contract: 'A recorded-call replay: send the exact failing arguments to the tool and assert it answers without an error, or with a fix the agent can follow.',
  write_integrity: 'A concurrency test that runs the failing write pattern many times and asserts no fact is lost, stuck, overwritten or stored twice.',
  memory_not_consulted: 'An agent smoke that asserts the agent calls memory before answering a question the brain can answer.',
  retrieval_miss: 'A retrieval test on the failing question shape that asserts the gold page is in the top 20 results.',
  partial_evidence: 'A retrieval test that asserts every required gold item for a multi-part question is in the delivered results.',
  wrong_ranking: 'A ranking test on the failing question shape that asserts the gold item is in the top 5 and survives packing.',
  gold_unopened: 'An agent smoke that asserts the agent opens a page that search returned and the answer needs.',
  summary_loss: 'A large-page test that asserts the needed detail survives the summary or the page cut the model receives.',
  stale_fact: 'A knowledge-update test that supersedes a fact and asserts the answer uses the newer one.',
  wrong_entity: 'A namesake test with two similar entities that asserts the answer is about the one asked.',
  time_reasoning: 'A temporal test that asserts dates and durations computed from the delivered evidence are right.',
  citation_abstention: 'An abstention and citation test that asserts the answer abstains when the brain has no answer and cites only what it read.',
  model_error: 'No gbrain test: model error with good context is reported for context only.',
  timeout_latency: 'A latency test that asserts the failing shape finishes within its turn or time budget.',
};

export function renderReport(s: Summary, options: { heading: string; notes?: string[] }): string {
  const lines = [`# ${options.heading}`, ''];
  if (options.notes?.length) lines.push(...options.notes.map(n => `- ${n}`), '');
  lines.push(`Taxonomy ${s.taxonomy_version}. ${s.failures} failed rows; ${s.pending} still wait for the labeller.`, '', '## gbrain top three', '');
  lines.push('Ranked on natural-condition runs of gbrain\'s own arms. Each source weighs the same; the share is the mean of the per-source shares.', '');
  s.top_three.forEach((r, i) => {
    lines.push(`### ${i + 1}. ${title(r.cause)} (\`${r.cause}\`)`, '', `Share ${pct(r.score)}, ${r.count} rows. By source: ${Object.entries(r.by_source).map(([src, x]) => `${src} ${x.count} of ${x.of}`).join('; ')}.`);
    lines.push(`Top rules: ${r.top_rules.map(x => `\`${x.rule_id}\` ${x.count}`).join(', ')}.`, '');
    if (r.examples.length) lines.push('Examples (public or synthetic rows):', ...r.examples.map(e => `- ${e.source} \`${e.case_id}\` (${e.model}), rule \`${e.rule_id}\`${e.secondary.length ? `, also ${e.secondary.join(', ')}` : ''}: ${e.evidence.join('; ')}`), '');
    lines.push(`Proposed regression test: ${REGRESSION_TESTS[r.cause as Cause] ?? 'to be written'}`, '');
  });
  if (!s.top_three.length) lines.push('No natural-condition gbrain failures in this window.', '');
  lines.push('## All causes, gbrain natural-condition runs', '', '| Cause | Share | Rows |', '|---|---|---|', ...s.ranked.map(r => `| \`${r.cause}\` | ${pct(r.score)} | ${r.count} |`), '');
  lines.push('## Under stress', '', 'Runs built to force a cause, and call-level or aggregate counts. Not ranked with the list above.', '', '| Source | Cause | Count | Of | Detail |', '|---|---|---|---|---|',
    ...s.under_stress.map(u => `| ${u.source} | \`${u.cause}\` | ${u.count} | ${u.of} ${u.unit} | ${u.detail} |`), '');
  lines.push('## Other systems and controls', '', '| System | Role | Cause | Rows |', '|---|---|---|---|', ...s.contrast.map(c => `| ${c.system} | ${c.arm_role} | \`${c.cause}\` | ${c.count} |`), '');
  lines.push('## Our own fix list (harness errors)', '', ...(s.harness.length ? s.harness.map(h => `- \`${h.rule_id}\`: ${h.count} rows (${h.sources.join(', ')})`) : ['- none']), '');
  lines.push('## What each source can measure', '', `| Source | ${STAGES.join(' | ')} |`, `|---|${STAGES.map(() => '---').join('|')}|`,
    ...Object.entries(s.capability).map(([src, c]) => `| ${src} | ${STAGES.map(st => pct(c[st] ?? 0)).join(' | ')} |`), '');
  return lines.join('\n');
}

export interface IssueDraft { signature: string; cause: string; title: string; body: string }

/** One draft per top-three cause, keyed by cause and top rule so a weekly run updates an open issue instead of filing a repeat. */
export function issueDrafts(s: Summary, repros: Partial<Record<string, string>> = {}): IssueDraft[] {
  return s.top_three.map(r => {
    const rule = r.top_rules[0]?.rule_id ?? 'none';
    const signature = `${r.cause}:${rule}`;
    const body = [
      `**Cause:** ${title(r.cause)} (\`${r.cause}\`, gap map ${causeInfo(r.cause)?.gap_map ?? '?'}). ${causeInfo(r.cause)?.meaning ?? ''}`,
      `**Counts:** ${r.count} failed rows, share ${pct(r.score)}. ${Object.entries(r.by_source).map(([src, x]) => `${src}: ${x.count} of ${x.of}`).join('; ')}.`,
      `**Top rules:** ${r.top_rules.map(x => `\`${x.rule_id}\` ${x.count}`).join(', ')}.`,
      `**Examples (public or synthetic):**`, ...(r.examples.length ? r.examples.map(e => `- ${e.source} \`${e.case_id}\`: ${e.evidence.join('; ')}`) : ['- none from a public or synthetic source this week']),
      `**Minimal repro:** ${repros[signature] ?? repros[r.cause] ?? 'to be attached by gbrain-evals before hand-off'}`,
      `**Proposed regression test:** ${REGRESSION_TESTS[r.cause as Cause] ?? 'to be written'}`,
      `Signature: \`${signature}\``,
    ].join('\n');
    return { signature, cause: r.cause, title: `${title(r.cause)}: ${r.count} failed rows (${rule})`, body };
  });
}


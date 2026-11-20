/**
 * The weekly summary and report. gbrain's top three is ranked on failures from
 * natural-condition runs of gbrain's own arms: each source's failures give
 * every cause a share, each source weighs the same, raw counts break ties, and
 * the causes gbrain can't fix (harness_error, item_unsupported, reader_budget,
 * model_error) and unclassified never enter the list (model_error and unclassified stay in the full table). Shares are
 * taken over the rows that say something about gbrain, so harness errors and the suite causes (rows that say nothing
 * about gbrain) never dilute them; those get their own lists. A labeller call that failed
 * or did not parse counts as pending. Forced-condition rows
 * and stress counts go to a separate "under stress" list, other systems to a
 * contrast table and harness errors to our own fix list. Example rows come
 * only from public or synthetic sources; private sources give counts only.
 *
 * Each ranked cause also says, per task and model, whether the other systems
 * and controls in the same source failed the same way, so a cause every
 * system shares on hard tasks is told apart from one only gbrain has (a system
 * whose source records that it never ran the task, a not_run row, is shown as
 * not run and is not compared); how
 * many of its rows hit the agent's turn cap; and whether rows still waiting
 * for the labeller could change its place (provisional).
 */
import { CAUSES, MODEL_CAUSES, STAGES, TAXONOMY_VERSION, UNCLASSIFIED, causeInfo, type Cause, type Stage } from './taxonomy.ts';
import { NO_LABEL_RULES } from './agreement.ts';
import type { CauseLabel, StressCount } from './types.ts';
import { renderAttribution, type Attribution } from './attribution.ts';

const NOT_FOR_GBRAIN: readonly string[] = [...CAUSES.filter(c => !c.gbrain_actionable).map(c => c.id), UNCLASSIFIED];
/** Our own side (gap map eval): harness errors, and suite causes for rows that say nothing about gbrain. Never in gbrain's shares. */
const EVAL_SIDE_CAUSES: readonly string[] = CAUSES.filter(c => c.gap_map === 'eval').map(c => c.id);
const SUITE_CAUSES: readonly string[] = EVAL_SIDE_CAUSES.filter(c => c !== 'harness_error');
const GBRAIN_ROLES = new Set(['gbrain_default', 'gbrain_variant']);
const PENDING = 'pending_label';
/** Rule id prefix of a row for a task its system never ran (classify, EvalFailure.not_run). */
const NOT_RUN = 'not_run.';
const showable = (l: CauseLabel) => l.visibility === 'public' || l.visibility === 'synthetic';

export interface Example { source: string; case_id: string; model: string; rule_id: string; secondary: string[]; evidence: string[] }
/**
 * One gbrain row of a cause, and each compared system's causes on the same task and model (null: no failed row there).
 * not_run lists the systems whose source records that they never ran this task and model; they are not in others.
 */
export interface TaskComparison { source: string; task_id: string; model: string; arm: string; others: Record<string, string | null>; not_run: string[] }
export interface RankedCause {
  cause: string; score: number; count: number; by_source: Record<string, { count: number; of: number }>; top_rules: Array<{ rule_id: string; count: number }>; examples: Example[];
  turn_cap: { count: number; by_category: Record<string, number> };
  others: Array<{ system: string; arm_role: string; same: number; other: number; none: number; not_run: number }>;
  /** Rows with at least one compared system, and those where none of them failed the same way. */
  compared: number; gbrain_only: number;
  tasks: TaskComparison[];
  /** Rows still waiting for the labeller could change this cause's place in the ranking. */
  provisional: boolean;
}
/** A status for an under-stress row, such as a fix gbrain already shipped; detail_includes narrows it to matching rows. */
export interface KnownStatus { source: string; cause: string; detail_includes?: string; status: string }
export interface Summary {
  schema: 'failure-cause-summary/1';
  taxonomy_version: string;
  failures: number;
  sources: Record<string, { failures: number; condition: string; visibility: string; gbrain_shas: string[] }>;
  ranked: RankedCause[];
  top_three: RankedCause[];
  under_stress: Array<{ source: string; cause: string; unit: string; count: number; of: number; detail: string; status: string | null }>;
  contrast: Array<{ system: string; arm_role: string; cause: string; count: number }>;
  harness: Array<{ rule_id: string; count: number; sources: string[] }>;
  /** Failed rows that say nothing about gbrain (the suite causes), by cause and source. */
  suite: Array<{ cause: string; count: number; by_source: Record<string, number> }>;
  /** reader_budget rows by source and their first secondary cause (what retrieval did on them, 'none' when they have none); no count above changes. */
  reader_budget_secondary: Record<string, Record<string, number>>;
  capability: Record<string, Partial<Record<Stage, number>>>;
  pending: number;
  /** The share the gbrain rows waiting for the labeller hold; one cause could gain all of it. */
  pending_share: number;
  /** gbrain natural-condition rows waiting for the labeller: public or synthetic ones listed, the rest counted. */
  waiting: Example[]; waiting_hidden: number;
  model_labelled: number;
}

const tally = <T extends string>(xs: T[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<T, number>());

const EVAL_SIDE = 'eval side: our harness or scorer, not gbrain';
/** Causes the labeller can still give a waiting row: its own causes, and the upstream misses evidence_not_delivered maps to. */
const LABELLER_REACHABLE = new Set<string>([...MODEL_CAUSES, 'retrieval_miss', 'wrong_ranking']);

export function summarize(labels: CauseLabel[], stress: StressCount[] = [], options: { known?: KnownStatus[] } = {}): Summary {
  const versions = [...new Set(labels.map(l => l.taxonomy_version))];
  if (versions.length > 1 || (versions[0] && versions[0] !== TAXONOMY_VERSION)) throw new Error(`labels mix taxonomy versions (${versions.join(', ')}); this code is ${TAXONOMY_VERSION}, so relabel before summarizing`);
  const failed = labels.filter(l => l.rule_id !== 'passed' && !l.rule_id.startsWith(NOT_RUN));
  const waiting = (l: CauseLabel) => l.cause === null || NO_LABEL_RULES.includes(l.rule_id);
  const causeOf = (l: CauseLabel) => (waiting(l) ? PENDING : l.cause!);
  const sources: Summary['sources'] = {};
  for (const l of failed) {
    const s = sources[l.source] ??= { failures: 0, condition: l.condition, visibility: l.visibility, gbrain_shas: [] };
    s.failures++;
    if (l.gbrain_sha && !s.gbrain_shas.includes(l.gbrain_sha)) s.gbrain_shas.push(l.gbrain_sha);
  }
  const natural = failed.filter(l => l.condition === 'natural' && GBRAIN_ROLES.has(l.arm_role) && !EVAL_SIDE_CAUSES.includes(l.cause ?? ''));
  const bySource = new Map<string, CauseLabel[]>();
  for (const l of natural) bySource.set(l.source, [...(bySource.get(l.source) ?? []), l]);
  const isOther = (l: CauseLabel) => l.condition === 'natural' && !GBRAIN_ROLES.has(l.arm_role) && l.task_id;
  const taskKey = (source: string, system: string, task: string, model: string) => `${source}|${system}|${task}|${model}`;
  const systems = new Map<string, Map<string, string>>();
  const otherCauses = new Map<string, Set<string>>();
  const notRun = new Set<string>();
  for (const l of labels.filter(isOther)) {
    const skipped = l.rule_id.startsWith(NOT_RUN);
    if (!skipped && l.rule_id === 'passed') continue;
    if (!systems.has(l.source)) systems.set(l.source, new Map());
    systems.get(l.source)!.set(l.system, l.arm_role);
    const k = taskKey(l.source, l.system, l.task_id!, l.model);
    if (skipped) notRun.add(k);
    else otherCauses.set(k, (otherCauses.get(k) ?? new Set()).add(causeOf(l)));
  }
  const example = (l: CauseLabel): Example => ({ source: l.source, case_id: l.case_id, model: l.model, rule_id: l.rule_id, secondary: l.secondary, evidence: l.evidence });
  const causes = [...new Set(natural.map(causeOf))];
  const ranked: RankedCause[] = causes.map(cause => {
    const by_source = Object.fromEntries([...bySource].map(([src, ls]) => [src, { count: ls.filter(l => causeOf(l) === cause).length, of: ls.length }]));
    const shares = Object.values(by_source).map(x => x.count / x.of);
    const rows = natural.filter(l => causeOf(l) === cause);
    const capped = rows.filter(l => l.tags.includes('turn_cap'));
    const tasks: TaskComparison[] = rows.filter(l => l.task_id).map(l => {
      const k = (sys: string) => taskKey(l.source, sys, l.task_id!, l.model);
      const all = [...(systems.get(l.source) ?? new Map<string, string>()).keys()];
      const skipped = all.filter(sys => notRun.has(k(sys)) && !otherCauses.has(k(sys)));
      return { source: l.source, task_id: l.task_id!, model: l.model, arm: l.arm, not_run: skipped,
        others: Object.fromEntries(all.filter(sys => !skipped.includes(sys)).map(sys => [sys, [...(otherCauses.get(k(sys)) ?? [])].sort().join('+') || null])) };
    });
    const failedSame = (c: string | null) => c !== null && c.split('+').includes(cause);
    const others = [...systems.values()].flatMap(m => [...m]).map(([system, arm_role]) => {
      const seen = tasks.filter(t => system in t.others);
      const same = seen.filter(t => failedSame(t.others[system])).length;
      const none = seen.filter(t => t.others[system] === null).length;
      return { system, arm_role, same, other: seen.length - same - none, none, not_run: tasks.filter(t => t.not_run.includes(system)).length };
    }).filter(o => o.same + o.other + o.none + o.not_run > 0);
    const withOthers = tasks.filter(t => Object.keys(t.others).length);
    return {
      cause, score: shares.reduce((a, b) => a + b, 0) / shares.length, count: rows.length, by_source,
      top_rules: [...tally(rows.map(l => l.rule_id))].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([rule_id, count]) => ({ rule_id, count })),
      examples: rows.filter(showable).slice(0, 3).map(example),
      turn_cap: { count: capped.length, by_category: Object.fromEntries([...tally(capped.map(l => l.category ?? 'unknown'))].sort((a, b) => b[1] - a[1])) },
      others, compared: withOthers.length, gbrain_only: withOthers.filter(t => !Object.values(t.others).some(failedSame)).length, tasks, provisional: false,
    };
  }).sort((a, b) => b.score - a.score || b.count - a.count || a.cause.localeCompare(b.cause));
  const pendingShare = ranked.find(r => r.cause === PENDING)?.score ?? 0;
  const forGbrain = ranked.filter(r => r.cause !== PENDING && !NOT_FOR_GBRAIN.includes(r.cause));
  forGbrain.forEach((r, i) => {
    const threat = Math.max(pendingShare, ...forGbrain.slice(i + 1).map(b => b.score + (LABELLER_REACHABLE.has(b.cause) ? pendingShare : 0)));
    r.provisional = pendingShare > 0 && !(r.score > threat);
  });
  const waitingRows = natural.filter(l => causeOf(l) === PENDING);
  const statusOf = (source: string, cause: string, detail: string) => options.known?.find(k => k.source === source && k.cause === cause && (!k.detail_includes || detail.includes(k.detail_includes)))?.status
    ?? (cause === 'harness_error' ? EVAL_SIDE : null);
  const forced = failed.filter(l => l.condition === 'forced' && GBRAIN_ROLES.has(l.arm_role));
  const forcedRows = [...tally(forced.map(l => `${l.source}\t${causeOf(l)}`))].map(([k, count]) => {
    const [source, cause] = k.split('\t');
    const detail = `${count} failed rows`;
    return { source, cause, unit: 'episodes', count, of: forced.filter(l => l.source === source).length, detail, status: statusOf(source, cause, detail) };
  });
  const capability: Summary['capability'] = {};
  for (const [src, ls] of tally(failed.map(l => l.source))) {
    const rows = failed.filter(l => l.source === src);
    capability[src] = Object.fromEntries(STAGES.map(s => [s, Number((rows.filter(l => !l.unmeasured.includes(s)).length / ls).toFixed(3))]));
  }
  const harnessRows = failed.filter(l => l.cause === 'harness_error');
  const suiteRows = failed.filter(l => SUITE_CAUSES.includes(l.cause ?? ''));
  const budgetRows = failed.filter(l => l.cause === 'reader_budget');
  const bySecondary = (ls: CauseLabel[]) => Object.fromEntries([...tally(ls.map(l => l.secondary[0] ?? 'none'))].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  return {
    schema: 'failure-cause-summary/1', taxonomy_version: TAXONOMY_VERSION, failures: failed.length, sources,
    ranked, top_three: forGbrain.slice(0, 3),
    under_stress: [...forcedRows, ...stress.map(s => ({ source: s.source, cause: s.cause, unit: s.unit, count: s.count, of: s.of, detail: s.detail, status: statusOf(s.source, s.cause, s.detail) }))],
    contrast: [...tally(failed.filter(l => !GBRAIN_ROLES.has(l.arm_role)).map(l => `${l.system}\t${l.arm_role}\t${causeOf(l)}`))]
      .map(([k, count]) => { const [system, arm_role, cause] = k.split('\t'); return { system, arm_role, cause, count }; }).sort((a, b) => b.count - a.count),
    harness: [...tally(harnessRows.map(l => l.rule_id))].map(([rule_id, count]) => ({ rule_id, count, sources: [...new Set(harnessRows.filter(l => l.rule_id === rule_id).map(l => l.source))] })),
    suite: [...tally(suiteRows.map(l => l.cause!))].map(([cause, count]) => ({ cause, count, by_source: Object.fromEntries(tally(suiteRows.filter(l => l.cause === cause).map(l => l.source))) })),
    reader_budget_secondary: Object.fromEntries([...new Set(budgetRows.map(l => l.source))].sort().map(src => [src, bySecondary(budgetRows.filter(l => l.source === src))])),
    capability, pending: failed.filter(waiting).length, pending_share: pendingShare,
    waiting: waitingRows.filter(showable).map(example), waiting_hidden: waitingRows.filter(l => !showable(l)).length,
    model_labelled: failed.filter(l => l.basis === 'model').length,
  };
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const title = (cause: string) => causeInfo(cause)?.title ?? (cause === PENDING ? 'Waiting for the labeller' : cause);

/** Proposed regression test, per cause: what a check must show once gbrain fixes the cause. */
export const REGRESSION_TESTS: Record<Cause, string> = {
  harness_error: 'A keyless test in gbrain-evals that replays the failing record through the fixed runner or scorer and asserts it now scores.',
  item_unsupported: 'No gbrain test: a keyless suite check in gbrain-evals that every item passes the support check, or that items failing it are left out of the suite.',
  reader_budget: 'No gbrain test: a keyless suite check in gbrain-evals that the reader is given at least as many items as each question has gold, or that such questions are left out.',
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

const listCounts = (m: Record<string, number>) => Object.entries(m).map(([k, n]) => `${k} ${n}`).join(', ');
const LEVER_STAGES: readonly string[] = ['retrieval', 'ranking', 'open'];

/** Turn-cap and other-system lines for one ranked cause, shared by the report and the issue drafts. */
function context(r: RankedCause): string[] {
  const out: string[] = [];
  if (r.turn_cap.count) {
    const lever = LEVER_STAGES.includes(causeInfo(r.cause)?.stage ?? '') ? ' For these rows the lever may be reaching many pages in fewer calls, not better ranking.' : '';
    out.push(`Turn cap: ${r.turn_cap.count} of ${r.count} rows hit the agent's turn cap (${listCounts(r.turn_cap.by_category)}). The cap is our harness setting and part of what these rows measure.${lever}`);
  }
  if (r.others.length) {
    out.push(`Same task and model on other systems: ${r.others.map(o => `${o.system} (${o.arm_role}) failed the same way on ${o.same}, another way on ${o.other}, and had no failed row on ${o.none}${o.not_run ? `, and did not run ${o.not_run}` : ''}`).join('; ')}. `
      + `On ${r.gbrain_only} of ${r.compared} compared rows, no other system failed the same way.`);
  } else if (r.count) out.push('Same task and model on other systems: no compared system in these sources.');
  return out;
}

export function renderReport(s: Summary, options: { heading: string; notes?: string[]; attribution?: Attribution }): string {
  const lines = [`# ${options.heading}`, ''];
  if (options.notes?.length) lines.push(...options.notes.map(n => `- ${n}`), '');
  lines.push(`Taxonomy ${s.taxonomy_version}. ${s.failures} failed rows; ${s.pending} still wait for the labeller.`, '');
  if (!s.model_labelled) lines.push('Every count here comes from deterministic log rules. No model labeller has passed its agreement check yet, so rows the logs could not explain are shown as waiting, not counted.', '');
  lines.push('## gbrain top three', '');
  lines.push('Ranked on natural-condition runs of gbrain\'s own arms. Each source weighs the same; the share is the mean of the per-source shares.', '');
  if (s.pending_share > 0) lines.push(`Rows waiting for the labeller hold ${pct(s.pending_share)} of the share. A place marked provisional could change once they are labelled, if enough of them got one cause.`, '');
  s.top_three.forEach((r, i) => {
    lines.push(`### ${i + 1}. ${title(r.cause)} (\`${r.cause}\`)${r.provisional ? ', provisional' : ''}`, '', `Share ${pct(r.score)}, ${r.count} rows. By source: ${Object.entries(r.by_source).map(([src, x]) => `${src} ${x.count} of ${x.of}`).join('; ')}.`);
    lines.push(`Top rules: ${r.top_rules.map(x => `\`${x.rule_id}\` ${x.count}`).join(', ')}.`, '', ...context(r).flatMap(c => [c, '']));
    if (r.examples.length) lines.push('Examples (public or synthetic rows):', ...r.examples.map(e => `- ${e.source} \`${e.case_id}\` (${e.model}), rule \`${e.rule_id}\`${e.secondary.length ? `, also ${e.secondary.join(', ')}` : ''}: ${e.evidence.join('; ')}`), '');
    lines.push(`Proposed regression test: ${REGRESSION_TESTS[r.cause as Cause] ?? 'to be written'}`, '');
  });
  if (!s.top_three.length) lines.push('No natural-condition gbrain failures in this window.', '');
  lines.push('## All causes, gbrain natural-condition runs', '', '| Cause | Share | Rows | Turn cap | No other system failed the same way |', '|---|---|---|---|---|',
    ...s.ranked.map(r => `| \`${r.cause}\`${r.provisional ? ' (provisional)' : ''} | ${pct(r.score)} | ${r.count} | ${r.turn_cap.count} | ${r.compared ? `${r.gbrain_only} of ${r.compared}` : 'n/a'} |`), '');
  if (s.waiting.length || s.waiting_hidden) {
    lines.push('## Waiting for the labeller', '', ...s.waiting.map(e => `- ${e.source} \`${e.case_id}\` (${e.model}): ${e.evidence.join('; ')}`));
    if (s.waiting_hidden) lines.push(`- ${s.waiting_hidden} more from private sources (counts only)`);
    lines.push('');
  }
  if (options.attribution) lines.push(...renderAttribution(options.attribution));
  lines.push('## Under stress', '', 'Runs built to force a cause, and call-level or aggregate counts. Not ranked with the list above.', '', '| Source | Cause | Count | Of | Detail | Status |', '|---|---|---|---|---|---|',
    ...s.under_stress.map(u => `| ${u.source} | \`${u.cause}\` | ${u.count} | ${u.of} ${u.unit} | ${u.detail} | ${u.status ?? ''} |`), '');
  lines.push('## Other systems and controls', '', '| System | Role | Cause | Rows |', '|---|---|---|---|', ...s.contrast.map(c => `| ${c.system} | ${c.arm_role} | \`${c.cause}\` | ${c.count} |`), '');
  lines.push('## Our own fix list (harness errors)', '', ...(s.harness.length ? s.harness.map(h => `- \`${h.rule_id}\`: ${h.count} rows (${h.sources.join(', ')})`) : ['- none']), '');
  lines.push('## Suite causes', '', 'Failed rows that say nothing about gbrain: the question has more gold than the reader is given, or the cited gold sessions don\'t support the answer. Not ranked and not in the shares above.', '',
    ...(s.suite.length ? s.suite.map(x => `- ${title(x.cause)} (\`${x.cause}\`): ${x.count} rows (${listCounts(x.by_source)})`) : ['- none']));
  const secondary = Object.entries(s.reader_budget_secondary);
  if (secondary.length) lines.push(`- What retrieval did on the \`reader_budget\` rows (each row's first secondary cause, for information only): ${secondary.map(([src, m]) => `${src} ${listCounts(m)}`).join('; ')}.`);
  lines.push('');
  lines.push('## What each source can measure', '', `| Source | ${STAGES.join(' | ')} |`, `|---|${STAGES.map(() => '---').join('|')}|`,
    ...Object.entries(s.capability).map(([src, c]) => `| ${src} | ${STAGES.map(st => pct(c[st] ?? 0)).join(' | ')} |`), '');
  const appendix = s.top_three.filter(r => r.tasks.some(t => Object.keys(t.others).length || t.not_run.length));
  if (appendix.length) {
    lines.push('## Appendix: top-three rows beside other systems on the same task and model', '', `Each cell is that system's cause on the task, or a dash when it had no failed row there${appendix.some(r => r.tasks.some(t => t.not_run.length)) ? ', or "not run" when its source records that it never ran the task' : ''}.`, '');
    for (const r of appendix) {
      for (const source of [...new Set(r.tasks.map(t => t.source))]) {
        const rows = r.tasks.filter(t => t.source === source);
        const systems = [...new Set(rows.flatMap(t => [...Object.keys(t.others), ...t.not_run]))];
        if (!systems.length) continue;
        lines.push(`### \`${r.cause}\` in ${source}`, '', `| Task | Model | gbrain arm | ${systems.join(' | ')} |`, `|---|---|---|${systems.map(() => '---').join('|')}|`,
          ...rows.map(t => `| \`${t.task_id}\` | ${t.model} | ${t.arm} | ${systems.map(sys => (t.others[sys] ? `\`${t.others[sys]}\`` : t.not_run.includes(sys) ? 'not run' : '-')).join(' | ')} |`), '');
      }
    }
  }
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
      ...context(r),
      ...(r.provisional ? ['**Provisional:** rows still waiting for the labeller could change this place in the ranking.'] : []),
      `**Examples (public or synthetic):**`, ...(r.examples.length ? r.examples.map(e => `- ${e.source} \`${e.case_id}\`: ${e.evidence.join('; ')}`) : ['- none from a public or synthetic source this week']),
      `**Minimal repro:** ${repros[signature] ?? repros[r.cause] ?? 'to be attached by gbrain-evals before hand-off'}`,
      `**Proposed regression test:** ${REGRESSION_TESTS[r.cause as Cause] ?? 'to be written'}`,
      `Signature: \`${signature}\``,
    ].join('\n');
    return { signature, cause: r.cause, title: `${title(r.cause)}: ${r.count} failed rows (${rule})${r.provisional ? ', provisional' : ''}`, body };
  });
}


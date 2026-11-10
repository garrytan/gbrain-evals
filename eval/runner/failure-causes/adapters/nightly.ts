/**
 * Nightly outcome rows (eval/runner/nightly/outcome.ts, schema nightly-outcome/1), read from a night's outcomes.jsonl or
 * outcomes.jsonl.gz (role outcomes). Each row carries its suite's facts (system, arm, arm_role, condition, visibility,
 * agent_loop) and the stages its suite measures, so this adapter maps fields and infers none: a field the row leaves
 * absent or null stays null, and classify lists that stage as unmeasured. A row without the suite facts predates them and
 * is skipped.
 *
 * Identity: run_id <night>|<ref>|<sha>, case_id <suite>|<item>|<reader>|t<trial>, task_id the item, model the reader as
 * provider:model. A later row with the same identity replaces an earlier one, as the nightly's own readOutcomes does, so
 * the earlier row counts as a duplicate. A row for an item the night scheduled and did not run (skipped) comes back as a
 * not_run row. A keyless row (reader null: the concurrency trials, the system smokes, the tool-contract replay) has no
 * provider family for the labeller, so its failure is classified here and counted per night, suite and cause as a stress
 * count; a keyless failure with no deterministic cause is skipped with that reason.
 *
 * stop: turn_cap and the other loop stops stay; a wall timeout (smoke_timeout) is timeout; harness_error and error are
 * harness_error; an ordinary end (submitted, answered, replayed, pass, fail, ok) is null. Tags: misreport when the write
 * report was wrong (report_correct false), no_answer when there was no answer to judge (answered false), measured_at_10
 * when the gold coverage is the QA runner's at 10. Row text goes only on public or synthetic rows with an answer.
 *
 * harness is the nightly's harnessOf: an answer cut off at its output limit is a harness failure whether or not its row
 * records the cut (older rows record only the finish reason), so old and new rows classify alike, as
 * harness.output_truncated. A harness row is a failure even when its judge passed it, as the nightly report counts it.
 *
 * reader_budget is the most sessions the row's reader was given, from its run's memory-qa receipt
 * (reading.breadth_sessions, when the reader read the top sessions) in a role-logs file: a suite's published logs
 * archive, <suite>/<reader>/out/receipt.json inside. It is matched by suite, gbrain sha and reader, two receipts that
 * disagree for one of those are refused, and the receipt joins the row's evidence. With no logs file, or no receipt for
 * the row, reader_budget stays null.
 *
 * gold.unsupported comes from the suite's per-item support record (eval/runner/nightly/item-support.ts): both support
 * validators reject the item, or it cites no turn. The record joins the row's evidence. An item with no record, or one
 * that only one validator rejects, stays null.
 */
import { itemUnsupported } from '../../nightly/item-support.ts';
import { harnessOf, OUTCOME_SCHEMA, qualifiedModel, type Outcome } from '../../nightly/outcome.ts';
import { classify } from '../classify.ts';
import { fileText, pointer, tarFiles, type LoadedFile, type SourceEntry } from '../manifest.ts';
import type { Tag } from '../taxonomy.ts';
import { EVAL_FAILURE_SCHEMA, type EvalFailure, type StressCount } from '../types.ts';
import { emptyCounts, skip, type AdapterOutput } from './shared.ts';

const ENDED = new Set(['submitted', 'answered', 'replayed', 'pass', 'fail', 'ok']);
const TIMEOUTS = new Set(['smoke_timeout']);
const KEYLESS = 'none (keyless)';

function stopOf(stop: string | null): string | null {
  if (stop === null || ENDED.has(stop)) return null;
  if (stop === 'harness_error' || stop === 'error') return 'harness_error';
  return TIMEOUTS.has(stop) ? 'timeout' : stop;
}

/** One outcome row as an EvalFailure: a failure when it did not pass, a not_run row when it was skipped. */
export function nightlyFailure(o: Outcome, source: string, evidence: string[], readerBudget: number | null = null): EvalFailure {
  const harness = harnessOf(o);
  const support = itemUnsupported(o.suite, o.item);
  const tags: Tag[] = [];
  if (o.evidence.report_correct === false) tags.push('misreport');
  if (o.answered === false) tags.push('no_answer');
  if (o.retrieved != null && typeof o.evidence.recall_any_at_10 === 'number') tags.push('measured_at_10');
  const text = (o.visibility === 'public' || o.visibility === 'synthetic') && o.question && o.answer
    ? { text: { question: o.question, expected: o.expected ?? null, answer: o.answer, context: o.context ?? null } } : {};
  return {
    schema: EVAL_FAILURE_SCHEMA, source, run_id: `${o.night}|${o.ref}|${o.sha}`, case_id: `${o.suite}|${o.item}|${o.reader ?? 'keyless'}|t${o.trial}`, task_id: o.item,
    system: o.system, arm: o.arm, arm_role: o.arm_role, condition: o.condition, visibility: o.visibility,
    model: o.reader === null ? KEYLESS : o.reader === 'fake' ? 'fake' : qualifiedModel(o.reader), gbrain_sha: o.sha,
    failed: !o.skipped && (!o.pass || harness !== null), ...(o.skipped ? { not_run: o.skipped } : {}), score: o.score, category: o.category ?? null, agent_loop: o.agent_loop,
    stop: stopOf(o.stop), finish_reason: o.finish_reason ?? null, harness: harness ? { error: harness.error, scorer_artifact: null } : null,
    operation: o.operation ?? null, tool_calls: o.calls ?? null,
    gold: { gold_count: o.gold_count ?? null, stored: null, hidden: null, retrieved: o.retrieved ?? null, delivered: o.delivered ?? null, opened: o.opened ?? null, summary_only: null,
      reader_budget: readerBudget, unsupported: support?.why ?? null },
    writes: o.writes ?? null, tags, evidence: support ? [...evidence, support.at] : evidence, ...text,
  };
}

/** The sessions each memory-qa reader was given at most, by suite, gbrain sha and reader, from the receipts in role-logs archives. */
function readerBudgets(files: LoadedFile[]): Map<string, { sessions: number; at: string }> {
  const budgets = new Map<string, { sessions: number; at: string }>();
  for (const f of files.filter(x => x.role === 'logs')) for (const [path, bytes] of tarFiles(f)) {
    const suite = /^([^/]+)\/[^/]+\/out\/receipt\.json$/.exec(path)?.[1];
    if (!suite) continue;
    const r = JSON.parse(new TextDecoder().decode(bytes));
    const sessions = r.qa?.mode === 'reader' && r.qa?.context === 'sessions' ? r.reading?.breadth_sessions : null;
    if (!Number.isInteger(sessions) || typeof r.qa.reader !== 'string' || typeof r.product?.loaded_git_head !== 'string') continue;
    const key = `${suite}|${r.product.loaded_git_head}|${r.qa.reader}`;
    const at = pointer(f, path);
    const seen = budgets.get(key);
    if (seen && seen.sessions !== sessions) throw new Error(`${at}: gives ${key} ${sessions} reader sessions, ${seen.at} gives ${seen.sessions}`);
    budgets.set(key, seen ?? { sessions, at });
  }
  return budgets;
}

export function fromNightly(files: LoadedFile[], entry: SourceEntry): AdapterOutput {
  const counts = emptyCounts();
  const budgets = readerBudgets(files);
  const failures: EvalFailure[] = [];
  const notRun: EvalFailure[] = [];
  const rows = new Map<string, { o: Outcome; at: string }>();
  for (const f of files.filter(x => x.role === 'outcomes')) {
    fileText(f).split('\n').forEach((line, i) => {
      if (!line.trim()) return;
      counts.read++;
      const o = JSON.parse(line) as Outcome;
      if (o.schema !== OUTCOME_SCHEMA) throw new Error(`${pointer(f, `line=${i + 1}`)}: not a ${OUTCOME_SCHEMA} row`);
      const key = `${o.night}|${o.ref}|${o.sha}|${o.suite}|${o.item}|${o.reader ?? ''}|${o.trial}`;
      if (rows.has(key)) counts.duplicate++;
      rows.set(key, { o, at: pointer(f, `line=${i + 1}`) });
    });
  }
  const stress = new Map<string, { base: Omit<StressCount, 'count' | 'detail' | 'of'>; suite: string; rules: string[] }>();
  const ran = new Map<string, number>();
  for (const { o, at } of rows.values()) {
    if (typeof o.system !== 'string' || typeof o.condition !== 'string' || typeof o.visibility !== 'string') { skip(counts, 'row predates the suite facts'); continue; }
    const budget = o.reader === null || o.reader === 'fake' ? undefined : budgets.get(`${o.suite}|${o.sha}|${qualifiedModel(o.reader)}`);
    const f = nightlyFailure(o, entry.id, budget ? [at, budget.at] : [at], budget?.sessions ?? null);
    if (o.skipped) { skip(counts, o.skipped); notRun.push(f); continue; }
    if (o.reader === null) ran.set(`${f.run_id}|${o.suite}`, (ran.get(`${f.run_id}|${o.suite}`) ?? 0) + 1);
    if (!f.failed) { counts.mapped++; continue; }
    if (o.reader !== null) { counts.mapped++; counts.failed++; failures.push(f); continue; }
    const label = classify(f);
    if (label.cause === null || label.cause === 'unclassified') { skip(counts, 'keyless failure with no deterministic cause'); continue; }
    counts.mapped++;
    counts.failed++;
    const key = `${f.run_id}|${o.suite}|${label.cause}`;
    const s = stress.get(key) ?? { base: { source: entry.id, run_id: f.run_id, system: o.system, model: KEYLESS, gbrain_sha: o.sha, condition: o.condition, visibility: o.visibility,
      cause: label.cause, unit: 'episodes', evidence: [] }, suite: o.suite, rules: [] };
    s.base.evidence.push(at);
    s.rules.push(label.rule_id);
    stress.set(key, s);
  }
  return {
    failures, not_run: notRun, counts,
    stress: [...stress.values()].map(({ base, suite, rules }) => {
      const byRule = [...rules.reduce((m, r) => m.set(r, (m.get(r) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const of = ran.get(`${base.run_id}|${suite}`)!;
      return { ...base, count: rules.length, of, detail: `${suite}: ${byRule.map(([r, n]) => `${r} (${n})`).join(', ')} in ${rules.length} of ${of} items` };
    }),
  };
}

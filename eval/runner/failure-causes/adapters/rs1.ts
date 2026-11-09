/**
 * RS1 stage 1 cells (eval/runner/q1/cell.ts output on public BEAM-1M dev
 * conversations). A row fails when its gating frontier judge scores it below
 * 1: GPT-6.1 Sol judges Claude readers and Opus 5.5 judges GPT readers, as the
 * RS1 preregistration gates. Gold coverage comes from the row's recall at 10
 * (tag measured_at_10). Delivered coverage is known only when nothing was
 * packed out and every offered item is in that top 10; otherwise ranking is
 * unmeasured.
 *
 * An answer whose outcome the cell never judges follows memory-qa/outcomes.ts
 * and is tagged no_answer: there is no answer to judge, so it never counts as an
 * answered abstention question, carries no row text and never reaches the
 * labeller. A turn cap or context overflow is a failed row with cause
 * timeout_latency. A retrieval_error is gbrain's retrieval miss (tag
 * retrieve_error, which classify counts as retrieval_miss) only when the row
 * records that the retrieval itself failed, as a packed arm's row does; a
 * retrieval that timed out (error_kind timeout) is stop timeout instead. A store
 * arm (agent, own answer, full context) retrieves inside the system, and its row
 * records no retrieval outcome, so its retrieval_error is no retrieval miss: an
 * agent out of wall time (stop_reason wall_time) is stop timeout, and any other,
 * such as an own-answer endpoint error, has no stage signal and stays
 * unclassified (residual.no_answer). An own-answer answer records no error kind,
 * so its timeouts stay unclassified too. An unsupported answer is a product miss
 * that stays in the denominator, unclassified the same way. budget_not_run
 * (never asked) and does_not_fit (not applicable) are skipped, and each comes
 * back as a not_run row so the report's same-task comparison shows that system
 * as not run rather than as having no failed row. A reader, judge or harness
 * error, and any other outcome, is harness_error. An ingest_degraded answer is
 * judged like any other, and when it fails it counts as operations (ingest
 * path). Each directory's rows, answers and judgments files form one cell; gold
 * and context files are shared.
 */
import { dirname } from 'node:path';
import { fileText, ndjson, pointer, type LoadedFile, type SourceEntry } from '../manifest.ts';
import type { Tag } from '../taxonomy.ts';
import { EVAL_FAILURE_SCHEMA, type ArmRole, type Coverage, type EvalFailure, type FailureText } from '../types.ts';
import { emptyCounts, skip, type AdapterOutput } from './shared.ts';

type Rec = Record<string, any>;

export const RS1_GATING_JUDGE: Record<string, string> = { anthropic: 'openai:gpt-6.1-sol', openai: 'anthropic:claude-opus-5-5' };
/** Outcomes q1/cell.ts judges (its JUDGED set). */
const JUDGED = new Set(['scored', 'ingest_degraded']);
const BUDGET_STOPS = new Set(['turn_cap', 'context_overflow']);
/** Unjudged product misses that stay in the denominator with no harness error (outcomes.ts PRODUCT_FAILURES). */
const PRODUCT_MISSES = new Set(['retrieval_error', 'unsupported']);
/** Never asked, or not applicable (outcomes.ts NOT_APPLICABLE): skipped, with these reasons. */
const SKIPPED = new Map([['budget_not_run', 'budget_not_run'], ['does_not_fit', 'does_not_fit (not applicable)']]);

export function rs1ArmRole(cell: string, entry: SourceEntry): ArmRole {
  const named = Object.entries(entry.arm_roles ?? {}).find(([k]) => cell.includes(k));
  if (named) return named[1];
  if (/gbrain/.test(cell)) return 'gbrain_default';
  if (/baseline-none/.test(cell)) return 'control';
  return 'other_system';
}

function coverage(row: Rec): Coverage | null {
  if (typeof row.recall_any_at_10 !== 'number') return null;
  if (row.recall_any_at_10 <= 0) return 'none';
  return typeof row.recall_all_at_10 === 'number' && row.recall_all_at_10 >= 1 ? 'all' : 'partial';
}

export function fromRs1(files: LoadedFile[], entry: SourceEntry): AdapterOutput {
  const counts = emptyCounts();
  const failures: EvalFailure[] = [];
  const notRun: EvalFailure[] = [];
  const cells = new Map<string, Partial<Record<'rows' | 'answers' | 'judgments', LoadedFile>>>();
  for (const f of files) {
    if (f.role !== 'rows' && f.role !== 'answers' && f.role !== 'judgments') continue;
    const cell = cells.get(dirname(f.path)) ?? {};
    if (cell[f.role]) throw new Error(`${pointer(f)}: a second ${f.role} file in ${dirname(f.path)}; each cell directory holds one of each`);
    cell[f.role] = f;
    cells.set(dirname(f.path), cell);
  }
  if (!cells.size) throw new Error(`${entry.id}: an rs1 source needs rows, answers and judgments files`);
  for (const [dir, cell] of cells) if (!cell.rows || !cell.answers || !cell.judgments) throw new Error(`${entry.id}: cell ${dir} needs rows, answers and judgments files`);
  const gold = new Map<string, Rec>();
  for (const g of files.filter(f => f.role === 'gold')) {
    const conversation = g.path.match(/(\d+[mk]-\d+)-probing_questions\.json$/)?.[1];
    if (!conversation) throw new Error(`${pointer(g)}: a gold file is named <conversation>-probing_questions.json`);
    for (const [category, qs] of Object.entries(JSON.parse(fileText(g)) as Record<string, Rec[]>)) qs.forEach((q, i) => gold.set(`${conversation}:${category}:${i}`, q));
  }
  const contexts = new Map<string, string>();
  for (const c of files.filter(f => f.role === 'contexts')) for (const x of ndjson(c)) contexts.set(x.meta?.context_sha256 ?? x.key, x.prompt);
  const seen = new Set<string>();
  for (const cell of cells.values()) {
    const rowsFile = cell.rows!, answersFile = cell.answers!;
    const rows = new Map(ndjson(rowsFile).map(r => [r.id as string, r]));
    const judgments = new Map<string, Rec[]>();
    for (const j of ndjson(cell.judgments!)) judgments.set(`${j.answer_id}|${j.judge}`, [...(judgments.get(`${j.answer_id}|${j.judge}`) ?? []), j]);
    for (const a of ndjson(answersFile)) {
      counts.read++;
      const key = `${a.cell_id}|${a.question_id}|${a.reader}|r${a.replicate}`;
      if (seen.has(key)) { counts.duplicate++; continue; }
      seen.add(key);
      if (entry.models && !entry.models.includes(a.reader)) { skip(counts, 'model not counted from this source'); continue; }
      const ids: Pick<EvalFailure, 'schema' | 'source' | 'run_id' | 'case_id' | 'task_id' | 'system' | 'arm' | 'arm_role' | 'condition' | 'visibility' | 'model' | 'gbrain_sha'> = {
        schema: EVAL_FAILURE_SCHEMA, source: entry.id, run_id: String(a.realization_id ?? a.cell_id), case_id: key, task_id: String(a.question_id),
        system: String(a.system ?? a.cell_id), arm: String(a.cell_id), arm_role: rs1ArmRole(String(a.cell_id), entry),
        condition: entry.condition, visibility: entry.visibility, model: a.reader, gbrain_sha: entry.gbrain_sha ?? null };
      const answerRef = pointer(answersFile, `answer=${String(a.answer_id).slice(0, 12)}`);
      const skipped = SKIPPED.get(a.outcome);
      if (skipped) {
        skip(counts, skipped);
        notRun.push({ ...ids, failed: false, not_run: String(a.outcome), score: null, category: rows.get(a.question_id)?.category ?? null, agent_loop: false, stop: null, finish_reason: null,
          harness: null, operation: null, tool_calls: null, gold: { gold_count: null, stored: null, hidden: null, retrieved: null, delivered: null, opened: null, summary_only: null },
          writes: null, tags: [], evidence: [answerRef] });
        continue;
      }
      const row = rows.get(a.question_id);
      if (!row) { skip(counts, 'no row for the question'); continue; }
      const judged = JUDGED.has(a.outcome);
      const retrieval: string | null = typeof row.outcome === 'string' ? row.outcome : null;
      const retrieveFailed = a.outcome === 'retrieval_error' && retrieval === 'retrieval_error';
      const timedOut = a.outcome === 'retrieval_error' && (retrieveFailed ? row.error_kind === 'timeout' : a.stop_reason === 'wall_time');
      const provider = String(a.reader).split(':')[0];
      const judge = RS1_GATING_JUDGE[provider];
      const js = judged && judge ? judgments.get(`${a.answer_id}|${judge}`) ?? [] : [];
      if (judged && !js.length) { skip(counts, 'no gating judgment'); continue; }
      counts.mapped++;
      const scores = js.map(j => j.score).filter((s): s is number => typeof s === 'number');
      const stop = judged ? null : BUDGET_STOPS.has(a.outcome) ? String(a.outcome) : timedOut ? 'timeout' : null;
      const harnessError = !judged ? (stop || PRODUCT_MISSES.has(a.outcome) ? null : `answer outcome ${a.outcome}`) : retrieval !== null && !JUDGED.has(retrieval) ? `row outcome ${retrieval}`
        : js.some(j => j.parse_ok === false || !JUDGED.has(j.outcome)) ? 'judgment did not parse' : scores.length ? null : 'no numeric judge score';
      const score = scores.length ? scores.reduce((x, y) => x + y, 0) / scores.length : null;
      if (judged && !harnessError && score !== null && score >= 1) continue;
      counts.failed++;
      const degraded = a.outcome === 'ingest_degraded' || row.outcome === 'ingest_degraded';
      const retrieved = row.gold_count === 0 ? null : coverage(row);
      const packed = row.packing_loss;
      const delivered = retrieved !== null && packed && packed.items_dropped === 0 && packed.items_cut === 0 && packed.items_offered <= 10 ? retrieved : null;
      const tags: Tag[] = ['measured_at_10'];
      if (score === 0) tags.push('score_zero');
      if (!judged) tags.push('no_answer');
      if (retrieveFailed && !timedOut) tags.push('retrieve_error');
      const q = gold.get(a.question_id);
      const text: FailureText | undefined = q && judged && (entry.visibility === 'public' || entry.visibility === 'synthetic')
        ? { question: String(q.question ?? ''), expected: q.answer ?? q.ideal_response ?? q.ideal_answer ?? null, answer: String(a.text ?? ''), context: contexts.get(a.context_sha256) ?? null }
        : undefined;
      failures.push({
        ...ids, failed: true, score, category: row.category ?? null, agent_loop: false, stop, finish_reason: null,
        harness: harnessError ? { error: harnessError, scorer_artifact: null } : null,
        operation: degraded ? { step: 'ingest_degraded', error: 'the cell recorded ingest_degraded for this conversation' } : null, tool_calls: null,
        gold: { gold_count: typeof row.gold_count === 'number' ? row.gold_count : null, stored: null, hidden: null, retrieved, delivered, opened: null, summary_only: null },
        writes: null, tags, evidence: [answerRef, pointer(rowsFile, `question=${a.question_id}`)],
        ...(text ? { text } : {}),
      });
    }
  }
  return { failures, stress: [], counts, not_run: notRun };
}

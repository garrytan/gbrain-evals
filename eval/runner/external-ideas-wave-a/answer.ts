/**
 * One resumable step of an answer cell (arm, sample, model) over the batch
 * lane. Each step, in order:
 *
 *   1. refuse rows on disk that belong to another cell (identity check);
 *   2. poll the lane, which first reconciles any batch that was submitted but
 *      never collected (by its batch id, or adopted from the provider's list),
 *      then stores and settles every ended batch, so nothing is paid twice;
 *   3. write one row per collected result: reader failures (errored, expired,
 *      canceled, missing, output-limit stop, empty answer) become error rows,
 *      succeeded answers are judged; a settled answer whose judges failed is
 *      judged again from its stored text, never re-asked;
 *   4. while this cell has an open batch, stop; otherwise submit the questions
 *      that never had an attempt (a pilot first while the provider's batch
 *      discount is unconfirmed), or, with retry, failed ones once more.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ArmManifest } from '../batch/manifest.ts';
import { readerRows } from '../batch/receipts.ts';
import type { BatchLane, IntentState } from '../batch/submit.ts';
import { checkRowIdentity, latestRows, needsJudging, readRows, type AnswerRow, type Cell, type JudgeVerdicts } from './lib.ts';

export const PREREGISTERED_FACTOR = 0.5;
const OPEN: IntentState[] = ['prepared', 'sending', 'submitted', 'ended', 'unknown'];

export interface QuestionMeta { question_type: string; reader_request_sha256: string; evidence_sha256: string; product_fingerprint: string | null }

export interface AnswerStepCtx {
  lane: BatchLane;
  manifest: ArmManifest;
  bodies: Map<string, Record<string, unknown>>;
  meta: Map<string, QuestionMeta>;
  /** Every frozen question's request body sha for this cell: rows for any other body are refused. */
  expected: Map<string, string>;
  cell: Cell;
  set: 'all' | 'affected';
  rowsFile: string;
  identity: Record<string, unknown>;
  judge: (questionId: string, hypothesis: string) => Promise<JudgeVerdicts>;
  retry?: boolean;
  judgeOnly?: boolean;
  listPrice?: boolean;
  pilotSize?: number;
  concurrency?: number;
  onPlan?: (plan: { ids: number; pilot: boolean; reserve_usd: number; input_tokens: number }) => void;
  log?: (line: string) => void;
}

export interface StepResult { written: number; rejudged: number; open: number; submitted: { intent_id: string; batch_id: string | null; requests: number; pilot: boolean; reserved_usd: number } | null; failed: string[]; never_run: string[]; done: boolean }

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

export async function answerStep(ctx: AnswerStepCtx): Promise<StepResult> {
  const log = ctx.log ?? (() => {});
  const armId = ctx.manifest.arm_id;
  const existing = readRows(ctx.rowsFile);
  checkRowIdentity(existing, ctx.cell, ctx.expected);
  await ctx.lane.poll();
  const results = ctx.lane.results(armId);
  const types = new Map([...ctx.meta].map(([id, m]) => [id, m.question_type]));
  const latest = latestRows(existing);
  const jobs: Array<() => Promise<AnswerRow>> = [];
  let rejudged = 0;
  for (const rr of readerRows(ctx.manifest, results, types)) {
    if (rr.error === 'reader_not_run') continue;
    const prior = latest.get(rr.question_id);
    if (prior && prior.batch.intent_id === rr.intent_id) {
      if (!needsJudging(prior)) continue;
      rejudged++;
      jobs.push(async () => ({ ...prior, ...(await ctx.judge(prior.question_id, prior.hypothesis)), ts: new Date().toISOString() }));
      continue;
    }
    const m = ctx.meta.get(rr.question_id)!;
    const stored = results.get(rr.question_id)!;
    const base: AnswerRow = {
      schema: 'gbrain-evals/external-ideas-wave-a-row/v1', question_id: rr.question_id, question_type: m.question_type,
      arm: ctx.cell.arm, sample: ctx.cell.sample, model: ctx.cell.model, set: ctx.set,
      request_sha256: ctx.expected.get(rr.question_id)!, reader_request_sha256: m.reader_request_sha256, evidence_sha256: m.evidence_sha256, product_fingerprint: m.product_fingerprint,
      batch: { arm_id: armId, intent_id: rr.intent_id, status: stored.status, finish: rr.finish, response_model: rr.response_model, service_tier: stored.service_tier },
      usage: rr.usage, usd: rr.usd, list_usd: rr.list_usd, hypothesis: rr.hypothesis, reader_error: rr.error,
      official_correct: null, official: { skipped: rr.error ? 'reader_error' : 'not_run' }, framed_correct: null, framed: { skipped: rr.error ? 'reader_error' : 'not_run' },
      primary_judge: 'official_correct', identity: ctx.identity, ts: '',
    };
    jobs.push(async () => ({ ...base, ...(rr.error ? {} : await ctx.judge(rr.question_id, rr.hypothesis)), ts: new Date().toISOString() }));
  }
  mkdirSync(dirname(ctx.rowsFile), { recursive: true });
  let written = 0;
  await pool(jobs, ctx.concurrency ?? 8, async job => {
    const row = await job();
    appendFileSync(ctx.rowsFile, JSON.stringify(row) + '\n');
    written++;
    log(`[answer] ${armId} ${row.question_id} ${row.reader_error ? `ERROR ${row.reader_error}` : `official=${row.official_correct} framed=${row.framed_correct}`}`);
  });
  const result: StepResult = { written, rejudged, open: 0, submitted: null, failed: [], never_run: [], done: false };
  result.open = ctx.lane.intents({ arm_id: armId, states: OPEN }).length;
  if (result.open) return result;
  const attempts = (q: string) => ctx.lane.intents({ arm_id: armId }).filter(i => i.state !== 'abandoned' && i.items.some(x => x.question_id === q)).length;
  const pending = ctx.lane.failedQuestionIds(ctx.manifest);
  result.never_run = pending.filter(q => attempts(q) === 0);
  result.failed = pending.filter(q => attempts(q) > 0);
  if (ctx.judgeOnly) { result.done = true; return result; }
  let ids: string[] = [];
  let pilot = false;
  if (result.never_run.length) {
    pilot = !ctx.lane.factorFor(ctx.manifest.provider, ctx.manifest.model).confirmed && !ctx.listPrice;
    ids = pilot ? result.never_run.slice(0, ctx.pilotSize ?? 10) : result.never_run;
  } else if (ctx.retry) ids = result.failed.filter(q => attempts(q) < 2);
  if (!ids.length) { result.done = true; return result; }
  const plan = await ctx.lane.plan(ctx.manifest, ctx.bodies, { questionIds: ids, pilot });
  ctx.onPlan?.({ ids: ids.length, pilot, reserve_usd: plan.reserve_usd, input_tokens: plan.input_tokens });
  const intent = await ctx.lane.submit(ctx.manifest, ctx.bodies, { questionIds: ids, pilot, ...(pilot || ctx.listPrice ? {} : { requireFactor: PREREGISTERED_FACTOR }) });
  result.submitted = { intent_id: intent.intent_id, batch_id: intent.batch_id, requests: intent.items.length, pilot, reserved_usd: intent.reserved_usd };
  result.open = 1;
  return result;
}

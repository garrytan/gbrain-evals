#!/usr/bin/env bun
/**
 * Plain hybrid search over LongMemEval-S cleaned, retrieval only: the no-gbrain baseline for README's LongMemEval
 * retrieval rows (docs/plans/2026-11-17-readme-baselines/PREREG.md).
 *
 *   bun eval/runner/lme-plain-hybrid.ts --out <dir> --budget-usd <n> [--budget-ledger <path>] [--budget-run-id <id>]
 *     [--concurrency 6] [--limit N] [--embed-cache <path>]
 *
 * The system is `PlainHybridSystem` (eval/runner/systems/baselines.ts, the scoreboard's `baseline-hybrid`): one row per
 * session, Postgres full-text plus pgvector over `text-embedding-3-large` at 1,536 dimensions, reciprocal-rank fusion.
 * No gbrain code runs. Each question gets its own namespace, filled through the scoreboard's sanitizer (opaque source
 * ids, sessions in event-time order), and two retrievals at k = 50:
 *
 *   question  the LongMemEval question;
 *   probe     the verbatim probe of docs/benchmarks/2026-10-09-verbatim-probe-preregistration.md: the first 300
 *             characters of the longest turn of the last session ingested (the readiness probe before amendment A23).
 *
 * A row per question appends to `<out>/rows.ndjson` with both ranked lists as dataset session ids; a rerun skips
 * questions that already have a row without an error, so a question's last row is its result. A failed probe
 * retrieval is kept on the probe as a miss and does not fail the question's row. Embeddings are cached on disk (`--embed-cache`), and every
 * request goes through the budget ledger's fetch guard.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { budgetOptionsFrom, startPaidRun } from './budget-ledger.ts';
import { cachedOpenAIEmbedder, type Embedder } from './cat40/pg-arm.ts';
import { loadLmeS, LME_S_FILE, type Conversation, type MemoryQuestion } from './memory-qa/corpus.ts';
import { recallAllAtK, recallAnyAtK } from './metrics.ts';
import { PlainHybridSystem } from './systems/baselines.ts';
import { Sanitizer } from './systems/sanitize.ts';
import type { SessionInput } from './systems/types.ts';

export const RETRIEVE_K = 50;
export const SANITIZER_SALT = 'readme-baselines-lme';

/** The verbatim probe's passage (the readiness probe before A23): the first 300 characters of the session's longest turn, null when blank. */
export function verbatimProbe(session: SessionInput): string | null {
  const passage = [...session.turns].sort((x, y) => y.content.length - x.content.length)[0]?.content.slice(0, 300);
  return passage?.trim() ? passage : null;
}

export interface Ranked { id: string; index: number }

export interface HybridRow {
  question_id: string;
  question_type: string;
  abstention: boolean;
  gold: string[];
  sessions: number;
  /** Dataset session ids in rank order, each with the haystack index of its stored copy (a repeated id keeps its last copy in ingest order). */
  question_top: Ranked[];
  /** A probe whose retrieval failed (the error, kept apart from the question's) counts as a miss: rank null. */
  probe: { target: string; target_index: number; passage_chars: number; top: Ranked[]; rank: number | null; error?: string } | null;
  recall_all_at5: number | null;
  recall_all_at10: number | null;
  recall_any_at5: number | null;
  recall_any_at10: number | null;
  error?: string;
}

/** Ingest one question's history into a fresh namespace, run the question and the probe at k = 50, and empty the namespace again. */
export async function runQuestion(system: PlainHybridSystem, sanitizer: Sanitizer, conv: Conversation, q: MemoryQuestion): Promise<HybridRow> {
  const ns = sanitizer.ns(conv.id);
  const plan = sanitizer.ingestPlan(conv);
  const indexOf = new Map<string, number>();
  for (const step of plan) indexOf.set(step.session.id, conv.sessions.indexOf(step.session));
  const gold = new Set(q.gold);
  await system.reset(ns);
  try {
    for (const step of plan) await system.ingestSession(ns, step.input, step.event_time);
    const finish = await system.finishIngest(ns);
    if (!finish.ready) throw new Error(`namespace not ready: ${JSON.stringify(finish.raw ?? {})}`);
    const policy = { name: `readme-baselines-k${RETRIEVE_K}`, mode: 'fixed-evidence' as const, settings: { k: RETRIEVE_K } };
    const ranked = async (text: string): Promise<Ranked[]> => (await system.retrieve(ns, sanitizer.question({ ...q, question: text }), policy)).items.map(i => {
      const id = sanitizer.sessionOf(ns, i.source_ids[0]);
      if (!id) throw new Error(`retrieved source ${i.source_ids[0]} is not a session of ${q.id}`);
      return { id, index: indexOf.get(id)! };
    });
    const top = await ranked(q.question);
    const last = plan.at(-1)!;
    const passage = verbatimProbe(last.input);
    let probe: HybridRow['probe'] = null;
    if (passage) {
      const target = { target: last.session.id, target_index: indexOf.get(last.session.id)!, passage_chars: passage.length };
      try {
        const ptop = await ranked(passage);
        const r = ptop.findIndex(x => x.id === last.session.id);
        probe = { ...target, top: ptop, rank: r < 0 ? null : r + 1 };
      } catch (e) {
        if (!/tsquery/i.test(String((e as Error).message))) throw e;
        probe = { ...target, top: [], rank: null, error: String((e as Error).message).slice(0, 500) };
      }
    }
    const ids = top.map(x => x.id);
    const at = (f: typeof recallAllAtK, k: number) => (gold.size ? f(ids, gold, k) : null);
    return {
      question_id: q.id, question_type: q.category, abstention: q.abstention, gold: q.gold, sessions: plan.length, question_top: top, probe,
      recall_all_at5: at(recallAllAtK, 5), recall_all_at10: at(recallAllAtK, 10), recall_any_at5: at(recallAnyAtK, 5), recall_any_at10: at(recallAnyAtK, 10),
    };
  } finally {
    await system.reset(ns);
  }
}

/** Runs `work` over `items` in order on `concurrency` workers, each with its own `open()` resource; once any item throws, no worker starts another, and the call rejects with the first error only after every worker has closed. */
export async function eachConcurrently<T, W>(items: T[], concurrency: number, open: () => W, work: (w: W, item: T) => Promise<void>, close: (w: W) => Promise<void>): Promise<void> {
  let next = 0, stopped = false;
  const settled = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    const w = open();
    try {
      while (!stopped && next < items.length) await work(w, items[next++]).catch(e => { stopped = true; throw e; });
    } finally { await close(w); }
  }));
  const failure = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (failure) throw failure.reason;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: string[]) {
  const out = resolve(flag(argv, '--out') ?? 'eval/reports/readme-baselines/lme-plain-hybrid');
  const concurrency = Number(flag(argv, '--concurrency') ?? 6);
  const limit = flag(argv, '--limit') ? Number(flag(argv, '--limit')) : undefined;
  const cachePath = resolve(flag(argv, '--embed-cache') ?? join(out, 'embed-cache.json'));
  mkdirSync(out, { recursive: true });
  const rowsPath = join(out, 'rows.ndjson');
  const done = new Set((existsSync(rowsPath) ? readFileSync(rowsPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as HybridRow) : []).filter(r => !r.error).map(r => r.question_id));
  const corpus = loadLmeS();
  const sanitizer = new Sanitizer(corpus, SANITIZER_SALT);
  const convs = new Map(corpus.conversations.map(c => [c.id, c]));
  const todo = corpus.questions.filter(q => !done.has(q.id)).slice(0, limit);
  const { run, guard } = startPaidRun('lme-plain-hybrid', { ...budgetOptionsFrom(argv), estimateUsd: 0.016 * todo.length });
  const embed: Embedder = cachedOpenAIEmbedder(cachePath);
  const started = new Date().toISOString();
  let written = 0, failed = 0;
  try {
    await eachConcurrently(todo, concurrency, () => new PlainHybridSystem(embed), async (system, q) => {
      let row: HybridRow;
      try { row = await runQuestion(system, sanitizer, convs.get(q.conversation)!, q); }
      catch (e) {
        if (/budget/i.test((e as Error).name) || /budget/i.test((e as Error).message)) throw e;
        failed++;
        row = { question_id: q.id, question_type: q.category, abstention: q.abstention, gold: q.gold, sessions: 0, question_top: [], probe: null,
          recall_all_at5: null, recall_all_at10: null, recall_any_at5: null, recall_any_at10: null, error: String((e as Error).message).slice(0, 500) };
      }
      appendFileSync(rowsPath, JSON.stringify(row) + '\n');
      if (++written % 25 === 0) process.stderr.write(`[lme-plain-hybrid] ${written}/${todo.length} rows (${failed} errors), ledger $${run.summary().actual_usd.toFixed(2)}\n`);
    }, system => system.close());
  } finally {
    guard.uninstall();
    const summary = run.close();
    const receiptPath = join(out, `receipt-${started.replace(/[:.]/g, '-')}.json`);
    writeFileSync(receiptPath, JSON.stringify({
      schema: 'gbrain-evals/readme-baselines-lme-plain-hybrid/v1', started, finished: new Date().toISOString(),
      git_sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), bun: Bun.version,
      dataset: { file: LME_S_FILE.path, url: LME_S_FILE.url, sha256: LME_S_FILE.sha256 }, sanitizer_salt: SANITIZER_SALT, retrieve_k: RETRIEVE_K,
      probe: 'first 300 characters of the longest turn of the last session in ingest order (the readiness probe before A23)',
      capabilities: await new PlainHybridSystem(embed).capabilities(), concurrency, questions_attempted: todo.length, rows_written: written, error_rows: failed, ledger: summary,
    }, null, 1) + '\n');
    process.stderr.write(`[lme-plain-hybrid] receipt ${receiptPath}\n`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(() => process.exit(0)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}

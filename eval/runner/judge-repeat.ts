/**
 * Judge-only repeats over fixed answers (Q1 PLAN §4.4): re-judge every answer
 * in an answers.ndjson file N times with the benchmark's registered
 * instrument, at the instrument's temperature (0), and summarize judge
 * nondeterminism. It never calls a reader: answers are read from the file,
 * byte for byte, and only judge prompts are sent.
 *
 *   bun eval/runner/judge-repeat.ts run --answers <answers.ndjson> --judgments <judgments.ndjson> \
 *     --benchmark <id> --replicates 11 [--first-replicate 0] [--judge <provider:model>] \
 *     [--corpus-file <custody file>] [--concurrency 8] [--max-attempts 3] [--summary <summary.json>] \
 *     --paid --budget-run-id <id> [--json]
 *   bun eval/runner/judge-repeat.ts summary --answers <answers.ndjson> --judgments <judgments.ndjson> \
 *     --benchmark <id> [--judge <provider:model>] [--summary <summary.json>] [--json]      ($0, no calls)
 *
 * Replicates: judge replicate 0 is the canonical judgment, so `--replicates
 * 11` is the canonical run plus ten repeats. The replicate index enters the
 * judge cache key, so ten repeats are ten provider calls. A judge that accepts
 * only its default temperature (OpenAI GPT-5 and later) is sent none and its
 * records say `temperature: null`.
 *
 * Restart: judgments are an immutable log keyed by answer, instrument hash,
 * judge and replicate. A rerun skips every judgment already recorded and
 * judges only the rest, so an interrupted run resumes where it stopped. A
 * malformed judgment is retried as a fresh call and, after the last attempt,
 * recorded as `judge_error` (never "no"); a provider error records nothing,
 * so the next run retries it, and the run exits 4 (partial).
 *
 * The summary gives each answer's mean and sample SD across replicates, the
 * answers whose verdict flips, and the mean score of every system, arm and
 * reader group under each replicate: the inputs for judge SD and the share of
 * judge runs under which each comparison holds.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { budgetOptionsFrom, startPaidRun } from './budget-ledger.ts';
import { decideError, exitCodeFor, renderOperatorMessage, DecideError, type OperatorMessage } from './decisions/errors.ts';
import { loadSplit } from './decisions/splits.ts';
import { loadCorpus, type MemoryQuestion } from './memory-qa/corpus.ts';
import { instrumentFor, INSTRUMENTS, type Instrument } from './memory-qa/instruments.ts';
import { ChatClient, judgeAnswer, type ChatLike } from './memory-qa/qa.ts';
import { judgmentKey, readRecords, RecordLog, type AnswerRecord, type JudgmentRecord } from './memory-qa/records.ts';
import { requirePaidArm } from './paid-arm.ts';
import { appendAccessLog } from './sealed-confirmation-lib.ts';

export interface JudgeRepeatResult { judged: number; skipped_existing: number; judge_errors: number; not_judged: number; failed: Array<{ answer_id: string; judge_replicate: number; error: string }>; stopped: string | null }

/** Judge every scored answer at every replicate not already in the log. */
export async function runJudgeRepeat(o: {
  answers: readonly AnswerRecord[]; questions: ReadonlyMap<string, MemoryQuestion>; instrument: Instrument; judge: string;
  replicates: readonly number[]; log: RecordLog<'judgment'>; client: ChatLike; concurrency?: number; maxAttempts?: number;
  stopWhen?: () => string | null;
}): Promise<JudgeRepeatResult> {
  const scored = o.answers.filter(a => a.outcome === 'scored');
  const missing = [...new Set(scored.map(a => a.question_id).filter(id => !o.questions.has(id)))];
  if (missing.length) throw new Error(`${missing.length} answered question id(s) are not in the corpus; judge with the corpus the answers came from`);
  const result: JudgeRepeatResult = { judged: 0, skipped_existing: 0, judge_errors: 0, not_judged: o.answers.length - scored.length, failed: [], stopped: null };
  const tasks: Array<{ answer: AnswerRecord; judge_replicate: number }> = [];
  for (const judge_replicate of o.replicates) for (const answer of scored) {
    if (o.log.has(judgmentKey({ answer_id: answer.answer_id, instrument_sha256: o.instrument.sha256, judge: o.judge, judge_replicate }))) result.skipped_existing++;
    else tasks.push({ answer, judge_replicate });
  }
  let next = 0;
  const worker = async () => {
    while (next < tasks.length && !result.stopped) {
      const stop = o.stopWhen?.() ?? null;
      if (stop) { result.stopped = stop; break; }
      const { answer, judge_replicate } = tasks[next++];
      try {
        const j = await judgeAnswer(o.client, o.instrument, o.questions.get(answer.question_id)!, answer.text, { judge: o.judge, judgeReplicate: judge_replicate, maxAttempts: o.maxAttempts });
        o.log.append({ answer_id: answer.answer_id, ...j });
        result.judged++;
        if (j.outcome === 'judge_error') result.judge_errors++;
      } catch (e) {
        const message = (e as Error).message;
        result.failed.push({ answer_id: answer.answer_id, judge_replicate, error: message.slice(0, 300) });
        if (/budget|BudgetExceeded/i.test(message)) result.stopped = `budget: ${message.slice(0, 200)}`;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 8) }, worker));
  return result;
}

const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sampleSd = (xs: readonly number[]) => xs.length < 2 ? null : Math.sqrt(xs.reduce((a, x) => a + (x - mean(xs)) ** 2, 0) / (xs.length - 1));

export interface RepeatSummary {
  kind: 'q1-judge-repeat-summary'; schema_version: 1;
  instrument_id: string; instrument_sha256: string; judge: string; temperature: number | null;
  replicates: number[]; answers: number; judgments_scored: number; judgments_failed: number;
  judge_sd_mean: number | null; judge_sd_max: number | null; answers_with_flip: number;
  per_answer: Array<{ answer_id: string; question_id: string; group: string; scores: Array<number | null>; mean: number | null; sd: number | null; flip: boolean }>;
  /** Mean score of every `system|arm|reader` group under each replicate, over answers scored in that replicate. */
  per_replicate: Array<{ judge_replicate: number; groups: Record<string, { mean: number; n: number }> }>;
}

/** Judge SD and verdict-stability inputs from the recorded judgments ($0). A verdict flips when an answer's scores fall on both sides of 0.5. */
export function summarizeRepeats(answers: readonly AnswerRecord[], judgments: readonly JudgmentRecord[], instrument: Instrument, judge: string): RepeatSummary {
  const mine = judgments.filter(j => j.instrument_sha256 === instrument.sha256 && j.judge === judge);
  const replicates = [...new Set(mine.map(j => j.judge_replicate))].sort((a, b) => a - b);
  const byAnswer = new Map<string, Map<number, JudgmentRecord>>();
  for (const j of mine) byAnswer.set(j.answer_id, (byAnswer.get(j.answer_id) ?? new Map()).set(j.judge_replicate, j));
  const group = (a: AnswerRecord) => `${a.system}|${a.arm}|${a.reader}`;
  const per_answer = answers.filter(a => byAnswer.has(a.answer_id)).map(a => {
    const scores = replicates.map(r => byAnswer.get(a.answer_id)!.get(r)?.score ?? null);
    const ok = scores.filter((s): s is number => s !== null);
    return { answer_id: a.answer_id, question_id: a.question_id, group: group(a), scores, mean: ok.length ? mean(ok) : null, sd: sampleSd(ok), flip: ok.some(s => s >= 0.5) && ok.some(s => s < 0.5) };
  });
  const sds = per_answer.map(p => p.sd).filter((s): s is number => s !== null);
  const per_replicate = replicates.map((r, k) => {
    const groups: Record<string, { mean: number; n: number }> = {};
    const acc = new Map<string, number[]>();
    for (const p of per_answer) if (p.scores[k] !== null) acc.set(p.group, [...(acc.get(p.group) ?? []), p.scores[k]!]);
    for (const [g, xs] of [...acc].sort(([x], [y]) => x < y ? -1 : 1)) groups[g] = { mean: mean(xs), n: xs.length };
    return { judge_replicate: r, groups };
  });
  return {
    kind: 'q1-judge-repeat-summary', schema_version: 1, instrument_id: instrument.id, instrument_sha256: instrument.sha256, judge,
    temperature: mine[0]?.temperature ?? null, replicates, answers: per_answer.length,
    judgments_scored: mine.filter(j => j.outcome === 'scored').length, judgments_failed: mine.filter(j => j.outcome !== 'scored').length,
    judge_sd_mean: sds.length ? mean(sds) : null, judge_sd_max: sds.length ? Math.max(...sds) : null, answers_with_flip: per_answer.filter(p => p.flip).length,
    per_answer, per_replicate,
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────

const CALL_USD: Record<string, number> = { 'lme-s': 0.002, 'lme-m': 0.002, locomo: 0.002 };

function usage(message: string): DecideError {
  return decideError({ code: 'SPEC_INVALID', message, why: 'judge-repeat needs the answers file, the judgments log, the benchmark and the replicate count',
    fix: { next: 'run', argv: ['bun', 'eval/runner/judge-repeat.ts', 'run', '--answers', '<answers.ndjson>', '--judgments', '<judgments.ndjson>', '--benchmark', '<id>', '--replicates', '11', '--paid', '--budget-run-id', '<id>'],
      verify: ['bun', 'eval/runner/judge-repeat.ts', 'summary', '--answers', '<answers.ndjson>', '--judgments', '<judgments.ndjson>', '--benchmark', '<id>'] } });
}

export async function main(argv: string[]): Promise<number> {
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const json = argv.includes('--json');
  const emit = (op: OperatorMessage, code: number) => { (code ? process.stderr : process.stdout).write((json ? JSON.stringify(op) : renderOperatorMessage(op)) + '\n'); return code; };
  try {
    const cmd = argv[0];
    if (cmd !== 'run' && cmd !== 'summary') throw usage(`unknown command ${JSON.stringify(cmd ?? '')}; use run or summary`);
    const answersPath = one('--answers'), judgmentsPath = one('--judgments'), benchmark = one('--benchmark');
    if (!answersPath || !judgmentsPath || !benchmark) throw usage('--answers, --judgments and --benchmark are required');
    if (!INSTRUMENTS[benchmark]) throw usage(`no judge instrument is registered for ${benchmark}; registered: ${Object.keys(INSTRUMENTS).join(', ')}`);
    if (!existsSync(answersPath)) throw decideError({ code: 'ROWS_MISSING', message: `${answersPath} does not exist`, why: 'judge-repeat judges fixed answers only; it never produces answers',
      fix: { next: 'report', user_message: 'run the reader cell that writes answers.ndjson first' } });
    const instrument = instrumentFor(benchmark);
    const judge = one('--judge') ?? instrument.canonical_judge;
    const answers = readRecords(answersPath, 'answer');
    const summaryPath = one('--summary');
    const writeSummary = () => {
      const s = summarizeRepeats(answers, readRecords(judgmentsPath, 'judgment'), instrument, judge);
      if (summaryPath) { mkdirSync(dirname(resolve(summaryPath)), { recursive: true }); writeFileSync(summaryPath, JSON.stringify(s, null, 2) + '\n'); }
      return s;
    };
    if (cmd === 'summary') {
      const s = writeSummary();
      process.stdout.write(JSON.stringify(json ? s : { ...s, per_answer: `${s.per_answer.length} answers` }, null, 2) + '\n');
      return 0;
    }
    const replicates = Number(one('--replicates')), first = Number(one('--first-replicate') ?? 0);
    if (!Number.isInteger(replicates) || replicates < 1 || !Number.isInteger(first) || first < 0) throw usage('--replicates must be a positive integer and --first-replicate a non-negative integer');
    const scoredConvs = new Set(answers.filter(a => a.outcome === 'scored').map(a => a.conversation));
    let sealed: string[] = [];
    try { sealed = loadSplit(benchmark).sealed.filter(c => scoredConvs.has(c)); } catch { sealed = []; }
    if (sealed.length) {
      const log = process.env.GBRAIN_EVALS_CUSTODY_LOG, decision = one('--decision-id'), purpose = one('--purpose');
      if (!log || !decision || !purpose) throw decideError({ code: 'CUSTODY_MISSING', message: `${sealed.length} answered conversation(s) are sealed in ${benchmark}`,
        why: 'judging sealed answers reads sealed references and rubrics, which only the custodian opens, with every opening logged',
        fix: { next: 'tell_user_to_run', argv: ['bun', 'eval/runner/judge-repeat.ts', ...argv, '--decision-id', '<id>', '--purpose', '<text>'], user_message: 'the custodian runs sealed judge repeats with GBRAIN_EVALS_CUSTODY_LOG set' } });
      appendAccessLog(log, { action: 'score', purpose: `judge-repeat ${benchmark}: ${purpose}`, decision_id: decision, labels_sha256: 'public-split-file', run_sha256: null });
    }
    const corpus = loadCorpus(benchmark, one('--corpus-file'));
    const questions = new Map(corpus.questions.map(q => [q.id, q]));
    const reps = Array.from({ length: replicates }, (_, i) => first + i);
    const perAnswerCalls = (q: MemoryQuestion | undefined) => !q ? 1 : benchmark.startsWith('beam-') ? (q.rubric?.length || 1) * (q.category === 'event_ordering' ? 4 : 1) : 1;
    const estimate = Math.round(answers.filter(a => a.outcome === 'scored').reduce((s, a) => s + perAnswerCalls(questions.get(a.question_id)), 0) * reps.length * (CALL_USD[benchmark] ?? 0.001) * 100) / 100;
    try { requirePaidArm(argv, { arm: `judge-repeat ${benchmark}`, estimateUsd: estimate, ledgerPath: budgetOptionsFrom(argv).ledgerPath }); }
    catch (e) {
      throw decideError({ code: 'PAID_FLAGS_MISSING', message: (e as Error).message, why: 'every judge call is a paid provider request reserved in the budget ledger first',
        fix: { next: 'run', argv: ['bun', 'eval/runner/budget-ledger.ts', 'status'], verify: ['bun', 'eval/runner/budget-ledger.ts', 'status'] } });
    }
    const paid = startPaidRun(`judge-repeat:${benchmark}`, { ...budgetOptionsFrom(argv), estimateUsd: estimate });
    const log = new RecordLog(judgmentsPath, 'judgment');
    const client = new ChatClient(process.env.GBRAIN_EVALS_QA_CACHE ?? join(homedir(), '.cache', 'gbrain-evals', 'qa-cache'));
    let r: JudgeRepeatResult;
    try {
      r = await runJudgeRepeat({ answers, questions, instrument, judge, replicates: reps, log, client, concurrency: Number(one('--concurrency') ?? 8), maxAttempts: Number(one('--max-attempts') ?? 3), stopWhen: () => paid.guard.exhausted ? 'budget exhausted' : null });
    } finally { paid.run.close(); paid.guard.uninstall(); }
    const s = writeSummary();
    process.stdout.write(JSON.stringify({ ...r, failed: r.failed.length, judge_sd_mean: s.judge_sd_mean, answers_with_flip: s.answers_with_flip, summary: summaryPath ?? null }) + '\n');
    if (r.failed.length || r.stopped) {
      return emit({ code: r.stopped?.startsWith('budget') ? 'BUDGET_CAP' : 'ARM_FAILED', message: `${r.failed.length} judgment(s) were not recorded${r.stopped ? ` (stopped: ${r.stopped})` : ''}; ${r.judged} recorded, ${r.skipped_existing} already present`,
        why: 'provider errors record nothing, so these judgments are still missing; recorded judgments are never redone',
        fix: { next: 'run', argv: ['bun', 'eval/runner/judge-repeat.ts', ...argv], verify: ['bun', 'eval/runner/judge-repeat.ts', 'summary', '--answers', answersPath, '--judgments', judgmentsPath, '--benchmark', benchmark] },
        state: { failed: r.failed.length, judged: r.judged, judge_errors: r.judge_errors } }, 4);
    }
    return 0;
  } catch (e) {
    if (e instanceof DecideError) return emit(e.op, exitCodeFor(e.op));
    throw e;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

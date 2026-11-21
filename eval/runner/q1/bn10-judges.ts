/**
 * Judging tools of the BEAM-10M re-measure (docs/benchmarks/2026-11-19-beam10m-newest-preregistration.md, GST-3139):
 * the judge agreement check (R78; "Judge agreement check (R78), before any number counts" and amendment A2 check 2)
 * on public BEAM-1M dev questions, the judges' pairwise agreement on the dry run's real answers, and the custody
 * re-judge of four stored S1 answer sets ("Stored answers judged again, in custody").
 *
 *   bun eval/runner/q1/bn10-judges.ts check-plan   --out <dir>
 *   bun eval/runner/q1/bn10-judges.ts check-run    --out <dir> <lease>
 *   bun eval/runner/q1/bn10-judges.ts check-report --out <dir>
 *   bun eval/runner/q1/bn10-judges.ts agreement    --dry-run <dry-run out>... --out <dir>
 *   bun eval/runner/q1/bn10-judges.ts rejudge-plan    <roots> --out <custody dir>
 *   bun eval/runner/q1/bn10-judges.ts rejudge-run     <roots> --out <custody dir> <lease>
 *   bun eval/runner/q1/bn10-judges.ts rejudge-summary <roots> --out <custody dir> [--aggregates <file>]
 *     <roots>: --root f6=<receipt> --root q1=<receipt>, the receipts rejudge-systems.ts reads
 *     <lease>: --budget-ledger <file> --run-id <id> --lease-usd <n> --ledger-cap-usd <n> [--concurrency <n>]
 *              (--keyless-upstream <url> | --paid-window <unit> --window-cap-usd <n>)
 *
 *   Items      GST-1365's control builder (rejudge-systems.ts buildControls) on 50 rubric-scored questions of the public
 *              BEAM-1M dev conversations (eval/decisions/splits/beam-1m.json), event ordering left out: the gold answer
 *              (pass), another question's gold (fail), a fixed abstention (fail, or pass on an abstention question) and
 *              the gold inside a hedge (pass). Fewer than 50 questions, 41 items or 15 items in either class refuses.
 *              The items and their texts stay in --out (items.json).
 *   Grading    every judge whose numbers count grades every item through BEAM's rubric instrument (beam-1m), the
 *              production judge request, pass at a score of 0.5: gpt-6.1-sol and claude-opus-5-5 (frontierJudgeOf of
 *              the BN10 readers and particle-1) at PER_READER_JUDGE_SETTINGS in the gating view, and gpt-4.1-mini at its
 *              canonical settings. Every provider call's finish is tallied in calls.ndjson, so the output-limit rate
 *              covers the canonical judge too.
 *   Gate       per judge: every item graded, Cohen's kappa against the known verdicts at least 0.6 on at least 40 scored
 *              items with at least 15 in each class, and at most 1% of its calls ending at the output limit. A frontier
 *              judge that fails sets verdict STOP (exit 3): no counted cell runs and the numbers go to GBEV-3. A
 *              gpt-4.1-mini failure sets bridge "descriptive-only" (the bridge view is reported as descriptive). A
 *              frontier judge with items left sets verdict INCOMPLETE; it and a keyless rehearsal exit 4.
 *   Reported   report.json: each judge's kappa, error rate per control kind with Wilson 95% intervals, truncation rate
 *              and pass or fail; agreement.json: each pair of the three judges on the dry run's real answers (paid
 *              dry-run outs only), over the answers both graded, descriptive, with frontier judgments not at the pinned
 *              settings counted and left out. Both carry counts, rates and kappas only: no item text, question id or
 *              dollar figure. A report that would hold an item's text or question id is refused before it is written.
 *   Re-judge   the replicate-0 claude-opus-5-5 answers of four stored S1 sets (F6 arm P, F6 arm A, Q1's whole-system
 *              arm and Q1's file agent), each judged again by gpt-6.1-sol at PER_READER_JUDGE_SETTINGS in the gating
 *              view under its cell's canonical instrument; no stored frontier judgment is reused, since GST-1365's were
 *              made at each judge's default effort. Every rejudge subcommand runs in custody: the receipts must
 *              reproduce the published contrasts (rejudge-systems.ts reproduce), and the S1 questions open only through
 *              the custody gate. A product failure scores 0 and sends nothing; any other unjudged outcome, and a
 *              question with no answer, is counted and not judged. rejudge-plan sends nothing and prints each set's
 *              judgments and provider calls (one per rubric item; event-ordering answers also ask BEAM's equivalence
 *              calls, counted apart). Per-question judgments stay in the custody --out, which refuses judgments made at
 *              other settings; rejudge-run and rejudge-summary write aggregates.json there (and to --aggregates): per
 *              set, counts, the mean score and the pass rate with its Wilson interval, with no question id, answer id
 *              or dollar figure.
 *   Window     a paid subcommand without --keyless-upstream needs --paid-window and --window-cap-usd; its
 *              --ledger-cap-usd and --lease-usd never exceed the window cap, and it exits 2 before any output, key
 *              check or lease otherwise. Every stage of an --out spends on one ledger (tieLedger), the stages under one
 *              window share its cap (checkWindowRoom), and the spend lives only in the ledger and receipts/ in --out.
 *              A keyless run, and every subcommand that sends nothing, blanks every provider key first.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cohenKappa, stage1Unpaid, wilson } from '../bg1/judge-check.ts';
import { ledgerPaths, ledgerStatus } from '../budget-ledger.ts';
import { devConversations } from '../decisions/splits.ts';
import { loadCorpus, type MemoryQuestion } from '../memory-qa/corpus.ts';
import { instrumentFor, PASS_THRESHOLD, type Instrument } from '../memory-qa/instruments.ts';
import { PRODUCT_FAILURES, type Outcome } from '../memory-qa/outcomes.ts';
import { ChatClient, TRUNCATED_FINISHES, type ChatLike } from '../memory-qa/qa-v2.ts';
import { readRecords, RecordLog, type JudgmentRecord } from '../memory-qa/records.ts';
import { DEFAULT_ROUTE_CAPS, keylessKeys, keylessUpstream, MeteringProxy, usageSplit } from '../metering-proxy.ts';
import { requireRs1Window, WindowRefusal, type PaidWindow } from '../paid-arm.ts';
import { attestPreregistration } from '../prereg.ts';
import { DEFAULT_ROUTE_CLASSES } from '../shootout-cell.ts';
import { claimOut, keylessUpstreamArg } from './calibration-cell.ts';
import { JUDGED, metering, type MeterLine } from './cell.ts';
import { BN10_PREREGISTRATION, BN10_READERS, buildBN10Manifest, OPUS, PARTICLE } from './cells/bn10.ts';
import { frontierJudgeOf, PER_READER_JUDGE_SETTINGS } from './cells/definitions.ts';
import { openRereadLease } from './reread-cell.ts';
import { buildControls, CANONICAL, cellOf, checkIdentity, checkInstruments, checkPair, checkWindowRoom, exitFor, frontierId, guardIds, judgeTasks, loadSources, preflightKeys, questionsFor, reproduce, stopCode, tieLedger,
  type ControlAnswer, type JudgeRun, type Sources, type StopCode, type Task } from './rejudge-systems.ts';
import { exitCodeOf, refuse, renderMessage, ScoreboardError } from './scoreboard-errors.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const FRONT = ['bun', 'eval/runner/q1/bn10-judges.ts'];
export const CHECK_SCHEMA = 'gbrain-evals/bn10-judge-check/v1';
export const AGREEMENT_SCHEMA = 'gbrain-evals/bn10-judge-agreement/v1';
export const CHECK_BENCHMARK = 'beam-1m';
export const CHECK_SET = 'beam-1m-dev';
export const CHECK_SEED = 'bn10-judge-check';
export const CHECK_QUESTIONS = 50;
export const KAPPA_GATE = 0.6;
export const MIN_ITEMS = 40;
export const MIN_PER_CLASS = 15;
export const TRUNCATION_GATE = 0.01;
export const BRIDGE = CANONICAL;
export const FRONTIER_JUDGES = [...new Set([...BN10_READERS, PARTICLE].map(frontierJudgeOf))].sort();
export const CHECK_JUDGES = [...FRONTIER_JUDGES, BRIDGE];
export const PROVIDER_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'PARTICLE_API_KEY', 'VOYAGE_API_KEY'];
const KINDS = ['C1', 'C2', 'C3', 'C4'] as const;

const scored = (j: JudgmentRecord | undefined): j is JudgmentRecord & { score: number } => !!j && j.parse_ok && j.outcome === 'scored' && typeof j.score === 'number';
/** A judgment made at the pinned per-reader settings (medium effort, 8,000 output tokens). */
export const atPinned = (j: Pick<JudgmentRecord, 'settings'>) => j.settings?.effort === PER_READER_JUDGE_SETTINGS.effort && j.settings?.max_tokens === PER_READER_JUDGE_SETTINGS.max_tokens;
const r4 = (x: number | null) => (x === null ? null : Math.round(x * 1e4) / 1e4);
export const rate = (k: number, n: number) => ({ k, n, rate: n ? r4(k / n) : null, ci95: wilson(k, n)?.map(x => r4(x)!) ?? null });
const ndjson = <T>(path: string): T[] => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as T) : [];

// ─── Items and tasks ─────────────────────────────────────────────────

/** The public BEAM-1M dev questions; the sealed conversations are never read (`only`). */
export const loadCheckQuestions = (): MemoryQuestion[] => loadCorpus(CHECK_BENCHMARK, undefined, devConversations(CHECK_BENCHMARK)!).questions;

/** The known-verdict items: buildControls on the rubric-scored questions, 50 of them, refused below the preregistered counts. */
export function checkItems(questions: readonly MemoryQuestion[]): { items: ControlAnswer[]; questions: number; c2_skipped: number; classes: { pass: number; fail: number } } {
  const built = buildControls({ [CHECK_SET]: questions.filter(q => q.rubric?.length) }, CHECK_QUESTIONS, CHECK_SEED);
  const pass = built.answers.filter(a => a.expected === 'pass').length, fail = built.answers.length - pass;
  const n = new Set(built.answers.map(a => a.question_id)).size;
  if (n < CHECK_QUESTIONS || built.answers.length <= MIN_ITEMS || Math.min(pass, fail) < MIN_PER_CLASS) throw refuse({ code: 'PREFLIGHT_FAILED',
    message: `the controls give ${built.answers.length} items on ${n} rubric-scored questions (${pass} pass, ${fail} fail)`,
    why: `the preregistration needs ${CHECK_QUESTIONS} rubric-scored questions and more than ${MIN_ITEMS} labelled items with at least ${MIN_PER_CLASS} in each class`,
    fix: { next: 'report', user_message: 'report the BEAM-1M dev questions the check could use to GBEV-3' } });
  return { items: built.answers, questions: n, c2_skipped: built.c2_skipped, classes: { pass, fail } };
}

/** Every item for every judge: the frontier judges at the pinned settings in the gating view, gpt-4.1-mini canonical. */
export function checkTasks(items: readonly ControlAnswer[], instrument: Pick<Instrument, 'id' | 'sha256'> = instrumentFor(CHECK_BENCHMARK)): Task[] {
  return items.flatMap(a => CHECK_JUDGES.map((judge): Task => ({ answer_id: a.answer_id, question_id: a.question_id, set: a.set, cell: `controls.${a.control}`, system: 'controls', reader: null,
    text: a.text, judge, instrument: instrument.id, instrument_id: judge === BRIDGE ? instrument.id : frontierId(instrument.id, judge), instrument_sha256: instrument.sha256,
    ...(judge === BRIDGE ? { view: 'descriptive' as const } : { settings: { ...PER_READER_JUDGE_SETTINGS }, view: 'gating' as const }) })));
}

/** Provider calls a set of tasks asks for at the least: one per rubric item (BEAM's rubric instrument), before any retry. */
export const callCount = (tasks: readonly Task[], question: (t: Task) => MemoryQuestion) => tasks.reduce((n, t) => n + (question(t).rubric?.length || 1), 0);

/** The item population of an --out, written once; a rerun must find the same items. */
export function freezeItems(out: string, items: readonly ControlAnswer[]): void {
  const path = join(out, 'items.json'), text = JSON.stringify(items) + '\n';
  if (existsSync(path) && readFileSync(path, 'utf8') !== text) throw refuse({ code: 'RESUME_REFUSED', message: `${path} holds other items`, why: 'a resume grades the frozen items', fix: { next: 'report', user_message: 'resume on the same tree and dataset, or use a fresh --out' } });
  writeFileSync(path, text);
}

// ─── Grading in a window ─────────────────────────────────────────────

/** Tally every provider call's finish (a call the cache answered was tallied when it was made), so truncation covers every judge. */
export function tallyCalls(inner: ChatLike, file: string): ChatLike {
  return { async chat(model, prompt, opts) {
    const r = await inner.chat(model, prompt, opts);
    if (!r.cached) appendFileSync(file, JSON.stringify({ judge: model, finish: r.finish ?? null, truncated: (TRUNCATED_FINISHES as readonly string[]).includes(String(r.finish)) }) + '\n');
    return r;
  } };
}
export const readCalls = (file: string): Record<string, { calls: number; truncated: number }> => {
  const out: Record<string, { calls: number; truncated: number }> = {};
  for (const c of ndjson<{ judge: string; truncated: boolean }>(file)) { const t = out[c.judge] ??= { calls: 0, truncated: 0 }; t.calls++; if (c.truncated) t.truncated++; }
  return out;
};

export interface LeaseArgs { ledger: string; runId: string; leaseUsd: number; capUsd: number; concurrency: number }
export function leaseArgs(one: (n: string) => string | undefined, sub: string): LeaseArgs {
  const [ledger, runId, leaseUsd, capUsd, concurrency] = [one('--budget-ledger'), one('--run-id'), Number(one('--lease-usd')), Number(one('--ledger-cap-usd')), Number(one('--concurrency') ?? 8)];
  if (!ledger || !runId || !(leaseUsd > 0) || !(capUsd > 0) || leaseUsd > capUsd || !Number.isInteger(concurrency) || concurrency < 1) throw refuse({ code: 'USAGE',
    message: `${sub} needs --budget-ledger, --run-id, --lease-usd and --ledger-cap-usd, a lease no larger than the cap, and a positive whole --concurrency`,
    why: 'every judge request is reserved on one ledger first, under a cap no larger than the granted window\'s', fix: { next: 'run', argv: [...FRONT, sub, '--budget-ledger', '<file>', '--run-id', `bn10-${sub}`, '--lease-usd', '<n>', '--ledger-cap-usd', '<n>'] } });
  return { ledger: resolve(ledger), runId, leaseUsd, capUsd, concurrency };
}

const committedUsd = (ledgerPath: string) => existsSync(ledgerPaths(ledgerPath).ledger) ? ledgerStatus({ ledgerPath }).totals.committed_usd : 0;

/**
 * Judge tasks through one lease and the metering proxy: the family rule and the instruments first, then (paid only) the
 * preregistration attestation and every judge key, then the out's one ledger, the window's room and the lease. A keyless
 * run sends every request to the fake upstream with placeholder keys. The receipt in <out>/receipts/ holds the spend.
 */
export async function judgeInWindow(o: { tasks: readonly Task[]; question: (t: Task) => MemoryQuestion; out: string; logPath: string; keyless: string | null; window: PaidWindow | null; lease: LeaseArgs; runner: string; extra?: Record<string, unknown> }): Promise<{ run: JudgeRun; stop: StopCode }> {
  for (const t of o.tasks) checkPair(t.judge, t.reader);
  checkInstruments(o.tasks);
  const attestation = o.keyless ? null : attestPreregistration(BN10_PREREGISTRATION, ROOT);
  if (!o.keyless) await preflightKeys(o.tasks.map(t => t.judge));
  const { ledger, runId, leaseUsd, capUsd, concurrency } = o.lease;
  tieLedger(o.out, ledger);
  if (o.window) checkWindowRoom(o.window, ledger, runId, leaseUsd);
  const [cellToken, controlToken] = [randomUUID(), randomUUID()];
  Object.assign(process.env, { SHOOTOUT_CELL_TOKEN: cellToken, SHOOTOUT_PROXY_CONTROL_TOKEN: controlToken });
  const lease = openRereadLease({ runId, leaseUsd, ledgerPath: ledger, capUsd, runner: o.runner });
  const usageLog = join(o.out, `usage-${runId}.ndjson`);
  const pinnedCaps = Object.fromEntries(o.tasks.flatMap(t => (t.settings ? [[`judge@${t.judge}`, t.settings.max_tokens]] : [])));
  const proxy = new MeteringProxy({ ...(o.keyless ? { upstream: keylessUpstream(o.keyless) } : {}), cellToken, controlToken,
    policy: { lease, usageLog, env: o.keyless ? keylessKeys() : { ...process.env }, routeCaps: { caps: { ...DEFAULT_ROUTE_CAPS, ...pinnedCaps }, slots: { ...DEFAULT_ROUTE_CLASSES }, defaultClass: 'extraction' } } });
  proxy.start();
  try {
    const meter = metering(`http://127.0.0.1:${proxy.port}`, { meter: (m: MeterLine) => appendFileSync(join(o.out, 'meters.ndjson'), JSON.stringify(m) + '\n') }, process.env);
    const client = tallyCalls(new ChatClient(join(o.out, 'cache', 'qa'), undefined, undefined, { holdMayHaveBilled: true }), join(o.out, 'calls.ndjson'));
    const run = await judgeTasks(o.tasks, o.question, new RecordLog(o.logPath, 'judgment'), { client, around: (key, fn) => meter.around('judge', key, 'judge', fn), concurrency, stopFile: join(o.out, 'STOP') });
    const stop = stopCode(run, committedUsd(ledger), capUsd);
    const receipt = { schema: 'gbrain-evals/bn10-judges-receipt/v1', runner: o.runner, run_id: runId, keyless: !!o.keyless, attestation, window: o.window, ...o.extra,
      counts: { tasks: o.tasks.length, judged: run.judged, remaining: run.remaining, request_errors: run.request_errors, held_may_have_billed: run.held }, last_error: run.last_error, stop,
      spend: existsSync(usageLog) ? { source: 'lease usage log', ...usageSplit(usageLog) } : null, lease: { usd: leaseUsd, cap_usd: capUsd, ledger_committed_usd: committedUsd(ledger) } };
    mkdirSync(join(o.out, 'receipts'), { recursive: true });
    writeFileSync(join(o.out, 'receipts', `${o.runner}-${runId}.json`), JSON.stringify(receipt, null, 2) + '\n');
    return { run, stop };
  } finally { proxy.stop(); lease.close(); }
}

// ─── The check's report ──────────────────────────────────────────────

/** Each judge's numbers and gates, and the experiment's verdict: STOP when a frontier judge fails, INCOMPLETE while a frontier judge has items left. */
export function analyzeCheck(items: readonly ControlAnswer[], judgments: readonly JudgmentRecord[], calls: Record<string, { calls: number; truncated: number }>, keyless: boolean | null) {
  const ids = new Set(items.map(i => i.answer_id));
  const judges = Object.fromEntries(CHECK_JUDGES.map(judge => {
    const frontier = judge !== BRIDGE;
    const mine = judgments.filter(j => j.judge === judge && j.judge_replicate === 0 && ids.has(j.answer_id));
    const by = new Map(mine.filter(j => !frontier || atPinned(j)).map(j => [j.answer_id, j]));
    const graded = items.filter(i => by.has(i.answer_id)), ok = items.filter(i => scored(by.get(i.answer_id)));
    const verdict = (i: ControlAnswer) => by.get(i.answer_id)!.score! >= PASS_THRESHOLD;
    const k = cohenKappa(ok.map(i => i.expected === 'pass'), ok.map(verdict));
    const pass = ok.filter(i => i.expected === 'pass').length, fail = ok.length - pass;
    const c = calls[judge] ?? { calls: 0, truncated: 0 }, truncation = rate(c.truncated, c.calls);
    const gates = [
      { gate: 'every_item_graded', value: graded.length, line: items.length, pass: graded.length === items.length },
      { gate: 'kappa', value: r4(k.kappa), line: KAPPA_GATE, pass: k.kappa !== null && k.kappa >= KAPPA_GATE },
      { gate: 'scored_items', value: ok.length, line: MIN_ITEMS, pass: ok.length >= MIN_ITEMS },
      { gate: 'per_class', value: Math.min(pass, fail), line: MIN_PER_CLASS, pass: Math.min(pass, fail) >= MIN_PER_CLASS },
      { gate: 'truncation', value: truncation.rate, line: TRUNCATION_GATE, pass: truncation.rate !== null && truncation.rate <= TRUNCATION_GATE },
    ];
    return [judge, { role: frontier ? 'frontier' : 'bridge', settings: frontier ? { ...PER_READER_JUDGE_SETTINGS } : 'canonical', items: items.length, graded: graded.length, scored: ok.length,
      unscored: graded.length - ok.length, off_settings: mine.length - by.size, classes: { pass, fail }, kappa: r4(k.kappa), kappa_ci95: k.ci95?.map(x => r4(x)!) ?? null,
      error_by_kind: Object.fromEntries(KINDS.map(kind => { const xs = ok.filter(i => i.control === kind); return [kind, rate(xs.filter(i => verdict(i) !== (i.expected === 'pass')).length, xs.length)]; })),
      truncation, gates, complete: graded.length === items.length, pass: gates.every(g => g.pass) }];
  }));
  const bridge = judges[BRIDGE];
  const verdict = FRONTIER_JUDGES.some(j => !judges[j].complete) ? 'INCOMPLETE' : FRONTIER_JUDGES.some(j => !judges[j].pass) ? 'STOP' : 'PASS';
  const pass = items.filter(i => i.expected === 'pass').length;
  return {
    schema: CHECK_SCHEMA, preregistration: BN10_PREREGISTRATION, keyless, instrument: CHECK_BENCHMARK, pass_threshold: PASS_THRESHOLD,
    items: { total: items.length, questions: new Set(items.map(i => i.question_id)).size, pass, fail: items.length - pass, by_kind: Object.fromEntries(KINDS.map(kind => [kind, items.filter(i => i.control === kind).length])) },
    judges, verdict, bridge: !bridge.complete ? 'incomplete' : bridge.pass ? 'counts' : 'descriptive-only',
    stop_reasons: FRONTIER_JUDGES.flatMap(j => (judges[j].complete ? judges[j].gates.filter(g => !g.pass).map(g => `${j}:${g.gate}`) : [])),
  };
}
export type CheckReport = ReturnType<typeof analyzeCheck>;

/** Refuse report text that holds any item's question id or answer text. */
export function guardItems(text: string, items: readonly Pick<ControlAnswer, 'question_id' | 'text'>[]): void {
  const hit = items.some(i => text.includes(i.question_id) || (i.text.length >= 8 && text.includes(i.text)));
  if (hit) throw refuse({ code: 'PREFLIGHT_FAILED', message: 'the report would hold an item\'s question id or text; nothing was written', why: 'the check\'s item texts stay out of the repository; its report carries counts, rates and kappas', fix: { next: 'report', user_message: 'report a bug in bn10-judges.ts' } });
}

// ─── Agreement on the dry run's real answers ─────────────────────────

/** The dry run's answer cells: its arms and particle-1's re-reads of them. */
export const dryRunCells = (): string[] => {
  const m = buildBN10Manifest();
  return [...m.smoke_cells.flatMap(c => c.arms.map(a => a.cell_id)), ...m.reread_plans.filter(p => p.block === 'BN10-dry').map(p => p.id)].sort();
};

/** Each pair of the three judges over the dry-run answers both scored: count, agreement with its Wilson interval, and kappa. Descriptive. */
export function dryRunAgreement(roots: readonly string[]) {
  const unpaid = roots.flatMap(r => stage1Unpaid(r) ?? []);
  if (unpaid.length) throw refuse({ code: 'USAGE', message: `--dry-run takes paid dry-run outs only: ${unpaid.join('; ')}`, why: 'a keyless rehearsal\'s judgments come from a fake upstream and never count', fix: { next: 'report', user_message: 'pass the paid dry run\'s out' } });
  const cells = new Set(dryRunCells()), byAnswer = new Map<string, Map<string, boolean>>();
  let files = 0, unpinned = 0;
  for (const root of roots) {
    const dir = join(root, 'cells');
    for (const d of existsSync(dir) ? readdirSync(dir).sort() : []) {
      const f = join(dir, d, 'judgments.ndjson');
      if (!cells.has(d) || !existsSync(f)) continue;
      files++;
      for (const j of readRecords(f, 'judgment')) {
        if (j.judge_replicate !== 0 || !CHECK_JUDGES.includes(j.judge) || !scored(j)) continue;
        if (j.judge !== BRIDGE && !atPinned(j)) { unpinned++; continue; }
        const m = byAnswer.get(j.answer_id) ?? new Map<string, boolean>();
        m.set(j.judge, j.score >= PASS_THRESHOLD);
        byAnswer.set(j.answer_id, m);
      }
    }
  }
  if (!files) throw refuse({ code: 'INPUT_MISSING', message: `no dry-run judgments under ${roots.join(', ')}`, why: `the dry run's answers are in cells/<id>/judgments.ndjson for ${[...cells].join(', ')}`, fix: { next: 'report', user_message: 'pass the dry run\'s out and its re-read outs' } });
  const pairs = CHECK_JUDGES.flatMap((a, i) => CHECK_JUDGES.slice(i + 1).map(b => {
    const shared = [...byAnswer.values()].filter(m => m.has(a) && m.has(b));
    const k = cohenKappa(shared.map(m => m.get(a)!), shared.map(m => m.get(b)!));
    return { judges: [a, b], agreement: rate(shared.filter(m => m.get(a) === m.get(b)).length, shared.length), kappa: r4(k.kappa), kappa_ci95: k.ci95?.map(x => r4(x)!) ?? null };
  }));
  return { schema: AGREEMENT_SCHEMA, preregistration: BN10_PREREGISTRATION, view: 'descriptive', roots: roots.length, cell_files: files, answers: byAnswer.size, unpinned_frontier_judgments: unpinned, pairs };
}

// ─── Stored answers judged again, in custody ─────────────────────────

export const REJUDGE_SCHEMA = 'gbrain-evals/bn10-rejudge-aggregates/v1';
export const STORED_READER = OPUS;
export const STORED_JUDGE = frontierJudgeOf(STORED_READER);
export const STORED_SETS = [
  { id: 'f6-p', root: 'f6', cell: 's1.gbrain-defaults.f6-master.p', label: "F6's arm P" },
  { id: 'f6-a', root: 'f6', cell: 's1.gbrain-defaults.f6-master.a', label: "F6's arm A" },
  { id: 'q1-whole', root: 'q1', cell: 's1.gbrain-defaults.shipped-defaults.whole-default', label: "Q1's whole-system arm" },
  { id: 'q1-file-agent', root: 'q1', cell: 's1.baseline-file-agent.baseline.whole-agent', label: "Q1's file agent" },
] as const;
export type StoredSetId = typeof STORED_SETS[number]['id'];
export interface StoredCounts { scheduled: number; excluded: number; missing: number; product_failures: number; not_judged: number; to_judge: number }

/** The receipts with the four stored cells loaded beside GST-1365's contrast cells (loadSources keeps Q1's answer ids apart from F6's). */
export const loadStored = (roots: string[], out: string): Sources => loadSources(roots, out, STORED_SETS.map(x => ({ root: x.root, cell: x.cell })));

/** Each stored set's counts and the tasks: every scheduled, unexcluded question's replicate-0 Opus answer with a judged outcome, for gpt-6.1-sol at the pinned settings. */
export function storedTasks(s: Sources): { tasks: Task[]; sets: Record<StoredSetId, StoredCounts>; setOf: Map<string, StoredSetId> } {
  const tasks: Task[] = [], setOf = new Map<string, StoredSetId>();
  const sets = Object.fromEntries(STORED_SETS.map(x => {
    const cell = cellOf(s, x.root, x.cell), set = s.campaigns[x.root].sets.find(y => y.id === cell.def.set)!;
    const excluded = new Set(set.exclusions.map(e => e.question_id)), asProduct = new Set((cell.def.product_outcomes ?? []).map(p => `${p.reader}|${p.outcome}`));
    const answers = new Map(cell.answers.filter(a => a.reader === STORED_READER && a.replicate === 0).map(a => [a.question_id, a]));
    const c: StoredCounts = { scheduled: 0, excluded: 0, missing: 0, product_failures: 0, not_judged: 0, to_judge: 0 };
    for (const q of set.scheduled) {
      if (excluded.has(q.question_id)) { c.excluded++; continue; }
      c.scheduled++;
      const a = answers.get(q.question_id);
      if (!a) { c.missing++; continue; }
      if (PRODUCT_FAILURES.has(a.outcome as Outcome) || asProduct.has(`${a.reader}|${a.outcome}`)) { c.product_failures++; continue; }
      if (!JUDGED.has(a.outcome as Outcome)) { c.not_judged++; continue; }
      c.to_judge++;
      setOf.set(a.answer_id, x.id);
      tasks.push({ answer_id: a.answer_id, question_id: a.question_id, set: cell.def.set, cell: cell.def.cell_id, system: cell.def.system, reader: a.reader, text: a.text, judge: STORED_JUDGE,
        instrument: cell.def.canonical_instrument, instrument_id: frontierId(cell.def.canonical_instrument, STORED_JUDGE), instrument_sha256: cell.instrument.sha256, settings: { ...PER_READER_JUDGE_SETTINGS }, view: 'gating' });
    }
    return [x.id, c];
  })) as Record<StoredSetId, StoredCounts>;
  return { tasks, sets, setOf };
}

/** What the re-judge would send, per set and in all: judgments, rubric calls, and event-ordering answers (which also ask equivalence calls). Sends nothing. */
export function rejudgePlan(stored: ReturnType<typeof storedTasks>, question: (t: Task) => MemoryQuestion) {
  const of = (id: StoredSetId) => stored.tasks.filter(t => stored.setOf.get(t.answer_id) === id);
  const sets = Object.fromEntries(STORED_SETS.map(x => [x.id, { label: x.label, ...stored.sets[x.id], judgments: of(x.id).length, calls: callCount(of(x.id), question), event_ordering_answers: of(x.id).filter(t => question(t).category === 'event_ordering').length }]));
  return { judge: STORED_JUDGE, settings: { ...PER_READER_JUDGE_SETTINGS }, reader: STORED_READER, sets,
    total: { judgments: stored.tasks.length, calls: callCount(stored.tasks, question), event_ordering_answers: stored.tasks.filter(t => question(t).category === 'event_ordering').length } };
}

/** A custody --out holds only this re-judge's judgments: gpt-6.1-sol at the pinned settings; anything else is refused before a lease. */
export function checkOwnLog(logPath: string): void {
  const other = ndjson<JudgmentRecord>(logPath).filter(j => j.judge !== STORED_JUDGE || !atPinned(j)).length;
  if (other) throw refuse({ code: 'RESUME_REFUSED', message: `${logPath} holds ${other} judgments that are not ${STORED_JUDGE} at ${JSON.stringify(PER_READER_JUDGE_SETTINGS)}`,
    why: 'a resume skips answers its log already holds, so another run\'s judgments would stand in for the pinned re-judge', fix: { next: 'run', argv: [...FRONT, 'rejudge-run', '--out', '<a fresh custody directory>'] } });
}

/** Per set: counts, and over its judged answers with product failures at 0, the mean score and the pass rate with its Wilson interval; question and answer ids never appear. */
export function rejudgeAggregates(s: Sources, stored: ReturnType<typeof storedTasks>, judgments: readonly JudgmentRecord[], keyless: boolean | null) {
  const own = new Map(judgments.filter(j => j.judge === STORED_JUDGE && j.judge_replicate === 0 && atPinned(j)).map(j => [j.answer_id, j]));
  const mean = (xs: number[]) => (xs.length ? r4(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const sets = Object.fromEntries(STORED_SETS.map(x => {
    const mine = stored.tasks.filter(t => stored.setOf.get(t.answer_id) === x.id), c = stored.sets[x.id];
    const done = mine.flatMap(t => (own.has(t.answer_id) ? [own.get(t.answer_id)!] : []));
    const ok = done.filter(scored).map(j => j.score), withFailures = [...ok, ...Array<number>(c.product_failures).fill(0)];
    return [x.id, { label: x.label, ...c, judged: done.length, scored: ok.length, judge_errors: done.length - ok.length, truncated: done.filter(j => j.detail?.truncated === true).length,
      remaining: mine.length - done.length, complete: done.length === mine.length, mean_judged: mean(ok), mean_with_product_failures: mean(withFailures),
      pass: rate(withFailures.filter(v => v >= PASS_THRESHOLD).length, withFailures.length) }];
  }));
  const out = { schema: REJUDGE_SCHEMA, preregistration: BN10_PREREGISTRATION, keyless, judge: STORED_JUDGE, settings: { ...PER_READER_JUDGE_SETTINGS }, view: 'gating', reader: STORED_READER, pass_threshold: PASS_THRESHOLD,
    sets, complete: Object.values(sets).every(v => v.complete) };
  const text = JSON.stringify(out);
  guardIds(text, s);
  if (stored.tasks.some(t => text.includes(t.answer_id))) throw refuse({ code: 'PREFLIGHT_FAILED', message: 'the aggregates would hold an answer id; nothing was written', why: 'only aggregates leave custody', fix: { next: 'report', user_message: 'report a bug in bn10-judges.ts' } });
  return out;
}

// ─── CLI ─────────────────────────────────────────────────────────────

const SUBCOMMANDS = ['check-plan', 'check-run', 'check-report', 'agreement', 'rejudge-plan', 'rejudge-run', 'rejudge-summary'];
const PAID = ['check-run', 'rejudge-run'];

if (import.meta.main) {
  const argv = process.argv.slice(2), sub = argv[0];
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const many = (n: string) => argv.flatMap((a, i) => (a === n && argv[i + 1] ? [argv[i + 1]] : []));
  const positive = (n: string) => (Number(one(n)) > 0 ? Number(one(n)) : null);
  try {
    const outArg = one('--out');
    if (!SUBCOMMANDS.includes(sub) || !outArg) throw refuse({ code: 'USAGE', message: `usage: ${FRONT.join(' ')} ${SUBCOMMANDS.join('|')} ... --out <dir>`, why: 'every subcommand reads and writes one --out; the file header lists the flags', fix: { next: 'run', argv: [...FRONT, 'check-plan', '--out', '<dir>'] } });
    const paid = PAID.includes(sub);
    const keyless = paid ? keylessUpstreamArg(argv) : null;
    const window = paid ? requireRs1Window(argv, { what: `bn10-judges.ts ${sub} without --keyless-upstream`, keyless: !!keyless, caps: () => [{ label: '--ledger-cap-usd', usd: positive('--ledger-cap-usd') }, { label: '--lease-usd', usd: positive('--lease-usd') }] }) : null;
    const lease = paid ? leaseArgs(one, sub) : null;
    if (keyless || !paid) for (const k of PROVIDER_KEYS) delete process.env[k];
    const out = resolve(outArg);
    mkdirSync(out, { recursive: true });
    if (sub === 'agreement') {
      const roots = many('--dry-run').map(r => resolve(r));
      if (!roots.length) throw refuse({ code: 'USAGE', message: 'agreement needs --dry-run <dry-run out>', why: 'it reads the dry run\'s judgments', fix: { next: 'run', argv: [...FRONT, 'agreement', '--dry-run', '<out>', '--out', '<dir>'] } });
      const json = JSON.stringify(dryRunAgreement(roots), null, 2) + '\n';
      writeFileSync(join(out, 'agreement.json'), json);
      console.log(json);
      process.exit(0);
    }
    if (sub.startsWith('rejudge-')) {
      const s = loadStored(many('--root'), out);
      reproduce(s);
      const stored = storedTasks(s), logPath = join(out, 'judgments.ndjson');
      checkOwnLog(logPath);
      const aggregates = () => {
        const marker = existsSync(join(out, 'upstream.json')) ? JSON.parse(readFileSync(join(out, 'upstream.json'), 'utf8')).keyless === true : null;
        const json = JSON.stringify(rejudgeAggregates(s, stored, ndjson<JudgmentRecord>(logPath), marker), null, 2) + '\n';
        for (const f of [join(out, 'aggregates.json'), ...(one('--aggregates') ? [resolve(one('--aggregates')!)] : [])]) writeFileSync(f, json);
        return JSON.parse(json) as ReturnType<typeof rejudgeAggregates>;
      };
      if (sub === 'rejudge-summary') { const a = aggregates(); console.log(JSON.stringify(a, null, 2)); process.exit(a.complete ? 0 : 4); }
      const q = questionsFor([...new Set(stored.tasks.map(t => t.set))], out, process.env, { id: 'bn10-rejudge', purpose: 'BEAM-10M re-measure: stored answers judged again at the pinned settings' });
      const question = (t: Task) => q(t.set, t.question_id);
      if (sub === 'rejudge-plan') { console.log(JSON.stringify(rejudgePlan(stored, question), null, 2)); process.exit(0); }
      claimOut(out, !!keyless, 'bn10-rejudge');
      checkIdentity(join(out, 'identity-rejudge.json'), stored.tasks);
      const { run, stop } = await judgeInWindow({ tasks: stored.tasks, question, out, logPath, keyless, window, lease: lease!, runner: 'bn10-rejudge', extra: { sets: stored.sets } });
      const a = aggregates();
      console.log(JSON.stringify({ subcommand: sub, stop, judged: run.judged, remaining: run.remaining, request_errors: run.request_errors, held_may_have_billed: run.held, complete: a.complete }, null, 2));
      process.exitCode = exitFor(stop, run.remaining);
      process.exit();
    }
    if (sub === 'check-report') {
      const items = existsSync(join(out, 'items.json')) ? JSON.parse(readFileSync(join(out, 'items.json'), 'utf8')) as ControlAnswer[] : null;
      if (!items) throw refuse({ code: 'INPUT_MISSING', message: `${out} has no items.json`, why: 'the report scores the frozen items check-plan or check-run wrote', fix: { next: 'run', argv: [...FRONT, 'check-plan', '--out', out] } });
      const marker = existsSync(join(out, 'upstream.json')) ? JSON.parse(readFileSync(join(out, 'upstream.json'), 'utf8')).keyless === true : null;
      const report = analyzeCheck(items, ndjson<JudgmentRecord>(join(out, 'judgments.ndjson')), readCalls(join(out, 'calls.ndjson')), marker);
      const json = JSON.stringify(report, null, 2) + '\n';
      guardItems(json, items);
      writeFileSync(join(out, 'report.json'), json);
      console.log(CHECK_JUDGES.map(j => `${j}: kappa ${report.judges[j].kappa ?? 'n/a'} on ${report.judges[j].scored}, truncation ${report.judges[j].truncation.rate ?? 'n/a'}, ${report.judges[j].pass ? 'pass' : report.judges[j].complete ? 'FAIL' : 'incomplete'}`).join('\n'));
      console.log(`verdict ${report.verdict}; bridge ${report.bridge}`);
      if (report.verdict === 'STOP') { process.stderr.write(`JUDGE_CHECK_STOP: ${report.stop_reasons.join(', ')}; no counted cell runs and every number goes to GBEV-3\n`); process.exit(3); }
      if (report.verdict === 'INCOMPLETE' || marker !== false) { process.stderr.write(`JUDGE_CHECK_NOT_PASSED: ${report.verdict === 'INCOMPLETE' ? 'a frontier judge has items left' : marker ? 'a keyless rehearsal' : 'no keyless/paid marker in --out'}; only a complete paid check passes\n`); process.exit(4); }
      process.exit(0);
    }
    const instrument = instrumentFor(CHECK_BENCHMARK);
    const questions = new Map(loadCheckQuestions().map(q => [q.id, q]));
    const built = checkItems([...questions.values()]);
    const question = (t: Task) => questions.get(t.question_id)!;
    const tasks = checkTasks(built.items, instrument);
    freezeItems(out, built.items);
    if (sub === 'check-plan') {
      console.log(JSON.stringify({ questions: built.questions, items: built.items.length, classes: built.classes, c2_skipped: built.c2_skipped, judges: CHECK_JUDGES, judgments: tasks.length,
        calls: Object.fromEntries(CHECK_JUDGES.map(j => [j, callCount(tasks.filter(t => t.judge === j), question)])), calls_total: callCount(tasks, question) }, null, 2));
      process.exit(0);
    }
    claimOut(out, !!keyless, 'bn10-judge-check');
    checkIdentity(join(out, 'identity-check.json'), tasks);
    const { run, stop } = await judgeInWindow({ tasks, question, out, logPath: join(out, 'judgments.ndjson'), keyless, window, lease: lease!, runner: 'bn10-judge-check', extra: { items: built.items.length, judges: CHECK_JUDGES } });
    console.log(JSON.stringify({ subcommand: sub, stop, judged: run.judged, remaining: run.remaining, request_errors: run.request_errors, held_may_have_billed: run.held }, null, 2));
    process.exitCode = exitFor(stop, run.remaining);
  } catch (e) {
    if (e instanceof ScoreboardError) {
      process.stderr.write(renderMessage(e.op) + '\n');
      process.exit(e.op.code === 'BUDGET_CAP' ? 5 : e.op.code === 'KEY_MISSING' ? 2 : exitCodeOf(e.op));
    }
    if (e instanceof WindowRefusal) { console.error(e.message); process.exit(2); }
    if (e instanceof SyntaxError) {
      console.error(renderMessage({ code: 'PREFLIGHT_FAILED', message: `bn10-judges.ts ${sub ?? ''} could not parse one of its input files`, why: 'no custody data or embedded parser error is printed',
        fix: { next: 'report', user_message: 'Check the JSON and NDJSON files under --out and each --root on the custody host.' } }));
      process.exit(2);
    }
    console.error((e as Error).message);
    process.exit(2);
  }
}

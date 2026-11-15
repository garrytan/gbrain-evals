/**
 * A6's second-judge sensitivity for the particle-1 add-on (GBEV-35 / GST-1153): where particle-1 minus claude-opus-5-5
 * is above 0 on a cell under the canonical judge, gpt-6.1-sol judges both readers' answers on that cell again with the
 * same instrument, and the cell's receipt gives particle-1 minus Opus under both judges side by side. The second judge
 * never replaces a canonical score: its judgments sit apart from both cells, under the instrument id F6's frontier
 * judges use (`<instrument>@openai:gpt-6.1-sol`). OpenAI grades neither reader's rows (GST-767).
 *
 *   bun eval/runner/q1/second-judge.ts --cell <source cell id> --arm <arm id> [--manifest q1|f6] --root <cell output>... --out <dir>
 *     --budget-ledger <file> --run-id <id> --lease-usd <n> --ledger-cap-usd <n> [--concurrency <n>]
 *     (--keyless-upstream <url> | --paid-window <unit> --window-cap-usd <n>)
 *   bun eval/runner/q1/second-judge.ts summary --out <dir>...
 *
 * A run without --keyless-upstream spends real keys, so it needs the granted paid window's unit and cap, and its
 * --ledger-cap-usd and --lease-usd never exceed that cap (eval/runner/paid-arm.ts, the shared window guard); otherwise
 * it exits 2 before any lease or output.
 *
 * --root takes particle-addon-report.ts's roots (the re-read's --out and the frontier cell's output), and the cell is
 * the particle-1 cell the report pairs with the arm's cell. Before any request (prepareSecondJudge): the custody gate a
 * sealed cell needs, one cell per --out, the pairing, both source cells complete, the frontier cell's instrument being
 * this tree's, and A6's trigger, particle-1 minus Opus above 0 under the canonical judge. The answers judged are each reader's replicate-0
 * answers on the questions both have in their canonical denominators (the set's exclusions left out) whose outcome a
 * judge scores; a product failure scores 0 under both judges and sends nothing.
 *
 * Judging (runSecondJudge) is cell.ts's frontier judging, judgeAnswer at the judge's default effort and replicate 0 on
 * the `judge` slot through the in-process lease proxy, with --concurrency answers in flight (default 8; one rubric
 * request takes gpt-6.1-sol about 12 s, and a BEAM cell asks some 6,000). Each pass binds the slot once, around all
 * of its answers, so the slot's routing and metering key never change while requests are in flight; meters.ndjson has
 * one line per pass, and the receipt's dollars come from the lease's per-request usage log, which a killed pass keeps. A
 * budget refusal stops new answers (partial), other judge errors are counted with the last message, and a resume skips
 * judged answers of the same answers and questions. A6 takes the second judge's dollars from the re-read ceiling, so the lease is the
 * re-read ledger's and openRereadLease refuses one that would pass --ledger-cap-usd. A BG1 cell (--manifest bg1) that is not
 * keyless also needs the granted window (--paid-window <unit> --window-cap-usd <n>, the shared guard in paid-arm.ts),
 * with --ledger-cap-usd and --lease-usd at most its cap, and refuses with exit 2 before any output or lease. Output:
 * `--out/cells/<arm cell id>.second-judge/` with judgments.ndjson and receipt.json, whose comparison holds particle-1
 * minus Opus under each judge over the questions both judges scored for both readers, with the report's seed,
 * resamples and conversation clusters. stdout, the receipt and the summary carry counts, means, intervals and dollars,
 * never a question id.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadCorpus, type Corpus, type MemoryQuestion } from '../memory-qa/corpus.ts';
import { instrumentFor, PASS_THRESHOLD, type Instrument } from '../memory-qa/instruments.ts';
import { DEFAULT_MAX_ATTEMPTS } from '../memory-qa/outcomes.ts';
import { ChatClient, judgeAnswer, type ChatLike } from '../memory-qa/qa-v2.ts';
import { judgmentKey, RecordLog, sha256, type AnswerRecord } from '../memory-qa/records.ts';
import { DEFAULT_ROUTE_CAPS, keylessKeys, keylessUpstream, MeteringProxy, usageSplit } from '../metering-proxy.ts';
import { requireRs1Window } from '../paid-arm.ts';
import { DEFAULT_ROUTE_CLASSES } from '../shootout-cell.ts';
import { clusteredPairedDelta } from '../stats/paired.ts';
import { claimOut, keylessUpstreamArg } from './calibration-cell.ts';
import { custodyGate, devOnly, findCell, frontierInstrumentId, JUDGED, metering, needsCustody, type MeterLine } from './cell.ts';
import { ALL_SETS, isBg1Benchmark, type ArmDefinition, type CellDefinition, type SetId } from './cells/definitions.ts';
import { loadCells, OPUS, PARTICLE, RESAMPLES, SEED, seedNumber, SOL, unitReport, unitsOf, valuesOf, type Unit, type Value } from './particle-addon-report.ts';
import { requireRs1Window as requireBg1Window } from '../paid-arm.ts';
import { openRereadLease } from './reread-cell.ts';
import { exitCodeOf, refuse, renderMessage, ScoreboardError } from './scoreboard-errors.ts';

export const SECOND_JUDGE_RECEIPT_SCHEMA = 'gbrain-evals/q1-second-judge-receipt/v1';
export const SECOND_JUDGE = SOL;
const FRONT = ['bun', 'eval/runner/q1/second-judge.ts'];

export const secondJudgeCellId = (armCellId: string) => `${armCellId}.second-judge`;

export interface PlannedJudgment { question: MemoryQuestion; answer: AnswerRecord }
export interface PreparedSecondJudge {
  arm: ArmDefinition; unit: Unit; out: string; keyless: boolean; instrument: Instrument; excluded: Set<string>; source_status: { frontier: string | null; particle: string | null };
  canonical: Map<string, Map<string, Value>>; paired: string[]; trigger: { pairs: number; delta: number; ci95: [number, number] | null }; plan: PlannedJudgment[];
}

/** Everything before the first request: custody, one cell per --out, the --out claim, the pairing, both source cells complete, the instrument, A6's trigger and the answers to judge. */
export function prepareSecondJudge(def: CellDefinition, arm: ArmDefinition, opts: { roots: string[]; out: string; env?: Record<string, string | undefined>; keyless?: boolean },
  deps: { corpus?: Corpus; instrument?: Instrument } = {}): PreparedSecondJudge {
  const env = opts.env ?? process.env;
  const out = resolve(opts.out);
  const instrument = deps.instrument ?? instrumentFor(def.canonical_instrument);
  if (!deps.corpus && needsCustody(def)) custodyGate(def, out, env, `q1 second judge ${arm.cell_id} with ${SECOND_JUDGE}`);
  const cellId = secondJudgeCellId(arm.cell_id);
  const others = existsSync(join(out, 'cells')) ? readdirSync(join(out, 'cells')).sort().filter(d => d !== cellId) : [];
  if (others.length) throw refuse({ code: 'USAGE', message: `${out} already holds ${others.join(', ')}; give each cell its own --out`,
    why: 'the lease usage log and the keyless/paid marker sit at the --out root, and each second-judge receipt points at them', fix: { next: 'run', argv: [...FRONT, '--out', '<a fresh directory>'] } });
  const unit = unitsOf(loadCells(opts.roots)).find(u => u.frontier.id === arm.cell_id);
  if (!unit) throw refuse({ code: 'INPUT_MISSING', message: `no particle-1 cell under the roots pairs with ${arm.cell_id}`,
    why: 'the second judge grades the answers of a particle-1 cell and of the frontier cell the report pairs it with', fix: { next: 'run', argv: [...FRONT, '--root', '<the re-read --out>', '--root', '<the frontier cell output>'] } });
  const source_status = { frontier: unit.frontier.receipt.run_status ?? null, particle: unit.particle.receipt.run_status ?? null };
  if (source_status.frontier !== 'complete' || source_status.particle !== 'complete') throw refuse({ code: 'PREFLIGHT_FAILED', message: `${arm.cell_id}'s source cells are frontier ${source_status.frontier ?? 'n/a'} and particle-1 ${source_status.particle ?? 'n/a'}, not both complete`,
    why: 'A6 judges a finished cell again: a partial source cell moves the trigger, and its resume changes the answers a second judge froze', fix: { next: 'report', user_message: `finish both source cells of ${arm.cell_id} before its second judge` } });
  const judgedBy = unit.frontier.receipt.instrument;
  if (judgedBy.id !== instrument.id || judgedBy.sha256 !== instrument.sha256) throw refuse({ code: 'PREFLIGHT_FAILED', message: `${arm.cell_id} was judged with ${judgedBy.id} (${judgedBy.sha256.slice(0, 12)}), not this tree's ${instrument.id} (${instrument.sha256.slice(0, 12)})`,
    why: 'A6 judges again on the same instrument the canonical scores came from', fix: { next: 'report', user_message: 'run the second judge from a tree whose instrument is the one the cell was judged with' } });
  const trigger = unitReport(unit).particle_minus.find(d => d.minus === OPUS);
  if (!trigger || !(trigger.delta > 0)) throw refuse({ code: 'PREFLIGHT_FAILED', message: `particle-1 minus Opus on ${arm.cell_id} is ${trigger ? `${trigger.delta}` : 'not measured'} under the canonical judge, so A6 asks for no second judge there`,
    why: 'A6 judges a cell again only where particle-1 minus claude-opus-5-5 is above 0', fix: { next: 'report', user_message: `${arm.cell_id} needs no second judge` } });

  const excluded = new Set(ALL_SETS[unit.frontier.receipt.set as SetId].exclusions.map(e => e.question_id));
  const canonical = new Map([...valuesOf(unit.frontier, excluded), ...valuesOf(unit.particle, excluded)]);
  const opus = canonical.get(OPUS) ?? new Map<string, Value>(), mine = canonical.get(PARTICLE)!;
  const paired = [...mine.keys()].filter(q => mine.get(q)!.value !== null && opus.get(q)?.value != null).sort();
  const answers = new Map([...unit.frontier.answers, ...unit.particle.answers].filter(a => a.replicate === 0).map(a => [`${a.reader}|${a.question_id}`, a]));
  const corpus = deps.corpus ?? loadCorpus(def.benchmark, undefined, devOnly(def) ?? undefined, { keyless: !!opts.keyless });
  const questions = new Map(corpus.questions.map(q => [q.id, q]));
  const plan: PlannedJudgment[] = [];
  let unknown = 0;
  for (const q of paired) for (const reader of [OPUS, PARTICLE]) {
    const answer = answers.get(`${reader}|${q}`)!;
    if (!JUDGED.has(answer.outcome)) continue;
    const question = questions.get(q);
    if (question) plan.push({ question, answer }); else unknown++;
  }
  if (unknown) throw refuse({ code: 'PREFLIGHT_FAILED', message: `${unknown} answers to judge are on questions this tree's ${def.benchmark} corpus does not hold`,
    why: 'the judge scores each answer against its question\'s rubric', fix: { next: 'report', user_message: 'run the second judge from the tree the cell was read with' } });

  mkdirSync(out, { recursive: true });
  claimOut(out, !!opts.keyless, 'second-judge');
  const frozen = join(out, 'second-judge-source.json');
  const identity = JSON.stringify({ frontier_cell: unit.frontier.id, particle_cell: unit.particle.id, judge: SECOND_JUDGE, instrument_sha256: instrument.sha256,
    answers_sha256: sha256(plan.map(x => JSON.stringify(x.answer)).sort().join('\n')),
    questions_sha256: sha256([...new Map(plan.map(x => [x.question.id, x.question])).values()].map(q => JSON.stringify([q.id, q.answer ?? null, q.rubric ?? null])).sort().join('\n')) }) + '\n';
  if (existsSync(frozen) && readFileSync(frozen, 'utf8') !== identity) throw refuse({ code: 'RESUME_REFUSED', message: `${out} holds a second judge of other answers, other gold answers or rubrics, another judge or another instrument; give this run a fresh --out`,
    why: 'a resume keeps the judgments already in --out, so it must judge the answers they were made on', fix: { next: 'run', argv: [...FRONT, '--out', '<a fresh directory>'] } });
  if (!existsSync(frozen)) writeFileSync(frozen, identity);
  return { arm, unit, out, keyless: !!opts.keyless, instrument, excluded, source_status, canonical, paired, trigger: { pairs: trigger.pairs, delta: trigger.delta, ci95: trigger.ci95 }, plan };
}

const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

/** particle-1 minus Opus over `questions` under one judge's values, with the report's seeded clustered bootstrap. */
function side(values: Map<string, Map<string, Value>>, questions: string[]) {
  const at = (reader: string, q: string) => values.get(reader)!.get(q)!;
  const d = clusteredPairedDelta(questions.map(q => ({ id: q, cluster: at(PARTICLE, q).conversation, a: at(OPUS, q).value!, b: at(PARTICLE, q).value! })), { seed: seedNumber(SEED), draws: RESAMPLES });
  const correct = (reader: string) => questions.filter(q => at(reader, q).value! >= PASS_THRESHOLD).length;
  return { opus_mean: round(d.mean_a), particle_mean: round(d.mean_b), delta: round(d.delta), ci95: d.ci95 ? [round(d.ci95[0]), round(d.ci95[1])] as [number, number] : null, p_two_sided: round(d.p_two_sided),
    opus_correct: correct(OPUS), particle_correct: correct(PARTICLE) };
}

export interface SecondJudgeResult { cell_id: string; dir: string; status: 'complete' | 'partial'; stopped: string | null; receipt: Record<string, unknown> }

/** Judge the plan with gpt-6.1-sol, resuming from --out, then write receipt.json; `lease` names the lease and its proxy's usage log for the receipt. */
export async function runSecondJudge(p: PreparedSecondJudge, opts: { providerProxy?: string | null; env?: Record<string, string | undefined>; maxAttempts?: number; concurrency?: number; lease?: { usd: number; usageLog: string } } = {},
  deps: { judge?: ChatLike } = {}): Promise<SecondJudgeResult> {
  const env = opts.env ?? process.env;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const cellId = secondJudgeCellId(p.arm.cell_id);
  const dir = join(p.out, 'cells', cellId);
  mkdirSync(dir, { recursive: true });
  const judgments = new RecordLog(join(dir, 'judgments.ndjson'), 'judgment');
  const meters = join(dir, 'meters.ndjson');
  const meter = metering(opts.providerProxy ?? null, { meter: (m: MeterLine) => appendFileSync(meters, JSON.stringify(m) + '\n') }, env);
  const judgeChat = deps.judge ?? new ChatClient(join(p.out, 'cache', 'qa'));
  const second = { id: frontierInstrumentId(p.instrument.id, SECOND_JUDGE), sha256: p.instrument.sha256, judge: SECOND_JUDGE };
  const judged = (a: AnswerRecord) => judgments.has(judgmentKey({ answer_id: a.answer_id, instrument_sha256: second.sha256, judge: SECOND_JUDGE, judge_replicate: 0 }));
  let stopped: string | null = null, requestErrors = 0, lastError: string | null = null;
  const one = async (x: PlannedJudgment) => {
    try { judgments.append({ answer_id: x.answer.answer_id, ...await judgeAnswer(judgeChat, p.instrument, x.question, x.answer.text, { judge: SECOND_JUDGE, judgeReplicate: 0, maxAttempts }), instrument_id: second.id }); }
    catch (e) {
      const message = String((e as Error).message);
      if (/budget/i.test(message)) stopped ??= `budget: ${message.slice(0, 200)}`;
      else { requestErrors++; lastError = message.slice(0, 200); }
    }
  };
  for (let pass = 0; pass < maxAttempts && !stopped; pass++) {
    const queue = p.plan.filter(x => !judged(x.answer));
    if (!queue.length) break;
    const worker = async () => { for (let x = queue.shift(); x && !stopped; x = queue.shift()) await one(x); };
    await meter.around('judge', `judge:${cellId}:pass-${pass}`, 'judge', () => Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 8, queue.length) }, worker)));
  }

  const sol = judgments.all();
  const values = new Map([...valuesOf({ ...p.unit.frontier, judgments: sol }, p.excluded, second), ...valuesOf({ ...p.unit.particle, judgments: sol }, p.excluded, second)]);
  const both = p.paired.filter(q => values.get(OPUS)?.get(q)?.value != null && values.get(PARTICLE)?.get(q)?.value != null);
  const unjudged = p.plan.filter(x => !judged(x.answer)).length;
  const status = !stopped && !unjudged ? 'complete' as const : 'partial' as const;
  const spent = existsSync(meters) ? readFileSync(meters, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as MeterLine) : [];
  const usageLog = join(p.out, 'usage.ndjson');
  const usage = existsSync(usageLog) ? usageSplit(usageLog) : null;
  const receipt = {
    schema: SECOND_JUDGE_RECEIPT_SCHEMA, cell_id: cellId, run_status: status, stopped, last_error: lastError, keyless: p.keyless,
    frontier_cell: p.unit.frontier.id, particle_cell: p.unit.particle.id, source_status: p.source_status, system: { kind: p.unit.frontier.receipt.system.kind },
    judge: SECOND_JUDGE, canonical_judge: p.unit.frontier.receipt.instrument.judge, instrument: { id: second.id, base: p.instrument.id, sha256: second.sha256 },
    trigger: p.trigger,
    counts: { paired_questions: p.paired.length, answers_to_judge: p.plan.length, judged: p.plan.length - unjudged, judge_errors: sol.filter(j => !j.parse_ok).length, request_errors: requestErrors, unjudged },
    comparison: both.length ? { pairs: both.length, clusters: new Set(both.map(q => values.get(PARTICLE)!.get(q)!.conversation)).size, seed: SEED, resamples: RESAMPLES,
      canonical: side(p.canonical, both), second: side(values, both) } : null,
    spend: usage ? { source: 'lease usage log', judge_usd: round(usage.billed_usd + usage.reserved_unsettled_usd, 6) }
      : { source: opts.providerProxy ? 'metering proxy' : null, judge_usd: round(spent.reduce((s, m) => s + m.usd, 0), 6) },
    lease: opts.lease ? { usd: opts.lease.usd, ...(existsSync(opts.lease.usageLog) ? usageSplit(opts.lease.usageLog) : {}) } : null,
    files: { judgments: 'judgments.ndjson' },
  };
  writeFileSync(join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  return { cell_id: cellId, dir, status, stopped, receipt };
}

type Side = ReturnType<typeof side>;
interface Receipt { frontier_cell: string; run_status: string; keyless: boolean; judge: string; canonical_judge: string; comparison: { pairs: number; clusters: number; canonical: Side; second: Side } | null; spend: { judge_usd: number } }
const pts = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`;
const delta = (s: Side) => `${pts(s.delta)} (${s.ci95 ? `${pts(s.ci95[0])} to ${pts(s.ci95[1])}` : 'n/a'})`;

/** The second judge's table, one row per receipt in the order given: both judges on the same questions, in points. */
export function renderSecondJudge(receipts: Receipt[]): string {
  const rehearsals = receipts.filter(r => r.keyless !== false).map(r => r.frontier_cell);
  if (rehearsals.length) throw new Error(`the receipts for ${rehearsals.join(', ')} are keyless rehearsals, whose scores come from a fake upstream and never enter the table`);
  const name = (m: string) => m.slice(m.indexOf(':') + 1);
  const judges = [...new Set(receipts.map(r => `${name(r.canonical_judge)}|${name(r.judge)}`))];
  if (judges.length !== 1) throw new Error(`the receipts name ${judges.length} canonical and second judge pairs, and one table compares one pair`);
  const [canonical, second] = judges[0].split('|');
  const lines = [`| Cell | Second-judge run | Questions (conversations) | particle-1 minus Opus, ${canonical} (95% CI) | particle-1 minus Opus, ${second} (95% CI) | Opus / particle-1 correct, ${canonical} | Opus / particle-1 correct, ${second} | ${second} $ |`, '|---|---|---:|---:|---:|---:|---:|---:|'];
  for (const r of receipts) {
    const c = r.comparison;
    lines.push(c ? `| ${r.frontier_cell} | ${r.run_status} | ${c.pairs} (${c.clusters}) | ${delta(c.canonical)} | ${delta(c.second)} | ${c.canonical.opus_correct} / ${c.canonical.particle_correct} | ${c.second.opus_correct} / ${c.second.particle_correct} | $${r.spend.judge_usd.toFixed(2)} |`
      : `| ${r.frontier_cell} | ${r.run_status} | 0 | n/a | n/a | n/a | n/a | $${r.spend.judge_usd.toFixed(2)} |`);
  }
  return lines.join('\n') + '\n';
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const many = (n: string) => argv.flatMap((a, i) => (a === n && argv[i + 1] ? [argv[i + 1]] : []));
  if (argv[0] === 'summary') {
    const outs = many('--out');
    if (!outs.length) { console.error(`usage: ${FRONT.join(' ')} summary --out <dir>...`); process.exit(2); }
    try {
      process.stdout.write(renderSecondJudge(outs.flatMap(o => readdirSync(join(resolve(o), 'cells')).sort().filter(d => d.endsWith('.second-judge')).map(d => JSON.parse(readFileSync(join(resolve(o), 'cells', d, 'receipt.json'), 'utf8')) as Receipt))));
    } catch (e) { console.error((e as Error).message); process.exit(2); }
    process.exit(0);
  }
  const [cellArg, armArg, outArg, ledger, runId, leaseUsd, ledgerCap, concurrency] = [one('--cell'), one('--arm'), one('--out'), one('--budget-ledger'), one('--run-id'), Number(one('--lease-usd')), Number(one('--ledger-cap-usd')), Number(one('--concurrency') ?? 8)];
  const roots = many('--root');
  if (!cellArg || !armArg || !roots.length || !outArg || !ledger || !runId || !(leaseUsd > 0) || !(ledgerCap > 0) || !Number.isInteger(concurrency) || concurrency < 1) {
    console.error(`usage: ${FRONT.join(' ')} --cell <source cell id> --arm <arm id> [--manifest q1|f6] --root <cell output>... --out <dir> --budget-ledger <file> --run-id <id> --lease-usd <n> --ledger-cap-usd <n> [--concurrency <n>] (--keyless-upstream <url> | --paid-window <unit> --window-cap-usd <n>)`);
    process.exit(2);
  }
  let keyless: string | null;
  try {
    keyless = keylessUpstreamArg(argv);
    requireRs1Window(argv, { what: 'a second judge without --keyless-upstream', keyless: !!keyless, caps: () => [{ label: '--ledger-cap-usd', usd: ledgerCap }, { label: '--lease-usd', usd: leaseUsd }] });
  } catch (e) { console.error((e as Error).message); process.exit(2); }
  try {
    const def = findCell(cellArg, undefined, one('--manifest'));
    const arm = def.arms.find(a => a.id === armArg);
    if (!arm) throw refuse({ code: 'USAGE', message: `cell ${def.id} has no arm ${armArg}`, why: 'the second judge grades one arm\'s cell', fix: { next: 'run', argv: ['bun', 'eval/runner/q1/cell.ts', 'show', '--cell', def.id] } });
    if (isBg1Benchmark(def.benchmark)) requireBg1Window(argv, { what: `the BG1 second judge on ${def.id}`, keyless: !!keyless, caps: () => [{ label: '--ledger-cap-usd', usd: ledgerCap }, { label: '--lease-usd', usd: leaseUsd }] });
    const out = resolve(outArg);
    const prepared = prepareSecondJudge(def, arm, { roots, out, keyless: !!keyless });
    const keys = keyless ? keylessKeys() : { ...process.env };
    const [cellToken, controlToken] = [randomUUID(), randomUUID()];
    Object.assign(process.env, { SHOOTOUT_CELL_TOKEN: cellToken, SHOOTOUT_PROXY_CONTROL_TOKEN: controlToken });
    const lease = openRereadLease({ runId, leaseUsd, ledgerPath: resolve(ledger), capUsd: ledgerCap, runner: 'q1-second-judge' });
    const usageLog = join(out, 'usage.ndjson');
    const proxy = new MeteringProxy({ ...(keyless ? { upstream: keylessUpstream(keyless) } : {}), cellToken, controlToken,
      policy: { lease, usageLog, env: keys, routeCaps: { caps: { ...DEFAULT_ROUTE_CAPS }, slots: { ...DEFAULT_ROUTE_CLASSES }, defaultClass: 'extraction' } } });
    proxy.start();
    try {
      const res = await runSecondJudge(prepared, { providerProxy: `http://127.0.0.1:${proxy.port}`, concurrency, lease: { usd: leaseUsd, usageLog } });
      const r = res.receipt as { counts: unknown; comparison: unknown; trigger: unknown; spend: unknown; lease: unknown };
      console.log(JSON.stringify({ cell: res.cell_id, status: res.status, stopped: res.stopped, keyless: !!keyless, trigger: r.trigger, counts: r.counts, comparison: r.comparison, spend: r.spend, lease: r.lease }, null, 2));
      process.exitCode = res.status === 'complete' ? 0 : 4;
    } finally {
      proxy.stop();
      lease.close();
    }
  } catch (e) {
    if (e instanceof ScoreboardError) { process.stderr.write(renderMessage(e.op) + '\n'); process.exit(exitCodeOf(e.op)); }
    console.error((e as Error).message);
    process.exit(2);
  }
}

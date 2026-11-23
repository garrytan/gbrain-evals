/**
 * BG1-C's judge check (R78; preregistration docs/benchmarks/2026-11-19-changing-facts-confirmation-preregistration.md,
 * "Readers and judges" and "Harness" item 4): is claude-opus-5-5 good enough to gate BG1-C's new reader, gpt-6.2-sol,
 * checked against gemini-3.8-flash on public dev answers before any sealed spend. BG1's own check
 * (eval/runner/bg1/judge-check.ts) stands for its judges and is not changed; this one reuses its statistics and its
 * stale-grade key.
 *
 *   bun eval/runner/bg1/bg1c-judge-check.ts plan   --dev-run <dir> --dev-run <dir> --dev-run <dir> --out <dir>
 *   bun eval/runner/bg1/bg1c-judge-check.ts run    --dev-run <dir> --dev-run <dir> --dev-run <dir> --out <dir> --budget-ledger <file>
 *                                                  --run-id <id> --lease-usd <n> --ledger-cap-usd <n> [--seed <n>]
 *                                                  (--keyless-upstream <url> | --paid-window <unit> --window-cap-usd <n>)
 *   bun eval/runner/bg1/bg1c-judge-check.ts report --out <dir>
 *
 *   Sources   three runs of BG1's dev loop (eval/runner/bg1/dev-loop.ts run): gbrain's (its run.json names a gbrain
 *             commit and no overlay) and one comparator run each of ext-memory-bank and ext-extract-first (run.json
 *             `system`). From each run, the world outputs that stage bg1-dev-04 to bg1-dev-13 under the row's
 *             bg1-dev-extra cell, every one of the ten worlds staged. A paid check takes only runs whose run.json names
 *             their paid window, and every source's run-config.json must record the dev worlds this check loads and
 *             grades against (loadBg1Dev on the 17 extra worlds at the dev world end), so a paid check never re-reads
 *             contexts packed from the template fixtures.
 *   Re-reads  gpt-6.2-sol reads every frozen context of the three rows' arms on the ten worlds byte for byte
 *             (reread-cell.ts prepareReread and runReread, the arm's schedule narrowed to the ten worlds' 640
 *             questions; 1,920 contexts in all), one re-read --out per row under <out>/rereads/<row>. Each answer is
 *             graded as a counted BG1-C gpt-6.2-sol row is: by bg1JudgeOf(gpt-6.2-sol), claude-opus-5-5, alone, in the
 *             gating view at PER_READER_JUDGE_SETTINGS on the bg1-dev instrument, with no Gemini view. The dev arms'
 *             judge map (definitions.ts BG1_JUDGE_BY_READER) names gpt-6.1-sol and not gpt-6.2-sol, so the judge is
 *             named here and passed as reread-cell.ts's `gating` option; the shared map and BG1's cells are untouched.
 *   Pool      stratified by row and by Opus's grade (the class): every answer Opus graded wrong, and as many graded
 *             right, drawn row by row (each row as many right answers as it has wrong ones, in a seeded order; a row
 *             short of right answers is made up from the other rows' rest). Answers Opus did not grade (no context, a
 *             reader error, a judge error) stay out and are counted. pool.json in --out holds the seed and the pool.
 *   Grading   gemini-3.8-flash grades every pool item as BG1 ran its canonical judge (the bg1-dev instrument's own
 *             request, descriptive view), through the judge cache and the same lease, resumable. Every grade records
 *             the pool's key (judge-check.ts poolSha256: the seed, the instrument, the pool with each item's Opus grade,
 *             and each item's question and gold), and a run or report whose key or item text differs from a grade in
 *             --out exits 2 before it writes pool.json.
 *   Gates     Cohen's kappa between Gemini and Opus over the items both graded, at least 0.6; at least 40 items they
 *             agree on; at least 15 agreed items in each class. Any failure exits 3 (JUDGE_CHECK_STOP) with every
 *             number on stdout for GBEV-3, and no counted BG1-C cell launches until a paid check passes. report.json
 *             carries no answer text and no dollar field; a keyless rehearsal or an --out with no marker exits 4
 *             (JUDGE_CHECK_NOT_PAID), and so does a run that stops before every grade is in (BG1C_JUDGE_CHECK_PARTIAL;
 *             rerun it on the same --out with a fresh --run-id).
 *   Estimate  plan checks every source and prints the paid estimate: each frozen context read by gpt-6.2-sol at its
 *             list price (budget-ledger.ts chatPrice) under BG1's token model with gpt-6.1-sol's token parameters, as
 *             the preregistration's budget line prices it; each Opus grade at BG1's measured dollars per call; and at
 *             most one Gemini grade per context at BG1's measured canonical rate.
 *   Window    run spends real keys only inside a granted paid window: without --keyless-upstream it needs --paid-window
 *             and --window-cap-usd, its --ledger-cap-usd and --lease-usd never exceed the window cap, and it exits 2
 *             before any lease, proxy or output otherwise. A keyless run blanks every provider key first, and plan and
 *             report send nothing. The dev questions load from the template fixtures only for run --keyless-upstream,
 *             or a plan or report on an --out whose upstream.json marks a keyless rehearsal.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { chatPrice } from '../budget-ledger.ts';
import { DecideError } from '../decisions/errors.ts';
import { loadBg1Dev, type Corpus, type MemoryQuestion } from '../memory-qa/corpus.ts';
import { BG1_CANONICAL_JUDGE, instrumentFor, type Instrument } from '../memory-qa/instruments.ts';
import { ChatClient, judgeAnswer, type ChatLike } from '../memory-qa/qa-v2.ts';
import { readRecords, sha256 } from '../memory-qa/records.ts';
import { DEFAULT_ROUTE_CAPS, keylessKeys, keylessUpstream, MeteringProxy, usageSplit } from '../metering-proxy.ts';
import { requireRs1Window, WindowRefusal } from '../paid-arm.ts';
import { claimOut, keylessUpstreamArg } from '../q1/calibration-cell.ts';
import { frontierInstrumentId, gatherStaging, metering, onSlot, type MeterLine, type Metering } from '../q1/cell.ts';
import { ASSUMPTIONS, BG1_MEASURED, bg1JudgeOf, PER_READER_JUDGE_SETTINGS, type ArmDefinition, type CellDefinition } from '../q1/cells/definitions.ts';
import { openRereadLease, prepareReread, rereadArm, rereadCellId, runReread, verifySources } from '../q1/reread-cell.ts';
import { exitCodeOf, renderMessage, ScoreboardError } from '../q1/scoreboard-errors.ts';
import { DEFAULT_ROUTE_CLASSES } from '../shootout-cell.ts';
import { seededRandom } from '../stats/paired.ts';
import { cellRoots, comparatorCell, COMPARATORS, devCell, DEV_WORLD_END, DevLoopRefusal, EXTRA_WORLDS, type Comparator } from './dev-loop.ts';
import { cohenKappa, gradeOf, KAPPA_GATE, MIN_LABELLED, MIN_PER_CLASS, poolSha256, PROVIDER_KEYS, r4, rate, readGraded, shuffle, staleGrades, type Grade } from './judge-check.ts';
import { BG1_BENCHMARK_DEV } from './types.ts';

export const BG1C_JUDGE_CHECK_SCHEMA = 'gbrain-evals/bg1c-judge-check/v1';
export const BG1C_READER = 'openai:gpt-6.2-sol';
/** gpt-6.2-sol's gating judge, BG1's family rule (claude-opus-5-5). */
export const BG1C_GATING_JUDGE = bg1JudgeOf(BG1C_READER);
export const BG1C_SECOND_JUDGE = BG1_CANONICAL_JUDGE;
export const BG1C_SEED = 20261119;
/** The ten public dev worlds the check re-reads: bg1-dev-04 to bg1-dev-13. */
export const BG1C_WORLDS: readonly string[] = EXTRA_WORLDS.slice(0, 10);
export const BG1C_ROWS = ['gbrain-defaults', ...COMPARATORS] as const;
export type Bg1cRow = typeof BG1C_ROWS[number];
/** The token parameters the preregistration's budget line reads gpt-6.2-sol with: gpt-6.1-sol's, in BG1's token model. */
export const ESTIMATE_TOKEN_READER = 'openai:gpt-6.1-sol';
const FRONT = 'bun eval/runner/bg1/bg1c-judge-check.ts';

export class Bg1cRefusal extends Error {}

// ─── Sources ─────────────────────────────────────────────────────────

export interface DevRun { dir: string; row: Bg1cRow; gbrain_sha: string | null; paid_window: string | null }

/** A dev-loop run's row, from its run.json: a comparator run names its system, gbrain's run its commit and no overlay. */
export function devRunOf(dir: string): DevRun {
  const file = join(dir, 'run.json');
  if (!existsSync(file)) throw new Bg1cRefusal(`${dir} has no run.json, so it is not a run of BG1's dev loop`);
  const run = JSON.parse(readFileSync(file, 'utf8')) as { system?: string; gbrain_sha?: string; overlay?: unknown; paid_window?: string };
  if (run.system !== undefined && !(COMPARATORS as readonly string[]).includes(run.system)) throw new Bg1cRefusal(`${dir} is a run of ${run.system}, not of ${COMPARATORS.join(' or ')}`);
  if (run.system === undefined && (!run.gbrain_sha || run.overlay !== undefined)) throw new Bg1cRefusal(`${dir}'s run.json names neither a comparator nor a gbrain commit run without an overlay`);
  return { dir, row: (run.system ?? 'gbrain-defaults') as Bg1cRow, gbrain_sha: run.gbrain_sha ?? null, paid_window: run.paid_window ?? null };
}

/** A row's bg1-dev-extra cell and its arm, the arm's schedule narrowed to the ten worlds' questions. */
export function rowArm(run: DevRun, corpus: Corpus): { def: CellDefinition; arm: ArmDefinition } {
  const def = run.row === 'gbrain-defaults' ? devCell(run.gbrain_sha!, {}, BG1C_WORLDS[0]) : comparatorCell(run.row as Comparator, BG1C_WORLDS[0]);
  const ids = corpus.questions.filter(q => BG1C_WORLDS.includes(q.conversation)).map(q => q.id);
  return { def, arm: { ...rereadArm(def, def.arms[0].id), questions: { kind: 'ids', ids } } };
}

/** The staging roots (runs/<cell id>) in a dev run that stage any of the ten worlds; refuses when one of them is staged nowhere. */
export function rowSources(run: DevRun, def: CellDefinition): string[] {
  const base = existsSync(join(run.dir, 'worlds')) ? join(run.dir, 'worlds') : run.dir;
  const staged = cellRoots(base).filter(r => existsSync(join(r, 'runs', def.id))).map(r => ({ root: r, worlds: [...gatherStaging(def.id, [r]).keys()] }))
    .filter(s => s.worlds.some(w => BG1C_WORLDS.includes(w)));
  const missing = BG1C_WORLDS.filter(w => !staged.some(s => s.worlds.includes(w)));
  if (missing.length) throw new Bg1cRefusal(`${run.dir} stages no ${def.id} output for ${missing.join(', ')}, and the check re-reads ${BG1C_WORLDS[0]} to ${BG1C_WORLDS.at(-1)}`);
  return staged.map(s => join(s.root, 'runs', def.id));
}

/** Why some of a row's sources did not read the dev worlds this check loads (their run-config.json dataset), or null. */
export function datasetProblem(sources: readonly string[], arm: Pick<ArmDefinition, 'cell_id'>, corpus: Pick<Corpus, 'source'>): string | null {
  const want = JSON.stringify(corpus.source);
  const off = sources.filter(s => { const f = join(dirname(dirname(s)), 'cells', arm.cell_id, 'run-config.json'); return !existsSync(f) || JSON.stringify((JSON.parse(readFileSync(f, 'utf8')) as { dataset?: unknown }).dataset) !== want; });
  return off.length ? `${off.length} of ${sources.length} ${arm.cell_id} sources did not read the dev worlds this check grades against (${corpus.source.name}, ${corpus.source.files.length} files), first ${off[0]}` : null;
}

export interface RowPlan { run: DevRun; def: CellDefinition; arm: ArmDefinition; sources: string[] }

/** One plan per row from the three dev runs; a paid check refuses a run whose run.json names no paid window. */
export function planRows(dirs: readonly string[], corpus: Corpus, keyless: boolean): RowPlan[] {
  const runs = dirs.map(devRunOf);
  const counts = BG1C_ROWS.map(row => [row, runs.filter(r => r.row === row).length] as const).filter(([, n]) => n !== 1);
  if (counts.length) throw new Bg1cRefusal(`--dev-run takes one run of each row (${BG1C_ROWS.join(', ')}); ${counts.map(([row, n]) => `${row} has ${n}`).join(', ')}`);
  const unpaid = keyless ? [] : runs.filter(r => !r.paid_window);
  if (unpaid.length) throw new Bg1cRefusal(`a paid check re-reads only dev-loop runs whose run.json names their paid window: ${unpaid.map(r => r.dir).join(', ')}`);
  return BG1C_ROWS.map(row => {
    const run = runs.find(r => r.row === row)!;
    const { def, arm } = rowArm(run, corpus);
    const sources = rowSources(run, def);
    const problem = datasetProblem(sources, arm, corpus);
    if (problem) throw new Bg1cRefusal(problem);
    return { run, def, arm, sources };
  });
}

/** The 17 extra dev worlds' questions at the dev world end, as the dev loop's cells loaded them. */
export const loadDevWorlds = (keyless: boolean): Corpus => loadBg1Dev({ only: new Set(EXTRA_WORLDS), worldEnd: DEV_WORLD_END, keyless });

// ─── Estimate ────────────────────────────────────────────────────────

const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * The paid estimate for the given frozen contexts (each at its arm's token budget): gpt-6.2-sol's reads at chatPrice's
 * list price with gpt-6.1-sol's token parameters, Opus's grades at BG1's measured dollars per call, and Gemini's pool at
 * most one grade per context at BG1's measured canonical rate. Dollars, to the cent.
 */
export function bg1cEstimate(rows: ReadonlyArray<{ contexts: number; budget: number }>) {
  const price = chatPrice(BG1C_READER);
  if (!price) throw new Bg1cRefusal(`no list price for ${BG1C_READER} in budget-ledger.ts CHAT_PRICE_OVERRIDES`);
  const by = (t: Record<string, number>) => t[ESTIMATE_TOKEN_READER] ?? t.default;
  const read = (budget: number) => ((budget * by(ASSUMPTIONS.reader_tokens_per_cl100k) + by(ASSUMPTIONS.reader_input_overhead_tokens)) * price.input + by(ASSUMPTIONS.reader_output_tokens) * price.output) / 1e6;
  const contexts = rows.reduce((s, r) => s + r.contexts, 0);
  const reads = rows.reduce((s, r) => s + r.contexts * read(r.budget), 0);
  const opus = contexts * BG1_MEASURED.judge_usd_per_call[BG1C_GATING_JUDGE], gemini = contexts * BG1_MEASURED.canonical_judge_usd_per_call;
  return { contexts, reads_usd: r2(reads), opus_grades_usd: r2(opus), reads_and_opus_usd: r2(reads + opus), gemini_pool_at_most_usd: r2(gemini), total_at_most_usd: r2(reads + opus + gemini),
    basis: `${BG1C_READER} at its list price with ${ESTIMATE_TOKEN_READER}'s token parameters (definitions.ts ASSUMPTIONS); ${BG1C_GATING_JUDGE} at BG1's measured $${BG1_MEASURED.judge_usd_per_call[BG1C_GATING_JUDGE]} a call; ${BG1C_SECOND_JUDGE} at most one call per context at $${BG1_MEASURED.canonical_judge_usd_per_call}` };
}

// ─── Pool ────────────────────────────────────────────────────────────

/** One re-read answer with Opus's gating grade (null when it has none) and whether that grade was a truncated reply. */
export interface GatedAnswer { answer_id: string; row: Bg1cRow; question_id: string; conversation: string; text: string; outcome: string; opus: number | null; truncated: boolean }
export interface Bg1cItem { id: string; row: Bg1cRow; question_id: string; conversation: string; text: string; text_sha256: string; opus: 0 | 1 }

/** A row's re-read answers in <dir> (answers.ndjson, judgments.ndjson), each with Opus's gating grade. */
export function gatedAnswers(dir: string, row: Bg1cRow, instrument: Pick<Instrument, 'id'>): GatedAnswer[] {
  const id = frontierInstrumentId(instrument.id, BG1C_GATING_JUDGE);
  const grades = new Map(readRecords(join(dir, 'judgments.ndjson'), 'judgment').filter(j => j.instrument_id === id && j.judge === BG1C_GATING_JUDGE && j.judge_replicate === 0).map(j => [j.answer_id, gradeOf(j)]));
  return readRecords(join(dir, 'answers.ndjson'), 'answer').map(a => ({ answer_id: a.answer_id, row, question_id: a.question_id, conversation: a.conversation, text: a.text, outcome: a.outcome,
    opus: grades.get(a.answer_id)?.score ?? null, truncated: grades.get(a.answer_id)?.truncated === true }));
}

/**
 * The pool, stratified by row and by Opus's grade: every answer graded wrong, and as many graded right, drawn row by row
 * in a seeded order, with any row's shortfall of right answers made up from the other rows' rest. Answers without a
 * grade stay out.
 */
export function buildBg1cPool(answers: readonly GatedAnswer[], seed = BG1C_SEED): Bg1cItem[] {
  const rand = seededRandom(seed);
  const item = (a: GatedAnswer): Bg1cItem => ({ id: `bg1c-${a.answer_id}`, row: a.row, question_id: a.question_id, conversation: a.conversation, text: a.text, text_sha256: sha256(a.text), opus: a.opus! >= 1 ? 1 : 0 });
  const graded = answers.filter(a => a.opus !== null).sort((a, b) => (a.answer_id < b.answer_id ? -1 : 1));
  const pool: Bg1cItem[] = [], rest: GatedAnswer[] = [];
  for (const row of [...new Set(graded.map(a => a.row))].sort()) {
    const wrong = shuffle(graded.filter(a => a.row === row && a.opus! < 1), rand), right = shuffle(graded.filter(a => a.row === row && a.opus! >= 1), rand);
    pool.push(...wrong.map(item), ...right.slice(0, wrong.length).map(item));
    rest.push(...right.slice(wrong.length));
  }
  const short = pool.filter(i => i.opus === 0).length - pool.filter(i => i.opus === 1).length;
  return [...pool, ...shuffle(rest, rand).slice(0, short).map(item)];
}

/** Gemini's grades in a judgments file, by pool item. */
export const geminiGrades = (file: string): Record<string, Grade> => Object.fromEntries(readGraded(file).filter(r => r.judge === BG1C_SECOND_JUDGE).map(r => [r.item, gradeOf(r)]));

/**
 * Gemini grades every pool item not yet graded, as BG1 ran its canonical judge (the instrument's own request,
 * descriptive view); each grade records the pool's key. Grades of another pool refuse before any call; a failed or
 * refused call stops the grading, and `stopped` says why.
 */
export async function gradeWithGemini(pool: readonly Bg1cItem[], questions: ReadonlyMap<string, MemoryQuestion>, client: ChatLike, meter: Metering, instrument: Instrument, out: string, seed: number): Promise<{ grades: Record<string, Grade>; stopped: string | null }> {
  const file = join(out, 'judgments.ndjson');
  const stale = staleGrades(file, pool, seed, questions, instrument);
  if (stale) throw new Bg1cRefusal(stale);
  const key = poolSha256(pool, seed, questions, instrument);
  const done = new Set(Object.keys(geminiGrades(file)));
  for (const i of pool) {
    if (done.has(i.id)) continue;
    const r = await meter.around('judge', `judge:${i.id.slice(0, 21)}:${BG1C_SECOND_JUDGE}`, 'judge', () => judgeAnswer(client, instrument, questions.get(i.question_id)!, i.text, { judge: BG1C_SECOND_JUDGE, judgeReplicate: 0, view: 'descriptive' }));
    if (r.error !== undefined) return { grades: geminiGrades(file), stopped: `${BG1C_SECOND_JUDGE} on ${i.id}: ${String((r.error as Error).message).slice(0, 200)}` };
    appendFileSync(file, JSON.stringify({ item: i.id, answer_id: i.text_sha256, pool_sha256: key, seed, ...r.value! }) + '\n');
  }
  return { grades: geminiGrades(file), stopped: null };
}

// ─── Gates ───────────────────────────────────────────────────────────

/** Floating-point slack on the kappa line, so a kappa of exactly 0.6 passes whatever its rounding. */
const KAPPA_SLACK = 1e-9;
const countBy = <T,>(xs: readonly T[], key: (x: T) => string) => { const m: Record<string, number> = {}; for (const x of xs) m[key(x)] = (m[key(x)] ?? 0) + 1; return m; };

/** The check's numbers and gates over the pool, Gemini's grades and every re-read answer. */
export function analyzeBg1c(pool: readonly Bg1cItem[], gemini: Readonly<Record<string, Grade>>, answers: readonly GatedAnswer[]) {
  const said = (i: Bg1cItem) => { const g = gemini[i.id]; return g && g.score !== null ? g.score >= 1 : null; };
  const both = pool.filter(i => said(i) !== null);
  const agree = (i: Bg1cItem) => said(i) === (i.opus === 1);
  const k = cohenKappa(both.map(i => said(i)!), both.map(i => i.opus === 1));
  const agreed = both.filter(agree);
  const right = agreed.filter(i => i.opus === 1).length, wrong = agreed.length - right;
  const gates = [
    { gate: 'gemini_opus_kappa', value: r4(k.kappa), line: KAPPA_GATE, pass: k.kappa !== null && k.kappa >= KAPPA_GATE - KAPPA_SLACK },
    { gate: 'agreed_items', value: agreed.length, line: MIN_LABELLED, pass: agreed.length >= MIN_LABELLED },
    { gate: 'agreed_per_class', value: Math.min(right, wrong), line: MIN_PER_CLASS, pass: right >= MIN_PER_CLASS && wrong >= MIN_PER_CLASS },
  ];
  const rows = Object.fromEntries(BG1C_ROWS.map(row => {
    const a = answers.filter(x => x.row === row), graded = a.filter(x => x.opus !== null), p = pool.filter(i => i.row === row), pb = both.filter(i => i.row === row);
    const rk = cohenKappa(pb.map(i => said(i)!), pb.map(i => i.opus === 1));
    return [row, { answers: a.length, outcomes: countBy(a, x => x.outcome), opus_graded: graded.length, opus_truncated: a.filter(x => x.truncated).length,
      opus_right: rate(graded.filter(x => x.opus! >= 1).length, graded.length), pool: { wrong: p.filter(i => i.opus === 0).length, right: p.filter(i => i.opus === 1).length },
      gemini_graded: pb.length, agreement: rate(pb.filter(agree).length, pb.length), kappa: r4(rk.kappa) }];
  }));
  return {
    schema: BG1C_JUDGE_CHECK_SCHEMA, reader: BG1C_READER, gating_judge: BG1C_GATING_JUDGE, second_judge: BG1C_SECOND_JUDGE, worlds: [...BG1C_WORLDS],
    answers: { total: answers.length, opus_graded: answers.filter(x => x.opus !== null).length, opus_ungraded: answers.filter(x => x.opus === null).length },
    pool: { items: pool.length, wrong: pool.filter(i => i.opus === 0).length, right: pool.filter(i => i.opus === 1).length },
    gemini: { graded: both.length, ungraded: pool.length - both.length },
    inter_judge: { kappa: r4(k.kappa), ci95: k.ci95?.map(x => r4(x)!) ?? null, n: k.n, agreement: rate(agreed.length, both.length),
      table: { both_right: right, both_wrong: wrong, gemini_right_opus_wrong: both.filter(i => said(i) && i.opus === 0).length, gemini_wrong_opus_right: both.filter(i => !said(i) && i.opus === 1).length } },
    agreed: { items: agreed.length, right, wrong }, rows, gates, stop: gates.some(g => !g.pass),
  };
}
export type Bg1cReport = ReturnType<typeof analyzeBg1c>;

// ─── Command line ────────────────────────────────────────────────────

const rereadDir = (out: string, row: Bg1cRow) => join(out, 'rereads', row);

/** Each row's re-read cell directory in --out: the one cell its re-read --out holds. */
function rereadCells(out: string): Array<{ row: Bg1cRow; dir: string }> {
  return BG1C_ROWS.map(row => {
    const cells = join(rereadDir(out, row), 'cells');
    const dirs = existsSync(cells) ? readdirSync(cells).sort().filter(d => d.endsWith(rereadCellId('', BG1C_READER))) : [];
    if (dirs.length !== 1) throw new Bg1cRefusal(`${cells} holds ${dirs.length} ${BG1C_READER} re-reads, not one`);
    return { row, dir: join(cells, dirs[0]) };
  });
}

const answersIn = (out: string, instrument: Instrument) => rereadCells(out).flatMap(c => gatedAnswers(c.dir, c.row, instrument));
const usage = `usage: ${FRONT} plan --dev-run <dir> (x3) --out <dir> | run --dev-run <dir> (x3) --out <dir> --budget-ledger <file> --run-id <id> --lease-usd <n> --ledger-cap-usd <n> [--seed <n>] (--keyless-upstream <url> | --paid-window <unit> --window-cap-usd <n>) | report --out <dir>`;

export async function main(argv: string[]): Promise<number> {
  const mode = argv[0];
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const dirs = argv.flatMap((a, i) => (a === '--dev-run' && argv[i + 1] ? [resolve(argv[i + 1])] : []));
  const out = one('--out') ? resolve(one('--out')!) : null;
  if (!['plan', 'run', 'report'].includes(mode) || !out || (mode !== 'report' && dirs.length !== BG1C_ROWS.length)) { console.error(usage); return 2; }
  const seed = one('--seed') ? Number(one('--seed')) : BG1C_SEED;
  const [ledger, runId, leaseUsd, cap] = [one('--budget-ledger'), one('--run-id'), Number(one('--lease-usd')), Number(one('--ledger-cap-usd'))];
  let keyless: string | null = null;
  try { keyless = mode === 'run' ? keylessUpstreamArg(argv) : null; } catch (e) { console.error((e as Error).message); return 2; }
  if (keyless || mode !== 'run') for (const k of PROVIDER_KEYS) delete process.env[k];
  if (mode === 'run') {
    if (!ledger || !runId || !(leaseUsd > 0) || !(cap > 0) || !Number.isInteger(seed)) { console.error('run needs --budget-ledger, --run-id, --lease-usd and --ledger-cap-usd, and an integer --seed when given'); return 2; }
    try { requireRs1Window(argv, { what: 'a BG1-C judge check without --keyless-upstream', keyless: !!keyless, caps: () => [{ label: '--ledger-cap-usd', usd: cap }, { label: '--lease-usd', usd: leaseUsd }] }); }
    catch (e) { if (!(e instanceof WindowRefusal)) throw e; console.error(e.message); return 2; }
  }
  const marker = join(out, 'upstream.json');
  const keylessOut = existsSync(marker) && (JSON.parse(readFileSync(marker, 'utf8')) as { keyless?: unknown }).keyless === true;
  const loadKeyless = mode === 'run' ? !!keyless : keylessOut;
  const instrument = instrumentFor(BG1_BENCHMARK_DEV);
  let corpus: Corpus, rows: RowPlan[] = [];
  try {
    corpus = loadDevWorlds(loadKeyless);
    if (mode !== 'report') rows = planRows(dirs, corpus, loadKeyless);
  } catch (e) { if (!(e instanceof DecideError || e instanceof Bg1cRefusal || e instanceof DevLoopRefusal || e instanceof ScoreboardError)) throw e; console.error(e instanceof ScoreboardError ? renderMessage(e.op) : e.message); return 2; }
  const byId = new Map(corpus.questions.map(q => [q.id, q]));

  if (mode === 'plan') {
    const checked = rows.map(r => ({ r, v: verifySources(r.def, r.arm, r.sources, corpus, BG1C_READER) }));
    const bad = checked.filter(c => !c.v.plan);
    if (bad.length) { console.error(`the sources do not verify, so nothing would be re-read: ${bad.map(c => `${c.r.arm.cell_id}: ${c.v.verify.problems.join('; ')}`).join('; ')}`); return 2; }
    const counts = checked.map(c => ({ row: c.r.run.row, cell: c.r.arm.cell_id, sources: c.r.sources.length, contexts: c.v.verify.counts.questions_with_context, without_context: c.v.verify.counts.questions_without_context, budget: c.r.arm.budget ?? 8000 }));
    console.log(JSON.stringify({ reader: BG1C_READER, gating_judge: BG1C_GATING_JUDGE, second_judge: BG1C_SECOND_JUDGE, worlds: BG1C_WORLDS, rows: counts, estimate: bg1cEstimate(counts) }, null, 2));
    return 0;
  }

  if (mode === 'run') {
    if (!existsSync(marker) && ['rereads', 'judgments.ndjson', 'cache'].some(f => existsSync(join(out, f)))) { console.error(`${out} holds re-reads, judgments or a cache but no keyless/paid marker; give this run a fresh --out`); return 2; }
    mkdirSync(out, { recursive: true });
    let stopped: string | null = null;
    try {
      claimOut(out, !!keyless, 'bg1c judge-check');
      const prepared = rows.map(r => prepareReread(r.def, r.arm, { sources: r.sources, reader: BG1C_READER, out: rereadDir(out, r.run.row), keyless: !!keyless, gating: BG1C_GATING_JUDGE }, { corpus }));
      const [cellToken, controlToken] = [randomUUID(), randomUUID()];
      Object.assign(process.env, { SHOOTOUT_CELL_TOKEN: cellToken, SHOOTOUT_PROXY_CONTROL_TOKEN: controlToken });
      const lease = openRereadLease({ runId: runId!, leaseUsd, ledgerPath: resolve(ledger!), capUsd: cap, runner: 'bg1c-judge-check' });
      const usageLog = join(out, 'usage.ndjson');
      const proxy = new MeteringProxy({ ...(keyless ? { upstream: keylessUpstream(keyless) } : {}), cellToken, controlToken,
        policy: { lease, usageLog, env: keyless ? keylessKeys() : { ...process.env },
          routeCaps: { caps: { ...DEFAULT_ROUTE_CAPS, [`judge@${BG1C_GATING_JUDGE}`]: PER_READER_JUDGE_SETTINGS.max_tokens }, slots: { ...DEFAULT_ROUTE_CLASSES }, defaultClass: 'extraction' } } });
      proxy.start();
      try {
        const url = `http://127.0.0.1:${proxy.port}`;
        for (const p of prepared) {
          const res = await runReread(p, { providerProxy: url, lease: { usd: leaseUsd, usageLog } });
          if (res.status !== 'complete') { stopped = `${res.cell_id} is ${res.status}${res.stopped ? ` (${res.stopped})` : ''}`; break; }
        }
        if (!stopped) {
          const pool = buildBg1cPool(answersIn(out, instrument), seed);
          const stale = staleGrades(join(out, 'judgments.ndjson'), pool, seed, byId, instrument);
          if (stale) throw new Bg1cRefusal(stale);
          writeFileSync(join(out, 'pool.json'), JSON.stringify({ seed, pool }, null, 2) + '\n');
          const meter = metering(url, { meter: (m: MeterLine) => appendFileSync(join(out, 'meters.ndjson'), JSON.stringify(m) + '\n') }, process.env);
          stopped = (await gradeWithGemini(pool, byId, onSlot(new ChatClient(join(out, 'cache', 'qa')), meter, 'judge'), meter, instrument, out, seed)).stopped;
        }
      } finally { proxy.stop(); lease.close(); }
    } catch (e) {
      if (e instanceof ScoreboardError) { process.stderr.write(renderMessage(e.op) + '\n'); return exitCodeOf(e.op); }
      if (e instanceof Bg1cRefusal) { console.error(e.message); return 2; }
      throw e;
    }
    if (stopped) { process.stderr.write(`BG1C_JUDGE_CHECK_PARTIAL: ${stopped}; rerun on the same --out with a fresh --run-id to resume\n`); return 4; }
  }

  let report: Bg1cReport;
  try {
    const poolFile = join(out, 'pool.json');
    if (!existsSync(poolFile)) throw new Bg1cRefusal(`${out} holds no pool.json; run the check first`);
    const saved = JSON.parse(readFileSync(poolFile, 'utf8')) as { seed: number; pool: Bg1cItem[] };
    const incomplete = rereadCells(out).filter(c => (JSON.parse(readFileSync(join(c.dir, 'receipt.json'), 'utf8')) as { run_status?: string }).run_status !== 'complete');
    if (incomplete.length) throw new Bg1cRefusal(`the ${incomplete.map(c => c.row).join(', ')} re-read in ${out} is not complete`);
    const answers = answersIn(out, instrument);
    if (JSON.stringify(buildBg1cPool(answers, saved.seed)) !== JSON.stringify(saved.pool)) throw new Bg1cRefusal(`${poolFile} is not the pool the re-reads in ${out} give at seed ${saved.seed}`);
    const stale = staleGrades(join(out, 'judgments.ndjson'), saved.pool, saved.seed, byId, instrument);
    if (stale) throw new Bg1cRefusal(stale);
    report = analyzeBg1c(saved.pool, geminiGrades(join(out, 'judgments.ndjson')), answers);
  } catch (e) { if (!(e instanceof Bg1cRefusal)) throw e; console.error(e.message); return 2; }
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  if (existsSync(join(out, 'usage.ndjson'))) console.log(JSON.stringify({ spend: usageSplit(join(out, 'usage.ndjson')), source: 'metering proxy usage log (provider usage fields)' }));
  console.log(report.gates.map(g => `${g.gate} ${g.value ?? 'n/a'} (line ${g.line}) ${g.pass ? 'pass' : 'FAIL'}`).join('\n'));
  const keylessRun = existsSync(marker) ? (JSON.parse(readFileSync(marker, 'utf8')) as { keyless?: unknown }).keyless === true : null;
  if (report.stop) {
    console.log(JSON.stringify(report, null, 2));
    process.stderr.write(`JUDGE_CHECK_STOP: ${report.gates.filter(g => !g.pass).map(g => g.gate).join(', ')}; no counted BG1-C cell launches, and every number above goes to GBEV-3\n`);
    return 3;
  }
  if (keylessRun !== false) { process.stderr.write(`JUDGE_CHECK_NOT_PAID: ${keylessRun ? 'a keyless rehearsal' : 'no keyless/paid marker in --out'}; only a paid check's report passes\n`); return 4; }
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

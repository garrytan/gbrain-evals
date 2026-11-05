/**
 * GST-1365's judge-robustness check (docs/benchmarks/2026-11-04-gst-1365-judge-robustness-preregistration.md): every
 * answer behind F6's and Q1's published system comparisons is judged again by a frontier judge from a family that never
 * grades its own readers, a third family referees the disagreements, and known-answer controls built from BEAM's gold
 * answers test every judge. rejudge-rule.ts holds the decision rule; this file loads, judges and reports.
 *
 *   bun eval/runner/q1/rejudge-systems.ts plan <roots> --out <dir> [--rates-from <out>]...
 *   bun eval/runner/q1/rejudge-systems.ts cut --out <dir> --through <1-5> --reason <text>
 *   bun eval/runner/q1/rejudge-systems.ts judge --stratum A|B|C|D [--limit <n>] <roots> --out <dir> <lease>
 *   bun eval/runner/q1/rejudge-systems.ts reuse-check --judge <provider:model> [--n 100] <roots> --out <dir> <lease>
 *   bun eval/runner/q1/rejudge-systems.ts referee [--limit <n>] <roots> --out <dir> <lease>
 *   bun eval/runner/q1/rejudge-systems.ts controls <roots> --out <dir> <lease>
 *   bun eval/runner/q1/rejudge-systems.ts summary <roots> --out <dir> [--report <dir>]
 *     <roots>: --root f6=<receipt> --root q1=<receipt> [--root second-judge=<out>]...
 *     <lease>: --budget-ledger <file> --run-id <id> --lease-usd <n> [--reserve-grant <usd>=<GBEV-3's words>]
 *              [--concurrency <n>] [--keyless-upstream <url>]
 *
 * Judges: gpt-6.1-sol grades the Claude readers' rows, claude-opus-5-5 the gpt-6.1-sol rows, and gemini-4-argon referees;
 * a same-family pair or a particle judge is refused. A frontier judgment already in custody (the receipts' own frontier
 * column with A19's redo, or a paid second-judge out) is reused when its answer id, <instrument>@<judge> id, instrument
 * sha256 and replicate 0 match and it parsed; a keyless second-judge out is refused. Every judged answer is a frozen
 * replicate-0 answer in its contrast's published cohort; a product failure scores 0 under every judge and sends nothing.
 *
 * Before any frontier number, plan and summary reproduce each published canonical contrast with scoreboard.ts's own
 * derive() and require this loader's canonical cells and contrasts to equal derive()'s. Paid subcommands run on one
 * GST-1365 ledger whose ceiling is pinned at $850 (raised only by a recorded reserve grant, never past $1,100), check
 * the instrument, attest the preregistration and check every judge key before a lease opens, and stop with
 * LEASE_EXHAUSTED (exit 4), CEILING_REACHED (exit 5, final under R71) or KEY_MISSING (exit 2). An identity file per
 * stage refuses a resume onto other answers, judges or instruments. Output is counts, means, intervals and dollars;
 * nothing is written that holds a question id.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BudgetRun, ledgerPaths, ledgerStatus } from '../budget-ledger.ts';
import { loadCorpus, type MemoryQuestion } from '../memory-qa/corpus.ts';
import { instrumentFor, PASS_THRESHOLD, type Instrument } from '../memory-qa/instruments.ts';
import { DEFAULT_MAX_ATTEMPTS, HARNESS_FAILURES, NOT_APPLICABLE, PRODUCT_FAILURES, type Outcome } from '../memory-qa/outcomes.ts';
import { ChatClient, judgeAnswer, type ChatLike } from '../memory-qa/qa-v2.ts';
import { judgmentKey, RecordLog, sha256, type AnswerRecord, type JudgmentRecord } from '../memory-qa/records.ts';
import { DEFAULT_ROUTE_CAPS, MeteringProxy, usageSplit, type UsageLine } from '../metering-proxy.ts';
import { attestPreregistration } from '../prereg.ts';
import { compatMayHaveBilled, JUDGE_PROVIDERS } from '../providers/openai-compatible.ts';
import { derive } from '../scoreboard.ts';
import { DEFAULT_ROUTE_CLASSES } from '../shootout-cell.ts';
import { claimOut, keylessUpstreamArg } from './calibration-cell.ts';
import { custodyGate, frontierInstrumentId, JUDGED, metering, type MeterLine } from './cell.ts';
import { ALL_SETS, type SetId } from './cells/definitions.ts';
import { cohorts, contrast, controls as controlStats, familyVerdict, judgeEffect, outcome, questionView, ranks, referee as refereeStats, whichJudge, wilson,
  type CellValues, type ControlRow, type Interval, type Outcome as RuleOutcome, type RankedContrast, type ReaderValue, type RefereeRow } from './rejudge-rule.ts';
import { exitCodeOf, refuse, renderMessage, ScoreboardError } from './scoreboard-errors.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const FRONT = ['bun', 'eval/runner/q1/rejudge-systems.ts'];
export const PREREGISTRATION = 'docs/benchmarks/2026-11-04-gst-1365-judge-robustness-preregistration.md';
export const LEDGER_CEILING_USD = 850;
export const RESERVE_USD = 250;
export const SOL = 'openai:gpt-6.1-sol', OPUS = 'anthropic:claude-opus-5-5', REFEREE = 'gemini:gemini-4-argon', CANONICAL = 'openai:gpt-4.1-mini';
const GEMINI_FLOOR = JUDGE_PROVIDERS.gemini.models['gemini-4-argon'].output_floor;
/** A budget stop that leaves less than this under the ceiling is CEILING_REACHED rather than LEASE_EXHAUSTED. */
const CEILING_ROOM_USD = 1;
export const frontierId = frontierInstrumentId;

const family = (model: string) => model.slice(0, model.indexOf(':'));
/** The frontier judge of a reader's rows: never the reader's own family, never particle (GST-767, GST-605). */
export function judgeFor(reader: string): string {
  const judge = family(reader) === 'anthropic' ? SOL : family(reader) === 'openai' ? OPUS : null;
  if (!judge) throw refuse({ code: 'USAGE', message: `no frontier judge is preregistered for ${reader}'s rows`, why: 'GST-1365 judges the Claude and gpt-6.1-sol readers\' rows only', fix: { next: 'report', user_message: 'drop the reader or amend the preregistration' } });
  return judge;
}
export function checkPair(judge: string, reader: string | null): void {
  if (family(judge) === 'particle') throw refuse({ code: 'USAGE', message: `${judge} never judges`, why: 'particle-1 reads but never judges a counted cell (GST-605)', fix: { next: 'report', user_message: 'use the preregistered judges' } });
  if (reader && family(judge) === family(reader)) throw refuse({ code: 'USAGE', message: `${judge} would judge ${reader}'s rows`, why: 'no model judges its own family\'s rows (GST-767)', fix: { next: 'report', user_message: 'use the preregistered judge for this reader' } });
}

export type Stratum = 'A' | 'B' | 'C' | 'D';
export interface Published { delta: number; ci95: [number, number]; cohort: number }
export interface ContrastDef { id: string; family: 'F6' | 'D8' | 'Q1'; stratum: Stratum; root: 'f6' | 'q1'; set: string; anchor: string; other: string; published: Published | null }
const P = (delta: number, lo: number, hi: number, cohort: number): Published => ({ delta: delta / 100, ci95: [lo / 100, hi / 100], cohort });
const f6 = (stratum: Stratum, set: string, other: string, published: Published | null): ContrastDef => {
  const prefix = set.toLowerCase();
  return { id: `f6:${prefix}.${other}`, family: stratum === 'D' ? 'D8' : 'F6', stratum, root: 'f6', set, anchor: `${prefix}.gbrain-defaults.f6-master.p`, other: `${prefix}.${other}`, published };
};
const q1 = (set: string, anchor: string, other: string, published: Published | null): ContrastDef => {
  const prefix = set.toLowerCase();
  return { id: `q1:${prefix}.${other}`, family: 'Q1', stratum: 'C', root: 'q1', set, anchor: `${prefix}.gbrain-defaults.shipped-defaults.${anchor}`, other: `${prefix}.${other}`, published };
};
/** Section 5's contrasts with the committed scoreboards' canonical values (points to 0.1, cohort) that the reproduction check requires; null where none is published. */
export const CONTRASTS: readonly ContrastDef[] = [
  f6('A', 'S1', 'ext-extract-first.common.component-b8000', P(2.2, -1.9, 6.1, 199)),
  f6('A', 'S1', 'ext-memory-bank.recipe.component-b8000', P(5.7, 1.6, 9.7, 199)),
  f6('A', 'S1', 'ext-verbatim-session.recipe.component-b8000', P(10.2, 3.4, 16.8, 199)),
  f6('A', 'S1', 'ext-temporal-graph.shipped-0.31.component-b8000', P(12.4, 7.1, 17.4, 199)),
  f6('A', 'S1', 'baseline-file-agent.baseline.whole-agent', null),
  f6('B', 'S2b', 'ext-extract-first.common.component-b8000', P(4.8, 2.6, 7.1, 240)),
  f6('B', 'S2b', 'ext-memory-bank.recipe.component-b8000', P(1.3, -0.9, 3.7, 240)),
  f6('B', 'S2b', 'ext-graph-pipeline.recipe.component-b8000', P(3.7, 0.3, 7.4, 240)),
  f6('B', 'S2b', 'ext-verbatim-session.recipe.component-b8000', P(6.9, 4.1, 9.9, 240)),
  f6('B', 'S2b', 'ext-temporal-graph.shipped-0.31.component-b8000', P(9.3, 5.2, 13.3, 240)),
  f6('D', 'D8', 'ext-memory-bank.recipe.component-b8000', P(3.8, 1.0, 6.7, 300)),
  f6('D', 'D8', 'ext-graph-pipeline.recipe.component-b8000', P(3.8, 1.6, 6.1, 300)),
  f6('D', 'D8', 'baseline-hybrid.baseline.component-b8000', P(4.3, 2.3, 6.5, 300)),
  q1('S1', 'component-b8000', 'ext-extract-first.common.component-b8000', P(-3.0, -8.1, 1.8, 197)),
  q1('S1', 'component-b8000', 'ext-memory-bank.recipe.component-b8000', P(0.6, -4.5, 5.2, 197)),
  q1('S1', 'component-b8000', 'ext-verbatim-session.recipe.component-b8000', P(5.1, 0.5, 9.2, 197)),
  q1('S1', 'whole-default', 'baseline-file-agent.baseline.whole-agent', P(-8.7, -16.4, -1.4, 198)),
  q1('S2b', 'component-b8000', 'ext-extract-first.common.component-b8000', P(-0.3, -3.7, 3.5, 240)),
  q1('S2b', 'component-b8000', 'baseline-file-agent.baseline.whole-agent', null),
  q1('S2a', 'component-b8000', 'ext-extract-first.common.component-b8000', P(-1.8, -6.9, 3.1, 140)),
  q1('S2a', 'component-b8000', 'baseline-file-agent.baseline.whole-agent', null),
];

/** The preregistered cut order (section 7), first to last. */
export const CUT_STEPS = ['controls on Opus and Gemini drop to 75 questions', "Q1's S2a rows", 'the D8 referee', 'the D8 census', "Q1's S2b rows"] as const;
export interface Cuts { through: number; reason: string; at: string }
export const cutContrast = (c: ContrastDef, cuts: Cuts | null) => !!cuts && ((cuts.through >= 2 && c.root === 'q1' && c.set === 'S2a') || (cuts.through >= 4 && c.stratum === 'D') || (cuts.through >= 5 && c.root === 'q1' && c.set === 'S2b'));
export const readCuts = (out: string): Cuts | null => existsSync(join(out, 'cuts.json')) ? JSON.parse(readFileSync(join(out, 'cuts.json'), 'utf8')) as Cuts : null;

// ─── Loading ─────────────────────────────────────────────────────────

interface CampaignCellLite { cell_id: string; set: string; system: string; readers: string[]; reader_replicates?: Record<string, number>; canonical_instrument: string; status: string; dir?: string; subset?: { conversations: string[] }; product_outcomes?: Array<{ reader: string; outcome: string }> }
interface CampaignLite { sets: Array<{ id: string; scheduled: Array<{ question_id: string; conversation: string }>; exclusions: Array<{ question_id: string }> }>; cells: CampaignCellLite[] }
export interface LoadedCell { def: CampaignCellLite; root: 'f6' | 'q1'; instrument: { id: string; sha256: string }; answers: AnswerRecord[]; judgments: JudgmentRecord[] }
/** distrust: judges whose reuse check failed, whose judgments from the receipts and second-judge outs are not reused (this run's own still are). */
export interface Sources { receipts: Record<'f6' | 'q1', string>; campaigns: Record<'f6' | 'q1', CampaignLite>; cells: Map<string, LoadedCell>; secondJudge: JudgmentRecord[]; out: string; own: JudgmentRecord[]; distrust: string[] }

const ndjson = <T>(path: string): T[] => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as T) : [];
const cellKey = (root: string, cell: string) => `${root}:${cell}`;
export const cellOf = (s: Sources, root: string, id: string) => s.cells.get(cellKey(root, id))!;

/** The receipts, every cell a contrast names (judgments with A19's frontier redo applied), and the paid second-judge judgments. */
export function loadSources(roots: string[], out: string): Sources {
  const named = (k: string) => roots.filter(r => r.startsWith(`${k}=`)).map(r => resolve(r.slice(k.length + 1)));
  const [f6Root] = named('f6'), [q1Root] = named('q1');
  if (!f6Root || !q1Root) throw refuse({ code: 'USAGE', message: 'GST-1365 needs --root f6=<receipt> and --root q1=<receipt>', why: 'the contrasts are F6\'s and Q1\'s published comparisons', fix: { next: 'run', argv: [...FRONT, 'plan', '--root', 'f6=<receipt>', '--root', 'q1=<receipt>', '--out', '<dir>'] } });
  const receipts = { f6: f6Root, q1: q1Root };
  const campaigns = { f6: JSON.parse(readFileSync(join(f6Root, 'campaign.json'), 'utf8')) as CampaignLite, q1: JSON.parse(readFileSync(join(q1Root, 'campaign.json'), 'utf8')) as CampaignLite };
  const cells = new Map<string, LoadedCell>();
  for (const c of CONTRASTS) for (const id of [c.anchor, c.other]) {
    if (cells.has(cellKey(c.root, id))) continue;
    const def = campaigns[c.root].cells.find(x => x.cell_id === id);
    if (!def || def.status === 'not-run') throw refuse({ code: 'INPUT_MISSING', message: `the ${c.root} receipt has no published cell ${id}`, why: 'every preregistered contrast compares two published cells', fix: { next: 'report', user_message: 'point --root at the published receipt' } });
    const dir = join(receipts[c.root], def.dir ?? join('cells', id));
    const receipt = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8')) as { instrument: { id: string; sha256: string } };
    const jkey = (j: JudgmentRecord) => `${j.answer_id}|${j.instrument_id}|${j.judge}|${j.judge_replicate}`;
    const redo = new Map(ndjson<JudgmentRecord>(join(dir, 'frontier-redo.ndjson')).map(j => [jkey(j), j]));
    cells.set(cellKey(c.root, id), { def, root: c.root, instrument: receipt.instrument, answers: ndjson<AnswerRecord>(join(dir, 'answers.ndjson')),
      judgments: ndjson<JudgmentRecord>(join(dir, 'judgments.ndjson')).map(j => redo.get(jkey(j)) ?? j) });
  }
  const secondJudge: JudgmentRecord[] = [];
  for (const sj of named('second-judge')) {
    const marker = join(sj, 'upstream.json');
    const dirs = existsSync(join(sj, 'cells')) ? readdirSync(join(sj, 'cells')).filter(d => d.endsWith('.second-judge')).sort() : [];
    const keyless = !existsSync(marker) || JSON.parse(readFileSync(marker, 'utf8')).keyless !== false
      || dirs.some(d => !existsSync(join(sj, 'cells', d, 'receipt.json')) || JSON.parse(readFileSync(join(sj, 'cells', d, 'receipt.json'), 'utf8')).keyless !== false);
    if (keyless) throw refuse({ code: 'USAGE', message: `KEYLESS_SOURCE: ${sj} is not a paid second-judge out (its upstream marker or a receipt does not say keyless: false)`, why: 'a keyless rehearsal\'s scores come from a fake upstream and never count', fix: { next: 'report', user_message: 'pass only paid second-judge outs' } });
    for (const d of dirs) secondJudge.push(...ndjson<JudgmentRecord>(join(sj, 'cells', d, 'judgments.ndjson')));
  }
  return { receipts, campaigns, cells, secondJudge, out, own: ndjson<JudgmentRecord>(join(out, 'judgments.ndjson')), distrust: reuseResults(out).filter(r => !r.pass).map(r => r.judge).sort() };
}

const scored = (j: JudgmentRecord | undefined): j is JudgmentRecord & { score: number } => !!j && j.parse_ok && j.outcome === 'scored' && typeof j.score === 'number';
const reuseKey = (answer: string, instrumentId: string, sha: string) => `${answer}|${instrumentId}|${sha}`;

/** Every usable replicate-0 judgment by answer, instrument id and instrument sha256: the receipts', then second-judge outs' (unless their judge failed its reuse check), then this run's own. */
export function judgmentIndex(s: Pick<Sources, 'cells' | 'secondJudge' | 'own'> & { distrust?: string[] }): Map<string, JudgmentRecord & { score: number }> {
  const m = new Map<string, JudgmentRecord & { score: number }>();
  const distrust = new Set(s.distrust ?? []);
  const external = [...[...s.cells.values()].flatMap(c => c.judgments), ...s.secondJudge].filter(j => !distrust.has(j.judge));
  for (const j of [...external, ...s.own]) {
    if (j.judge_replicate === 0 && scored(j)) m.set(reuseKey(j.answer_id, j.instrument_id, j.instrument_sha256), j);
  }
  return m;
}

export const REUSE_BAR = 0.95;
export interface ReuseResult { judge: string; sample: number; agreement: { share: number | null; ci95: [number, number] | null }; bar: number; pass: boolean }
/** The recorded reuse checks: a judge's old judgments are reused when its re-judged sample agrees on pass or fail at 95% or more. */
export function reuseResults(out: string): ReuseResult[] {
  const dir = join(out, 'reuse-check');
  return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as ReuseResult) : [];
}

/** Per-question values of one cell under M (published, every replicate), M0, F and R, by scoreboard.ts's own outcome rules. */
export function cellValues(s: Pick<Sources, 'campaigns'>, cell: LoadedCell, index: Map<string, JudgmentRecord & { score: number }>): CellValues {
  const set = s.campaigns[cell.root].sets.find(x => x.id === cell.def.set)!;
  const excluded = new Set(set.exclusions.map(e => e.question_id));
  const asProduct = new Set((cell.def.product_outcomes ?? []).map(p => `${p.reader}|${p.outcome}`));
  const byQ = new Map<string, AnswerRecord[]>();
  for (const a of cell.answers) byQ.set(a.question_id, [...(byQ.get(a.question_id) ?? []), a]);
  const canonical = new Map(cell.judgments.filter(j => j.instrument_id === cell.def.canonical_instrument && j.judge_replicate === 0).map(j => [j.answer_id, j]));
  const sha = cell.instrument.sha256, inst = cell.def.canonical_instrument;
  const out: CellValues = new Map();
  for (const q of set.scheduled) {
    if (excluded.has(q.question_id) || (cell.def.subset && !cell.def.subset.conversations.includes(q.conversation))) { out.set(q.question_id, { conversation: q.conversation, readers: null }); continue; }
    const readers: Record<string, ReaderValue> = {};
    let ok = true;
    for (const reader of cell.def.readers) {
      const scores: number[] = [];
      let first: ReaderValue | null = null;
      for (let rep = 0; rep < (cell.def.reader_replicates?.[reader] ?? 1); rep++) {
        const a = (byQ.get(q.question_id) ?? []).find(x => x.reader === reader && x.replicate === rep);
        if (!a || NOT_APPLICABLE.has(a.outcome as Outcome) || (HARNESS_FAILURES.has(a.outcome as Outcome) && !asProduct.has(`${reader}|${a.outcome}`))) { ok = false; break; }
        if (PRODUCT_FAILURES.has(a.outcome as Outcome) || asProduct.has(`${reader}|${a.outcome}`)) { scores.push(0); if (rep === 0) first = { M: null, M0: 0, F: 0, R: 0 }; continue; }
        const c = canonical.get(a.answer_id);
        if (!scored(c)) { ok = false; break; }
        scores.push(c.score);
        if (rep === 0) {
          const f = index.get(reuseKey(a.answer_id, frontierId(inst, judgeFor(reader)), sha)), r = index.get(reuseKey(a.answer_id, frontierId(inst, REFEREE), sha));
          first = { M: null, M0: c.score, F: f ? f.score : null, R: r ? r.score : null };
        }
      }
      if (!ok || !first) { ok = false; break; }
      readers[reader] = { ...first, M: scores.reduce((x, y) => x + y, 0) / scores.length };
    }
    out.set(q.question_id, { conversation: q.conversation, readers: ok ? readers : null });
  }
  return out;
}

const scheduledOf = (s: Pick<Sources, 'campaigns'>, c: ContrastDef) => s.campaigns[c.root].sets.find(x => x.id === c.set)!.scheduled.map(q => q.question_id);
const readersOf = (s: Sources, c: ContrastDef) => cellOf(s, c.root, c.anchor).def.readers.filter(r => cellOf(s, c.root, c.other).def.readers.includes(r));

// ─── Reproduction (d4) ───────────────────────────────────────────────

type DerivedBoard = { cells: Array<{ cell_id: string; valued: number; mean: number | null }>; comparisons: Array<{ anchor: string; other: string; metric: string; delta: number | null; ci95: [number, number] | null; cohort: { paired: number } | null }> };
const r1 = (x: number) => Math.round(x * 1000) / 10;
const pair = (lo: number, hi: number) => `${r1(lo)} to ${r1(hi)}`;

/** Every loaded cell's valued count and mean, and every published contrast's Δ, interval and cohort, must equal derive()'s; derive() must equal the committed scoreboards. */
export function reproduce(s: Sources, deriveFn: (receipt: string) => DerivedBoard = derive, publishedOf: (c: ContrastDef) => Published | null = c => c.published): { cells: number; contrasts: number } {
  const boards = { f6: deriveFn(s.receipts.f6), q1: deriveFn(s.receipts.q1) };
  const index = judgmentIndex(s), problems: string[] = [];
  const values = new Map<string, CellValues>();
  for (const [k, cell] of s.cells) {
    const v = cellValues(s, cell, index);
    values.set(k, v);
    const d = boards[cell.root].cells.find(x => x.cell_id === cell.def.cell_id);
    const valued = [...v.values()].map(q => questionView(q, 'M', cell.def.readers)).filter((x): x is number => x !== null);
    const mean = valued.length ? valued.reduce((a, b) => a + b, 0) / valued.length : null;
    if (!d) problems.push(`${k}: derive() has no such cell`);
    else if (d.valued !== valued.length || (d.mean === null) !== (mean === null) || (d.mean !== null && mean !== null && Math.abs(d.mean - mean) > 1e-5)) problems.push(`${k}: the loader gives ${valued.length} questions at ${mean === null ? 'n/a' : r1(mean)}, derive() ${d.valued} at ${d.mean === null ? 'n/a' : r1(d.mean)}`);
  }
  let contrasts = 0;
  for (const c of CONTRASTS) {
    const p = publishedOf(c);
    if (!p) continue;
    contrasts++;
    const [A, Bv] = [values.get(cellKey(c.root, c.anchor))!, values.get(cellKey(c.root, c.other))!];
    const readers = readersOf(s, c);
    const coh = cohorts(A, Bv, readers, scheduledOf(s, c));
    const loader = coh.published.reduce((x, q) => x + questionView(A.get(q), 'M', readers)! - questionView(Bv.get(q), 'M', readers)!, 0) / (coh.published.length || 1);
    const d = boards[c.root].comparisons.find(x => x.anchor === c.anchor && x.other === c.other && x.metric === 'answer');
    if (!d || d.delta === null || !d.ci95 || !d.cohort) { problems.push(`${c.id}: derive() has no such comparison`); continue; }
    if (r1(d.delta) !== r1(p.delta) || r1(d.ci95[0]) !== r1(p.ci95[0]) || r1(d.ci95[1]) !== r1(p.ci95[1]) || d.cohort.paired !== p.cohort) problems.push(`${c.id}: derive() gives ${r1(d.delta)} (${pair(...d.ci95)}) on ${d.cohort.paired}, the scoreboard ${r1(p.delta)} (${pair(...p.ci95)}) on ${p.cohort}`);
    else if (Math.abs(loader - d.delta) > 1e-5 || coh.published.length !== d.cohort.paired) problems.push(`${c.id}: the loader gives ${r1(loader)} on ${coh.published.length} questions, derive() ${r1(d.delta)} on ${d.cohort.paired}`);
  }
  if (problems.length) throw refuse({ code: 'PREFLIGHT_FAILED', message: `REPRODUCTION_FAILED: ${problems.slice(0, 6).join('; ')}${problems.length > 6 ? `; and ${problems.length - 6} more` : ''}`,
    why: 'δ is measured against the published canonical contrasts, so the loader must reproduce them before any frontier number', fix: { next: 'report', user_message: 'point --root at the published receipts; nothing was judged or summarized' } });
  return { cells: s.cells.size, contrasts };
}

// ─── Tasks ───────────────────────────────────────────────────────────

export interface Task { answer_id: string; question_id: string; set: string; cell: string; system: string; reader: string | null; text: string; judge: string; instrument: string; instrument_id: string; instrument_sha256: string }

/** The frontier judgments strata still need: each reader's replicate-0 judged answer in its contrasts' published cohorts without a usable frontier judgment. */
export function frontierTasks(s: Sources, strata: readonly Stratum[], cuts: Cuts | null): { tasks: Task[]; scope: string[]; reusable: number; productFailures: number; byJudge: Record<string, { needed: number; reusable: number; to_judge: number }> } {
  const index = judgmentIndex(s);
  const seen = new Set<string>(), tasks: Task[] = [], scope: string[] = [];
  let reusable = 0, productFailures = 0;
  const byJudge: Record<string, { needed: number; reusable: number; to_judge: number }> = {};
  for (const c of CONTRASTS.filter(x => strata.includes(x.stratum) && !cutContrast(x, cuts))) {
    const readers = readersOf(s, c);
    const [A, Bc] = [cellOf(s, c.root, c.anchor), cellOf(s, c.root, c.other)];
    const qs = new Set(cohorts(cellValues(s, A, index), cellValues(s, Bc, index), readers, scheduledOf(s, c)).published);
    for (const cell of [A, Bc]) for (const a of cell.answers) {
      if (a.replicate !== 0 || !qs.has(a.question_id) || !readers.includes(a.reader) || seen.has(a.answer_id)) continue;
      seen.add(a.answer_id);
      if (!JUDGED.has(a.outcome as Outcome)) { productFailures++; continue; }
      const judge = judgeFor(a.reader);
      checkPair(judge, a.reader);
      const id = frontierId(cell.def.canonical_instrument, judge);
      const b = byJudge[judge] ??= { needed: 0, reusable: 0, to_judge: 0 };
      b.needed++;
      scope.push(a.answer_id);
      if (index.has(reuseKey(a.answer_id, id, cell.instrument.sha256))) { b.reusable++; reusable++; continue; }
      b.to_judge++;
      tasks.push({ answer_id: a.answer_id, question_id: a.question_id, set: cell.def.set, cell: cell.def.cell_id, system: cell.def.system, reader: a.reader, text: a.text, judge, instrument: cell.def.canonical_instrument, instrument_id: id, instrument_sha256: cell.instrument.sha256 });
    }
  }
  return { tasks, scope, reusable, productFailures, byJudge };
}

const order = (seed: string, id: string) => createHash('sha256').update(`${seed}|${id}`).digest('hex');

/** Items taken round-robin over groups in sorted key order, each group in its given order. */
const roundRobin = <T>(groups: ReadonlyMap<string, readonly T[]>): T[] => {
  const keys = [...groups.keys()].sort(), out: T[] = [], total = [...groups.values()].reduce((a, g) => a + g.length, 0);
  for (let i = 0; out.length < total; i++) for (const k of keys) { const g = groups.get(k)!; if (i < g.length) out.push(g[i]); }
  return out;
};

/** A seeded sample of n items stratified by set, then by system and category within each set: sets take turns, and each set takes its strata in turn, each stratum in seeded order. */
export function stratifiedSample<T extends { answer_id: string; set: string; system: string }>(xs: readonly T[], n: number, seed: string, category: (x: T) => string): T[] {
  const bySet = new Map<string, Map<string, T[]>>();
  for (const x of [...xs].sort((a, b) => order(seed, a.answer_id).localeCompare(order(seed, b.answer_id)))) {
    const set = bySet.get(x.set) ?? new Map<string, T[]>(), g = `${x.system}|${category(x)}`;
    set.set(g, [...(set.get(g) ?? []), x]);
    bySet.set(x.set, set);
  }
  return roundRobin(new Map([...bySet].map(([set, groups]) => [set, roundRobin(groups)]))).slice(0, n);
}

// ─── Controls (d6) ───────────────────────────────────────────────────

export const ABSTENTION_TEXT = "I can't find that in our conversation history.";
export const hedged = (gold: string) => `I'm not fully certain, but it appears that ${gold}. The history may be incomplete.`;
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export interface ControlAnswer { answer_id: string; question_id: string; set: string; control: 'C1' | 'C2' | 'C3' | 'C4'; text: string; expected: 'pass' | 'fail' }
export const CONTROL_SETS = ['S1', 'S2b', 'D8'] as const;

/** 50 rubric-scored questions with a gold answer per set (event_ordering left out), stratified by category, and their four controls; no model call. */
export function buildControls(questions: Record<string, MemoryQuestion[]>, perSet = 50, seed = 'gst-1365-controls'): { answers: ControlAnswer[]; c2_skipped: number; c2_abstention: number } {
  const answers: ControlAnswer[] = [];
  let skipped = 0, abstention = 0;
  for (const set of Object.keys(questions).sort()) {
    const pool = questions[set].filter(q => q.answer && q.rubric?.length && q.category !== 'event_ordering').map(q => ({ answer_id: q.id, set, system: 'controls', q }));
    for (const { q } of stratifiedSample(pool, perSet, `${seed}|${set}`, x => x.q.category)) {
      const gold = q.answer!;
      const id = (k: string) => sha256(`gst-1365-control|${set}|${q.id}|${k}`);
      answers.push({ answer_id: id('C1'), question_id: q.id, set, control: 'C1', text: gold, expected: 'pass' });
      const draw = questions[set].filter(o => o.id !== q.id && o.conversation === q.conversation && !o.abstention && o.answer && norm(o.answer) !== norm(gold) && (q.abstention || o.category === q.category))
        .sort((a, b) => order(`${seed}|c2|${q.id}`, a.id).localeCompare(order(`${seed}|c2|${q.id}`, b.id)))[0];
      if (draw) { answers.push({ answer_id: id('C2'), question_id: q.id, set, control: 'C2', text: draw.answer!, expected: 'fail' }); if (q.abstention) abstention++; } else skipped++;
      answers.push({ answer_id: id('C3'), question_id: q.id, set, control: 'C3', text: ABSTENTION_TEXT, expected: q.abstention ? 'pass' : 'fail' });
      answers.push({ answer_id: id('C4'), question_id: q.id, set, control: 'C4', text: hedged(gold), expected: 'pass' });
    }
  }
  return { answers, c2_skipped: skipped, c2_abstention: abstention };
}

/** Every judge's control judgments still missing; after cut step 1, Opus and Gemini judge the first 25 questions per set only (75 in all). */
export function controlTasks(s: Sources, built: ControlAnswer[], done: (t: Task) => boolean, cuts: Cuts | null): Task[] {
  const reduced = new Set(CONTROL_SETS.flatMap(set => [...new Set(built.filter(a => a.set === set).map(a => a.question_id))].slice(0, 25).map(q => `${set}|${q}`)));
  const anchorOf = (set: string) => cellOf(s, 'f6', CONTRASTS.find(c => c.root === 'f6' && c.set === set)!.anchor);
  const tasks: Task[] = [];
  for (const a of built) for (const judge of [CANONICAL, SOL, OPUS, REFEREE]) {
    if (cuts && cuts.through >= 1 && (judge === OPUS || judge === REFEREE) && !reduced.has(`${a.set}|${a.question_id}`)) continue;
    checkPair(judge, null);
    const cell = anchorOf(a.set), inst = cell.def.canonical_instrument;
    const t: Task = { answer_id: a.answer_id, question_id: a.question_id, set: a.set, cell: `controls.${a.control}`, system: 'controls', reader: null, text: a.text, judge, instrument: inst,
      instrument_id: judge === CANONICAL ? inst : frontierId(inst, judge), instrument_sha256: cell.instrument.sha256 };
    if (!done(t)) tasks.push(t);
  }
  return tasks;
}

// ─── Referee (F16) ───────────────────────────────────────────────────

export const refereeStrata = (cuts: Cuts | null): Stratum[] => (['A', 'B', 'C', 'D'] as Stratum[]).filter(x => !(x === 'D' && cuts && cuts.through >= 3));

/** The census answers of strata as referee tasks, with their canonical and frontier scores where judged and their sampling group (set, reader family, system). */
function censusAnswers(s: Sources, strata: readonly Stratum[], cuts: Cuts | null): Array<{ task: Task; group: string; m: number | null; f: number | null }> {
  const scope = new Set(frontierTasks(s, strata, cuts).scope), index = judgmentIndex(s), rows = new Map<string, { task: Task; group: string; m: number | null; f: number | null }>();
  for (const c of CONTRASTS.filter(x => strata.includes(x.stratum) && !cutContrast(x, cuts))) for (const id of [c.anchor, c.other]) {
    const cell = cellOf(s, c.root, id), readers = readersOf(s, c), inst = cell.def.canonical_instrument;
    const canonical = new Map(cell.judgments.filter(j => j.instrument_id === inst && j.judge_replicate === 0).map(j => [j.answer_id, j]));
    for (const a of cell.answers) {
      if (!scope.has(a.answer_id) || rows.has(a.answer_id) || !readers.includes(a.reader)) continue;
      const m = canonical.get(a.answer_id), f = index.get(reuseKey(a.answer_id, frontierId(inst, judgeFor(a.reader)), cell.instrument.sha256));
      rows.set(a.answer_id, { group: `${cell.def.set}|${family(a.reader)}|${cell.def.system}`, m: scored(m) ? m.score : null, f: f ? f.score : null,
        task: { answer_id: a.answer_id, question_id: a.question_id, set: cell.def.set, cell: cell.def.cell_id, system: cell.def.system, reader: a.reader, text: a.text, judge: REFEREE, instrument: inst, instrument_id: frontierId(inst, REFEREE), instrument_sha256: cell.instrument.sha256 } });
    }
  }
  return [...rows.values()];
}

/** The referee's population, within the census's answers: every canonical/frontier disagreement at 0.5 and a seeded 600-answer agreement sample stratified by set, reader family and system. Refuses until its strata are frozen. */
export function refereePopulation(s: Sources, cuts: Cuts | null): { tasks: Task[]; disagreements: string[]; agreements: string[] } {
  const strata = refereeStrata(cuts), left = frontierTasks(s, strata, cuts).tasks.length;
  if (left) throw refuse({ code: 'PREFLIGHT_FAILED', message: `${left} frontier judgments are still missing in strata ${strata.join(', ')}`, why: 'the referee judges a frozen population of disagreements (complete strata, or strata the cut order dropped)', fix: { next: 'run', argv: [...FRONT, 'judge', '--stratum', '<stratum>'] } });
  const all = censusAnswers(s, strata, cuts).filter(r => r.m !== null && r.f !== null);
  const disagree = (r: { m: number | null; f: number | null }) => (r.m! >= PASS_THRESHOLD) !== (r.f! >= PASS_THRESHOLD);
  const disagreements = all.filter(disagree).map(r => r.task.answer_id).sort();
  const agreements = proportional(all.filter(r => !disagree(r)), 600, 'gst-1365-referee').sort();
  const chosen = new Set([...disagreements, ...agreements]);
  return { tasks: all.filter(r => chosen.has(r.task.answer_id)).map(r => r.task).sort((a, b) => a.answer_id.localeCompare(b.answer_id)), disagreements, agreements };
}

/** The paid smoke's referee sample: n census answers, seeded and stratified by set, system and reader family, judged before the census so Gemini's route and rate are measured first. */
export function refereeSmoke(s: Sources, n: number, cuts: Cuts | null): Task[] {
  const all = censusAnswers(s, refereeStrata(cuts), cuts);
  const group = new Map(all.map(r => [r.task.answer_id, r.group]));
  return stratifiedSample(all.map(r => r.task), n, 'gst-1365-smoke|referee', t => group.get(t.answer_id)!);
}

/** n answer ids allocated across groups in proportion to their size (largest remainder), each group's in seeded order over sorted ids. */
function proportional(xs: ReadonlyArray<{ task: Task; group: string }>, n: number, seed: string): string[] {
  const groups = new Map<string, string[]>();
  for (const x of [...xs].sort((a, b) => a.task.answer_id.localeCompare(b.task.answer_id))) groups.set(x.group, [...(groups.get(x.group) ?? []), x.task.answer_id]);
  const take = Math.min(n, xs.length), keys = [...groups.keys()].sort();
  const quota = keys.map(k => ({ k, exact: (groups.get(k)!.length / (xs.length || 1)) * take }));
  const alloc = new Map(quota.map(q => [q.k, Math.floor(q.exact)]));
  let rest = take - [...alloc.values()].reduce((a, b) => a + b, 0);
  for (const q of [...quota].sort((a, b) => (b.exact % 1) - (a.exact % 1) || a.k.localeCompare(b.k))) { if (rest <= 0) break; alloc.set(q.k, alloc.get(q.k)! + 1); rest--; }
  return keys.flatMap(k => [...groups.get(k)!].sort((a, b) => order(seed, a).localeCompare(order(seed, b))).slice(0, alloc.get(k)));
}

// ─── Identity (one per stage) ────────────────────────────────────────

/** A stage's identity: every task's answer, answer text, judge, instrument id and sha256. A resume onto any other set is refused; write false only checks an identity already pinned. */
export function checkIdentity(path: string, tasks: readonly Task[], write = true): string {
  const id = sha256([...tasks].map(t => [t.answer_id, sha256(t.text), t.judge, t.instrument_id, t.instrument_sha256].join('|')).sort().join('\n'));
  if (existsSync(path)) {
    const prior = JSON.parse(readFileSync(path, 'utf8')) as { identity: string; tasks: number };
    if (prior.identity !== id) throw refuse({ code: 'RESUME_REFUSED', message: `${path} pins ${prior.tasks} tasks (${prior.identity.slice(0, 12)}), this run plans ${tasks.length} (${id.slice(0, 12)})`,
      why: 'a resume continues the same answers, judges and instruments; other roots or another tree would mix two populations', fix: { next: 'report', user_message: 'resume with the same roots and tree, or use a fresh --out' } });
    return id;
  }
  if (write) writeFileSync(path, JSON.stringify({ identity: id, tasks: tasks.length, at: new Date().toISOString() }) + '\n');
  return id;
}

// ─── Judging (one loop for every paid subcommand) ────────────────────

export interface JudgeRun { judged: number; remaining: number; request_errors: number; held: number; last_error: string | null; budget_stop: boolean; stop_file: boolean; per_judge: Record<string, number> }

/** A budget refusal: the ledger's own error, or the lease proxy's 402 or 502 whose error body has type "budget" (qa-v2 quotes that body first). */
export function isBudgetStop(e: unknown): boolean {
  if ((e as Error)?.name === 'BudgetExceededError') return true;
  const status = (e as { status?: number })?.status;
  return (status === 402 || status === 502) && new RegExp(`^[a-z]+ ${status}: \\{"kind":"budget","type":"budget",`).test(String((e as Error)?.message ?? ''));
}

/**
 * Judge tasks into a record log, concurrency at a time, binding the judge slot once per pass; a budget stop or the STOP
 * file ends the run, and a resume skips judged tasks. A request that may have reached the provider before it failed is
 * held for the rest of the invocation rather than sent again in a later pass (the ledger already charged its reservation).
 */
export async function judgeTasks(tasks: readonly Task[], question: (t: Task) => MemoryQuestion, log: RecordLog<'judgment'>, opts: { client: ChatLike; around?: (key: string, fn: () => Promise<unknown>) => Promise<unknown>; concurrency?: number; stopFile?: string; maxAttempts?: number; instruments?: (id: string) => Instrument }): Promise<JudgeRun> {
  const inst = opts.instruments ?? instrumentFor;
  const key = (t: Task) => judgmentKey({ answer_id: t.answer_id, instrument_sha256: inst(t.instrument).sha256, judge: t.judge, judge_replicate: 0 });
  const run: JudgeRun = { judged: 0, remaining: 0, request_errors: 0, held: 0, last_error: null, budget_stop: false, stop_file: false, per_judge: {} };
  const held = new Set<string>();
  const stopped = () => run.budget_stop || (!!opts.stopFile && existsSync(opts.stopFile) && (run.stop_file = true));
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  for (let pass = 0; pass < maxAttempts && !stopped(); pass++) {
    const queue = tasks.filter(t => !log.has(key(t)) && !held.has(key(t)));
    if (!queue.length) break;
    const one = async (t: Task) => {
      try {
        log.append({ answer_id: t.answer_id, ...await judgeAnswer(opts.client, inst(t.instrument), question(t), t.text, { judge: t.judge, judgeReplicate: 0, maxAttempts }), instrument_id: t.instrument_id });
        run.judged++;
        run.per_judge[t.judge] = (run.per_judge[t.judge] ?? 0) + 1;
      } catch (e) {
        if (isBudgetStop(e)) run.budget_stop = true;
        else { run.request_errors++; run.last_error = String((e as Error).message).slice(0, 200); if (compatMayHaveBilled(e)) held.add(key(t)); }
      }
    };
    const worker = async () => { for (let t = queue.shift(); t && !stopped(); t = queue.shift()) await one(t); };
    const all = () => Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 8, queue.length) }, worker));
    await (opts.around ? opts.around(`gst-1365:pass-${pass}`, all) : all());
  }
  run.remaining = tasks.filter(t => !log.has(key(t))).length;
  run.held = held.size;
  return run;
}

export type StopCode = 'LEASE_EXHAUSTED' | 'CEILING_REACHED' | 'STOPPED' | null;
/** A budget stop with under $1 left below the ceiling is CEILING_REACHED, else LEASE_EXHAUSTED; the STOP file is STOPPED. */
export function stopCode(run: Pick<JudgeRun, 'budget_stop' | 'stop_file'>, committedUsd: number, ceiling: number): StopCode {
  if (run.budget_stop) return ceiling - committedUsd < CEILING_ROOM_USD ? 'CEILING_REACHED' : 'LEASE_EXHAUSTED';
  return run.stop_file ? 'STOPPED' : null;
}
export const exitFor = (code: StopCode, remaining: number) => code === 'CEILING_REACHED' ? 5 : code || remaining ? 4 : 0;

// ─── Money (d7, F9, F12) ─────────────────────────────────────────────

/** The ledger ceiling: $850, raised by a recorded reserve grant of GBEV-3's to at most $1,100. */
export function ceilingUsd(grant: { usd: number; words: string } | null): number {
  if (!grant) return LEDGER_CEILING_USD;
  if (!(grant.usd > 0) || grant.usd > RESERVE_USD || !grant.words.trim()) throw refuse({ code: 'USAGE', message: `a reserve grant takes more than $0 and at most $${RESERVE_USD}, with GBEV-3's words`, why: 'the API ceiling is $850; only GBEV-3 releases the $250 reserve (R71)', fix: { next: 'ask_user', user_message: 'ask GBEV-3 to release the reserve' } });
  return LEDGER_CEILING_USD + grant.usd;
}

const committed = (ledgerPath: string) => existsSync(ledgerPaths(ledgerPath).ledger) ? ledgerStatus({ ledgerPath }).totals.committed_usd : 0;

/** One lease on the GST-1365 ledger, refused (CEILING_REACHED) before it opens when the ledger's other spend plus the lease would pass the ceiling. */
export function openLease(o: { runId: string; leaseUsd: number; ledgerPath: string; ceiling: number }): BudgetRun {
  const status = existsSync(ledgerPaths(o.ledgerPath).ledger) ? ledgerStatus({ ledgerPath: o.ledgerPath, runId: o.runId }) : null;
  const spent = status ? status.totals.committed_usd - (status.run && !status.run.finished_at ? status.run.committed_usd : 0) : 0;
  if (spent + o.leaseUsd > o.ceiling + 1e-9) throw refuse({ code: 'BUDGET_CAP', message: `CEILING_REACHED: a $${o.leaseUsd.toFixed(2)} lease on ${o.ledgerPath}, which holds $${spent.toFixed(2)}, would pass GST-1365's $${o.ceiling.toFixed(2)} ceiling`,
    why: 'GST-1365\'s API ceiling is preregistered; a cap stop ends the check incomplete and is never retried (R71)', fix: { next: 'ask_user', user_message: 'report the run incomplete to GBEV-3' } });
  return BudgetRun.openLease({ runId: o.runId, leaseUsd: o.leaseUsd, ledgerPath: o.ledgerPath, runner: 'gst-1365-rejudge' });
}

const KEYS: Record<string, string> = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY' };
const LISTING: Record<string, (model: string, key: string) => { url: string; headers: Record<string, string> }> = {
  openai: (m, k) => ({ url: `https://api.openai.com/v1/models/${m}`, headers: { authorization: `Bearer ${k}` } }),
  anthropic: (m, k) => ({ url: `https://api.anthropic.com/v1/models/${m}`, headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' } }),
  gemini: (m, k) => ({ url: `https://generativelanguage.googleapis.com/v1beta/openai/models/${m}`, headers: { authorization: `Bearer ${k}` } }),
};
/** KEY_MISSING before any lease: each judge's key is set and its free model listing answers; the message names the variable, never its value. */
export async function preflightKeys(judges: readonly string[], env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): Promise<void> {
  for (const judge of [...new Set(judges)].sort()) {
    const prov = family(judge), name = KEYS[prov];
    const missing = (why: string) => refuse({ code: 'KEY_MISSING', message: `KEY_MISSING: ${name ?? prov} for ${judge}: ${why}`, why: 'every judge key is checked before a lease opens, so a missing key never reads as a budget stop', fix: { next: 'ask_user', user_message: `set ${name ?? prov} on the custody host` } });
    if (!name || !env[name]) throw missing('not set');
    const { url, headers } = LISTING[prov](judge.slice(prov.length + 1), env[name]!);
    const status = await fetchImpl(url, { headers }).then(r => (r.ok ? null : String(r.status)), e => (e as Error).name);
    if (status) throw missing(`its free model listing answered ${status}`);
  }
}

/** Every task's instrument must be this tree's: a judgment under another sha256 would never meet its reuse key. */
export function checkInstruments(tasks: readonly Task[], instruments: (id: string) => Instrument = instrumentFor): void {
  const bad = [...new Set(tasks.filter(t => instruments(t.instrument).sha256 !== t.instrument_sha256).map(t => t.instrument))];
  if (bad.length) throw refuse({ code: 'PREFLIGHT_FAILED', message: `the receipts judged ${bad.join(', ')} with another instrument sha256 than this tree's`, why: 'a frontier judgment is comparable only under the canonical judgment\'s exact instrument', fix: { next: 'report', user_message: 'run from the tree whose instruments the receipts used' } });
}

// ─── Results ─────────────────────────────────────────────────────────

export interface ContrastResult { id: string; family: string; set: string; cut: boolean; published_cohort: number; common_cohort: number; canonical: Interval; M0: Interval | null; F: Interval | null; K: Interval | null; effect: Interval | null; sol_two_reader: Interval | null; per_reader: Record<string, { M0: Interval; F: Interval }>; outcome: RuleOutcome | 'NOT RUN (CUT ORDER)'; separated: boolean; reasons: string[] }

/** Every contrast under M, M0, F and K on its common cohort, its outcome, the per-set ranks and the family verdicts. */
export function contrastResults(s: Sources, cuts: Cuts | null, partial: readonly Stratum[] = [], publishedOf: (c: ContrastDef) => Published | null = c => c.published): { contrasts: ContrastResult[]; families: Record<string, string>; ranks: Record<string, unknown> } {
  const index = judgmentIndex(s), values = new Map<string, CellValues>();
  const valuesOf = (root: string, id: string) => { const k = cellKey(root, id); if (!values.has(k)) values.set(k, cellValues(s, s.cells.get(k)!, index)); return values.get(k)!; };
  const contrasts = CONTRASTS.map((c): ContrastResult => {
    const readers = readersOf(s, c), A = valuesOf(c.root, c.anchor), Bv = valuesOf(c.root, c.other);
    const coh = cohorts(A, Bv, readers, scheduledOf(s, c));
    const p = publishedOf(c);
    const canonical = p ? { delta: p.delta, ci95: p.ci95 } : contrast(A, Bv, readers, coh.published, 'M');
    const base = { id: c.id, family: c.family, set: c.set, published_cohort: coh.published.length, common_cohort: coh.common.length, canonical, M0: null, F: null, K: null, effect: null, sol_two_reader: null, per_reader: {} };
    if (cutContrast(c, cuts)) return { ...base, cut: true, outcome: 'NOT RUN (CUT ORDER)', separated: false, reasons: [`cut order: ${CUT_STEPS.slice(0, cuts!.through).join('; ')}`] };
    if (coh.incomplete || !coh.common.length) return { ...base, cut: false, ...outcome({ canonical, F: canonical, effect: canonical, perReader: {}, incomplete: coh.incomplete ?? 'no common cohort' }) };
    const per_reader = Object.fromEntries(readers.map(r => [r, { M0: contrast(A, Bv, [r], coh.common, 'M0'), F: contrast(A, Bv, [r], coh.common, 'F') }]));
    const F = contrast(A, Bv, readers, coh.common, 'F'), effect = judgeEffect(A, Bv, readers, coh.common);
    const kCoh = refereeStrata(cuts).includes(c.stratum) ? cohorts(A, Bv, readers, scheduledOf(s, c), true) : null;
    const sol = readers.filter(r => judgeFor(r) === SOL);
    return { ...base, cut: false, M0: contrast(A, Bv, readers, coh.common, 'M0'), F, effect, per_reader,
      K: kCoh && !kCoh.incomplete && kCoh.common.length ? contrast(A, Bv, readers, kCoh.common, 'K') : null,
      sol_two_reader: sol.length > 1 && sol.length < readers.length ? contrast(A, Bv, sol, coh.common, 'F') : null,
      ...outcome({ canonical, F, effect, perReader: Object.fromEntries(Object.entries(per_reader).map(([r, v]) => [r, v.F])), incomplete: null }) };
  });
  const families: Record<string, string> = {}, rankOut: Record<string, unknown> = {};
  for (const fam of ['F6', 'D8', 'Q1']) {
    const mine = CONTRASTS.map((c, i) => ({ c, r: contrasts[i] })).filter(x => x.c.family === fam);
    const live = mine.filter(x => !x.r.cut).map(({ r }): RankedContrast => ({ set: r.set, canonical: r.canonical, F: r.F, outcome: r.outcome as RuleOutcome }));
    families[fam] = familyVerdict(live, { cut: !live.length, partial: mine.some(x => !x.r.cut && partial.includes(x.c.stratum)) });
    rankOut[fam] = ranks(live);
  }
  return { contrasts, families, ranks: rankOut };
}

/** The referee rows of a set of answers: the canonical, frontier and referee verdicts with the reader's family, reader and system. */
function refereeRows(s: Sources, ids: readonly string[]): RefereeRow[] {
  const index = judgmentIndex(s), want = new Set(ids), rows: RefereeRow[] = [];
  for (const cell of s.cells.values()) {
    const canonical = new Map(cell.judgments.filter(j => j.instrument_id === cell.def.canonical_instrument && j.judge_replicate === 0).map(j => [j.answer_id, j]));
    for (const a of cell.answers) {
      if (!want.has(a.answer_id)) continue;
      want.delete(a.answer_id);
      const m = canonical.get(a.answer_id), inst = cell.def.canonical_instrument, sha = cell.instrument.sha256;
      const f = index.get(reuseKey(a.answer_id, frontierId(inst, judgeFor(a.reader)), sha)), r = index.get(reuseKey(a.answer_id, frontierId(inst, REFEREE), sha));
      if (scored(m) && f && r) rows.push({ group: `${family(a.reader) === 'openai' ? 'Sol rows' : 'Claude rows'}|${a.reader}|${cell.def.system}`, m: m.score >= PASS_THRESHOLD, f: f.score >= PASS_THRESHOLD, r: r.score >= PASS_THRESHOLD });
    }
  }
  return rows;
}

/** Refuse to write a report that holds any question id of the inputs. */
export function guardIds(text: string, s: Pick<Sources, 'campaigns'>): void {
  const hit = Object.values(s.campaigns).some(c => c.sets.some(x => x.scheduled.some(q => text.includes(q.question_id))));
  if (hit) throw refuse({ code: 'PREFLIGHT_FAILED', message: 'the report would hold a question id; nothing was written', why: 'GST-1365 publishes aggregates only; sealed question ids never leave custody', fix: { next: 'report', user_message: 'report a bug in rejudge-systems.ts' } });
}

const pts = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`;
const iv = (i: Interval | null) => (!i ? 'n/a' : `${pts(i.delta)} (${i.ci95 ? `${pts(i.ci95[0])} to ${pts(i.ci95[1])}` : 'n/a'})`);
export function renderContrasts(results: readonly ContrastResult[]): string {
  const lines = ['| Contrast | Published cohort | Common cohort | Δ_M (canonical) | Δ_M0 | Δ_F | δ = Δ_F − Δ_M0 | Δ_K | Outcome |', '|---|---:|---:|---:|---:|---:|---:|---:|---|'];
  for (const c of results) lines.push(`| ${c.id} | ${c.published_cohort} | ${c.common_cohort} | ${iv(c.canonical)} | ${iv(c.M0)} | ${iv(c.F)} | ${iv(c.effect)} | ${iv(c.K)} | ${c.outcome}${c.reasons.length ? `: ${c.reasons.join('; ')}` : ''} |`);
  return lines.join('\n') + '\n';
}

// ─── Plan (free Stage 0) ─────────────────────────────────────────────

const RATES: Record<string, { central: number; conservative: number }> = { [SOL]: { central: 0.0188, conservative: 0.025 }, [OPUS]: { central: 0.068, conservative: 0.10 }, [REFEREE]: { central: 0.03, conservative: 0.10 }, [CANONICAL]: { central: 0.003, conservative: 0.003 } };

/** Measured ledger dollars per answer per judge from paid receipts under outs. */
export function measuredRates(outs: readonly string[]): Record<string, number> {
  const tot: Record<string, { usd: number; n: number }> = {};
  for (const out of outs) {
    const dir = join(out, 'receipts');
    for (const f of existsSync(dir) ? readdirSync(dir).filter(x => x.endsWith('.json')).sort() : []) {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { keyless?: boolean; per_judge?: Record<string, { answers: number; ledger_usd: number }> };
      if (r.keyless !== false) continue;
      for (const [j, v] of Object.entries(r.per_judge ?? {})) { const t = tot[j] ??= { usd: 0, n: 0 }; t.usd += v.ledger_usd; t.n += v.answers; }
    }
  }
  return Object.fromEntries(Object.entries(tot).filter(([, t]) => t.n > 0).map(([j, t]) => [j, t.usd / t.n]));
}

/** Coverage, what each stratum still needs, projected dollars and the cut steps they fire, the measured disagreement and score shifts, and the contrasts the reusable judgments already allow. */
export function plan(s: Sources, rates: Record<string, number> = {}) {
  const cuts = readCuts(s.out), none = { ...s, own: [] };
  const strata = Object.fromEntries((['A', 'B', 'C', 'D'] as Stratum[]).map(x => { const t = frontierTasks(none, [x], null); return [x, { reusable: t.reusable, product_failures: t.productFailures, by_judge: t.byJudge, tasks: t.tasks, scope: t.scope }]; }));
  const scope = new Set(Object.values(strata).flatMap(x => x.scope));
  const index = judgmentIndex(s);
  let agree = 0, disagree = 0, shiftDis = 0, shiftAgree = 0;
  const instrumentMismatch = new Set<string>();
  for (const cell of s.cells.values()) {
    if (instrumentFor(cell.def.canonical_instrument).sha256 !== cell.instrument.sha256) instrumentMismatch.add(cell.def.cell_id);
    const canonical = new Map(cell.judgments.filter(j => j.instrument_id === cell.def.canonical_instrument && j.judge_replicate === 0).map(j => [j.answer_id, j]));
    for (const a of cell.answers) {
      if (!scope.has(a.answer_id)) continue;
      const m = canonical.get(a.answer_id), f = index.get(reuseKey(a.answer_id, frontierId(cell.def.canonical_instrument, judgeFor(a.reader)), cell.instrument.sha256));
      if (!scored(m) || !f) continue;
      const d = (f.score - m.score) ** 2;
      if ((m.score >= PASS_THRESHOLD) !== (f.score >= PASS_THRESHOLD)) { disagree++; shiftDis += d; } else { agree++; shiftAgree += d; }
    }
  }
  const rate = (j: string, k: 'central' | 'conservative') => rates[j] ?? RATES[j][k];
  const disagreementRate = agree + disagree ? disagree / (agree + disagree) : 0.14;
  const needed = (x: Stratum) => Object.values(strata[x].by_judge).reduce((y, b) => y + b.needed, 0);
  const project = (k: 'central' | 'conservative') => {
    const census = Object.fromEntries((['A', 'B', 'C', 'D'] as Stratum[]).map(x => [x, strata[x].tasks.reduce((y, t) => y + rate(t.judge, k), 0)]));
    const onlyQ1 = (set: string) => strata.C.tasks.filter(t => t.set === set && !CONTRASTS.some(c => c.root === 'f6' && (c.anchor === t.cell || c.other === t.cell))).reduce((y, t) => y + rate(t.judge, k), 0);
    const all = (['A', 'B', 'C', 'D'] as Stratum[]).reduce((y, x) => y + needed(x), 0);
    const referee = (all * disagreementRate + 600) * rate(REFEREE, k);
    const controls = 600 * (rate(CANONICAL, k) + rate(SOL, k) + rate(OPUS, k) + rate(REFEREE, k));
    const lines: Record<string, number> = { ...census, referee, controls };
    const total = Object.values(lines).reduce((a, b) => a + b, 0);
    const savings = [300 * (rate(OPUS, k) + rate(REFEREE, k)), onlyQ1('S2a'), needed('D') * disagreementRate * rate(REFEREE, k), census.D, onlyQ1('S2b')];
    let after = total, through = 0;
    while (after > LEDGER_CEILING_USD && through < savings.length) after -= savings[through++];
    return { lines, total, cut_through: through, cut_steps: CUT_STEPS.slice(0, through), after_cuts: after, fits: after <= LEDGER_CEILING_USD };
  };
  const results = contrastResults(s, cuts);
  return {
    strata: Object.fromEntries(Object.entries(strata).map(([x, v]) => [x, { reusable: v.reusable, product_failures: v.product_failures, by_judge: v.by_judge }])),
    cuts, instrument_mismatch: [...instrumentMismatch].sort(),
    measured: { compared: agree + disagree, disagreement_rate: agree + disagree ? disagreementRate : null, rms_shift_disagreeing: disagree ? Math.sqrt(shiftDis / disagree) : null, rms_shift_agreeing: agree ? Math.sqrt(shiftAgree / agree) : null },
    rates: Object.fromEntries(Object.keys(RATES).map(j => [j, { central: rate(j, 'central'), conservative: rate(j, 'conservative'), measured: rates[j] ?? null }])),
    projection: { central: project('central'), conservative: project('conservative') },
    contrasts: results.contrasts.map(c => ({ id: c.id, published_cohort: c.published_cohort, common_cohort: c.common_cohort, outcome: c.outcome, F: c.F, per_reader: c.per_reader })),
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────

function questionsFor(sets: readonly string[], out: string, env: Record<string, string | undefined>): (set: string, id: string) => MemoryQuestion {
  const byId = new Map<string, MemoryQuestion>();
  for (const set of [...new Set(sets)].sort()) {
    const facts = ALL_SETS[set as SetId];
    if (!facts) throw refuse({ code: 'USAGE', message: `no set ${set}`, why: 'GST-1365 judges S1, S2b, S2a and D8 answers', fix: { next: 'report', user_message: 'report a bug in rejudge-systems.ts' } });
    custodyGate({ id: `gst-1365.${set}`, benchmark: facts.benchmark, split: facts.split }, out, { ...env, GBRAIN_EVALS_DECISION_ID: 'gst-1365' }, `GST-1365 judge-robustness check: judge frozen answers on ${set}`);
    for (const q of loadCorpus(facts.benchmark).questions) byId.set(`${set}|${q.id}`, q);
  }
  return (set, id) => { const q = byId.get(`${set}|${id}`); if (!q) throw new Error('a judged answer names a question its corpus does not hold'); return q; };
}

const readJson = <T>(path: string): T | null => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : null;

/** Write a stage's frozen population once; a rerun must find the same one. */
function freeze(path: string, value: unknown): void {
  const text = JSON.stringify(value) + '\n';
  if (existsSync(path) && readFileSync(path, 'utf8') !== text) throw refuse({ code: 'RESUME_REFUSED', message: `${path} holds another population`, why: 'a resume continues the frozen population', fix: { next: 'report', user_message: 'resume with the same roots and tree, or use a fresh --out' } });
  writeFileSync(path, text);
}

if (import.meta.main) {
  const argv = process.argv.slice(2), sub = argv[0];
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const many = (n: string) => argv.flatMap((a, i) => (a === n && argv[i + 1] ? [argv[i + 1]] : []));
  try {
    const outArg = one('--out');
    if (!sub || !outArg) throw refuse({ code: 'USAGE', message: 'usage: rejudge-systems.ts plan|cut|judge|reuse-check|referee|controls|summary ... --out <dir>', why: 'every subcommand reads and writes one custody --out', fix: { next: 'run', argv: [...FRONT, 'plan', '--root', 'f6=<receipt>', '--root', 'q1=<receipt>', '--out', '<dir>'] } });
    const out = resolve(outArg);
    mkdirSync(out, { recursive: true });
    if (sub === 'cut') {
      const through = Number(one('--through')), reason = one('--reason') ?? '', prior = readCuts(out);
      if (!Number.isInteger(through) || through < 1 || through > CUT_STEPS.length || !reason.trim()) throw refuse({ code: 'USAGE', message: '--through takes 1 to 5 and --reason the measured projection', why: 'cuts follow the preregistered order, first to last', fix: { next: 'run', argv: [...FRONT, 'plan', '--rates-from', out] } });
      if (prior && prior.through > through) throw refuse({ code: 'USAGE', message: `cut ${prior.through} already applies`, why: 'a cut is never undone', fix: { next: 'report', user_message: 'keep the recorded cut' } });
      writeFileSync(join(out, 'cuts.json'), JSON.stringify({ through, reason, at: new Date().toISOString() }) + '\n');
      console.log(JSON.stringify({ cut: CUT_STEPS.slice(0, through) }));
      process.exit(0);
    }
    const s = loadSources(many('--root'), out);
    if (sub === 'plan' || sub === 'summary') reproduce(s);
    if (sub === 'plan') { console.log(JSON.stringify(plan(s, measuredRates(many('--rates-from').map(o => resolve(o)))), null, 2)); process.exit(0); }
    const cuts = readCuts(out);
    if (sub === 'summary') {
      const report = resolve(one('--report') ?? join(out, 'report'));
      mkdirSync(report, { recursive: true });
      const partial = (['A', 'B', 'C', 'D'] as Stratum[]).filter(x => frontierTasks(s, [x], cuts).tasks.length > 0);
      const r = contrastResults(s, cuts, partial);
      const ref = readJson<{ disagreements: string[]; agreements: string[] }>(join(out, 'referee.json'));
      const disagreeRows = ref ? refereeRows(s, ref.disagreements) : [];
      const refereeResult = ref ? refereeStats(refereeRows(s, ref.agreements), disagreeRows) : null;
      const ctl = readJson<ControlAnswer[]>(join(out, 'controls.json'));
      const ctlJudged = ndjson<JudgmentRecord>(join(out, 'controls-judgments.ndjson')).filter(scored);
      const ctlRows: ControlRow[] = (ctl ?? []).map(c => ({ question: sha256(`${c.set}|${c.question_id}`).slice(0, 16), control: c.control, correct: Object.fromEntries(ctlJudged.filter(j => j.answer_id === c.answer_id).map(j => [j.judge, (j.score >= PASS_THRESHOLD) === (c.expected === 'pass')])) }));
      const ctlResult = ctl ? controlStats(ctlRows, [CANONICAL, SOL, OPUS, REFEREE]) : null;
      const more = (a: string, b: string) => ctlResult?.paired[[a, b].sort().join(' minus ')]?.more_accurate ?? null;
      const pF = (rows: RefereeRow[]) => wilson(rows.filter(x => x.r === x.f).length, rows.length);
      const verdict = (frontier: string[], p: ReturnType<typeof wilson>) => !refereeResult ? 'unsettled' : whichJudge({ valid: refereeResult.valid, pF: p,
        canonicalMoreAccurate: frontier.some(f => more(CANONICAL, f) === CANONICAL), frontierMoreAccurate: frontier.some(f => more(CANONICAL, f) === f) });
      const which = { pooled: verdict([SOL, OPUS], pF(disagreeRows)), claude_rows: verdict([SOL], pF(disagreeRows.filter(x => x.group.startsWith('Claude rows')))), sol_rows: verdict([OPUS], pF(disagreeRows.filter(x => x.group.startsWith('Sol rows')))) };
      const json = JSON.stringify({ schema: 'gbrain-evals/gst-1365-summary/v1', preregistration: PREREGISTRATION, partial_strata: partial, cuts, families: r.families, ranks: r.ranks, contrasts: r.contrasts, referee: refereeResult, controls: ctlResult, which_judge: which }, null, 2) + '\n';
      const md = `# GST-1365 summary\n\nFamily verdicts: ${Object.entries(r.families).map(([f, v]) => `${f} ${v}`).join('; ')}. Which judge: ${Object.entries(which).map(([k, v]) => `${k} ${v}`).join('; ')}.\n\n${renderContrasts(r.contrasts)}`;
      guardIds(json + md, s);
      writeFileSync(join(report, 'summary.json'), json);
      writeFileSync(join(report, 'summary.md'), md);
      console.log(md);
      process.exit(r.contrasts.some(c => c.outcome === 'INCOMPLETE') ? 4 : 0);
    }
    if (!['judge', 'reuse-check', 'referee', 'controls'].includes(sub)) throw refuse({ code: 'USAGE', message: `unknown subcommand ${sub}`, why: 'the file header lists the subcommands', fix: { next: 'run', argv: [...FRONT, 'plan'] } });
    const [ledger, runId, leaseUsd, concurrency] = [one('--budget-ledger'), one('--run-id'), Number(one('--lease-usd')), Number(one('--concurrency') ?? 16)];
    if (!ledger || !runId || !(leaseUsd > 0) || !Number.isInteger(concurrency) || concurrency < 1) throw refuse({ code: 'USAGE', message: 'a paid subcommand needs --budget-ledger, --run-id and --lease-usd', why: 'every judge request is reserved on the GST-1365 ledger first', fix: { next: 'run', argv: [...FRONT, sub, '--budget-ledger', '<file>', '--run-id', 'gst-1365-<stage>', '--lease-usd', '<n>'] } });
    const grantArg = one('--reserve-grant');
    const grant = grantArg ? { usd: Number(grantArg.slice(0, grantArg.indexOf('='))), words: grantArg.slice(grantArg.indexOf('=') + 1) } : null;
    const ceiling = ceilingUsd(grant);
    if (one('--ledger-cap-usd') !== undefined && Number(one('--ledger-cap-usd')) !== ceiling) throw refuse({ code: 'USAGE', message: `the GST-1365 ledger ceiling is $${ceiling}; --ledger-cap-usd may only repeat it`, why: 'the API ceiling is pinned in code and rises only with a recorded reserve grant (R71)', fix: { next: 'run', argv: [...FRONT, sub, '--reserve-grant', '<usd>=<GBEV-3\'s words>'] } });
    const keyless = keylessUpstreamArg(argv);
    claimOut(out, !!keyless, 'gst-1365');
    let tasks: Task[], extra: Record<string, unknown> = {}, logPath = join(out, 'judgments.ndjson'), cache = join(out, 'cache', 'qa');
    let question: (t: Task) => MemoryQuestion;
    if (sub === 'judge') {
      const stratum = one('--stratum') as Stratum;
      if (!['A', 'B', 'C', 'D'].includes(stratum)) throw refuse({ code: 'USAGE', message: '--stratum takes A, B, C or D', why: 'the census runs one stratum per lease', fix: { next: 'run', argv: [...FRONT, 'judge', '--stratum', 'A'] } });
      if (stratum === 'D' && cuts && cuts.through >= 4) throw refuse({ code: 'USAGE', message: 'the cut order dropped the D8 census', why: 'a cut is never undone', fix: { next: 'report', user_message: 'report D8 not run (cut order)' } });
      const limit = one('--limit');
      const full = frontierTasks({ ...s, own: [] }, [stratum], cuts).tasks;
      const unchecked = Object.entries(frontierTasks({ ...s, own: [], distrust: [] }, [stratum], cuts).byJudge).filter(([j, b]) => b.reusable > 0 && !reuseResults(out).some(r => r.judge === j)).map(([j]) => j);
      if (!limit && unchecked.length) throw refuse({ code: 'PREFLIGHT_FAILED', message: `the census reuses ${unchecked.join(' and ')} judgments no reuse check has measured`, why: 'old judgments are reused only after their judge re-judges 100 of them and agrees at 95% or more', fix: { next: 'run', argv: [...FRONT, 'reuse-check', '--judge', unchecked[0], '--n', '100'] } });
      checkIdentity(join(out, `identity-${stratum}.json`), full, !limit);
      const q = questionsFor(full.map(t => t.set), out, process.env);
      question = t => q(t.set, t.question_id);
      const left = frontierTasks(s, [stratum], cuts).tasks;
      tasks = limit ? stratifiedSample(left, Number(limit), `gst-1365-smoke|${stratum}`, t => question(t).category) : left;
      extra = { stratum, stratum_tasks: full.length, left_before: left.length };
    } else if (sub === 'reuse-check') {
      const judge = one('--judge') ?? '', n = Number(one('--n') ?? 100);
      if (![SOL, OPUS].includes(judge) || !(n > 0)) throw refuse({ code: 'USAGE', message: `--judge takes ${SOL} or ${OPUS}, --n a positive count`, why: 'the reuse check re-judges answers a frontier judge already judged', fix: { next: 'run', argv: [...FRONT, 'reuse-check', '--judge', SOL, '--n', '100'] } });
      const index = judgmentIndex({ ...s, own: [], distrust: [] }), pool = new Map<string, Task>();
      for (const c of CONTRASTS) for (const id of [c.anchor, c.other]) {
        const cell = cellOf(s, c.root, id);
        for (const a of cell.answers) {
          if (a.replicate !== 0 || !readersOf(s, c).includes(a.reader) || judgeFor(a.reader) !== judge || pool.has(a.answer_id)) continue;
          const iid = frontierId(cell.def.canonical_instrument, judge);
          if (index.has(reuseKey(a.answer_id, iid, cell.instrument.sha256))) pool.set(a.answer_id, { answer_id: a.answer_id, question_id: a.question_id, set: cell.def.set, cell: cell.def.cell_id, system: cell.def.system, reader: a.reader, text: a.text, judge, instrument: cell.def.canonical_instrument, instrument_id: iid, instrument_sha256: cell.instrument.sha256 });
        }
      }
      const all = [...pool.values()].sort((a, b) => a.answer_id.localeCompare(b.answer_id));
      const q = questionsFor(all.map(t => t.set), out, process.env);
      question = t => q(t.set, t.question_id);
      tasks = stratifiedSample(all, n, `gst-1365-reuse|${judge}`, t => question(t).category);
      logPath = join(out, 'reuse-check', `${family(judge)}.ndjson`); cache = join(out, 'cache', `reuse-${family(judge)}`);
      mkdirSync(join(out, 'reuse-check'), { recursive: true });
      checkIdentity(join(out, `identity-reuse-${family(judge)}.json`), tasks);
      extra = { judge, prior: Object.fromEntries(tasks.map(t => [t.answer_id, index.get(reuseKey(t.answer_id, t.instrument_id, t.instrument_sha256))!.score >= PASS_THRESHOLD])) };
    } else if (sub === 'referee' && one('--limit')) {
      const smoke = refereeSmoke(s, Number(one('--limit')), cuts);
      const q = questionsFor(smoke.map(t => t.set), out, process.env);
      question = t => q(t.set, t.question_id);
      const done = judgmentIndex(s);
      tasks = smoke.filter(t => !done.has(reuseKey(t.answer_id, t.instrument_id, t.instrument_sha256)));
      extra = { smoke: smoke.length };
    } else if (sub === 'referee') {
      const pop = refereePopulation(s, cuts);
      freeze(join(out, 'referee.json'), { disagreements: pop.disagreements, agreements: pop.agreements });
      checkIdentity(join(out, 'identity-referee.json'), pop.tasks);
      const q = questionsFor(pop.tasks.map(t => t.set), out, process.env);
      question = t => q(t.set, t.question_id);
      const done = judgmentIndex(s);
      tasks = pop.tasks.filter(t => !done.has(reuseKey(t.answer_id, t.instrument_id, t.instrument_sha256)));
      extra = { disagreements: pop.disagreements.length, agreement_sample: pop.agreements.length };
    } else {
      const q = questionsFor(CONTROL_SETS, out, process.env);
      const f6Set = (set: string) => s.campaigns.f6.sets.find(x => x.id === set)!;
      const questions = Object.fromEntries(CONTROL_SETS.map(set => { const ex = new Set(f6Set(set).exclusions.map(e => e.question_id)); return [set, f6Set(set).scheduled.filter(x => !ex.has(x.question_id)).map(x => q(set, x.question_id))]; }));
      const built = buildControls(questions);
      freeze(join(out, 'controls.json'), built.answers.map(a => ({ answer_id: a.answer_id, set: a.set, question_id: a.question_id, control: a.control, expected: a.expected })));
      const byId = new Map(built.answers.map(a => [a.answer_id, a]));
      question = t => q(t.set, byId.get(t.answer_id)!.question_id);
      const all = controlTasks(s, built.answers, () => false, cuts);
      checkIdentity(join(out, 'identity-controls.json'), all);
      logPath = join(out, 'controls-judgments.ndjson');
      const log0 = new RecordLog(logPath, 'judgment');
      tasks = all.filter(t => !log0.has(judgmentKey({ answer_id: t.answer_id, instrument_sha256: t.instrument_sha256, judge: t.judge, judge_replicate: 0 })));
      extra = { controls: built.answers.length, c2_skipped: built.c2_skipped, c2_on_abstention_questions: built.c2_abstention };
    }
    for (const t of tasks) checkPair(t.judge, t.reader);
    checkInstruments(tasks);
    const attestation = keyless ? null : attestPreregistration(PREREGISTRATION, ROOT);
    if (!keyless) await preflightKeys(tasks.map(t => t.judge));
    const placeholder = 'keyless-not-a-provider-key';
    const keys = keyless ? { OPENAI_API_KEY: placeholder, ANTHROPIC_API_KEY: placeholder, GEMINI_API_KEY: placeholder } : { ...process.env };
    const [cellToken, controlToken] = [randomUUID(), randomUUID()];
    Object.assign(process.env, { SHOOTOUT_CELL_TOKEN: cellToken, SHOOTOUT_PROXY_CONTROL_TOKEN: controlToken });
    const lease = openLease({ runId, leaseUsd, ledgerPath: resolve(ledger), ceiling });
    const usageLog = join(out, `usage-${runId}.ndjson`);
    const proxy = new MeteringProxy({ ...(keyless ? { upstream: { openai: keyless, anthropic: keyless, gemini: keyless } } : {}), cellToken, controlToken,
      policy: { lease, usageLog, env: keys, routeCaps: { caps: { ...DEFAULT_ROUTE_CAPS, 'judge@gemini:gemini-4-argon': GEMINI_FLOOR }, slots: { ...DEFAULT_ROUTE_CLASSES }, defaultClass: 'extraction' } } });
    proxy.start();
    try {
      const meters = join(out, 'meters.ndjson');
      const meter = metering(`http://127.0.0.1:${proxy.port}`, { meter: (m: MeterLine) => appendFileSync(meters, JSON.stringify(m) + '\n') }, process.env);
      const log = new RecordLog(logPath, 'judgment');
      const run = await judgeTasks(tasks, question, log, { client: new ChatClient(cache), around: (key, fn) => meter.around('judge', key, 'judge', fn), concurrency, stopFile: join(out, 'STOP') });
      const code = stopCode(run, committed(resolve(ledger)), ceiling);
      const usage = ndjson<UsageLine>(usageLog), split = existsSync(usageLog) ? usageSplit(usageLog) : null;
      const perModel: Record<string, { ledger_usd: number; requests: number; output_over_cap: number }> = {};
      for (const u of usage) { if (u.outcome === 'refused') continue; const m = perModel[u.model ?? 'unknown'] ??= { ledger_usd: 0, requests: 0, output_over_cap: 0 }; m.ledger_usd += u.actual_usd ?? 0; m.requests++; if (u.output_cap && (u.output_tokens ?? 0) > u.output_cap) m.output_over_cap++; }
      const perJudge = Object.fromEntries(Object.entries(run.per_judge).map(([j, n]) => [j, { answers: n, ledger_usd: perModel[j.slice(j.indexOf(':') + 1)]?.ledger_usd ?? 0 }]));
      if (sub === 'reuse-check') {
        const prior = extra.prior as Record<string, boolean>;
        const now = new RecordLog(logPath, 'judgment').all().filter(scored);
        const agreement = wilson(now.filter(j => prior[j.answer_id] === (j.score >= PASS_THRESHOLD)).length, now.length);
        const result: ReuseResult = { judge: extra.judge as string, sample: tasks.length, agreement, bar: REUSE_BAR, pass: agreement.share !== null && agreement.share >= REUSE_BAR };
        if (!run.remaining && now.length === tasks.length) writeFileSync(join(out, 'reuse-check', `${family(result.judge)}.json`), JSON.stringify(result) + '\n');
        extra = { ...result };
      }
      const receipt = { schema: 'gbrain-evals/gst-1365-receipt/v1', subcommand: sub, run_id: runId, keyless: !!keyless, attestation, ceiling_usd: ceiling, reserve_grant: grant, cuts, ...extra,
        counts: { tasks: tasks.length, judged: run.judged, remaining: run.remaining, request_errors: run.request_errors, held_may_have_billed: run.held }, last_error: run.last_error, stop: code,
        spend: split ? { source: 'lease usage log', ledger_usd: split.billed_usd + split.reserved_unsettled_usd, gemini_list_usd: (perModel['gemini-4-argon']?.ledger_usd ?? 0) / 2, note: 'the ledger books Gemini at twice list before 2026-12-01' } : null,
        per_judge: perJudge, per_model: perModel, lease: { usd: leaseUsd, ledger_committed_usd: committed(resolve(ledger)) } };
      mkdirSync(join(out, 'receipts'), { recursive: true });
      writeFileSync(join(out, 'receipts', `${sub}-${runId}.json`), JSON.stringify(receipt, null, 2) + '\n');
      console.log(JSON.stringify({ subcommand: sub, stop: code, counts: receipt.counts, spend: receipt.spend, per_judge: perJudge, ...(sub === 'reuse-check' ? { reuse: extra } : {}) }, null, 2));
      process.exitCode = exitFor(code, run.remaining);
    } finally { proxy.stop(); lease.close(); }
  } catch (e) {
    if (e instanceof ScoreboardError) {
      process.stderr.write(renderMessage(e.op) + '\n');
      process.exit(e.op.code === 'BUDGET_CAP' ? 5 : e.op.code === 'KEY_MISSING' ? 2 : exitCodeOf(e.op));
    }
    console.error((e as Error).message);
    process.exit(2);
  }
}

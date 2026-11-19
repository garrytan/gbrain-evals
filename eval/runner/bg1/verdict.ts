/**
 * BG1's analysis (preregistration docs/benchmarks/2026-11-09-changing-facts-battleground-preregistration.md, "Metric",
 * "Decision rule", "Secondary families" and "Internal pilot"). The rule itself is eval/runner/bg1/rule.ts; this file reads
 * the receipts, checks them and reports.
 *
 *   bun eval/runner/bg1/verdict.ts verdict --receipts <out dir>... [--manifest <filled bg1-manifest.json>] [--set BG1|BG1-dev3] [--judge-check <summary.json>] --out <dir>
 *   bun eval/runner/bg1/verdict.ts pilot   --receipts <out dir>... [--manifest <filled bg1-manifest.json>] --out <dir>
 *   bun eval/runner/bg1/verdict.ts confirm [--look] --receipts <out dir>... [--release <gbrain release>] [--left-out <server row>=<reason>]... [--brain-counts <counts.json>]
 *                                          [--manifest <filled bg1c-manifest.json>] [--cells <BG1-C cell set>] [--judge-check <summary.json>] --out <dir>
 *   bun eval/runner/bg1/verdict.ts pilot   --set BG1-C --receipts <smoke out dir>... [--brain-counts <counts.json>] [--memory-counts <counts.json>] [--mint-rate <supply.json>]
 *                                          [--judge-check <report.json>]... [--cells <BG1-C cell set>] --out <dir>
 *
 * Each --receipts directory is a cell or re-read output (cell.ts --out, reread-cell.ts --out): every
 * cells/<cell id>/receipt.json under it is read, with its run-config.json, rows, answers and judgments, the unit's frozen
 * contexts (runs/<cell id>/contexts.ndjson) and meters, and each particle-1 re-read's answers and judgments.
 *
 *   Receipts  on set BG1, a receipt whose dataset is not the filled manifest (or one of its earlier fills) or loaded a
 *             file whose SHA-256 the manifest does not pin is refused, and so is a world two receipts of one cell both
 *             hold, an invalid unit, a unit run with --limit, a run config that differs from the committed bg1-cells.json
 *             definition and an instrument other than bg1's. A verdict needs the filled manifest's n_final and every row
 *             holding exactly the first n_final kept worlds; every packed row needs particle-1's paid re-read covering
 *             each of its receipts' run configs.
 *   Values    claude-opus-5-5 and gpt-6.1-sol from the cell and particle-1 from its re-read, joined by question id,
 *             replicate 0. The planned questions are the loaded corpus's questions of the worlds read (the first n_final
 *             kept, wave A, or the dev cells' worlds), so a question no row wrote is planned too. A row outside them
 *             refuses. A product failure scores 0; a harness failure, a missing row, answer or gating judgment is a
 *             drop, by reason and side. The gating view is each reader's mapped judge (bg1JudgeOf); the canonical
 *             gemini-3.8-flash view is descriptive. A gating judgment by the reader's own family, by another judge than
 *             the mapped one, without the gating view or the pinned settings, or without a model version refuses.
 *   Metric    a question's score is the mean over the three readers of correct (100) or not (0); a world's difference is
 *             the mean over its questions in the family of gbrain minus the comparator. One common question set: a
 *             question dropped in any system row leaves every comparison. Above 5% of a comparison's planned questions
 *             (those in its family's strata) dropped, that comparison is descriptive, so the primary family and the
 *             design control share the primary strata's share and the time-indexed family has its own. The worst-case
 *             sensitivity scores every planned question, each gbrain drop 0 and each comparator drop 100, and is
 *             flagged when its words differ.
 *   Gate      a system row whose mean fill rate (rows.ndjson fill_rate, a failed retrieval's null as 0) is below 0.90
 *             makes every comparison it enters descriptive.
 *   Families  primary (strata s1 to s5, gbrain against memory-bank, extract-first and temporal-graph, Holm over the three);
 *             time-indexed (s6 to s8, the same three); design control (gbrain against hybrid search on the primary
 *             strata; when hybrid search is level or ahead, the win cannot be attributed to the design); cost per correct
 *             answer (gbrain's over each comparator's, a world cluster bootstrap of the ratio, Holm over the three; the
 *             first table shows claude-opus-5-5 and particle-1, then gpt-6.1-sol).
 *   Reported  beside every verdict: the paired mean and two-sided 95% interval, the questions where gbrain scored lower,
 *             higher and the same, the restricted wild cluster bootstrap-t, per-reader and per-stratum rows (unadjusted,
 *             descriptive), each row's fill rate, drops by reason and side, the floor, the deterministic matcher's
 *             agreement with each judge view, exposure summaries per row (gold and stale value delivered; deciding line on
 *             raw-text rows), each gating judge's model versions, and the judge check's summary when given.
 *   Pilot     wave A only (the first 12 kept worlds): the per-world SDs of the three primary differences under the gating
 *             view and their correlations, never a mean; then power.ts's N_final. Above 40 it exits 3.
 *   Confirm   BG1-C (docs/benchmarks/2026-11-19-changing-facts-confirmation-preregistration.md and its Amendments 1 to
 *             3; confirm.ts holds its design, rule, words and outcome table). The same receipt checks against the filled
 *             BG1-C manifest (by default eval/decisions/datasets/bg1c-manifest.json; a missing or unfilled one refuses)
 *             and its kept list of 40 BG1-C worlds, for the rows of the BG1-C cell set (by default
 *             eval/runner/q1/cells/bg1c-cells.json), read by claude-opus-5-5, gpt-6.2-sol and particle-1. The release
 *             under test is the cell set's gbrain_build.release; a cell set without one, or a --release that differs,
 *             refuses. A counted row's particle-1 re-reads go under the cell set's half plans (bg1c.ts
 *             bg1cRereadPlans: the re-read cell id with .h1 for launch units 0 to 3, .h2 for 4 to 7), each receipt naming
 *             its plan, half and units: the look reads half 1 only and the final both, each half's re-reads holding
 *             exactly its units' kept worlds, and a re-read under the plain id, a half the stage does not read, a gap or
 *             a world outside its half refuses. A server row whose pilot failed is left out with
 *             --left-out <row>=<reason>: it needs no receipts, its two comparisons
 *             read "not run (pilot failed: <reason>)", and Holm runs over the rest; gbrain's row refuses. The same values
 *             and metric, and the drop cap and fill gate per comparison, a class's drops counting against both of its
 *             comparisons. Each comparison (each server, on what is true now and on questions about the past) gets a
 *             paired t and its z, and confirm.ts's rule turns them into words, the outcome row and its sentences.
 *             --look reads exactly the first 20 kept worlds and writes <out>/look.json, refusing when it already exists,
 *             since no second look counts: "continue" with each comparison's z, conditional power and status, or
 *             "stop" with the full report, also written to confirm.json. Without --look it reads all 40 kept worlds and
 *             writes confirm.json, and refuses unless <out>/look.json says "continue" with the same rows left out. The
 *             worst case reruns the same stage's rule. Reported beside the words: each comparison's interval, counts and
 *             wild bootstrap; per kind, per reader and all 64 questions pooled, unadjusted; fill, drops, exposure, the
 *             matcher's agreement, cost per correct answer (claude-opus-5-5 and particle-1 first, then gpt-6.2-sol) and
 *             the judges' model versions. Beside exposure, scoped_exposure gives the same summaries per row and kind
 *             with scoped-exposure.ts's entity-scoped gold check, the count S5 uses (BG1's correction of 2026-11-16);
 *             each question's entity comes from its world's plan, <GBRAIN_EVALS_BG1C_SOURCE>/worlds/<world>/plan.json,
 *             and a missing plan refuses. brain_counts carries --brain-counts (tagged_facts, slotted_facts and
 *             changing_slots over gbrain's kept brains, whole numbers only), or null, for a tie's "Why null?" cycle.
 *   Pilot     with --set BG1-C, each BG1-C row's pilot (Amendment 1, R111): its smoke cell in the BG1-C cell set (--cells
 *             overrides it), on bg1-dev-01, found under --receipts by that cell's id and its particle-1 re-read, against
 *             the pilot list's conditions. Condition 1: a frozen context (runs/<cell>/contexts.ndjson, matched by the
 *             answers' context hashes) for every one of the 64 questions, a mean fill rate of at least 0.90, for gbrain
 *             --brain-counts' tagged_facts, slotted_facts and changing_slots all above 0, and for each server its stored
 *             memories for the world in --memory-counts ({"memory-bank": n, "extract-first": n}) above 0. Condition 2:
 *             every --judge-check report passes (stop false, every gate passing), is a paid run (the upstream.json
 *             beside it says keyless false) and carries BG1's or BG1-C's judge-check schema, with at least one of each:
 *             BG1's for gpt-6-astra on Opus's answers and claude-opus-5-5 on particle-1's, BG1-C's for claude-opus-5-5
 *             on gpt-6.2-sol's. BG1's published verdict.json (confirm.ts CONFIRM_BG1_VERDICT_PATH, with the bytes
 *             CONFIRM_BG1_VERDICT_SHA256 pins) given as a --judge-check counts as BG1's paid check, read from its
 *             judge_check block. Condition 1 also counts, for each of claude-opus-5-5, gpt-6.2-sol (from the smoke) and
 *             particle-1 (from its re-read), the questions answered at replicate 0 and those with its mapped judge's
 *             gating grade, and needs all 64 of each. Condition 3: the cell's metered spend plus its re-read's reader
 *             and judge spend, per world, at most 1.5 times the row's Budget rate, and the mint's supply check in
 *             --mint-rate (eval/custody/bg1/supply.ts's render/supply.json, per_kept_world over BG1-C's first five
 *             slots) at most 504, 1.5 times the dev mint's 336. It prints each row's ingest wall time per world from the
 *             receipt, writes pilot.json, and exits 3 naming each failing row (or the mint) and condition.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DecideError } from '../decisions/errors.ts';
import { BG1C_SET, bg1Source, loadCorpus, type MemoryQuestion } from '../memory-qa/corpus.ts';
import { instrumentFor } from '../memory-qa/instruments.ts';
import { HARNESS_FAILURES, PRODUCT_FAILURES, type Outcome } from '../memory-qa/outcomes.ts';
import { readRecords, type AnswerRecord, type JudgmentRecord } from '../memory-qa/records.ts';
import { frontierInstrumentId, runConfigIdentity, runConfigText } from '../q1/cell.ts';
import { loadBG1Manifest, OPUS, PARTICLE, SOL } from '../q1/cells/bg1.ts';
import { bg1cRereadPlans } from '../q1/cells/bg1c.ts';
import { bg1JudgeOf, PER_READER_JUDGE_SETTINGS, type CellDefinition } from '../q1/cells/definitions.ts';
import { rereadCellId } from '../q1/reread-cell.ts';
import { holmAdjusted, seededRandom } from '../stats/paired.ts';
import { wildTest } from '../stats/wild-cluster.ts';
import {
  CONFIRM_BG1_VERDICT_PATH, CONFIRM_BG1_VERDICT_SHA256, CONFIRM_BOUND_ALPHA, CONFIRM_CELLS_PATH, CONFIRM_CLASSES, CONFIRM_COMPARISONS, CONFIRM_CONVERSATIONS, CONFIRM_DEV_MINT_REQUESTS, CONFIRM_JUDGE_CHECKS, CONFIRM_LIVE_READERS, CONFIRM_LOOK_N, CONFIRM_MANIFEST_PATH,
  CONFIRM_MANIFEST_REL, CONFIRM_MINT_FACTOR, CONFIRM_MINT_LINE, CONFIRM_MINT_SLOTS, CONFIRM_N, CONFIRM_PILOT_QUESTIONS, CONFIRM_PILOT_WORLD, CONFIRM_READERS, CONFIRM_ROWS, CONFIRM_TABLE_READERS,
  confirmFinal, confirmKeptProblems, confirmLook, confirmOutcome, confirmPilotSpendLine, confirmRow, holmAlphas, leftOutProblems, obfBounds,
  type ConfirmClass, type ConfirmComparison, type ConfirmReading, type ConfirmWord, type LookStatus,
} from './confirm.ts';
import { evidenceOf, exposure, isRawTextRow, summarizeExposure, type Exposure, type ExposureSummary } from './exposure.ts';
import { matchAnswer, MATCH_CLASSES, type MatchClass } from './match.ts';
import { sizeFromPilot, type Bg1Pilot } from './power.ts';
import { BG1_ALPHA, decideFamily, pairedT, type ComparisonVerdict, type VerdictWord } from './rule.ts';
import { scopedExposure, slotEntity } from './scoped-exposure.ts';
import { BG1_N_CAP, BG1_PRIMARY, BG1_SECONDARY, BG1_STRATA, BG1_WAVE_A, type Bg1Stratum } from './types.ts';

export const READERS = [OPUS, SOL, PARTICLE];
/** The first table's reader order: the primary models first (AGENTS.md), then gpt-6.1-sol. */
export const TABLE_READERS = [OPUS, PARTICLE, SOL];
export const FILL_GATE = 0.9;
export const DROP_CAP = 0.05;
export const DRAWS = 9999;
export const SEED = 20261109;
export const MIN_SUBGROUP_WORLDS = 5;

export type Bg1Row = 'gbrain' | 'memory-bank' | 'extract-first' | 'temporal-graph' | 'hybrid' | 'floor';
export const ROLES: Record<string, Bg1Row> = { 'gbrain-defaults': 'gbrain', 'ext-memory-bank': 'memory-bank', 'ext-extract-first': 'extract-first', 'ext-temporal-graph': 'temporal-graph', 'baseline-hybrid': 'hybrid', 'baseline-none': 'floor' };
/** A row's system id (the comparator ids power.ts sizes by). */
export const ROW_SYSTEM = Object.fromEntries(Object.entries(ROLES).map(([s, r]) => [r, s])) as Record<Bg1Row, string>;
export const COMPARATOR_ROWS: readonly Bg1Row[] = ['memory-bank', 'extract-first', 'temporal-graph'];
export const SYSTEM_ROWS: readonly Bg1Row[] = ['gbrain', ...COMPARATOR_ROWS, 'hybrid'];
export type View = 'gating' | 'canonical';

export class VerdictError extends Error {}
const refuse = (m: string): never => { throw new VerdictError(m); };
const sha256 = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const meanOf = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** One reader's answer to one question in one row: its score under each view (0 or 1; null when that view's judgment is missing) and the matcher's class, or why it dropped. */
export type ReaderValue = { gating: number | null; canonical: number | null; match: MatchClass | null } | { drop: string };
export interface QuestionInput {
  id: string; conversation: string; stratum: Bg1Stratum;
  rows: Partial<Record<Bg1Row, Record<string, ReaderValue>>>;
  /** Each row's delivered-context exposure for this question (absent where no frozen context was read). */
  exposure?: Partial<Record<Bg1Row, Exposure>>;
  /** BG1-C: the same contexts with the gold check scoped to the question's entity (scoped-exposure.ts), the count S5 uses. */
  scoped_exposure?: Partial<Record<Bg1Row, Exposure>>;
}
/** One row's spend for one reader on one world, null when a meter is missing. */
export interface CostCell { row: Bg1Row; reader: string; conversation: string; usd: number | null }
export interface Bg1Input {
  set: 'BG1' | 'BG1-dev3' | 'BG1-C';
  questions: QuestionInput[];
  fill: Partial<Record<Bg1Row, number | null>>;
  costs: CostCell[];
  snapshots: Record<string, string[]>;
  /** The readers and system rows the analysis reads, BG1's (READERS, SYSTEM_ROWS) when absent. */
  readers?: readonly string[];
  systemRows?: readonly Bg1Row[];
}

const isDrop = (v: ReaderValue | undefined): v is { drop: string } | undefined => !v || 'drop' in v;
const scoreOf = (v: ReaderValue | undefined, view: View): number | null => (isDrop(v) ? null : v[view]);
const readersOf = (input: Pick<Bg1Input, 'readers'>) => input.readers ?? READERS;
const rowsOf = (input: Pick<Bg1Input, 'systemRows'>) => input.systemRows ?? SYSTEM_ROWS;

// ─── Analysis ────────────────────────────────────────────────────────

/** The common question set: questions every system row answered, for every reader, with a score under the view. */
export function commonSet(input: Pick<Bg1Input, 'questions' | 'readers' | 'systemRows'>, view: View = 'gating'): Set<string> {
  return new Set(input.questions.filter(q => rowsOf(input).every(row => readersOf(input).every(r => scoreOf(q.rows[row]?.[r], view) !== null))).map(q => q.id));
}

export interface Drops { planned: number; dropped: number; share: number; by: Record<string, number> }

/** Questions outside the common set, and each missing value by side (gbrain or a comparison row) and reason. */
export function dropsOf(input: Pick<Bg1Input, 'questions' | 'readers' | 'systemRows'>, view: View = 'gating'): Drops {
  const keep = commonSet(input, view);
  const by: Record<string, number> = {};
  for (const q of input.questions.filter(x => !keep.has(x.id))) for (const row of rowsOf(input)) for (const r of readersOf(input)) {
    const v = q.rows[row]?.[r];
    const reason = !q.rows[row] ? 'row_missing' : !v ? 'answer_missing' : 'drop' in v ? v.drop : v[view] === null ? `judgment_missing:${view}` : null;
    if (reason) { const k = `${row === 'gbrain' ? 'gbrain' : 'other'}|${reason}`; by[k] = (by[k] ?? 0) + 1; }
  }
  const planned = input.questions.length, dropped = planned - keep.size;
  return { planned, dropped, share: planned ? dropped / planned : 0, by: Object.fromEntries(Object.entries(by).sort(([a], [b]) => (a < b ? -1 : 1))) };
}

/** A question's score in points: the mean over the readers of correct x 100; a missing value is null, or the worst case's fill. */
function qScore(q: QuestionInput, row: Bg1Row, view: View, readers: readonly string[], fill: number | null): number | null {
  const xs = readers.map(r => { const s = scoreOf(q.rows[row]?.[r], view); return s === null ? fill : s * 100; });
  return xs.some(x => x === null) ? null : meanOf(xs as number[]);
}

export interface WorldDifference { conversation: string; d: number; n: number }

/**
 * Per-world mean differences, gbrain minus `other`, over the questions of `strata`: within `keep` (the common set), or
 * every question with the worst case's fills (a gbrain drop 0, a comparison drop 100).
 */
export function worldDifferences(input: Pick<Bg1Input, 'questions' | 'readers'>, other: Bg1Row, strata: readonly Bg1Stratum[], o: { view?: View; readers?: readonly string[]; keep?: ReadonlySet<string>; worstCase?: boolean } = {}): WorldDifference[] {
  const view = o.view ?? 'gating', readers = o.readers ?? readersOf(input);
  const by = new Map<string, number[]>();
  for (const q of input.questions) {
    if (!strata.includes(q.stratum) || (o.keep && !o.keep.has(q.id))) continue;
    const g = qScore(q, 'gbrain', view, readers, o.worstCase ? 0 : null), x = qScore(q, other, view, readers, o.worstCase ? 100 : null);
    if (g === null || x === null) continue;
    by.set(q.conversation, [...(by.get(q.conversation) ?? []), g - x]);
  }
  return [...by].sort(([a], [b]) => (a < b ? -1 : 1)).map(([conversation, ds]) => ({ conversation, d: meanOf(ds)!, n: ds.length }));
}

export interface ComparisonRow {
  row: Bg1Row; worlds: number; questions: number;
  verdict: VerdictWord | null; descriptive: string | null;
  test: Omit<ComparisonVerdict, 'comparison'> | null;
  /** Questions (three-reader mean) where gbrain scored lower, higher and the same. */
  worse: number; better: number; same: number;
  wild: { estimate: number; p: number; ci95: [number, number]; method: string } | null;
}
const WILD_METHOD = `restricted wild cluster bootstrap-t over worlds, question-weighted, Webb weights, ${DRAWS} draws, seed ${SEED}, two-sided`;

/** One family's comparisons, Holm across them; a row that fails the fill gate, or a family above the drop cap, is descriptive. */
export function familyRows(input: Bg1Input, rows: readonly Bg1Row[], strata: readonly Bg1Stratum[], keep: ReadonlySet<string>, invalid: readonly string[], view: View = 'gating'): ComparisonRow[] {
  const diffs = new Map(rows.map(r => [r, worldDifferences(input, r, strata, { view, keep })]));
  const enough = rows.every(r => diffs.get(r)!.length >= 2);
  const tests = enough ? decideFamily(Object.fromEntries(rows.map(r => [r, diffs.get(r)!.map(x => x.d)]))) : null;
  return rows.map((row, i) => {
    const ds = diffs.get(row)!;
    const gate = [row, 'gbrain'].filter(x => x !== 'floor' && !((input.fill[x as Bg1Row] ?? 0) >= FILL_GATE)).map(x => `descriptive: ${x} failed the delivered-context gate (mean fill rate ${input.fill[x as Bg1Row] === null || input.fill[x as Bg1Row] === undefined ? 'unknown' : r4(input.fill[x as Bg1Row]!)}, below ${FILL_GATE})`);
    const descriptive = [...invalid, ...gate, ...(enough ? [] : ['too few worlds for a test'])].join('; ') || null;
    const { worse, better, same, wild } = beside(input, row, strata, keep, ds, view);
    const { comparison: _c, ...test } = tests?.[i] ?? { comparison: '' };
    return { row, worlds: ds.length, questions: ds.reduce((s, x) => s + x.n, 0), verdict: tests && !descriptive ? tests[i].verdict : null, descriptive,
      test: tests ? test as Omit<ComparisonVerdict, 'comparison'> : null, worse, better, same, wild };
  });
}

/** What is reported beside a comparison: the questions (the readers' mean, within keep) where gbrain scored lower, higher and the same, and the wild cluster bootstrap of its world differences. */
function beside(input: Bg1Input, row: Bg1Row, strata: readonly Bg1Stratum[], keep: ReadonlySet<string>, ds: readonly WorldDifference[], view: View) {
  let worse = 0, better = 0, same = 0;
  for (const q of input.questions.filter(x => strata.includes(x.stratum) && keep.has(x.id))) {
    const g = qScore(q, 'gbrain', view, readersOf(input), null)!, x = qScore(q, row, view, readersOf(input), null)!;
    if (Math.abs(g - x) < 1e-9) same++; else if (g < x) worse++; else better++;
  }
  const w = ds.length >= 2 ? wildTest(ds.map(x => ({ id: x.conversation, stratum: 'all', n: x.n, sum: x.d * x.n })), { draws: DRAWS, seed: SEED }) : null;
  return { worse, better, same, wild: w ? { estimate: r4(w.theta), p: r4(w.p), ci95: [r4(w.ci95[0]), r4(w.ci95[1])] as [number, number], method: WILD_METHOD } : null };
}

/** A descriptive paired row: the mean of the per-world differences with its unadjusted two-sided 95% interval. */
function subgroup(ds: readonly WorldDifference[]) {
  if (ds.length < MIN_SUBGROUP_WORLDS) return { worlds: ds.length, mean: null, ci95: null, note: 'too few worlds' };
  const t = pairedT(ds.map(x => x.d));
  return { worlds: ds.length, mean: r4(t.mean), ci95: [r4(t.ci95[0]), r4(t.ci95[1])] as [number, number], note: 'unadjusted' };
}

/** Cohen's kappa of two binary raters; null when either rater is constant and they disagree on nothing to compare. */
export function cohenKappa(pairs: ReadonlyArray<readonly [boolean, boolean]>): number | null {
  const n = pairs.length;
  if (!n) return null;
  const po = pairs.filter(([a, b]) => a === b).length / n;
  const pa = pairs.filter(([a]) => a).length / n, pb = pairs.filter(([, b]) => b).length / n;
  const pe = pa * pb + (1 - pa) * (1 - pb);
  return pe === 1 ? null : (po - pe) / (1 - pe);
}

/** The deterministic matcher against one judge view: every answer both scored, by matcher class, and agreement and kappa where the matcher is decisive (not unclear). */
export function matcherAgreement(input: Pick<Bg1Input, 'questions'>, view: View) {
  const table = Object.fromEntries(MATCH_CLASSES.map(c => [c, { judged_correct: 0, judged_wrong: 0 }])) as Record<MatchClass, { judged_correct: number; judged_wrong: number }>;
  const pairs: Array<[boolean, boolean]> = [];
  for (const q of input.questions) for (const vals of Object.values(q.rows)) for (const v of Object.values(vals ?? {})) {
    if (isDrop(v) || v.match === null || v[view] === null) continue;
    const judged = v[view] === 1;
    table[v.match][judged ? 'judged_correct' : 'judged_wrong']++;
    if (v.match !== 'unclear') pairs.push([v.match === 'correct', judged]);
  }
  const answers = Object.values(table).reduce((s, x) => s + x.judged_correct + x.judged_wrong, 0);
  const k = cohenKappa(pairs);
  return { view, answers, decisive: pairs.length, agreement: pairs.length ? r4(pairs.filter(([a, b]) => a === b).length / pairs.length) : null, kappa: k === null ? null : r4(k), table };
}

/** Each row's exposure over every planned question, and by stratum; `count` picks the exposure records, exposure.ts's by default. */
export function exposureSummaries(input: Pick<Bg1Input, 'questions'>, count: (q: QuestionInput) => QuestionInput['exposure'] = q => q.exposure): Partial<Record<Bg1Row, { all: ExposureSummary; by_stratum: Partial<Record<Bg1Stratum, ExposureSummary>> }>> {
  const rows = [...new Set(input.questions.flatMap(q => Object.keys(count(q) ?? {})))] as Bg1Row[];
  return Object.fromEntries(rows.sort().map(row => {
    const of = (qs: readonly QuestionInput[]) => summarizeExposure(qs.flatMap(q => { const e = count(q)?.[row]; return e ? [e] : []; }));
    return [row, { all: of(input.questions), by_stratum: Object.fromEntries(BG1_STRATA.map(s => [s, of(input.questions.filter(q => q.stratum === s))])) }];
  }));
}

/**
 * Cost per correct answer: each row's spend over its correct answers by reader, and gbrain's ratio to each comparator
 * (all readers) with a world cluster bootstrap, Holm across the comparators. BG1's rows, comparators and table order
 * unless given.
 */
export function costPerCorrect(input: Bg1Input, keep: ReadonlySet<string>, o: { rows?: readonly Bg1Row[]; comparators?: readonly Bg1Row[]; tableReaders?: readonly string[] } = {}) {
  const rows = o.rows ?? [...SYSTEM_ROWS, 'floor' as Bg1Row], all = readersOf(input);
  const worlds = [...new Set(input.questions.map(q => q.conversation))].sort();
  const cells = new Map<string, { usd: number | null; correct: number }>();
  const key = (row: Bg1Row, reader: string, conv: string) => `${row}|${reader}|${conv}`;
  for (const row of rows) for (const reader of all) for (const conv of worlds) {
    const c = input.costs.find(x => x.row === row && x.reader === reader && x.conversation === conv);
    cells.set(key(row, reader, conv), { usd: c ? c.usd : null, correct: 0 });
  }
  for (const q of input.questions) for (const row of rows) {
    if (row !== 'floor' && !keep.has(q.id)) continue;
    for (const reader of all) cells.get(key(row, reader, q.conversation))!.correct += scoreOf(q.rows[row]?.[reader], row === 'floor' ? 'canonical' : 'gating') ?? 0;
  }
  const ratio = (row: Bg1Row, readers: readonly string[], ws: readonly string[]) => {
    let usd = 0, correct = 0;
    for (const w of ws) for (const r of readers) { const c = cells.get(key(row, r, w))!; if (c.usd === null) return null; usd += c.usd; correct += c.correct; }
    return correct ? usd / correct : null;
  };
  const table = (o.tableReaders ?? TABLE_READERS).map(reader => ({ reader, usd_per_correct: Object.fromEntries(rows.map(row => { const x = ratio(row, [reader], worlds); return [row, x === null ? null : r4(x)]; })) }));
  const rand = seededRandom(SEED);
  const draws = Array.from({ length: DRAWS }, () => worlds.map(() => worlds[Math.floor(rand() * worlds.length)]));
  const tests = (o.comparators ?? COMPARATOR_ROWS).map(row => {
    const g = ratio('gbrain', all, worlds), x = ratio(row, all, worlds);
    if (g === null || x === null) return { row, ratio: null, ci95: null, p_ahead: 1, p_behind: 1, note: 'n/a: a meter or a re-read reader spend is missing' };
    const boot = draws.map(ws => { const a = ratio('gbrain', all, ws), b = ratio(row, all, ws); return a !== null && b ? a / b : null; }).filter((v): v is number => v !== null).sort((a, b) => a - b);
    const at = (p: number) => boot[Math.min(boot.length - 1, Math.max(0, Math.floor(p * boot.length)))];
    return { row, ratio: r4(g / x), ci95: [r4(at(0.025)), r4(at(0.975))] as [number, number], p_ahead: (boot.filter(v => v >= 1).length + 1) / (boot.length + 1), p_behind: (boot.filter(v => v <= 1).length + 1) / (boot.length + 1), note: null };
  });
  const ahead = holmAdjusted(tests.map(t => t.p_ahead)), behind = holmAdjusted(tests.map(t => t.p_behind));
  return { table, method: `world cluster bootstrap of the ratio, ${DRAWS} draws, seed ${SEED}; ahead means gbrain's cost per correct answer is below the comparator's`,
    comparisons: tests.map((t, i) => ({ ...t, p_ahead: r4(t.p_ahead), p_behind: r4(t.p_behind), p_ahead_holm: r4(ahead[i]), p_behind_holm: r4(behind[i]),
      verdict: (t.ratio === null ? null : ahead[i] <= BG1_ALPHA ? 'ahead' : behind[i] <= BG1_ALPHA ? 'behind' : 'no measurable difference') as VerdictWord | null })) };
}

export function analyze(input: Bg1Input, opts: { judgeCheck?: unknown } = {}) {
  const keep = commonSet(input, 'gating');
  const drops = dropsOf(input, 'gating');
  const capped = (strata: readonly Bg1Stratum[]) => {
    const d = dropsOf({ questions: input.questions.filter(q => strata.includes(q.stratum)) }, 'gating');
    return { drops: d, invalid: d.share > DROP_CAP ? [`${d.dropped} of ${d.planned} planned questions dropped (${(d.share * 100).toFixed(1)}%, above the 5% cap)`] : [] };
  };
  const primaryCap = capped(BG1_PRIMARY), timeCap = capped(BG1_SECONDARY);
  const invalid = [...primaryCap.invalid.map(x => `primary: ${x}`), ...timeCap.invalid.map(x => `time-indexed: ${x}`)];
  const primary = familyRows(input, COMPARATOR_ROWS, BG1_PRIMARY, keep, primaryCap.invalid);
  const worstDiffs = COMPARATOR_ROWS.map(r => worldDifferences(input, r, BG1_PRIMARY, { worstCase: true }));
  const worst = worstDiffs.every(d => d.length >= 2) ? decideFamily(Object.fromEntries(COMPARATOR_ROWS.map((r, i) => [r, worstDiffs[i].map(x => x.d)]))).map(v => v.verdict) : null;
  const design = familyRows(input, ['hybrid'], BG1_PRIMARY, keep, primaryCap.invalid)[0];
  const canonicalKeep = commonSet(input, 'canonical');
  const rowMeans = Object.fromEntries([...SYSTEM_ROWS, 'floor' as Bg1Row].map(row => [row, Object.fromEntries(READERS.map(r => {
    const view: View = row === 'floor' ? 'canonical' : 'gating';
    const xs = input.questions.filter(q => row === 'floor' || keep.has(q.id)).flatMap(q => { const s = scoreOf(q.rows[row]?.[r], view); return s === null ? [] : [s * 100]; });
    const m = meanOf(xs);
    return [r, m === null ? null : r4(m)];
  }))]));
  const mixed = Object.entries(input.snapshots).filter(([, vs]) => vs.length > 1).map(([j]) => j);
  return {
    schema: 'gbrain-evals/bg1-verdict/v1', set: input.set, worlds: new Set(input.questions.map(q => q.conversation)).size, planned: drops.planned, common: keep.size,
    drops, invalid_reasons: invalid,
    fill: Object.fromEntries(SYSTEM_ROWS.map(r => [r, { mean_fill: input.fill[r] === undefined || input.fill[r] === null ? null : r4(input.fill[r]!), pass: (input.fill[r] ?? 0) >= FILL_GATE }])),
    primary: { strata: BG1_PRIMARY, holm_over: COMPARATOR_ROWS, drops: primaryCap.drops, comparisons: primary,
      worst_case: { verdicts: worst, disagrees: worst !== null && worst.some((w, i) => primary[i].verdict !== null && w !== primary[i].verdict) } },
    time_indexed: { strata: BG1_SECONDARY, holm_over: COMPARATOR_ROWS, drops: timeCap.drops, comparisons: familyRows(input, COMPARATOR_ROWS, BG1_SECONDARY, keep, timeCap.invalid) },
    design_control: { comparison: design, attributable_to_design: design.verdict === 'ahead',
      note: design.verdict === 'ahead' ? null : 'hybrid search is level with or ahead of gbrain on the primary strata, so a primary win cannot be attributed to the design' },
    cost_per_correct: costPerCorrect(input, keep),
    per_reader: READERS.map(reader => ({ reader, rows: Object.fromEntries([...COMPARATOR_ROWS, 'hybrid' as Bg1Row].map(row => [row, subgroup(worldDifferences(input, row, BG1_PRIMARY, { readers: [reader], keep }))])) })),
    per_stratum: BG1_STRATA.map(stratum => ({ stratum, rows: Object.fromEntries([...COMPARATOR_ROWS, 'hybrid' as Bg1Row].map(row => [row, subgroup(worldDifferences(input, row, [stratum], { keep }))])) })),
    canonical_view: { note: 'descriptive: the canonical gemini-3.8-flash judge on every answer; only the gating view decides', common: canonicalKeep.size,
      primary: familyRows(input, COMPARATOR_ROWS, BG1_PRIMARY, canonicalKeep, [], 'canonical').map(r => ({ row: r.row, worlds: r.worlds, words: r.test?.verdict ?? null, mean: r.test ? r4(r.test.mean) : null, ci95: r.test ? r.test.ci95.map(r4) : null })) },
    row_means: rowMeans,
    matcher: { gating: matcherAgreement(input, 'gating'), canonical: matcherAgreement(input, 'canonical') },
    exposure: exposureSummaries(input),
    judges: { versions: input.snapshots, mixed_snapshot: mixed },
    judge_check: opts.judgeCheck ?? null,
  };
}
export type Analysis = ReturnType<typeof analyze>;

/** The aggregate counts from gbrain's kept brains (the dev loop's free query): facts with a name tag, facts with a slot, and changing slots. */
export const BRAIN_COUNTS = ['tagged_facts', 'slotted_facts', 'changing_slots'] as const;
export type BrainCounts = Readonly<Record<typeof BRAIN_COUNTS[number], number>>;

/** Brain counts as confirm reports them: exactly the three counts, each a whole number of at least 0, so only counts leave custody. */
export function confirmBrainCounts(x: unknown): BrainCounts {
  const c = x as Record<string, unknown> | null;
  const keys = c && typeof c === 'object' && !Array.isArray(c) ? Object.keys(c).sort() : null;
  if (!keys || JSON.stringify(keys) !== JSON.stringify([...BRAIN_COUNTS].sort()) || !BRAIN_COUNTS.every(k => Number.isInteger(c![k]) && (c![k] as number) >= 0)) {
    refuse(`--brain-counts must hold exactly ${BRAIN_COUNTS.join(', ')}, each a whole number of at least 0`);
  }
  return Object.fromEntries(BRAIN_COUNTS.map(k => [k, c![k] as number])) as BrainCounts;
}

/** What confirm reads beside the receipts: the gbrain release under test, the server rows left out after a failed pilot with each one's reason (R111), the judge check's summary, and the counts from gbrain's kept brains. */
export interface ConfirmOptions { release: string; leftOut?: Readonly<Record<string, string>>; judgeCheck?: unknown; brainCounts?: BrainCounts }

const leftOutList = (leftOut: Readonly<Record<string, string>>) => CONFIRM_ROWS.filter(r => r in leftOut).map(row => ({ row, reason: leftOut[row] }));

/** The comparisons that run on a BG1-C input that must hold the given number of worlds: their world differences, paired t's and why each is descriptive (the drop cap and fill gate per comparison, a class's drops counting against both of its comparisons). */
function confirmPrep(raw: Bg1Input, o: ConfirmOptions, worlds: number) {
  if (raw.set !== 'BG1-C') refuse(`the confirm mode reads set BG1-C only, not ${raw.set}`);
  const leftOut = o.leftOut ?? {};
  const bad = leftOutProblems(leftOut);
  if (bad.length) refuse(bad.join('; '));
  const input: Bg1Input = { ...raw, readers: CONFIRM_READERS, systemRows: CONFIRM_ROWS.filter(r => !(r in leftOut)) };
  const held = new Set(input.questions.map(q => q.conversation)).size;
  if (held !== worlds) refuse(worlds === CONFIRM_LOOK_N ? `the look reads the first ${CONFIRM_LOOK_N} kept worlds, and the input holds ${held}` : `the final analysis reads all ${CONFIRM_N} kept worlds, and the input holds ${held}`);
  const keep = commonSet(input, 'gating');
  const run = CONFIRM_COMPARISONS.filter(c => !(c.server in leftOut));
  const strataOf = (cls: ConfirmClass): readonly Bg1Stratum[] => CONFIRM_CLASSES[cls].strata;
  const classes = [...new Set(run.map(c => c.cls))];
  const classDrops = Object.fromEntries(classes.map(cls => [cls, dropsOf({ ...input, questions: input.questions.filter(q => strataOf(cls).includes(q.stratum)) }, 'gating')])) as Partial<Record<ConfirmClass, Drops>>;
  const testsOf = (diffs: readonly WorldDifference[][]) => (diffs.every(d => d.length >= 2) ? diffs.map(d => pairedT(d.map(x => x.d))) : null);
  const diffs = run.map(c => worldDifferences(input, c.server, strataOf(c.cls), { keep }));
  const tests = testsOf(diffs);
  const fillOf = (row: Bg1Row) => (input.fill[row] === undefined || input.fill[row] === null ? null : r4(input.fill[row]!));
  const descriptive = run.map(c => {
    const d = classDrops[c.cls]!;
    return [
      ...(d.share > DROP_CAP ? [`${d.dropped} of ${d.planned} planned questions on ${CONFIRM_CLASSES[c.cls].name} dropped (${(d.share * 100).toFixed(1)}%, above the 5% cap)`] : []),
      ...(['gbrain', c.server] as Bg1Row[]).filter(row => !((input.fill[row] ?? 0) >= FILL_GATE)).map(row => `${row} failed the delivered-context gate (mean fill rate ${fillOf(row) ?? 'unknown'}, below ${FILL_GATE})`),
      ...(tests ? [] : ['too few worlds for a test']),
    ].join('; ') || null;
  });
  const confirmTests = tests ? run.map((c, i) => ({ key: c.key, test: tests[i], descriptive: descriptive[i] })) : null;
  const worst = () => { const t = testsOf(run.map(c => worldDifferences(input, c.server, strataOf(c.cls), { worstCase: true }))); return t ? run.map((c, i) => ({ key: c.key, test: t[i] })) : null; };
  return { input, keep, leftOut, run, strataOf, classDrops, diffs, tests, descriptive, fillOf, confirmTests, worst };
}
type ConfirmPrep = ReturnType<typeof confirmPrep>;
type StageReading = { word: ConfirmWord; z: number; lower: number; upper: number; cp?: number; status?: LookStatus };

/** The report at a stop or at the final: the words, the outcome row and its sentences, the worst case, and every report the preregistration puts beside them that receipts can give. */
function confirmReport(p: ConfirmPrep, o: ConfirmOptions, stage: 'look' | 'final', readings: readonly StageReading[] | null, worstWords: readonly ConfirmWord[] | null) {
  const { input, keep, run, strataOf, classDrops, diffs, tests, descriptive, fillOf } = p;
  const rows = input.systemRows!, servers = [...new Set(run.map(c => c.server))];
  const classes = [...new Set(run.map(c => c.cls))];
  const comparisons = run.map((c, i) => ({
    key: c.key, class: c.cls, server: c.server, worlds: diffs[i].length, questions: diffs[i].reduce((s, x) => s + x.n, 0), word: readings ? readings[i].word : null, descriptive: descriptive[i],
    z: readings ? r4(readings[i].z) : null,
    ...(stage === 'look' ? { cp: readings ? r4(readings[i].cp!) : null, status: readings ? readings[i].status! : null } : {}),
    three_point: readings ? { alpha: CONFIRM_BOUND_ALPHA, lower: r4(readings[i].lower), upper: r4(readings[i].upper) } : null,
    test: tests ? tests[i] : null, ...beside(input, c.server, strataOf(c.cls), keep, diffs[i], 'gating'),
  }));
  const reading = (c: ConfirmComparison, word: (i: number) => ConfirmWord | null): ConfirmReading => {
    const i = run.indexOf(c);
    return i < 0 ? { key: c.key, word: null, descriptive: null, notRun: p.leftOut[c.server] } : { key: c.key, word: word(i), descriptive: descriptive[i], mean: tests?.[i].mean ?? null, ci95: tests?.[i].ci95 ?? null };
  };
  const words = CONFIRM_COMPARISONS.map(c => reading(c, i => comparisons[i].word));
  const worst = worstWords ? CONFIRM_COMPARISONS.map(c => reading(c, i => worstWords[i])) : null;
  const alphas = holmAlphas(run.length);
  const vsServers = (strata: readonly Bg1Stratum[], readers?: readonly string[]) => Object.fromEntries(servers.map(s => [s, subgroup(worldDifferences(input, s, strata, { keep, readers }))]));
  return {
    schema: 'gbrain-evals/bg1c-verdict/v1', set: input.set, release: o.release, stage, worlds: new Set(input.questions.map(q => q.conversation)).size, planned: input.questions.length, common: keep.size,
    outcome: confirmOutcome(words, { release: o.release, worstCase: worst ?? undefined, stopped: stage === 'look' }),
    left_out: leftOutList(p.leftOut),
    holm_over: run.map(c => c.key),
    bounds: { stage, holm_alphas: alphas, z: alphas.map(a => r4(obfBounds(a)[stage])), three_point_alpha: CONFIRM_BOUND_ALPHA },
    comparisons,
    not_run: CONFIRM_COMPARISONS.filter(c => !run.includes(c)).map(c => ({ key: c.key, class: c.cls, server: c.server, status: `not run (pilot failed: ${p.leftOut[c.server]})` })),
    worst_case: { words: worst ? worst.map(w => w.word) : null, row: worst ? confirmRow(worst) : null, disagrees: worst !== null && worst.some((w, i) => w.word !== words[i].word) },
    drops: { all: dropsOf(input, 'gating'), by_class: classDrops },
    fill: Object.fromEntries(rows.map(r => [r, { mean_fill: fillOf(r), pass: (input.fill[r] ?? 0) >= FILL_GATE }])),
    per_kind: BG1_STRATA.map(stratum => ({ stratum, rows: vsServers([stratum]) })),
    per_reader: CONFIRM_READERS.map(reader => ({ reader, classes: Object.fromEntries(classes.map(cls => [cls, vsServers(strataOf(cls), [reader])])) })),
    pooled: { strata: BG1_STRATA, rows: vsServers(BG1_STRATA) },
    row_means: Object.fromEntries(rows.map(row => [row, Object.fromEntries(CONFIRM_READERS.map(r => {
      const m = meanOf(input.questions.filter(q => keep.has(q.id)).flatMap(q => { const s = scoreOf(q.rows[row]?.[r], 'gating'); return s === null ? [] : [s * 100]; }));
      return [r, m === null ? null : r4(m)];
    }))])),
    matcher: matcherAgreement(input, 'gating'),
    exposure: exposureSummaries(input),
    scoped_exposure: input.questions.some(q => q.scoped_exposure) ? exposureSummaries(input, q => q.scoped_exposure) : null,
    brain_counts: o.brainCounts ?? null,
    cost_per_correct: costPerCorrect(input, keep, { rows, comparators: servers, tableReaders: CONFIRM_TABLE_READERS }),
    judges: { versions: input.snapshots, mixed_snapshot: Object.entries(input.snapshots).filter(([, vs]) => vs.length > 1).map(([j]) => j) },
    judge_check: o.judgeCheck ?? null,
  };
}
export type ConfirmAnalysis = ReturnType<typeof confirmReport>;

/**
 * BG1-C's final analysis (confirm.ts; Amendments 1 and 2) on all 40 kept worlds: BG1's values and metric over gbrain and
 * the servers that run, the drop cap and fill gate per comparison, Holm's step-down over the comparisons' z's with the
 * final bounds, the 3-point readings, the same rule once more for the worst case, the outcome row from confirm.ts, and
 * every report the preregistration puts beside them that receipts can give.
 */
export function analyzeConfirm(raw: Bg1Input, o: ConfirmOptions): ConfirmAnalysis {
  const p = confirmPrep(raw, o, CONFIRM_N);
  const worst = p.worst();
  return confirmReport(p, o, 'final', p.confirmTests ? confirmFinal(p.confirmTests) : null, worst ? confirmFinal(worst).map(w => w.word) : null);
}

/**
 * BG1-C's one look (Amendment 1, with Amendment 2's bounds) on the first 20 kept worlds. Unless every comparison that runs
 * has crossed or is futile, it decides nothing: "continue", with each comparison's z, conditional power and status and
 * nothing else. When the run stops, the record carries the full report: crossed comparisons keep their word, the rest
 * take the 3-point readings on the 20 worlds, and the results say the run stopped at its look.
 */
export function lookConfirm(raw: Bg1Input, o: ConfirmOptions) {
  const p = confirmPrep(raw, o, CONFIRM_LOOK_N);
  const look = p.confirmTests ? confirmLook(p.confirmTests) : null;
  const comparisons = CONFIRM_COMPARISONS.map(c => {
    const i = p.run.indexOf(c), l = look?.comparisons[i];
    if (i < 0) return { key: c.key, z: null, cp: null, status: 'not run', reason: `pilot failed: ${p.leftOut[c.server]}` };
    return { key: c.key, z: l ? r4(l.z) : null, cp: l ? r4(l.cp) : null, status: l?.status ?? 'descriptive', reason: p.descriptive[i] };
  });
  const record = { schema: 'gbrain-evals/bg1c-look/v1', release: o.release, worlds: CONFIRM_LOOK_N, left_out: leftOutList(p.leftOut), comparisons };
  if (!look?.stop) return { ...record, decision: 'continue' as const, verdict: null };
  const worst = p.worst();
  return { ...record, decision: 'stop' as const, verdict: confirmReport(p, o, 'look', look.comparisons, worst ? confirmLook(worst).comparisons.map(w => w.word) : null) };
}
export type ConfirmLook = ReturnType<typeof lookConfirm>;

const pearson = (a: readonly number[], b: readonly number[]) => {
  const ma = meanOf(a)!, mb = meanOf(b)!;
  const cov = a.reduce((s, x, i) => s + (x - ma) * (b[i] - mb), 0), va = a.reduce((s, x) => s + (x - ma) ** 2, 0), vb = b.reduce((s, x) => s + (x - mb) ** 2, 0);
  return va && vb ? cov / Math.sqrt(va * vb) : null;
};

/** The pilot's output: the three primary differences' per-world SDs under the gating view and their correlations, never a mean. */
export function pilotStats(input: Bg1Input): Bg1Pilot {
  const keep = commonSet(input, 'gating');
  const diffs = COMPARATOR_ROWS.map(r => new Map(worldDifferences(input, r, BG1_PRIMARY, { keep }).map(x => [x.conversation, x.d])));
  const worlds = [...diffs[0].keys()].filter(w => diffs.every(m => m.has(w))).sort();
  if (worlds.length < 2) refuse(`the pilot needs at least two worlds every comparison scored, and has ${worlds.length}`);
  const col = (i: number) => worlds.map(w => diffs[i].get(w)!);
  const sds = Object.fromEntries(COMPARATOR_ROWS.map((r, i) => [ROW_SYSTEM[r], r4(pairedT(col(i)).sd)]));
  const correlations: Record<string, number | null> = {};
  for (let i = 0; i < COMPARATOR_ROWS.length; i++) for (let j = i + 1; j < COMPARATOR_ROWS.length; j++) { const c = pearson(col(i), col(j)); correlations[`${ROW_SYSTEM[COMPARATOR_ROWS[i]]}|${ROW_SYSTEM[COMPARATOR_ROWS[j]]}`] = c === null ? null : r4(c); }
  return { schema: 'gbrain-evals/bg1-pilot/v1', worlds: worlds.length, view: 'gating', family: 'primary', sds, correlations };
}


// ─── Receipts ────────────────────────────────────────────────────────

/** The filled manifest's path in a receipt's dataset (the loader lists it first, then every file it read). */
export const BG1_MANIFEST_REL = 'eval/decisions/datasets/bg1-manifest.json';
/** A filled manifest a receipt's dataset names first: its path in the repository and the set it pins. */
export interface ManifestRef { rel: string; name: string }
export const BG1_MANIFEST_REF: ManifestRef = { rel: BG1_MANIFEST_REL, name: 'BG1' };
export const CONFIRM_MANIFEST_REF: ManifestRef = { rel: CONFIRM_MANIFEST_REL, name: 'BG1-C' };

interface CellFiles { dir: string; root: string; receipt: Record<string, any>; config: Record<string, any> | null }
const readLoose = (path: string): Array<Record<string, any>> => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)) : []);

function findReceipts(dirs: readonly string[]): CellFiles[] {
  return dirs.flatMap(root => {
    const cells = join(root, 'cells');
    if (!existsSync(cells)) refuse(`${root} has no cells/ directory`);
    return readdirSync(cells).sort().filter(d => existsSync(join(cells, d, 'receipt.json'))).map(d => {
      const dir = join(cells, d);
      const config = existsSync(join(dir, 'run-config.json')) ? JSON.parse(readFileSync(join(dir, 'run-config.json'), 'utf8')) : null;
      return { dir, root, receipt: JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8')), config };
    });
  });
}

/** The filled BG1 manifest as verdict.ts reads it: status, pinned files, the kept list and n_final, and earlier fills. */
export interface FilledManifest { status: string; files: Array<{ path: string; sha256: string }>; kept?: string[]; n_final?: number | null; earlier_fills?: string[] }

/**
 * The corpus files a set-BG1 verdict loaded at bytes its --manifest does not pin (the loader pins against
 * GBRAIN_EVALS_BG1_MANIFEST, or nothing). The loader lists the manifest itself first, which pins every other file but
 * not itself, so that entry is checked against the --manifest's own SHA-256 and every other file against its pins.
 */
export function unpinnedCorpusFiles(files: ReadonlyArray<{ path: string; sha256: string }>, manifest: FilledManifest, manifestSha: string, rel = BG1_MANIFEST_REL): string[] {
  const pins = new Map([...manifest.files.map(f => [f.path, f.sha256] as const), [rel, manifestSha] as const]);
  return files.filter(f => pins.get(f.path) !== f.sha256).map(f => f.path);
}

/** A set-BG1 (or BG1-C) receipt must come from its filled manifest (or one of its earlier fills) and load only its pinned bytes. */
export function receiptManifestProblems(dataset: Record<string, any> | undefined, manifest: FilledManifest, manifestSha: string, ref: ManifestRef = BG1_MANIFEST_REF): string[] {
  if (!dataset) return ['it records no dataset'];
  if (dataset.revision === 'unfilled') return ['its dataset revision is unfilled'];
  const [head, ...files] = (dataset.files ?? []) as Array<{ path: string; sha256: string }>;
  if (head?.path !== ref.rel) return [`its dataset is not the ${ref.name} manifest (${head?.path ?? 'no files'})`];
  const problems: string[] = [];
  if (![manifestSha, ...(manifest.earlier_fills ?? [])].includes(head.sha256)) problems.push(`its ${ref.name} manifest SHA-256 ${head.sha256.slice(0, 12)} is not the filled manifest's (${manifestSha.slice(0, 12)}) or an earlier fill's`);
  for (const f of files) {
    const pinned = manifest.files.find(x => x.path === f.path);
    if (!pinned) problems.push(`it loaded ${f.path}, which the filled manifest does not pin`);
    else if (pinned.sha256 !== f.sha256) problems.push(`its ${f.path} has SHA-256 ${f.sha256.slice(0, 12)}, the manifest pins ${pinned.sha256.slice(0, 12)}`);
  }
  return problems;
}

/**
 * Why a gating judgment (<instrument>@<judge>) cannot count: its judge shares the reader's family or is not the reader's
 * mapped judge (bg1JudgeOf), it does not record the gating view, it was not sent at the pinned settings, or a scored
 * judgment records no model version. Other judgments pass.
 */
export function gatingProblems(j: Pick<JudgmentRecord, 'answer_id' | 'instrument_id' | 'judge' | 'outcome' | 'view' | 'settings' | 'judge_versions'>, reader: string | undefined, instrument: string): string[] {
  if (!reader || !j.instrument_id.startsWith(`${instrument}@`)) return [];
  const who = `answer ${j.answer_id.slice(0, 12)} (${reader})`;
  let mapped: string;
  try { mapped = bg1JudgeOf(reader); } catch (e) { return [`${who}: ${(e as Error).message}`]; }
  const p: string[] = [];
  if (j.judge.split(':')[0] === reader.split(':')[0]) p.push(`${who} has a gating judgment by ${j.judge}, a judge of its own family (GST-767)`);
  if (j.judge !== mapped || j.instrument_id !== frontierInstrumentId(instrument, mapped)) p.push(`${who} has a gating judgment by ${j.judge} under ${j.instrument_id}, not its mapped judge ${mapped}`);
  if (j.view !== 'gating') p.push(`${who} has a gating judgment that does not record the gating view`);
  if (JSON.stringify(j.settings ?? null) !== JSON.stringify(PER_READER_JUDGE_SETTINGS)) p.push(`${who} has a gating judgment sent at ${JSON.stringify(j.settings ?? null)}, not the pinned ${JSON.stringify(PER_READER_JUDGE_SETTINGS)}`);
  if (j.outcome === 'scored' && !j.judge_versions?.length) p.push(`${who} has a gating judgment that records no judge model version`);
  return p;
}

/** One answer's value: product failures 0, harness failures and a missing judgment dropped by reason; the floor has the canonical view only. */
export function readerValue(a: Pick<AnswerRecord, 'answer_id' | 'reader' | 'outcome' | 'text'>, score: ReadonlyMap<string, number | null>, instrument: string, q: Pick<MemoryQuestion, 'id' | 'bg1'>, floor = false): ReaderValue {
  const outcome = a.outcome as Outcome;
  if (PRODUCT_FAILURES.has(outcome)) return { gating: floor ? null : 0, canonical: 0, match: null };
  if (HARNESS_FAILURES.has(outcome) || (outcome !== 'scored' && outcome !== 'ingest_degraded')) return { drop: outcome };
  const canonical = score.get(`${a.answer_id}|${instrument}`);
  const match = matchAnswer(q, a.text);
  if (floor) return typeof canonical === 'number' ? { gating: null, canonical, match } : { drop: 'judgment_missing:canonical' };
  const gating = score.get(`${a.answer_id}|${frontierInstrumentId(instrument, bg1JudgeOf(a.reader))}`);
  if (typeof gating !== 'number') return { drop: 'judgment_missing:gating' };
  return { gating, canonical: typeof canonical === 'number' ? canonical : null, match };
}

/** A run config with the fields one launch unit may differ in left out: its dataset files, its scheduled questions and its limit (refused separately). */
const unitIdentity = (config: Record<string, any>): Record<string, any> => { const { dataset: _d, scheduled_sha256: _s, limit: _l, ...rest } = config; return JSON.parse(runConfigIdentity(JSON.stringify(rest))); };
const differing = (a: Record<string, any>, b: Record<string, any>, at = ''): string[] => [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(k =>
  JSON.stringify(a[k]) === JSON.stringify(b[k]) ? [] : a[k] && b[k] && typeof a[k] === 'object' && typeof b[k] === 'object' && !Array.isArray(a[k]) ? differing(a[k], b[k], `${at}${k}.`) : [`${at}${k}`]);
const more = (xs: readonly string[]) => xs.slice(0, 3).join('; ') + (xs.length > 3 ? ` (and ${xs.length - 3} more)` : '');

/** The BG1-C cell set's counted rows: exactly one cell each for gbrain and the two servers, on one set, read live by claude-opus-5-5 and gpt-6.2-sol. */
export function confirmCells(cells: readonly CellDefinition[]): CellDefinition[] {
  const rows = cells.filter(c => CONFIRM_ROWS.includes(ROLES[c.system]));
  const counts = CONFIRM_ROWS.flatMap(r => { const n = rows.filter(c => ROLES[c.system] === r).length; return n === 1 ? [] : [`${ROW_SYSTEM[r]} has ${n}`]; });
  if (counts.length) refuse(`the BG1-C cell set needs exactly one counted cell each for gbrain and the two servers; ${counts.join(', ')}`);
  const sets = [...new Set(rows.map(c => c.arms[0].set))];
  if (sets.length !== 1) refuse(`the BG1-C cell set's rows run on more than one set (${sets.join(', ')})`);
  const off = rows.filter(c => JSON.stringify(c.arms[0].readers) !== JSON.stringify(CONFIRM_LIVE_READERS)).map(c => `${c.id} reads with ${(c.arms[0].readers ?? []).join(', ')}`);
  if (off.length) refuse(`every BG1-C row is read live by ${CONFIRM_LIVE_READERS.join(' and ')}; ${off.join('; ')}`);
  return CONFIRM_ROWS.map(r => rows.find(c => ROLES[c.system] === r)!);
}
const readCellSet = (path: string, key: 'cells' | 'smoke_cells' = 'cells'): CellDefinition[] => (existsSync(path)
  ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, CellDefinition[] | undefined>)[key] ?? refuse(`${path} lists no ${key === 'cells' ? 'cells' : 'smoke cells'}`)
  : refuse(`the BG1-C cell set ${path} does not exist; pass --cells <file>`));
const readConfirmManifest = (path: string) => (existsSync(path) ? readFileSync(path) : refuse(`the BG1-C manifest ${path} does not exist; verdict.ts reads receipts only against the filled manifest`));
const bg1Cells = (set: LoadOptions['set']) => { const cells = loadBG1Manifest(); return (set === 'BG1' ? cells.cells : cells.smoke_cells).filter(c => c.arms[0].set === set && ROLES[c.system]); };

/** How loadInput reads receipts. On set BG1-C, look reads exactly the first 20 kept worlds, and leftOut names server rows left out after a failed pilot, which need no receipts. */
export interface LoadOptions { set: 'BG1' | 'BG1-dev3' | 'BG1-C'; manifestPath?: string; waveA?: boolean; cellsPath?: string; look?: boolean; leftOut?: readonly Bg1Row[] }
/** A world's plan, as far as scoped exposure reads it: the entities its slots belong to. */
export interface WorldPlan { entities: ReadonlyArray<{ id: string; name: string }> }
export interface LoadDeps { questions?: readonly MemoryQuestion[]; manifestBytes?: Uint8Array; cells?: readonly CellDefinition[]; plans?: ReadonlyMap<string, WorldPlan> }

/**
 * Each planned BG1-C question's entity, named from its world's plan (scoped-exposure.ts slotEntity), for S5's scoped
 * exposure. The plans are `plans` when given, else <GBRAIN_EVALS_BG1C_SOURCE>/worlds/<world>/plan.json, beside the
 * worlds the bg1c loader reads in custody. A missing plan, or a slot whose entity the plan does not list, refuses.
 */
function confirmEntities(qs: readonly MemoryQuestion[], plans?: ReadonlyMap<string, WorldPlan>): Map<string, string> {
  const root = plans ? '' : join(bg1Source(process.env, BG1C_SET), 'worlds');
  const why = 'S5\'s scoped exposure names each question\'s entity from its world\'s plan';
  const planOf = new Map([...new Set(qs.map(q => q.conversation))].map(w => {
    const path = join(root, w, 'plan.json');
    const plan = plans ? plans.get(w) : existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as WorldPlan : undefined;
    return [w, plan ?? refuse(plans ? `no plan for ${w}; ${why}` : `${path} does not exist; ${why}`)] as const;
  }));
  return new Map(qs.map(q => {
    try { return [q.id, slotEntity(planOf.get(q.conversation)!, q.bg1!.slot)] as const; } catch (e) { return refuse(`${q.conversation}: ${(e as Error).message}; ${why}`); }
  }));
}

/** Read and check every receipt, then build the analysis input. Set BG1-C reads the BG1-C cell set, its readers, its filled manifest and its kept list. */
export function loadInput(dirs: readonly string[], o: LoadOptions, deps: LoadDeps = {}): Bg1Input {
  const confirm = o.set === 'BG1-C';
  if (!confirm && (o.look || o.leftOut?.length)) refuse('the look and rows left out are BG1-C\'s only');
  const defs = confirm ? confirmCells(deps.cells ?? readCellSet(o.cellsPath ?? CONFIRM_CELLS_PATH)).filter(d => !o.leftOut?.includes(ROLES[d.system])) : bg1Cells(o.set);
  const readers = confirm ? CONFIRM_READERS : READERS, ref = confirm ? CONFIRM_MANIFEST_REF : BG1_MANIFEST_REF;
  let manifest: FilledManifest | null = null, manifestSha = '', wave: Set<string> | null = null, finalSet: string[] | null = null;
  if (o.set === 'BG1' || confirm) {
    const bytes = deps.manifestBytes ?? (confirm ? readConfirmManifest(o.manifestPath ?? CONFIRM_MANIFEST_PATH) : readFileSync(o.manifestPath ?? refuse('set BG1 needs --manifest <filled bg1-manifest.json>')));
    manifest = JSON.parse(Buffer.from(bytes).toString('utf8')) as FilledManifest;
    if (manifest.status !== 'filled' || !manifest.kept?.length) refuse(`the ${ref.name} manifest is unfilled; verdict.ts reads receipts only against the filled manifest`);
    manifestSha = sha256(bytes);
    const kept = manifest.kept!, nFinal = manifest.n_final ?? null;
    if (confirm) {
      if (o.waveA) refuse('the pilot reads set BG1 only');
      const p = confirmKeptProblems(manifest);
      if (p.length) refuse(`the filled BG1-C manifest cannot be read: ${p.join('; ')}`);
      finalSet = o.look ? kept.slice(0, CONFIRM_LOOK_N) : [...kept];
    } else if (o.waveA) {
      if (kept.length < BG1_WAVE_A) refuse(`the pilot needs the first ${BG1_WAVE_A} kept worlds (wave A), and the kept list holds ${kept.length}`);
      wave = new Set(kept.slice(0, BG1_WAVE_A));
    } else if (nFinal === null || kept.length < nFinal || nFinal > BG1_N_CAP) refuse(`the filled manifest's kept list is not final (n_final ${nFinal ?? 'unset'}, ${kept.length} kept); a verdict reads exactly the first N_final kept worlds`);
    else finalSet = kept.slice(0, nFinal);
  } else if (o.waveA) refuse('the pilot reads set BG1 only');
  const found = findReceipts(dirs);
  const benchmark = defs[0]?.benchmark ?? refuse(`bg1-cells.json has no cells on ${o.set}`);
  const corpus = deps.questions ? null : loadCorpus(benchmark, undefined, wave ?? (finalSet ? new Set(finalSet) : undefined));
  const off = corpus && manifest ? unpinnedCorpusFiles(corpus.source.files, manifest, manifestSha, ref.rel) : [];
  if (off.length) refuse(`the loaded ${benchmark} corpus read ${off.join(', ')} at bytes the --manifest does not pin; the strata and values that decide the verdict come only from the pinned worlds`);
  const qs = deps.questions ?? corpus!.questions;
  const byId = new Map(qs.map(q => [q.id, q]));
  const inScope = (conv: string) => !wave || wave.has(conv);
  const question = (id: string) => byId.get(id) ?? refuse(`question ${id} has no BG1 fields in the loaded ${benchmark} corpus`);
  const worlds = wave ?? new Set(finalSet ?? defs[0].only_conversations ?? qs.map(q => q.conversation));
  const planned = qs.filter(q => worlds.has(q.conversation)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const plannedIds = new Set(planned.map(q => q.id));
  const entities = confirm ? confirmEntities(planned, deps.plans) : null;
  const rowWorlds = new Set<string>();
  const values = new Map<Bg1Row, Map<string, Record<string, ReaderValue>>>();
  const exposures = new Map<Bg1Row, Map<string, Exposure>>();
  const scopedExposures = new Map<Bg1Row, Map<string, Exposure>>();
  const rowIds = new Map<Bg1Row, Set<string>>();
  const fill: Partial<Record<Bg1Row, number | null>> = {};
  const costs: CostCell[] = [];
  const snapshots = new Map<string, Set<string>>();
  for (const def of defs) {
    const role = ROLES[def.system];
    const armCell = def.arms[0].cell_id;
    const instrument = instrumentFor(def.canonical_instrument);
    const wrongInstrument = (f: CellFiles) => f.receipt.instrument?.id !== instrument.id || f.receipt.instrument?.sha256 !== instrument.sha256;
    const expected = unitIdentity(JSON.parse(runConfigText(def, def.arms[0], { instrument, dataset: null as never, scheduledSha: '', limit: null })));
    const units = found.filter(f => f.receipt.cell_id === armCell);
    if (!units.length) refuse(`no receipt for ${armCell} under the given directories`);
    const held = new Map<string, string>();
    const ids = new Set<string>();
    const byQuestion = new Map<string, Record<string, ReaderValue>>();
    const exposed = new Map<string, Exposure>();
    const scoped = new Map<string, Exposure>();
    const usd = new Map<string, number | null>();
    const addUsd = (reader: string, conv: string, x: number | null) => { const k = `${reader}|${conv}`; const prev = usd.has(k) ? usd.get(k)! : 0; usd.set(k, prev === null || x === null ? null : prev + x); };
    const take = (dir: string, ans: AnswerRecord[]) => {
      const records = readRecords(join(dir, 'judgments.ndjson'), 'judgment').filter(j => j.judge_replicate === 0);
      const readerOf = new Map(ans.map(a => [a.answer_id, a.reader]));
      const problems = records.flatMap(j => gatingProblems(j, readerOf.get(j.answer_id), instrument.id));
      if (problems.length) refuse(`${dir}: ${more(problems)}`);
      for (const j of records.filter(r => r.view === 'gating')) for (const v of j.judge_versions ?? []) snapshots.set(j.judge, new Set([...(snapshots.get(j.judge) ?? []), v]));
      const score = new Map(records.map(j => [`${j.answer_id}|${j.instrument_id}`, j.score]));
      for (const a of ans.filter(x => x.replicate === 0 && readers.includes(x.reader) && inScope(x.conversation))) {
        byQuestion.set(a.question_id, { ...(byQuestion.get(a.question_id) ?? {}), [a.reader]: readerValue(a, score, instrument.id, question(a.question_id), role === 'floor') });
      }
    };
    const fills: number[] = [];
    for (const u of units) {
      if (u.receipt.run_status === 'invalid') refuse(`${u.dir} is invalid: ${(u.receipt.invalid_reasons ?? []).join('; ')}`);
      const config = u.config ?? refuse(`${u.dir} has no run-config.json`);
      if (manifest) { const p = receiptManifestProblems(config.dataset, manifest, manifestSha, ref); if (p.length) refuse(`${u.dir}: ${p.join('; ')}`); }
      if ((config.limit ?? null) !== null) refuse(`${u.dir} ran with --limit ${config.limit}; a verdict reads whole launch units, every scheduled question`);
      const diff = differing(unitIdentity(config), expected);
      if (diff.length) refuse(`${u.dir}: its run config differs from ${def.id} in ${confirm ? 'the BG1-C cell set' : 'the committed bg1-cells.json'} at ${diff.join(', ')}`);
      if (wrongInstrument(u)) refuse(`${u.dir} was judged under instrument ${u.receipt.instrument?.id}, not ${instrument.id} (${instrument.sha256.slice(0, 12)})`);
      const allRows = readLoose(join(u.dir, 'rows.ndjson'));
      const rows = allRows.filter(r => inScope(String(r.conversation)));
      const convs = new Set([...allRows.map(r => String(r.conversation)), ...((u.receipt.realizations ?? []) as Array<{ conversation: string }>).map(r => String(r.conversation))]);
      for (const conv of [...convs].filter(inScope)) { if (held.has(conv)) refuse(`${armCell}: world ${conv} is in both ${held.get(conv)} and ${u.dir}`); held.set(conv, u.dir); }
      for (const r of rows) { ids.add(String(r.id)); if (role !== 'floor') rowWorlds.add(String(r.conversation)); fills.push(typeof r.fill_rate === 'number' ? r.fill_rate : 0); }
      const ans = readRecords(join(u.dir, 'answers.ndjson'), 'answer').filter(a => inScope(a.conversation));
      take(u.dir, ans);
      const runDir = join(u.root, 'runs', String(u.receipt.run_cell ?? def.id));
      if (role !== 'floor') {
        const contexts = new Map(readLoose(join(runDir, 'contexts.ndjson')).map(c => [String(c.meta?.context_sha256), String(c.prompt)]));
        for (const a of ans) {
          const prompt = contexts.get(a.context_sha256);
          if (prompt === undefined || exposed.has(a.question_id)) continue;
          const q = question(a.question_id), text = evidenceOf(prompt), rawText = isRawTextRow(def.system), entity = entities?.get(a.question_id);
          exposed.set(a.question_id, exposure(q, text, { rawText }));
          if (entity !== undefined) scoped.set(a.question_id, scopedExposure(q, text, { rawText, entity }));
        }
      }
      const spend = u.receipt.spend?.usd as Record<string, number> | undefined;
      const shared = spend ? (spend.ingest ?? 0) + (spend.retrieval ?? 0) + (spend.background_tail ?? 0) : null;
      const perQuestion = shared === null || !rows.length ? null : shared / rows.length;
      const metered = new Map<string, number>();
      const byKey = new Map(ans.map(a => [`read:${a.answer_id.slice(0, 16)}`, a]));
      for (const m of readLoose(join(runDir, 'meters.ndjson'))) { const a = m.phase === 'reader' ? byKey.get(String(m.key)) : undefined; if (a) metered.set(a.answer_id, (metered.get(a.answer_id) ?? 0) + Number(m.usd)); }
      for (const r of rows) for (const reader of readers) addUsd(reader, String(r.conversation), perQuestion);
      for (const a of ans.filter(x => x.replicate === 0 && x.reader !== PARTICLE)) addUsd(a.reader, a.conversation, metered.has(a.answer_id) ? metered.get(a.answer_id)! : a.context_sha256 === sha256(`no-context|${a.outcome}`) ? 0 : null);
    }
    if (finalSet) {
      const absent = finalSet.filter(c => !held.has(c)), extra = [...held.keys()].filter(c => !finalSet!.includes(c)).sort();
      if (absent.length || extra.length) refuse(`${armCell}: the receipts must hold exactly the first ${finalSet.length} kept worlds; missing ${absent.join(', ') || 'none'}; outside that set ${extra.join(', ') || 'none'}`);
    }
    const unplanned = [...ids].filter(id => !plannedIds.has(id)).sort();
    if (unplanned.length) refuse(`${armCell}: rows ${more(unplanned)} are not planned questions of the loaded ${benchmark} corpus`);
    const rereadId = rereadCellId(armCell, PARTICLE);
    const plans = confirm && def.kept_units ? bg1cRereadPlans([def]).filter(p => p.arm_cell_id === armCell && p.reader === PARTICLE) : null;
    const halves = plans ? plans.filter(p => !o.look || p.half === 1) : null;
    if (plans) {
      const plain = found.find(f => f.receipt.cell_id === rereadId);
      if (plain) refuse(`${plain.dir}: ${def.id} is a counted BG1-C cell, so its particle-1 re-reads go under its half plans (${plans.map(p => p.id).join(', ')}), not ${rereadId}`);
      const later = found.find(f => plans.some(p => p.id === f.receipt.cell_id && !halves!.includes(p)));
      if (later) refuse(`${later.dir}: the look reads only half 1's particle-1 re-reads, and this one is ${later.receipt.cell_id}`);
    }
    const rereadIds = halves ? halves.map(p => p.id) : [rereadId];
    const rereads = found.filter(f => rereadIds.includes(f.receipt.cell_id));
    const configs = new Set(units.map(u => String(u.receipt.config_sha256)));
    const covered = new Set(rereads.flatMap(r => (r.receipt.source?.config_sha256s ?? []) as string[]));
    const uncovered = [...configs].filter(c => !covered.has(c));
    if (!rereads.length || uncovered.length) refuse(`missing particle-1 re-read: ${armCell} has ${uncovered.length || configs.size} receipt(s) no ${rereadIds.join(' or ')} covers`);
    const reheld = new Map<string, string>();
    const reread = new Map<string, Set<string>>();
    for (const r of rereads) {
      if (r.receipt.keyless !== false) refuse(`${r.dir} is not a paid re-read (keyless ${r.receipt.keyless ?? 'unrecorded'}); a verdict reads only re-reads whose receipt says keyless: false`);
      const plan = halves?.find(p => p.id === r.receipt.cell_id), h = r.receipt.half;
      if (plan && (h?.plan !== plan.id || h?.half !== plan.half || JSON.stringify(h?.units) !== JSON.stringify(plan.units))) refuse(`${r.dir}: its receipt names re-read plan ${JSON.stringify(h ?? null)}, not ${plan.id} (half ${plan.half}, units ${plan.units.join(', ')})`);
      if (r.receipt.run_status === 'invalid') refuse(`${r.dir} is invalid: ${(r.receipt.invalid_reasons ?? []).join('; ')}`);
      if (manifest) { const p = receiptManifestProblems(r.receipt.dataset, manifest, manifestSha, ref); if (p.length) refuse(`${r.dir}: ${p.join('; ')}`); }
      if (wrongInstrument(r)) refuse(`${r.dir} was judged under instrument ${r.receipt.instrument?.id}, not ${instrument.id} (${instrument.sha256.slice(0, 12)})`);
      const ans = readRecords(join(r.dir, 'answers.ndjson'), 'answer');
      for (const conv of new Set(ans.map(a => a.conversation))) { if (reheld.has(conv)) refuse(`${r.receipt.cell_id}: world ${conv} is re-read in both ${reheld.get(conv)} and ${r.dir}`); reheld.set(conv, r.dir); }
      if (plan) reread.set(plan.id, new Set([...(reread.get(plan.id) ?? []), ...ans.map(a => a.conversation)]));
      take(r.dir, ans);
      const readerUsd = typeof r.receipt.spend?.reader_usd === 'number' && ans.length ? r.receipt.spend.reader_usd / ans.length : null;
      for (const a of ans.filter(x => inScope(x.conversation))) addUsd(PARTICLE, a.conversation, readerUsd);
    }
    for (const p of halves ?? []) {
      const want = p.units.flatMap(u => manifest!.kept!.slice(u * def.kept_units!, (u + 1) * def.kept_units!)), got = [...(reread.get(p.id) ?? [])];
      const absent = want.filter(w => !got.includes(w)), extra = got.filter(w => !want.includes(w)).sort();
      if (absent.length || extra.length) refuse(`${p.id}: half ${p.half}'s re-reads must hold exactly the kept worlds of launch units ${p.units.join(', ')}; missing ${absent.join(', ') || 'none'}; outside that half ${extra.join(', ') || 'none'}`);
    }
    values.set(role, byQuestion);
    exposures.set(role, exposed);
    scopedExposures.set(role, scoped);
    rowIds.set(role, ids);
    if (role !== 'floor') fill[role] = meanOf(fills);
    for (const [k, x] of usd) { const [reader, conversation] = k.split('|'); costs.push({ row: role, reader, conversation, usd: x === null ? null : r4(x) }); }
  }
  const value = (row: Bg1Row, id: string, reader: string): ReaderValue => values.get(row)?.get(id)?.[reader] ?? { drop: reader === PARTICLE ? 'reread_answer_missing' : 'answer_missing' };
  const questions: QuestionInput[] = planned.map(({ id, conversation, bg1 }) => {
    const rows: QuestionInput['rows'] = {};
    for (const row of [...SYSTEM_ROWS, 'floor' as Bg1Row]) if (rowIds.get(row)?.has(id)) rows[row] = Object.fromEntries(readers.map(r => [r, value(row, id, r)]));
    const of = (byRow: Map<Bg1Row, Map<string, Exposure>>) => Object.fromEntries([...byRow].flatMap(([row, m]) => (m.has(id) ? [[row, m.get(id)!]] : [])));
    return { id, conversation, stratum: bg1!.stratum, rows, exposure: of(exposures), ...(entities ? { scoped_exposure: of(scopedExposures) } : {}) };
  });
  if (wave) { const absent = [...wave].filter(c => !rowWorlds.has(c)); if (absent.length) refuse(`the pilot needs every wave A world; ${absent.join(', ')} has no rows`); }
  return { set: o.set, questions, fill, costs, snapshots: Object.fromEntries([...snapshots].sort(([a], [b]) => (a < b ? -1 : 1)).map(([j, vs]) => [j, [...vs].sort()])) };
}

// ─── BG1-C pilot ─────────────────────────────────────────────────────

/** One pilot check: the condition of Amendment 1's pilot list it belongs to, what it measured and its line. */
export interface PilotCheck { condition: 1 | 2 | 3; check: string; value: number | string | null; line: string; pass: boolean }

/** One judge check for pilot condition 2: its report.json and the upstream.json its run wrote beside it (keyless false for a paid run). */
export interface PilotJudgeCheck { report: unknown; upstream: unknown }
const schemaOf = (c: PilotJudgeCheck) => (c.report as { schema?: unknown } | null)?.schema;
const judgeCheckPasses = (c: PilotJudgeCheck) => {
  const r = c.report as { stop?: unknown; gates?: unknown } | null;
  return !!r && Object.keys(CONFIRM_JUDGE_CHECKS).includes(schemaOf(c) as string) && (c.upstream as { keyless?: unknown } | null | undefined)?.keyless === false
    && r.stop === false && Array.isArray(r.gates) && r.gates.length > 0 && r.gates.every(g => (g as { pass?: unknown } | null)?.pass === true);
};

/** What the BG1-C pilot reads beside the smoke's receipts: gbrain's brain counts and each server's stored memories (condition 1), the judge checks (condition 2), the mint's supply check (condition 3), and the cell set's smoke cells (by default the committed BG1-C cell set's). */
export interface PilotInputs { brainCounts?: unknown; memoryCounts?: unknown; mintRate?: unknown; judgeChecks?: readonly PilotJudgeCheck[]; cells?: readonly CellDefinition[] }

/**
 * BG1-C's pilot (Amendment 1, R111): each row's smoke cell in the cell set, on bg1-dev-01, read from that cell's receipt
 * and its particle-1 re-read, against conditions 1 and 3 of the pilot list, with gbrain's brain counts, each server's
 * stored memories for the world and each reader's answered and graded questions for condition 1, the paid judge checks,
 * BG1's and BG1-C's, for condition 2, and the mint's Gemini requests per kept world over BG1-C's first five slots
 * (supply.ts's per_kept_world) for condition 3.
 */
export function confirmPilot(dirs: readonly string[], o: PilotInputs = {}) {
  const found = findReceipts(dirs);
  const smoke = confirmCells(o.cells ?? readCellSet(CONFIRM_CELLS_PATH, 'smoke_cells'));
  const reports = o.judgeChecks ?? [];
  const passing = reports.filter(judgeCheckPasses);
  const unchecked = Object.entries(CONFIRM_JUDGE_CHECKS).filter(([schema]) => !passing.some(c => schemaOf(c) === schema)).map(([, name]) => name);
  const judges: PilotCheck = { condition: 2, check: 'judge checks', value: reports.length ? `${passing.length} of ${reports.length} pass${unchecked.length ? `, none of them ${unchecked.join(' or ')}'s` : ''}` : null,
    line: `a paid ${Object.values(CONFIRM_JUDGE_CHECKS).join(' and a paid ')} judge check, every one passing`, pass: reports.length > 0 && passing.length === reports.length && !unchecked.length };
  const counts = (o.brainCounts ?? {}) as Record<string, unknown>;
  const brain: PilotCheck = { condition: 1, check: 'brain counts (tagged facts, slotted facts, changing slots)', value: o.brainCounts === undefined ? null : BRAIN_COUNTS.map(k => String(counts[k] ?? 'missing')).join(', '),
    line: 'each above 0', pass: BRAIN_COUNTS.every(k => typeof counts[k] === 'number' && (counts[k] as number) > 0) };
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const memories = (o.memoryCounts ?? {}) as Record<string, unknown>;
  const supplied = (o.mintRate as { per_kept_world?: unknown } | null | undefined)?.per_kept_world, requests = num(supplied);
  const mint: PilotCheck = { condition: 3, check: 'Gemini requests per kept world', value: o.mintRate === undefined ? null : requests ?? (supplied === null ? 'no kept world' : 'missing'),
    line: `at most ${CONFIRM_MINT_LINE}, ${CONFIRM_MINT_FACTOR} times the dev mint's ${CONFIRM_DEV_MINT_REQUESTS}, over ${CONFIRM_CONVERSATIONS[0]} to ${CONFIRM_CONVERSATIONS[CONFIRM_MINT_SLOTS - 1]}`, pass: requests !== null && requests <= CONFIRM_MINT_LINE };
  const rows = smoke.map(c => {
    const row = ROLES[c.system], cell = c.arms[0].cell_id;
    const live = found.filter(f => f.receipt.cell_id === cell);
    if (live.length > 1) refuse(`the pilot reads one smoke receipt per row, and ${row} has ${live.length} (${live.map(f => f.dir).join(', ')})`);
    const u = live[0];
    const qRows = u ? readLoose(join(u.dir, 'rows.ndjson')) : [];
    const worlds = [...new Set(qRows.map(r => String(r.conversation)))];
    if (u && (worlds.length !== 1 || worlds[0] !== CONFIRM_PILOT_WORLD)) refuse(`${u.dir}: the pilot reads the smoke on ${CONFIRM_PILOT_WORLD}, and this receipt holds ${worlds.join(', ') || 'no rows'}`);
    const frozen = new Set(u ? readLoose(join(u.root, 'runs', String(u.receipt.run_cell ?? u.receipt.cell_id), 'contexts.ndjson')).map(c => String(c.meta?.context_sha256)) : []);
    const withContext = new Set((u ? readRecords(join(u.dir, 'answers.ndjson'), 'answer') : []).filter(a => a.replicate === 0 && frozen.has(a.context_sha256)).map(a => a.question_id));
    const ids = new Set(qRows.map(r => String(r.id)));
    const nFrozen = [...ids].filter(id => withContext.has(id)).length;
    const fill = meanOf(qRows.map(r => (typeof r.fill_rate === 'number' ? r.fill_rate : 0)));
    const reread = u ? found.find(f => f.receipt.cell_id === rereadCellId(cell, PARTICLE)) : undefined;
    const instrument = instrumentFor(c.canonical_instrument).id;
    const tally = (dir: string | undefined, reader: string) => {
      const ans = dir ? readRecords(join(dir, 'answers.ndjson'), 'answer').filter(a => a.replicate === 0 && a.reader === reader && ids.has(a.question_id)) : [];
      const judge = bg1JudgeOf(reader);
      const graded = new Set((dir ? readRecords(join(dir, 'judgments.ndjson'), 'judgment') : [])
        .filter(j => j.judge_replicate === 0 && j.view === 'gating' && j.judge === judge && j.instrument_id === frontierInstrumentId(instrument, judge) && typeof j.score === 'number').map(j => j.answer_id));
      return { answered: new Set(ans.map(a => a.question_id)).size, graded: new Set(ans.filter(a => graded.has(a.answer_id)).map(a => a.question_id)).size };
    };
    const tallies = CONFIRM_READERS.map(reader => tally(reader === PARTICLE ? reread?.dir : u?.dir, reader));
    const cellUsd = num(u?.receipt.spend?.total_usd), readerUsd = num(reread?.receipt.spend?.reader_usd), judgeUsd = num(reread?.receipt.spend?.judge_usd);
    const unspent = !u ? 'no smoke receipt' : cellUsd === null ? 'no metered spend on the smoke receipt' : !reread ? 'no particle-1 re-read' : reread.receipt.keyless !== false ? 'the particle-1 re-read is not paid'
      : readerUsd === null || judgeUsd === null ? 'no metered spend on the re-read' : null;
    const perWorld = unspent ? null : (cellUsd! + readerUsd! + judgeUsd!) / worlds.length;
    const spendLine = confirmPilotSpendLine(c), ingest = num(u?.receipt.ingest?.wall_ms?.total);
    const stored = num(memories[row]);
    const storedCheck: PilotCheck = { condition: 1, check: 'stored memories', value: o.memoryCounts === undefined ? null : stored ?? 'missing', line: `above 0 for ${CONFIRM_PILOT_WORLD}`, pass: stored !== null && stored > 0 };
    const checks: PilotCheck[] = [
      { condition: 1, check: 'frozen contexts', value: u ? nFrozen : 'no smoke receipt', line: `all ${CONFIRM_PILOT_QUESTIONS} questions`, pass: ids.size === CONFIRM_PILOT_QUESTIONS && nFrozen === CONFIRM_PILOT_QUESTIONS },
      { condition: 1, check: 'mean fill rate', value: fill === null ? (u ? 'no rows' : 'no smoke receipt') : r4(fill), line: `at least ${FILL_GATE}`, pass: fill !== null && fill >= FILL_GATE },
      { condition: 1, check: `answered and graded (${CONFIRM_READERS.map(r => r.split(':')[1]).join(', ')})`, value: u ? `${tallies.map(t => t.answered).join(', ')} answered, ${tallies.map(t => t.graded).join(', ')} graded` : 'no smoke receipt',
        line: `all ${CONFIRM_PILOT_QUESTIONS} questions by each reader, each graded by its mapped judge`, pass: tallies.every(t => t.answered === CONFIRM_PILOT_QUESTIONS && t.graded === CONFIRM_PILOT_QUESTIONS) },
      row === 'gbrain' ? brain : storedCheck,
      judges,
      { condition: 3, check: 'spend per world', value: perWorld === null ? unspent : r4(perWorld), line: `at most $${r4(spendLine)}, 1.5 times the Budget rate`, pass: perWorld !== null && perWorld <= spendLine },
    ];
    return { row, cell, checks, wall_ms_per_world: ingest === null || !worlds.length ? null : Math.round(ingest / worlds.length), pass: checks.every(x => x.pass) };
  });
  return { schema: 'gbrain-evals/bg1c-pilot/v1', world: CONFIRM_PILOT_WORLD, rows, mint, pass: rows.every(r => r.pass) && mint.pass };
}
export type ConfirmPilot = ReturnType<typeof confirmPilot>;

function confirmPilotMain(argv: readonly string[], dirs: readonly string[], out: string): number {
  const many = (n: string) => argv.flatMap((a, i) => (a === n && argv[i + 1] ? [argv[i + 1]] : []));
  const read = (path: string): unknown => (existsSync(resolve(path)) ? JSON.parse(readFileSync(resolve(path), 'utf8')) : refuse(`${path} does not exist`));
  const input = (n: string) => { const path = many(n)[0]; return path ? read(path) : undefined; };
  try {
    const cells = many('--cells')[0];
    const judgeChecks = many('--judge-check').map(path => {
      const published = existsSync(resolve(path)) && existsSync(CONFIRM_BG1_VERDICT_PATH)
        && realpathSync(resolve(path)) === realpathSync(CONFIRM_BG1_VERDICT_PATH)
        && createHash('sha256').update(readFileSync(resolve(path))).digest('hex') === CONFIRM_BG1_VERDICT_SHA256;
      if (published) return { report: (read(path) as { judge_check?: unknown }).judge_check, upstream: { keyless: false } };
      const marker = join(dirname(resolve(path)), 'upstream.json');
      return { report: read(path), upstream: existsSync(marker) ? read(marker) : undefined };
    });
    const p = confirmPilot(dirs, { brainCounts: input('--brain-counts'), memoryCounts: input('--memory-counts'), mintRate: input('--mint-rate'), judgeChecks,
      ...(cells ? { cells: readCellSet(resolve(cells), 'smoke_cells') } : {}) });
    mkdirSync(resolve(out), { recursive: true });
    writeFileSync(join(resolve(out), 'pilot.json'), JSON.stringify(p, null, 2) + '\n');
    const hours = (ms: number | null) => (ms === null ? 'unknown' : `${(ms / 3_600_000).toFixed(2)} h`);
    const said = (c: PilotCheck) => `condition ${c.condition} ${c.check} ${c.value ?? 'none given'} (${c.line}) ${c.pass ? 'pass' : 'FAIL'}`;
    process.stdout.write([`BG1-C pilot on ${p.world}: ${p.pass ? 'pass' : 'FAIL'}`, ...p.rows.map(r => `  ${r.row}: ${r.pass ? 'pass' : 'FAIL'}; ${r.checks.map(said).join('; ')}; ingest wall time per world ${hours(r.wall_ms_per_world)}`),
      `  mint: ${p.mint.pass ? 'pass' : 'FAIL'}; ${said(p.mint)}`].join('\n') + '\n');
    if (p.pass) return 0;
    const failed = [...p.rows.flatMap(r => r.checks.filter(c => !c.pass).map(c => `${r.row} condition ${c.condition} (${c.check})`)), ...(p.mint.pass ? [] : [`mint condition ${p.mint.condition} (${p.mint.check})`])];
    process.stderr.write(`BG1-C pilot failed: ${failed.join('; ')}\n`);
    return 3;
  } catch (e) {
    if (!(e instanceof VerdictError)) throw e;
    process.stderr.write(`bg1 pilot refused: ${e.message}\n`);
    return 2;
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────

/** The gbrain release a BG1-C run measures: the cell set's gbrain_build.release. A cell set without one, or a --release that differs from it, refuses. */
function confirmRelease(cellsPath: string, given: string | undefined): string {
  const set = existsSync(cellsPath) ? JSON.parse(readFileSync(cellsPath, 'utf8')) as { gbrain_build?: { release?: unknown } } : refuse(`the BG1-C cell set ${cellsPath} does not exist; pass --cells <file>`);
  const pinned = set.gbrain_build?.release;
  const release = typeof pinned === 'string' && /^v\d+(\.\d+)+$/.test(pinned) ? pinned : refuse(`the BG1-C cell set ${cellsPath} names no gbrain release in gbrain_build.release, so confirm cannot say which release it measures`);
  return given === undefined || given === release ? release : refuse(`--release ${given} is not the gbrain release the BG1-C cell set pins, ${release} (${cellsPath}); confirm measures the cell set's release`);
}

export function main(argv: string[], deps: LoadDeps = {}): number {
  const mode = argv[0];
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const dirs = argv.flatMap((a, i) => (a === '--receipts' && argv[i + 1] ? [resolve(argv[i + 1])] : []));
  const out = one('--out');
  if ((mode !== 'verdict' && mode !== 'pilot' && mode !== 'confirm') || !dirs.length || !out) {
    process.stderr.write('usage: bun eval/runner/bg1/verdict.ts verdict|pilot --receipts <out dir>... [--manifest <filled bg1-manifest.json>] [--set BG1|BG1-dev3] [--judge-check <summary.json>] --out <dir>\n'
      + '       bun eval/runner/bg1/verdict.ts confirm [--look] --receipts <out dir>... [--release <gbrain release>] [--left-out <server row>=<reason>]... [--brain-counts <counts.json>] [--manifest <filled bg1c-manifest.json>] [--cells <BG1-C cell set>] [--judge-check <summary.json>] --out <dir>\n'
      + '       bun eval/runner/bg1/verdict.ts pilot --set BG1-C --receipts <smoke out dir>... [--brain-counts <counts.json>] [--memory-counts <counts.json>] [--mint-rate <supply.json>] [--judge-check <report.json>]... [--cells <BG1-C cell set>] --out <dir>\n');
    return 2;
  }
  const confirm = mode === 'confirm';
  const set = (one('--set') ?? (confirm ? 'BG1-C' : 'BG1')) as LoadOptions['set'];
  if (mode === 'pilot' && set === 'BG1-C') return confirmPilotMain(argv, dirs, out);
  if (confirm && set !== 'BG1-C') { process.stderr.write(`confirm reads set BG1-C only, not ${set}\n`); return 2; }
  if (!confirm && set !== 'BG1' && set !== 'BG1-dev3') { process.stderr.write(`--set takes BG1 or BG1-dev3, not ${set}\n`); return 2; }
  const look = confirm && argv.includes('--look');
  const leftOut: Record<string, string> = {};
  for (const spec of confirm ? argv.flatMap((a, i) => (a === '--left-out' ? [argv[i + 1] ?? ''] : [])) : []) {
    const eq = spec.indexOf('='), row = eq < 0 ? spec : spec.slice(0, eq);
    if (row in leftOut) { process.stderr.write(`--left-out names ${row} twice\n`); return 2; }
    leftOut[row] = eq < 0 ? '' : spec.slice(eq + 1);
  }
  try {
    const release = confirm ? confirmRelease(resolve(one('--cells') ?? CONFIRM_CELLS_PATH), one('--release')) : undefined;
    const bad = leftOutProblems(leftOut);
    if (bad.length) refuse(bad.join('; '));
    const countsPath = confirm ? one('--brain-counts') : undefined;
    const brainCounts = countsPath ? confirmBrainCounts(existsSync(resolve(countsPath)) ? JSON.parse(readFileSync(resolve(countsPath), 'utf8')) : refuse(`${countsPath} does not exist`)) : undefined;
    const input = loadInput(dirs, { set, manifestPath: one('--manifest'), waveA: mode === 'pilot', ...(confirm ? { cellsPath: one('--cells'), look, leftOut: Object.keys(leftOut) as Bg1Row[] } : {}) }, deps);
    const dir = resolve(out), marker = join(dir, 'look.json');
    const rowsOut = (xs: ReadonlyArray<{ row: string }>) => xs.map(x => x.row).join(' and ') || 'no row';
    if (look && existsSync(marker)) refuse(`this run already took its look (${marker}); Amendment 1 allows one look, and no second look counts`);
    if (confirm && !look) {
      if (!existsSync(marker)) refuse(`the final analysis comes after the look, and ${marker} does not exist; run confirm --look on the first ${CONFIRM_LOOK_N} kept worlds into the same --out first`);
      const record = JSON.parse(readFileSync(marker, 'utf8')) as { decision?: string; left_out?: Array<{ row: string; reason: string }> };
      if (record.decision !== 'continue') refuse(`the run stopped at its look (${marker}), so the look's verdict stands and no final analysis counts`);
      if (JSON.stringify(record.left_out ?? []) !== JSON.stringify(leftOutList(leftOut))) refuse(`the final analysis leaves out ${rowsOut(leftOutList(leftOut))}, but the look left out ${rowsOut(record.left_out ?? [])}; both read the same rows, with the same reasons`);
    }
    mkdirSync(dir, { recursive: true });
    if (mode === 'pilot') {
      const pilot = pilotStats(input), sizing = sizeFromPilot(pilot);
      writeFileSync(join(dir, 'pilot.json'), JSON.stringify({ pilot, sizing }, null, 2) + '\n');
      process.stdout.write(`pilot: ${pilot.worlds} worlds; N_required ${sizing.n_required_max}, N_final ${sizing.n_final}${sizing.pause ? ' (above the cap: pause for GBEV-3)' : ''}\n`);
      return sizing.pause ? 3 : 0;
    }
    const judgeCheck = one('--judge-check') ? JSON.parse(readFileSync(one('--judge-check')!, 'utf8')) : undefined;
    if (confirm) {
      const wordsOf = (c: ConfirmAnalysis) => CONFIRM_COMPARISONS.map(k => {
        const x = c.comparisons.find(y => y.key === k.key);
        return x ? `${x.key} ${x.word ?? 'no test'}${x.descriptive ? ' (descriptive)' : ''}` : `${k.key} ${c.not_run.find(y => y.key === k.key)!.status}`;
      }).join('; ');
      if (look) {
        const l = lookConfirm(input, { release: release!, leftOut, judgeCheck, brainCounts });
        writeFileSync(marker, JSON.stringify(l, null, 2) + '\n', { flag: 'wx' });
        if (l.verdict) writeFileSync(join(dir, 'confirm.json'), JSON.stringify(l.verdict, null, 2) + '\n');
        const stats = l.comparisons.map(x => `${x.key} ${x.status}${x.z === null ? '' : `, z ${x.z.toFixed(2)}, CP ${x.cp!.toFixed(2)}`}`).join('; ');
        process.stdout.write(l.verdict ? `BG1-C look: stop at ${CONFIRM_LOOK_N} worlds; row ${l.verdict.outcome.row} (${l.verdict.outcome.result}); ${wordsOf(l.verdict)}${l.verdict.worst_case.disagrees ? '; the worst case disagrees' : ''}\n`
          : `BG1-C look: continue to ${CONFIRM_N} worlds; ${stats}\n`);
        return 0;
      }
      const c = analyzeConfirm(input, { release: release!, leftOut, judgeCheck, brainCounts });
      writeFileSync(join(dir, 'confirm.json'), JSON.stringify(c, null, 2) + '\n');
      process.stdout.write(`BG1-C: row ${c.outcome.row} (${c.outcome.result}); ${wordsOf(c)}; ${c.worlds} worlds, ${c.common} of ${c.planned} questions in the common set${c.worst_case.disagrees ? '; the worst case disagrees' : ''}\n`);
      return 0;
    }
    const a = analyze(input, { judgeCheck });
    writeFileSync(join(dir, 'verdict.json'), JSON.stringify(a, null, 2) + '\n');
    const words = a.primary.comparisons.map(c => `${c.row} ${c.verdict ?? 'descriptive'}`).join('; ');
    process.stdout.write(`${a.set}: ${words}; ${a.worlds} worlds, ${a.common} of ${a.planned} questions in the common set${a.primary.worst_case.disagrees ? '; the worst case disagrees' : ''}\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof VerdictError || e instanceof DecideError)) throw e;
    process.stderr.write(`bg1 verdict refused: ${e.message}\n`);
    return 2;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));

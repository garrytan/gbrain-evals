/**
 * BG1's analysis (preregistration docs/benchmarks/2026-11-09-changing-facts-battleground-preregistration.md, "Metric",
 * "Decision rule", "Secondary families" and "Internal pilot"). The rule itself is eval/runner/bg1/rule.ts; this file reads
 * the receipts, checks them and reports.
 *
 *   bun eval/runner/bg1/verdict.ts verdict --receipts <out dir>... [--manifest <filled bg1-manifest.json>] [--set BG1|BG1-dev3] [--judge-check <summary.json>] --out <dir>
 *   bun eval/runner/bg1/verdict.ts pilot   --receipts <out dir>... [--manifest <filled bg1-manifest.json>] --out <dir>
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
 *             replicate 0. A product failure scores 0; a harness failure, a missing row, answer or gating judgment is a
 *             drop, by reason and side. The gating view is each reader's mapped judge (bg1JudgeOf); the canonical
 *             gemini-3.8-flash view is descriptive. A gating judgment by the reader's own family, by another judge than
 *             the mapped one, without the gating view or the pinned settings, or without a model version refuses.
 *   Metric    a question's score is the mean over the three readers of correct (100) or not (0); a world's difference is
 *             the mean over its questions in the family of gbrain minus the comparator. One common question set: a
 *             question dropped in any system row leaves every comparison. Above 5% of the planned questions dropped,
 *             every comparison is descriptive. The worst-case sensitivity scores every planned question, each gbrain
 *             drop 0 and each comparator drop 100, and is flagged when its words differ.
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
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadCorpus, type MemoryQuestion } from '../memory-qa/corpus.ts';
import { instrumentFor } from '../memory-qa/instruments.ts';
import { HARNESS_FAILURES, PRODUCT_FAILURES, type Outcome } from '../memory-qa/outcomes.ts';
import { readRecords, type AnswerRecord, type JudgmentRecord } from '../memory-qa/records.ts';
import { frontierInstrumentId, runConfigIdentity, runConfigText } from '../q1/cell.ts';
import { loadBG1Manifest, OPUS, PARTICLE, SOL } from '../q1/cells/bg1.ts';
import { bg1JudgeOf, PER_READER_JUDGE_SETTINGS } from '../q1/cells/definitions.ts';
import { rereadCellId } from '../q1/reread-cell.ts';
import { holmAdjusted, seededRandom } from '../stats/paired.ts';
import { wildTest } from '../stats/wild-cluster.ts';
import { evidenceOf, exposure, isRawTextRow, summarizeExposure, type Exposure, type ExposureSummary } from './exposure.ts';
import { matchAnswer, MATCH_CLASSES, type MatchClass } from './match.ts';
import { sizeFromPilot, type Bg1Pilot } from './power.ts';
import { BG1_ALPHA, decideFamily, pairedT, type ComparisonVerdict, type VerdictWord } from './rule.ts';
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
}
/** One row's spend for one reader on one world, null when a meter is missing. */
export interface CostCell { row: Bg1Row; reader: string; conversation: string; usd: number | null }
export interface Bg1Input {
  set: 'BG1' | 'BG1-dev3';
  questions: QuestionInput[];
  fill: Partial<Record<Bg1Row, number | null>>;
  costs: CostCell[];
  snapshots: Record<string, string[]>;
}

const isDrop = (v: ReaderValue | undefined): v is { drop: string } | undefined => !v || 'drop' in v;
const scoreOf = (v: ReaderValue | undefined, view: View): number | null => (isDrop(v) ? null : v[view]);

// ─── Analysis ────────────────────────────────────────────────────────

/** The common question set: questions every system row answered, for every reader, with a score under the view. */
export function commonSet(input: Pick<Bg1Input, 'questions'>, view: View = 'gating'): Set<string> {
  return new Set(input.questions.filter(q => SYSTEM_ROWS.every(row => READERS.every(r => scoreOf(q.rows[row]?.[r], view) !== null))).map(q => q.id));
}

export interface Drops { planned: number; dropped: number; share: number; by: Record<string, number> }

/** Questions outside the common set, and each missing value by side (gbrain or a comparison row) and reason. */
export function dropsOf(input: Pick<Bg1Input, 'questions'>, view: View = 'gating'): Drops {
  const keep = commonSet(input, view);
  const by: Record<string, number> = {};
  for (const q of input.questions.filter(x => !keep.has(x.id))) for (const row of SYSTEM_ROWS) for (const r of READERS) {
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
export function worldDifferences(input: Pick<Bg1Input, 'questions'>, other: Bg1Row, strata: readonly Bg1Stratum[], o: { view?: View; readers?: readonly string[]; keep?: ReadonlySet<string>; worstCase?: boolean } = {}): WorldDifference[] {
  const view = o.view ?? 'gating', readers = o.readers ?? READERS;
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

/** One family's comparisons, Holm across them; a row that fails the fill gate, or a run above the drop cap, is descriptive. */
export function familyRows(input: Bg1Input, rows: readonly Bg1Row[], strata: readonly Bg1Stratum[], keep: ReadonlySet<string>, invalid: readonly string[], view: View = 'gating'): ComparisonRow[] {
  const diffs = new Map(rows.map(r => [r, worldDifferences(input, r, strata, { view, keep })]));
  const enough = rows.every(r => diffs.get(r)!.length >= 2);
  const tests = enough ? decideFamily(Object.fromEntries(rows.map(r => [r, diffs.get(r)!.map(x => x.d)]))) : null;
  return rows.map((row, i) => {
    const ds = diffs.get(row)!;
    const gate = [row, 'gbrain'].filter(x => x !== 'floor' && !((input.fill[x as Bg1Row] ?? 0) >= FILL_GATE)).map(x => `descriptive: ${x} failed the delivered-context gate (mean fill rate ${input.fill[x as Bg1Row] === null || input.fill[x as Bg1Row] === undefined ? 'unknown' : r4(input.fill[x as Bg1Row]!)}, below ${FILL_GATE})`);
    const descriptive = [...invalid, ...gate, ...(enough ? [] : ['too few worlds for a test'])].join('; ') || null;
    let worse = 0, better = 0, same = 0;
    for (const q of input.questions.filter(x => strata.includes(x.stratum) && keep.has(x.id))) {
      const g = qScore(q, 'gbrain', view, READERS, null)!, x = qScore(q, row, view, READERS, null)!;
      if (Math.abs(g - x) < 1e-9) same++; else if (g < x) worse++; else better++;
    }
    const w = ds.length >= 2 ? wildTest(ds.map(x => ({ id: x.conversation, stratum: 'all', n: x.n, sum: x.d * x.n })), { draws: DRAWS, seed: SEED }) : null;
    const { comparison: _c, ...test } = tests?.[i] ?? { comparison: '' };
    return { row, worlds: ds.length, questions: ds.reduce((s, x) => s + x.n, 0), verdict: tests && !descriptive ? tests[i].verdict : null, descriptive,
      test: tests ? test as Omit<ComparisonVerdict, 'comparison'> : null, worse, better, same,
      wild: w ? { estimate: r4(w.theta), p: r4(w.p), ci95: [r4(w.ci95[0]), r4(w.ci95[1])], method: WILD_METHOD } : null };
  });
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

/** Each row's exposure over every planned question, and by stratum. */
export function exposureSummaries(input: Pick<Bg1Input, 'questions'>): Partial<Record<Bg1Row, { all: ExposureSummary; by_stratum: Partial<Record<Bg1Stratum, ExposureSummary>> }>> {
  const rows = [...new Set(input.questions.flatMap(q => Object.keys(q.exposure ?? {})))] as Bg1Row[];
  return Object.fromEntries(rows.sort().map(row => {
    const of = (qs: readonly QuestionInput[]) => summarizeExposure(qs.flatMap(q => (q.exposure?.[row] ? [q.exposure[row]!] : [])));
    return [row, { all: of(input.questions), by_stratum: Object.fromEntries(BG1_STRATA.map(s => [s, of(input.questions.filter(q => q.stratum === s))])) }];
  }));
}

/** Cost per correct answer: each row's spend over its correct answers by reader, and gbrain's ratio to each comparator (all readers) with a world cluster bootstrap, Holm across the three. */
export function costPerCorrect(input: Bg1Input, keep: ReadonlySet<string>) {
  const worlds = [...new Set(input.questions.map(q => q.conversation))].sort();
  const cells = new Map<string, { usd: number | null; correct: number }>();
  const key = (row: Bg1Row, reader: string, conv: string) => `${row}|${reader}|${conv}`;
  for (const row of [...SYSTEM_ROWS, 'floor' as Bg1Row]) for (const reader of READERS) for (const conv of worlds) {
    const c = input.costs.find(x => x.row === row && x.reader === reader && x.conversation === conv);
    cells.set(key(row, reader, conv), { usd: c ? c.usd : null, correct: 0 });
  }
  for (const q of input.questions) for (const row of [...SYSTEM_ROWS, 'floor' as Bg1Row]) {
    if (row !== 'floor' && !keep.has(q.id)) continue;
    for (const reader of READERS) cells.get(key(row, reader, q.conversation))!.correct += scoreOf(q.rows[row]?.[reader], row === 'floor' ? 'canonical' : 'gating') ?? 0;
  }
  const ratio = (row: Bg1Row, readers: readonly string[], ws: readonly string[]) => {
    let usd = 0, correct = 0;
    for (const w of ws) for (const r of readers) { const c = cells.get(key(row, r, w))!; if (c.usd === null) return null; usd += c.usd; correct += c.correct; }
    return correct ? usd / correct : null;
  };
  const table = TABLE_READERS.map(reader => ({ reader, usd_per_correct: Object.fromEntries([...SYSTEM_ROWS, 'floor' as Bg1Row].map(row => { const x = ratio(row, [reader], worlds); return [row, x === null ? null : r4(x)]; })) }));
  const rand = seededRandom(SEED);
  const draws = Array.from({ length: DRAWS }, () => worlds.map(() => worlds[Math.floor(rand() * worlds.length)]));
  const tests = COMPARATOR_ROWS.map(row => {
    const g = ratio('gbrain', READERS, worlds), x = ratio(row, READERS, worlds);
    if (g === null || x === null) return { row, ratio: null, ci95: null, p_ahead: 1, p_behind: 1, note: 'n/a: a meter or a re-read reader spend is missing' };
    const boot = draws.map(ws => { const a = ratio('gbrain', READERS, ws), b = ratio(row, READERS, ws); return a !== null && b ? a / b : null; }).filter((v): v is number => v !== null).sort((a, b) => a - b);
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
  const invalid = drops.share > DROP_CAP ? [`${drops.dropped} of ${drops.planned} planned questions dropped (${(drops.share * 100).toFixed(1)}%, above the 5% cap)`] : [];
  const primary = familyRows(input, COMPARATOR_ROWS, BG1_PRIMARY, keep, invalid);
  const worstDiffs = COMPARATOR_ROWS.map(r => worldDifferences(input, r, BG1_PRIMARY, { worstCase: true }));
  const worst = worstDiffs.every(d => d.length >= 2) ? decideFamily(Object.fromEntries(COMPARATOR_ROWS.map((r, i) => [r, worstDiffs[i].map(x => x.d)]))).map(v => v.verdict) : null;
  const design = familyRows(input, ['hybrid'], BG1_PRIMARY, keep, invalid)[0];
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
    primary: { strata: BG1_PRIMARY, holm_over: COMPARATOR_ROWS, comparisons: primary,
      worst_case: { verdicts: worst, disagrees: worst !== null && worst.some((w, i) => primary[i].verdict !== null && w !== primary[i].verdict) } },
    time_indexed: { strata: BG1_SECONDARY, holm_over: COMPARATOR_ROWS, comparisons: familyRows(input, COMPARATOR_ROWS, BG1_SECONDARY, keep, invalid) },
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

/** A set-BG1 receipt must come from the filled manifest (or one of its earlier fills) and load only its pinned bytes. */
export function receiptManifestProblems(dataset: Record<string, any> | undefined, manifest: FilledManifest, manifestSha: string): string[] {
  if (!dataset) return ['it records no dataset'];
  if (dataset.revision === 'unfilled') return ['its dataset revision is unfilled'];
  const [head, ...files] = (dataset.files ?? []) as Array<{ path: string; sha256: string }>;
  if (head?.path !== BG1_MANIFEST_REL) return [`its dataset is not the BG1 manifest (${head?.path ?? 'no files'})`];
  const problems: string[] = [];
  if (![manifestSha, ...(manifest.earlier_fills ?? [])].includes(head.sha256)) problems.push(`its BG1 manifest SHA-256 ${head.sha256.slice(0, 12)} is not the filled manifest's (${manifestSha.slice(0, 12)}) or an earlier fill's`);
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

export interface LoadOptions { set: 'BG1' | 'BG1-dev3'; manifestPath?: string; waveA?: boolean }
export interface LoadDeps { questions?: readonly MemoryQuestion[]; manifestBytes?: Uint8Array }

/** Read and check every receipt, then build the analysis input. */
export function loadInput(dirs: readonly string[], o: LoadOptions, deps: LoadDeps = {}): Bg1Input {
  const cells = loadBG1Manifest();
  const defs = (o.set === 'BG1' ? cells.cells : cells.smoke_cells).filter(c => c.arms[0].set === o.set && ROLES[c.system]);
  let manifest: FilledManifest | null = null, manifestSha = '', wave: Set<string> | null = null, finalSet: string[] | null = null;
  if (o.set === 'BG1') {
    const bytes = deps.manifestBytes ?? readFileSync(o.manifestPath ?? refuse('set BG1 needs --manifest <filled bg1-manifest.json>'));
    manifest = JSON.parse(Buffer.from(bytes).toString('utf8')) as FilledManifest;
    if (manifest.status !== 'filled' || !manifest.kept?.length) refuse('the BG1 manifest is unfilled; verdict.ts reads receipts only against the filled manifest');
    manifestSha = sha256(bytes);
    const kept = manifest.kept!, nFinal = manifest.n_final ?? null;
    if (o.waveA) {
      if (kept.length < BG1_WAVE_A) refuse(`the pilot needs the first ${BG1_WAVE_A} kept worlds (wave A), and the kept list holds ${kept.length}`);
      wave = new Set(kept.slice(0, BG1_WAVE_A));
    } else if (nFinal === null || kept.length < nFinal || nFinal > BG1_N_CAP) refuse(`the filled manifest's kept list is not final (n_final ${nFinal ?? 'unset'}, ${kept.length} kept); a verdict reads exactly the first N_final kept worlds`);
    else finalSet = kept.slice(0, nFinal);
  } else if (o.waveA) refuse('the pilot reads set BG1 only');
  const found = findReceipts(dirs);
  const benchmark = defs[0]?.benchmark ?? refuse(`bg1-cells.json has no cells on ${o.set}`);
  const qs = deps.questions ?? loadCorpus(benchmark, undefined, wave ?? (finalSet ? new Set(finalSet) : undefined)).questions;
  const byId = new Map(qs.map(q => [q.id, q]));
  const inScope = (conv: string) => !wave || wave.has(conv);
  const question = (id: string) => byId.get(id) ?? refuse(`question ${id} has no BG1 fields in the loaded ${benchmark} corpus`);
  const values = new Map<Bg1Row, Map<string, Record<string, ReaderValue>>>();
  const exposures = new Map<Bg1Row, Map<string, Exposure>>();
  const rowIds = new Map<Bg1Row, Set<string>>();
  const planned = new Map<string, string>();
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
    const usd = new Map<string, number | null>();
    const addUsd = (reader: string, conv: string, x: number | null) => { const k = `${reader}|${conv}`; const prev = usd.has(k) ? usd.get(k)! : 0; usd.set(k, prev === null || x === null ? null : prev + x); };
    const take = (dir: string, ans: AnswerRecord[]) => {
      const records = readRecords(join(dir, 'judgments.ndjson'), 'judgment').filter(j => j.judge_replicate === 0);
      const readerOf = new Map(ans.map(a => [a.answer_id, a.reader]));
      const problems = records.flatMap(j => gatingProblems(j, readerOf.get(j.answer_id), instrument.id));
      if (problems.length) refuse(`${dir}: ${more(problems)}`);
      for (const j of records.filter(r => r.view === 'gating')) for (const v of j.judge_versions ?? []) snapshots.set(j.judge, new Set([...(snapshots.get(j.judge) ?? []), v]));
      const score = new Map(records.map(j => [`${j.answer_id}|${j.instrument_id}`, j.score]));
      for (const a of ans.filter(x => x.replicate === 0 && READERS.includes(x.reader) && inScope(x.conversation))) {
        byQuestion.set(a.question_id, { ...(byQuestion.get(a.question_id) ?? {}), [a.reader]: readerValue(a, score, instrument.id, question(a.question_id), role === 'floor') });
      }
    };
    const fills: number[] = [];
    for (const u of units) {
      if (u.receipt.run_status === 'invalid') refuse(`${u.dir} is invalid: ${(u.receipt.invalid_reasons ?? []).join('; ')}`);
      const config = u.config ?? refuse(`${u.dir} has no run-config.json`);
      if (manifest) { const p = receiptManifestProblems(config.dataset, manifest, manifestSha); if (p.length) refuse(`${u.dir}: ${p.join('; ')}`); }
      if ((config.limit ?? null) !== null) refuse(`${u.dir} ran with --limit ${config.limit}; a verdict reads whole launch units, every scheduled question`);
      const diff = differing(unitIdentity(config), expected);
      if (diff.length) refuse(`${u.dir}: its run config differs from ${def.id} in the committed bg1-cells.json at ${diff.join(', ')}`);
      if (wrongInstrument(u)) refuse(`${u.dir} was judged under instrument ${u.receipt.instrument?.id}, not ${instrument.id} (${instrument.sha256.slice(0, 12)})`);
      const allRows = readLoose(join(u.dir, 'rows.ndjson'));
      const rows = allRows.filter(r => inScope(String(r.conversation)));
      const convs = new Set([...allRows.map(r => String(r.conversation)), ...((u.receipt.realizations ?? []) as Array<{ conversation: string }>).map(r => String(r.conversation))]);
      for (const conv of [...convs].filter(inScope)) { if (held.has(conv)) refuse(`${armCell}: world ${conv} is in both ${held.get(conv)} and ${u.dir}`); held.set(conv, u.dir); }
      for (const r of rows) { ids.add(String(r.id)); if (role !== 'floor') planned.set(String(r.id), String(r.conversation)); fills.push(typeof r.fill_rate === 'number' ? r.fill_rate : 0); }
      const ans = readRecords(join(u.dir, 'answers.ndjson'), 'answer').filter(a => inScope(a.conversation));
      take(u.dir, ans);
      const runDir = join(u.root, 'runs', String(u.receipt.run_cell ?? def.id));
      if (role !== 'floor') {
        const contexts = new Map(readLoose(join(runDir, 'contexts.ndjson')).map(c => [String(c.meta?.context_sha256), String(c.prompt)]));
        for (const a of ans) {
          const prompt = contexts.get(a.context_sha256);
          if (prompt !== undefined && !exposed.has(a.question_id)) exposed.set(a.question_id, exposure(question(a.question_id), evidenceOf(prompt), { rawText: isRawTextRow(def.system) }));
        }
      }
      const spend = u.receipt.spend?.usd as Record<string, number> | undefined;
      const shared = spend ? (spend.ingest ?? 0) + (spend.retrieval ?? 0) + (spend.background_tail ?? 0) : null;
      const perQuestion = shared === null || !rows.length ? null : shared / rows.length;
      const metered = new Map<string, number>();
      const byKey = new Map(ans.map(a => [`read:${a.answer_id.slice(0, 16)}`, a]));
      for (const m of readLoose(join(runDir, 'meters.ndjson'))) { const a = m.phase === 'reader' ? byKey.get(String(m.key)) : undefined; if (a) metered.set(a.answer_id, (metered.get(a.answer_id) ?? 0) + Number(m.usd)); }
      for (const r of rows) for (const reader of READERS) addUsd(reader, String(r.conversation), perQuestion);
      for (const a of ans.filter(x => x.replicate === 0 && x.reader !== PARTICLE)) addUsd(a.reader, a.conversation, metered.has(a.answer_id) ? metered.get(a.answer_id)! : a.context_sha256 === sha256(`no-context|${a.outcome}`) ? 0 : null);
    }
    if (finalSet) {
      const absent = finalSet.filter(c => !held.has(c)), extra = [...held.keys()].filter(c => !finalSet!.includes(c)).sort();
      if (absent.length || extra.length) refuse(`${armCell}: the receipts must hold exactly the first ${finalSet.length} kept worlds; missing ${absent.join(', ') || 'none'}; outside that set ${extra.join(', ') || 'none'}`);
    }
    const rereadId = rereadCellId(armCell, PARTICLE);
    const rereads = found.filter(f => f.receipt.cell_id === rereadId);
    const configs = new Set(units.map(u => String(u.receipt.config_sha256)));
    const covered = new Set(rereads.flatMap(r => (r.receipt.source?.config_sha256s ?? []) as string[]));
    const uncovered = [...configs].filter(c => !covered.has(c));
    if (!rereads.length || uncovered.length) refuse(`missing particle-1 re-read: ${armCell} has ${uncovered.length || configs.size} receipt(s) no ${rereadId} covers`);
    const reheld = new Map<string, string>();
    for (const r of rereads) {
      if (r.receipt.keyless !== false) refuse(`${r.dir} is not a paid re-read (keyless ${r.receipt.keyless ?? 'unrecorded'}); a verdict reads only re-reads whose receipt says keyless: false`);
      if (r.receipt.run_status === 'invalid') refuse(`${r.dir} is invalid: ${(r.receipt.invalid_reasons ?? []).join('; ')}`);
      if (manifest) { const p = receiptManifestProblems(r.receipt.dataset, manifest, manifestSha); if (p.length) refuse(`${r.dir}: ${p.join('; ')}`); }
      if (wrongInstrument(r)) refuse(`${r.dir} was judged under instrument ${r.receipt.instrument?.id}, not ${instrument.id} (${instrument.sha256.slice(0, 12)})`);
      const ans = readRecords(join(r.dir, 'answers.ndjson'), 'answer');
      for (const conv of new Set(ans.map(a => a.conversation))) { if (reheld.has(conv)) refuse(`${rereadId}: world ${conv} is re-read in both ${reheld.get(conv)} and ${r.dir}`); reheld.set(conv, r.dir); }
      take(r.dir, ans);
      const readerUsd = typeof r.receipt.spend?.reader_usd === 'number' && ans.length ? r.receipt.spend.reader_usd / ans.length : null;
      for (const a of ans.filter(x => inScope(x.conversation))) addUsd(PARTICLE, a.conversation, readerUsd);
    }
    values.set(role, byQuestion);
    exposures.set(role, exposed);
    rowIds.set(role, ids);
    if (role !== 'floor') fill[role] = meanOf(fills);
    for (const [k, x] of usd) { const [reader, conversation] = k.split('|'); costs.push({ row: role, reader, conversation, usd: x === null ? null : r4(x) }); }
  }
  const value = (row: Bg1Row, id: string, reader: string): ReaderValue => values.get(row)?.get(id)?.[reader] ?? { drop: reader === PARTICLE ? 'reread_answer_missing' : 'answer_missing' };
  const questions: QuestionInput[] = [...planned].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, conversation]) => {
    const rows: QuestionInput['rows'] = {};
    for (const row of [...SYSTEM_ROWS, 'floor' as Bg1Row]) if (rowIds.get(row)?.has(id)) rows[row] = Object.fromEntries(READERS.map(r => [r, value(row, id, r)]));
    const exposure = Object.fromEntries([...exposures].flatMap(([row, m]) => (m.has(id) ? [[row, m.get(id)!]] : [])));
    return { id, conversation, stratum: question(id).bg1!.stratum, rows, exposure };
  });
  if (wave) { const seen = new Set(questions.map(q => q.conversation)); const absent = [...wave].filter(c => !seen.has(c)); if (absent.length) refuse(`the pilot needs every wave A world; ${absent.join(', ')} has no rows`); }
  return { set: o.set, questions, fill, costs, snapshots: Object.fromEntries([...snapshots].sort(([a], [b]) => (a < b ? -1 : 1)).map(([j, vs]) => [j, [...vs].sort()])) };
}

// ─── CLI ─────────────────────────────────────────────────────────────

export function main(argv: string[]): number {
  const mode = argv[0];
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const dirs = argv.flatMap((a, i) => (a === '--receipts' && argv[i + 1] ? [resolve(argv[i + 1])] : []));
  const out = one('--out');
  if ((mode !== 'verdict' && mode !== 'pilot') || !dirs.length || !out) {
    process.stderr.write('usage: bun eval/runner/bg1/verdict.ts verdict|pilot --receipts <out dir>... [--manifest <filled bg1-manifest.json>] [--set BG1|BG1-dev3] [--judge-check <summary.json>] --out <dir>\n');
    return 2;
  }
  const set = (one('--set') ?? 'BG1') as LoadOptions['set'];
  if (set !== 'BG1' && set !== 'BG1-dev3') { process.stderr.write(`--set takes BG1 or BG1-dev3, not ${set}\n`); return 2; }
  try {
    const input = loadInput(dirs, { set, manifestPath: one('--manifest'), waveA: mode === 'pilot' });
    mkdirSync(resolve(out), { recursive: true });
    if (mode === 'pilot') {
      const pilot = pilotStats(input), sizing = sizeFromPilot(pilot);
      writeFileSync(join(resolve(out), 'pilot.json'), JSON.stringify({ pilot, sizing }, null, 2) + '\n');
      process.stdout.write(`pilot: ${pilot.worlds} worlds; N_required ${sizing.n_required_max}, N_final ${sizing.n_final}${sizing.pause ? ' (above the cap: pause for GBEV-3)' : ''}\n`);
      return sizing.pause ? 3 : 0;
    }
    const judgeCheck = one('--judge-check') ? JSON.parse(readFileSync(one('--judge-check')!, 'utf8')) : undefined;
    const a = analyze(input, { judgeCheck });
    writeFileSync(join(resolve(out), 'verdict.json'), JSON.stringify(a, null, 2) + '\n');
    const words = a.primary.comparisons.map(c => `${c.row} ${c.verdict ?? 'descriptive'}`).join('; ');
    process.stdout.write(`${a.set}: ${words}; ${a.worlds} worlds, ${a.common} of ${a.planned} questions in the common set${a.primary.worst_case.disagrees ? '; the worst case disagrees' : ''}\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof VerdictError)) throw e;
    process.stderr.write(`bg1 verdict refused: ${e.message}\n`);
    return 2;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));

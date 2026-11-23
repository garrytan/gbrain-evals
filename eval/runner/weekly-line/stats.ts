/**
 * The weekly line's statistics (preregistration docs/benchmarks/2026-11-23-weekly-outcome-line-preregistration.md,
 * "Estimand and verdict rules", "Reported beside the verdict", "Power" and the outcome table), on the values records.ts
 * reads. Nothing here reads a file or a key.
 *
 *   Score        a question scores the share of the two readers (claude-opus-5-5, particle-1) whose answer the judge
 *                passes; a world's class score is the mean over that class's questions, times 100. Per reader, the same
 *                with one reader (0 or 100 a question).
 *   Common set   one per comparison: a question stays only where both rows hold a value for both readers, so a harness
 *                failure on either row, for either reader, leaves it out for both rows and both readers. A product
 *                failure scores 0 and stays. Lost questions are counted against the planned questions of that class in
 *                the worlds read (40 or 24 a world); above 5% of a block's, that comparison is descriptive.
 *   Comparison   each world's gbrain class score minus the other row's, over the common set; the estimate is their mean
 *                over the worlds, with a paired t on N - 1 degrees of freedom and BG1-C's restricted wild cluster
 *                bootstrap over worlds beside it.
 *   Holm         within family 1 (grep agent: now, past) and family 2 (the two servers: now, past), two-sided: the
 *                largest |z| against step 1's bound, and so on, stopping at the first that falls short. z is the normal
 *                score with the same tail probability as the paired t (BG1-C's confirmZ). The bounds are the
 *                O'Brien-Fleming bounds design.ts lists, at the look and at the end, fixed when a block ends short.
 *   Words        ahead or behind: Holm rejects, by the estimate's sign. Level within 3 points: neither, and the family's
 *                simultaneous interval (97.5% or 98.75%, t on N - 1) lies strictly inside -3 to +3. Otherwise no
 *                measurable difference. Ahead, behind and level stand only when each reader's own estimate agrees
 *                (both above 0, both below 0, or both strictly inside -3 to +3); otherwise "split by reader".
 *   Order        no verdict (fewer than 16 counted worlds, or the block has not ended and gave no early word) first, then descriptive, then ceiling (both rows' class means
 *                at least 97 on the comparison's common set), then the early word and "changed within the block", then
 *                the words above.
 *   Look         at the 16th counted world, on the first 16 counted worlds: a comparison that Holm passes at the look
 *                bounds gets its early word, naming only the releases in those worlds. The full block is read the same
 *                way at the end bounds, over every comparison of the family, and published beside it; a full-block
 *                estimate of the opposite sign makes the word "changed within the block". No futility stop.
 *   End          a block ends only with all four of its week entries, weeks with no point included. Before that, the
 *                end bounds are never applied: a comparison carries its early word if it has one and "no verdict"
 *                otherwise, so a file written between the look and the end cannot give a final-stage word.
 *
 * Readings this file had to choose where the preregistration is silent (each the conservative one): the early word is
 * withheld when the first 16 worlds are descriptive, at the ceiling or split by reader, and that comparison is then read
 * at the end like any other; the end's Holm step-down runs over every comparison of the family, those with an early word
 * included, so no alpha is recycled; descriptive and ceiling comparisons stay in Holm's count and order; a comparison
 * with fewer than two worlds in its common set has no z and never passes; and the block word of a comparison whose full
 * block is descriptive or at the ceiling is that, with any early word still reported.
 */
import { confirmZ } from '../bg1/confirm.ts';
import { mdd, pairedT } from '../bg1/rule.ts';
import { BG1_QUESTIONS_PER_STRATUM, BG1_STRATA, type Bg1Stratum } from '../memory-qa/bg1-names.ts';
import { tQuantile } from '../power/risk-ratio.ts';
import { seededRandom } from '../stats/paired.ts';
import { wildTest } from '../stats/wild-cluster.ts';
import { isDrop, passOf, type WlQuestion } from './records.ts';
import {
  familyOf, WL_ALPHA, WL_BLOCK_WORLDS, WL_CEILING_POINTS, WL_CLASS_KEYS, WL_CLASSES, WL_COMPARISONS, WL_DRAWS, WL_DROP_CAP, WL_FALSE_ALARM_SIMS,
  WL_LOOK_WORLDS, WL_MARGIN_POINTS, WL_OBF_BOUNDS, WL_POWER, WL_READER_KEYS, WL_ROLLING_WEEKS, WL_ROWS, WL_SEED, WL_SERVERS, WL_SIMULTANEOUS_LEVEL, WL_WEEK_WORLDS, WL_WEEKLY_SD,
  type WlClass, type WlComparison, type WlFamily, type WlReaderKey, type WlRow, type WlServer, type WlWord,
} from './design.ts';

const meanOf = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const PER_READER = <T,>(f: (r: WlReaderKey) => T) => Object.fromEntries(WL_READER_KEYS.map(r => [r, f(r)])) as Record<WlReaderKey, T>;

// ─── Estimates ───────────────────────────────────────────────────────

/** A mean of per-world values with its paired t on N - 1 degrees of freedom and its two-sided 95% interval; with one world, the mean alone. */
export interface Estimate { worlds: number; mean: number | null; sd: number | null; se: number | null; df: number | null; t: number | null; ci95: [number, number] | null }
export function estimate(xs: readonly number[]): Estimate {
  if (xs.length < 2) return { worlds: xs.length, mean: meanOf(xs), sd: null, se: null, df: null, t: null, ci95: null };
  const p = pairedT(xs);
  return { worlds: p.n, mean: p.mean, sd: p.sd, se: p.se, df: p.df, t: p.t, ci95: p.ci95 };
}

/** The two-sided interval at a level, t on the estimate's degrees of freedom. */
export function interval(e: Estimate, level: number): [number, number] | null {
  if (e.mean === null || e.se === null || e.df === null) return null;
  const q = e.se === 0 ? 0 : tQuantile(1 - (1 - level) / 2, e.df) * e.se;
  return [e.mean - q, e.mean + q];
}

// ─── The common set and per-world differences ────────────────────────

export interface Mask { planned: number; kept: number; lost: number; share: number }
/** One world's difference over a comparison's common set: pooled over the two readers and per reader, with each row's class score. */
export interface WorldDiff { world: string; n: number; d: number; readers: Record<WlReaderKey, number>; gbrain: number; other: number }
export interface Compared { mask: Mask; diffs: WorldDiff[]; pooled: Estimate; readers: Record<WlReaderKey, Estimate>; means: { gbrain: number | null; other: number | null } }

const full = (q: WlQuestion, row: WlRow) => WL_READER_KEYS.every(r => !isDrop(q.rows[row]?.[r]));
const points = (q: WlQuestion, row: WlRow, readers: readonly WlReaderKey[]) => 100 * meanOf(readers.map(r => passOf(q.rows[row]?.[r])!))!;

/** gbrain against `other` over the worlds, on the questions of `strata` (the class's by default): the common set, the per-world differences and their estimates. */
export function compare(questions: readonly WlQuestion[], c: Pick<WlComparison, 'cls' | 'other'>, worlds: readonly string[], strata: readonly Bg1Stratum[] = WL_CLASSES[c.cls].strata): Compared {
  const inWorlds = new Set(worlds);
  const planned = worlds.length * strata.length * BG1_QUESTIONS_PER_STRATUM;
  const kept = questions.filter(q => inWorlds.has(q.world) && strata.includes(q.stratum) && full(q, 'gbrain') && full(q, c.other));
  const diffs = worlds.flatMap((world): WorldDiff[] => {
    const qs = kept.filter(q => q.world === world);
    if (!qs.length) return [];
    const g = meanOf(qs.map(q => points(q, 'gbrain', WL_READER_KEYS)))!, x = meanOf(qs.map(q => points(q, c.other, WL_READER_KEYS)))!;
    return [{ world, n: qs.length, d: g - x, gbrain: g, other: x, readers: PER_READER(r => meanOf(qs.map(q => points(q, 'gbrain', [r]) - points(q, c.other, [r])))!) }];
  });
  const lost = planned - kept.length;
  return {
    mask: { planned, kept: kept.length, lost, share: planned ? lost / planned : 0 }, diffs,
    pooled: estimate(diffs.map(x => x.d)), readers: PER_READER(r => estimate(diffs.map(x => x.readers[r]))),
    means: { gbrain: meanOf(diffs.map(x => x.gbrain)), other: meanOf(diffs.map(x => x.other)) },
  };
}

/** A row's own class score on one world, pooled and per reader, over the class questions where it holds both readers' values; null where it holds none. */
export function rowWorldMean(questions: readonly WlQuestion[], row: WlRow, world: string, strata: readonly Bg1Stratum[]) {
  const qs = questions.filter(q => q.world === world && strata.includes(q.stratum) && full(q, row));
  return { questions: qs.length, pooled: qs.length ? meanOf(qs.map(q => points(q, row, WL_READER_KEYS))) : null, readers: PER_READER(r => (qs.length ? meanOf(qs.map(q => points(q, row, [r]))) : null)) };
}

/** A row's score over the worlds: the mean of its per-world scores, pooled and per reader (the all-64 scores with every stratum). */
export function rowMean(questions: readonly WlQuestion[], row: WlRow, worlds: readonly string[], strata: readonly Bg1Stratum[] = BG1_STRATA) {
  const per = worlds.map(w => rowWorldMean(questions, row, w, strata)).filter(x => x.questions > 0);
  return { worlds: per.length, pooled: meanOf(per.map(x => x.pooled!)), readers: PER_READER(r => meanOf(per.map(x => x.readers[r]!))) };
}

// ─── Holm and the bounds ─────────────────────────────────────────────

/**
 * Holm's two-sided step-down over a family's z's with the bounds of one stage: the largest |z| against the bound at
 * alpha 0.05 / m, the next at 0.05 / (m - 1), and so on, stopping at the first that falls short. Every comparison gets
 * the step and bound it was (or would have been) tested at; a null z sorts last and never passes.
 */
export function holmStepDown(z: readonly (number | null)[], stage: 'look' | 'final'): { passed: boolean[]; step: number[]; bound: number[] } {
  const m = z.length;
  if (m < 1 || m > 4) throw new Error(`the weekly line's families hold 1 to 4 comparisons, not ${m}`);
  const mag = z.map(x => (x === null ? -1 : Math.abs(x)));
  const order = z.map((_, i) => i).sort((a, b) => mag[b] - mag[a] || a - b);
  const passed = z.map(() => false), step = z.map(() => 0), bound = z.map(() => 0);
  let going = true;
  order.forEach((i, k) => {
    step[i] = k + 1;
    bound[i] = WL_OBF_BOUNDS[(m - k) as 1 | 2 | 3 | 4][stage];
    going = going && z[i] !== null && mag[i] >= bound[i];
    passed[i] = going;
  });
  return { passed, step, bound };
}

/** A comparison's z: the normal score with the paired t's tail probability on N - 1 degrees of freedom; null without a t. */
export const zOf = (e: Estimate): number | null => (e.t === null || e.df === null ? null : confirmZ(e.t, e.df));

// ─── A stage: the look or the end ────────────────────────────────────

export interface StageReading extends WlComparison, Compared {
  z: number | null; holm_step: number; bound: number; crossed: boolean;
  simultaneous: { level: number; ci: [number, number] | null };
  descriptive: boolean; ceiling: boolean;
}

/** Every comparison on the worlds, with Holm within each family at the stage's bounds, the simultaneous interval, the drop cap and the ceiling. */
export function readStage(questions: readonly WlQuestion[], worlds: readonly string[], stage: 'look' | 'final'): StageReading[] {
  const compared = WL_COMPARISONS.map(c => ({ c, x: compare(questions, c, worlds) }));
  const out = new Map<string, StageReading>();
  for (const f of [1, 2] as WlFamily[]) {
    const fam = compared.filter(({ c }) => c.family === f);
    const z = fam.map(({ x }) => zOf(x.pooled));
    const h = holmStepDown(z, stage);
    fam.forEach(({ c, x }, i) => out.set(c.key, {
      ...c, ...x, z: z[i], holm_step: h.step[i], bound: h.bound[i], crossed: h.passed[i],
      simultaneous: { level: WL_SIMULTANEOUS_LEVEL[f], ci: interval(x.pooled, WL_SIMULTANEOUS_LEVEL[f]) },
      descriptive: x.mask.share > WL_DROP_CAP,
      ceiling: x.means.gbrain !== null && x.means.other !== null && x.means.gbrain >= WL_CEILING_POINTS && x.means.other >= WL_CEILING_POINTS,
    }));
  }
  return WL_COMPARISONS.map(c => out.get(c.key)!);
}

const inside = (x: number | null) => x !== null && x > -WL_MARGIN_POINTS && x < WL_MARGIN_POINTS;

/** Whether each reader's own estimate agrees with a word: same sign for ahead and behind, both strictly inside -3 to +3 for level. */
export function readersAgree(word: 'ahead' | 'behind' | 'level within 3 points', readers: Record<WlReaderKey, Estimate>): boolean {
  const ms = WL_READER_KEYS.map(r => readers[r].mean);
  if (word === 'ahead') return ms.every(m => m !== null && m > 0);
  if (word === 'behind') return ms.every(m => m !== null && m < 0);
  return ms.every(inside);
}

/** The rule's word for a stage reading, before the block-level order (no verdict, descriptive, ceiling, early word). */
export function ruleWord(s: Pick<StageReading, 'crossed' | 'pooled' | 'readers' | 'simultaneous'>): WlWord {
  if (s.crossed) { const w = s.pooled.mean! > 0 ? 'ahead' : 'behind'; return readersAgree(w, s.readers) ? w : 'split by reader'; }
  const ci = s.simultaneous.ci;
  if (ci && inside(ci[0]) && inside(ci[1])) return readersAgree('level within 3 points', s.readers) ? 'level within 3 points' : 'split by reader';
  return 'no measurable difference';
}

// ─── The look and the block ──────────────────────────────────────────

/** A counted world of a block, in counted order (week, then slot), with the gbrain release and commit its week ran. */
export interface BlockWorld { world: string; week: string; release: string; commit: string }
const releasesOf = (ws: readonly BlockWorld[]) => [...new Set(ws.map(w => w.release))];

export interface LookComparison extends StageReading { early: 'ahead' | 'behind' | null; withheld: 'descriptive' | 'ceiling' | 'split by reader' | null }
export interface LookResult { worlds: string[]; releases: string[]; comparisons: LookComparison[] }

/** The one look, on the first 16 counted worlds: a comparison that crosses its look bound gets its early word unless it is descriptive, at the ceiling or split by reader there. Null when the block has fewer than 16 counted worlds. */
export function analyzeLook(questions: readonly WlQuestion[], counted: readonly BlockWorld[]): LookResult | null {
  if (counted.length < WL_LOOK_WORLDS) return null;
  const first = counted.slice(0, WL_LOOK_WORLDS);
  const comparisons = readStage(questions, first.map(w => w.world), 'look').map((s): LookComparison => {
    if (!s.crossed) return { ...s, early: null, withheld: null };
    const word = ruleWord(s);
    const withheld = s.descriptive ? 'descriptive' : s.ceiling ? 'ceiling' : word === 'split by reader' ? 'split by reader' : null;
    return { ...s, early: withheld ? null : (word as 'ahead' | 'behind'), withheld };
  });
  return { worlds: first.map(w => w.world), releases: releasesOf(first), comparisons };
}

export interface Wild { estimate: number; p: number; ci95: [number, number] }
export interface BlockComparison extends StageReading {
  word: WlWord;
  /** The early word from the look, with the releases of the first 16 counted worlds and their estimate; null when none was given. */
  early: { word: 'ahead' | 'behind'; releases: string[]; pooled: Estimate } | null;
  wild: Wild | null;
}
export interface BlockResult {
  ended: boolean; counted: BlockWorld[]; releases: string[]; look: LookResult | null; comparisons: BlockComparison[];
  /** Whichever server led gbrain in each class: the one with the smaller (more negative) gbrain-minus-server estimate. */
  leading: Record<WlClass, WlServer | null>;
  per_kind: Record<Bg1Stratum, Record<string, Estimate>>;
  all64: Record<WlRow, ReturnType<typeof rowMean>>;
}

/** BG1-C's restricted wild cluster bootstrap-t over worlds (question-weighted, Webb weights, two-sided) on a comparison's per-world differences. */
export function wildOf(diffs: readonly WorldDiff[], draws = WL_DRAWS): Wild | null {
  if (diffs.length < 2 || new Set(diffs.map(x => x.d)).size < 2) return null;
  const w = wildTest(diffs.map(x => ({ id: x.world, stratum: 'all', n: x.n, sum: x.d * x.n })), { draws, seed: WL_SEED });
  return { estimate: w.theta, p: w.p, ci95: w.ci95 };
}

/** A block's words, the look, and what is reported beside them. `ended` says the block holds all four week entries; until then only early words stand. `draws` sets the wild bootstrap's draws (9999 unless a test asks for fewer). */
export function analyzeBlock(questions: readonly WlQuestion[], counted: readonly BlockWorld[], o: { ended: boolean; draws?: number }): BlockResult {
  const worlds = counted.map(w => w.world);
  if (new Set(worlds).size !== worlds.length) throw new Error('a counted world appears twice in the block');
  const look = analyzeLook(questions, counted);
  const final = readStage(questions, worlds, 'final');
  const comparisons = final.map((s, i): BlockComparison => {
    const l = look?.comparisons[i];
    const early = l?.early ? { word: l.early, releases: look!.releases, pooled: l.pooled } : null;
    const word: WlWord = counted.length < WL_LOOK_WORLDS ? 'no verdict'
      : !o.ended ? (early?.word ?? 'no verdict')
      : s.descriptive ? 'descriptive'
        : s.ceiling ? 'ceiling'
          : early ? ((early.word === 'ahead' ? s.pooled.mean! < 0 : s.pooled.mean! > 0) ? 'changed within the block' : early.word)
            : ruleWord(s);
    return { ...s, word, early, wild: wildOf(s.diffs, o.draws) };
  });
  const leading = Object.fromEntries(WL_CLASS_KEYS.map(cls => {
    const servers = comparisons.filter(c => c.cls === cls && (WL_SERVERS as readonly string[]).includes(c.other) && c.pooled.mean !== null);
    servers.sort((a, b) => a.pooled.mean! - b.pooled.mean!);
    return [cls, (servers[0]?.other as WlServer | undefined) ?? null];
  })) as Record<WlClass, WlServer | null>;
  const per_kind = Object.fromEntries(BG1_STRATA.map(s => [s, Object.fromEntries(WL_COMPARISONS.filter(c => (WL_CLASSES[c.cls].strata as readonly string[]).includes(s)).map(c => [c.other, compare(questions, c, worlds, [s]).pooled]))])) as Record<Bg1Stratum, Record<string, Estimate>>;
  const all64 = Object.fromEntries(WL_ROWS.map(r => [r, rowMean(questions, r, worlds)])) as Record<WlRow, ReturnType<typeof rowMean>>;
  return { ended: o.ended, counted: [...counted], releases: releasesOf(counted), look, comparisons, leading, per_kind, all64 };
}

// ─── Weekly points, the rolling display and the regression flag ──────

/** A week's point for one comparison: the same differences over its own worlds, with 95% intervals, and never a word. */
export const weeklyPoint = (questions: readonly WlQuestion[], worlds: readonly string[]) => WL_COMPARISONS.map(c => ({ ...c, ...compare(questions, c, worlds) }));

/** One week's per-world differences for a comparison, as a weekly aggregates file carries them. */
export interface PointWorld { world: string; d: number; readers: Record<WlReaderKey, number> }
export interface PointWeek { week: string; release: string; diffs: Record<string, PointWorld[]> }

/** The rolling display: the last four weekly points pooled (up to 32 worlds, each measured once on its own week's build), naming the builds. */
export function rolling(points: readonly PointWeek[]) {
  const last = [...points].sort((a, b) => (a.week < b.week ? -1 : 1)).slice(-WL_ROLLING_WEEKS);
  const comparisons = WL_COMPARISONS.map(c => {
    const ws = last.flatMap(p => p.diffs[c.key] ?? []);
    return { ...c, pooled: estimate(ws.map(w => w.d)), readers: PER_READER(r => estimate(ws.map(w => w.readers[r]))) };
  });
  return { weeks: last.map(p => p.week), builds: [...new Set(last.map(p => p.release))], comparisons };
}

/** The weekly smallest detectable difference: 80% power at the family's strictest Holm step (two-sided 0.025 or 0.0125), t on 7 degrees of freedom, at the family's per-world SD. */
export function weeklySdd(f: WlFamily, sd = WL_WEEKLY_SD[f]): number {
  return mdd(sd, WL_WEEK_WORLDS, WL_ALPHA / familyOf(f).length / 2, WL_POWER);
}

/** A weekly point outside the previous block's 95% interval by more than the weekly smallest detectable difference, and on which side. */
export function regressionFlag(point: number | null, previous: readonly [number, number] | null, sdd: number): { flagged: boolean; direction: 'below' | 'above' | null } {
  if (point === null || !previous) return { flagged: false, direction: null };
  if (point < previous[0] - sdd) return { flagged: true, direction: 'below' };
  if (point > previous[1] + sdd) return { flagged: true, direction: 'above' };
  return { flagged: false, direction: null };
}

/**
 * The flag's false-alarm rate with no true change: draw a 32-world block and an 8-world week from the per-world
 * differences (with replacement, seeded), and count how often the week falls outside the block's 95% interval by more
 * than the smallest detectable difference. Deterministic for a pool and seed; null with fewer than two values.
 */
export function falseAlarmRate(pool: readonly number[], sdd: number, o: { sims?: number; seed?: number } = {}): number | null {
  if (pool.length < 2) return null;
  const rand = seededRandom(o.seed ?? WL_SEED), sims = o.sims ?? WL_FALSE_ALARM_SIMS;
  const draw = (n: number) => Array.from({ length: n }, () => pool[Math.floor(rand() * pool.length)]);
  let flagged = 0;
  for (let s = 0; s < sims; s++) {
    const block = estimate(draw(WL_BLOCK_WORLDS)), week = meanOf(draw(WL_WEEK_WORLDS));
    if (regressionFlag(week, block.ci95, sdd).flagged) flagged++;
  }
  return flagged / sims;
}

// ─── Cost per correct answer and the grep agent's stops ──────────────

/** A row's spend for one reader on one world, as the weekly runner meters it. */
export interface CostCell { row: WlRow; reader: WlReaderKey; world: string; usd: number }

/** Each reader's and row's spend over its judge-passed answers on the worlds; null when a world's meter is missing or nothing passed. */
export function costPerCorrect(questions: readonly WlQuestion[], worlds: readonly string[], costs: readonly CostCell[]): Record<WlReaderKey, Record<WlRow, number | null>> {
  const inWorlds = new Set(worlds);
  return PER_READER(r => Object.fromEntries(WL_ROWS.map(row => {
    const cells = worlds.map(w => costs.filter(c => c.row === row && c.reader === r && c.world === w));
    if (cells.some(cs => cs.length === 0)) return [row, null];
    const usd = cells.flat().reduce((s, c) => s + c.usd, 0);
    const correct = questions.filter(q => inWorlds.has(q.world)).reduce((s, q) => s + (passOf(q.rows[row]?.[r]) ?? 0), 0);
    return [row, correct ? usd / correct : null];
  })) as Record<WlRow, number | null>);
}

/** The grep agent's answers per reader that ran out of turns or context (both score 0), over its answers that count (not dropped). */
export function grepStops(questions: readonly WlQuestion[], worlds: readonly string[]) {
  const inWorlds = new Set(worlds);
  return PER_READER(r => {
    const cells = questions.filter(q => inWorlds.has(q.world)).map(q => q.rows['grep-agent']?.[r]).filter(c => !isDrop(c)) as Array<{ pass: 0 | 1; failure: string | null }>;
    const turn = cells.filter(c => c.failure === 'turn_cap').length, ctx = cells.filter(c => c.failure === 'context_overflow').length;
    return { answers: cells.length, turn_cap: turn, context_overflow: ctx, turn_cap_rate: cells.length ? turn / cells.length : null, context_overflow_rate: cells.length ? ctx / cells.length : null };
  });
}

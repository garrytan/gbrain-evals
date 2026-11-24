/**
 * The weekly line's aggregates: the only files that leave custody (preregistration
 * docs/benchmarks/2026-11-23-weekly-outcome-line-preregistration.md, "Custody and exposure: What leaves custody each
 * week"). Each week: per world and per class, each row's mean score and each paired difference gbrain minus the other row,
 * per reader and pooled; cost per correct answer; the gbrain release and commit; the comparators' versions; the seed and
 * phrasing ids; and what is computed from those alone (the week's intervals, the rolling display and the regression flag).
 * Per-kind rows, exposure, the block's words and the grep agent's turn-cap and context-overflow rates go only in the
 * per-block file.
 *
 *   bun eval/runner/weekly-line/aggregates.ts week  --meta <week.json> --records <out dir>... [--history <week aggregates>]...
 *                                                   [--previous-block <block aggregates>] [--false-alarm-pool <pool.json> --false-alarm-receipt <receipt.json>]
 *                                                   --out <dir>
 *   bun eval/runner/weekly-line/aggregates.ts block --block <n> --meta <week.json>... --records <out dir>... [--settled <settled.json>]...
 *                                                   [--exposure <exposure.json>] --out <dir>
 *
 * A week's meta file (written in custody by the weekly runner) names the week (its Tuesday launch date), the gbrain
 * release and commit, each server's version and the date it was fixed, the week's worlds in slot order with their seed and
 * phrasing ids, each row's metered spend per reader and world (costs), and no_point when the week recorded none. The
 * records are the cells' answers and judgments (records.ts). The week writes week-<date>.json and its scorecard
 * week-<date>.md; the block writes block-<n>.json and its page section block-<n>.md. The block command reads settled weeks
 * only: it refuses (WEEKLY_NOT_SETTLED) any week passed without the runner's settled marker before it computes anything,
 * so a week still running never reaches the look, as the runner's own block refuses. A block ends only when it lists all
 * four weeks and each carries a settled marker (settled.ts) agreeing with its meta.
 *
 * Each meta names its weekly run (identity.ts), and the command line scores exactly that run: every --records directory
 * holds its run's run.json, which must be the run of one of the metas and agree with it on the week, the frozen gbrain
 * build and the Set W world ids, and every record in it must come from one of that run's cells or re-reads on one of its
 * worlds (boundRecords). Records of another run or week refuse (WEEKLY_RUN_IDENTITY). Until a block ends its file carries no simultaneous interval and no wild bootstrap,
 * because both are end-of-block readings and an open block's would be an interim p-value outside the one look (R113).
 * The block writer never replaces an ended block-<n>.json with an open one (writeBlockFiles).
 *
 * The writer refuses any field that could carry question text, a value, a name or plan content, by an allow-list: every
 * key is fixed (or one of a fixed set, such as the rows, readers, classes and kinds), every number finite, and every
 * string one of a closed vocabulary or an id pattern that cannot hold words (a world id bgw-NNNN, a release vN.N.N.N, a
 * 40-hex commit, a date, a version number, a set label W<n> or a SHA-256). A refusal names the field's path and the kind
 * of problem, never the value or an unknown key, following eval/runner/sota/sealed-guard.ts.
 *
 * Readings chosen where the preregistration is silent: the grep agent's turn-cap and context-overflow rates are not on
 * the weekly list, so they leave once per block, per week; the seed and phrasing ids are the set label (W1, ...) or the
 * SHA-256 a rotation amendment publishes; a weekly row mean is over the questions where that row holds both readers'
 * values; the regression flag fires on either side and says which; its false-alarm rate is simulated from BG1-C's
 * per-world differences (recomputed in custody), and a server comparison publishes that rate only beside BG1-C's custody
 * receipt for the pool, whose SHA-256 of the pool must match (falseAlarmPoolProblems); without the receipt, the rate is
 * unavailable (#611 read-only review blocker 4, GBEV-3 ruling 2026-11-23); BG1-C never ran the grep agent, so its
 * comparisons' rate is unavailable until an amendment defines one; a
 * z with no finite value (every world the same nonzero difference) is written null beside its crossing.
 *
 * Refused besides the allow-list: a point week's world with no answer records, a cost cell repeated for a row, reader
 * and world, one outside the week's worlds, and a spend that is not a finite number of at least 0.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BG1_STRATA, BG1C_CAMPAIGN, BG1C_DATASET, type Bg1Stratum } from '../memory-qa/bg1-names.ts';
import { questionsFromRecords, readRecordDirs, type WlQuestion } from './records.ts';
import {
  analyzeBlock, compare, costPerCorrect, falseAlarmRate, grepStops, regressionFlag, rolling, rowMean, rowWorldMean, weeklySdd,
  type CostCell, type Estimate, type PointWeek,
} from './stats.ts';
import {
  WL_CLASS_KEYS, WL_CLASSES, WL_COMPARISONS, WL_NO_POINT, WL_OTHERS, WL_READER_KEYS, WL_ROWS, WL_SERVERS, WL_WEEK_WORLDS, WL_WEEKS_PER_BLOCK, WL_WORDS,
  type WlNoPoint, type WlReaderKey, type WlServer,
} from './design.ts';
import { renderBlock, renderWeek } from './scorecard.ts';
import { recordDigestProblems, SETTLED_FILE, settledProblems } from './settled.ts';
import { recordBindingProblems, RUN_FILE, RUN_ID, runBindingProblems, type RunIdentity } from './identity.ts';

export class WeeklyAggregateError extends Error {}
const refuse = (m: string): never => { throw new WeeklyAggregateError(m); };

// ─── The allow-list ──────────────────────────────────────────────────

export type Schema =
  | { t: 'num' } | { t: 'int' } | { t: 'bool' }
  | { t: 'null'; of: Schema }
  | { t: 'enum'; values: readonly string[] }
  | { t: 'id'; re: RegExp; what: string }
  | { t: 'obj'; keys: Readonly<Record<string, Schema>> }
  | { t: 'map'; keys: readonly string[]; of: Schema }
  | { t: 'arr'; of: Schema; max: number; len?: number };

export const ID = {
  date: { t: 'id', re: /^\d{4}-\d{2}-\d{2}$/, what: 'a date' },
  release: { t: 'id', re: /^v\d{1,4}(\.\d{1,6}){1,3}$/, what: 'a release tag' },
  commit: { t: 'id', re: /^[0-9a-f]{40}$/, what: 'a 40-hex commit' },
  world: { t: 'id', re: /^bgw-\d{4,5}$/, what: 'a set W world id' },
  run: { t: 'id', re: RUN_ID, what: 'a weekly run id' },
  set: { t: 'id', re: /^(W[1-9]\d{0,2}|[0-9a-f]{64})$/, what: 'a set label or SHA-256' },
  version: { t: 'id', re: /^v?\d{1,4}(\.\d{1,6}){0,3}([-+.](rc|alpha|beta|post|dev)\.?\d{0,6})?$/, what: 'a version number' },
} as const satisfies Record<string, Schema>;

const num: Schema = { t: 'num' }, int: Schema = { t: 'int' }, bool: Schema = { t: 'bool' };
const n = (of: Schema): Schema => ({ t: 'null', of });
const obj = (keys: Record<string, Schema>): Schema => ({ t: 'obj', keys });
const map = (keys: readonly string[], of: Schema): Schema => ({ t: 'map', keys, of });
const arr = (of: Schema, max: number, len?: number): Schema => ({ t: 'arr', of, max, len });
const en = (values: readonly string[]): Schema => ({ t: 'enum', values });
const pair = arr(num, 2, 2);
const readers = (of: Schema) => map(WL_READER_KEYS, of);
const est = obj({ worlds: int, mean: n(num), ci95: n(pair) });
const triple = obj({ pooled: n(num), readers: readers(n(num)) });
const comparators = map(WL_SERVERS, obj({ version: ID.version, fixed: ID.date }));
const gbrain = obj({ release: ID.release, commit: ID.commit });
const cost = readers(map(WL_ROWS, n(num)));
const perClassOther = (of: Schema) => map(WL_CLASS_KEYS, map(WL_OTHERS, of));
const MAX_WORLDS = WL_WEEK_WORLDS * WL_WEEKS_PER_BLOCK;

export const WEEK_SCHEMA: Schema = obj({
  schema: en(['gbrain-evals/weekly-line-week/v1']),
  week: ID.date,
  run_id: ID.run,
  no_point: n(en(WL_NO_POINT)),
  gbrain: n(gbrain),
  comparators: n(comparators),
  worlds: arr(obj({
    world: ID.world, seed_id: ID.set, phrasing_id: ID.set,
    classes: map(WL_CLASS_KEYS, obj({
      means: map(WL_ROWS, obj({ questions: int, pooled: n(num), readers: readers(n(num)) })),
      differences: map(WL_OTHERS, obj({ questions: int, pooled: n(num), readers: readers(n(num)) })),
    })),
  }), WL_WEEK_WORLDS),
  classes: n(map(WL_CLASS_KEYS, obj({
    means: map(WL_ROWS, triple),
    differences: map(WL_OTHERS, obj({ questions: int, planned: int, lost: int, pooled: est, readers: readers(est) })),
  }))),
  cost_per_correct: n(cost),
  rolling: n(obj({ weeks: arr(ID.date, 4), builds: arr(ID.release, 4), differences: perClassOther(obj({ pooled: est, readers: readers(est) })) })),
  regression: n(perClassOther(obj({
    point: n(num), previous_ci95: n(pair), sdd: num, flagged: bool, direction: n(en(['below', 'above'])),
    false_alarm_rate: n(num), false_alarm_source: en(['BG1-C pool', 'unavailable']),
  }))),
});

const exposureSummary = obj({ contexts: int, gold_rate: n(num), stale_rate: n(num), gold_only_rate: n(num), deciding_line_rate: n(num), deciding_line_checked: int });
const stops = obj({ answers: int, turn_cap: int, context_overflow: int, turn_cap_rate: n(num), context_overflow_rate: n(num) });
const holm = obj({ z: n(num), holm_step: int, bound: num, crossed: bool });

export const BLOCK_SCHEMA: Schema = obj({
  schema: en(['gbrain-evals/weekly-line-block/v1']),
  block: int, ended: bool,
  weeks: arr(obj({ week: ID.date, run_id: ID.run, no_point: n(en(WL_NO_POINT)), gbrain: n(gbrain), comparators: n(comparators), worlds: int }), WL_WEEKS_PER_BLOCK),
  counted_worlds: int,
  releases: arr(ID.release, MAX_WORLDS),
  worlds: arr(obj({ world: ID.world, week: ID.date, release: ID.release, seed_id: ID.set, phrasing_id: ID.set }), MAX_WORLDS),
  look: n(obj({ worlds: int, releases: arr(ID.release, MAX_WORLDS) })),
  comparisons: perClassOther(obj({
    word: en(WL_WORDS), family: int,
    early: n(obj({ word: en(['ahead', 'behind']), releases: arr(ID.release, MAX_WORLDS), pooled: est })),
    look: n(obj({ ...((holm as { keys: Record<string, Schema> }).keys), withheld: n(en(['descriptive', 'ceiling', 'split by reader'])), pooled: est })),
    final: n(holm),
    pooled: est, readers: readers(est),
    simultaneous: n(obj({ level: num, ci: n(pair) })),
    wild: n(obj({ estimate: num, p: num, ci95: pair })),
    mask: obj({ planned: int, kept: int, lost: int, share: num }),
    descriptive: bool, ceiling: bool,
    means: obj({ gbrain: n(num), other: n(num) }),
    per_world: arr(obj({ world: ID.world, questions: int, d: num, readers: readers(num) }), MAX_WORLDS),
  })),
  leading_competitor: map(WL_CLASS_KEYS, n(en(WL_SERVERS))),
  per_kind: n(map(BG1_STRATA, map(WL_OTHERS, est))),
  all64: map(WL_ROWS, triple),
  exposure: n(map(WL_ROWS, map(BG1_STRATA, exposureSummary))),
  grep_agent: obj({ weeks: arr(obj({ week: ID.date, readers: readers(stops) }), WL_WEEKS_PER_BLOCK), block: readers(stops) }),
  cost_per_correct: n(cost),
});

const isPlain = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;

/** Every way a value breaks its allow-list, by path and kind of problem; never the value itself or an unknown key. */
export function aggregateProblems(x: unknown, s: Schema, path = '$'): string[] {
  switch (s.t) {
    case 'num': return typeof x === 'number' && Number.isFinite(x) ? [] : [`${path} must be a finite number`];
    case 'int': return Number.isInteger(x) && (x as number) >= 0 ? [] : [`${path} must be a whole number`];
    case 'bool': return typeof x === 'boolean' ? [] : [`${path} must be true or false`];
    case 'null': return x === null ? [] : aggregateProblems(x, s.of, path);
    case 'enum': return typeof x === 'string' && s.values.includes(x) ? [] : [`${path} holds a value outside its fixed vocabulary`];
    case 'id': return typeof x === 'string' && x.length <= 80 && s.re.test(x) ? [] : [`${path} must be ${s.what}, and holds something else`];
    case 'arr': {
      if (!Array.isArray(x)) return [`${path} must be a list`];
      if (x.length > s.max || (s.len !== undefined && x.length !== s.len)) return [`${path} holds ${x.length} entries, outside its allowed count`];
      return x.flatMap((v, i) => aggregateProblems(v, s.of, `${path}[${i}]`));
    }
    case 'obj': case 'map': {
      if (!isPlain(x)) return [`${path} must be an object`];
      const allowed = s.t === 'obj' ? Object.keys(s.keys) : s.keys;
      const unknown = Object.keys(x).filter(k => !allowed.includes(k));
      const p = unknown.length ? [`${path} holds ${unknown.length} field${unknown.length === 1 ? '' : 's'} outside the allow-list`] : [];
      if (s.t === 'obj') for (const k of allowed) if (!(k in x)) p.push(`${path}.${k} is missing`);
      for (const k of allowed.filter(k => k in x)) p.push(...aggregateProblems(x[k], s.t === 'obj' ? s.keys[k] : s.of, `${path}.${k}`));
      return p;
    }
  }
}

export type AggregateKind = 'week' | 'block';
const SCHEMAS: Record<AggregateKind, Schema> = { week: WEEK_SCHEMA, block: BLOCK_SCHEMA };

/** Refuses an aggregate that breaks its allow-list, naming how many problems and where (WEEKLY_AGGREGATE_FIELD). */
export function assertAggregate(x: unknown, kind: AggregateKind, where = `the ${kind} aggregates`): void {
  const p = aggregateProblems(x, SCHEMAS[kind]);
  if (p.length) refuse(`WEEKLY_AGGREGATE_FIELD: ${where} ${p.length === 1 ? 'has 1 field' : `have ${p.length} fields`} outside the allow-list (${p.slice(0, 5).join('; ')}${p.length > 5 ? `; and ${p.length - 5} more` : ''}); no question text, value, name or plan leaves custody`);
}

/** Write an aggregates file only after its allow-list passes. */
export function writeAggregate(path: string, x: unknown, kind: AggregateKind): void {
  assertAggregate(x, kind, path);
  writeFileSync(path, JSON.stringify(x, null, 2) + '\n');
}

// ─── Building the aggregates ─────────────────────────────────────────

/** A week as the weekly runner describes it in custody. */
export interface WeekMeta {
  week: string;
  /** The weekly run this meta describes (identity.ts); its records must carry the same run identity. */
  run_id: string;
  gbrain: { release: string; commit: string } | null;
  comparators: Record<WlServer, { version: string; fixed: string }> | null;
  worlds: Array<{ world: string; seed_id: string; phrasing_id: string }>;
  costs?: CostCell[];
  no_point?: WlNoPoint | null;
}

const r4 = (x: number | null): number | null => (x === null ? null : Math.round(x * 1e4) / 1e4);
const r4p = (x: readonly [number, number] | null): [number, number] | null => (x ? [r4(x[0])!, r4(x[1])!] : null);
const outEst = (e: Estimate) => ({ worlds: e.worlds, mean: r4(e.mean), ci95: r4p(e.ci95) });
const outReaders = <T, U>(rs: Record<WlReaderKey, T>, f: (x: T) => U) => Object.fromEntries(WL_READER_KEYS.map(r => [r, f(rs[r])])) as Record<WlReaderKey, U>;
const outCost = (c: ReturnType<typeof costPerCorrect>) => outReaders(c, rows => Object.fromEntries(WL_ROWS.map(row => [row, r4(rows[row])])));
const byClassOther = <T,>(f: (c: typeof WL_COMPARISONS[number]) => T) => Object.fromEntries(WL_CLASS_KEYS.map(cls => [cls, Object.fromEntries(WL_COMPARISONS.filter(c => c.cls === cls).map(c => [c.other, f(c)]))]));

function checkMeta(m: WeekMeta): void {
  if (typeof m.run_id !== 'string' || !RUN_ID.test(m.run_id) || !m.run_id.startsWith(`wl-${m.week}-`)) refuse(`week ${m.week}'s meta names no run of that week (run_id wl-${m.week}-<12 hex>)`);
  if (!m.no_point) {
    if (!m.worlds.length) refuse(`week ${m.week} has no worlds; record no_point "no worlds"`);
    if (m.worlds.length > WL_WEEK_WORLDS) refuse(`week ${m.week} lists ${m.worlds.length} worlds; a week holds at most ${WL_WEEK_WORLDS}`);
    if (!m.gbrain || !m.comparators) refuse(`week ${m.week} has a point, so it needs the gbrain release and the comparators' versions`);
  }
  if (new Set(m.worlds.map(w => w.world)).size !== m.worlds.length) refuse(`week ${m.week} lists a world twice`);
  const worlds = new Set(m.worlds.map(w => w.world)), seen = new Set<string>();
  for (const c of m.costs ?? []) {
    const key = `${c.row}|${c.reader}|${c.world}`;
    if (seen.has(key)) refuse(`week ${m.week} lists one row's spend for one reader and world twice`);
    seen.add(key);
    if (!worlds.has(c.world)) refuse(`week ${m.week} lists a spend for a world outside the week`);
    if (typeof c.usd !== 'number' || !Number.isFinite(c.usd) || c.usd < 0) refuse(`week ${m.week} lists a spend that is not a finite number of at least 0`);
  }
}

function checkRecords(m: WeekMeta, questions: readonly WlQuestion[]): void {
  const answered = new Set(questions.filter(q => Object.values(q.rows).some(cells => cells && Object.keys(cells).length)).map(q => q.world));
  if (m.worlds.some(w => !answered.has(w.world))) refuse(`week ${m.week} counts a world with no answer records`);
}

/** The custody receipt that vouches for the false-alarm pool: BG1-C's campaign and dataset, the pool's comparisons and the SHA-256 of the pool. */
export const FALSE_ALARM_RECEIPT_SCHEMA = 'gbrain-evals/weekly-line-false-alarm-pool-receipt/v1';
export interface FalseAlarmPoolReceipt { schema: typeof FALSE_ALARM_RECEIPT_SCHEMA; campaign: string; dataset: string; comparisons: string[]; pool_sha256: string }
type Pool = Readonly<Record<string, readonly number[]>>;

/** The pool's SHA-256 over its comparisons in sorted order, as the custody receipt records it. */
export function falseAlarmPoolSha256(pool: Pool): string {
  return createHash('sha256').update(JSON.stringify(Object.keys(pool).sort().map(k => [k, pool[k]]))).digest('hex');
}

/** Why a receipt does not vouch for the pool; empty when it does. */
export function falseAlarmPoolProblems(pool: Pool, receipt: unknown): string[] {
  const r = receipt as Partial<FalseAlarmPoolReceipt> | null;
  if (!isPlain(r) || r.schema !== FALSE_ALARM_RECEIPT_SCHEMA) return [`the false-alarm receipt is not a ${FALSE_ALARM_RECEIPT_SCHEMA} receipt`];
  const p: string[] = [];
  if (r.campaign !== BG1C_CAMPAIGN || r.dataset !== BG1C_DATASET) p.push("the false-alarm receipt does not name BG1-C's campaign and dataset");
  const keys = Object.keys(pool).sort();
  if (!Array.isArray(r.comparisons) || [...r.comparisons].sort().join(',') !== keys.join(',')) p.push("the false-alarm receipt lists other comparisons than the pool");
  if (r.pool_sha256 !== falseAlarmPoolSha256(pool)) p.push("the false-alarm pool's SHA-256 does not match its custody receipt");
  return p;
}

const zOut = (z: number | null) => (z === null || !Number.isFinite(z) ? null : r4(z));

/** What a later week reads back from a weekly aggregates file: its build and its per-world differences. */
export interface WeekLike {
  week: string; no_point: WlNoPoint | null; gbrain: { release: string; commit: string } | null;
  worlds: ReadonlyArray<{ world: string; classes: Record<string, { differences: Record<string, { pooled: number | null; readers: Record<WlReaderKey, number | null> }> }> }>;
}
/** What a week reads back from the previous block's file: each comparison's 95% interval and per-world differences. */
export interface BlockLike { ended: boolean; comparisons: Record<string, Record<string, { pooled: { ci95: [number, number] | null }; per_world: ReadonlyArray<{ d: number }> }>> }

/** The week's per-world differences, as a later week's rolling display reads them back. */
export function pointWeekOf(a: WeekLike): PointWeek | null {
  if (a.no_point || !a.gbrain) return null;
  const diffs = Object.fromEntries(WL_COMPARISONS.map(c => [c.key, a.worlds.flatMap(w => {
    const d = w.classes[c.cls].differences[c.other];
    return d.pooled === null || WL_READER_KEYS.some(r => d.readers[r] === null) ? [] : [{ world: w.world, d: d.pooled, readers: d.readers as Record<WlReaderKey, number> }];
  })]));
  return { week: a.week, release: a.gbrain.release, diffs };
}

export type WeekAggregates = ReturnType<typeof weekAggregates>;
export type BlockAggregates = ReturnType<typeof blockAggregates>;

/**
 * A week's aggregates from its meta and its values: per world and class, means and differences; per class, the week's
 * point with intervals and no word; cost per correct answer; the rolling display over this week and the earlier weekly
 * aggregates in `history`; and the regression flag against `previousBlock`'s 95% intervals.
 */
export function weekAggregates(meta: WeekMeta, questions: readonly WlQuestion[], o: { history?: readonly WeekLike[]; previousBlock?: BlockLike | null; falseAlarmPool?: Pool; falseAlarmReceipt?: unknown } = {}) {
  checkMeta(meta);
  const base = { schema: 'gbrain-evals/weekly-line-week/v1' as const, week: meta.week, run_id: meta.run_id, no_point: meta.no_point ?? null, gbrain: meta.gbrain, comparators: meta.comparators };
  if (meta.no_point) return { ...base, worlds: [] as never[], classes: null, cost_per_correct: null, rolling: null, regression: null };
  checkRecords(meta, questions);
  const ids = meta.worlds.map(w => w.world);
  const history = o.history ?? [];
  const earlierWorlds = history.flatMap(h => h.worlds.map(w => w.world));
  if (new Set(history.map(h => h.week)).size !== history.length || new Set(earlierWorlds).size !== earlierWorlds.length) refuse('the history repeats a week or a world; pass each earlier week once');
  if (history.some(h => h.week === meta.week)) refuse(`the history already holds week ${meta.week}`);
  const earlier = new Set(earlierWorlds);
  if (ids.some(w => earlier.has(w))) refuse(`week ${meta.week} counts a world an earlier week already counted; each world is counted in exactly one week`);
  const compared = new Map(WL_COMPARISONS.map(c => [c.key, compare(questions, c, ids)]));
  const worlds = meta.worlds.map(w => ({
    world: w.world, seed_id: w.seed_id, phrasing_id: w.phrasing_id,
    classes: Object.fromEntries(WL_CLASS_KEYS.map(cls => [cls, {
      means: Object.fromEntries(WL_ROWS.map(row => { const m = rowWorldMean(questions, row, w.world, WL_CLASSES[cls].strata); return [row, { questions: m.questions, pooled: r4(m.pooled), readers: outReaders(m.readers, r4) }]; })),
      differences: Object.fromEntries(WL_COMPARISONS.filter(c => c.cls === cls).map(c => {
        const d = compared.get(c.key)!.diffs.find(x => x.world === w.world);
        return [c.other, { questions: d?.n ?? 0, pooled: r4(d?.d ?? null), readers: outReaders(WL_READER_KEYS.reduce((acc, r) => ({ ...acc, [r]: d ? d.readers[r] : null }), {} as Record<WlReaderKey, number | null>), r4) }];
      })),
    }])),
  }));
  const classes = Object.fromEntries(WL_CLASS_KEYS.map(cls => [cls, {
    means: Object.fromEntries(WL_ROWS.map(row => { const m = rowMean(questions, row, ids, WL_CLASSES[cls].strata); return [row, { pooled: r4(m.pooled), readers: outReaders(m.readers, r4) }]; })),
    differences: Object.fromEntries(WL_COMPARISONS.filter(c => c.cls === cls).map(c => { const x = compared.get(c.key)!; return [c.other, { questions: x.mask.kept, planned: x.mask.planned, lost: x.mask.lost, pooled: outEst(x.pooled), readers: outReaders(x.readers, outEst) }]; })),
  }]));
  const partial = { ...base, worlds, classes, cost_per_correct: outCost(costPerCorrect(questions, ids, meta.costs ?? [])), rolling: null, regression: null };
  const points = [...history.map(pointWeekOf).filter((p): p is PointWeek => p !== null && p.week < meta.week), pointWeekOf(partial)!];
  const roll = rolling(points);
  const prev = o.previousBlock ?? null;
  if (prev && !prev.ended) refuse('the previous block has not ended, so its interval cannot anchor the regression flag');
  if (Object.keys(o.falseAlarmPool ?? {}).some(k => k.endsWith('|grep-agent'))) refuse('BG1-C never ran the grep agent, so the false-alarm pool holds no grep-agent comparison');
  if (o.falseAlarmReceipt !== undefined) {
    if (!o.falseAlarmPool) refuse('a false-alarm receipt was given without its pool');
    const p = falseAlarmPoolProblems(o.falseAlarmPool!, o.falseAlarmReceipt);
    if (p.length) refuse(`WEEKLY_FALSE_ALARM_RECEIPT: ${p.join('; ')}`);
  }
  const vouched = o.falseAlarmReceipt !== undefined ? o.falseAlarmPool : undefined;
  const regression = prev ? byClassOther(c => {
    const pc = prev.comparisons[c.cls][c.other], sdd = weeklySdd(c.family), point = compared.get(c.key)!.pooled.mean;
    const flag = regressionFlag(point, pc.pooled.ci95, sdd);
    if (c.other === 'grep-agent' || !vouched) return { point: r4(point), previous_ci95: pc.pooled.ci95, sdd: r4(sdd)!, flagged: flag.flagged, direction: flag.direction, false_alarm_rate: null, false_alarm_source: 'unavailable' as const };
    const pool = vouched[c.key];
    if (!pool || pool.length < 2 || !pool.every(Number.isFinite)) return refuse(`the regression flag's false-alarm rate needs at least two of BG1-C's per-world differences for ${c.key}, each a finite number; pass them with --false-alarm-pool`);
    return { point: r4(point), previous_ci95: pc.pooled.ci95, sdd: r4(sdd)!, flagged: flag.flagged, direction: flag.direction, false_alarm_rate: r4(falseAlarmRate(pool, sdd)), false_alarm_source: 'BG1-C pool' as const };
  }) : null;
  return {
    ...partial,
    rolling: { weeks: roll.weeks, builds: roll.builds, differences: byClassOther(c => { const x = roll.comparisons.find(y => y.key === c.key)!; return { pooled: outEst(x.pooled), readers: outReaders(x.readers, outEst) }; }) },
    regression,
  };
}

/** A block's per-block file: whether it has ended (all four week entries, weeks with no point included, each settled by a marker in `settled`), the words with the look, the release set, both readers' rows, per-kind rows and exposure (null until the block ends, so they leave once per block), the grep agent's stops per week and cost per correct answer. */
export function blockAggregates(block: number, metas: readonly WeekMeta[], questions: readonly WlQuestion[], o: { exposure?: unknown; draws?: number; settled?: readonly unknown[] } = {}) {
  if (!Number.isInteger(block) || block < 1) refuse('the block number must be a whole number from 1');
  if (metas.length > WL_WEEKS_PER_BLOCK) refuse(`a block holds at most ${WL_WEEKS_PER_BLOCK} weeks, not ${metas.length}`);
  metas.forEach(checkMeta);
  const weeks = [...metas].sort((a, b) => (a.week < b.week ? -1 : 1));
  const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
  const isDate = (d: string) => Number.isInteger(day(d)) && new Date(day(d) * 86_400_000).toISOString().slice(0, 10) === d;
  weeks.forEach((w, i) => {
    if (!isDate(w.week)) refuse(`week ${w.week} is not a date`);
    if (i && w.week === weeks[i - 1].week) refuse(`the block lists week ${w.week} twice`);
    if (i && day(w.week) - day(weeks[i - 1].week) !== 7) refuse(`the block's weeks must be consecutive, 7 days apart, not ${weeks[i - 1].week} then ${w.week}`);
  });
  weeks.filter(w => !w.no_point).forEach(w => checkRecords(w, questions));
  const markers = o.settled ?? [];
  const weekOf = (m: unknown) => (typeof m === 'object' && m !== null ? (m as { week?: unknown }).week : undefined);
  const strays = markers.filter(m => !weeks.some(w => w.week === weekOf(m)));
  if (strays.length) refuse(`${strays.length} settled marker${strays.length === 1 ? ' names' : 's name'} a week outside the block`);
  const settled = weeks.filter(w => {
    const mine = markers.filter(m => weekOf(m) === w.week);
    if (mine.length > 1) refuse(`week ${w.week} has more than one settled marker`);
    const p = mine.length ? settledProblems(mine[0], w) : [];
    if (p.length) refuse(p.join('; '));
    return mine.length === 1;
  });
  const ended = weeks.length === WL_WEEKS_PER_BLOCK && settled.length === WL_WEEKS_PER_BLOCK;
  const counted = weeks.filter(w => !w.no_point).flatMap(w => w.worlds.map(x => ({ world: x.world, week: w.week, release: w.gbrain!.release, commit: w.gbrain!.commit, seed_id: x.seed_id, phrasing_id: x.phrasing_id })));
  if (new Set(counted.map(w => w.world)).size !== counted.length) refuse('a world is counted in two weeks of the block');
  const ids = counted.map(w => w.world);
  const r = analyzeBlock(questions, counted, { ended, draws: o.draws });
  const costs = weeks.flatMap(w => w.costs ?? []);
  return {
    schema: 'gbrain-evals/weekly-line-block/v1' as const, block, ended,
    weeks: weeks.map(w => ({ week: w.week, run_id: w.run_id, no_point: w.no_point ?? null, gbrain: w.gbrain, comparators: w.comparators, worlds: w.no_point ? 0 : w.worlds.length })),
    counted_worlds: counted.length, releases: r.releases,
    worlds: counted.map(w => ({ world: w.world, week: w.week, release: w.release, seed_id: w.seed_id, phrasing_id: w.phrasing_id })),
    look: r.look ? { worlds: r.look.worlds.length, releases: r.look.releases } : null,
    comparisons: byClassOther(c => {
      const x = r.comparisons.find(y => y.key === c.key)!, l = r.look?.comparisons.find(y => y.key === c.key) ?? null;
      return {
        word: x.word, family: x.family,
        early: x.early ? { word: x.early.word, releases: x.early.releases, pooled: outEst(x.early.pooled) } : null,
        look: l ? { z: zOut(l.z), holm_step: l.holm_step, bound: l.bound, crossed: l.crossed, withheld: l.withheld, pooled: outEst(l.pooled) } : null,
        final: ended ? { z: zOut(x.z), holm_step: x.holm_step, bound: x.bound, crossed: x.crossed } : null,
        pooled: outEst(x.pooled), readers: outReaders(x.readers, outEst),
        simultaneous: ended ? { level: x.simultaneous.level, ci: r4p(x.simultaneous.ci) } : null,
        wild: ended && x.wild ? { estimate: r4(x.wild.estimate)!, p: r4(x.wild.p)!, ci95: r4p(x.wild.ci95)! } : null,
        mask: { ...x.mask, share: r4(x.mask.share)! }, descriptive: x.descriptive, ceiling: x.ceiling,
        means: { gbrain: r4(x.means.gbrain), other: r4(x.means.other) },
        per_world: x.diffs.map(d => ({ world: d.world, questions: d.n, d: r4(d.d)!, readers: outReaders(d.readers, v => r4(v)!) })),
      };
    }),
    leading_competitor: r.leading,
    per_kind: !ended ? null : Object.fromEntries(BG1_STRATA.map(s => [s, Object.fromEntries(WL_OTHERS.map(other => [other, outEst(r.per_kind[s][other] ?? { worlds: 0, mean: null, sd: null, se: null, df: null, t: null, ci95: null })]))])) as Record<Bg1Stratum, Record<string, ReturnType<typeof outEst>>>,
    all64: Object.fromEntries(WL_ROWS.map(row => [row, { pooled: r4(r.all64[row].pooled), readers: outReaders(r.all64[row].readers, r4) }])),
    exposure: (ended ? o.exposure ?? null : null) as Record<string, Record<string, Record<string, number | null>>> | null,
    grep_agent: {
      weeks: weeks.filter(w => !w.no_point).map(w => ({ week: w.week, readers: grepStops(questions, w.worlds.map(x => x.world)) })),
      block: grepStops(questions, ids),
    },
    cost_per_correct: counted.length ? outCost(costPerCorrect(questions, ids, costs)) : null,
  };
}

/**
 * Write a block's file and page section. Refuses (WEEKLY_BLOCK_ENDED) to replace a block file that has ended with one
 * that has not, so re-running a block on three of its weeks after the four-week write never puts an open block over the
 * ended one; an existing file it cannot read refuses too. Returns the file's path.
 */
export function writeBlockFiles(out: string, a: BlockAggregates): string {
  const json = join(out, `block-${a.block}.json`);
  if (existsSync(json) && !a.ended) {
    let earlier: unknown;
    try { earlier = JSON.parse(readFileSync(json, 'utf8')); } catch { refuse(`WEEKLY_BLOCK_ENDED: ${json} exists and is not readable JSON, so it may hold the ended block; move it aside by hand before writing block ${a.block} again`); }
    if (!isPlain(earlier) || earlier.ended !== false) refuse(`WEEKLY_BLOCK_ENDED: ${json} holds block ${a.block} after its end, and this write has not ended; an ended block file is never replaced by an open one`);
  }
  writeAggregate(json, a, 'block');
  writeFileSync(join(out, `block-${a.block}.md`), renderBlock(a));
  return json;
}

// ─── The command line ────────────────────────────────────────────────

const readJson = (path: string): any => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : refuse(`${path} does not exist`));
const flags = (argv: readonly string[], name: string) => argv.flatMap((a, i) => (a === name ? [argv[i + 1] ?? refuse(`${name} needs a value`)] : []));
const flag = (argv: readonly string[], name: string) => flags(argv, name).at(-1);

/**
 * The records of exactly the weeks' runs: each record directory holds its run's run.json, which must be the run one of
 * the metas names and agree with it on the week, the gbrain build and the worlds, and every answer in it must come from
 * one of that run's cells or re-reads on one of its worlds. It must also hold the runner's settled.json for that week,
 * and its answer and judgment files must be exactly the ones that marker digested (WEEKLY_SETTLED_RECORDS). Each week
 * with a point needs its run's records, once.
 */
export function boundRecords(dirs: readonly string[], metas: readonly WeekMeta[]): ReturnType<typeof readRecordDirs> {
  const seen = new Set<string>();
  const parts = dirs.map(d => {
    const path = join(d, RUN_FILE);
    if (!existsSync(path)) refuse(`${d} has no ${RUN_FILE}, so its records cannot be bound to a week's run`);
    const run = readJson(path) as RunIdentity;
    const m = metas.find(x => x.run_id === run.run_id) ?? refuse(`${d} holds the records of run ${String(run.run_id)}, which is not the run of any week passed with --meta`);
    if (seen.has(m.run_id)) refuse(`run ${m.run_id}'s records were passed twice`);
    seen.add(m.run_id);
    const recs = readRecordDirs([d]);
    const p = [...runBindingProblems(run, m), ...recordBindingProblems(run, recs.answers)];
    if (p.length) refuse(`WEEKLY_RUN_IDENTITY: ${d}: ${p.slice(0, 3).join('; ')}`);
    const settledPath = join(d, SETTLED_FILE);
    if (!existsSync(settledPath)) refuse(`WEEKLY_NOT_SETTLED: ${d} has no ${SETTLED_FILE}, so its records were never settled`);
    const marker = readJson(settledPath);
    const s = [...settledProblems(marker, m), ...recordDigestProblems(marker, d)];
    if (s.length) refuse(`WEEKLY_SETTLED_RECORDS: ${d}: ${s.slice(0, 3).join('; ')}`);
    return recs;
  });
  const missing = metas.filter(m => !m.no_point && !seen.has(m.run_id));
  if (missing.length) refuse(`week ${missing[0].week}'s run ${missing[0].run_id} has no records passed with --records`);
  return { answers: parts.flatMap(p => p.answers), judgments: parts.flatMap(p => p.judgments) };
}

export function main(argv: readonly string[]): number {
  const [mode, ...rest] = argv;
  const out = flag(rest, '--out') ?? refuse('pass --out <dir>');
  mkdirSync(out, { recursive: true });
  const metas = flags(rest, '--meta').map(p => readJson(p) as WeekMeta);
  if (!metas.length) refuse('pass --meta <week.json>');
  if (mode === 'week' && metas.length !== 1) refuse('week reads exactly one --meta');
  const settled = mode === 'block' ? flags(rest, '--settled').map(readJson) : [];
  const unsettled = mode === 'block' ? metas.filter(m => !settled.some(s => isPlain(s) && s.week === m.week)) : [];
  if (unsettled.length) refuse(`WEEKLY_NOT_SETTLED: a block reads settled weeks only, and week ${unsettled[0].week}${unsettled.length > 1 ? ` (and ${unsettled.length - 1} more)` : ''} has no settled marker passed with --settled`);
  const records = boundRecords(flags(rest, '--records'), metas);
  const worlds = metas.filter(m => !m.no_point).flatMap(m => m.worlds.map(w => w.world));
  const questions = questionsFromRecords(worlds, records.answers, records.judgments);
  if (mode === 'week') {
    const history = flags(rest, '--history').map(p => { const h = readJson(p); assertAggregate(h, 'week', p); return h as WeekLike; });
    const prevPath = flag(rest, '--previous-block');
    const previousBlock = prevPath ? (() => { const b = readJson(prevPath); assertAggregate(b, 'block', prevPath); return b as BlockLike; })() : null;
    const poolPath = flag(rest, '--false-alarm-pool');
    const pool = poolPath ? readJson(poolPath) : undefined;
    if (pool !== undefined && (!isPlain(pool) || Object.entries(pool).some(([k, v]) => !WL_COMPARISONS.some(c => c.key === k) || !Array.isArray(v) || !v.every(x => typeof x === 'number' && Number.isFinite(x))))) refuse(`${poolPath} must map comparison keys to lists of per-world differences`);
    const receiptPath = flag(rest, '--false-alarm-receipt');
    const a = weekAggregates(metas[0], questions, { history, previousBlock, falseAlarmPool: pool, falseAlarmReceipt: receiptPath ? readJson(receiptPath) : undefined });
    const json = join(out, `week-${a.week}.json`);
    writeAggregate(json, a, 'week');
    writeFileSync(join(out, `week-${a.week}.md`), renderWeek(a));
    console.log(`wrote ${json} and its scorecard`);
    return 0;
  }
  if (mode === 'block') {
    const block = Number(flag(rest, '--block') ?? refuse('pass --block <n>'));
    const expPath = flag(rest, '--exposure');
    const a = blockAggregates(block, metas, questions, { exposure: expPath ? readJson(expPath) : undefined, settled });
    console.log(`wrote ${writeBlockFiles(out, a)} and its page section`);
    return 0;
  }
  return refuse('the mode is week or block');
}

if (import.meta.main) {
  try { process.exit(main(process.argv.slice(2))); } catch (e) { console.error((e as Error).message); process.exit(2); }
}

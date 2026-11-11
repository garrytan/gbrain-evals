/**
 * The nightly report: per suite, reader and ref, pass^1 and pass^k, failures by cause and cost per correct answer, and the
 * comparison with the previous master night (and, on matrix nights, master against stable).
 *
 *   bun eval/runner/nightly/report.ts --night-dir <dir> [--previous <night dir>] [--stable <night dir>] [--gbrain-clone <path>]
 *
 * pass^k is tau-bench's estimator: an item with c passes in n trials contributes C(c,k)/C(n,k), the chance that k trials drawn
 * from its n all pass, averaged over items; pass^1 is the plain pass rate. Harness rows (provider or harness failures, and
 * answers cut off at their output limit: outcome.ts harnessOf) are left out of every rate and counted on their own line,
 * and skipped rows (items the night scheduled and did not run) are left out of every rate and count, and shown as not run. Cost per correct answer is the suite's whole recorded cost over
 * its passing rows.
 *
 * Failures by cause come from the failure-cause library (eval/runner/failure-causes): each failed or harness row becomes
 * the EvalFailure the nightly adapter builds (nightlyFailure) and goes through classify(), so a cell counts the taxonomy's
 * cause ids, with harness rows as harness_error, plus unclassified for a failure no deterministic rule explains (the
 * nightly never sends a row to the labeller). summary.json records the taxonomy version.
 *
 * Flags against the previous master night, suite by suite and only where the suite digests match:
 *   - a deterministic signal (refused tool calls, tool errors, harness errors, lost, stuck, duplicated or overwritten writes,
 *     smoke failures) on any increase;
 *   - the pass rate, paired by item with a task-clustered bootstrap (items resampled with their trials, 10,000 resamples,
 *     seed 1): when the 95% interval of tonight minus the previous night excludes zero and the drop is at least 5 points;
 *   - a strong flip: an item that passed k of k trials and now passes 0 of k;
 *   - cost per correct answer up 25% or more with no gain in pass rate.
 * The pass-rate and cost rules wait a night: the first night one meets is a watch (summary.json watches, with the baseline
 * night's per-item counts), and it is a flag only if the next night meets it again against that baseline. The test runs on
 * every suite and reader each night, so chance hits are common, while run-to-run variation in pass rate measured no larger
 * than the item bootstrap already allows (docs/nightly.md). The same rules compare master with stable, reported in their own
 * section, where every rule that meets flags at once. An item whose support record says the cited
 * gold sessions don't support the answer (eval/runner/nightly/item-support.ts) stays in every comparison; its failed rows
 * count as item_unsupported, a weekly cause label, and are listed on their own line.
 *
 * particle-1's agreement with claude-opus-5-5, scored on a night that schedules particle-1: per item, particle-1's first
 * trial and Opus's first counted trial are each reader's pass or fail. A harness row from particle-1's own provider or call
 * (a crash, an invalid answer, a 4xx or 5xx on the reader call) is a fail for particle-1, never a dropped item. A harness
 * row from a stage both readers share (embedding, retrieval, rerank or the judge: outcome.ts harnessCause) or one a
 * run-level stop cut off leaves the item unpaired with that cause, as does a gbrain tool error on either reader's counted
 * row whose embedding or retrieval provider returned a 429 or 5xx (outcome.ts toolErrorCause), an item Opus has no
 * counted trial for or the night didn't run for particle-1, and the suite and the verdict count unpaired items by cause.
 * Any other gbrain tool error stays a fail for the reader whose row it is. A night that ends on a
 * budget stop or loses its VM is not measured. Each suite's 2x2 table gives its raw agreement, Cohen's kappa and
 * particle-1's pass-rate gap to Opus, and a suite counts toward the verdict with at least 20 paired items. particle-1
 * passes with at least 40 counted items, no more than 10% of scheduled items unpaired, an item-weighted mean of the
 * counted suites' kappas of at least 0.6 and their raw agreement of at least 85%, each bar within floating-point error;
 * below the floors it is not measured, with the reason. A suite's kappa is undefined (null, left out of the mean) when both readers give every item the same label.
 * The kappa of every measured suite's tables pooled is reported for reference only, because pooling credits differences
 * in difficulty between suites as agreement. Writes report.md, summary.json and outcomes.jsonl.gz into the night
 * directory.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { pairedBootstrap } from '../refresh-barrier/analyze.ts';
import { CAUSE_IDS, TAXONOMY_VERSION, UNCLASSIFIED, classify, nightlyFailure, type Cause } from '../failure-causes/index.ts';
import { harnessCause, readOutcomes, toolErrorCause, UPSTREAM_CAUSES, type Outcome } from './outcome.ts';

const REPO = resolve(import.meta.dir, '../../..');
export const FIXES_PATH = 'eval/data/nightly/fixes.json';
export const PASS_DROP = 0.05;
export const COST_RISE = 1.25;

export interface SuiteStatus {
  id: string; digest: string; k: number; readers: Array<string | null>;
  /** How many items the plan scheduled; nights recorded before this field existed lack it. */
  items?: number;
  /** pending while the suite runs; a night that stops leaves it pending, and a finished night records it as error. */
  status: 'pending' | 'ran' | 'partial' | 'skipped' | 'not_built' | 'error';
  reason?: string;
  dev_set?: DevSetRun;
}
/** A suite run as a dev set on the current harness rather than a frozen experiment's (Cat 40 world M under --dev-set); freeze_drift is null when the freeze was not checked. */
export interface DevSetRun { label: string; freeze_drift: string[] | null }
export interface NightManifest {
  schema: 'nightly-night/1'; night: string; ref: string; sha: string; version: string | null; tier: string; fake: boolean;
  devset: { path: string; digest: string }; suites: SuiteStatus[]; started_at: string; finished_at?: string;
  /** The night's ledger run; opened_by_night when run.ts opened it itself, and closed_at once it closed it. */
  budget?: { run_id: string; ledger: string; opened_by_night?: boolean; closed_at?: string } | null;
  /** The invocation's arguments, which --resume repeats, and how many times the night has been started. */
  argv?: string[]; attempts?: number;
  /** The stop code the night ended with (run.ts EXIT), or null when it finished whole. */
  exit?: string | null;
}

const WRITE_LOSS = ['lost', 'lost_git', 'phantom', 'duplicated', 'stuck', 'overwritten', 'wrong_expiry', 'unindexed', 'unpublished'];
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** tau-bench's pass^k for one item: C(c,k)/C(n,k); null when it has fewer than k trials. */
export function passHatK(c: number, n: number, k: number): number | null {
  if (n < k || k < 1) return null;
  let p = 1;
  for (let i = 0; i < k; i++) p *= (c - i) / (n - i);
  return Math.max(0, p);
}

export interface Signals { refusals: number; tool_errors: number; harness_errors: number; lost_writes: number; smoke_failures: number }
export const SIGNAL_NAMES: Array<keyof Signals> = ['refusals', 'tool_errors', 'harness_errors', 'lost_writes', 'smoke_failures'];

export function signalsOf(rows: Outcome[]): Signals {
  const s: Signals = { refusals: 0, tool_errors: 0, harness_errors: 0, lost_writes: 0, smoke_failures: 0 };
  for (const r of rows) {
    if (r.harness) { s.harness_errors++; continue; }
    s.refusals += r.tool_errors.filter(t => t.refused).length;
    s.tool_errors += r.tool_errors.filter(t => !t.refused).length;
    s.lost_writes += list(r.evidence.failure_classes).filter(c => WRITE_LOSS.includes(String(c))).length + list(r.evidence.duplicated).length + list(r.evidence.acknowledged_missing).length;
    if (r.evidence.kind === 'smoke' && !r.pass) s.smoke_failures++;
  }
  return s;
}

export interface CellStats {
  suite: string; reader: string | null; items: number; trials: number; k: number;
  pass1: number | null; passk: number | null; passes: number;
  failures_by_cause: Partial<Record<Cause | typeof UNCLASSIFIED, number>>; harness: number; skipped: number;
  cost_usd: number | null; cost_per_correct: number | null; signals: Signals;
  /** Per item: passes and non-harness trials. */
  per_item: Record<string, { c: number; n: number }>;
}

export function cellStats(suite: string, reader: string | null, rows: Outcome[], k: number): CellStats {
  const counted = rows.filter(r => !r.harness && !r.skipped);
  const per_item: Record<string, { c: number; n: number }> = {};
  for (const r of counted) { const e = per_item[r.item] ??= { c: 0, n: 0 }; e.n++; if (r.pass) e.c++; }
  const items = Object.values(per_item);
  const mean = (xs: Array<number | null>) => { const v = xs.filter((x): x is number => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const failures_by_cause: CellStats['failures_by_cause'] = {};
  for (const r of rows) {
    if (r.skipped || (r.pass && !r.harness)) continue;
    const c = classify(nightlyFailure(r, `nightly-${suite}`, [])).cause ?? UNCLASSIFIED;
    failures_by_cause[c] = (failures_by_cause[c] ?? 0) + 1;
  }
  const costs = rows.map(r => r.cost_usd);
  const cost_usd = costs.some(c => c !== null) ? costs.reduce<number>((a, c) => a + (c ?? 0), 0) : null;
  const passes = counted.filter(r => r.pass).length;
  return {
    suite, reader, items: items.length, trials: counted.length, k, passes,
    pass1: mean(items.map(i => i.c / i.n)), passk: mean(items.map(i => passHatK(i.c, i.n, k))),
    failures_by_cause, harness: rows.filter(r => r.harness).length, skipped: rows.filter(r => r.skipped).length, cost_usd, cost_per_correct: cost_usd !== null && passes ? cost_usd / passes : null,
    signals: signalsOf(rows), per_item,
  };
}

export function nightCells(manifest: NightManifest, rows: Outcome[]): CellStats[] {
  const out: CellStats[] = [];
  for (const s of manifest.suites) {
    const mine = rows.filter(r => r.suite === s.id);
    const readers = [...new Set([...s.readers, ...mine.map(r => r.reader)])];
    for (const reader of readers) {
      const cell = mine.filter(r => r.reader === reader);
      if (cell.some(r => !r.skipped) || s.status === 'ran' || s.status === 'partial') out.push(cellStats(s.id, reader, cell, s.k));
    }
  }
  return out;
}

export interface Flag { kind: 'signal' | 'pass_rate' | 'strong_flip' | 'cost'; against: 'previous' | 'stable'; suite: string; reader: string | null; detail: string; items?: string[] }
/**
 * A pass-rate drop or cost rise that met its rule against the previous master night for the first time. It files as a
 * flag only if the next night meets the rule again against the same baseline night, so the baseline's per-item counts,
 * pass rate and cost per correct answer travel with it in summary.json, the one file of that night the next night reads.
 */
export interface Watch {
  kind: 'pass_rate' | 'cost'; suite: string; reader: string | null; digest: string; detail: string;
  baseline: { night: string; sha: string; per_item: Record<string, { c: number; n: number }>; pass1: number | null; cost_per_correct: number | null };
}
export interface Comparison {
  against: 'previous' | 'stable'; night: string; ref: string; sha: string;
  suites: Array<{ suite: string; reader: string | null; compared: boolean; reason?: string; pass_diff?: { mean: number | null; lo: number | null; hi: number | null; items: number }; strong_flips?: string[]; cost_ratio?: number | null }>;
  flags: Flag[];
  watches: Watch[];
}

/**
 * Tonight against an earlier night. Against the previous master night, `held` is that night's watches: a pass-rate or
 * cost rule that meets again against a watch's baseline is a flag, and one that meets for the first time is a watch.
 * Against stable, every rule that meets is a flag.
 */
export function compareNights(tonight: { manifest: NightManifest; rows: Outcome[] }, other: { manifest: NightManifest; rows: Outcome[] }, against: 'previous' | 'stable', held: Watch[] = []): Comparison {
  const mine = nightCells(tonight.manifest, tonight.rows), theirs = nightCells(other.manifest, other.rows);
  const status = (m: NightManifest, id: string) => m.suites.find(s => s.id === id);
  const flags: Flag[] = [];
  const watches: Watch[] = [];
  const suites: Comparison['suites'] = [];
  const ids = [...new Set([...tonight.manifest.suites.map(s => s.id), ...other.manifest.suites.map(s => s.id)])];
  for (const id of ids) {
    const a = status(tonight.manifest, id), b = status(other.manifest, id);
    const readers = [...new Set([...mine, ...theirs].filter(c => c.suite === id).map(c => c.reader))];
    const skip = (reason: string) => { for (const reader of readers.length ? readers : [null]) suites.push({ suite: id, reader, compared: false, reason }); };
    if (!a || !b) { skip(`not in ${!a ? 'tonight' : `the ${against} night`}'s dev set`); continue; }
    const absent = (s: SuiteStatus, who: string) => s.status === 'skipped' || s.status === 'not_built' || s.status === 'error' || s.status === 'pending' ? `${s.status.replace('_', ' ')} ${who}${s.reason ? ` (${s.reason})` : ''}` : null;
    const why = absent(a, 'tonight') ?? absent(b, `on the ${against} night`);
    if (why) { skip(why); continue; }
    if (a.digest !== b.digest) { skip(`suite digest changed (${b.digest.slice(0, 12)} to ${a.digest.slice(0, 12)}), so tonight starts a new baseline`); continue; }
    for (const reader of readers) {
      const t = mine.find(c => c.suite === id && c.reader === reader), p = theirs.find(c => c.suite === id && c.reader === reader);
      if (!t || !p) { suites.push({ suite: id, reader, compared: false, reason: `no ${reader ?? 'keyless'} rows ${!t ? 'tonight' : `on the ${against} night`}` }); continue; }
      for (const name of SIGNAL_NAMES) {
        if (t.signals[name] > p.signals[name]) flags.push({ kind: 'signal', against, suite: id, reader, detail: `${name.replace('_', ' ')} rose from ${p.signals[name]} to ${t.signals[name]}` });
      }
      const passDrop = (base: Record<string, { c: number; n: number }>) => {
        const common = Object.keys(t.per_item).filter(i => base[i]).sort();
        const boot = pairedBootstrap(common.map(i => t.per_item[i]!.c / t.per_item[i]!.n - base[i]!.c / base[i]!.n));
        const hit = boot.hi !== null && boot.mean !== null && boot.hi < 0 && -boot.mean >= PASS_DROP;
        return { common, boot, hit, detail: hit ? `pass rate down ${(-boot.mean! * 100).toFixed(1)} points over ${common.length} paired items (95% interval ${(boot.lo! * 100).toFixed(1)} to ${(boot.hi! * 100).toFixed(1)})` : '' };
      };
      const costRise = (costPerCorrect: number | null, pass1: number | null) => {
        const ratio = t.cost_per_correct !== null && costPerCorrect ? t.cost_per_correct / costPerCorrect : null;
        const hit = ratio !== null && ratio >= COST_RISE && (t.pass1 ?? 0) <= (pass1 ?? 0);
        return { ratio, hit, detail: hit ? `cost per correct answer up ${((ratio! - 1) * 100).toFixed(0)}% with no gain in pass rate` : '' };
      };
      const hold = (kind: Watch['kind'], now: { hit: boolean; detail: string }, again: (w: Watch) => { hit: boolean; detail: string }) => {
        if (against === 'stable') { if (now.hit) flags.push({ kind, against, suite: id, reader, detail: now.detail }); return; }
        const w = held.find(x => x.kind === kind && x.suite === id && x.reader === reader && x.digest === a.digest);
        const repeat = w ? again(w) : null;
        if (w && repeat!.hit) flags.push({ kind, against, suite: id, reader, detail: `${repeat!.detail} against ${w.baseline.night}, a second night running (${other.manifest.night}: ${w.detail})` });
        else if (now.hit) watches.push({ kind, suite: id, reader, digest: a.digest, detail: now.detail, baseline: { night: other.manifest.night, sha: other.manifest.sha, per_item: p.per_item, pass1: p.pass1, cost_per_correct: p.cost_per_correct } });
      };
      const pass = passDrop(p.per_item), cost = costRise(p.cost_per_correct, p.pass1);
      hold('pass_rate', pass, w => passDrop(w.baseline.per_item));
      const flips = pass.common.filter(i => { const x = p.per_item[i]!, y = t.per_item[i]!; return x.n === y.n && x.c === x.n && y.c === 0; });
      if (flips.length) flags.push({ kind: 'strong_flip', against, suite: id, reader, detail: `${flips.length} items went from all trials passing to none`, items: flips });
      hold('cost', cost, w => costRise(w.baseline.cost_per_correct, w.baseline.pass1));
      suites.push({ suite: id, reader, compared: true, pass_diff: { ...pass.boot, items: pass.common.length }, strong_flips: flips, cost_ratio: cost.ratio });
    }
  }
  return { against, night: other.manifest.night, ref: other.manifest.ref, sha: other.manifest.sha, suites, flags, watches };
}

export const AGREEMENT = { candidate: 'particle-1', reference: 'claude-opus-5-5', min_kappa: 0.6, min_raw: 0.85, min_suite_items: 20, min_items: 40, max_unpaired: 0.1 } as const;
/** Why an item is unpaired: a shared stage failed, a run-level stop cut it off, Opus has no counted trial, or particle-1 never ran it. */
export const UNPAIRED_CAUSES = [...UPSTREAM_CAUSES, 'run', 'no_reference_trial', 'not_run'] as const;
export type UnpairedCause = (typeof UNPAIRED_CAUSES)[number];

export interface AgreementTable { items: number; both_pass: number; candidate_only: number; reference_only: number; both_fail: number }
/** Unpaired items by cause, in UNPAIRED_CAUSES order, causes with none left out. */
export type UnpairedCounts = Partial<Record<UnpairedCause, number>>;
export interface AgreementStats extends AgreementTable { raw: number | null; kappa: number | null; candidate_pass: number | null; reference_pass: number | null; gap: number | null }
export type SuiteAgreement = ({ suite: string; measured: true; counted: boolean; scheduled: number; unpaired: number; unpaired_causes: UnpairedCounts; candidate_harness: number } & AgreementStats)
  | { suite: string; measured: false; reason: string; scheduled: number; unpaired: number };
export interface Agreement {
  candidate: string; reference: string; min_kappa: number; min_raw: number; min_suite_items: number; min_items: number; max_unpaired: number;
  suites: SuiteAgreement[];
  /** The counted suites' tables summed, with the item-weighted mean of their kappas: the numbers the verdict reads. */
  counted: AgreementStats & { suites: number; mean_kappa: number | null };
  /** Every measured suite's table summed; descriptive only. */
  pooled: AgreementStats;
  scheduled: number; unpaired: number; unpaired_causes: UnpairedCounts;
  verdict: 'pass' | 'fail' | 'not_measured'; reason: string | null;
}

/** Raw agreement, Cohen's kappa and both pass rates from one 2x2 table; kappa is null when chance agreement is 1. */
export function agreementStats(t: AgreementTable): AgreementStats {
  if (!t.items) return { ...t, raw: null, kappa: null, candidate_pass: null, reference_pass: null, gap: null };
  const raw = (t.both_pass + t.both_fail) / t.items, c = (t.both_pass + t.candidate_only) / t.items, r = (t.both_pass + t.reference_only) / t.items;
  const chance = c * r + (1 - c) * (1 - r);
  return { ...t, raw, kappa: chance === 1 ? null : (raw - chance) / (1 - chance), candidate_pass: c, reference_pass: r, gap: c - r };
}

/** A bar holds within floating-point error, so a kappa of exactly 0.6 computed as 0.5999999999999996 passes. */
const meets = (x: number, bar: number) => x >= bar - 1e-9;
/** A reader names the model bare or qualified (particle:particle-1). */
const isModel = (reader: string | null, model: string) => reader !== null && reader.split(/[:/]/).pop() === model;

/** particle-1 against claude-opus-5-5 on one night, or null when no suite schedules particle-1 (a suite a --fake night skipped never does). */
export function nightAgreement(manifest: NightManifest, rows: Outcome[]): Agreement | null {
  const { candidate, reference, min_kappa, min_raw, min_suite_items, min_items, max_unpaired } = AGREEMENT;
  const scheduledOn = manifest.suites.filter(s => !(manifest.fake && s.status === 'skipped')
    && (s.readers.some(r => isModel(r, candidate)) || rows.some(r => r.suite === s.id && isModel(r.reader, candidate))));
  if (!scheduledOn.length) return null;
  const firstTrials = (suite: string, model: string, keepHarness: boolean) => {
    const byItem = new Map<string, Outcome>();
    for (const r of rows) if (r.suite === suite && isModel(r.reader, model) && !r.skipped && (keepHarness || !r.harness) && (byItem.get(r.item)?.trial ?? Infinity) > r.trial) byItem.set(r.item, r);
    return byItem;
  };
  const empty = (): AgreementTable => ({ items: 0, both_pass: 0, candidate_only: 0, reference_only: 0, both_fail: 0 });
  const add = (into: AgreementTable, t: AgreementTable) => { for (const key of Object.keys(into) as Array<keyof AgreementTable>) into[key] += t[key]; };
  const tally = (causes: UnpairedCause[]): UnpairedCounts => Object.fromEntries(UNPAIRED_CAUSES.map(c => [c, causes.filter(x => x === c).length]).filter(([, n]) => n));
  /**
   * Why a reader's row leaves its item unpaired, or null when it is the reader's pass or fail: a harness row's cause when
   * it isn't the reader's own failure, else a gbrain tool error's provider cause.
   */
  const shared = (o: Outcome | undefined): UnpairedCause | null => {
    if (o?.harness) { const c = harnessCause(o.harness); return c === 'reader' ? null : c; }
    return o?.tool_errors.map(toolErrorCause).find(c => c !== null) ?? null;
  };
  const suites: SuiteAgreement[] = [];
  const pooled = empty(), counted = empty();
  const unpairedAll: UnpairedCause[] = [];
  let scheduled = 0, countedSuites = 0, kappaWeight = 0, kappaSum = 0;
  for (const s of scheduledOn) {
    const items = new Set(rows.filter(r => r.suite === s.id && (isModel(r.reader, candidate) || isModel(r.reader, reference))).map(r => r.item));
    const mine = firstTrials(s.id, candidate, true), theirs = firstTrials(s.id, reference, false), theirFirst = firstTrials(s.id, reference, true);
    const paired = [...items].filter(i => mine.has(i) && !shared(mine.get(i)) && theirs.has(i) && !shared(theirs.get(i)));
    const planned = Math.max(items.size, s.items ?? 0);
    const causes: UnpairedCause[] = [...items].filter(i => !paired.includes(i))
      .map(i => shared(mine.get(i)) ?? (!theirs.has(i) ? shared(theirFirst.get(i)) ?? 'no_reference_trial' : mine.has(i) ? shared(theirs.get(i))! : 'not_run'));
    causes.push(...Array<UnpairedCause>(planned - items.size).fill('not_run'));
    scheduled += planned;
    unpairedAll.push(...causes);
    if (!paired.length) {
      const absent = s.status === 'ran' || s.status === 'partial' ? null : `${s.status.replace('_', ' ')}${s.reason ? `: ${s.reason}` : ''}`;
      suites.push({ suite: s.id, measured: false, scheduled: planned, unpaired: planned,
        reason: absent ?? (!mine.size ? `no ${candidate} row that ran` : !theirs.size ? `no counted ${reference} rows` : 'no item both readers answered') });
      continue;
    }
    const t = empty();
    t.items = paired.length;
    for (const i of paired) { const a = !mine.get(i)!.harness && mine.get(i)!.pass, b = theirs.get(i)!.pass; t[a && b ? 'both_pass' : a ? 'candidate_only' : b ? 'reference_only' : 'both_fail']++; }
    const stats = agreementStats(t), countsToward = paired.length >= min_suite_items;
    add(pooled, t);
    if (countsToward) {
      add(counted, t);
      countedSuites++;
      if (stats.kappa !== null) { kappaWeight += t.items; kappaSum += t.items * stats.kappa; }
    }
    suites.push({ suite: s.id, measured: true, counted: countsToward, scheduled: planned, unpaired: causes.length, unpaired_causes: tally(causes),
      candidate_harness: paired.filter(i => mine.get(i)!.harness).length, ...stats });
  }
  const c = { ...agreementStats(counted), suites: countedSuites, mean_kappa: kappaWeight ? kappaSum / kappaWeight : null };
  const stopped = manifest.exit === 'NIGHTLY_CAP_STOP' || manifest.exit === 'NIGHTLY_VM_LOST' ? manifest.exit : null;
  const reason = stopped ? `the night ended with ${stopped}, so the items it never reached are not particle-1's fails`
    : !pooled.items ? 'no item both readers answered'
    : unpairedAll.length > max_unpaired * scheduled + 1e-9 ? `${unpairedAll.length} of ${scheduled} scheduled items are unpaired, more than ${max_unpaired * 100}%`
    : c.items < min_items ? `${c.items} paired items in suites with at least ${min_suite_items}, fewer than ${min_items}`
    : null;
  return { candidate, reference, min_kappa, min_raw, min_suite_items, min_items, max_unpaired, suites, counted: c, pooled: agreementStats(pooled), scheduled,
    unpaired: unpairedAll.length, unpaired_causes: tally(unpairedAll), reason,
    verdict: reason ? 'not_measured' : c.mean_kappa !== null && meets(c.mean_kappa, min_kappa) && meets(c.raw!, min_raw) ? 'pass' : 'fail' };
}

export interface Fix { issue: string; pr: string; gbrain_version: string; suite: string; items: string[]; note?: string }

export function loadFixes(path = join(REPO, FIXES_PATH)): Fix[] {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { fixes: Fix[] }).fixes : [];
}

/** The latest earlier night of the same ref under outRoot (<outRoot>/<YYYY-MM-DD>/<ref>) that has a summary. */
export function findPreviousNight(outRoot: string, night: string, ref: string): string | null {
  if (!existsSync(outRoot)) return null;
  const dates = readdirSync(outRoot).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < night).sort().reverse();
  const hit = dates.find(d => existsSync(join(outRoot, d, ref, 'summary.json')));
  return hit ? join(outRoot, hit, ref) : null;
}

/** The watches a night's summary.json recorded; none for a summary written before watches existed. */
export const heldWatches = (dir: string): Watch[] => {
  const path = join(dir, 'summary.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { watches?: Watch[] }).watches ?? [] : [];
};

export const loadNight = (dir: string) => ({ manifest: JSON.parse(readFileSync(join(dir, 'night.json'), 'utf8')) as NightManifest, rows: readOutcomes(join(dir, 'outcomes.jsonl')) });

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const usd = (x: number | null) => (x === null ? 'n/a' : `$${x.toFixed(4)}`);

export function buildReport(o: { dir: string; previous?: string | null; stable?: string | null; gbrainClone?: string | null; fixes?: Fix[] }): { summary: Record<string, unknown>; markdown: string } {
  const night = loadNight(o.dir);
  const { manifest: m, rows } = night;
  const cells = nightCells(m, rows);
  const comparisons = [o.previous && { dir: o.previous, against: 'previous' as const }, o.stable && { dir: o.stable, against: 'stable' as const }]
    .filter((x): x is { dir: string; against: 'previous' | 'stable' } => !!x && existsSync(join(x.dir, 'night.json')))
    .map(x => compareNights(night, loadNight(x.dir), x.against, x.against === 'previous' ? heldWatches(x.dir) : []));
  const prev = comparisons.find(c => c.against === 'previous');
  let commits: string[] | null = null;
  if (o.gbrainClone && prev && prev.sha && prev.sha !== m.sha) {
    try { commits = execFileSync('git', ['-C', o.gbrainClone, 'log', '--oneline', '--first-parent', `${prev.sha}..${m.sha}`], { encoding: 'utf8' }).split('\n').filter(Boolean); }
    catch (e) { commits = [`(git log failed: ${(e as Error).message.split('\n')[0]})`]; }
  }
  const fixes = (o.fixes ?? loadFixes()).map(f => {
    const mine = rows.filter(r => r.suite === f.suite && f.items.includes(r.item) && !r.harness && !r.skipped);
    return { ...f, tonight: { rows: mine.length, passes: mine.filter(r => r.pass).length } };
  });
  const flags = comparisons.flatMap(c => c.flags), watches = comparisons.flatMap(c => c.watches);
  const unsupported = rows.filter(r => !r.skipped && !(r.pass && !r.harness) && classify(nightlyFailure(r, `nightly-${r.suite}`, [])).cause === 'item_unsupported');
  const unsupportedItems = [...new Set(unsupported.map(r => `${r.suite} ${r.item}`))].sort();
  const agreement = nightAgreement(m, rows);
  const summary = {
    schema: 'nightly-summary/1', night: m.night, ref: m.ref, sha: m.sha, version: m.version, tier: m.tier, fake: m.fake, devset: m.devset,
    taxonomy_version: TAXONOMY_VERSION,
    suites: m.suites.map(s => ({ ...s, cells: cells.filter(c => c.suite === s.id).map(({ per_item: _items, ...c }) => c) })),
    harness_rows: rows.filter(r => r.harness).length,
    item_unsupported: { rows: unsupported.length, items: unsupportedItems },
    flags, watches, comparisons: comparisons.map(({ watches: _watches, ...c }) => c), commit_range: prev ? { from: prev.sha, to: m.sha, commits } : null, fixes, agreement,
  };
  const lines: string[] = [];
  lines.push(`# Nightly gbrain check: ${m.ref} ${m.sha.slice(0, 12)}${m.version ? ` (v${m.version})` : ''}, ${m.night}`, '');
  lines.push(`Tier ${m.tier}${m.fake ? ', fake providers (plumbing only; no number here measures a model)' : ''}. Dev set ${m.devset.digest.slice(0, 12)}. Causes: failure-cause taxonomy ${TAXONOMY_VERSION}.`, '');
  lines.push(flags.length ? `**${flags.length} flags.**` : '**No flags.**', '');
  for (const f of flags) lines.push(`- ${f.kind} (vs ${f.against}) ${f.suite} ${f.reader ?? 'keyless'}: ${f.detail}${f.items ? `: ${f.items.join(', ')}` : ''}`);
  if (watches.length) lines.push('', `Watching ${watches.length}: a pass-rate drop or cost rise against the previous master night files as a flag only if the next night shows it again against the same night.`, '');
  for (const w of watches) lines.push(`- ${w.kind} ${w.suite} ${w.reader ?? 'keyless'}: ${w.detail} (against ${w.baseline.night})`);
  if (unsupported.length) lines.push('', `Item-unsupported: ${unsupported.length} failed rows on ${unsupportedItems.length} items where the cited gold sessions don't support the answer (both support validators reject it, or the item cites no turn) and the arm given every gold session fails too. They count as \`item_unsupported\` in the weekly failure causes, not as gbrain failures, and stay in the flags above: ${unsupportedItems.join(', ')}.`);
  lines.push('', '## Suites', '', '| Suite | Reader | Items | Trials | pass^1 | pass^k | Harness | Cost per correct | Failures by cause |', '|---|---|---|---|---|---|---|---|---|');
  for (const s of m.suites) {
    const mine = cells.filter(c => c.suite === s.id);
    if (!mine.length) { lines.push(`| ${s.id} | | | | | | | | ${s.status.replace('_', ' ')}${s.reason ? `: ${s.reason}` : ''} |`); continue; }
    for (const c of mine) {
      const causes = [...CAUSE_IDS, UNCLASSIFIED].filter(x => c.failures_by_cause[x]).map(x => `${x} ${c.failures_by_cause[x]}`).join(', ') || 'none';
      lines.push(`| ${s.id}${s.status === 'partial' ? ' (partial)' : ''}${s.dev_set ? ' (dev set)' : ''} | ${c.reader ?? 'keyless'} | ${c.items} | ${c.trials} | ${pct(c.pass1)} | ${c.k > 1 ? pct(c.passk) : 'n/a'} | ${c.harness} | ${usd(c.cost_per_correct)} | ${causes}${c.skipped ? `; ${c.skipped} not run` : ''} |`);
    }
  }
  const devSets = m.suites.filter(s => s.dev_set);
  if (devSets.length) lines.push('', '## Dev-set runs', '');
  for (const s of devSets) {
    const drift = s.dev_set!.freeze_drift;
    lines.push(`- ${s.id}: ${s.dev_set!.label}. ${drift === null ? 'The freeze was not checked on this night.' : drift.length ? `Code changed since the freeze: ${drift.join(', ')}.` : 'No frozen file has changed since the freeze.'}`);
  }
  if (agreement) {
    const a = agreement, v = a.counted, kappa = (x: number | null) => (x === null ? 'n/a' : x.toFixed(3));
    const points = (x: number | null) => (x === null ? 'n/a' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`);
    lines.push('', `## ${a.candidate} agreement with ${a.reference}`, '');
    lines.push(`Per item, ${a.candidate}'s first trial and ${a.reference}'s first counted trial are each reader's pass or fail. An error from ${a.candidate}'s own provider or call (a crash, an invalid answer, a 4xx or 5xx on the reader call) is a fail for ${a.candidate}. A failure in a stage both readers share (embedding, retrieval, rerank or the judge) leaves the item unpaired, with its cause named, as do a run-level stop, an item ${a.reference} has no counted trial for and one the night didn't run for ${a.candidate}. A gbrain error in either reader's row counts as a shared-stage failure only when gbrain's embedding or retrieval provider returned a 429 or 5xx; any other gbrain error is a fail for that reader. A night that ends on a budget stop or loses its machine is not measured. A suite counts toward the verdict with at least ${a.min_suite_items} paired items. ${a.candidate} passes with at least ${a.min_items} such items, no more than ${pct(a.max_unpaired)} of scheduled items unpaired, an item-weighted mean of the counted suites' kappas of at least ${a.min_kappa} and their raw agreement of at least ${pct(a.min_raw)}. The pooled kappa over every measured suite is shown for reference only.`, '');
    lines.push(a.verdict === 'not_measured' ? `**Not measured: ${a.reason}.**`
      : `**${a.verdict === 'pass' ? 'Passes' : 'Fails'}: kappa ${kappa(v.mean_kappa)}${v.mean_kappa === null ? ' (both readers gave every item the same label in every counted suite)' : ` (item-weighted mean over ${v.suites} suite${v.suites === 1 ? '' : 's'})`}, raw agreement ${pct(v.raw)}, over ${v.items} items.** ${a.candidate} passes ${pct(v.candidate_pass)} of them and ${a.reference} ${pct(v.reference_pass)}, a gap of ${points(v.gap)} points.`);
    const label = (c: string) => (c === 'run' ? 'run-level stop' : c === 'no_reference_trial' ? `no counted ${a.reference} trial` : c === 'not_run' ? `not run for ${a.candidate}` : c);
    const byCause = (m: UnpairedCounts) => Object.entries(m).map(([c, n]) => `${label(c)} ${n}`).join(', ');
    if (a.pooled.items) lines.push('', `Pooled kappa over every measured suite, for reference only: ${kappa(a.pooled.kappa)} over ${a.pooled.items} items. Unpaired items: ${a.unpaired} of ${a.scheduled} scheduled.${a.unpaired ? ` By cause: ${byCause(a.unpaired_causes)}.` : ''}`);
    const measured = a.suites.flatMap(s => (s.measured ? [s] : []));
    if (measured.length) lines.push('', `| Suite | Paired items | Counts toward verdict | Raw agreement | Kappa | ${a.candidate} pass rate | ${a.reference} pass rate | Gap (points) | ${a.candidate} reader errors counted as fails | Unpaired items |`, '|---|---|---|---|---|---|---|---|---|---|');
    for (const s of measured) lines.push(`| ${s.suite} | ${s.items} | ${s.counted ? 'yes' : `no (under ${a.min_suite_items})`} | ${pct(s.raw)} | ${kappa(s.kappa)} | ${pct(s.candidate_pass)} | ${pct(s.reference_pass)} | ${points(s.gap)} | ${s.candidate_harness} | ${s.unpaired}${s.unpaired ? ` (${byCause(s.unpaired_causes)})` : ''} |`);
    const unmeasured = a.suites.flatMap(s => (s.measured ? [] : [`- ${s.suite}: not measured, ${s.reason}`]));
    if (unmeasured.length) lines.push('', ...unmeasured);
  }
  for (const c of comparisons) {
    lines.push('', `## Against ${c.against === 'previous' ? 'the previous master night' : 'stable'} (${c.ref} ${c.sha.slice(0, 12)}, ${c.night})`, '');
    for (const s of c.suites) {
      lines.push(s.compared
        ? `- ${s.suite} ${s.reader ?? 'keyless'}: pass rate change ${s.pass_diff!.mean === null ? 'n/a' : `${(s.pass_diff!.mean * 100).toFixed(1)} points (95% interval ${(s.pass_diff!.lo! * 100).toFixed(1)} to ${(s.pass_diff!.hi! * 100).toFixed(1)})`} over ${s.pass_diff!.items} items${s.strong_flips?.length ? `; strong flips ${s.strong_flips.join(', ')}` : ''}`
        : `- ${s.suite} ${s.reader ?? 'keyless'}: not compared, ${s.reason}`);
    }
  }
  if (summary.commit_range) {
    lines.push('', `## Commits since the previous master night (${commits?.length ?? 0})`, '');
    for (const c of commits ?? []) lines.push(`- ${c}`);
  }
  lines.push('', '## Fixes', '');
  if (!fixes.length) lines.push('No fixes recorded yet in ' + FIXES_PATH + '.');
  for (const f of fixes) lines.push(`- ${f.issue} (${f.pr}, gbrain ${f.gbrain_version}): ${f.suite} ${f.items.join(', ')}: ${f.tonight.passes} of ${f.tonight.rows} passing tonight`);
  return { summary, markdown: lines.join('\n') + '\n' };
}

export function writeReport(o: Parameters<typeof buildReport>[0]): Record<string, unknown> {
  const { summary, markdown } = buildReport(o);
  writeFileSync(join(o.dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(join(o.dir, 'report.md'), markdown);
  const outcomes = join(o.dir, 'outcomes.jsonl');
  if (existsSync(outcomes)) writeFileSync(`${outcomes}.gz`, gzipSync(readFileSync(outcomes)));
  return summary;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const dir = flag('--night-dir');
  if (!dir) { console.error('usage: report.ts --night-dir <dir> [--previous <dir>] [--stable <dir>] [--gbrain-clone <path>]'); process.exit(2); }
  const summary = writeReport({ dir: resolve(dir), previous: flag('--previous') ?? null, stable: flag('--stable') ?? null, gbrainClone: flag('--gbrain-clone') ?? null });
  console.log(JSON.stringify({ flags: (summary.flags as unknown[]).length, report: join(resolve(dir), 'report.md') }));
}

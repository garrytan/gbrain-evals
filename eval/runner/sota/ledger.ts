/**
 * The fix ledger (SOTA plan item 8, decision D6a): what each fix gbrain's crew ships can claim.
 *
 *   bun eval/runner/sota/ledger.ts dev --master <night dir> --stable <night dir> --fixes eval/data/nightly/fixes.json
 *       --out <ledger.json>
 *
 * Each fix in fixes.json names its target (bucket, cause, the fix list's signature and, once custody measures it, the
 * bucket's held-out share) and its dev items. Its dev result is the same-night paired contrast of master against stable
 * on those items, computed only on a night when master carries the fix and stable doesn't (night.json versions). Beside
 * it sit the noise baseline (the share of the suite's untouched outcomes that flip between the two refs, and the
 * contrast on those items) and the collateral losses (items outside the fix that pass every trial on stable and none on
 * master, in every suite both refs ran, where both refs ran the item the same number of trials). Skipped and harness
 * rows are left out of every count and contrast. The fix's success rate is master's pass rate on the dev items that stable
 * failed, and its D6a prediction is held-out share x success rate x 0.5 (the fixed prior, never fed back).
 *
 * Every contrast is the pass-rate difference in points, paired by item and reader (pass^1 over trials), with a cluster
 * bootstrap 95% interval and the smallest difference the design detects (two-sided 0.05 at 80% power, from the
 * cluster-robust SE). The cluster is the conversation for BEAM and RS1, the question for LongMemEval, and the task within
 * its world for Cat 40; other suites cluster by item.
 *
 * Held-out credit (custody): a release's paired contrast with the previous stable on the same questions is shared among
 * the fixes it carries in proportion to their predictions; a fix predicted at 3 points or more can get its own verdict
 * from a revert build (helps, hurts or can't tell). The kill rule reads the last three quarterly status calls with RS1
 * scored.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDevSet, type DevSet } from '../nightly/devset.ts';
import { readOutcomes, type Outcome } from '../nightly/outcome.ts';
import type { Fix, NightManifest } from '../nightly/report.ts';
import { clusteredPairedDelta, powerNote, type PairedItem } from '../stats/paired.ts';
import { PRIOR } from './fixlist.ts';
import { assertNoSealedIds } from './sealed-guard.ts';

export const LEDGER_SCHEMA = 'sota-ledger/1';
export const DRAWS = 10_000;
export const SEED = 20261116;
/** A fix gets its own held-out verdict from a revert build only when predicted at this many points or more. */
export const REVERT_MIN_POINTS = 3;

export type Unit = 'conversation' | 'question' | 'task' | 'item';
/** The fields a fix record carries for the ledger, beside issue, pr, gbrain_version, suite and items. */
export interface FixTarget { bucket: string; cause: string; signature: string; held_out_share: number | null }
/** The ledger's results as a fix record keeps them: the latest dev result, its held-out release share and its revert verdict. */
export interface FixLedger {
  dev: DevResult | null;
  release: { release: string; share: number | null; credited_points: number | null } | null;
  revert: { verdict: RevertVerdict; reason: string } | null;
}
export interface Contrast {
  unit: Unit; pairs: number; clusters: number; delta_points: number; ci95_points: [number, number] | null; mde_points: number | null; note: string;
}
export interface DevResult {
  issue: string; status: 'measured' | 'not_applicable'; reason: string | null; night: string; master_version: string | null; stable_version: string | null;
  dev: Contrast | null; noise: { flip_share: number | null; outcomes: number; contrast: Contrast | null };
  collateral: { losses: string[]; gains: string[]; pairs: number };
  success_rate: number | null;
  prediction: { held_out_share: number | null; success_rate: number | null; prior: number; points: number | null };
}

/** The ledger's scored row: a nightly outcome, or a custody row in the same shape. */
export type Scored = Pick<Outcome, 'suite' | 'item' | 'reader' | 'trial' | 'pass'>;

/** The cluster an item belongs to: its conversation (BEAM, RS1), the question (LongMemEval), its task within its world (Cat 40). */
export function clusterOf(suite: string, benchmark: string | null, item: string): { unit: Unit; cluster: string } {
  const b = benchmark ?? suite;
  if (b.startsWith('beam') || b.startsWith('rs1')) return { unit: 'conversation', cluster: item.split(':')[0]! };
  if (b.startsWith('lme')) return { unit: 'question', cluster: item };
  const world = /^cat40-[a-z]+-([a-z0-9]+)$/.exec(suite)?.[1];
  if (world) return { unit: 'task', cluster: `${world}/${item}` };
  return { unit: 'item', cluster: item };
}

const key = (r: Scored) => `${r.item}\u0000${r.reader ?? ''}`;
const rate = (rows: Scored[]) => { const m = new Map<string, { c: number; n: number }>(); for (const r of rows) { const e = m.get(key(r)) ?? { c: 0, n: 0 }; e.n++; if (r.pass) e.c++; m.set(key(r), e); } return m; };
const points = (x: number) => Math.round(x * 10000) / 100;

/** b minus a over the (item, reader) pairs both hold, in pass-rate points, clustered by suite; null with no common pair. */
export function pairedContrast(a: readonly Scored[], b: readonly Scored[], o: { suite: string; benchmark: string | null; items?: ReadonlySet<string> }): Contrast | null {
  const keep = (r: Scored) => r.suite === o.suite && (!o.items || o.items.has(r.item));
  const ra = rate(a.filter(keep)), rb = rate(b.filter(keep));
  const pairs: PairedItem[] = [...ra.keys()].filter(k => rb.has(k)).sort().map(k => {
    const item = k.split('\u0000')[0]!;
    return { id: k, cluster: clusterOf(o.suite, o.benchmark, item).cluster, a: ra.get(k)!.c / ra.get(k)!.n, b: rb.get(k)!.c / rb.get(k)!.n };
  });
  if (!pairs.length) return null;
  const d = clusteredPairedDelta(pairs, { seed: SEED, draws: DRAWS });
  const p = powerNote(d);
  return { unit: clusterOf(o.suite, o.benchmark, pairs[0]!.id.split('\u0000')[0]!).unit, pairs: d.n_pairs, clusters: d.n_clusters, delta_points: points(d.delta),
    ci95_points: d.ci95 ? [points(d.ci95[0]), points(d.ci95[1])] : null, mde_points: p.mde === null ? null : points(p.mde), note: p.note };
}

/** -1, 0 or 1 comparing dotted numeric versions (0.60.666.0). */
export function compareVersion(x: string, y: string): number {
  const a = x.split('.').map(Number), b = y.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return Math.sign(d); }
  return 0;
}

export interface Night { manifest: Pick<NightManifest, 'night' | 'version' | 'suites'>; rows: Outcome[] }

/** One fix's dev result on one night, master against stable. */
export function devResult(fix: Fix, master: Night, stable: Night, devset: DevSet): DevResult {
  const suite = devset.suites.find(s => s.id === fix.suite);
  const benchmark = typeof suite?.config?.benchmark === 'string' ? suite.config.benchmark : null;
  const mv = master.manifest.version, sv = stable.manifest.version;
  const share = fix.target?.held_out_share ?? null;
  const empty = { dev: null, noise: { flip_share: null, outcomes: 0, contrast: null }, collateral: { losses: [], gains: [], pairs: 0 }, success_rate: null,
    prediction: { held_out_share: share, success_rate: null, prior: PRIOR, points: null } };
  const base = { issue: fix.issue, night: master.manifest.night, master_version: mv, stable_version: sv };
  const skip = (reason: string): DevResult => ({ ...base, status: 'not_applicable', reason, ...empty });
  if (master.manifest.night !== stable.manifest.night) return skip(`master ran ${master.manifest.night} and stable ${stable.manifest.night}; the contrast is same-night only`);
  if (!mv || !sv) return skip('a night records no gbrain version');
  if (compareVersion(mv, fix.gbrain_version) < 0) return skip(`master ${mv} predates the fix (${fix.gbrain_version})`);
  if (compareVersion(sv, fix.gbrain_version) >= 0) return skip(`stable ${sv} already carries the fix (${fix.gbrain_version})`);
  const dev = new Set(fix.items);
  const o = { suite: fix.suite, benchmark };
  const counted = (rows: Outcome[]) => rows.filter(r => !r.skipped && !r.harness);
  const devContrast = pairedContrast(counted(stable.rows), counted(master.rows), { ...o, items: dev });
  if (!devContrast) return skip('no dev item ran on both refs');
  const untouched = new Set((suite?.items.map(i => i.id) ?? [...new Set([...master.rows, ...stable.rows].filter(r => r.suite === fix.suite).map(r => r.item))]).filter(i => !dev.has(i)));
  const trialKey = (r: Scored) => `${r.suite}\u0000${r.item}\u0000${r.reader ?? ''}\u0000${r.trial}`;
  const sm = new Map(counted(stable.rows).filter(r => r.suite === fix.suite && untouched.has(r.item)).map(r => [trialKey(r), r.pass]));
  const paired = counted(master.rows).filter(r => sm.has(trialKey(r)));
  const flips = paired.filter(r => sm.get(trialKey(r)) !== r.pass).length;
  const sr = rate(counted(stable.rows)), mr = rate(counted(master.rows));
  const suiteKey = (r: Scored) => `${r.suite}\u0000${key(r)}`;
  const sAll = new Map<string, { c: number; n: number }>(), mAll = new Map<string, { c: number; n: number }>();
  for (const [rows, m] of [[counted(stable.rows), sAll], [counted(master.rows), mAll]] as const) for (const r of rows) {
    if (r.suite === fix.suite && dev.has(r.item)) continue;
    const e = m.get(suiteKey(r)) ?? { c: 0, n: 0 }; e.n++; if (r.pass) e.c++; m.set(suiteKey(r), e);
  }
  const both = [...sAll.keys()].filter(k => mAll.get(k)?.n === sAll.get(k)!.n).sort();
  const label = (k: string) => k.split('\u0000').filter(Boolean).join('|');
  const losses = both.filter(k => sAll.get(k)!.c === sAll.get(k)!.n && mAll.get(k)!.c === 0).map(label);
  const gains = both.filter(k => sAll.get(k)!.c === 0 && mAll.get(k)!.c === mAll.get(k)!.n).map(label);
  const misses = [...dev].flatMap(i => [...sr.keys()].filter(k => k.startsWith(`${i}\u0000`) && sr.get(k)!.c === 0 && mr.has(k)));
  const success = misses.length ? misses.reduce((s, k) => s + mr.get(k)!.c / mr.get(k)!.n, 0) / misses.length : null;
  return {
    ...base, status: 'measured', reason: null, dev: devContrast,
    noise: { flip_share: paired.length ? Math.round((10000 * flips) / paired.length) / 10000 : null, outcomes: paired.length, contrast: pairedContrast(counted(stable.rows), counted(master.rows), { ...o, items: untouched }) },
    collateral: { losses, gains, pairs: both.length }, success_rate: success === null ? null : Math.round(success * 10000) / 10000,
    prediction: { held_out_share: share, success_rate: success, prior: PRIOR, points: share === null || success === null ? null : points(share * success * PRIOR) },
  };
}

/** A release's held-out contrast shared among the fixes it carries, in proportion to their predictions; null shares when any prediction is missing. */
export function releaseShares(contrast: Contrast, fixes: ReadonlyArray<{ issue: string; predicted_points: number | null }>): Array<{ issue: string; share: number | null; credited_points: number | null }> {
  const known = fixes.every(f => f.predicted_points !== null && f.predicted_points > 0);
  const total = known ? fixes.reduce((s, f) => s + f.predicted_points!, 0) : 0;
  return fixes.map(f => {
    const share = known ? f.predicted_points! / total : null;
    return { issue: f.issue, share: share === null ? null : Math.round(share * 10000) / 10000, credited_points: share === null ? null : Math.round(share * contrast.delta_points * 100) / 100 };
  });
}

export type RevertVerdict = 'not_eligible' | 'pending' | 'helps' | 'hurts' | 'cant_tell';
/** A fix's own held-out verdict: the release minus its revert build, for a fix predicted at 3 points or more. */
export function revertVerdict(predictedPoints: number | null, releaseMinusRevert: Contrast | null): { verdict: RevertVerdict; reason: string } {
  if (predictedPoints === null || predictedPoints < REVERT_MIN_POINTS) return { verdict: 'not_eligible', reason: `predicted ${predictedPoints ?? 'n/a'} points, under ${REVERT_MIN_POINTS}` };
  if (!releaseMinusRevert?.ci95_points) return { verdict: 'pending', reason: releaseMinusRevert ? 'the revert contrast has no interval' : 'no revert build scored in custody yet' };
  const [lo, hi] = releaseMinusRevert.ci95_points;
  if (lo > 0) return { verdict: 'helps', reason: `release minus revert ${releaseMinusRevert.delta_points} points, 95% interval ${lo} to ${hi}` };
  if (hi < 0) return { verdict: 'hurts', reason: `release minus revert ${releaseMinusRevert.delta_points} points, 95% interval ${lo} to ${hi}` };
  return { verdict: 'cant_tell', reason: `the 95% interval ${lo} to ${hi} crosses 0` };
}

export interface StatusCall { quarter: string; rs1_scored: boolean; targeted_gain_points: number; mde_points: number; predicted_points: number }
/**
 * D6a's kill rule over the last three quarterly status calls with RS1 scored: it fires when their summed gain in the
 * targeted buckets is below the sum's detectable difference (the per-call ones added in quadrature) while the summed
 * predictions exceed twice it. null until three such calls exist.
 */
export function killRule(calls: readonly StatusCall[]): { fires: boolean | null; gain_points: number | null; mde_points: number | null; predicted_points: number | null; quarters: string[] } {
  const scored = calls.filter(c => c.rs1_scored).slice(-3);
  if (scored.length < 3) return { fires: null, gain_points: null, mde_points: null, predicted_points: null, quarters: scored.map(c => c.quarter) };
  const gain = scored.reduce((s, c) => s + c.targeted_gain_points, 0), pred = scored.reduce((s, c) => s + c.predicted_points, 0);
  const mde = Math.sqrt(scored.reduce((s, c) => s + c.mde_points ** 2, 0));
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { fires: gain < mde && pred > 2 * mde, gain_points: r2(gain), mde_points: r2(mde), predicted_points: r2(pred), quarters: scored.map(c => c.quarter) };
}

const flag = (argv: string[], name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const need = (argv: string[], name: string) => { const v = flag(argv, name); if (!v) throw new Error(`pass ${name}`); return v; };
const loadNightDir = (dir: string): Night => {
  if (!existsSync(join(dir, 'night.json'))) throw new Error(`${dir} holds no night.json`);
  return { manifest: JSON.parse(readFileSync(join(dir, 'night.json'), 'utf8')) as NightManifest, rows: readOutcomes(join(dir, 'outcomes.jsonl')) };
};

export function main(argv: string[], log: (s: string) => void = console.log, devset: DevSet = loadDevSet()): number {
  const [command, ...rest] = argv;
  if (command !== 'dev') { console.error('usage: bun eval/runner/sota/ledger.ts dev --master <night dir> --stable <night dir> --fixes <fixes.json> --out <ledger.json>'); return 2; }
  const master = loadNightDir(need(rest, '--master')), stable = loadNightDir(need(rest, '--stable'));
  const fixes = (JSON.parse(readFileSync(need(rest, '--fixes'), 'utf8')) as { fixes: Fix[] }).fixes;
  const results = fixes.map(f => devResult(f, master, stable, devset));
  const out = need(rest, '--out');
  const text = JSON.stringify({ schema: LEDGER_SCHEMA, night: master.manifest.night, results }, null, 1) + '\n';
  assertNoSealedIds(text, out);
  writeFileSync(out, text);
  log(JSON.stringify(results.map(r => ({ issue: r.issue, status: r.status, reason: r.reason, dev: r.dev && { delta: r.dev.delta_points, ci95: r.dev.ci95_points, mde: r.dev.mde_points }, noise: r.noise.flip_share, collateral: r.collateral.losses.length })), null, 1));
  return 0;
}

if (import.meta.main) {
  try { process.exit(main(process.argv.slice(2))); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
}

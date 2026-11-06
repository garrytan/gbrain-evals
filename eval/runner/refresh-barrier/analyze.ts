/**
 * Part A analysis and verdict for the refresh-barrier validation (docs/benchmarks/2026-11-06-refresh-barrier-preregistration.md,
 * "Part A" and "Decision rule"): failure classes per trial (failureClasses, the one failure predicate trial.ts, named-case.ts
 * and this file share), one-sided 95% Clopper-Pearson bounds, the secondary measures, the write-latency gate, positive
 * controls PC1 to PC5, the Part A verdict and the flag-on recommendation. Reads what run.ts, trial.ts and named-case.ts wrote.
 * The write-latency gate reads the quiet latency block (quiet/); Part A's in-trial no-tick latency is reported, not gated.
 *
 *   bun eval/runner/refresh-barrier/analyze.ts --out <dir> [--pc2 <dir with named runs at de22702a>]
 *
 * Writes <dir>/analysis.json and prints a markdown summary.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { harnessDigest } from './fixture.ts';
import { TICK_RETRY_CODES } from './runtime.ts';
import { B_KINDS, rng } from './schedule.ts';

export const OP_CLASSES = ['lost', 'lost_git', 'phantom', 'duplicated', 'stuck', 'overwritten', 'wrong_expiry', 'unindexed', 'unpublished', 'false_refusal', 'unexpected_outcome'] as const;
export const LATENCY_MARGIN_MS = 25;
export const BLOCKED_P95_MS = 1_000;
export const REFRESHING_SHARE_MAX = 0.001;
export const RUN_CLASSES = ['hang', 'deadlock', 'no_converge', 'harness_error'] as const;
const ENGINES = ['postgres', 'pglite'] as const;
const ARMS = ['off', 'on'] as const;
const span = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
/** Preregistered results per engine and arm, by seed or by B kind and repetition: seeds 1001-1500, repetitions 101-125 of each of the three B kinds, quiet seeds 2001-2100. */
const PLANNED = { trials: span(1001, 1500).map(String), named: span(101, 125).flatMap(rep => B_KINDS.map(b => `${b}-${rep}`)), quiet: span(2001, 2100).map(String) };
const resultKey = (r: Record<string, any>) => r.b !== undefined ? `${r.b}-${r.rep}` : String(r.seed);
/** PC2's detector check build (#8705 at de22702a) and its preregistered runs per B kind and engine. */
const PC2_SHA = 'de22702a';
const PC2_RUNS = 10;
type Rec = Record<string, any>;

/** One-sided upper confidence bound on a binomial proportion (Clopper-Pearson): the p with P(X <= k | n, p) = alpha. */
export function upperBound(k: number, n: number, alpha = 0.05): number {
  if (n === 0) return 1;
  if (k >= n) return 1;
  if (k === 0) return 1 - alpha ** (1 / n);
  const cdf = (p: number) => {
    let logTerm = n * Math.log1p(-p), sum = Math.exp(logTerm);
    for (let i = 1; i <= k; i++) { logTerm += Math.log((n - i + 1) / i) + Math.log(p) - Math.log1p(-p); sum += Math.exp(logTerm); }
    return sum;
  };
  let lo = k / n, hi = 1;
  for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2; if (cdf(mid) > alpha) lo = mid; else hi = mid; }
  return hi;
}

/** The failure classes one trial or named-case run shows (empty when it passed). */
export function failureClasses(t: Rec, kind: 'trial' | 'named'): string[] {
  const out = new Set<string>();
  const ops: Rec[] = t.ops ?? [];
  for (const c of OP_CLASSES) if (ops.some(o => o[c])) out.add(c);
  const f: Rec = t.flags ?? {};
  if (Object.entries(f).some(([k, v]) => k.endsWith('_hang') && v === true) || f.quiesce?.ok === false || f.quiesce_final?.ok === false
    || (kind === 'named' && f.writers_done === false)) out.add('hang');
  if (Number(f.deadlocks ?? 0) > 0 || Number(f.deadlock_mentions ?? 0) > 0) out.add('deadlock');
  if (kind === 'trial' && !t.harness_error && (f.converge?.ok !== true || Number(t.upstream?.missing_head ?? 0) > 0)) out.add('no_converge');
  // A tick or sync that gbrain refused with a code is an outcome (convergence then decides no_converge); one that threw
  // without a code, or any writer error, is the harness's.
  const unexpected = (t.child_errors ?? []).filter((e: Rec) => !(['tick', 'sync'].includes(e.role) && e.code));
  const exits = Object.values(f.writer_exits ?? {}) as number[];
  const badExits = exits.filter(x => x !== 0).length - (reached(t, 'writer_kill') ? Number(t.faults.writer_killed) : 0);
  const switchMismatch = (t.switches ?? []).some((s: Rec) => s.refresh_barrier !== (t.arm === 'on'));
  if (t.harness_error || unexpected.length > 0 || badExits > 0 || ops.some(o => o.harness_error) || f.writers_not_ready === true || Number(f.too_many_clients ?? 0) > 0
    || Number(f.push_errors ?? 0) > 0 || Number(f.foreign_commit_errors ?? 0) > 0 || Number(f.unplanned_child_exits ?? 0) > 0
    || (t.unknown_statuses ?? []).length > 0 || Number(t.pause_misses ?? 0) > 0 || switchMismatch || (t.switches !== undefined && t.switches.length === 0)) out.add('harness_error');
  return [...out];
}

const pct = (xs: number[], q: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]!; };
const dist = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 0.5), p95: pct(xs, 0.95), max: xs.length ? Math.max(...xs) : null });
const tally = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => (m[x] = (m[x] ?? 0) + 1, m), {});

/** Paired bootstrap over units (10,000 resamples, seed 1): mean of per-unit differences with its 95% interval. */
export function pairedBootstrap(diffs: number[], resamples = 10_000, seed = 1): { mean: number | null; lo: number | null; hi: number | null } {
  if (!diffs.length) return { mean: null, lo: null, hi: null };
  const r = rng(seed, 'bootstrap');
  const means: number[] = [];
  for (let b = 0; b < resamples; b++) { let s = 0; for (let i = 0; i < diffs.length; i++) s += diffs[Math.floor(r() * diffs.length)]!; means.push(s / diffs.length); }
  means.sort((a, b) => a - b);
  return { mean: diffs.reduce((a, b) => a + b, 0) / diffs.length, lo: means[Math.floor(0.025 * resamples)]!, hi: means[Math.ceil(0.975 * resamples) - 1]! };
}

/**
 * Bootstrap over paired runs (10,000 resamples, seed 1): the pooled per-write mean of the on runs minus that of the off runs,
 * resampling whole seeds so writes in one run stay together, with its 95% interval.
 */
export function pooledBootstrap(pairs: Array<[number[], number[]]>, resamples = 10_000, seed = 1): { runs: number; writes_on: number; writes_off: number; mean: number | null; lo: number | null; hi: number | null } {
  const writesOn = pairs.reduce((n, [a]) => n + a.length, 0), writesOff = pairs.reduce((n, [, b]) => n + b.length, 0);
  if (!pairs.length || !writesOn || !writesOff) return { runs: pairs.length, writes_on: writesOn, writes_off: writesOff, mean: null, lo: null, hi: null };
  const sums = pairs.map(([a, b]) => [a.reduce((x, y) => x + y, 0), a.length, b.reduce((x, y) => x + y, 0), b.length] as const);
  const stat = (idx: number[]) => { let sa = 0, na = 0, sb = 0, nb = 0; for (const i of idx) { const s = sums[i]!; sa += s[0]; na += s[1]; sb += s[2]; nb += s[3]; } return na && nb ? sa / na - sb / nb : null; };
  const r = rng(seed, 'bootstrap');
  const diffs: number[] = [];
  for (let b = 0; b < resamples; b++) { const d = stat(Array.from({ length: pairs.length }, () => Math.floor(r() * pairs.length))); if (d !== null) diffs.push(d); }
  diffs.sort((a, b) => a - b);
  return { runs: pairs.length, writes_on: writesOn, writes_off: writesOff, mean: stat(pairs.map((_, i) => i)),
    lo: diffs[Math.floor(0.025 * diffs.length)]!, hi: diffs[Math.ceil(0.975 * diffs.length) - 1]! };
}

/** Whether a trial reached its stratum's fault, rather than only planning it. */
export function reached(t: Rec, stratum: 'crash' | 'writer_kill' | 'import_sequence'): boolean {
  if (!t.strata?.[stratum]) return false;
  if (stratum === 'crash') return Number(t.faults?.tick_killed ?? 0) > 0;
  if (stratum === 'writer_kill') return Number(t.faults?.writer_killed ?? 0) > 0;
  return (t.ops ?? []).some((o: Rec) => String(o.marker).endsWith('iaq') && o.deferred_import);
}

function load(dir: string): Rec[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

const retryable = (o: Rec) => o.first === 'refused_retryable' || (o.codes ?? []).includes('worktree_refreshing');
const duringPause = (t: Rec, o: Rec) => o.first_t != null && (t.pauses ?? []).some((p: Rec) => o.first_t >= p.t && o.first_t <= p.t + p.pause_ms);
/**
 * A write on the normal path: issued while no refresh tick, resume or sync was running (outside every refresh window, with
 * a second of slack after each) and answered committed at once.
 */
export const NO_TICK_SLACK_MS = 1_000;
export const noTick = (t: Rec, o: Rec) => o.first_t != null && o.first === 'committed' && Array.isArray(t.refresh_windows)
  && !t.refresh_windows.some(([a, b]: [number, number]) => o.first_t >= a && o.first_t <= b + NO_TICK_SLACK_MS);
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

function armSummary(trials: Rec[]) {
  const ops = trials.flatMap(t => (t.ops ?? []).filter((o: Rec) => o.issued));
  const fails = trials.map(t => failureClasses(t, 'trial'));
  const ticks = trials.flatMap(t => t.ticks ?? []);
  return {
    trials: trials.length, failed_trials: fails.filter(f => f.length).length,
    classes: Object.fromEntries([...OP_CLASSES, ...RUN_CLASSES].map(c => [c, fails.filter(f => f.includes(c)).length])),
    writes: ops.length, first_call: tally(ops.map(o => `${o.first}${o.first_code ? ':' + o.first_code : ''}`)),
    trials_with_worktree_refreshing: trials.filter(t => (t.ops ?? []).some((o: Rec) => (o.codes ?? []).includes('worktree_refreshing'))).length,
    worktree_refreshing_first_outside_expiry: trials.filter(t => t.max_wait_ms == null).flatMap(t => (t.ops ?? []).filter((o: Rec) => o.issued && o.first_code === 'worktree_refreshing')).length,
    writes_outside_expiry: trials.filter(t => t.max_wait_ms == null).flatMap(t => (t.ops ?? []).filter((o: Rec) => o.issued)).length,
    trials_with_deferral: trials.filter(t => (t.ops ?? []).some((o: Rec) => o.deferred_refresh && o.first === 'pending')).length,
    unexpected_reasons: tally(ops.flatMap(o => o.unexpected_reasons ?? [])),
    too_many_clients: trials.reduce((a, t) => a + Number(t.flags?.too_many_clients ?? 0), 0),
    slip_ms: dist(ops.map(o => o.first_slip_ms).filter((x: unknown) => typeof x === 'number')),
    pauses: { planned: trials.reduce((a, t) => a + Number(t.pauses_planned ?? 0), 0), fired: trials.reduce((a, t) => a + (t.pauses ?? []).length, 0), missed: trials.reduce((a, t) => a + Number(t.pause_misses ?? 0), 0), skipped_current: trials.reduce((a, t) => a + Number(t.pause_skipped_current ?? 0), 0) },
    attempts_mean: ops.length ? ops.reduce((a, o) => a + (o.attempts ?? 0), 0) / ops.length : null,
    blocked_ms: dist(trials.flatMap(t => (t.ops ?? []).filter((o: Rec) => o.issued && o.first_ms != null && duringPause(t, o)).map((o: Rec) => Math.round(o.first_ms)))),
    defer_to_apply_ms: dist(ops.map(o => o.defer_to_apply_ms).filter((x: unknown) => typeof x === 'number')),
    release_to_apply_ms: dist(ops.map(o => o.release_to_apply_ms).filter((x: unknown) => typeof x === 'number')),
    ticks: { total: ticks.length, completed: ticks.filter((k: Rec) => k.ev === 'tick_result').length, refused: tally(ticks.filter((k: Rec) => k.ev !== 'tick_result').map((k: Rec) => String(k.code))) },
    converge_attempts: dist(trials.flatMap(t => Object.values(t.flags?.converge?.sources ?? {}).map((s: any) => Number(s.attempts ?? 0)))),
    trials_with_publish_consent: trials.filter(t => Object.values(t.flags?.converge?.sources ?? {}).some((s: any) => s.consented_publish === true)).length,
    failures: trials.map((t, i) => ({ seed: t.seed, classes: fails[i] })).filter(x => x.classes.length),
  };
}

export function analyze(out: string, pc2Dir?: string): Rec {
  const trials: Rec = {}, named: Rec = {}, quiet: Rec = {};
  for (const e of ENGINES) for (const a of ARMS) {
    trials[`${e}/${a}`] = load(join(out, 'trials', e, a)); named[`${e}/${a}`] = load(join(out, 'named', e, a)); quiet[`${e}/${a}`] = load(join(out, 'quiet', e, a));
  }
  const summary: Rec = {};
  for (const [k, ts] of Object.entries(trials)) if ((ts as Rec[]).length) summary[k] = armSummary(ts as Rec[]);

  const paired: Rec = {};
  for (const e of ENGINES) {
    const off = new Map((trials[`${e}/off`] as Rec[]).map(t => [t.seed, t])), on = new Map((trials[`${e}/on`] as Rec[]).map(t => [t.seed, t]));
    const seeds = [...off.keys()].filter(s => on.has(s));
    if (!seeds.length) continue;
    const rate = (t: Rec) => { const ops = (t.ops ?? []).filter((o: Rec) => o.issued); return ops.length ? ops.filter(retryable).length / ops.length : 0; };
    const blocked = (t: Rec) => { const xs = (t.ops ?? []).filter((o: Rec) => o.issued && o.first_ms != null && duringPause(t, o)).map((o: Rec) => o.first_ms); return xs.length ? xs.reduce((a: number, b: number) => a + b, 0) / xs.length : null; };
    const bSeeds = seeds.filter(s => blocked(off.get(s)!) != null && blocked(on.get(s)!) != null);
    const quiet = (t: Rec) => mean((t.ops ?? []).filter((o: Rec) => o.issued && o.first_ms != null && noTick(t, o)).map((o: Rec) => Number(o.first_ms)));
    const qSeeds = seeds.filter(s => quiet(off.get(s)!) != null && quiet(on.get(s)!) != null);
    const latency = pairedBootstrap(qSeeds.map(s => quiet(on.get(s)!)! - quiet(off.get(s)!)!));
    paired[e] = { seeds: seeds.length,
      retryable_refusal_rate_off_minus_on: pairedBootstrap(seeds.map(s => rate(off.get(s)!) - rate(on.get(s)!))),
      blocked_ms_off_minus_on: { seeds: bSeeds.length, ...pairedBootstrap(bSeeds.map(s => blocked(off.get(s)!)! - blocked(on.get(s)!)!)) },
      no_tick_latency_on_minus_off_ms: { seeds: qSeeds.length, ...latency, note: 'descriptive; the gate is quiet_latency' } };
  }

  // The write-latency gate: the quiet latency block, every write answered committed at once, paired by seed; a run that
  // failed (any class) leaves its pair out and is counted among the failures instead.
  const quietSummary: Rec = {}, quietLatency: Rec = {};
  for (const [k, ts] of Object.entries(quiet)) if ((ts as Rec[]).length) quietSummary[k] = armSummary(ts as Rec[]);
  for (const e of ENGINES) {
    const off = new Map((quiet[`${e}/off`] as Rec[]).map(t => [t.seed, t])), on = new Map((quiet[`${e}/on`] as Rec[]).map(t => [t.seed, t]));
    const seeds = [...off.keys()].filter(s => on.has(s)).sort((a, b) => a - b);
    const ok = seeds.filter(s => !failureClasses(off.get(s)!, 'trial').length && !failureClasses(on.get(s)!, 'trial').length);
    const writes = (t: Rec) => (t.ops ?? []).filter((o: Rec) => o.issued && o.first_ms != null && noTick(t, o)).map((o: Rec) => Number(o.first_ms));
    const b = pooledBootstrap(ok.map(s => [writes(on.get(s)!), writes(off.get(s)!)]));
    quietLatency[e] = { seeds: seeds.length, excluded_failed: seeds.length - ok.length, ...b, margin_ms: LATENCY_MARGIN_MS, pass: b.hi !== null && b.hi <= LATENCY_MARGIN_MS };
  }

  const namedSummary: Rec = {};
  for (const [k, rs] of Object.entries(named)) {
    if (!(rs as Rec[]).length) continue;
    const cells: Rec = {};
    for (const r of rs as Rec[]) { const c = (cells[r.b] ??= { runs: 0, in_window: 0, failed: 0, classes: {} as Rec }); c.runs++; if (r.observed?.window_hit) c.in_window++;
      const f = failureClasses(r, 'named'); if (f.length) { c.failed++; for (const x of f) c.classes[x] = (c.classes[x] ?? 0) + 1; } }
    namedSummary[k] = cells;
  }

  const onTrials = ENGINES.flatMap(e => trials[`${e}/on`] as Rec[]);
  const failedOn = (ts: Rec[]) => ts.filter(t => failureClasses(t, 'trial').length).length;
  const unit = (n: number, k: number) => ({ n, failures: k, upper95: upperBound(k, n) });
  const onNamed = ENGINES.flatMap(e => named[`${e}/on`] as Rec[]);
  const opsOn = onTrials.flatMap(t => (t.ops ?? []).filter((o: Rec) => o.issued));
  const bounds: Rec = {
    trials_both_engines: unit(onTrials.length, failedOn(onTrials)),
    ...Object.fromEntries(ENGINES.map(e => [`trials_${e}`, unit((trials[`${e}/on`] as Rec[]).length, failedOn(trials[`${e}/on`] as Rec[]))])),
    writes_both_engines: { ...unit(opsOn.length, opsOn.filter(o => OP_CLASSES.some(c => o[c]) || o.harness_error).length), assumes: 'independent writes (writes in one trial share a brain, so this bound is optimistic; the trial bound is the primary one)' },
    writes_held_on: { ...unit(opsOn.filter(o => o.deferred_refresh || o.deferred_import).length, opsOn.filter(o => (o.deferred_refresh || o.deferred_import) && (OP_CLASSES.some(c => o[c]) || o.harness_error)).length), assumes: 'independent writes; n is the held writes the run actually reached' },
    // Each stratum's bound is on the trials that reached its fault: a tick actually killed, a writer actually killed, write A
    // actually held for the import.
    ...Object.fromEntries((['crash', 'writer_kill', 'import_sequence'] as const).map(s => { const ts = onTrials.filter(t => reached(t, s)); return [`stratum_${s}`, unit(ts.length, failedOn(ts))]; })),
    named_in_window: unit(onNamed.filter(r => r.observed?.window_hit).length, onNamed.filter(r => r.observed?.window_hit && failureClasses(r, 'named').length).length),
    named_all_runs: unit(onNamed.length, onNamed.filter(r => failureClasses(r, 'named').length).length),
    quiet_trials_on: unit(ENGINES.flatMap(e => quiet[`${e}/on`] as Rec[]).length, failedOn(ENGINES.flatMap(e => quiet[`${e}/on`] as Rec[]))),
  };

  const pcs: Rec = {};
  pcs.PC1 = Object.fromEntries(ENGINES.map(e => { const s = summary[`${e}/off`]; const share = s ? s.trials_with_worktree_refreshing / s.trials : null; return [e, { share, pass: share !== null && share >= 0.05 }]; }));
  if (pc2Dir) {
    const byEngine = ENGINES.map(e => load(join(resolve(pc2Dir), 'named', e, 'on')));
    const all = byEngine.flat(), runs = all.filter(r => r.observed?.window_hit);
    const caught = runs.filter(r => (r.ops ?? []).some((o: Rec) => o.overwritten)).length;
    const atDetector = all.length > 0 && all.every(r => String(r.provenance?.gbrain_sha ?? '').startsWith(PC2_SHA));
    const planned = byEngine.every(rs => B_KINDS.every(b => rs.filter(r => r.b === b).length === PC2_RUNS));
    pcs.PC2 = { runs: all.length, in_window: runs.length, overwritten: caught, share: runs.length ? caught / runs.length : null, at_detector_build: atDetector, planned_runs: planned,
      pass: runs.length > 0 && caught / runs.length >= 0.8 && atDetector && planned };
  } else pcs.PC2 = { pass: null, note: 'no --pc2 directory given' };
  pcs.PC3 = Object.fromEntries(Object.entries(namedSummary).filter(([k]) => k.endsWith('/on')).flatMap(([k, cells]) => Object.entries(cells as Rec).map(([b, c]: [string, any]) => [`${k}/${b}`, { share: c.in_window / c.runs, pass: c.in_window / c.runs >= 0.9 }])));
  pcs.PC4 = Object.fromEntries(ARMS.map(a => { const ts = ENGINES.flatMap(e => trials[`${e}/${a}`] as Rec[]); const k = ts.filter(t => failureClasses(t, 'trial').includes('harness_error')).length; return [a, { trials: ts.length, harness_errors: k, pass: ts.length > 0 && k / ts.length < 0.01 }]; }));
  pcs.PC5 = Object.fromEntries(ENGINES.map(e => {
    const s = summary[`${e}/on`];
    if (!s) return [e, { pass: false, note: 'no on-arm trials' }];
    const switchesOk = ARMS.every(a => (trials[`${e}/${a}`] as Rec[]).every(t => (t.switches ?? []).length > 0 && t.switches.every((x: Rec) => x.refresh_barrier === (a === 'on'))));
    const share = s.trials_with_deferral / s.trials;
    return [e, { deferral_share: share, worktree_refreshing_first_outside_expiry: s.worktree_refreshing_first_outside_expiry, switches_match_arm: switchesOk,
      pass: share >= 0.05 && s.worktree_refreshing_first_outside_expiry === 0 && switchesOk }];
  }));
  const pcPass = [pcs.PC1, pcs.PC3, pcs.PC4, pcs.PC5].every(m => Object.values(m).every((v: any) => v.pass === true)) && pcs.PC2.pass === true;
  const flagOnFailures = bounds.trials_both_engines.failures + bounds.named_all_runs.failures + bounds.quiet_trials_on.failures;
  const latencyMissing = ENGINES.some(e => !quietLatency[e]?.runs);
  // Every result must come from one gbrain commit and one harness tree, the ones its block's receipt names.
  const results = [...Object.values(trials), ...Object.values(named), ...Object.values(quiet)].flat() as Rec[];
  const provenance = { gbrain_shas: [...new Set(results.map(r => r.provenance?.gbrain_sha ?? null))], harness_digests: [...new Set(results.map(r => r.provenance?.harness_digest ?? null))] };
  const latencyPass = ENGINES.every(e => quietLatency[e]?.pass === true);
  const receipts = readdirSync(out).sort().filter(f => f.startsWith('receipt-')).map(f => JSON.parse(readFileSync(join(out, f), 'utf8')));
  const blockNames = Object.keys(PLANNED) as (keyof typeof PLANNED)[];
  const counted = receipts.every(r => r.counted === true) && ENGINES.every(e => blockNames.every(b => receipts.some(r => r.block === b && r.engine === e)));
  const blocks: Record<keyof typeof PLANNED, Rec> = { trials, named, quiet };
  const incomplete = ENGINES.flatMap(e => ARMS.flatMap(a => blockNames.flatMap(b => {
    const got = new Set((blocks[b][`${e}/${a}`] as Rec[]).map(resultKey)), want = new Set(PLANNED[b]);
    const missing = PLANNED[b].filter(k => !got.has(k)).length, outside = [...got].filter(k => !want.has(k)).length;
    return missing || outside ? [`${b} ${e}/${a} ${got.size - outside} of ${want.size}${outside ? `, ${outside} outside the preregistered seeds` : ''}`] : [];
  })));
  const mixed = provenance.gbrain_shas.length !== 1 || provenance.harness_digests.length !== 1 || provenance.gbrain_shas[0] === null
    || receipts.some(r => r.gbrain?.sha !== provenance.gbrain_shas[0] || r.harness_digest !== provenance.harness_digests[0]);
  const verdict = !pcPass ? 'FIX-METHOD' : mixed ? 'FIX-METHOD (results from more than one gbrain commit or harness tree)'
    : flagOnFailures > 0 ? 'FAIL (triage: gbrain or harness)' : latencyMissing ? 'INCOMPLETE (no quiet latency block)'
    : !latencyPass ? 'FAIL (no-tick write latency)' : incomplete.length ? `FIX-METHOD (incomplete: ${incomplete.join(', ')}; INCOMPLETE instead if the cap stopped the run)` : 'PASS';
  const benefit = Object.fromEntries(ENGINES.map(e => {
    const s = summary[`${e}/on`];
    const share = s && s.writes_outside_expiry ? s.worktree_refreshing_first_outside_expiry / s.writes_outside_expiry : null;
    const p95 = s?.blocked_ms?.p95 ?? null;
    return [e, { worktree_refreshing_share_outside_expiry: share, blocked_p95_ms: p95, pass: share !== null && share <= REFRESHING_SHARE_MAX && p95 !== null && p95 < BLOCKED_P95_MS }];
  }));
  const recommendFlagOn = verdict === 'PASS' && Object.values(benefit).every((b: any) => b.pass === true);
  const analyzerDigest = harnessDigest();
  const result = { counted, incomplete, provenance: { ...provenance, mixed, analyzer_digest: analyzerDigest, analyzer_matches_results: provenance.harness_digests.length === 1 && provenance.harness_digests[0] === analyzerDigest }, receipts: receipts.map(r => ({ block: r.block, engine: r.engine, gbrain: r.gbrain, counted: r.counted, jobs: r.jobs })), verdict_part_a: verdict,
    recommend_flag_on: recommendFlagOn, benefit, bounds, positive_controls: pcs, quiet_latency: quietLatency, summary, quiet_summary: quietSummary, paired, named: namedSummary };
  writeFileSync(join(out, 'analysis.json'), JSON.stringify(result, null, 2));
  return result;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const r = analyze(resolve(get('--out')!), get('--pc2'));
  const f = (x: number | null) => x == null ? 'n/a' : `${(100 * x).toFixed(3)}%`;
  if (!r.provenance.analyzer_matches_results) console.log(`Warning: this analyzer's harness digest ${r.provenance.analyzer_digest} differs from the results' (${r.provenance.harness_digests.join(', ')}).\n`);
  console.log(`# Part A: ${r.verdict_part_a}${r.counted ? '' : ' (uncounted: development receipts, or a block without a receipt)'}; recommend flag on: ${r.recommend_flag_on}\n\n| Unit | n | failures | 95% upper bound |\n|---|---|---|---|`);
  for (const [k, u] of Object.entries(r.bounds as Rec)) console.log(`| ${k} | ${u.n} | ${u.failures} | ${f(u.upper95)} |`);
  console.log(`\nPositive controls: ${JSON.stringify(r.positive_controls)}`);
  for (const [k, s] of Object.entries(r.summary as Rec)) console.log(`\n## ${k}\n${JSON.stringify({ trials: s.trials, failed: s.failed_trials, classes: s.classes, writes: s.writes, first_call: s.first_call, blocked_ms: s.blocked_ms, defer_to_apply_ms: s.defer_to_apply_ms, ticks: s.ticks, failures: s.failures.slice(0, 10) })}`);
  console.log(`\n## quiet latency (gate)\n${JSON.stringify(r.quiet_latency)}\n\n## paired\n${JSON.stringify(r.paired)}\n\n## named\n${JSON.stringify(r.named)}`);
}

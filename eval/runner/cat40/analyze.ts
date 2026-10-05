/**
 * Cat 40 analysis: success by model and arm, gbrain's advantage over the
 * best simple baseline, and how that advantage moves with model capability.
 *
 * Capability index: a model's success rate in the `oracle` arm (the task's
 * evidence handed over, no retrieval). Advantage: gbrain's success rate minus
 * the best of fs, memory and pg for the same model. The slope of advantage on
 * capability across models is the headline; its interval comes from a
 * bootstrap that resamples tasks (all models and arms of a task move together).
 *
 * Cost: `total_usd` per cell is every agent session plus gbrain's own
 * provider calls (judge excluded). The cost split divides it into uncached
 * input, cache writes, cache reads and output (both sessions), plus gbrain's
 * provider calls; the buckets sum to `total_usd`. Cost per success is
 * `total_usd` summed over cells divided by successful cells.
 *
 * With --receipt (repeatable) it warns when a run's event-loop lag p99 was 50 ms
 * or more (its tool latency is then not trustworthy). With --budget-ledger it
 * reconciles cell totals, judge cost and slot builds against each budget run's
 * ledger spend and flags a gap over 1%.
 *
 * Hard tier (v2 records from attempts.jsonl or results.jsonl, or any Hard
 * family): the v1 tables are replaced by the Hard report (`hardAnalysis`).
 * Success uses canonical cells (the last harness-clean attempt per key); cost
 * sums every attempt and every session; retries are counted per model and
 * arm. --comparator (default fs) names the arm for incremental cost per
 * extra success. --expect-grid checks the cell grid and experiment identity
 * and exits 1 on a problem: `observed` expects every observed model x arm x
 * task x repeat, and `models=a,b;arms=fs,pg;tasks=<ids or a count>;repeats=N`
 * overrides any part. --use-rescored reads `rescored.score` (rescore.ts --hard)
 * in place of the original score.
 *
 * Freeze rule (DX-F6): --freeze-rule --round N prints each calibration freeze
 * condition with its value, Wilson 95% interval, threshold and n, names the
 * knob group to move next, appends the table to --calibration-md when given,
 * and exits 0 on PASS, 1 on FAIL.
 *
 * Usage: bun eval/runner/cat40/analyze.ts <results.jsonl> [more.jsonl ...] [--json out.json] [--md out.md]
 *          [--subject gbrain] [--receipt receipt.json ...] [--budget-ledger <ledger>]
 *          [--models a,b] [--comparator fs] [--expect-grid observed|<spec>] [--use-rescored]
 *        bun eval/runner/cat40/analyze.ts <results.jsonl ...> --freeze-rule --round N
 *          [--calibration-md docs/benchmarks/cat40-hard/calibration.md] [--models a,b]
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import type { CellRecord } from '../cat40-model-ladder.ts';
import { CHAT_PRICE_OVERRIDES, ledgerStatus } from '../budget-ledger.ts';
import { provider } from './loop.ts';
import { canonicalCells, gridProblems, isV2, readRecords, type CellRecordV2, type CellView } from './records.ts';
import { HARD_STOP_KINDS, KNOB_PRIORITY, type HardStopKind } from '../../generators/hard/schema.ts';
import { stratumOf } from '../../generators/model-ladder-gen.ts';

export const BASELINES = ['fs', 'memory', 'pg'] as const;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function load(paths: string[]): CellRecord[] {
  return paths.flatMap(p => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as CellRecord));
}

/** Mean success per (model, arm, task) over repeats. */
function table(recs: CellRecord[]) {
  const m = new Map<string, number[]>();
  for (const r of recs) {
    const k = `${r.model}\t${r.arm}\t${r.task}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r.score.success ? 1 : 0);
  }
  const out = new Map<string, number>();
  for (const [k, v] of m) out.set(k, v.reduce((a, b) => a + b, 0) / v.length);
  return out;
}

function rate(t: Map<string, number>, model: string, arm: string, tasks: string[]): number | null {
  const v = tasks.map(x => t.get(`${model}\t${arm}\t${x}`)).filter((x): x is number => x !== undefined);
  return v.length === tasks.length && v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function slope(xs: number[], ys: number[]): number {
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0), den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  return den === 0 ? NaN : num / den;
}

export interface Analysis {
  models: string[];
  arms: string[];
  tasks: string[];
  families: string[];
  success: Record<string, Record<string, number | null>>;
  by_family: Record<string, Record<string, Record<string, number | null>>>;
  /** Success by stratum (memory-only, page-authoring, hidden-tool), then model and arm. */
  by_stratum: Record<string, Record<string, Record<string, number | null>>>;
  capability: Record<string, number | null>;
  advantage: Record<string, { best_baseline: string; value: number; ci95: [number, number] }>;
  pooled_advantage: { value: number; ci95: [number, number] };
  slope: { value: number; ci95: [number, number]; n_models: number };
  family_slopes: Record<string, { value: number; ci95: [number, number] }>;
  safety: Record<string, { output_leaks: number; context_exposures: number; unsafe_writes: number; c_runs: number }>;
  efficiency: Record<string, Record<string, { usd_per_task: number; usd_per_success: number | null; p50_s: number; p95_s: number; turns: number }>>;
  claims: Record<string, { unsupported_per_answer: number; contradicted_per_answer: number; judged: number }>;
  missed_evidence: Record<string, number>;
  /** Mean dollars per cell by bucket, per model and arm; the buckets sum to total_usd. */
  cost_split: Record<string, Record<string, CostBuckets>>;
  /** Mean tool-result characters per cell by tool name (both sessions), per model and arm. */
  tool_chars: Record<string, Record<string, Record<string, number>>>;
  cells: number;
  usd: number;
}

/** `unsplit` holds agent cost a cell's record cannot split (no usage or no verified price); it is 0 for runner output. */
export interface CostBuckets { uncached_input: number; cache_write: number; cache_read: number; output: number; gbrain_provider_calls: number; unsplit: number; total: number }
const BUCKETS = ['uncached_input', 'cache_write', 'cache_read', 'output', 'gbrain_provider_calls', 'unsplit'] as const;

/** One cell's total_usd split into buckets (a scripted cell costs nothing). */
export function cellCostBuckets(r: CellRecord): CostBuckets {
  const b: CostBuckets = { uncached_input: 0, cache_write: 0, cache_read: 0, output: 0, gbrain_provider_calls: r.gbrain_internal?.usd ?? 0, unsplit: 0, total: 0 };
  let p: (typeof CHAT_PRICE_OVERRIDES)[string] | undefined;
  try { p = CHAT_PRICE_OVERRIDES[`${provider(r.model)}:${r.model}`]; } catch { p = undefined; }
  if (r.provider === 'scripted') { /* no agent cost */ }
  else if (!p || !r.run.usage) b.unsplit = r.total_usd - b.gbrain_provider_calls;
  else {
    for (const u of [r.run.usage, r.session1?.usage]) {
      if (!u) continue;
      b.uncached_input += u.input * p.input / 1e6;
      b.cache_write += u.cache_write * (p.cache_write ?? p.input) / 1e6;
      b.cache_read += u.cache_read * (p.cache_read ?? p.input) / 1e6;
      b.output += u.output * p.output / 1e6;
    }
  }
  b.total = BUCKETS.reduce((s, k) => s + b[k], 0);
  return b;
}

/** Tool-result characters by tool name in one cell, both sessions. */
export function cellToolChars(r: CellRecord): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of [...(r.session1?.tool_calls ?? []), ...(r.run.tool_calls ?? [])]) out[t.name] = (out[t.name] ?? 0) + t.chars;
  return out;
}

export interface ReceiptLike { path?: string; budget_run_id?: string | null; slot_builds?: Array<{ allowance?: { usd: number } }>; cost?: { event_loop_lag_ms?: { p50: number; p99: number; max: number } | null; event_loop_lag_unavailable?: string } | null }

/** A warning per receipt whose event-loop lag p99 reached 50 ms, or whose lag was not measured. */
export function lagWarnings(receipts: ReceiptLike[]): string[] {
  const out: string[] = [];
  for (const r of receipts) {
    const lag = r.cost?.event_loop_lag_ms;
    if (lag && lag.p99 >= 50) out.push(`${r.path ?? 'receipt'}: event-loop lag p99 ${lag.p99} ms (max ${lag.max} ms) is 50 ms or more; tool latency from this run is not trustworthy`);
    else if (r.cost && !lag) out.push(`${r.path ?? 'receipt'}: event-loop lag not measured (${r.cost.event_loop_lag_unavailable ?? 'receipt predates the lag monitor'})`);
  }
  return out;
}

export interface Reconciliation { budget_run_id: string; cells: number; cells_usd: number; judge_usd: number; slot_builds_usd: number; attributed_usd: number; ledger_usd: number; gap_usd: number; gap_pct: number; flagged: boolean }

/**
 * Per budget run: cell total_usd plus judge cost plus slot-build allowances,
 * against the ledger's committed spend for that run. A gap over 1% means some
 * spend is not in any cell (failed cells, unattributed proxy requests) or a
 * cell's own pricing disagrees with the provider's billing.
 */
export function reconcile(recs: CellRecord[], ledgerUsd: Record<string, number>, slotBuildsUsd: Record<string, number> = {}): Reconciliation[] {
  const runs = [...new Set([...recs.map(r => r.budget_run_id).filter((x): x is string => !!x), ...Object.keys(ledgerUsd)])].sort();
  return runs.map(id => {
    const rr = recs.filter(r => r.budget_run_id === id);
    const cells_usd = rr.reduce((s, r) => s + r.total_usd, 0), judge_usd = rr.reduce((s, r) => s + (r.judge_usd ?? 0), 0), slot_builds_usd = slotBuildsUsd[id] ?? 0;
    const attributed_usd = cells_usd + judge_usd + slot_builds_usd, ledger_usd = ledgerUsd[id] ?? NaN;
    const gap_usd = ledger_usd - attributed_usd, gap_pct = ledger_usd > 0 ? Math.abs(gap_usd) / ledger_usd : (attributed_usd > 0 ? 1 : 0);
    return { budget_run_id: id, cells: rr.length, cells_usd, judge_usd, slot_builds_usd, attributed_usd, ledger_usd, gap_usd, gap_pct, flagged: !(gap_pct <= 0.01) };
  });
}

export function analyze(recs: CellRecord[], opts: { boots?: number; seed?: number; subject?: string } = {}): Analysis {
  const subject = opts.subject ?? 'gbrain';
  const models = [...new Set(recs.map(r => r.model))].sort();
  const arms = [...new Set(recs.map(r => r.arm))].sort();
  const tasks = [...new Set(recs.map(r => r.task))].sort();
  const families = [...new Set(recs.map(r => r.family))].sort();
  const coreTasks = tasks;
  const t = table(recs);
  const success: Analysis['success'] = {};
  for (const m of models) { success[m] = {}; for (const a of arms) success[m][a] = rate(t, m, a, a === 'fs-acl' ? tasks.filter(x => x.startsWith('C')) : coreTasks); }
  const by_family: Analysis['by_family'] = {};
  for (const f of families) {
    by_family[f] = {};
    const ft = tasks.filter(x => x.startsWith(f));
    for (const m of models) { by_family[f][m] = {}; for (const a of arms) by_family[f][m][a] = rate(t, m, a, ft); }
  }
  const by_stratum: Analysis['by_stratum'] = {};
  const stratumTasks = new Map<string, Set<string>>();
  for (const r of recs) { const k = stratumOf(r.family); if (!stratumTasks.has(k)) stratumTasks.set(k, new Set()); stratumTasks.get(k)!.add(r.task); }
  for (const [k, ts] of [...stratumTasks].sort()) {
    by_stratum[k] = {};
    for (const m of models) { by_stratum[k][m] = {}; for (const a of arms) by_stratum[k][m][a] = rate(t, m, a, [...ts]); }
  }
  const capability = Object.fromEntries(models.map(m => [m, rate(t, m, 'oracle', coreTasks)]));

  const advOn = (taskSet: string[]) => {
    const per: Record<string, { best: string; value: number }> = {};
    for (const m of models) {
      const g = rate(t, m, subject, taskSet);
      const bs = BASELINES.map(b => ({ b, v: rate(t, m, b, taskSet) })).filter(x => x.v !== null) as Array<{ b: string; v: number }>;
      if (g === null || !bs.length) continue;
      const best = bs.reduce((a, b) => (b.v > a.v ? b : a));
      per[m] = { best: best.b, value: g - best.v };
    }
    return per;
  };
  const point = advOn(coreTasks);
  const capOn = (taskSet: string[]) => Object.fromEntries(models.map(m => [m, rate(t, m, 'oracle', taskSet)]));
  const slopeOn = (taskSet: string[]) => {
    const adv = advOn(taskSet), cap = capOn(taskSet);
    const ms = Object.keys(adv).filter(m => cap[m] !== null);
    return ms.length >= 2 ? slope(ms.map(m => cap[m]!), ms.map(m => adv[m].value)) : NaN;
  };
  const rng = mulberry32(opts.seed ?? 40);
  const B = opts.boots ?? 2000;
  const bootAdv: Record<string, number[]> = Object.fromEntries(models.map(m => [m, []]));
  const bootPooled: number[] = [], bootSlope: number[] = [];
  const famBoot: Record<string, number[]> = Object.fromEntries(families.map(f => [f, []]));
  for (let b = 0; b < B; b++) {
    const sample = coreTasks.map(() => coreTasks[Math.floor(rng() * coreTasks.length)]);
    // Duplicate-aware rates: expand the table lookups by the sampled list.
    const rs = (m: string, a: string, list: string[]) => { const v = list.map(x => t.get(`${m}\t${a}\t${x}`)); return v.every(x => x !== undefined) && v.length ? (v as number[]).reduce((p, q) => p + q, 0) / v.length : null; };
    const adv: Record<string, number> = {}, cap: Record<string, number> = {};
    for (const m of models) {
      const g = rs(m, subject, sample);
      const bs = BASELINES.map(x => rs(m, x, sample)).filter((x): x is number => x !== null);
      const c = rs(m, 'oracle', sample);
      if (g === null || !bs.length) continue;
      adv[m] = g - Math.max(...bs);
      bootAdv[m].push(adv[m]);
      if (c !== null) cap[m] = c;
    }
    const ms = Object.keys(adv);
    if (ms.length) bootPooled.push(ms.reduce((s, m) => s + adv[m], 0) / ms.length);
    const ms2 = ms.filter(m => cap[m] !== undefined);
    if (ms2.length >= 2) bootSlope.push(slope(ms2.map(m => cap[m]), ms2.map(m => adv[m])));
    for (const f of families) {
      const fs = sample.filter(x => x.startsWith(f));
      if (fs.length < 2) continue;
      const a2: Record<string, number> = {}, c2: Record<string, number> = {};
      for (const m of models) {
        const g = rs(m, subject, fs); const bs = BASELINES.map(x => rs(m, x, fs)).filter((x): x is number => x !== null); const c = rs(m, 'oracle', fs);
        if (g !== null && bs.length && c !== null) { a2[m] = g - Math.max(...bs); c2[m] = c; }
      }
      const mm = Object.keys(a2);
      if (mm.length >= 2) { const s = slope(mm.map(m => c2[m]), mm.map(m => a2[m])); if (Number.isFinite(s)) famBoot[f].push(s); }
    }
  }
  const ci = (xs: number[]): [number, number] => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? [s[Math.floor(0.025 * (s.length - 1))], s[Math.ceil(0.975 * (s.length - 1))]] : [NaN, NaN]; };
  const advantage: Analysis['advantage'] = {};
  for (const m of Object.keys(point)) advantage[m] = { best_baseline: point[m].best, value: point[m].value, ci95: ci(bootAdv[m]) };
  const pv = Object.values(point);
  const pooled_advantage = { value: pv.length ? pv.reduce((s, x) => s + x.value, 0) / pv.length : NaN, ci95: ci(bootPooled) };
  const family_slopes: Analysis['family_slopes'] = {};
  for (const f of families) family_slopes[f] = { value: slopeOn(tasks.filter(x => x.startsWith(f))), ci95: ci(famBoot[f]) };

  const safety: Analysis['safety'] = {};
  for (const a of arms) {
    const rr = recs.filter(r => r.arm === a);
    const cr = rr.filter(r => r.family === 'C');
    safety[a] = { output_leaks: cr.filter(r => r.score.output_leak).length, context_exposures: cr.filter(r => r.score.context_exposure).length, unsafe_writes: rr.filter(r => r.score.unsafe_write).length, c_runs: cr.length };
  }
  const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
  const efficiency: Analysis['efficiency'] = {};
  for (const m of models) {
    efficiency[m] = {};
    for (const a of arms) {
      const rr = recs.filter(r => r.model === m && r.arm === a);
      if (!rr.length) continue;
      const usd = rr.reduce((s, r) => s + r.total_usd, 0), wins = rr.filter(r => r.score.success).length;
      efficiency[m][a] = { usd_per_task: usd / rr.length, usd_per_success: wins ? usd / wins : null, p50_s: pct(rr.map(r => r.wall_ms / 1000), 0.5), p95_s: pct(rr.map(r => r.wall_ms / 1000), 0.95), turns: rr.reduce((s, r) => s + r.run.turns, 0) / rr.length };
    }
  }
  const claims: Analysis['claims'] = {};
  for (const a of arms) {
    const rr = recs.filter(r => r.arm === a && r.claims);
    claims[a] = { unsupported_per_answer: rr.length ? rr.reduce((s, r) => s + r.claims!.unsupported, 0) / rr.length : NaN, contradicted_per_answer: rr.length ? rr.reduce((s, r) => s + r.claims!.contradicted, 0) / rr.length : NaN, judged: rr.length };
  }
  const missed_evidence: Analysis['missed_evidence'] = {};
  for (const a of arms) {
    const rr = recs.filter(r => r.arm === a && r.score.evidence_cited.length + r.score.missed_evidence.length > 0);
    const tot = rr.reduce((s, r) => s + r.score.evidence_cited.length + r.score.missed_evidence.length, 0);
    missed_evidence[a] = tot ? rr.reduce((s, r) => s + r.score.missed_evidence.length, 0) / tot : NaN;
  }
  const cost_split: Analysis['cost_split'] = {};
  const tool_chars: Analysis['tool_chars'] = {};
  for (const m of models) {
    cost_split[m] = {}; tool_chars[m] = {};
    for (const a of arms) {
      const rr = recs.filter(r => r.model === m && r.arm === a);
      if (!rr.length) continue;
      const sum: CostBuckets = { uncached_input: 0, cache_write: 0, cache_read: 0, output: 0, gbrain_provider_calls: 0, unsplit: 0, total: 0 };
      const chars: Record<string, number> = {};
      for (const r of rr) {
        const b = cellCostBuckets(r);
        for (const k of [...BUCKETS, 'total'] as const) sum[k] += b[k] / rr.length;
        for (const [tool, c] of Object.entries(cellToolChars(r))) chars[tool] = (chars[tool] ?? 0) + c / rr.length;
      }
      cost_split[m][a] = sum;
      tool_chars[m][a] = chars;
    }
  }
  const ms = Object.keys(point).filter(m => capability[m] !== null);
  return {
    models, arms, tasks, families, success, by_family, by_stratum, capability, advantage, pooled_advantage,
    slope: { value: ms.length >= 2 ? slope(ms.map(m => capability[m]!), ms.map(m => point[m].value)) : NaN, ci95: ci(bootSlope), n_models: ms.length },
    family_slopes, safety, efficiency, claims, missed_evidence, cost_split, tool_chars, cells: recs.length,
    usd: recs.reduce((s, r) => s + r.total_usd + ((r as unknown as { judge_usd?: number }).judge_usd ?? 0), 0),
  };
}

const f2 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : x.toFixed(2));
const pc = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : `${Math.round(x * 100)}%`);

export function markdown(a: Analysis): string {
  const L: string[] = [];
  L.push(`Cells: ${a.cells}. Spend in these records: $${a.usd.toFixed(2)}.`, '');
  L.push(`| Model | capability (oracle) | ${a.arms.filter(x => x !== 'oracle').join(' | ')} | gbrain advantage [95% CI] |`);
  L.push(`|---|---|${a.arms.filter(x => x !== 'oracle').map(() => '---').join('|')}|---|`);
  for (const m of a.models) {
    const adv = a.advantage[m];
    L.push(`| ${m} | ${pc(a.capability[m])} | ${a.arms.filter(x => x !== 'oracle').map(x => pc(a.success[m][x])).join(' | ')} | ${adv ? `${adv.value >= 0 ? '+' : ''}${Math.round(adv.value * 100)} pts vs ${adv.best_baseline} [${Math.round(adv.ci95[0] * 100)}, ${Math.round(adv.ci95[1] * 100)}]` : 'n/a'} |`);
  }
  L.push('', `Pooled advantage: ${Math.round(a.pooled_advantage.value * 100)} pts [${Math.round(a.pooled_advantage.ci95[0] * 100)}, ${Math.round(a.pooled_advantage.ci95[1] * 100)}].`);
  L.push(`Slope of advantage on capability (${a.slope.n_models} models): ${f2(a.slope.value)} [${f2(a.slope.ci95[0])}, ${f2(a.slope.ci95[1])}].`, '');
  L.push('| Family | ' + a.models.map(m => m).join(' | ') + ' | slope [95% CI] |');
  L.push('|---|' + a.models.map(() => '---').join('|') + '|---|');
  for (const f of a.families) {
    L.push(`| ${f} | ${a.models.map(m => a.arms.filter(x => x !== 'fs-acl').map(x => `${x[0]}${x === 'memory' ? 'm' : ''}:${pc(a.by_family[f][m][x])}`).join(' ')).join(' | ')} | ${f2(a.family_slopes[f].value)} [${f2(a.family_slopes[f].ci95[0])}, ${f2(a.family_slopes[f].ci95[1])}] |`);
  }
  L.push('', '| Stratum | ' + a.models.join(' | ') + ' |', '|---|' + a.models.map(() => '---').join('|') + '|');
  for (const k of Object.keys(a.by_stratum)) L.push(`| ${k} | ${a.models.map(m => a.arms.filter(x => x !== 'fs-acl').map(x => `${x}:${pc(a.by_stratum[k][m][x])}`).join(' ')).join(' | ')} |`);
  L.push('', '| Arm | C output leaks | C context exposures | unsafe writes | unsupported claims/answer | missed evidence |', '|---|---|---|---|---|---|');
  for (const x of a.arms) L.push(`| ${x} | ${a.safety[x].output_leaks}/${a.safety[x].c_runs} | ${a.safety[x].context_exposures}/${a.safety[x].c_runs} | ${a.safety[x].unsafe_writes} | ${f2(a.claims[x].unsupported_per_answer)} | ${pc(a.missed_evidence[x])} |`);
  L.push('', '| Model | Arm | $/task | $/success | p50 s | p95 s | turns |', '|---|---|---|---|---|---|---|');
  for (const m of a.models) for (const x of a.arms) { const e = a.efficiency[m][x]; if (e) L.push(`| ${m} | ${x} | ${e.usd_per_task.toFixed(3)} | ${e.usd_per_success === null ? 'n/a' : e.usd_per_success.toFixed(3)} | ${e.p50_s.toFixed(0)} | ${e.p95_s.toFixed(0)} | ${e.turns.toFixed(1)} |`); }
  L.push('', 'Cost split per cell (`total_usd`: agent sessions plus gbrain provider calls, judge excluded; the columns sum to the total):', '',
    '| Model | Arm | uncached input $ | cache write $ | cache read $ | output $ | gbrain provider calls $ | total_usd |', '|---|---|---|---|---|---|---|---|');
  for (const m of a.models) for (const x of a.arms) { const c = a.cost_split[m]?.[x]; if (c) L.push(`| ${m} | ${x} | ${c.uncached_input.toFixed(4)} | ${c.cache_write.toFixed(4)} | ${c.cache_read.toFixed(4)} | ${c.output.toFixed(4)} | ${c.gbrain_provider_calls.toFixed(4)} | ${c.total.toFixed(4)} |`); }
  L.push('', 'Tool-result characters per cell, by tool:', '', '| Model | Arm | characters by tool |', '|---|---|---|');
  for (const m of a.models) for (const x of a.arms) {
    const t = a.tool_chars[m]?.[x];
    if (t) L.push(`| ${m} | ${x} | ${Object.entries(t).sort((p, q) => q[1] - p[1]).map(([k, v]) => `${k} ${Math.round(v).toLocaleString('en-US')}`).join(', ') || 'none'} |`);
  }
  return L.join('\n');
}

export function reconciliationMarkdown(rows: Reconciliation[]): string {
  const L = ['| Budget run | cells | cells $ | judge $ | slot builds $ | ledger $ | gap | |', '|---|---|---|---|---|---|---|---|'];
  for (const r of rows) L.push(`| ${r.budget_run_id} | ${r.cells} | ${r.cells_usd.toFixed(4)} | ${r.judge_usd.toFixed(4)} | ${r.slot_builds_usd.toFixed(4)} | ${r.ledger_usd.toFixed(4)} | ${(r.gap_pct * 100).toFixed(2)}% | ${r.flagged ? 'GAP OVER 1%' : 'ok'} |`);
  return L.join('\n');
}

// ─── Hard tier (v2 records) ─────────────────────────────────────────

/** Hard reports list the models people use most first, then the rest alphabetically (CEO-F8). */
export const HARD_MODEL_ORDER = ['claude-sonnet-5-5', 'claude-opus-5-5', 'gpt-6.1-sol', 'claude-fable-5-1', 'gpt-6-astra'];
/** Arms in report order; others follow alphabetically. */
const HARD_ARM_ORDER = ['oracle', 'fs', 'pg', 'memory'];

export function orderModels(models: Iterable<string>): string[] {
  const set = new Set(models);
  return [...HARD_MODEL_ORDER.filter(m => set.has(m)), ...[...set].filter(m => !HARD_MODEL_ORDER.includes(m)).sort()];
}

function orderArms(arms: Iterable<string>): string[] {
  const set = new Set(arms);
  return [...HARD_ARM_ORDER.filter(a => set.has(a)), ...[...set].filter(a => !HARD_ARM_ORDER.includes(a)).sort()];
}

/** True when the input holds v2 records or Hard families, so the Hard report applies. */
export function isHardInput(records: Array<Record<string, unknown>>): boolean {
  return records.some(r => isV2(r) || String(r.family ?? '').startsWith('H'));
}

/** Wilson score interval for k successes in n trials (95% by default); [NaN, NaN] when n is 0. */
export function wilson(k: number, n: number, z = 1.959963984540054): [number, number] {
  if (!n) return [NaN, NaN];
  const p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN; };

/**
 * Dollars per extra successful task, subject against comparator: the
 * difference in cost per task divided by the difference in success rate.
 * With equal cell counts this is (cost(subject) - cost(comparator)) /
 * (successes(subject) - successes(comparator)). Null when the subject does
 * not finish more tasks (denominator at or below 0).
 */
export function incrementalCost(subject: { usd_per_task: number | null; success: number | null }, comparator: { usd_per_task: number | null; success: number | null }): number | null {
  if (subject.usd_per_task === null || comparator.usd_per_task === null || subject.success === null || comparator.success === null) return null;
  const dS = subject.success - comparator.success;
  return dS > 1e-12 ? (subject.usd_per_task - comparator.usd_per_task) / dS : null;
}

/** Drop repeated v2 lines (the same attempt_id read from both attempts.jsonl and results.jsonl); v1 lines pass through. */
export function uniqueAttempts(records: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  return records.filter(r => { if (!isV2(r)) return true; if (seen.has(r.attempt_id)) return false; seen.add(r.attempt_id); return true; });
}

/** Replace each record's score with its offline rescoring (`rescored.score`, rescore.ts --hard) where one exists. */
export function useRescored(records: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return records.map(r => { const x = (r as { rescored?: { score?: unknown } }).rescored; return x?.score ? { ...r, score: x.score } : r; });
}

export interface HardSlice {
  cells: number;
  successes: number;
  success: number | null;
  ci95: [number, number];
  /** Tool calls per canonical cell, every session. */
  tool_calls_per_task: number | null;
  /** Stop kinds of canonical cells; `harness_error` counts attempts (canonical cells never end in one). */
  stops: Record<HardStopKind, number>;
  attempts: number;
  unparseable_set: number;
  /** Agent, embedding and gbrain dollars over every attempt and session (judge excluded). */
  usd_all_attempts: number;
  judge_usd_all_attempts: number;
  usd_per_task: number | null;
  usd_per_success: number | null;
  /** Agent-only latency (`timings.agent_ms`, never restore time). */
  agent_p50_s: number;
  agent_p95_s: number;
  /** End-to-end wall clock per attempt, and slot restore time where recorded. */
  wall_p50_s: number;
  restore_p50_s: number | null;
}

export interface HardAnalysis {
  models: string[];
  arms: string[];
  families: string[];
  comparator: string;
  cells: number;
  attempts: number;
  /** Agent, embedding, gbrain and judge dollars over every attempt. */
  usd_all_attempts: number;
  judge_usd: number;
  /** harness_error retries per `model|arm`. */
  retries: Record<string, number>;
  /** Keys with no harness-clean attempt. */
  incomplete: string[];
  grid_problems: string[];
  /** v2 attempts whose session dollars plus embeddings plus gbrain dollars differ from total_usd. */
  cost_warnings: string[];
  by_model_arm: Record<string, Record<string, HardSlice>>;
  by_arm: Record<string, HardSlice>;
  by_arm_family: Record<string, Record<string, HardSlice>>;
  /** Stop kinds per session index, multi-session canonical cells only. */
  by_session: Record<string, Record<number, Partial<Record<HardStopKind, number>>>>;
  incremental: Array<{ model: string; arm: string; delta_usd_per_task: number | null; delta_success: number | null; usd_per_extra_success: number | null; ceiling: boolean }>;
  favors: Record<string, { best: string[]; margin: number | null }>;
  /** Models at 100% on every arm they ran. */
  ceiling_models: string[];
  setup_usd: number | null;
}

function slice(cells: CellView[], attempts: CellView[]): HardSlice {
  const successes = cells.filter(c => c.success).length;
  const stops = Object.fromEntries(HARD_STOP_KINDS.map(k => [k, 0])) as Record<HardStopKind, number>;
  for (const c of cells) if (c.stop in stops) stops[c.stop as HardStopKind]++;
  stops.harness_error = attempts.filter(a => !a.harness_clean).length;
  const usd = attempts.reduce((s, a) => s + a.total_usd, 0);
  const restores = attempts.map(a => (a.raw as { timings?: { restore_ms?: number }; restore_ms?: number })).map(r => r.timings?.restore_ms ?? r.restore_ms).filter((x): x is number => typeof x === 'number');
  return {
    cells: cells.length, successes, success: cells.length ? successes / cells.length : null, ci95: wilson(successes, cells.length),
    tool_calls_per_task: cells.length ? cells.reduce((s, c) => s + c.tool_calls, 0) / cells.length : null,
    stops, attempts: attempts.length, unparseable_set: cells.filter(c => c.unparseable_set).length,
    usd_all_attempts: usd, judge_usd_all_attempts: attempts.reduce((s, a) => s + a.judge_usd, 0),
    usd_per_task: cells.length ? usd / cells.length : null, usd_per_success: successes ? usd / successes : null,
    agent_p50_s: quantile(cells.map(c => c.agent_ms / 1000), 0.5), agent_p95_s: quantile(cells.map(c => c.agent_ms / 1000), 0.95),
    wall_p50_s: quantile(attempts.map(a => a.wall_ms / 1000), 0.5), restore_p50_s: restores.length ? quantile(restores, 0.5) / 1000 : null,
  };
}

/** Parse `--expect-grid models=a,b;arms=fs,pg;tasks=H1-01,H1-02|N;repeats=1`; omitted keys take the observed values. */
export function parseGridSpec(spec: string, observed: { models: string[]; arms: string[]; tasks: string[]; repeats: number }): { models: string[]; arms: string[]; tasks: string[]; repeats: number; task_count?: number } {
  const out: { models: string[]; arms: string[]; tasks: string[]; repeats: number; task_count?: number } = { ...observed };
  for (const part of spec.split(';').map(s => s.trim()).filter(s => s && s !== 'observed')) {
    const [k, v = ''] = part.split('=');
    if (k === 'models' || k === 'arms') out[k] = v.split(',').filter(Boolean);
    else if (k === 'repeats') out.repeats = Number(v);
    else if (k === 'tasks') { if (/^\d+$/.test(v)) out.task_count = Number(v); else out.tasks = v.split(',').filter(Boolean); }
    else throw new Error(`--expect-grid: unknown key "${k}"; use models=a,b;arms=fs,pg;tasks=<ids or a count>;repeats=N`);
  }
  if (!Number.isInteger(out.repeats) || out.repeats < 1) throw new Error('--expect-grid: repeats is a positive integer');
  return out;
}

/**
 * The Hard report (CEO-F8, CEO-F27, DX-F14, ENG-F1): canonical cells for
 * success, cost over every attempt and session, retries per model and arm,
 * stops by kind, unparseable sets, incremental cost per extra success against
 * the comparator, agent latency without restore time, and which families
 * favor which arm. Reads v1 and v2 records.
 */
export function hardAnalysis(records: Array<Record<string, unknown>>, opts: { comparator?: string; expectGrid?: string; models?: string[]; setupUsd?: number | null } = {}): HardAnalysis {
  const recs = uniqueAttempts(opts.models ? records.filter(r => opts.models!.includes(String(r.model))) : records);
  const { cells, attempts, retries, incomplete } = canonicalCells(recs);
  const models = orderModels(attempts.map(a => a.model));
  const arms = orderArms(attempts.map(a => a.arm));
  const families = [...new Set(attempts.map(a => a.family))].sort();
  const tasks = [...new Set(attempts.map(a => a.task))].sort();
  const comparator = opts.comparator ?? 'fs';
  const grid_problems: string[] = incomplete.length ? [`${incomplete.length} cells have no harness-clean attempt (${incomplete.slice(0, 3).join(', ')}${incomplete.length > 3 ? ', ...' : ''})`] : [];
  if (opts.expectGrid !== undefined) {
    const g = parseGridSpec(opts.expectGrid, { models, arms, tasks, repeats: Math.max(0, ...attempts.map(a => a.repeat)) + 1 });
    if (g.task_count !== undefined && g.task_count !== tasks.length) grid_problems.push(`expected ${g.task_count} tasks, found ${tasks.length}`);
    grid_problems.push(...gridProblems(cells, g));
  } else grid_problems.push(...gridProblems(cells, { models: [], arms: [], tasks: [], repeats: 0 }));
  const cost_warnings: string[] = [];
  for (const a of attempts) {
    if (a.version !== 2) continue;
    const r = a.raw as unknown as CellRecordV2;
    const sum = r.sessions.reduce((s, x) => s + x.usd, 0) + (r.cost?.embed_usd ?? 0) + (r.cost?.gbrain_usd ?? 0);
    if (Math.abs(sum - r.total_usd) > 1e-6) cost_warnings.push(`${r.attempt_id}: sessions ($${sum.toFixed(4)} with embeddings and gbrain) differ from total_usd ($${r.total_usd.toFixed(4)})`);
  }
  const pick = (m?: string, a?: string, f?: string) => (x: CellView) => (m === undefined || x.model === m) && (a === undefined || x.arm === a) && (f === undefined || x.family === f);
  const sl = (m?: string, a?: string, f?: string) => slice(cells.filter(pick(m, a, f)), attempts.filter(pick(m, a, f)));
  const by_model_arm: HardAnalysis['by_model_arm'] = {};
  for (const m of models) { by_model_arm[m] = {}; for (const a of arms) if (attempts.some(pick(m, a))) by_model_arm[m][a] = sl(m, a); }
  const by_arm: HardAnalysis['by_arm'] = Object.fromEntries(arms.map(a => [a, sl(undefined, a)]));
  const by_arm_family: HardAnalysis['by_arm_family'] = Object.fromEntries(arms.map(a => [a, Object.fromEntries(families.map(f => [f, sl(undefined, a, f)]))]));
  const by_session: HardAnalysis['by_session'] = {};
  for (const c of cells) {
    if (c.sessions.length < 2) continue;
    for (const s of c.sessions) { const row = ((by_session[c.arm] ??= {})[s.index] ??= {}); row[s.stop as HardStopKind] = (row[s.stop as HardStopKind] ?? 0) + 1; }
  }
  const incremental: HardAnalysis['incremental'] = [];
  for (const m of [...models, 'all']) {
    const get = (a: string) => (m === 'all' ? by_arm[a] : by_model_arm[m][a]);
    const comp = get(comparator);
    if (!comp) continue;
    for (const a of arms) {
      const s = get(a);
      if (a === comparator || a === 'oracle' || !s) continue;
      incremental.push({
        model: m, arm: a, delta_usd_per_task: s.usd_per_task !== null && comp.usd_per_task !== null ? s.usd_per_task - comp.usd_per_task : null,
        delta_success: s.success !== null && comp.success !== null ? s.success - comp.success : null, usd_per_extra_success: incrementalCost(s, comp),
        ceiling: s.success === 1 && comp.success === 1,
      });
    }
  }
  const favors: HardAnalysis['favors'] = {};
  for (const f of families) {
    const rs = arms.filter(a => a !== 'oracle').map(a => ({ a, v: by_arm_family[a][f].success })).filter((x): x is { a: string; v: number } => x.v !== null).sort((p, q) => q.v - p.v);
    if (!rs.length) { favors[f] = { best: [], margin: null }; continue; }
    const best = rs.filter(x => Math.abs(x.v - rs[0].v) < 1e-12).map(x => x.a);
    const next = rs.find(x => !best.includes(x.a));
    favors[f] = { best, margin: next ? rs[0].v - next.v : null };
  }
  const ceiling_models = models.filter(m => { const v = Object.values(by_model_arm[m]); return v.length > 0 && v.every(s => s.success === 1); });
  return {
    models, arms, families, comparator, cells: cells.length, attempts: attempts.length,
    usd_all_attempts: attempts.reduce((s, a) => s + a.total_usd + a.judge_usd, 0), judge_usd: attempts.reduce((s, a) => s + a.judge_usd, 0),
    retries: Object.fromEntries(Object.entries(retries).filter(([, n]) => n > 0)), incomplete, grid_problems, cost_warnings,
    by_model_arm, by_arm, by_arm_family, by_session, incremental, favors, ceiling_models, setup_usd: opts.setupUsd ?? null,
  };
}

const kn = (s: HardSlice) => `${pc(s.success)} (${s.successes}/${s.cells})`;
const usd = (x: number | null) => (x === null || !Number.isFinite(x) ? 'n/a' : `$${x.toFixed(4)}`);
const sec = (x: number | null) => (x === null || !Number.isFinite(x) ? 'n/a' : x.toFixed(1));
const pts = (x: number | null) => (x === null || !Number.isFinite(x) ? 'n/a' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)} pts`);

export function hardMarkdown(a: HardAnalysis): string {
  const L: string[] = ['## Hard tier', ''];
  const retries = Object.entries(a.retries);
  L.push(`Canonical cells: ${a.cells} (the last harness-clean attempt per cell). Attempts: ${a.attempts}. Spend over every attempt: $${a.usd_all_attempts.toFixed(2)} (judge $${a.judge_usd.toFixed(2)}).${a.setup_usd !== null ? ` Setup (slot builds from receipts): $${a.setup_usd.toFixed(2)}.` : ''}`);
  L.push(`Harness-error retries per model and arm: ${retries.length ? retries.map(([k, n]) => `${k.replace('|', ' / ')} ${n}`).join(', ') : 'none'}.`);
  L.push(`Grid and experiment checks: ${a.grid_problems.length ? a.grid_problems.join('; ') : 'no problems found'}.`);
  for (const w of a.cost_warnings) L.push(`Warning: ${w}.`);
  L.push('', '### Success by model and arm', '', `| Model | ${a.arms.join(' | ')} |`, `|---|${a.arms.map(() => '---').join('|')}|`);
  for (const m of a.models) L.push(`| ${m} | ${a.arms.map(x => (a.by_model_arm[m][x] ? kn(a.by_model_arm[m][x]) : 'not run')).join(' | ')} |`);
  L.push(`| all | ${a.arms.map(x => kn(a.by_arm[x])).join(' | ')} |`);
  for (const m of a.ceiling_models) L.push('', `${m} is at 100% on every arm it ran: uninformative for comparisons, not a tie.`);
  L.push('', '### Per arm and family', '', 'Stops count canonical cells, except harness_error, which counts retried attempts. Cost is agent, embedding and gbrain dollars over every attempt and session (judge excluded), divided by canonical cells. Agent latency excludes slot restore.', '');
  L.push('| Arm | Family | success | tool calls/task | turn_cap | no_tool_call | context_overflow | error | harness_error | unparseable sets | $/task | $/success | agent p50 s |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  const row = (arm: string, fam: string, s: HardSlice) => `| ${arm} | ${fam} | ${kn(s)} | ${f2(s.tool_calls_per_task)} | ${s.stops.turn_cap} | ${s.stops.no_tool_call} | ${s.stops.context_overflow} | ${s.stops.error} | ${s.stops.harness_error} | ${s.unparseable_set} | ${usd(s.usd_per_task)} | ${usd(s.usd_per_success)} | ${sec(s.agent_p50_s)} |`;
  for (const x of a.arms) { for (const f of a.families) if (a.by_arm_family[x][f].attempts) L.push(row(x, f, a.by_arm_family[x][f])); L.push(row(x, 'all', a.by_arm[x])); }
  const sessArms = Object.keys(a.by_session);
  if (sessArms.length) {
    L.push('', '### Stops by session (multi-session cells)', '', `| Arm | session | ${HARD_STOP_KINDS.filter(k => k !== 'harness_error').join(' | ')} |`, `|---|---|${HARD_STOP_KINDS.filter(k => k !== 'harness_error').map(() => '---').join('|')}|`);
    for (const x of orderArms(sessArms)) for (const [i, st] of Object.entries(a.by_session[x])) L.push(`| ${x} | ${i} | ${HARD_STOP_KINDS.filter(k => k !== 'harness_error').map(k => st[k] ?? 0).join(' | ')} |`);
  }
  L.push('', '### Cost and latency per model and arm', '', '| Model | Arm | success | $/task (all attempts) | $/success | judge $/task | agent p50 s | agent p95 s | end-to-end p50 s | restore p50 s | retries |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const m of a.models) for (const x of a.arms) {
    const s = a.by_model_arm[m][x];
    if (s) L.push(`| ${m} | ${x} | ${kn(s)} | ${usd(s.usd_per_task)} | ${usd(s.usd_per_success)} | ${usd(s.cells ? s.judge_usd_all_attempts / s.cells : null)} | ${sec(s.agent_p50_s)} | ${sec(s.agent_p95_s)} | ${sec(s.wall_p50_s)} | ${sec(s.restore_p50_s)} | ${a.retries[`${m}|${x}`] ?? 0} |`);
  }
  L.push('', `### Incremental cost per extra success against ${a.comparator}`, '');
  if (!a.by_arm[a.comparator]) L.push(`No comparison: the comparator ${a.comparator} is not in these records (choose one with --comparator).`);
  else if (!a.incremental.length) L.push(`No comparison: no arm besides ${a.comparator} and the oracle reference.`);
  else {
    L.push('Dollars per extra successful task = (cost per task of the arm minus that of the comparator) / (success rate of the arm minus that of the comparator); n/a when the arm does not finish more tasks.', '');
    L.push('| Model | Arm | Δ $/task | Δ success | $ per extra success | note |', '|---|---|---|---|---|---|');
    for (const r of a.incremental) L.push(`| ${r.model} | ${r.arm} | ${usd(r.delta_usd_per_task)} | ${pts(r.delta_success)} | ${usd(r.usd_per_extra_success)} | ${r.ceiling ? 'both at 100%: uninformative' : ''} |`);
  }
  const plain = a.arms.filter(x => x !== 'oracle');
  L.push('', '### Which families favor which arm', '', 'Success pooled over models; the oracle is a reference and is not ranked.', '', `| Family | ${a.arms.join(' | ')} | favors |`, `|---|${a.arms.map(() => '---').join('|')}|---|`);
  for (const f of a.families) {
    const fv = a.favors[f];
    const say = !fv.best.length ? 'n/a' : plain.length < 2 ? `${fv.best.join(', ')} (only arm)` : fv.margin === null ? `tie (${fv.best.join(', ')})` : fv.best.length > 1 ? `tie (${fv.best.join(', ')}), ${pts(fv.margin)} over the next` : `${fv.best[0]} by ${pts(fv.margin)}`;
    L.push(`| ${f} | ${a.arms.map(x => kn(a.by_arm_family[x][f])).join(' | ')} | ${say} |`);
  }
  return L.join('\n');
}

// ─── Freeze-rule analyzer (DX-F6, CEO-F5, CEO-F6, CEO-F20, Taste CEO-T1) ─

/** Calibration arms; the freeze rule uses the better of the two. */
export const CALIBRATION_ARMS = ['fs', 'pg'] as const;
export const FREEZE_RULE = { pooled: [0.4, 0.7], per_model: [0.2, 0.8], oracle_min: 0.9, family_oracle_min: 0.8, turn_cap_share_max: 0.5 } as const;

export interface FreezeCheck { id: string; label: string; value: number | null; k: number; n: number; ci95: [number, number]; threshold: string; pass: boolean }
export interface FreezeResult {
  models: string[];
  families: string[];
  tasks: number;
  /** The calibration arm with the higher pooled success (fs on a tie); null when neither ran. */
  pooled_arm: string | null;
  checks: FreezeCheck[];
  pass: boolean;
  per_model: Record<string, Record<string, HardSlice>>;
  per_family: Record<string, Record<string, HardSlice>>;
  stops: Record<string, HardSlice>;
  usd_all_attempts: number;
  grid_problems: string[];
  /** What to change next, in the knob priority order. */
  next: string[];
}

const EPS = 1e-9;

/**
 * Apply the calibration freeze rule to one round's records: (a) the pooled
 * best calibration arm within 40-70%; (b) every model's better of fs and pg
 * within 20-80%; (c) every model's oracle at least 90%; (d) every family's
 * oracle at least 80%, pooled over the round's models; (e) at most 50% of the
 * pooled arm's failures are turn_cap stops. A complete grid and one
 * experiment identity are required as well. Point estimates decide; Wilson
 * 95% intervals are reported beside them (ENG-F15).
 */
export function freezeRule(records: Array<Record<string, unknown>>, opts: { models?: string[] } = {}): FreezeResult {
  const recs = uniqueAttempts(opts.models ? records.filter(r => opts.models!.includes(String(r.model))) : records);
  const { cells, attempts, incomplete } = canonicalCells(recs);
  const models = orderModels(attempts.map(a => a.model));
  const families = [...new Set(attempts.map(a => a.family))].sort();
  const tasks = [...new Set(attempts.map(a => a.task))].sort();
  const present = CALIBRATION_ARMS.filter(a => attempts.some(x => x.arm === a));
  const armsUsed = [...present, 'oracle'];
  const pick = (m?: string, a?: string, f?: string) => (x: CellView) => (m === undefined || x.model === m) && (a === undefined || x.arm === a) && (f === undefined || x.family === f);
  const sl = (m?: string, a?: string, f?: string) => slice(cells.filter(pick(m, a, f)), attempts.filter(pick(m, a, f)));
  const per_model = Object.fromEntries(models.map(m => [m, Object.fromEntries(armsUsed.map(a => [a, sl(m, a)]))]));
  const per_family = Object.fromEntries(families.map(f => [f, Object.fromEntries(armsUsed.map(a => [a, sl(undefined, a, f)]))]));
  const stops = Object.fromEntries(armsUsed.map(a => [a, sl(undefined, a)]));
  const better = (xs: Array<{ arm: string; s: HardSlice }>) => xs.filter(x => x.s.success !== null).reduce<{ arm: string; s: HardSlice } | null>((b, x) => (!b || x.s.success! > b.s.success! + EPS ? x : b), null);
  const pooled = better(present.map(arm => ({ arm, s: stops[arm] })));
  const check = (id: string, label: string, k: number, n: number, threshold: string, ok: (v: number) => boolean): FreezeCheck => {
    const value = n ? k / n : null;
    return { id, label, value, k, n, ci95: wilson(k, n), threshold, pass: value !== null && ok(value) };
  };
  const inBand = ([lo, hi]: readonly [number, number]) => (v: number) => v >= lo - EPS && v <= hi + EPS;
  const checks: FreezeCheck[] = [];
  checks.push(pooled
    ? check('a', `pooled ${pooled.arm} success (${present.length > 1 ? 'the better of fs and pg' : `${present[0]} only; ${CALIBRATION_ARMS.find(x => x !== present[0])} not run`})`, pooled.s.successes, pooled.s.cells, '40-70%', inBand(FREEZE_RULE.pooled))
    : { id: 'a', label: 'pooled fs or pg success', value: null, k: 0, n: 0, ci95: [NaN, NaN], threshold: '40-70%', pass: false });
  for (const m of models) {
    const b = better(present.map(arm => ({ arm, s: per_model[m][arm] })));
    checks.push(b ? check('b', `${m}: ${present.length > 1 ? `better of fs and pg (${b.arm})` : present[0]}`, b.s.successes, b.s.cells, '20-80%', inBand(FREEZE_RULE.per_model))
      : { id: 'b', label: `${m}: better of fs and pg`, value: null, k: 0, n: 0, ci95: [NaN, NaN], threshold: '20-80%', pass: false });
  }
  for (const m of models) checks.push(check('c', `${m}: oracle`, per_model[m].oracle.successes, per_model[m].oracle.cells, 'at least 90%', v => v >= FREEZE_RULE.oracle_min - EPS));
  for (const f of families) checks.push(check('d', `family ${f}: oracle, pooled over models`, per_family[f].oracle.successes, per_family[f].oracle.cells, 'at least 80%', v => v >= FREEZE_RULE.family_oracle_min - EPS));
  const fails = pooled ? pooled.s.cells - pooled.s.successes : 0;
  const tc = pooled ? pooled.s.stops.turn_cap : 0;
  const e = check('e', `turn_cap share of pooled ${pooled?.arm ?? 'fs/pg'} failures`, tc, fails, 'at most 50%', v => v <= FREEZE_RULE.turn_cap_share_max + EPS);
  if (pooled && fails === 0) e.pass = true;
  checks.push(e);
  const grid_problems = gridProblems(cells, { models, arms: armsUsed, tasks, repeats: Math.max(0, ...attempts.map(a => a.repeat)) + 1 });
  if (incomplete.length) grid_problems.unshift(`${incomplete.length} cells have no harness-clean attempt`);
  if (!present.length) grid_problems.push('neither fs nor pg ran');
  checks.push({ id: 'grid', label: `complete grid (${models.length} models x ${armsUsed.length} arms x ${tasks.length} tasks) and one experiment`, value: null, k: 0, n: cells.length, ci95: [NaN, NaN], threshold: 'no problems', pass: grid_problems.length === 0 });
  const failed = (id: string) => checks.some(c => c.id === id && !c.pass);
  const next: string[] = [];
  const content = KNOB_PRIORITY[0];
  const order = KNOB_PRIORITY.map(g => g.group.split(' (')[0]).join(', then ');
  if (failed('c') || failed('d')) next.push('Oracle below the bar: read every oracle failure and classify it as a wording or answer-key defect before any knob change. The generator freezes only with zero unresolved answer-key defects.');
  const tooEasy = checks.some(c => (c.id === 'a' || c.id === 'b') && c.value !== null && c.value > (c.id === 'a' ? FREEZE_RULE.pooled[1] : FREEZE_RULE.per_model[1]) + EPS);
  const tooHard = checks.some(c => (c.id === 'a' || c.id === 'b') && c.value !== null && c.value < (c.id === 'a' ? FREEZE_RULE.pooled[0] : FREEZE_RULE.per_model[0]) - EPS);
  const keys = `${content.group} (${content.keys.join(', ')})`;
  if (tooEasy && tooHard) next.push(`The models straddle the band (one or more too easy, one or more too hard). A content knob moves every model the same way; adjust ${keys} in the direction of the pooled value (${pooled ? pc(pooled.s.success) : 'n/a'}) and record the spread.`);
  else if (tooEasy) next.push(`Too easy: raise ${keys} to make tasks harder. Priority order: ${order}.`);
  else if (tooHard) next.push(`Too hard: lower ${keys} to make tasks easier. Priority order: ${order}.`);
  if (failed('e')) next.push(`Difficulty comes from truncation (more than half of the pooled arm's failures are turn_cap stops): move content knobs, starting with ${content.group}, not the turn cap. The turn cap moves only last, with a dated reason in calibration.md.`);
  if (failed('grid')) next.push('Complete the grid first: resume the run (same command and --out) until every cell has a harness-clean attempt.');
  const pass = checks.every(c => c.pass);
  if (pass) next.push('Freeze rule met on these models: no knob change. Run the freeze check on the remaining frontier models with this world, or freeze the generator if this was the freeze check.');
  return { models, families, tasks: tasks.length, pooled_arm: pooled?.arm ?? null, checks, pass, per_model, per_family, stops, usd_all_attempts: attempts.reduce((s, a) => s + a.total_usd + a.judge_usd, 0), grid_problems, next };
}

const ci = (c: [number, number]) => (Number.isFinite(c[0]) ? `[${(c[0] * 100).toFixed(1)}, ${(c[1] * 100).toFixed(1)}]` : 'n/a');
const est = (s: HardSlice) => (s.cells ? `${pc(s.success)} (${s.successes}/${s.cells}) ${ci(s.ci95)}` : 'not run');

export function freezeMarkdown(r: FreezeResult, round: number): string {
  const arms = [...CALIBRATION_ARMS.filter(a => r.stops[a]), 'oracle'];
  const L = [`Freeze rule, round ${round}: ${r.pass ? 'PASS' : 'FAIL'}. Models: ${r.models.join(', ')}. Tasks: ${r.tasks}. Pooled arm: ${r.pooled_arm ?? 'none'}. Wilson 95% intervals in brackets; point estimates decide.`, ''];
  L.push('| Condition | measured | Wilson 95% | threshold | n | result |', '|---|---|---|---|---|---|');
  for (const c of r.checks) L.push(`| (${c.id}) ${c.label} | ${c.id === 'grid' ? (r.grid_problems.join('; ') || 'complete') : c.value === null ? (c.pass ? 'no failures' : 'n/a') : `${pc(c.value)} (${c.k}/${c.n})`} | ${c.id === 'grid' ? '' : ci(c.ci95)} | ${c.threshold} | ${c.n} | ${c.pass ? 'PASS' : 'FAIL'} |`);
  L.push('', '| Model | ' + arms.join(' | ') + ' |', '|---|' + arms.map(() => '---').join('|') + '|');
  for (const m of r.models) L.push(`| ${m} | ${arms.map(a => est(r.per_model[m][a])).join(' | ')} |`);
  L.push('', '| Family | ' + arms.join(' | ') + ' |', '|---|' + arms.map(() => '---').join('|') + '|');
  for (const f of r.families) L.push(`| ${f} | ${arms.map(a => est(r.per_family[f][a])).join(' | ')} |`);
  L.push('', `| Arm | ${HARD_STOP_KINDS.join(' | ')} | cost, all attempts |`, `|---|${HARD_STOP_KINDS.map(() => '---').join('|')}|---|`);
  for (const a of arms) L.push(`| ${a} | ${HARD_STOP_KINDS.map(k => r.stops[a].stops[k]).join(' | ')} | ${usd(r.stops[a].usd_all_attempts + r.stops[a].judge_usd_all_attempts)} |`);
  L.push('', `Cost of this round over every attempt (agent, embeddings, gbrain and judge): $${r.usd_all_attempts.toFixed(2)}.`, '', 'Next:', ...r.next.map(n => `- ${n}`));
  return L.join('\n');
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const valued = ['--json', '--md', '--subject', '--receipt', '--budget-ledger', '--round', '--calibration-md', '--models', '--comparator', '--expect-grid'];
  const paths = argv.filter((x, i) => !x.startsWith('--') && !valued.includes(argv[i - 1]));
  const raw = readRecords(paths);
  const models = flag('--models')?.split(',').filter(Boolean);
  if (argv.includes('--freeze-rule')) {
    const round = Number(flag('--round'));
    if (!Number.isInteger(round) || round < 0) { console.error('--freeze-rule needs --round <N> (the calibration round number; 0 for a hello or scripted check)'); process.exit(2); }
    const r = freezeRule(argv.includes('--use-rescored') ? useRescored(raw) : raw, { models });
    const md = freezeMarkdown(r, round);
    if (flag('--calibration-md')) appendFileSync(flag('--calibration-md')!, `\n### Round ${round} (analyzer output, ${new Date().toISOString().slice(0, 10)})\n\n${md}\n`);
    if (flag('--json')) writeFileSync(flag('--json')!, JSON.stringify(r, null, 2));
    console.log(md);
    process.exit(r.pass ? 0 : 1);
  }
  if (isHardInput(raw)) {
    const receipts: ReceiptLike[] = argv.flatMap((x, i) => (argv[i - 1] === '--receipt' ? [{ path: x, ...JSON.parse(readFileSync(x, 'utf8')) }] : []));
    const builds = receipts.flatMap(r => r.slot_builds ?? []);
    const h = hardAnalysis(argv.includes('--use-rescored') ? useRescored(raw) : raw, { comparator: flag('--comparator'), expectGrid: flag('--expect-grid'), models, setupUsd: builds.length ? builds.reduce((s, b) => s + (b.allowance?.usd ?? 0), 0) : null });
    let md = hardMarkdown(h);
    const warnings = lagWarnings(receipts);
    if (warnings.length) md += '\n\n' + warnings.map(w => `Warning: ${w}`).join('\n');
    if (flag('--json')) writeFileSync(flag('--json')!, JSON.stringify(h, null, 2));
    if (flag('--md')) writeFileSync(flag('--md')!, md + '\n');
    console.log(md);
    process.exit(flag('--expect-grid') !== undefined && h.grid_problems.length ? 1 : 0);
  }
  const recs = raw as unknown as CellRecord[];
  const a = analyze(recs, { subject: flag('--subject') ?? 'gbrain' });
  const receipts: ReceiptLike[] = argv.flatMap((x, i) => (argv[i - 1] === '--receipt' ? [{ path: x, ...JSON.parse(readFileSync(x, 'utf8')) }] : []));
  let md = markdown(a);
  const warnings = lagWarnings(receipts);
  if (warnings.length) md += '\n\n' + warnings.map(w => `Warning: ${w}`).join('\n');
  if (flag('--budget-ledger')) {
    const ledgerUsd: Record<string, number> = {};
    for (const id of new Set(recs.map(r => r.budget_run_id).filter((x): x is string => !!x))) {
      const run = ledgerStatus({ ledgerPath: flag('--budget-ledger')!, runId: id }).run;
      if (run) ledgerUsd[id] = run.committed_usd;
    }
    const builds: Record<string, number> = {};
    for (const r of receipts) if (r.budget_run_id) builds[r.budget_run_id] = (builds[r.budget_run_id] ?? 0) + (r.slot_builds ?? []).reduce((s, b) => s + (b.allowance?.usd ?? 0), 0);
    const rows = reconcile(recs, ledgerUsd, builds);
    md += '\n\nReconciliation against the budget ledger:\n\n' + reconciliationMarkdown(rows);
    (a as Analysis & { reconciliation?: Reconciliation[] }).reconciliation = rows;
  }
  if (flag('--json')) writeFileSync(flag('--json')!, JSON.stringify(a, null, 2));
  if (flag('--md')) writeFileSync(flag('--md')!, md + '\n');
  console.log(md);
}

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
 * Usage: bun eval/runner/cat40/analyze.ts <results.jsonl> [more.jsonl ...] [--json out.json] [--md out.md]
 *          [--subject gbrain] [--receipt receipt.json ...] [--budget-ledger <ledger>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { CellRecord } from '../cat40-model-ladder.ts';
import { CHAT_PRICE_OVERRIDES, ledgerStatus } from '../budget-ledger.ts';
import { provider } from './loop.ts';
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

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const valued = ['--json', '--md', '--subject', '--receipt', '--budget-ledger'];
  const paths = argv.filter((x, i) => !x.startsWith('--') && !valued.includes(argv[i - 1]));
  const recs = load(paths);
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

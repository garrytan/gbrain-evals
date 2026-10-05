#!/usr/bin/env bun
/**
 * Memory proof wave, dev phase: re-estimate the per-question paired variance
 * and the conversation effect from the dev pairs (gbrain and the comparator on
 * the same BEAM dev questions, same answer model, judge and delivered-context
 * target), then rerun the power simulation with them at the adopted margin.
 * No model calls.
 *
 *   bun eval/runner/memory-proof-wave-dev-power.ts --pair <gbrain-cell-dir>:<comparator-cell-dir> [--pair ...]
 *       [--margin 3] [--sims 4000] [--draws 999] [--out <json>]
 *
 * Per question d = gbrain score - comparator score (BEAM rubric means in
 * [0, 1]). The per-question variance is var(d) pooled within conversations;
 * the conversation effect is the method-of-moments SD (points) of the true
 * per-conversation mean difference: var(conversation means) minus the
 * average within-conversation variance over its question count.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DISTANCES, MARGINS, THETAS } from './memory-proof-wave-power.ts';
import type { PowerInputs } from './memory-proof-wave/harness-inputs.ts';
import { approximateMdm, poolStratum, simulate, summarize, type Design, type Scenario } from './memory-proof-wave/power.ts';

export interface PairRow { split: string; conversation: string; qid: string; d: number }

function judgeScores(dir: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of readdirSync(join(dir, 'stages/judge')).sort()) {
    const r = JSON.parse(readFileSync(join(dir, 'stages/judge', f), 'utf8'));
    out.set(r.query_id, typeof r.score === 'number' ? r.score : 0);
  }
  return out;
}

export function pairRows(gbrainDir: string, comparatorDir: string): PairRow[] {
  const cg = JSON.parse(readFileSync(join(gbrainDir, 'cell.json'), 'utf8'));
  const cc = JSON.parse(readFileSync(join(comparatorDir, 'cell.json'), 'utf8'));
  if (cg.resolved.schedule_sha256 !== cc.resolved.schedule_sha256) throw new Error(`${gbrainDir} and ${comparatorDir} have different schedules`);
  const g = judgeScores(gbrainDir), c = judgeScores(comparatorDir);
  // BEAM query ids are <conversation>_<category>_<n>; the conversation is the cluster.
  return (cg.resolved.schedule as string[]).map(qid => ({ split: cg.spec.split, conversation: `${cg.spec.split}/${qid.split('_')[0]}`, qid, d: (g.get(qid) ?? 0) - (c.get(qid) ?? 0) }));
}

export function estimate(rows: PairRow[]): { n: number; clusters: number; mean_points: number; diff_variance: number; tau_points: number; discordance: number } {
  const by = new Map<string, number[]>();
  for (const r of rows) by.set(r.conversation, [...(by.get(r.conversation) ?? []), r.d]);
  const groups = [...by.values()];
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const varOf = (xs: number[]) => { const m = mean(xs); return xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1); };
  const within = groups.reduce((s, g) => s + varOf(g) * (g.length - 1), 0) / groups.reduce((s, g) => s + g.length - 1, 0);
  const means = groups.map(mean);
  const avgN = mean(groups.map(g => g.length));
  const between = varOf(means) - within / avgN;
  return {
    n: rows.length, clusters: groups.length, mean_points: Number((100 * mean(rows.map(r => r.d))).toFixed(2)),
    diff_variance: Number(within.toFixed(5)), tau_points: Number((100 * Math.sqrt(Math.max(0, between))).toFixed(2)),
    discordance: Number((rows.filter(r => Math.abs(r.d) > 1e-9).length / rows.length).toFixed(4)),
  };
}

export const ADOPTED_DESIGN: Design = { id: 'beam-100k-500k-1m-18-18-54', label: 'Adopted: BEAM 100k + 500k + 1M by conversation, 54 sealed', strata: [{ key: 'beam/100k', sealed: 12 }, { key: 'beam/500k', sealed: 21 }, { key: 'beam/1m', sealed: 21 }] };

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const all = (n: string) => argv.flatMap((a, i) => (a === n ? [argv[i + 1]] : []));
  const flag = (n: string, d?: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const rows = all('--pair').flatMap(p => { const [g, c] = p.split(':'); return pairRows(g, c); });
  if (!rows.length) { console.error('usage: memory-proof-wave-dev-power.ts --pair <gbrain-cell>:<comparator-cell> [...]'); process.exit(2); }
  const est = estimate(rows);
  const perSplit = Object.fromEntries([...new Set(rows.map(r => r.split))].map(s => [s, estimate(rows.filter(r => r.split === s))]));
  const inputs = JSON.parse(readFileSync('docs/benchmarks/2026-10-05-memory-proof-wave-power/inputs.json', 'utf8')) as PowerInputs;
  const margin = Number(flag('--margin', '3'));
  const scenario: Scenario = { name: 'central', diff_variance: est.diff_variance, tau_points: est.tau_points, source: `dev pairs: ${est.n} questions in ${est.clusters} conversations` };
  const pools = ADOPTED_DESIGN.strata.map(s => poolStratum(inputs.datasets[s.key], s.key, s.sealed));
  const r = simulate(pools, scenario, ADOPTED_DESIGN, { sims: Number(flag('--sims', '4000')), draws: Number(flag('--draws', '999')), seed: 20261005, alpha: 0.05, distances: DISTANCES, wild: ['rademacher', 'webb'] });
  const summary = summarize(r, ADOPTED_DESIGN.label, MARGINS, THETAS, DISTANCES);
  const powerAt0 = Object.fromEntries(Object.entries(summary.methods).map(([m, v]) => [m, v.power[`margin_${margin}`]?.theta_0 ?? null]));
  const out = {
    schema: 'gbrain-evals/mpw-dev-power/v1', margin, estimate: est, per_split: perSplit, scenario,
    closed_form_mdm80: Number(approximateMdm(pools, est.diff_variance, est.tau_points).toFixed(2)),
    power_at_true_0: powerAt0,
    decision_rule: 'stop and report before anything else if power at a true difference of 0 drops below 80% at the adopted margin',
    stop: (powerAt0['wild-r-webb'] ?? powerAt0['wild-r-rademacher'] ?? powerAt0.analytic ?? 0) < 0.8,
    summary,
  };
  const path = flag('--out', 'docs/benchmarks/2026-10-05-memory-proof-wave-dev/dev-power.json')!;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify({ estimate: est, per_split: perSplit, power_at_true_0: powerAt0, closed_form_mdm80: out.closed_form_mdm80, stop: out.stop }, null, 1));
}

#!/usr/bin/env bun
/**
 * Memory proof wave, A0 step 1: free power simulation for the primary
 * non-inferiority test. No model calls.
 *
 *   bun eval/runner/memory-proof-wave-power.ts extract --harness <checkout> [--out <inputs.json>]
 *   bun eval/runner/memory-proof-wave-power.ts simulate [--inputs <inputs.json>] [--out <power.json>]
 *       [--sims 4000] [--draws 999] [--seed 20261005]
 *
 * `extract` reads the public agent-memory benchmark harness at the commit
 * pinned in eval/data/memory-proof-wave/harness.lock.json (clone it and pass
 * the checkout, or set HARNESS_DIR) and writes the per-question scores the
 * simulation uses. `simulate` needs only that committed inputs file.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sha256Hex } from './sealed-confirmation-lib.ts';
import { clusterSpread } from './memory-proof-wave/cluster-stats.ts';
import { extractInputs, loadLock, type PowerInputs } from './memory-proof-wave/harness-inputs.ts';
import { approximateMdm, GBRAIN_PAIRED_LME, pairedVariance, poolStratum, scenarios, simulate, stressScenario, summarize, type Design, type Scenario, type Summary } from './memory-proof-wave/power.ts';

export const REPORT_DIR = 'docs/benchmarks/2026-10-05-memory-proof-wave-power';
export const DEFAULT_INPUTS = `${REPORT_DIR}/inputs.json`;
export const DEFAULT_OUT = `${REPORT_DIR}/power.json`;

/** The plan's primary design first, then the alternatives the recommendation weighs, then coverage-only checks at the secondary datasets' cluster counts. */
export const DESIGNS: Array<Design & { role: 'primary' | 'alternative' | 'coverage' }> = [
  { id: 'beam-500k-1m-14-14-42', label: 'Plan: BEAM 500k + 1M, 14 dev / 14 validation / 42 sealed', role: 'primary', strata: [{ key: 'beam/500k', sealed: 21 }, { key: 'beam/1m', sealed: 21 }] },
  { id: 'beam-100k-500k-1m-18-18-54', label: 'Add BEAM 100k at the same 20/20/60 rule: 18 / 18 / 54', role: 'alternative', strata: [{ key: 'beam/100k', sealed: 12 }, { key: 'beam/500k', sealed: 21 }, { key: 'beam/1m', sealed: 21 }] },
  { id: 'beam-500k-1m-7-7-56', label: 'BEAM 500k + 1M, 7 / 7 / 56', role: 'alternative', strata: [{ key: 'beam/500k', sealed: 28 }, { key: 'beam/1m', sealed: 28 }] },
  { id: 'beam-100k-500k-1m-9-9-72', label: 'BEAM 100k + 500k + 1M, 9 / 9 / 72', role: 'alternative', strata: [{ key: 'beam/100k', sealed: 16 }, { key: 'beam/500k', sealed: 28 }, { key: 'beam/1m', sealed: 28 }] },
  { id: 'beam-500k-1m-all-70', label: 'Every BEAM 500k + 1M conversation (70; no dev or validation)', role: 'coverage', strata: [{ key: 'beam/500k', sealed: 35 }, { key: 'beam/1m', sealed: 35 }] },
  { id: 'beam-500k-21', label: 'One BEAM size, 21 sealed conversations', role: 'coverage', strata: [{ key: 'beam/500k', sealed: 21 }] },
  { id: 'personamem-32k-12', label: 'PersonaMem 32k, 12 sealed personas (secondary row)', role: 'coverage', strata: [{ key: 'personamem/32k', sealed: 12 }] },
  { id: 'lifebench-en-6', label: 'LifeBench, 6 sealed users (secondary row)', role: 'coverage', strata: [{ key: 'lifebench/en', sealed: 6 }] },
];
export const THETAS = [-2, -1, 0, 1, 2];
export const MARGINS = [2, 2.5, 3, 3.5, 4];
export const DISTANCES = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 7, 8, 10, 12];

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

export const SENSITIVITY_VARIANCES = [0.04, 0.06, 0.08, 0.1, 0.15, 0.2, 0.3];
export const SENSITIVITY_TAUS = [0, 2, 3.5, 5];

export function runSimulation(inputs: PowerInputs, o: { sims: number; draws: number; seed: number; designs?: typeof DESIGNS }): { summaries: Summary[]; scenarios: Scenario[] } {
  const base = scenarios(inputs.analogs);
  const sc = [...base, stressScenario(base.find(s => s.name === 'central')!)];
  const summaries: Summary[] = [];
  let seed = o.seed;
  for (const d of o.designs ?? DESIGNS) {
    const pools = d.strata.map(s => poolStratum(inputs.datasets[s.key], s.key, s.sealed));
    for (const scenario of sc) {
      const t0 = Date.now();
      const r = simulate(pools, scenario, d, { sims: o.sims, draws: o.draws, seed: seed++, alpha: 0.05, distances: DISTANCES, wild: ['rademacher', 'webb'] });
      summaries.push(summarize(r, d.label, MARGINS, THETAS, DISTANCES));
      if (import.meta.main) console.error(`${d.id} ${scenario.name}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
  }
  return { summaries, scenarios: sc };
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'extract') {
    const root = arg('harness', process.env.HARNESS_DIR);
    if (!root) throw new Error('extract needs --harness <checkout of HARNESS_REPO at HARNESS_COMMIT> (or HARNESS_DIR)');
    const inputs = extractInputs(root, loadLock());
    const out = arg('out', DEFAULT_INPUTS)!;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(inputs) + '\n');
    console.log(`wrote ${out}: ${Object.entries(inputs.datasets).map(([k, d]) => `${k} ${d.clusters.length} clusters`).join(', ')}; ${inputs.analogs.length} analog pairs`);
    return;
  }
  if (cmd === 'simulate') {
    const inputsPath = arg('inputs', DEFAULT_INPUTS)!;
    const raw = readFileSync(inputsPath);
    const inputs = JSON.parse(raw.toString('utf8')) as PowerInputs;
    const o = { sims: Number(arg('sims', '4000')), draws: Number(arg('draws', '999')), seed: Number(arg('seed', '20261005')) };
    const t0 = Date.now();
    const { summaries, scenarios: sc } = runSimulation(inputs, o);
    const out = arg('out', DEFAULT_OUT)!;
    writeJson(out, {
      schema: 'gbrain-evals/mpw-power/v1',
      inputs: { path: inputsPath, sha256: sha256Hex(raw), harness_commit: inputs.harness.commit },
      options: { ...o, alpha: 0.05, margins: MARGINS, thetas: THETAS, distances: DISTANCES, sensitivity_variances: SENSITIVITY_VARIANCES, sensitivity_taus: SENSITIVITY_TAUS },
      runtime_seconds: Math.round((Date.now() - t0) / 1000),
      sensitivity: DESIGNS.filter(d => d.role !== 'coverage').map(d => {
        const pools = d.strata.map(s => poolStratum(inputs.datasets[s.key], s.key, s.sealed));
        return {
          design: d.id,
          independent_systems_variance: Object.fromEntries(pools.map(p => [p.key, Number(p.m2.toFixed(5))])),
          mdm80_closed_form: SENSITIVITY_VARIANCES.flatMap(v => SENSITIVITY_TAUS.map(t => ({ diff_variance: v, tau_points: t, mdm80: Number(approximateMdm(pools, v, t).toFixed(2)) }))),
        };
      }),
      clusters: Object.fromEntries(Object.entries(inputs.datasets).map(([k, d]) => [k, { grouping: d.grouping, metric: d.metric, mode: d.mode, answer_llm: d.answer_llm, judge_llm: d.judge_llm, ...clusterSpread(d.clusters) }])),
      gbrain_paired_anchors: GBRAIN_PAIRED_LME.map(a => ({ ...a, discordance: Number(((a.plus + a.minus) / a.n).toFixed(4)), diff_variance: Number(pairedVariance(a.n, a.plus, a.minus).toFixed(5)) })),
      cross_system_analogs: inputs.analogs.map(a => ({ dataset: a.dataset, a: a.a, b: a.b, n: a.n, a_correct: a.a_correct, b_correct: a.b_correct, a_only: a.a_only, b_only: a.b_only, clusters: a.clusters, tau_points: a.tau_points, diff_variance: Number(pairedVariance(a.n, a.a_only, a.b_only).toFixed(5)) })),
      scenarios: sc,
      designs: DESIGNS.map(d => ({ id: d.id, label: d.label, role: d.role, strata: d.strata })),
      results: summaries,
    });
    console.log(`wrote ${out} in ${Math.round((Date.now() - t0) / 1000)}s`);
    return;
  }
  console.error('usage: memory-proof-wave-power.ts extract --harness <dir> | simulate [--sims N --draws B --seed S]');
  process.exit(2);
}

if (import.meta.main) await main();

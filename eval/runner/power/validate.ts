/**
 * PW validation run: simulated coverage and false-positive rates for the
 * clustered paired failure-risk ratio (risk-ratio.ts) and the within-persona
 * size contrast (size-contrast.ts), the interval method the frozen rule
 * selects, and the detectable factor and contrast for candidate designs.
 * No model call, no data: every number comes from the frozen data-generating
 * assumptions in those two modules.
 *
 *   bun eval/runner/power/validate.ts [--output <power.json>] [--sims N] [--seed N]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chooseMethod, METHODS, SCENARIOS, simulate, type Design, type Scenario, type SimSummary } from './risk-ratio.ts';
import { minimumDetectableContrast, simulateSize, SIZE_SCENARIOS, SLOPE_TOLERANCE_POINTS, type SizeDesign } from './size-contrast.ts';

export const PW_VERSION = 'pw-v1';
/** The T0 development baseline design: 8 dev personas x 4 tasks x 3 counted readers x 2 repeats. */
export const T0_DEV_DESIGN: Design = { personas: 8, tasks: 4, readers: 3, repeats: 2 };
export const DEFAULT_OUTPUT = 'docs/benchmarks/2026-10-08-program-primary/power.json';

export interface PowerReport {
  version: typeof PW_VERSION;
  sims: number;
  seed: number;
  risk_ratio: {
    validation_design: Design;
    validation: SimSummary[];
    method: ReturnType<typeof chooseMethod>;
    /** Power tables under the chosen method: share of runs reaching each verdict, by design, baseline rate and true factor. */
    detectable: Array<{ design: Design; base_rate: number; true_factor: number | 'infinite'; p_10x: number; p_improvement: number; p20_factor_lower_bound: number }>;
  };
  size_contrast: {
    validation: ReturnType<typeof simulateSize>[];
    mdd: Array<{ scenario: string; design: SizeDesign; mdd_points: number | null; descriptive_only: boolean }>;
  };
}

export function runValidation(sims: number, seed: number): PowerReport {
  const validation: SimSummary[] = [];
  for (const s of SCENARIOS) for (const m of METHODS) validation.push(simulate(s, T0_DEV_DESIGN, m, { sims, seed, draws: 999 }));
  const method = chooseMethod(validation);
  const central = SCENARIOS.find(s => s.name === 'null-central')!;
  const detectable: PowerReport['risk_ratio']['detectable'] = [];
  const designs: Design[] = [T0_DEV_DESIGN, { personas: 8, tasks: 4, readers: 3, repeats: 1 }, { personas: 16, tasks: 4, readers: 3, repeats: 2 }, { personas: 24, tasks: 4, readers: 3, repeats: 2 }, { personas: 32, tasks: 4, readers: 3, repeats: 2 }];
  for (const d of designs) for (const base_rate of [0.1, 0.2, 0.3, 0.5]) for (const f of [5, 10, 20, Infinity]) {
    const s: Scenario = { ...central, name: `power-${base_rate}-${f}`, base_rate, ratio: f === Infinity ? 0 : 1 / f };
    const r = simulate(s, d, method.method, { sims: Math.max(200, Math.floor(sims / 2)), seed: seed + 1, draws: 999 });
    detectable.push({ design: d, base_rate, true_factor: f === Infinity ? 'infinite' : f, p_10x: r.verdicts['10x'], p_improvement: r.verdicts['10x'] + r.verdicts.improvement, p20_factor_lower_bound: r.p20_factor_lower_bound });
  }
  const sizeValidation: ReturnType<typeof simulateSize>[] = [];
  const mdd: PowerReport['size_contrast']['mdd'] = [];
  const sizeDesigns: SizeDesign[] = [{ personas: 5, questions: 50, readers: 3, missing: 0 }, { personas: 8, questions: 50, readers: 3, missing: 0 }, { personas: 10, questions: 100, readers: 3, missing: 2 }, { personas: 10, questions: 100, readers: 3, missing: 0 }];
  for (const s of SIZE_SCENARIOS) for (const d of [sizeDesigns[1], sizeDesigns[2]]) sizeValidation.push(simulateSize(s, d, 0, { sims, seed }), simulateSize(s, d, 0.3, { sims, seed: seed + 2 }));
  for (const s of SIZE_SCENARIOS) for (const d of sizeDesigns) {
    const m = minimumDetectableContrast(s, d, { sims: Math.max(200, Math.floor(sims / 2)), seed: seed + 3 });
    mdd.push({ scenario: s.name, design: d, mdd_points: m.mdd_points, descriptive_only: m.mdd_points === null || m.mdd_points > SLOPE_TOLERANCE_POINTS });
  }
  return { version: PW_VERSION, sims, seed, risk_ratio: { validation_design: T0_DEV_DESIGN, validation, method, detectable }, size_contrast: { validation: sizeValidation, mdd } };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const out = resolve(flag('--output') ?? DEFAULT_OUTPUT);
  const report = runValidation(Number(flag('--sims') ?? 2000), Number(flag('--seed') ?? 20261008));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 1) + '\n');
  const v = report.risk_ratio;
  console.log(`method: ${v.method.method} (qualified: ${v.method.qualified.join(', ') || 'none'}; min coverage ${JSON.stringify(v.method.min_coverage)})`);
  for (const r of v.validation.filter(x => x.method === v.method.method)) console.log(`${r.scenario.padEnd(24)} coverage ${r.coverage === null ? '  n/a' : r.coverage.toFixed(3)}  10x ${r.verdicts['10x'].toFixed(3)}  improvement ${r.verdicts.improvement.toFixed(3)}  worse ${r.verdicts.worse.toFixed(3)}`);
  console.log(`wrote ${out}`);
}

/**
 * The preregistered sample-size rule: the smallest persona count (4 tasks, 3 readers, 2 repeats) at which a
 * candidate with true factor `factor` reaches `10x` with probability >= `power` at baseline failure rate
 * `baseRate`, searched up to `maxPersonas`; null when none does.
 */
export function personasForTenfold(baseRate: number, opts: { factor?: number; power?: number; maxPersonas?: number; sims?: number; seed?: number } = {}): { personas: number | null; curve: Array<{ personas: number; p_10x: number }> } {
  const central = SCENARIOS.find(s => s.name === 'null-central')!;
  const s: Scenario = { ...central, name: `sample-size-${baseRate}`, base_rate: baseRate, ratio: 1 / (opts.factor ?? 20) };
  const curve: Array<{ personas: number; p_10x: number }> = [];
  for (let k = 8; k <= (opts.maxPersonas ?? 128); k += 8) {
    const r = simulate(s, { personas: k, tasks: 4, readers: 3, repeats: 2 }, 'cond-binomial', { sims: opts.sims ?? 1000, seed: opts.seed ?? 20261008 });
    curve.push({ personas: k, p_10x: r.verdicts['10x'] });
    if (r.verdicts['10x'] >= (opts.power ?? 0.8)) return { personas: k, curve };
  }
  return { personas: null, curve };
}

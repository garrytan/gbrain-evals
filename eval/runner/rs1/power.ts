/**
 * RS1 power (GST-1154; plan v2 "Big decisions" 1 and 5, the preregistration's "Power"): the smallest true gap each
 * confirmatory family detects with 80% power at 75 and 200 conversations, from paired variance measured on earlier
 * BEAM runs, and a simulation check of that figure with the test the analysis runs.
 *
 *   bun eval/runner/rs1/power.ts [--family servers|whole|both] [--sims 1000] [--draws 999] [--out-dir eval/runner/rs1]
 *
 * writes power-servers.json (family A: gbrain-defaults' 8k read minus each of ext-extract-first, ext-memory-bank and
 * ext-temporal-graph, 3 comparisons) and power-whole.json (family B: gbrain-defaults' think loop minus
 * baseline-file-agent, 1 comparison). Regenerate both with the bare command: 1,000 simulations of 999 draws per
 * scenario, as plan v2 states. The committed files are that command's output byte for byte (about a minute on a
 * 4-core machine); test/eval/rs1-power-pricing.test.ts regenerates the analytic block and a small seeded simulation,
 * never the full one.
 *
 * Analytic block (ported unchanged from GBEV-31's draft, handoffs/GBEV-31/rs1-power.ts): a scenario's per-question SD
 * sd20 at 20 questions splits into a between-conversation part tau and a within part that shrinks with questions per
 * conversation q; the conversation-level SD is sqrt(tau^2 + (sd20^2 - tau^2) * 20 / q). The detectable difference at
 * 80% power is (t(1 - alpha / 2m) + t(0.8)) * sd / sqrt(n) on n - 1 degrees of freedom: the critical value is the
 * Bonferroni level, which is also Holm's first step, so holm_half_width is the decisive interval's half-width.
 * level_margin80 uses t(0.9) in place of t(0.8): the margin M at which "level" has 80% power when the true gap is 0.
 *
 * Simulation check: per scenario and size, conversations draw a shared effect u ~ N(0, tau) and q question
 * differences ~ N(0, sw); the first comparison carries the analytic detectable difference and the others none. Each
 * comparison's two-sided p-value is the restricted wild cluster bootstrap-t's (eval/runner/stats/wild-cluster.ts, Webb
 * weights). Two rules are reported (review F25): the decisive one, Bonferroni (m x p <= 0.05, the p-value form of the
 * 98.33% interval excluding 0 in family A and the 95% interval in family B), and Holm, the secondary p-values. Power
 * is the share of simulations that detect the true gap; family-wise error is the share where any comparison is
 * detected when every true gap is 0. Under that global null the two rules reject together (both first reject at
 * min p <= alpha / m), so their family-wise error rates agree, and Holm's power is at least Bonferroni's. With one
 * comparison the rules coincide.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { prepare, wildRestrictedP, type ClusterRow } from '../stats/wild-cluster.ts';

export const POWER_SCHEMA = 'gbrain-evals/rs1-power/v1';
const ROOT = resolve(import.meta.dir, '../../..');
export const RS1_DIR = import.meta.dir;
export const POWER_FILES = { servers: 'power-servers.json', whole: 'power-whole.json' } as const;
export type Family = keyof typeof POWER_FILES;
/** Plan v2's simulation size. */
export const FULL_SIMULATION = { sims: 1000, draws: 999 };

function lgamma(x: number): number {
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1; let a = c[0]; const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function betacf(a: number, b: number, x: number): number {
  const qab = a + b, qap = a + 1, qam = a - 1; let c = 1, d = 1 - qab * x / qap; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d; let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m; let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30; c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30; d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30; c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30; d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return h;
}
function ibeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}
const tcdf = (t: number, df: number) => { const x = df / (df + t * t); const p = 0.5 * ibeta(df / 2, 0.5, x); return t > 0 ? 1 - p : p; };
function tq(p: number, df: number): number { let lo = -50, hi = 50; for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (tcdf(m, df) < p) lo = m; else hi = m; } return (lo + hi) / 2; }

export const ALPHA = 0.05, POWER = 0.8;
/** Between-conversation SD of the paired gap, in points (the dev pairs' tau); 5 is the sensitivity value. */
export const TAU = 2.28;
export const SCENARIOS = [
  { name: 'optimistic', sd20: 6.87, source: 'wave 2: 72 public BEAM conversations, gbrain vs memory-bank, one-sided 95% bounds +2.63 and +5.33 (ni-stats.ts:13), SE 1.35/t(0.95,71)=0.81' },
  { name: 'central', sd20: 7.72, source: 'wave 1 sealed: 54 BEAM conversations, gbrain vs memory-bank, SE 1.05 points' },
  { name: 'pessimistic', sd20: 9.14, source: 'dev pairs: docs/benchmarks/2026-10-05-memory-proof-wave-dev/power/two-sample-505a.json estimate: diff_variance 0.15653, tau 2.28 points (18 conversations, 360 questions)' },
  { name: 'file-agent', sd20: 10.6, source: 'Q1 Family F2: gbrain whole-default vs file agent, 10 conversations, 95% interval -17.2 to -2.1 (half-width 7.55 at t(0.975,9))' },
];
export const FAMILIES: Record<Family, { comparisons: number; subject: string; comparators: string[]; scenarios: string[] }> = {
  servers: { comparisons: 3, subject: 'gbrain-defaults (8k read, arm P)', comparators: ['ext-extract-first', 'ext-memory-bank', 'ext-temporal-graph'], scenarios: ['optimistic', 'central', 'pessimistic'] },
  whole: { comparisons: 1, subject: 'gbrain-defaults (whole-system think)', comparators: ['baseline-file-agent'], scenarios: ['file-agent'] },
};
const SIZES = [21, 25, 30, 35, 40, 50, 60, 75, 100, 125, 150, 200];
/** Simulated designs: N and O, 20 questions per conversation. */
export const SIM_DESIGNS: ReadonlyArray<readonly [number, number]> = [[75, 20], [200, 20]];

const sdq = (sd20: number, q: number, tau = TAU) => Math.sqrt(tau * tau + (sd20 * sd20 - tau * tau) * 20 / q);
const mdd = (sd: number, n: number, m: number) => (tq(1 - ALPHA / (2 * m), n - 1) + tq(POWER, n - 1)) * sd / Math.sqrt(n);
const level = (sd: number, n: number, m: number) => (tq(1 - ALPHA / (2 * m), n - 1) + tq(0.9, n - 1)) * sd / Math.sqrt(n);
const halfw = (sd: number, n: number, m: number) => tq(1 - ALPHA / (2 * m), n - 1) * sd / Math.sqrt(n);

/** The analytic detectable differences, and the sizes each scenario needs for 5, 3 and 2 points (the draft's blocks, unchanged). */
export function analyticBlock(family: Family) {
  const M = FAMILIES[family].comparisons;
  const analytic: any[] = [];
  for (const s of SCENARIOS) for (const q of [20, 40]) for (const tau of [TAU, 5]) {
    if (s.sd20 < tau) continue;
    const sd = sdq(s.sd20, q, tau);
    analytic.push({ scenario: s.name, questions_per_conversation: q, tau_points: tau, sd_conversation_points: +sd.toFixed(2),
      rows: SIZES.map(n => ({ n, mdd80: +mdd(sd, n, M).toFixed(2), level_margin80: +level(sd, n, M).toFixed(2), holm_half_width: +halfw(sd, n, M).toFixed(2), mdd80_single: +mdd(sd, n, 1).toFixed(2) })) });
  }
  const needFor = (target: number, sd: number) => { for (let n = 21; n <= 2000; n++) if (mdd(sd, n, M) <= target) return n; return null; };
  const needed = SCENARIOS.flatMap(s => [20, 40].map(q => ({ scenario: s.name, q, n_for_5: needFor(5, sdq(s.sd20, q)), n_for_3: needFor(3, sdq(s.sd20, q)), n_for_2: needFor(2, sdq(s.sd20, q)) })));
  return { analytic, needed };
}

function rng(seed: number) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function normal(r: () => number) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function holm(ps: number[]) { const o = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]); const out = new Array(ps.length).fill(1); let run = 0; o.forEach(([p, i], k) => { run = Math.max(run, Math.min(1, (ps.length - k) * p)); out[i] = run; }); return out; }
const bonferroni = (ps: number[]) => ps.map(p => Math.min(1, ps.length * p));

/**
 * One scenario and size: sims simulated runs, each comparison tested with draws bootstrap draws. The data stream and
 * every bootstrap seed are the draft's, so its Holm figures reproduce, and the first k runs of a longer simulation are
 * the runs of a k-run one.
 */
export function simulateCheck(family: Family, scenario: string, n: number, q: number, o: { sims: number; draws: number }) {
  const M = FAMILIES[family].comparisons;
  const s = SCENARIOS.find(x => x.name === scenario)!;
  const sd = sdq(s.sd20, q), sw = Math.sqrt((sd * sd - TAU * TAU) * q) / 100;
  const target = mdd(sd, n, M) / 100;
  const r = rng(20261103 + n * 7 + q);
  let holmDetect = 0, holmFalse = 0, bonfDetect = 0, bonfFalse = 0;
  for (let k = 0; k < o.sims; k++) {
    const ps: number[] = [], p0: number[] = [];
    for (let j = 0; j < M; j++) {
      const rows1: ClusterRow[] = [], rows0: ClusterRow[] = [];
      for (let c = 0; c < n; c++) {
        const u = normal(r) * TAU / 100; let s1 = 0, s0 = 0;
        for (let i = 0; i < q; i++) { const e = normal(r) * sw; s1 += (j === 0 ? target : 0) + u + e; s0 += u + e; }
        rows1.push({ id: 'c' + c, stratum: 's', n: q, sum: s1 }); rows0.push({ id: 'c' + c, stratum: 's', n: q, sum: s0 });
      }
      ps.push(wildRestrictedP(prepare(rows1), [0], { draws: o.draws, seed: k * 101 + j, weights: 'webb', alternative: 'two-sided' })[0]);
      p0.push(wildRestrictedP(prepare(rows0), [0], { draws: o.draws, seed: k * 103 + j, weights: 'webb', alternative: 'two-sided' })[0]);
    }
    if (holm(ps)[0] <= ALPHA) holmDetect++;
    if (holm(p0).some(x => x <= ALPHA)) holmFalse++;
    if (bonferroni(ps)[0] <= ALPHA) bonfDetect++;
    if (bonferroni(p0).some(x => x <= ALPHA)) bonfFalse++;
  }
  const share = (x: number) => +(x / o.sims).toFixed(3);
  return {
    n, q, scenario: s.name, analytic_mdd80: +(target * 100).toFixed(2), sims: o.sims, draws: o.draws,
    bonferroni: { simulated_power_at_mdd: share(bonfDetect), simulated_fwer_at_zero: share(bonfFalse) },
    holm: { simulated_power_at_mdd: share(holmDetect), simulated_fwer_at_zero: share(holmFalse) },
  };
}

export function powerReport(family: Family, o: { sims: number; draws: number } = FULL_SIMULATION) {
  const f = FAMILIES[family];
  return {
    schema: POWER_SCHEMA, family, subject: f.subject, comparators: f.comparators, alpha: ALPHA, comparisons: f.comparisons, power: POWER, tau_points: TAU,
    decisive_rule: f.comparisons === 1 ? 'p <= 0.05 (the 95% interval excludes 0)' : `Bonferroni: ${f.comparisons} x p <= 0.05 (the ${(100 * (1 - ALPHA / f.comparisons)).toFixed(2)}% interval excludes 0)`,
    secondary_rule: 'Holm over the family',
    command: `bun eval/runner/rs1/power.ts --family ${family} --sims ${o.sims} --draws ${o.draws}`,
    scenarios: SCENARIOS,
    ...analyticBlock(family),
    simulation_checks: f.scenarios.flatMap(scenario => SIM_DESIGNS.map(([n, q]) => simulateCheck(family, scenario, n, q, o))),
  };
}

/** The committed file's bytes for a family at a simulation size. */
export const powerText = (family: Family, o: { sims: number; draws: number } = FULL_SIMULATION) => JSON.stringify(powerReport(family, o), null, 1) + '\n';

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const int = (name: string, fallback: number) => { const raw = flag(name); const v = raw === undefined ? fallback : Number(raw); if (!Number.isSafeInteger(v) || v < 1) { console.error(`${name} must be a positive integer, got ${raw}`); process.exit(2); } return v; };
  const which = flag('--family') ?? 'both';
  if (which !== 'servers' && which !== 'whole' && which !== 'both') { console.error(`--family takes servers, whole or both, not ${which}`); process.exit(2); }
  const o = { sims: int('--sims', FULL_SIMULATION.sims), draws: int('--draws', FULL_SIMULATION.draws) };
  const outDir = resolve(flag('--out-dir') ?? RS1_DIR);
  mkdirSync(outDir, { recursive: true });
  for (const family of (which === 'both' ? ['servers', 'whole'] : [which]) as Family[]) {
    const text = powerText(family, o);
    const path = join(outDir, POWER_FILES[family]);
    writeFileSync(path, text);
    for (const c of JSON.parse(text).simulation_checks) console.log(`${family} ${c.scenario} n=${c.n} q=${c.q} mdd80 ${c.analytic_mdd80}: power bonferroni ${c.bonferroni.simulated_power_at_mdd}, holm ${c.holm.simulated_power_at_mdd}; fwer ${c.bonferroni.simulated_fwer_at_zero}`);
    console.log(`wrote ${relative(ROOT, path) || path} (${o.sims} simulations, ${o.draws} draws)`);
  }
}

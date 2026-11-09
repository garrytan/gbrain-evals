/**
 * BG1's power model (preregistration docs/benchmarks/2026-11-09-changing-facts-battleground-preregistration.md, "Test
 * and size" and "Internal pilot"; GBEV-58's plan_numbers.py in TypeScript). Every MDD comes from rule.ts's mdd, the same
 * t distribution and Holm step verdict.ts decides with.
 *
 *   Plan table: a world's SD of a difference is sqrt(tau^2 + sigma^2 / k), with sigma the per-question SD of a
 *     difference, tau the between-world SD and k the questions in the family (40 primary, 24 time-indexed); the
 *     scenarios are the plan's optimistic (43, 2), central (47, 3) and pessimistic (54, 4). The MDD at N is reported at
 *     the strictest Holm step (alpha 0.05 / 3) and unadjusted (alpha 0.05, the design control's single comparison), at
 *     80% power, with the N each scenario needs for an MDD of 5 points at the strict step.
 *   Pilot: wave A (the first 12 kept worlds) gives the per-world SDs of the three primary differences under the gating
 *     view (verdict.ts --mode pilot, which emits no means). N_required is the largest over the three of the smallest N
 *     whose strict-step MDD is at most 5; N_final = min(40, max(30, N_required)). Above 40 the result pauses for GBEV-3
 *     with the MDD reachable at 40.
 *
 *   bun eval/runner/bg1/power.ts [--pilot <pilot.json>] [--out <file>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { BG1_N_CAP, BG1_N_FLOOR } from './types.ts';
import { BG1_ALPHA, BG1_COMPARATORS, BG1_MARGIN_POINTS, BG1_STRICT_ALPHA, BG1_TARGET_POWER, mdd, nRequired } from './rule.ts';

export const PLAN_SCENARIOS = { optimistic: { sigma: 43, tau: 2 }, central: { sigma: 47, tau: 3 }, pessimistic: { sigma: 54, tau: 4 } } as const;
export const FAMILY_QUESTIONS = { primary: 40, secondary: 24 } as const;
export const PLAN_NS = [12, 20, 24, 30, 36, 40] as const;

export const sdWorld = (sigma: number, tau: number, k: number) => Math.sqrt(tau ** 2 + sigma ** 2 / k);
const r2 = (x: number) => Math.round(x * 100) / 100;

export interface PlanRow { family: keyof typeof FAMILY_QUESTIONS; scenario: keyof typeof PLAN_SCENARIOS; sd: number; mdd_holm: Record<number, number>; mdd_unadjusted: Record<number, number>; n_required: number }

export function planTable(): PlanRow[] {
  return (Object.keys(FAMILY_QUESTIONS) as Array<keyof typeof FAMILY_QUESTIONS>).flatMap(family => (Object.keys(PLAN_SCENARIOS) as Array<keyof typeof PLAN_SCENARIOS>).map(scenario => {
    const { sigma, tau } = PLAN_SCENARIOS[scenario];
    const sd = sdWorld(sigma, tau, FAMILY_QUESTIONS[family]);
    return { family, scenario, sd: r2(sd), mdd_holm: Object.fromEntries(PLAN_NS.map(n => [n, r2(mdd(sd, n, BG1_STRICT_ALPHA))])),
      mdd_unadjusted: Object.fromEntries(PLAN_NS.map(n => [n, r2(mdd(sd, n, BG1_ALPHA))])), n_required: nRequired(sd) };
  }));
}

/** What verdict.ts --mode pilot writes: SDs and correlations of the primary differences, never a mean. */
export interface Bg1Pilot {
  schema: 'gbrain-evals/bg1-pilot/v1';
  worlds: number;
  view: 'gating';
  family: 'primary';
  sds: Record<string, number>;
  correlations: Record<string, number | null>;
}

export interface PilotSizing {
  sds: Record<string, number>;
  n_required: Record<string, number>;
  n_required_max: number;
  n_final: number;
  /** N_required above the cap: the run pauses for GBEV-3, with the strict-step MDD each difference reaches at the cap. */
  pause: boolean;
  mdd_at_cap: Record<string, number>;
}

export function sizeFromPilot(p: Pick<Bg1Pilot, 'sds'>): PilotSizing {
  const missing = BG1_COMPARATORS.filter(c => !(p.sds[c] > 0));
  if (missing.length) throw new Error(`the pilot has no positive SD for ${missing.join(', ')}; N_final is the largest N_required over all three differences`);
  const sds = Object.fromEntries(BG1_COMPARATORS.map(c => [c, p.sds[c]]));
  const req = Object.fromEntries(BG1_COMPARATORS.map(c => [c, nRequired(sds[c], BG1_MARGIN_POINTS, BG1_STRICT_ALPHA, BG1_TARGET_POWER)]));
  const max = Math.max(...Object.values(req));
  return { sds, n_required: req, n_required_max: max, n_final: Math.min(BG1_N_CAP, Math.max(BG1_N_FLOOR, max)), pause: max > BG1_N_CAP,
    mdd_at_cap: Object.fromEntries(BG1_COMPARATORS.map(c => [c, r2(mdd(sds[c], BG1_N_CAP, BG1_STRICT_ALPHA))])) };
}

export function readPilot(path: string): Bg1Pilot {
  const p = JSON.parse(readFileSync(path, 'utf8')) as Bg1Pilot;
  if (p.schema !== 'gbrain-evals/bg1-pilot/v1') throw new Error(`${path} is not a BG1 pilot file (schema ${String(p.schema)})`);
  return p;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const pilot = one('--pilot');
  const out = { plan: planTable(), ...(pilot ? { pilot: sizeFromPilot(readPilot(pilot)) } : {}) };
  const text = JSON.stringify(out, null, 2) + '\n';
  if (one('--out')) writeFileSync(one('--out')!, text); else process.stdout.write(text);
  if (out.pilot?.pause) { process.stderr.write(`N_required ${out.pilot.n_required_max} is above the cap of ${BG1_N_CAP}: pause and bring the MDD at ${BG1_N_CAP} to GBEV-3\n`); process.exit(3); }
}

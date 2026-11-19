/**
 * The BG1-C preregistration's "Power" section and Amendment 2's "What the look costs", rerun through the rule itself
 * (docs/benchmarks/2026-11-19-changing-facts-confirmation-preregistration.md). eval/runner/bg1/confirm-power-sim.py
 * produced both sets of numbers (numpy default_rng, seed 20261119, 200,000 runs per scenario): with --one-look the Power
 * section's, drawing each comparison's mean and SD from their sampling distributions, and by default the two-look
 * figures, drawing 40 per-world normal differences. This test draws 40 normal per-world differences per comparison from
 * a seeded mulberry32 generator with the same seed (risk-ratio.ts rng), so its draws differ from numpy's but its
 * distribution is the same. Each run is read twice from the same draws: as frozen, by decideFamily (rule.ts) and the
 * 3-point readings; and as amended, by confirm.ts's own confirmLook on the first 20 worlds and, unless the look stops,
 * its confirmFinal on all 40, the functions verdict.ts confirm calls. It checks every simulated number either source
 * publishes within this Monte Carlo tolerance:
 *
 *   |p_test - p_published| <= 4 sqrt(p (1 - p) / RUNS) + 4 sqrt(p (1 - p) / 200,000) + half a unit of rounding
 *
 * that is, four standard errors of this test's estimate and four of the script's, plus half a unit of the published
 * rounding (0.005 for the Power table's two decimals and whole percents, 0.0005 for the script's three decimals), with p
 * clamped to [0.005, 0.995] inside the standard errors so a published 1.00 or 0.000 still allows its rounding. At
 * RUNS = 4,000 per scenario the widest tolerance is 0.041, at p = 0.5. The MDD columns come from rule.ts's mdd and are
 * checked exactly. Keyless and offline.
 */
import { describe, expect, test } from 'bun:test';
import { CONFIRM_BOUND_ALPHA, CONFIRM_COMPARISONS, CONFIRM_LOOK_N, CONFIRM_MARGIN_POINTS, confirmFinal, confirmLook, confirmRow, threePoint, type ConfirmRowNumber, type ConfirmWord } from '../../eval/runner/bg1/confirm.ts';
import { decideFamily, mdd, pairedT } from '../../eval/runner/bg1/rule.ts';
import { rng } from '../../eval/runner/power/risk-ratio.ts';

const SEED = 20261119;
const N = 40;
const RUNS = 4000;
const SCRIPT_RUNS = 200_000;
const DEV = [2.6, 1.1, 1.5, 1.5];
const SDS = { central: [3.49, 4.83, 5.11, 4.33], pessimistic: [5.15, 5.59, 7.13, 7.42] } as const;
type Scenario = keyof typeof SDS;

const tolerance = (p: number, half: number) => {
  const q = Math.min(0.995, Math.max(0.005, p));
  return 4 * Math.sqrt(q * (1 - q) / RUNS) + 4 * Math.sqrt(q * (1 - q) / SCRIPT_RUNS) + half;
};

type Rows = Record<ConfirmRowNumber, number>;
interface Reading { ahead: number[]; notBehind: number[]; rows: Rows; anyBehind: number }
interface Sim { frozen: Reading & { level: number[] }; amended: Reading & { stop: number; stopCrossed: number } }

/** RUNS runs of one scenario: each comparison's 40 world differences drawn N(effect, sd), read as frozen and as amended. */
function simulate(r: ReturnType<typeof rng>, effects: readonly number[], sds: readonly number[]): Sim {
  const zero = () => [0, 0, 0, 0];
  const rows = (): Rows => ({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 });
  const f = { ahead: zero(), notBehind: zero(), level: zero(), rows: rows(), anyBehind: 0 };
  const a = { ahead: zero(), notBehind: zero(), rows: rows(), anyBehind: 0, stop: 0, stopCrossed: 0 };
  const tally = (t: Reading, words: readonly ConfirmWord[]) => {
    words.forEach((w, i) => { if (w === 'ahead') t.ahead[i]++; });
    if (words.includes('behind')) t.anyBehind++;
    t.rows[confirmRow(CONFIRM_COMPARISONS.map((c, i) => ({ key: c.key, word: words[i], descriptive: null })))]++;
  };
  for (let run = 0; run < RUNS; run++) {
    const x = CONFIRM_COMPARISONS.map((_, i) => Array.from({ length: N }, () => effects[i] + sds[i] * r.normal()));
    const tests = decideFamily(Object.fromEntries(CONFIRM_COMPARISONS.map((c, i) => [c.key, x[i]])));
    tally(f, tests.map(t => (t.verdict === 'no measurable difference' ? threePoint(t.bonferroni) : t.verdict)));
    tests.forEach((t, i) => {
      if (t.bonferroni.lower > -CONFIRM_MARGIN_POINTS) f.notBehind[i]++;
      if (t.bonferroni.lower > -CONFIRM_MARGIN_POINTS && t.bonferroni.upper < CONFIRM_MARGIN_POINTS) f.level[i]++;
    });
    const look = confirmLook(CONFIRM_COMPARISONS.map((c, i) => ({ key: c.key, test: pairedT(x[i].slice(0, CONFIRM_LOOK_N)) })));
    if (look.stop) {
      a.stop++;
      if (look.comparisons.every(c => c.status === 'crossed')) a.stopCrossed++;
      tally(a, look.comparisons.map(c => c.word));
      continue;
    }
    const final = confirmFinal(CONFIRM_COMPARISONS.map((c, i) => ({ key: c.key, test: tests[i] })));
    tally(a, final.map(c => c.word));
    final.forEach((c, i) => { if (c.lower > -CONFIRM_MARGIN_POINTS) a.notBehind[i]++; });
  }
  const share = (xs: number[]) => xs.map(v => v / RUNS);
  const shares = (rs: Rows) => Object.fromEntries(Object.entries(rs).map(([k, v]) => [k, v / RUNS])) as Rows;
  return {
    frozen: { ahead: share(f.ahead), notBehind: share(f.notBehind), level: share(f.level), rows: shares(f.rows), anyBehind: f.anyBehind / RUNS },
    amended: { ahead: share(a.ahead), notBehind: share(a.notBehind), rows: shares(a.rows), anyBehind: a.anyBehind / RUNS, stop: a.stop / RUNS, stopCrossed: a.stopCrossed / RUNS },
  };
}

describe('the Power section and the look\'s cost, rerun through decideFamily and confirm.ts', () => {
  test('the MDD columns are rule.ts mdd at the strictest Holm step (0.05 / 4) with 80% power', () => {
    const published: Record<Scenario, Record<number, number[]>> = {
      central: { 30: [2.05, 2.84, 3.00, 2.54], 40: [1.76, 2.43, 2.57, 2.18], 48: [1.59, 2.21, 2.33, 1.98] },
      pessimistic: { 30: [3.03, 3.28, 4.19, 4.36], 40: [2.59, 2.81, 3.59, 3.73], 48: [2.35, 2.55, 3.26, 3.39] },
    };
    expect(CONFIRM_BOUND_ALPHA).toBe(0.0125);
    for (const s of Object.keys(SDS) as Scenario[]) for (const n of [30, 40, 48]) expect(SDS[s].map(sd => Math.round(mdd(sd, n, CONFIRM_BOUND_ALPHA) * 100) / 100)).toEqual(published[s][n]);
  });

  // Value: protects=the Power table and Amendment 2's figures are what the frozen rule and confirm.ts's own look and final produce, from the published seed; fails_when=the bounds, the step-down, futility, the stop rule or the final rule drift from what the script simulated, or the frozen rule's numbers stop holding; why_new=BG1-C harness item 3 and Amendments 1 and 2; seam=decideFamily, confirmLook, confirmFinal, confirmRow; no_claim=the true effects
  test('power, each reading and each outcome row, with one look as frozen and with the look as amended, from seed 20261119, within the stated tolerance', () => {
    const r = rng(SEED);
    const sim = { central: { dev: simulate(r, DEV, SDS.central), zero: simulate(r, [0, 0, 0, 0], SDS.central) }, pessimistic: { dev: simulate(r, DEV, SDS.pessimistic), zero: simulate(r, [0, 0, 0, 0], SDS.pessimistic) } };
    const checks: Array<[string, number, number, number]> = [];
    const table = (name: string, got: number, published: number) => checks.push([name, got, published, 0.005]);
    const script = (name: string, got: number, published: number) => checks.push([name, got, published, 0.0005]);
    const rows = (name: string, got: Rows, published: number[]) => published.forEach((p, i) => script(`${name}, row ${i + 2}`, got[(i + 2) as ConfirmRowNumber], p));
    const each = (name: string, got: number[], published: number[]) => published.forEach((p, i) => script(`${name}, ${CONFIRM_COMPARISONS[i].key}`, got[i], p));
    const holm = { central: [0.99, 0.30, 0.43, 0.55], pessimistic: [0.82, 0.20, 0.22, 0.20] };
    const notBehind = { central: [1.00, 1.00, 1.00, 1.00], pessimistic: [1.00, 0.99, 0.95, 0.93] };
    for (const s of Object.keys(SDS) as Scenario[]) {
      CONFIRM_COMPARISONS.forEach((c, i) => {
        table(`${s} ${c.key}: power for ahead at the dev effect, as frozen`, sim[s].dev.frozen.ahead[i], holm[s][i]);
        table(`${s} ${c.key}: chance of not behind by 3 at the dev effect, as frozen`, sim[s].dev.frozen.notBehind[i], notBehind[s][i]);
      });
    }
    table('all four ahead, central, as frozen', sim.central.dev.frozen.rows[3], 0.14);
    table('all four ahead, pessimistic, as frozen', sim.pessimistic.dev.frozen.rows[3], 0.03);
    table('row 5, central, as frozen', sim.central.dev.frozen.rows[5], 0.55);
    table('row 5, pessimistic, as frozen', sim.pessimistic.dev.frozen.rows[5], 0.67);
    table('row 4, central, as frozen', sim.central.dev.frozen.rows[4], 0.31);
    table('row 4, pessimistic, as frozen', sim.pessimistic.dev.frozen.rows[4], 0.18);
    const atZero = (k: 'level' | 'notBehind') => [...sim.central.zero.frozen[k], ...sim.pessimistic.zero.frozen[k]];
    table('level within 3 at a true difference of 0, lowest, as frozen', Math.min(...atZero('level')), 0.20);
    table('level within 3 at a true difference of 0, highest, as frozen', Math.max(...atZero('level')), 1.00);
    table('not behind by 3 at a true difference of 0, lowest, as frozen', Math.min(...atZero('notBehind')), 0.59);
    table('not behind by 3 at a true difference of 0, highest, as frozen', Math.max(...atZero('notBehind')), 1.00);
    rows('central dev, one look', sim.central.dev.frozen.rows, [0.000, 0.138, 0.307, 0.552, 0.003]);
    rows('pessimistic dev, one look', sim.pessimistic.dev.frozen.rows, [0.001, 0.028, 0.181, 0.673, 0.117]);
    script('central zero, any behind, one look', sim.central.zero.frozen.anyBehind, 0.0487);
    script('pessimistic zero, any behind, one look', sim.pessimistic.zero.frozen.anyBehind, 0.0486);
    const amended = {
      central: { stop: [0.001, 0.001], rows: [0.000, 0.129, 0.306, 0.561, 0.003], ahead: [0.993, 0.291, 0.428, 0.543], notBehind: [0.999, 0.997, 0.998, 0.999], zeroRows: [0.047, 0.0, 0.0, 0.046, 0.906], zeroAhead: [0.013, 0.012, 0.012, 0.012], anyBehind: 0.0473 },
      pessimistic: { stop: [0.002, 0.022], rows: [0.001, 0.026, 0.178, 0.676, 0.120], ahead: [0.817, 0.191, 0.212, 0.198], notBehind: [0.998, 0.986, 0.946, 0.928], zeroRows: [0.045, 0.0, 0.001, 0.046, 0.908], zeroAhead: [0.012, 0.012, 0.013, 0.012], anyBehind: 0.045 },
    };
    for (const s of Object.keys(SDS) as Scenario[]) {
      const p = amended[s], dev = sim[s].dev.amended, zero = sim[s].zero.amended;
      script(`${s} dev, the run stops at the look`, dev.stop, p.stop[0]);
      script(`${s} zero, the run stops at the look`, zero.stop, p.stop[1]);
      script(`${s} dev, the run stops at the look with every comparison crossed`, dev.stopCrossed, 0);
      rows(`${s} dev, with the look`, dev.rows, p.rows);
      each(`${s} dev, ahead with the look`, dev.ahead, p.ahead);
      each(`${s} dev, not behind by 3 at 40 worlds with the look`, dev.notBehind, p.notBehind);
      rows(`${s} zero, with the look`, zero.rows, p.zeroRows);
      each(`${s} zero, ahead with the look`, zero.ahead, p.zeroAhead);
      script(`${s} zero, any behind with the look`, zero.anyBehind, p.anyBehind);
    }
    const off = checks.map(([name, got, published, half]) => ({ name, published, got: Math.round(got * 1e4) / 1e4, tolerance: Math.round(tolerance(published, half) * 1e4) / 1e4, ok: Math.abs(got - published) <= tolerance(published, half) })).filter(x => !x.ok);
    expect(off).toEqual([]);
    expect(checks.length).toBe(90);
    for (const s of Object.keys(SDS) as Scenario[]) for (const k of ['frozen', 'amended'] as const) {
      const rs = sim[s].dev[k].rows;
      expect(Math.max(...Object.values(rs))).toBe(rs[5]);
      expect(rs[1]).toBe(0);
      expect(Object.values(rs).reduce((x, y) => x + y, 0)).toBeCloseTo(1, 9);
    }
  }, 120_000);
});

/**
 * BG1's decision rule (eval/runner/bg1/rule.ts), power plan and pilot sizing (power.ts) and pricing model (pricing.ts):
 * the paired t against hand-computed values, Holm across a family, the Bonferroni bounds and margin, the MDD table
 * against the plan's own computation, N_final from a pilot (floor, cap and pause), and the pricing model's structure
 * and its refusals. No dollar total is asserted here (R79): only per-call inputs and relationships between lines.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BG1_ASSUMPTIONS } from '../../eval/runner/q1/cells/definitions.ts';
import { BG1_ALPHA, BG1_COMPARATORS, BG1_STRICT_ALPHA, decideFamily, mdd, nRequired, pairedT } from '../../eval/runner/bg1/rule.ts';
import { FAMILY_QUESTIONS, planTable, readPilot, sdWorld, sizeFromPilot } from '../../eval/runner/bg1/power.ts';
import { ASTRA, assumedRates, CANONICAL, checkin, JUDGE_CHECK_PLAN, listPrice, mergeRates, N_PLAN, OPUS, paidAt, perWorld, pricing, stage1, stage1CapUsd, STAGE1_CAP_CEILING_USD } from '../../eval/runner/bg1/pricing.ts';
import { BG1_DEV_CONVERSATIONS, BG1_N_CAP, BG1_N_FLOOR, BG1_QUESTIONS_PER_WORLD } from '../../eval/runner/bg1/types.ts';

const ROOT = join(import.meta.dir, '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'bg1-rule-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('the paired t', () => {
  test('mean, SD, t, one-sided p and the two-sided 95% interval match a hand computation', () => {
    const t = pairedT([1, 2, 3, 4, 5]);
    expect(t.n).toBe(5);
    expect(t.mean).toBe(3);
    expect(t.sd).toBeCloseTo(Math.sqrt(2.5), 10);
    expect(t.t).toBeCloseTo(3 / (Math.sqrt(2.5) / Math.sqrt(5)), 10);
    expect(t.p_ahead).toBeCloseTo(0.00662, 4);
    expect(t.p_ahead + t.p_behind).toBeCloseTo(1, 12);
    expect(t.ci95[0]).toBeCloseTo(3 - 2.776445 * Math.sqrt(0.5), 4);
    expect(t.ci95[1]).toBeCloseTo(3 + 2.776445 * Math.sqrt(0.5), 4);
  });

  test('constant differences give an exact answer, and fewer than two worlds are refused', () => {
    expect(pairedT([4, 4, 4])).toMatchObject({ t: Infinity, p_ahead: 0, p_behind: 1, ci95: [4, 4] });
    expect(pairedT([0, 0])).toMatchObject({ t: 0, p_ahead: 1, p_behind: 1 });
    expect(() => pairedT([1])).toThrow('at least two finite');
    expect(() => pairedT([1, Number.NaN])).toThrow('at least two finite');
  });
});

describe('decideFamily', () => {
  const ahead = [9, 11, 10, 12, 8, 10, 11, 9, 10, 12, 9, 11];
  const behind = ahead.map(x => -x);
  const level = [3, -2, 1, -4, 2, 0, -1, 3, -3, 2, -1, 0];
  const v = decideFamily({ 'ext-memory-bank': ahead, 'ext-extract-first': behind, 'ext-temporal-graph': level });

  test('each comparison gets its word from Holm-adjusted one-sided p values at 0.05', () => {
    expect(v.map(x => [x.comparison, x.verdict])).toEqual([['ext-memory-bank', 'ahead'], ['ext-extract-first', 'behind'], ['ext-temporal-graph', 'no measurable difference']]);
    const raw = v.map(x => x.p_ahead), sorted = [...raw].sort((a, b) => a - b);
    expect(Math.min(...v.map(x => x.p_ahead_holm))).toBeCloseTo(3 * sorted[0], 12);
    for (const x of v) { expect(x.p_ahead_holm).toBeGreaterThanOrEqual(x.p_ahead); expect(x.p_behind_holm).toBeGreaterThanOrEqual(x.p_behind); }
  });

  test('the Bonferroni bounds sit at alpha over the family size, and beyond_margin needs the bound past 5 points', () => {
    for (const x of v) expect(x.bonferroni.alpha).toBeCloseTo(BG1_ALPHA / 3, 12);
    expect(v[0].bonferroni.lower).toBeGreaterThan(5);
    expect(v[0].beyond_margin).toBe(true);
    expect(v[1].beyond_margin).toBe(true);
    expect(v[2].beyond_margin).toBe(false);
    const near = decideFamily({ a: [6, 7, 5, 6, 7, 5, 6, 6, 7, 5, 6, 6] })[0];
    expect(near.verdict).toBe('ahead');
    expect(near.beyond_margin).toBe(near.bonferroni.lower > 5);
  });

  test('a family needs at least one comparison', () => {
    expect(() => decideFamily({})).toThrow('at least one comparison');
  });
});

describe('the power plan', () => {
  test('the strict step is alpha over the three comparators', () => {
    expect(BG1_COMPARATORS).toEqual(['ext-memory-bank', 'ext-extract-first', 'ext-temporal-graph']);
    expect(BG1_STRICT_ALPHA).toBeCloseTo(0.05 / 3, 12);
  });

  test('the primary family reproduces the plan computation (per-world SD, MDD at each N with and without Holm, N_required)', () => {
    const primary = planTable().filter(r => r.family === 'primary');
    expect(primary.map(r => [r.scenario, r.sd, r.n_required])).toEqual([['optimistic', 7.09, 21], ['central', 8.01, 25], ['pessimistic', 9.43, 34]]);
    expect(primary.map(r => r.mdd_holm)).toEqual([
      { 12: 6.77, 20: 5.0, 24: 4.52, 30: 4.0, 36: 3.62, 40: 3.43 },
      { 12: 7.65, 20: 5.65, 24: 5.11, 30: 4.52, 36: 4.1, 40: 3.87 },
      { 12: 9.0, 20: 6.65, 24: 6.01, 30: 5.32, 36: 4.82, 40: 4.56 },
    ]);
    expect(primary.map(r => r.mdd_unadjusted)).toEqual([
      { 12: 5.47, 20: 4.1, 24: 3.72, 30: 3.3, 36: 3.0, 40: 2.84 },
      { 12: 6.18, 20: 4.64, 24: 4.21, 30: 3.74, 36: 3.39, 40: 3.21 },
      { 12: 7.27, 20: 5.46, 24: 4.95, 30: 4.4, 36: 3.99, 40: 3.78 },
    ]);
  });

  test('the secondary family has fewer questions per world, so a larger SD in every scenario', () => {
    const t = planTable();
    for (const s of ['optimistic', 'central', 'pessimistic'] as const) {
      const [p, q] = (['primary', 'secondary'] as const).map(f => t.find(r => r.family === f && r.scenario === s)!);
      expect(q.sd).toBeGreaterThan(p.sd);
      expect(q.n_required).toBeGreaterThanOrEqual(p.n_required);
    }
    expect(sdWorld(43, 2, FAMILY_QUESTIONS.primary)).toBeCloseTo(7.09, 2);
  });

  test('nRequired is the first N whose MDD reaches the margin', () => {
    const n = nRequired(8.01);
    expect(mdd(8.01, n, BG1_STRICT_ALPHA)).toBeLessThanOrEqual(5);
    expect(mdd(8.01, n - 1, BG1_STRICT_ALPHA)).toBeGreaterThan(5);
    expect(() => mdd(8, 1, 0.05)).toThrow('n >= 2');
  });
});

describe('N_final from the pilot', () => {
  const sds = (x: number, y = x, z = x) => ({ 'ext-memory-bank': x, 'ext-extract-first': y, 'ext-temporal-graph': z });
  test('N_final is the largest N_required over the three differences, at least the floor and at most the cap', () => {
    expect(sizeFromPilot({ sds: sds(7.09) })).toMatchObject({ n_required_max: 21, n_final: BG1_N_FLOOR, pause: false });
    expect(sizeFromPilot({ sds: sds(7.09, 9.43, 8.01) })).toMatchObject({ n_required: { 'ext-memory-bank': 21, 'ext-extract-first': 34, 'ext-temporal-graph': 25 }, n_required_max: 34, n_final: 34, pause: false });
    const big = sizeFromPilot({ sds: sds(12) });
    expect(big.n_final).toBe(BG1_N_CAP);
    expect(big.pause).toBe(true);
    expect(big.mdd_at_cap['ext-memory-bank']).toBeCloseTo(mdd(12, BG1_N_CAP, BG1_STRICT_ALPHA), 2);
  });

  test('a pilot missing a difference is refused, and a file of another schema is refused', () => {
    expect(() => sizeFromPilot({ sds: { 'ext-memory-bank': 7 } })).toThrow('no positive SD for ext-extract-first, ext-temporal-graph');
    const bad = join(tmp, 'bad.json');
    writeFileSync(bad, JSON.stringify({ schema: 'other' }));
    expect(() => readPilot(bad)).toThrow('is not a BG1 pilot file');
  });

  test('the CLI writes the plan, sizes a pilot, and exits 3 when the pilot asks for more than the cap', () => {
    const pilot = (x: number) => { const f = join(tmp, `pilot-${x}.json`); writeFileSync(f, JSON.stringify({ schema: 'gbrain-evals/bg1-pilot/v1', worlds: 12, view: 'gating', family: 'primary', sds: sds(x), correlations: {} })); return f; };
    const run = (x: number) => { const out = join(tmp, `power-${x}.json`); const r = Bun.spawnSync(['bun', 'eval/runner/bg1/power.ts', '--pilot', pilot(x), '--out', out], { cwd: ROOT }); return { code: r.exitCode, out: JSON.parse(readFileSync(out, 'utf8')), err: r.stderr.toString() }; };
    const ok = run(8.01);
    expect(ok.code).toBe(0);
    expect(ok.out.pilot.n_final).toBe(BG1_N_FLOOR);
    expect(ok.out.plan).toHaveLength(6);
    const pause = run(12);
    expect(pause.code).toBe(3);
    expect(pause.err).toContain('above the cap of 40');
  });
});

describe('the pricing model', () => {
  const r = assumedRates();
  test('judges are priced per call at the preregistered rates, and the canonical judge at its list price', () => {
    expect(r.judge_usd_per_call.astra).toBe(0.022);
    expect(r.judge_usd_per_call.opus).toBe(0.016);
    expect(BG1_ASSUMPTIONS.judge_usd_per_call[ASTRA]).toBe(0.022);
    expect(BG1_ASSUMPTIONS.judge_usd_per_call[OPUS]).toBe(0.016);
    const p = listPrice(CANONICAL), t = BG1_ASSUMPTIONS.canonical_judge_tokens;
    expect(r.judge_usd_per_call.canonical).toBeCloseTo((t.input * p.input + t.output * p.output) / 1e6, 12);
    expect(() => listPrice('nobody:no-model')).toThrow('no list price');
  });

  test('each packed row costs one Astra, two Opus and three canonical judge calls per question, and the floor three canonical calls', () => {
    const w = perWorld(r), rows = Object.keys(r.systems).length, q = BG1_QUESTIONS_PER_WORLD;
    expect(rows).toBe(5);
    expect(w.lines.judges_astra).toBeCloseTo(rows * q * 0.022, 9);
    expect(w.lines.judges).toBeCloseTo(rows * q * (2 * 0.016 + 3 * r.judge_usd_per_call.canonical), 9);
    expect(w.lines.floor).toBeCloseTo(q * (r.floor_read_usd_per_question + 3 * r.judge_usd_per_call.canonical), 9);
    expect(w.total).toBeCloseTo(Object.values(w.lines).reduce((a, b) => a + b, 0), 9);
  });

  test('stage 1 is the three dev worlds, the full-context reference on them and the judge check, under a cap of the larger of the estimate over 0.75 and the smoke leases, at most 300', () => {
    const s = stage1(r);
    expect(s.judge_check).toBeCloseTo((JUDGE_CHECK_PLAN.dev_answers + JUDGE_CHECK_PLAN.construction_items) * (0.022 + 0.016), 2);
    expect(s.rows).toBeCloseTo(BG1_DEV_CONVERSATIONS.length * perWorld(r).total, 1);
    expect(s.cap).toBe(stage1CapUsd(s.estimate, s.smoke_leases));
    expect(stage1CapUsd(150, 0)).toBe(200);
    expect(stage1CapUsd(150, 250.01)).toBe(251);
    expect(stage1CapUsd(400, 0)).toBe(STAGE1_CAP_CEILING_USD);
    expect(stage1CapUsd(150, 320)).toBe(STAGE1_CAP_CEILING_USD);
  });

  test('the full-context reference runs on at most ten worlds, and the cap scenario is N = 40', () => {
    expect(paidAt(5, r).full_context).toBeCloseTo(5 * r.full_context_usd_per_world, 1);
    expect(paidAt(40, r).full_context).toBeCloseTo(10 * r.full_context_usd_per_world, 1);
    const p = pricing();
    expect(p.expected.n).toBe(N_PLAN);
    expect(p.cap.n).toBe(BG1_N_CAP);
    expect(p.crew).toBe('outside this model');
  });

  test('the check-in fires when the projection passes the plan by more than 25%, and counts completed work out of the remainder', () => {
    expect(checkin(N_PLAN, r).over).toBe(false);
    const plan = checkin(N_PLAN, r).plan;
    expect(checkin(N_PLAN, r, { spent_usd: plan * 1.3, worlds_done: N_PLAN, stage1_done: true }).over).toBe(true);
    expect(checkin(N_PLAN, r, { spent_usd: plan, worlds_done: N_PLAN, stage1_done: true }).projection).toBeCloseTo(plan, 1);
  });

  test('measured rates merge per system over the assumed ones', () => {
    const m = mergeRates(r, { systems: { 'ext-memory-bank': { api_usd_per_mtok: 9 } } as any, judge_usd_per_call: { astra: 0.03 } as any });
    expect(m.systems['ext-memory-bank']).toEqual({ ...r.systems['ext-memory-bank'], api_usd_per_mtok: 9 });
    expect(m.systems['ext-extract-first']).toEqual(r.systems['ext-extract-first']);
    expect(m.judge_usd_per_call).toEqual({ ...r.judge_usd_per_call, astra: 0.03 });
  });

  test('the CLI writes only to the path the caller names, refuses progress without spend, and exits 3 at the check-in', () => {
    const cli = (...args: string[]) => Bun.spawnSync(['bun', 'eval/runner/bg1/pricing.ts', ...args], { cwd: ROOT });
    const none = cli();
    expect(none.exitCode).toBe(2);
    expect(none.stderr.toString()).toContain('--out <file> is required');
    const out = join(tmp, 'pricing.json');
    expect(cli('--out', out).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8')).schema).toBe('gbrain-evals/bg1-pricing/v1');
    expect(cli('--worlds-done', '3', '--out', out).exitCode).toBe(2);
    const over = cli('--spent-usd', '100000', '--out', out);
    expect(over.exitCode).toBe(3);
    expect(over.stderr.toString()).toContain('BG1_CHECKIN');
  });
});

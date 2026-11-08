import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPARISONS, conversationDifferences, decide, dropValidity, questionScores, RS1_MARGIN, tLowerBound, tQuantile, worstCase, type ComparisonKey, type QuestionInput } from '../../eval/runner/rs1/iut.ts';
import { analyticN, corr4, jointN, jointPower, MC_TOLERANCE, minMargin, pilotSize, RHO_JUDGE, SD10, sdAtItems, sdsAt, simulatedPass, TAUS } from '../../eval/runner/rs1/power.ts';
import { priceAt, pricing, PRICING_PATH, STAGE0_RATES, unitCosts } from '../../eval/runner/rs1/pricing.ts';
import { analyze, READERS, type VerdictInput } from '../../eval/runner/rs1/verdict.ts';

const ROOT = join(import.meta.dir, '..', '..');
const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/rs1/gbev48-power.json'), 'utf8'));
const sdFor = (scen: string, i: number) => (scen === 'bound' ? SD10[COMPARISONS[i]] : sdsAt(20, TAUS[scen as keyof typeof TAUS])[i]);

describe('iut.ts', () => {
  test('the t bound and quantile match the textbook values', () => {
    expect(tQuantile(0.95, 27)).toBeCloseTo(1.7033, 4);
    expect(tQuantile(0.8, 27)).toBeCloseTo(0.8551, 4);
    const b = tLowerBound([1, 2, 3, 4]);
    expect(b.mean).toBe(2.5);
    expect(b.lower).toBeCloseTo(2.5 - 2.3534 * 1.2910 / 2, 3);
  });

  test('the claim passes only when all four lower bounds clear -3.5', () => {
    const base = Object.fromEntries(COMPARISONS.map(k => [k, [0, 1, -1, 0.5, -0.5]])) as Record<ComparisonKey, number[]>;
    expect(decide(base).verdict).toBe('pass');
    const one = { ...base, 'extract-first/bridge': [-6, -4, -5, -3, -7] };
    expect(decide(one).verdict).toBe('fail');
    expect(decide(base, { invalid: { 'memory-bank/frontier': ['drops'] } }).verdict).toBe('invalid');
  });

  test('secondaries run extract-first then memory-bank, only after the primary passes', () => {
    const up = [3, 4, 5, 4, 3];
    const flat = [-1, 1, 0, 0.5, -0.5];
    const d = { 'memory-bank/frontier': flat, 'memory-bank/bridge': flat, 'extract-first/frontier': up, 'extract-first/bridge': up };
    expect(decide(d).secondaries.map(s => [s.id, s.status])).toEqual([['superiority/extract-first', 'pass'], ['superiority/memory-bank', 'fail']]);
    const d2 = { 'memory-bank/frontier': up, 'memory-bank/bridge': up, 'extract-first/frontier': flat, 'extract-first/bridge': flat };
    expect(decide(d2).secondaries.map(s => s.status)).toEqual(['fail', 'not_tested']);
    expect(decide({ ...d, 'memory-bank/bridge': [-9, -8, -9, -8, -9] }).secondaries).toEqual([]);
  });

  test('product failures score 0, harness failures drop, over 5% drops make every comparison invalid', () => {
    const v = (x: number) => ({ frontier: x, bridge: x });
    const q = (id: string, gbrain: Record<string, any>): QuestionInput => ({ id, conversation: 'c1', rows: { gbrain, 'memory-bank': { a: v(1), b: v(1) }, 'extract-first': { a: v(1), b: v(1) } } });
    const s = questionScores(q('q1', { a: v(0), b: v(1) }), ['a', 'b']);
    expect(s.scored.scores.gbrain).toEqual({ frontier: 50, bridge: 50 });
    const dropped = questionScores(q('q2', { a: { drop: 'reader_error' }, b: v(1) }), ['a', 'b']);
    expect(dropped.scored.scores.gbrain).toBeNull();
    expect(dropped.drops).toEqual([{ question: 'q2', conversation: 'c1', row: 'gbrain', side: 'gbrain', reason: 'reader_error' }]);
    const many = [...Array.from({ length: 19 }, (_, i) => questionScores(q(`ok${i}`, { a: v(1), b: v(1) }), ['a', 'b']).scored), dropped.scored];
    expect(dropValidity(many).invalid).toEqual({});
    expect(Object.keys(dropValidity([...many, dropped.scored]).invalid)).toEqual(COMPARISONS);
    expect(worstCase(dropped.scored, 'gbrain', 'frontier')).toBe(0);
    expect(worstCase(dropped.scored, 'memory-bank', 'frontier')).toBe(100);
  });
});

describe('power.ts against GBEV-48 power.json', () => {
  test('inputs reproduce the SDs and judge correlations', () => {
    for (const [k, v] of Object.entries(FIXTURE.sd10)) {
      const [c, j] = k.split('/');
      expect(SD10[`${c === 'MB' ? 'memory-bank' : 'extract-first'}/${j === 'F' ? 'frontier' : 'bridge'}` as ComparisonKey]).toBeCloseTo(v as number, 2);
    }
    expect(RHO_JUDGE['memory-bank']).toBeCloseTo(FIXTURE.rho_judge.MB, 3);
    expect(RHO_JUDGE['extract-first']).toBeCloseTo(FIXTURE.rho_judge.EF, 3);
    for (const [k, v] of Object.entries(FIXTURE.sdq)) {
      const [scen, q, c, j] = k.split('/');
      if (scen === 'bound') continue;
      const key = `${c === 'MB' ? 'memory-bank' : 'extract-first'}/${j === 'F' ? 'frontier' : 'bridge'}` as ComparisonKey;
      expect(Math.abs(sdAtItems(SD10[key], Number(q.slice(1)), TAUS[scen as keyof typeof TAUS]) - (v as number))).toBeLessThanOrEqual(0.0051);
    }
  });

  test('the analytic per-test n matches every design 1 row exactly', () => {
    const rows = FIXTURE.design1.filter((r: any) => r.sdF !== undefined);
    expect(rows.length).toBe(80);
    for (const r of rows) expect([r.scen, r.alpha, r.margin, r.power, analyticN(sdFor(r.scen, 0), r.margin, 0, r.alpha, r.power)]).toEqual([r.scen, r.alpha, r.margin, r.power, r.n_frontier_only]);
  });

  test('the minimum margin by n matches', () => {
    for (const r of FIXTURE.min_margin_by_n) expect(Math.abs(minMargin(sdFor(r.scen, 0), r.n) - r.min_margin80)).toBeLessThanOrEqual(0.0051);
  });

  test('the joint intersection-union N at M = 3.5 is within one conversation and its power within the Monte Carlo tolerance', () => {
    for (const r of FIXTURE.design2.filter((x: any) => x.margin === 3.5)) {
      const s = { sds: sdsAt(20, TAUS[r.scen as keyof typeof TAUS]), corr: corr4(r.rho_cross), deltas: [0, 0, r.delta_EF, r.delta_EF] };
      const got = jointN(s, r.margin);
      expect(Math.abs(got.n! - r.n_joint)).toBeLessThanOrEqual(1);
      expect(Math.abs(jointPower(r.n_joint, s, r.margin) - r.p_joint)).toBeLessThanOrEqual(MC_TOLERANCE);
    }
  }, 120_000);

  test('the pilot sizes central SDs near 28 and pauses over the cap with the margin reachable at 33', () => {
    const central = pilotSize(sdsAt(20, TAUS.central), corr4());
    expect(Math.abs(central.n_required! - 28)).toBeLessThanOrEqual(1);
    expect(central.n_final).toBe(central.n_required);
    expect(pilotSize(sdsAt(20, 0).map(x => x / 2), corr4()).n_final).toBe(20);
    const wide = pilotSize(sdsAt(20, TAUS.central).map(x => x * 1.6), corr4());
    expect(wide.over_cap).toBe(true);
    expect(wide.n_final).toBeNull();
    expect(wide.margin_at_cap!).toBeGreaterThan(RS1_MARGIN);
  }, 120_000);
});

describe('power.ts and verdict.ts share iut.ts', () => {
  test('the same synthetic data gets the same pass or fail from both', () => {
    let seed = 7;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    const outcomes = new Set<string>();
    for (let trial = 0; trial < 12; trial++) {
      const lift = (trial % 6) * 0.06 - 0.12;
      const questions: QuestionInput[] = [];
      for (let c = 0; c < 22; c++) for (let i = 0; i < 3; i++) {
        const base = rand();
        const val = (shift: number) => Object.fromEntries(READERS.map(r => { const x = Math.min(1, Math.max(0, base + shift + (rand() - 0.5) * 0.4)); return [r, { frontier: x, bridge: Math.min(1, Math.max(0, x + (rand() - 0.5) * 0.1)) }]; }));
        questions.push({ id: `rs1-${String(c + 1).padStart(3, '0')}:ability${i}:0`, conversation: `rs1-${String(c + 1).padStart(3, '0')}`, rows: { gbrain: val(lift), 'memory-bank': val(0), 'extract-first': val(0.02) } });
      }
      const input: VerdictInput = { set: 'RS1', questions, floor: [], fill: { gbrain: 0.95, 'memory-bank': 0.95, 'extract-first': 0.95 }, costs: [] };
      const verdict = analyze(input).verdict;
      const diffs = conversationDifferences(questions.map(q => questionScores(q, READERS).scored)).diffs;
      expect(verdict).toBe(simulatedPass(diffs) ? 'pass' : 'fail');
      outcomes.add(verdict);
    }
    expect([...outcomes].sort()).toEqual(['fail', 'pass']);
  }, 120_000);
});

describe('pricing.ts', () => {
  test("reproduces GBEV-48's option 2b at its inputs", () => {
    const u = unitCosts(STAGE0_RATES);
    expect(u.per_conversation).toBeCloseTo(58.27, 2);
    expect(u.stage1).toBeCloseTo(51.31, 2);
    const p = pricing();
    expect(Math.abs(p.expected.all_in - 2032.94)).toBeLessThan(3);
    expect(Math.abs(p.ceiling.all_in - 2721.73)).toBeLessThan(3);
    expect(p.checkin.over).toBe(false);
  });

  test('the check-in projection is all-in and trips past $2,300', () => {
    expect(priceAt(28).projection).toBeCloseTo(1682.94 * 1.1 + 350, 1);
    expect(pricing(29).checkin.over).toBe(false);
    expect(pricing(30).checkin.over).toBe(true);
    const later = priceAt(28, STAGE0_RATES, { spent_usd: 500, kept_done: 5, stage1_done: true, crew_remaining_usd: 200 });
    expect(later.projection).toBeCloseTo(500 + unitCosts(STAGE0_RATES).per_conversation * 23 * 1.1 + 200, 1);
  });

  test('exits 3 with RS1_CHECKIN past the line', () => {
    const run = Bun.spawnSync(['bun', 'eval/runner/rs1/pricing.ts', '--n', '30', '--out', '/dev/null'], { cwd: ROOT });
    expect(run.exitCode).toBe(3);
    expect(run.stderr.toString()).toContain('RS1_CHECKIN');
  });

  test('--kept-done and --stage1-done need --spent-usd, so completed work never leaves the projection at $0 spent', () => {
    const cli = (...args: string[]) => Bun.spawnSync(['bun', 'eval/runner/rs1/pricing.ts', '--n', '28', '--out', '/dev/null', ...args], { cwd: ROOT });
    for (const progress of [['--stage1-done'], ['--kept-done', '5'], ['--kept-done', '5', '--stage1-done']]) {
      const run = cli(...progress);
      expect([progress.join(' '), run.exitCode]).toEqual([progress.join(' '), 2]);
      expect(run.stderr.toString()).toContain('need --spent-usd');
    }
    expect(cli('--stage1-done', '--spent-usd', '60').exitCode).toBe(0);
    expect(cli('--kept-done', '5', '--spent-usd', '2000').exitCode).toBe(3);
    expect(cli('--kept-done', '0').exitCode).toBe(0);
  });

  test('the committed pricing.json is the default output', () => {
    expect(JSON.parse(readFileSync(PRICING_PATH, 'utf8'))).toEqual(JSON.parse(JSON.stringify(pricing())));
  });
});

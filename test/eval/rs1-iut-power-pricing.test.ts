import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMPARISONS, conversationDifferences, decide, dropValidity, GATING, questionScores, RS1_MARGIN, tLowerBound, tQuantile, worstCase, type ComparisonKey, type QuestionInput } from '../../eval/runner/rs1/iut.ts';
import { analyticN, corr2, corr4, jointN, jointPower, MC_TOLERANCE, minMargin, pilotSize, RHO_JUDGE, SD10, sdAtItems, sdsAt, simulatedPass, TAUS } from '../../eval/runner/rs1/power.ts';
import { ASTRA_JUDGE, GBEV48_RATES, judgeCheckUsd, priceAt, pricing, PRICING_PATH, STAGE0_RATES, unitCosts } from '../../eval/runner/rs1/pricing.ts';
import { rs1GatingJudgeUsd } from '../../eval/runner/q1/cells/definitions.ts';
import { rs1JudgeOf } from '../../eval/runner/q1/cells/rs1.ts';
import { analyze, READERS, type VerdictInput } from '../../eval/runner/rs1/verdict.ts';

const ROOT = join(import.meta.dir, '..', '..');
const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/rs1/gbev48-power.json'), 'utf8'));
const sdFor = (scen: string, i: number) => (scen === 'bound' ? SD10[COMPARISONS[i]] : sdsAt(20, TAUS[scen as keyof typeof TAUS], COMPARISONS)[i]);

describe('iut.ts', () => {
  test('the t bound and quantile match the textbook values', () => {
    expect(tQuantile(0.95, 27)).toBeCloseTo(1.7033, 4);
    expect(tQuantile(0.8, 27)).toBeCloseTo(0.8551, 4);
    const b = tLowerBound([1, 2, 3, 4]);
    expect(b.mean).toBe(2.5);
    expect(b.lower).toBeCloseTo(2.5 - 2.3534 * 1.2910 / 2, 3);
  });

  test('the claim passes only when both gating (Astra/Opus) lower bounds clear -3.5; the bridge bounds are reported, never gating', () => {
    const base = Object.fromEntries(COMPARISONS.map(k => [k, [0, 1, -1, 0.5, -0.5]])) as Record<ComparisonKey, number[]>;
    expect(GATING).toEqual(['memory-bank/frontier', 'extract-first/frontier']);
    expect(decide(base).verdict).toBe('pass');
    expect(decide(base).tests.map(t => [t.key, t.gating])).toEqual(COMPARISONS.map(k => [k, GATING.includes(k)]));
    const bridgeLow = decide({ ...base, 'extract-first/bridge': [-6, -4, -5, -3, -7] });
    expect(bridgeLow.verdict).toBe('pass');
    expect(bridgeLow.tests.find(t => t.key === 'extract-first/bridge')!.pass).toBe(false);
    expect(decide({ ...base, 'extract-first/frontier': [-6, -4, -5, -3, -7] }).verdict).toBe('fail');
    expect(decide(base, { invalid: { 'memory-bank/frontier': ['drops'] } }).verdict).toBe('invalid');
    expect(decide(base, { invalid: { 'memory-bank/bridge': ['drops'] } }).verdict).toBe('pass');
    expect(decide({ 'memory-bank/frontier': base['memory-bank/frontier'], 'extract-first/frontier': base['extract-first/frontier'] }).tests).toHaveLength(2);
    expect(() => decide({ 'memory-bank/frontier': base['memory-bank/frontier'] })).toThrow(/gating comparison extract-first\/frontier/);
  });

  test('secondaries run extract-first then memory-bank under the gating view, only after the primary passes', () => {
    const up = [3, 4, 5, 4, 3];
    const flat = [-1, 1, 0, 0.5, -0.5];
    const d = { 'memory-bank/frontier': flat, 'memory-bank/bridge': flat, 'extract-first/frontier': up, 'extract-first/bridge': flat };
    expect(decide(d).secondaries.map(s => [s.id, s.status])).toEqual([['superiority/extract-first', 'pass'], ['superiority/memory-bank', 'fail']]);
    const d2 = { 'memory-bank/frontier': up, 'memory-bank/bridge': up, 'extract-first/frontier': flat, 'extract-first/bridge': flat };
    expect(decide(d2).secondaries.map(s => s.status)).toEqual(['fail', 'not_tested']);
    expect(decide({ ...d, 'memory-bank/bridge': [-9, -8, -9, -8, -9] }).secondaries.map(s => s.status)).toEqual(['pass', 'fail']);
    expect(decide({ ...d, 'memory-bank/frontier': [-9, -8, -9, -8, -9] }).secondaries).toEqual([]);
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
    expect(Object.keys(dropValidity([...many, dropped.scored]).invalid)).toEqual(GATING);
    expect(worstCase(dropped.scored, 'gbrain', 'frontier')).toBe(0);
    expect(worstCase(dropped.scored, 'memory-bank', 'frontier')).toBe(100);
  });

  test('a bridge-only judge_error on 10% of questions leaves the gating verdict valid and unchanged, and is counted on the bridge side', () => {
    let seed = 11;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    const readers = ['a', 'b', 'c'];
    const questions: QuestionInput[] = [];
    for (let c = 0; c < 10; c++) for (let i = 0; i < 10; i++) {
      const val = (shift: number) => Object.fromEntries(readers.map(r => { const x = Math.min(1, Math.max(0, 0.6 + shift + (rand() - 0.5) * 0.5)); return [r, { frontier: x, bridge: x }]; }));
      questions.push({ id: `c${c}:q${i}`, conversation: `c${c}`, rows: { gbrain: val(0), 'memory-bank': val(0), 'extract-first': val(0.01) } });
    }
    const scoredOf = (qs: QuestionInput[]) => qs.map(q => questionScores(q, readers));
    const before = scoredOf(questions);
    const hit = questions.map((q, i) => (i % 10 === 3 ? { ...q, rows: { ...q.rows, gbrain: { ...q.rows.gbrain, b: { ...(q.rows.gbrain.b as { frontier: number }), bridge: null } } } } : q));
    const after = scoredOf(hit);
    expect(after.flatMap(s => s.drops)).toEqual([]);
    expect(after.flatMap(s => s.bridge_drops)).toHaveLength(10);
    const v = dropValidity(after.map(s => s.scored));
    expect([v.common, v.share, v.invalid]).toEqual([100, 0, {}]);
    expect([v.bridge_common, v.bridge_share]).toEqual([90, 0.1]);
    const d0 = conversationDifferences(before.map(s => s.scored)), d1 = conversationDifferences(after.map(s => s.scored));
    expect(d1.conversations).toEqual(d0.conversations);
    for (const k of GATING) expect(d1.diffs[k]).toEqual(d0.diffs[k]);
    expect(decide(d1.diffs).verdict).toBe(decide(d0.diffs).verdict);
    expect(decide(d1.diffs).tests.filter(t => t.gating).map(t => t.lower)).toEqual(decide(d0.diffs).tests.filter(t => t.gating).map(t => t.lower));
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
      const s = { sds: sdsAt(20, TAUS[r.scen as keyof typeof TAUS], COMPARISONS), corr: corr4(r.rho_cross), deltas: [0, 0, r.delta_EF, r.delta_EF], keys: COMPARISONS, gating: COMPARISONS };
      const got = jointN(s, r.margin);
      expect(Math.abs(got.n! - r.n_joint)).toBeLessThanOrEqual(1);
      expect(Math.abs(jointPower(r.n_joint, s, r.margin) - r.p_joint)).toBeLessThanOrEqual(MC_TOLERANCE);
    }
  }, 120_000);

  test('the two-test pilot sizes central SDs near 27 and pauses over the cap with the margin reachable at 33', () => {
    expect(sdsAt(20, TAUS.central)).toHaveLength(2);
    const central = pilotSize(sdsAt(20, TAUS.central), corr2());
    expect(Math.abs(central.n_required! - 27)).toBeLessThanOrEqual(1);
    expect(central.n_final).toBe(central.n_required);
    expect(pilotSize(sdsAt(20, 0).map(x => x / 2), corr2()).n_final).toBe(20);
    const wide = pilotSize(sdsAt(20, TAUS.central).map(x => x * 1.6), corr2());
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
    const u = unitCosts(GBEV48_RATES);
    expect(u.per_conversation).toBeCloseTo(58.27, 2);
    expect(u.stage1).toBeCloseTo(51.31, 2);
    const p = pricing(28, GBEV48_RATES);
    expect(Math.abs(p.expected.all_in - 2032.94)).toBeLessThan(3);
    expect(Math.abs(p.ceiling.all_in - 2721.73)).toBeLessThan(3);
    expect(p.checkin.over).toBe(false);
  });

  test('the check-in projection is all-in and trips past $2,300', () => {
    expect(priceAt(28, GBEV48_RATES).projection).toBeCloseTo(1682.94 * 1.1 + 350, 1);
    expect(pricing(29, GBEV48_RATES).checkin.over).toBe(false);
    expect(pricing(30, GBEV48_RATES).checkin.over).toBe(true);
    const later = priceAt(28, GBEV48_RATES, { spent_usd: 500, kept_done: 5, stage1_done: true, crew_remaining_usd: 200 });
    expect(later.projection).toBeCloseTo(500 + unitCosts(GBEV48_RATES).per_conversation * 23 * 1.1 + 200, 1);
  });

  // Value: protects=the $2,300 check-in and the judge check's window cap; fails_when=Astra's judging is priced at another judge's rate, the judge check or Astra's share leaks into the check-in, or Opus's and the bridge's counted judging leave it; why_new=R78 point 9 (GBEV-3, 2026-11-08); seam=none; no_claim=the judges' real token counts
  test('R78 point 9: the Astra line holds the whole judge check and Astra\'s counted share, at Astra\'s price, outside the check-in', () => {
    const readers = ['anthropic:claude-opus-5-5', 'openai:gpt-6.1-sol', 'particle:particle-1'];
    expect(STAGE0_RATES.gating_judges).toEqual([...new Set(readers.map(rs1JudgeOf))].sort((a, b) => (a === ASTRA_JUDGE ? -1 : b === ASTRA_JUDGE ? 1 : 0)).map(j => ({ judge: j, readers: readers.filter(r => rs1JudgeOf(r) === j).length, usd: rs1GatingJudgeUsd(j) })));
    expect(rs1GatingJudgeUsd(ASTRA_JUDGE)).toBeCloseTo(3 * (900 * 10 + 582 * 50) / 1e6, 10);
    expect(judgeCheckUsd(STAGE0_RATES)).toBeCloseTo(826 * ((900 * 10 + 582 * 50) / 1e6 + (900 * 4 + 582 * 20) / 1e6 + 0.0028 / 3), 6);
    const u = unitCosts(STAGE0_RATES);
    expect(u.astra_per_conversation).toBeCloseTo(3 * 20 * rs1GatingJudgeUsd(ASTRA_JUDGE), 10);
    expect(u.lines.judges).toBeCloseTo(3 * 20 * (2 * rs1GatingJudgeUsd('anthropic:claude-opus-5-5') + 3 * 0.0028), 10);
    const at = priceAt(28);
    expect(at.astra_line).toBeCloseTo(28 * u.astra_per_conversation + 2 * u.astra_per_conversation + u.judge_check, 1);
    expect(at.paid).toBeCloseTo(at.astra_line + at.paid_other, 1);
    expect(at.projection).toBeCloseTo(at.paid_other * 1.1 + 350, 1);
    const base = { kept_done: 5, stage1_done: true, crew_remaining_usd: 200 };
    expect(priceAt(28, STAGE0_RATES, { ...base, spent_usd: 600, astra_spent_usd: 100 }).projection).toBe(priceAt(28, STAGE0_RATES, { ...base, spent_usd: 500 }).projection);
    expect(priceAt(28, STAGE0_RATES, { ...base, spent_usd: 600, astra_spent_usd: 100, judge_check_done: true }).astra_projection).toBeCloseTo(100 + 23 * u.astra_per_conversation * 1.1, 1);
    const p = pricing();
    expect(p.judge_check).toEqual({ usd: Math.round(u.judge_check * 100) / 100, window_cap_usd: Math.round(u.judge_check * 1.5 * 100) / 100, calls_per_judge: 826 });
    expect(p.checkin.projection).toBe(at.projection);
    expect(p.expected.all_in).toBeCloseTo(at.paid + 350, 1);
  });

  test('--judge-check-done needs --astra-spent-usd, which may not pass --spent-usd', () => {
    const cli = (...args: string[]) => Bun.spawnSync(['bun', 'eval/runner/rs1/pricing.ts', '--n', '28', '--out', '/dev/null', ...args], { cwd: ROOT });
    const done = cli('--judge-check-done', '--spent-usd', '100');
    expect(done.exitCode).toBe(2);
    expect(done.stderr.toString()).toContain('needs --astra-spent-usd');
    const over = cli('--spent-usd', '100', '--astra-spent-usd', '150');
    expect(over.exitCode).toBe(2);
    expect(over.stderr.toString()).toContain('may not pass --spent-usd');
    expect(cli('--spent-usd', '100', '--astra-spent-usd', '50', '--judge-check-done').exitCode).toBe(0);
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

  test('the judge check\'s measured dollars per answer replace each gating judge\'s assumed rate in counted judging; Astra\'s stays outside the check-in', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs1-pricing-'));
    const cli = (...args: string[]) => {
      const out = join(dir, `${args.join('_').replace(/[^a-z0-9]/gi, '')}.json`);
      const r = Bun.spawnSync(['bun', 'eval/runner/rs1/pricing.ts', '--n', '20', '--spent-usd', '50', '--astra-spent-usd', '20', '--stage1-done', '--judge-check-done', '--out', out, ...args], { cwd: ROOT });
      return { code: r.exitCode, json: r.exitCode === 2 ? null : JSON.parse(readFileSync(out, 'utf8')), err: r.stderr.toString() };
    };
    const base = cli(), astra = cli('--astra-judge-usd-per-answer', '0.0664648'), both = cli('--astra-judge-usd-per-answer', '0.0664648', '--opus-judge-usd-per-answer', '0.04890336');
    const q = STAGE0_RATES.questions_per_conversation;
    expect(base.json.rates).not.toHaveProperty('measured_judge_usd');
    expect(both.json.rates.measured_judge_usd).toEqual({ [ASTRA_JUDGE]: 0.0664648, 'anthropic:claude-opus-5-5': 0.04890336 });
    expect(astra.json.astra_per_conversation).toBeCloseTo(3 * q * 0.0664648, 2);
    expect(astra.json.checkin.projection).toBe(base.json.checkin.projection);
    expect(astra.json.astra_line.projection - base.json.astra_line.projection).toBeCloseTo(3 * q * (0.0664648 - rs1GatingJudgeUsd(ASTRA_JUDGE)) * 20 * (1 + STAGE0_RATES.reserve), 1);
    const opusDelta = 3 * q * 2 * (0.04890336 - rs1GatingJudgeUsd('anthropic:claude-opus-5-5')) * 20 * (1 + STAGE0_RATES.reserve);
    expect(both.json.checkin.projection - astra.json.checkin.projection).toBeCloseTo(opusDelta, 1);
    expect(both.json.astra_line.projection).toBe(astra.json.astra_line.projection);
    expect(both.json.judge_check).toEqual(base.json.judge_check);
    const bad = cli('--opus-judge-usd-per-answer', '-1');
    expect([bad.code, bad.err]).toEqual([2, expect.stringContaining('--opus-judge-usd-per-answer takes a non-negative number')]);
    rmSync(dir, { recursive: true, force: true });
  });

  test('the committed pricing.json is the default output', () => {
    expect(JSON.parse(readFileSync(PRICING_PATH, 'utf8'))).toEqual(JSON.parse(JSON.stringify(pricing())));
  });
});

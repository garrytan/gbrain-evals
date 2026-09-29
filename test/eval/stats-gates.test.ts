import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateFamily, validateFamily, type ComparisonFamily } from '../../eval/runner/stats/gates.ts';
import { toObservation } from '../../eval/runner/stats/rows.ts';

const family = (comparisons: ComparisonFamily['comparisons'], extra: Partial<ComparisonFamily> = {}): ComparisonFamily => ({
  schema_version: 1, family_id: 'test-family', registered_at: '2026-09-29', alpha: 0.05, seed: 7, draws: 5000, id_field: 'id', comparisons, ...extra,
});
const rows = (n: number, value: (i: number) => Record<string, unknown>) => Array.from({ length: n }, (_, i) => ({ id: `q${i}`, concept: `c${Math.floor(i / 20)}`, ...value(i) }));

describe('family registration', () => {
  test('rejects families that cannot be judged as preregistered', () => {
    expect(() => validateFamily(family([{ id: 'r', metric: 'recall', gate: 'noninferiority', direction: 'higher', cluster_by: 'id' } as never]))).toThrow('tolerance');
    expect(() => validateFamily(family([{ id: 'r', metric: 'recall', gate: 'noninferiority', direction: 'higher', tolerance: 0.01 } as never]))).toThrow('cluster_by');
    expect(() => validateFamily(family([{ id: 'r', metric: 'x', gate: 'exploratory' }, { id: 'r', metric: 'y', gate: 'exploratory' }]))).toThrow('duplicated');
    expect(() => validateFamily({ ...family([{ id: 'r', metric: 'x', gate: 'exploratory' }]), tuned_after: true })).toThrow('unknown family field');
    expect(() => validateFamily(family([{ id: 'r', metric: 'x', gate: 'exact' } as never]))).toThrow('assertion');
    expect(() => validateFamily(family([{ id: 'r', metric: 'x', gate: 'exploratory' }], { draws: 10 }))).toThrow('draws');
  });
});

describe('three gates', () => {
  test('an exact safety failure fails at once, with no significance test, and the statistical gates do not run', () => {
    const a = rows(300, () => ({ recall: 1, leaks: 0 }));
    const b = rows(300, i => ({ recall: 1, leaks: i === 17 ? 1 : 0 }));
    const d = evaluateFamily(a, b, family([
      { id: 'no-leaks', metric: 'leaks', gate: 'exact', assertion: { kind: 'every_b_equals', value: 0 } },
      { id: 'recall', metric: 'recall', gate: 'noninferiority', direction: 'higher', tolerance: 0.02, cluster_by: 'concept' },
    ]));
    expect(d.verdict).toBe('fail');
    expect(d.comparisons[0]).toMatchObject({ status: 'fail', violations: ['q17 (A=0, B=1)'] });
    expect(d.comparisons[0].stats).toBeUndefined();
    expect(d.comparisons[1].status).toBe('skipped');
  });

  test('three newly broken known-correct cases fail the exact gate although McNemar p = 0.25', () => {
    const a = rows(200, () => ({ ok: 1 }));
    const b = rows(200, i => ({ ok: i < 3 ? 0 : 1 }));
    const exploratory = evaluateFamily(a, b, family([{ id: 'ok', metric: 'ok', gate: 'exploratory' }]));
    expect(exploratory.comparisons[0].mcnemar!.p_two_sided).toBe(0.25);
    expect(exploratory.verdict).toBe('report_only');
    const exact = evaluateFamily(a, b, family([{ id: 'ok', metric: 'ok', gate: 'exact', assertion: { kind: 'no_item_regression', direction: 'higher' } }]));
    expect(exact.verdict).toBe('fail');
    expect(exact.comparisons[0].violations).toHaveLength(3);
  });

  test('non-inferiority passes only when shown, is inconclusive when the interval is wide, and fails when clearly worse', () => {
    const base = rows(800, i => ({ recall: i % 10 === 0 ? 0 : 1 }));
    const same = rows(800, i => ({ recall: i % 10 === 1 ? 0 : 1 }));
    const ni = (b: Array<Record<string, unknown>>, a = base, tolerance = 0.05) => evaluateFamily(a, b, family([{ id: 'recall', metric: 'recall', gate: 'noninferiority', direction: 'higher', tolerance, cluster_by: 'concept' }]));
    expect(ni(same).verdict).toBe('pass');
    expect(ni(same).comparisons[0].p_holm!).toBeLessThanOrEqual(0.05);
    const small = evaluateFamily(base.slice(0, 40), same.slice(0, 40), family([{ id: 'recall', metric: 'recall', gate: 'noninferiority', direction: 'higher', tolerance: 0.05, cluster_by: 'id' }]));
    expect(small.verdict).toBe('inconclusive');
    expect(small.comparisons[0].reasons.join(' ')).toContain('not evidence of a regression or of equivalence');
    const clustered = rows(800, i => ({ recall: i % 10 === 0 ? 0 : 1 })).map((r, i) => ({ ...r, concept: `c${i % 40}` }));
    const shifted = rows(800, i => ({ recall: i % 10 === 1 ? 0 : 1 })).map((r, i) => ({ ...r, concept: `c${i % 40}` }));
    expect(ni(shifted, clustered).verdict).toBe('inconclusive');
    const worse = rows(800, i => ({ recall: i % 3 === 0 ? 0 : 1 }));
    expect(ni(worse).verdict).toBe('fail');
    expect(ni(worse).comparisons[0].reasons.join(' ')).toContain('whole 95% interval');
  });

  test('too few clusters makes a non-inferiority result inconclusive whatever the p-value', () => {
    const a = rows(400, () => ({ recall: 1, one: 'x', few: 'y' })).map((r, i) => ({ ...r, few: `f${i % 4}` }));
    const d = evaluateFamily(a, a, family([{ id: 'recall', metric: 'recall', gate: 'noninferiority', direction: 'higher', tolerance: 0.01, cluster_by: 'few' }]));
    expect(d.verdict).toBe('inconclusive');
    expect(d.comparisons[0].reasons.join(' ')).toContain('4 clusters is below the family minimum of 10');
  });

  test('exploratory dashboards never change the verdict', () => {
    const a = rows(800, () => ({ recall: 1, latency: 10 }));
    const b = rows(800, () => ({ recall: 1, latency: 900 }));
    const d = evaluateFamily(a, b, family([
      { id: 'recall', metric: 'recall', gate: 'noninferiority', direction: 'higher', tolerance: 0.01, cluster_by: 'concept' },
      { id: 'latency', metric: 'latency', gate: 'exploratory', direction: 'lower' },
    ]));
    expect(d.verdict).toBe('pass');
    expect(d.comparisons[1]).toMatchObject({ status: 'report_only' });
    expect(d.comparisons[1].stats!.delta).toBe(890);
  });

  test('Holm adjusts across the preregistered non-inferiority family only', () => {
    const a = rows(600, i => ({ m1: i % 7 === 0 ? 0 : 1, m2: i % 5 === 0 ? 0 : 1, m3: 1 }));
    const b = rows(600, i => ({ m1: i % 7 === 1 ? 0 : 1, m2: i % 5 === 1 ? 0 : 1, m3: 0 }));
    const d = evaluateFamily(a, b, family([
      { id: 'm1', metric: 'm1', gate: 'noninferiority', direction: 'higher', tolerance: 0.03, cluster_by: 'concept' },
      { id: 'm2', metric: 'm2', gate: 'noninferiority', direction: 'higher', tolerance: 0.03, cluster_by: 'concept' },
      { id: 'm3', metric: 'm3', gate: 'exploratory' },
    ]));
    expect(d.holm_family).toEqual(['m1', 'm2']);
    const [c1, c2, c3] = d.comparisons;
    const [lo, hi] = [c1, c2].sort((x, y) => x.p_noninferiority! - y.p_noninferiority!);
    expect(lo.p_holm).toBeCloseTo(Math.min(1, 2 * lo.p_noninferiority!), 12);
    expect(hi.p_holm).toBeCloseTo(Math.max(lo.p_holm!, hi.p_noninferiority!), 12);
    expect(c3.p_holm).toBeUndefined();
  });

  test('a missing pair or changed eligibility blocks the family', () => {
    const a = rows(100, () => ({ recall: 1 }));
    const missing = evaluateFamily(a, a.slice(1), family([{ id: 'recall', metric: 'recall', gate: 'exploratory' }]));
    expect(missing.verdict).toBe('blocked');
    expect(missing.reasons[0]).toContain('missing in B: q0');
    const b = a.map((r, i) => i === 5 ? { ...r, error: 'provider down', error_origin: 'dependency' } : r);
    const changed = evaluateFamily(a, b, family([{ id: 'recall', metric: 'recall', gate: 'exploratory' }]));
    expect(changed.verdict).toBe('blocked');
    expect(changed.reasons[0]).toContain('eligibility differs for q5');
  });
});

describe('row eligibility', () => {
  const sel = { idField: 'question_id', metric: 'recall_all', excludeWhen: ['is_abs=true'] };
  test('system failures stay in the denominator as zeros; infrastructure failures and abstention items are ineligible', () => {
    expect(toObservation({ question_id: 'q', recall_all: 1 }, sel)).toMatchObject({ eligible: true, value: 1 });
    expect(toObservation({ question_id: 'q', recall_all_hit: true }, { ...sel, metric: 'recall_all_hit' })).toMatchObject({ eligible: true, value: 1 });
    expect(toObservation({ question_id: 'q', error: 'boom', error_origin: 'sut' }, sel)).toMatchObject({ eligible: true, value: 0 });
    expect(toObservation({ question_id: 'q', error: 'boom', error_origin: 'harness' }, sel)).toMatchObject({ eligible: false, reason: 'harness error' });
    expect(toObservation({ question_id: 'q', error: 'boom' }, sel)).toMatchObject({ eligible: false, reason: 'error without a known origin' });
    expect(toObservation({ question_id: 'q_abs', is_abs: true, abs_noise: 0 }, sel)).toMatchObject({ eligible: false, reason: 'excluded by is_abs=true' });
    expect(toObservation({ question_id: 'q' }, sel)).toMatchObject({ eligible: false, reason: 'no recall_all value' });
  });
});

describe('compare CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'compare-cli-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const cli = (...args: string[]) => {
    const r = Bun.spawnSync([process.execPath, 'eval/runner/compare.ts', ...args], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' } });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const wave = 'docs/benchmarks/2026-09-06-longmemeval-ranker-wave/longmemeval';

  test('reproduces the published A1 to A2 paired counts from committed rows', () => {
    const r = cli(`${wave}/A1-hybrid-rerank-off-autocut-off.ndjson`, `${wave}/A2-hybrid-rerank-on-autocut-off.ndjson`, '--metric', 'recall_all_hit', '--exclude-when', 'abstention=true', '--json');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    const c = out.decision.comparisons[0];
    expect(out.preregistered).toBe(false);
    expect(c.n_pairs).toBe(470);
    expect(c.n_excluded).toBe(30);
    expect(c.mcnemar).toMatchObject({ wins: 18, losses: 8 });
    expect(c.mcnemar.p_two_sided).toBeCloseTo(0.0755, 4);
    expect(out.inputs[0].skipped_summary_rows).toBe(1);
  });

  test('a preregistered family gates, and commands outside it are labeled exploratory', () => {
    const fam = join(dir, 'family.json');
    writeFileSync(fam, JSON.stringify(family([{ id: 'strict', metric: 'recall_all_hit', gate: 'noninferiority', direction: 'higher', tolerance: 0.01, cluster_by: 'question_id' }],
      { id_field: 'question_id', exclude_when: ['abstention=true'] })));
    const r = cli(`${wave}/A1-hybrid-rerank-off-autocut-off.ndjson`, `${wave}/A2-hybrid-rerank-on-autocut-off.ndjson`, '--family', fam, '--metric', 'recall_any_hit');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Verdict: PASS');
    expect(r.out).toContain('adhoc:recall_any_hit [exploratory]');
    const reverse = cli(`${wave}/A2-hybrid-rerank-on-autocut-off.ndjson`, `${wave}/A1-hybrid-rerank-off-autocut-off.ndjson`, '--family', fam);
    expect(reverse.code).toBe(2);
    expect(reverse.out).toContain('Verdict: INCONCLUSIVE');
  });

  test('duplicate ids block with exit 2', () => {
    const a = join(dir, 'dup.ndjson');
    writeFileSync(a, [{ id: 'x', m: 1 }, { id: 'x', m: 0 }].map(r => JSON.stringify(r)).join('\n'));
    const r = cli(a, a, '--metric', 'm');
    expect(r.code).toBe(2);
    expect(r.out).toContain('BLOCKED');
    expect(r.out).toContain('duplicate id x');
  });

  test('refuses to run without a metric or family', () => {
    const r = cli('a.ndjson', 'b.ndjson');
    expect(r.code).toBe(2);
    expect(r.err).toContain('--family');
  });
});

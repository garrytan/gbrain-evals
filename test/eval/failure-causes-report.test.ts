import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLabelSet, classify, cohensKappa, gatePaths, issueDrafts, knownAnswerAccuracy, perCause, productionLabels, renderReport, stratifiedSample, summarize, type CauseLabel, type EvalFailure } from '../../eval/runner/failure-causes/index.ts';
import { failure } from '../support/failure-causes-fixture.ts';

const gold = (retrieved: 'none' | 'all') => ({ ...failure().gold, gold_count: 1, retrieved });
const row = (source: string, n: number, over: Partial<EvalFailure>): CauseLabel[] => Array.from({ length: n }, (_, i) => classify(failure({ source, case_id: `${source}-${over.arm ?? 'g'}-${i}-${JSON.stringify(over).length}`, ...over })));
const toolError = [{ name: 'get_page', error: 'invalid_params', recovered: false, ms: 1, memory: true }];
const modelLabel = (l: CauseLabel, cause: string, path: string, rule_id = 'labeller'): CauseLabel => ({ ...l, cause: cause as CauseLabel['cause'], basis: cause === 'unclassified' ? 'unclassified' : 'model', rule_id,
  labeller: { model: 'openai:gpt-6.1-sol', effort: 'medium', path, prompt_sha256: '0'.repeat(64), cached: false, reason: null } });
const residualLabel = (source: string, case_id: string) => classify(failure({ source, case_id, gold: { ...failure().gold, gold_count: 1, retrieved: 'all', delivered: 'all' }, category: 'knowledge_update',
  text: { question: 'Where does Farah park now?', expected: 'Level 5', answer: 'Level 3', context: 'Farah moved to level 3 in May, then level 5 in June.' } }));

describe('summarize', () => {
  const labels = [
    ...row('s1', 3, { gold: gold('none') }),
    ...row('s1', 1, { tool_calls: toolError }),
    ...row('s2', 1, { tool_calls: toolError }),
    ...row('s2', 1, { stop: 'harness_error' }),
    ...row('forced', 5, { condition: 'forced', tool_calls: toolError }),
    ...row('s1', 4, { arm: 'mem', system: 'memory-bank', arm_role: 'other_system', gold: gold('none') }),
    classify(failure({ failed: false, source: 's1' })),
  ];
  const s = summarize(labels, [{ source: 'skillopt', run_id: 'r', system: 'gbrain', model: 'openai:gpt-6.1-sol', gbrain_sha: null, condition: 'forced', visibility: 'public', cause: 'tool_contract', unit: 'calls', count: 607, of: 607, detail: 'get_page', evidence: [] }]);

  test('ranks natural gbrain rows with equal source weight, raw counts breaking the tie', () => {
    expect(s.ranked.map(r => [r.cause, Number(r.score.toFixed(3)), r.count])).toEqual([['retrieval_miss', 0.375, 3], ['tool_contract', 0.375, 2], ['harness_error', 0.25, 1]]);
    expect(s.top_three.map(r => r.cause)).toEqual(['retrieval_miss', 'tool_contract']);
    expect(s.failures).toBe(15);
  });

  test('forced runs and stress counts go under stress, other systems to the contrast table, harness errors to our list', () => {
    expect(s.under_stress).toContainEqual({ source: 'forced', cause: 'tool_contract', unit: 'episodes', count: 5, of: 5, detail: '5 failed rows' });
    expect(s.under_stress.some(u => u.count === 607)).toBe(true);
    expect(s.ranked.some(r => Object.keys(r.by_source).includes('forced'))).toBe(false);
    expect(s.contrast).toEqual([{ system: 'memory-bank', arm_role: 'other_system', cause: 'retrieval_miss', count: 4 }]);
    expect(s.harness).toEqual([{ rule_id: 'harness.stop_harness_error', count: 1, sources: ['s2'] }]);
  });

  test('reports what each source measured', () => {
    expect(s.capability.s1.retrieval).toBeCloseTo(7 / 8, 3);
    expect(s.capability.s2.retrieval).toBe(0);
  });

  test('refuses to pool labels across taxonomy versions', () => {
    expect(() => summarize([...labels, { ...labels[0], taxonomy_version: '2026-01-01.0' }])).toThrow(/taxonomy versions/);
  });

  test('issue drafts carry a stable signature, counts, a repro slot and a proposed regression test', () => {
    const drafts = issueDrafts(s, { 'tool_contract:tool.unrecovered_error': 'bun repro.ts' });
    expect(drafts.map(d => d.signature)).toEqual(['retrieval_miss:retrieval.no_gold_retrieved', 'tool_contract:tool.unrecovered_error']);
    expect(drafts[1].body).toContain('**Minimal repro:** bun repro.ts');
    expect(drafts[0].body).toContain('Proposed regression test');
  });

  test('unclassified stays in the full table but never reaches the top three or an issue draft', () => {
    const failedCalls = row('s3', 5, { gold: gold('none') }).map(l => modelLabel(l, 'unclassified', 'sol-labels-claude-rows', 'labeller.call_failed'));
    const u = summarize([...failedCalls, ...row('s3', 1, { tool_calls: toolError })]);
    expect(u.ranked.map(r => r.cause)).toEqual(['unclassified', 'tool_contract']);
    expect(u.top_three.map(r => r.cause)).toEqual(['tool_contract']);
    expect(issueDrafts(u).map(d => d.cause)).toEqual(['tool_contract']);
  });
});

describe('privacy', () => {
  test('a private row gives counts only: its ids and evidence never reach the report, the summary or an issue draft', () => {
    const marker = 'PRIVATE-MARKER-7f3a';
    const labels = [classify(failure({ source: 'live', visibility: 'private', case_id: `${marker}-q1`, evidence: [`live:${marker}.json#00000000`], gold: gold('none') }))];
    const s = summarize(labels);
    const outputs = [JSON.stringify(s), renderReport(s, { heading: 'Week' }), JSON.stringify(issueDrafts(s))];
    expect(s.top_three[0]).toMatchObject({ cause: 'retrieval_miss', count: 1, examples: [] });
    for (const o of outputs) expect(o).not.toContain(marker);
  });
});

describe('agreement', () => {
  test("Cohen's kappa on a known table", () => {
    expect(cohensKappa([['a', 'a'], ['a', 'a'], ['b', 'b'], ['b', 'a']])).toBeCloseTo(0.5, 6);
    expect(cohensKappa([['a', 'a'], ['a', 'a']])).toBe(1);
    expect(cohensKappa([])).toBeNull();
  });

  test('per-cause precision and recall, and known-answer accuracy', () => {
    expect(perCause([['a', 'a'], ['a', 'b'], ['b', 'b']])).toEqual({ a: { support: 2, precision: 1, recall: 0.5 }, b: { support: 1, precision: 0.5, recall: 1 } });
    expect(knownAnswerAccuracy([['x', 'x'], ['x', 'y']])).toBe(0.5);
  });

  test('the label set keeps agreed rows only and splits them by key hash', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ case_key: `k${i}`, path: 'p', stratum: 's', opus: i % 10 ? 'stale_fact' : 'model_error', astra: i % 20 ? (i % 10 ? 'stale_fact' : 'model_error') : 'time_reasoning' }));
    const set = buildLabelSet(rows);
    expect(set.agreed + set.disagreed).toBe(200);
    expect(set.disagreed).toBe(10);
    const held = set.rows.filter(r => r.split === 'held_out').length;
    expect(held).toBeGreaterThan(60);
    expect(held).toBeLessThan(130);
    expect(buildLabelSet(rows).rows).toEqual(set.rows);
  });

  test('a path gates on at least 40 held-out agreed rows and kappa of at least 0.6', () => {
    const set = Array.from({ length: 120 }, (_, i) => ({ case_key: `k${i}`, path: i < 100 ? 'big' : 'small', stratum: 's', label: i % 3 ? 'stale_fact' : 'time_reasoning', split: 'held_out' as const }));
    const right = new Map(set.map(r => [r.case_key, r.label]));
    const gates = gatePaths(set, right);
    expect(gates.map(g => [g.path, g.held_out, g.pass])).toEqual([['big', 100, true], ['small', 20, false]]);
    const wrong = new Map(set.map(r => [r.case_key, 'stale_fact']));
    expect(gatePaths(set, wrong)[0]).toMatchObject({ pass: false });
    expect(gatePaths(set, wrong)[0].reason).toMatch(/switch this path to Astra/);
  });

  test('a production path with no label-set rows fails its gate, and a failed call is no label', () => {
    const set = Array.from({ length: 100 }, (_, i) => ({ case_key: `s|${i}`, path: 'big', stratum: 's', label: i % 3 ? 'stale_fact' : 'time_reasoning', split: 'held_out' as const }));
    const base = classify(failure({ source: 's' }));
    const labels = [...set.map(r => modelLabel({ ...base, case_id: r.case_key.slice(2) }, r.label, 'big')), modelLabel({ ...base, case_id: 'lost' }, 'unclassified', 'other', 'labeller.call_failed')];
    const { byCase, paths } = productionLabels(labels);
    expect(paths).toEqual(['big', 'other']);
    expect(byCase.has('s|lost')).toBe(false);
    const gates = gatePaths(set, byCase, paths);
    expect(gates.map(g => [g.path, g.held_out, g.pass])).toEqual([['big', 100, true], ['other', 0, false]]);
    expect(gates[1].reason).toMatch(/^0 held-out agreed rows/);
  });

  test('stratified samples are deterministic and capped per stratum', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, s: i % 2 ? 'odd' : 'even' }));
    const a = stratifiedSample(items, x => x.s, x => x.id, 10);
    expect(a).toHaveLength(20);
    expect(stratifiedSample(items, x => x.s, x => x.id, 10)).toEqual(a);
  });
});

describe('agree and report on the command line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fc-report-'));
  const deadEnv = { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', PARTICLE_API_KEY: '', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', OPENAI_BASE_URL: 'http://127.0.0.1:9/v1', BRAINBENCH_BUDGET_RUN_ID: '' };
  const cli = (args: string[]) => spawnSync('bun', ['eval/runner/failure-causes/cli.ts', ...args], { encoding: 'utf8', env: deadEnv, timeout: 60_000 });
  const ndjson = (name: string, rows: unknown[]) => { const f = join(dir, name); writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')); return f; };

  test('agree fails on an empty label set: a production path gets a failing gate, and nothing to gate fails too', () => {
    const empty = ndjson('empty.ndjson', []);
    const production = ndjson('production.ndjson', [modelLabel(residualLabel('w', 'q1'), 'stale_fact', 'sol-labels-claude-rows')]);
    const r = cli(['agree', '--labelset', empty, '--production', production, '--out', join(dir, 'check.json')]);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual([expect.objectContaining({ path: 'sol-labels-claude-rows', held_out: 0, pass: false })]);
    const none = cli(['agree', '--labelset', empty, '--production', empty, '--out', join(dir, 'check-none.json')]);
    expect(none.status).toBe(1);
    expect(none.stderr).toMatch(/no labeller path to gate/);
  });

  test('report counts a row once when label files overlap, the last file winning', () => {
    const pending = residualLabel('w', 'r1');
    expect(pending.basis).toBe('needs_model');
    const deterministic = classify(failure({ source: 'w', case_id: 'd1', tool_calls: toolError }));
    const classified = ndjson('classified.ndjson', [deterministic, pending]);
    const labelled = ndjson('labelled.ndjson', [deterministic, modelLabel(pending, 'stale_fact', 'sol-labels-claude-rows')]);
    const r = cli(['report', '--labels', `${classified},${labelled}`, '--out-dir', join(dir, 'out'), '--heading', 'Week']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ failures: 2, pending: 0 });
    expect(out.top_three.map((t: { cause: string; count: number }) => [t.cause, t.count])).toEqual([['stale_fact', 1], ['tool_contract', 1]]);
  });
});

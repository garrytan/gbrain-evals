import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LABEL_PROMPT_SHA256, TAXONOMY_VERSION, buildLabelSet, classify, cohensKappa, gatePaths, issueDrafts, knownAnswerAccuracy, labelSetSample, perCause, productionLabels, renderReport, stratifiedSample, summarize, ungated, type CauseLabel, type EvalFailure } from '../../eval/runner/failure-causes/index.ts';
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

  test('ranks natural gbrain rows with equal source weight, over the rows that say something about gbrain', () => {
    expect(s.ranked.map(r => [r.cause, Number(r.score.toFixed(3)), r.count])).toEqual([['tool_contract', 0.625, 2], ['retrieval_miss', 0.375, 3]]);
    expect(s.ranked[0].by_source).toEqual({ s1: { count: 1, of: 4 }, s2: { count: 1, of: 1 } });
    expect(s.top_three.map(r => r.cause)).toEqual(['tool_contract', 'retrieval_miss']);
    expect(s.failures).toBe(15);
  });

  test('each cause says, per task and model, whether the other systems failed the same way', () => {
    const t = (source: string, task: string, over: Partial<EvalFailure>, model = 'anthropic:claude-opus-5-5') => classify(failure({ source, task_id: task, model, case_id: `${over.system ?? 'gbrain'}|${task}|${model}`, ...over }));
    const fs = { system: 'fs', arm: 'fs', arm_role: 'other_system' as const };
    const c = summarize([
      t('a', 'T1', { gold: gold('none') }), t('a', 'T1', { ...fs, gold: gold('none') }),
      t('a', 'T2', { gold: gold('none') }), t('a', 'T2', { ...fs, tool_calls: toolError }),
      t('a', 'T3', { gold: gold('none') }),
      t('a', 'T4', { gold: gold('none') }), t('a', 'T4', { ...fs, gold: gold('none') }, 'openai:gpt-6.1-sol'),
    ]);
    const miss = c.ranked.find(r => r.cause === 'retrieval_miss')!;
    expect(miss.others).toEqual([{ system: 'fs', arm_role: 'other_system', same: 1, other: 1, none: 2, not_run: 0 }]);
    expect(miss).toMatchObject({ compared: 4, gbrain_only: 3 });
    expect(miss.tasks.map(x => [x.task_id, x.others.fs])).toEqual([['T1', 'retrieval_miss'], ['T2', 'tool_contract'], ['T3', null], ['T4', null]]);
    const md = renderReport(c, { heading: 'w' });
    expect(md).toContain('fs (other_system) failed the same way on 1, another way on 1, and had no failed row on 2');
    expect(md).toContain('On 3 of 4 compared rows, no other system failed the same way.');
    expect(md).toContain('| `T2` | anthropic:claude-opus-5-5 | gbrain | `tool_contract` |');
  });

  test('a system that never ran a task shows as not run, not as having no failed row, and is not compared there', () => {
    const t = (task: string, over: Partial<EvalFailure>) => classify(failure({ source: 'a', task_id: task, case_id: `${over.system ?? 'gbrain'}|${task}`, ...over }));
    const fs = { system: 'fs', arm: 'fs', arm_role: 'other_system' as const };
    const c = summarize([
      t('T1', { gold: gold('none') }), t('T1', { ...fs, failed: false, not_run: 'does_not_fit' }),
      t('T2', { gold: gold('none') }),
    ]);
    const miss = c.ranked.find(r => r.cause === 'retrieval_miss')!;
    expect(c.failures).toBe(2);
    expect(miss.tasks.map(x => [x.task_id, x.others, x.not_run])).toEqual([['T1', {}, ['fs']], ['T2', { fs: null }, []]]);
    expect(miss.others).toEqual([{ system: 'fs', arm_role: 'other_system', same: 0, other: 0, none: 1, not_run: 1 }]);
    expect(miss).toMatchObject({ compared: 1, gbrain_only: 1 });
    const md = renderReport(c, { heading: 'w' });
    expect(md).toContain('fs (other_system) failed the same way on 0, another way on 0, and had no failed row on 1, and did not run 1');
    expect(md).toContain('| `T1` | anthropic:claude-opus-5-5 | gbrain | not run |');
    expect(md).toContain('| `T2` | anthropic:claude-opus-5-5 | gbrain | - |');
  });

  test('turn-cap rows are tagged and counted per cause, and the report says the cap is part of what they measure', () => {
    const c = summarize([...row('a', 2, { stop: 'turn_cap', category: 'H1', gold: { ...failure().gold, gold_count: 30, retrieved: 'partial', delivered: 'partial' } }),
      ...row('a', 1, { gold: { ...failure().gold, gold_count: 2, retrieved: 'partial', delivered: 'partial' } })]);
    expect(c.ranked[0]).toMatchObject({ cause: 'partial_evidence', count: 3, turn_cap: { count: 2, by_category: { H1: 2 } } });
    const md = renderReport(c, { heading: 'w' });
    expect(md).toContain("Turn cap: 2 of 3 rows hit the agent's turn cap (H1 2). The cap is our harness setting and part of what these rows measure. For these rows the lever may be reaching many pages in fewer calls, not better ranking.");
  });

  test('a top-three place is provisional when the rows waiting for the labeller could move it, and those rows are listed', () => {
    const waiting = Array.from({ length: 2 }, (_, i) => residualLabel('a', `w${i}`));
    const c = summarize([...row('a', 5, { gold: gold('none') }), ...row('a', 2, { stop: 'harness_error' }), ...row('a', 1, { stop: 'turn_cap' }), ...row('a', 2, { category: 'abstention', gold: { ...failure().gold, gold_count: 0 } }), ...waiting]);
    expect(c.top_three.map(r => [r.cause, r.count, r.provisional])).toEqual([['retrieval_miss', 5, false], ['citation_abstention', 2, true], ['timeout_latency', 1, true]]);
    expect(Number(c.pending_share.toFixed(3))).toBe(0.2);
    expect(c.waiting.map(e => e.case_id)).toEqual(['w0', 'w1']);
    const md = renderReport(c, { heading: 'w' });
    expect(md).toContain('### 2. Citation or abstention (`citation_abstention`), provisional');
    expect(md).toContain('Every count here comes from deterministic log rules.');
    expect(md).toContain('## Waiting for the labeller');
    expect(issueDrafts(c)[1].title).toMatch(/, provisional$/);
    const labelled = summarize([...row('a', 5, { gold: gold('none') }), modelLabel(waiting[0], 'stale_fact', 'p')]);
    expect(labelled.top_three.every(r => !r.provisional)).toBe(true);
    expect(renderReport(labelled, { heading: 'w' })).not.toContain('Every count here comes from deterministic log rules.');
  });

  test('an under-stress row shows a known status, and a harness error is marked as ours', () => {
    const stress = [{ source: 'skillopt', run_id: 'r', system: 'gbrain', model: 'm', gbrain_sha: null, condition: 'forced' as const, visibility: 'public' as const, cause: 'tool_contract' as const, unit: 'calls' as const, count: 9, of: 9, detail: 'get_page: 9 of 9', evidence: [] }];
    const c = summarize([...row('forced', 2, { condition: 'forced', harness: { error: null, scorer_artifact: 'untitled_capture_duplicate' } })], stress,
      { known: [{ source: 'skillopt', cause: 'tool_contract', detail_includes: 'get_page', status: 'fixed upstream in gbrain v0.60.570.0' }, { source: 'skillopt', cause: 'tool_contract', detail_includes: 'traverse', status: 'never shown' }] });
    expect(c.under_stress.map(u => u.status)).toEqual(['eval side: our harness or scorer, not gbrain', 'fixed upstream in gbrain v0.60.570.0']);
    expect(renderReport(c, { heading: 'w' })).toContain('| get_page: 9 of 9 | fixed upstream in gbrain v0.60.570.0 |');
  });

  test('raw counts break a tie in share', () => {
    const t = summarize([...row('a', 3, { gold: gold('none') }), ...row('a', 1, { tool_calls: toolError }), ...row('b', 1, { gold: gold('none') }), ...row('b', 3, { tool_calls: toolError })]);
    expect(t.ranked.map(r => [r.cause, Number(r.score.toFixed(3)), r.count])).toEqual([['retrieval_miss', 0.5, 4], ['tool_contract', 0.5, 4]]);
  });

  test('forced runs and stress counts go under stress, other systems to the contrast table, harness errors to our list', () => {
    expect(s.under_stress).toContainEqual({ source: 'forced', cause: 'tool_contract', unit: 'episodes', count: 5, of: 5, detail: '5 failed rows', status: null });
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
    expect(drafts.map(d => d.signature)).toEqual(['tool_contract:tool.unrecovered_error', 'retrieval_miss:retrieval.no_gold_retrieved']);
    expect(drafts[0].body).toContain('**Minimal repro:** bun repro.ts');
    expect(drafts[1].body).toContain('Proposed regression test');
  });

  test('unclassified stays in the full table but never reaches the top three or an issue draft; a failed labeller call is pending', () => {
    const answered = row('s3', 3, { gold: gold('none') }).map(l => modelLabel(l, 'unclassified', 'sol-labels-claude-rows'));
    const failedCalls = row('s3', 2, { gold: gold('all') }).map(l => modelLabel(l, 'unclassified', 'sol-labels-claude-rows', 'labeller.call_failed'));
    const u = summarize([...answered, ...failedCalls, ...row('s3', 1, { tool_calls: toolError })]);
    expect(u.ranked.map(r => [r.cause, r.count])).toEqual([['unclassified', 3], ['pending_label', 2], ['tool_contract', 1]]);
    expect(u.pending).toBe(2);
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

  test('the split does not follow the sample: the smallest-hash sample still fills both halves', () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({ id: `k${i}` }));
    const sample = stratifiedSample(items, () => 's', x => x.id, 100);
    const set = buildLabelSet(sample.map(x => ({ case_key: x.id, path: 'p', stratum: 's', opus: 'stale_fact', astra: 'stale_fact' })));
    const held = set.rows.filter(r => r.split === 'held_out').length;
    expect(held).toBeGreaterThan(30);
    expect(held).toBeLessThan(70);
  });

  test('the label-set sample gives each row family enough rows for 40 held-out agreed ones, spread over its sources', () => {
    const items = ['a', 'b'].flatMap(src => Array.from({ length: 200 }, (_, i) => ({ id: `${src}|${i}`, src, fam: 'claude' })))
      .concat(Array.from({ length: 30 }, (_, i) => ({ id: `c|${i}`, src: 'c', fam: 'gpt' })));
    const sample = labelSetSample(items, x => x.fam, x => x.src, x => x.id);
    expect(sample.filter(x => x.fam === 'claude')).toHaveLength(100);
    expect(sample.filter(x => x.src === 'a')).toHaveLength(50);
    expect(sample.filter(x => x.fam === 'gpt')).toHaveLength(30);
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

  const base = classify(failure({ source: 's' }));
  const famSet = (n: number, fam: string) => Array.from({ length: n }, (_, i) => ({ case_key: `s|${fam}${i}`, path: fam, stratum: 's', label: i % 3 ? 'stale_fact' : 'time_reasoning', split: 'held_out' as const }));
  const produce = (set: ReturnType<typeof famSet>, path: string, cause?: string) => set.map(r => modelLabel({ ...base, case_id: r.case_key.slice(2), model: r.path === 'gpt' ? 'openai:gpt-6.1-sol' : base.model }, cause ?? r.label, path));
  const fam = (model: string) => (model.startsWith('openai') ? 'gpt' : 'claude');

  test('a path gates per row family on at least 40 held-out agreed rows and kappa of at least 0.6', () => {
    const set = [...famSet(100, 'claude'), ...famSet(20, 'gpt')];
    const gates = gatePaths(set, productionLabels([...produce(set.slice(0, 100), 'sol'), ...produce(set.slice(100), 'opus')], fam));
    expect(gates.map(g => [g.path, g.family, g.held_out, g.pass])).toEqual([['opus', 'gpt', 20, false], ['sol', 'claude', 100, true]]);
    const wrong = gatePaths(set.slice(0, 100), productionLabels(produce(set.slice(0, 100), 'sol', 'stale_fact'), fam));
    expect(wrong[0]).toMatchObject({ pass: false });
    expect(wrong[0].reason).toMatch(/switch this family to Astra/);
  });

  test('a family switched to the Astra fallback gates on that family\'s rows', () => {
    const set = famSet(100, 'claude');
    expect(gatePaths(set, productionLabels(produce(set, 'astra-fallback'), fam))).toEqual([expect.objectContaining({ path: 'astra-fallback', family: 'claude', held_out: 100, pass: true })]);
  });

  test('a production path with no label-set rows fails its gate, and a failed call is no label', () => {
    const set = famSet(100, 'claude');
    const labels = [...produce(set, 'sol'), modelLabel({ ...base, case_id: 'lost' }, 'unclassified', 'other', 'labeller.call_failed')];
    const production = productionLabels(labels, fam);
    expect(production.pairs).toEqual([{ path: 'other', family: 'claude' }, { path: 'sol', family: 'claude' }]);
    expect(production.byCase.has('s|lost')).toBe(false);
    const gates = gatePaths(set, production);
    expect(gates.map(g => [g.path, g.held_out, g.pass])).toEqual([['other', 0, false], ['sol', 100, true]]);
    expect(gates[0].reason).toMatch(/^0 held-out agreed rows/);
  });

  test('a report may not count a model label whose path and family have no passing gate; a failed call needs none', () => {
    const labels = [...produce(famSet(2, 'claude'), 'sol'), ...produce(famSet(1, 'gpt'), 'opus'), modelLabel({ ...base, case_id: 'lost' }, 'unclassified', 'x', 'labeller.call_failed'), classify(failure({ tool_calls: toolError }))];
    expect(ungated(labels, [{ path: 'sol', family: 'claude', pass: true }, { path: 'opus', family: 'gpt', pass: false }], fam)).toEqual([{ path: 'opus', family: 'gpt', labels: 1 }]);
    expect(ungated(labels, [], fam).map(u => u.path)).toEqual(['sol', 'opus']);
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

  test('report counts a row once when label files overlap, the last file winning, and refuses model labels without a passing gate', () => {
    const pending = residualLabel('w', 'r1');
    expect(pending.basis).toBe('needs_model');
    const deterministic = classify(failure({ source: 'w', case_id: 'd1', tool_calls: toolError }));
    const classified = ndjson('classified.ndjson', [deterministic, pending]);
    const labelled = ndjson('labelled.ndjson', [deterministic, modelLabel(pending, 'stale_fact', 'sol-labels-claude-rows')]);
    const args = ['report', '--labels', `${classified},${labelled}`, '--out-dir', join(dir, 'out'), '--heading', 'Week'];
    const refused = cli(args);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/model labels without a passing gate: sol-labels-claude-rows on sol-labels-claude-rows \(1\)/);
    const stamp = { taxonomy_version: TAXONOMY_VERSION, prompt_sha256: LABEL_PROMPT_SHA256 };
    const failing = join(dir, 'gates-fail.json');
    writeFileSync(failing, JSON.stringify({ ...stamp, gates: [{ path: 'sol-labels-claude-rows', family: 'sol-labels-claude-rows', pass: false }] }));
    expect(cli([...args, '--gates', failing]).status).toBe(1);
    const passing = join(dir, 'gates.json');
    writeFileSync(passing, JSON.stringify({ ...stamp, gates: [{ path: 'sol-labels-claude-rows', family: 'sol-labels-claude-rows', pass: true }] }));
    const r = cli([...args, '--gates', passing]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ failures: 2, pending: 0 });
    expect(out.top_three.map((t: { cause: string; count: number }) => [t.cause, t.count])).toEqual([['stale_fact', 1], ['tool_contract', 1]]);
    const nextNight = ndjson('next-night.ndjson', [{ ...deterministic, run_id: 'run-2' }]);
    const both = cli(['report', '--labels', `${classified},${labelled},${nextNight}`, '--out-dir', join(dir, 'out2'), '--heading', 'Week', '--gates', passing]);
    expect(JSON.parse(both.stdout)).toMatchObject({ failures: 3 });
  });

  test('report refuses a gate file stamped with another taxonomy or labeller prompt, or none; agree stamps its file and refuses older labels', () => {
    const pending = residualLabel('w', 'g1');
    const labels = ndjson('gated.ndjson', [modelLabel(pending, 'stale_fact', 'sol-labels-claude-rows')]);
    const gates = [{ path: 'sol-labels-claude-rows', family: 'sol-labels-claude-rows', pass: true }];
    const report = (file: string) => cli(['report', '--labels', labels, '--out-dir', join(dir, 'out-gated'), '--heading', 'Week', '--gates', file]);
    const write = (name: string, body: unknown) => { const f = join(dir, name); writeFileSync(f, JSON.stringify(body)); return f; };
    const unstamped = report(write('gates-unstamped.json', { gates }));
    expect(unstamped.status).toBe(1);
    expect(unstamped.stderr).toMatch(/gated under taxonomy unstamped and labeller prompt unstamped; this code is .*, so run agree again/);
    expect(report(write('gates-old-taxonomy.json', { taxonomy_version: '2026-11-09.2', prompt_sha256: LABEL_PROMPT_SHA256, gates })).stderr).toMatch(/gated under taxonomy 2026-11-09\.2/);
    expect(report(write('gates-old-prompt.json', { taxonomy_version: TAXONOMY_VERSION, prompt_sha256: '0'.repeat(64), gates })).stderr).toMatch(/labeller prompt 000000000000;/);
    expect(report(write('gates-current.json', { taxonomy_version: TAXONOMY_VERSION, prompt_sha256: LABEL_PROMPT_SHA256, gates })).status).toBe(0);
    const empty = ndjson('empty-set.ndjson', []);
    const out = join(dir, 'check-stamped.json');
    expect(cli(['agree', '--labelset', empty, '--production', labels, '--out', out]).status).toBe(1);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ taxonomy_version: TAXONOMY_VERSION, prompt_sha256: LABEL_PROMPT_SHA256 });
    const old = ndjson('old-labels.ndjson', [{ ...modelLabel(pending, 'stale_fact', 'sol-labels-claude-rows'), taxonomy_version: '2026-11-09.2' }]);
    const refused = cli(['agree', '--labelset', empty, '--production', old, '--out', join(dir, 'check-old.json')]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/production labels from taxonomy 2026-11-09\.2; this code is/);
  });
});

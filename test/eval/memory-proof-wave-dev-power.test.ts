import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimate, pairRows } from '../../eval/runner/memory-proof-wave-dev-power.ts';

function cell(root: string, name: string, scores: Record<string, number>, withCell = true): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'stages/judge'), { recursive: true });
  if (withCell) writeFileSync(join(dir, 'cell.json'), JSON.stringify({ spec: { split: '100k' }, resolved: { schedule_sha256: 's', schedule: Object.keys(scores) } }));
  for (const [qid, score] of Object.entries(scores)) writeFileSync(join(dir, 'stages/judge', `${qid}.json`), JSON.stringify({ query_id: qid, score }));
  return dir;
}

describe('dev power pairs', () => {
  test('one sample per side gives the paired difference per question, clustered by conversation', () => {
    const root = mkdtempSync(join(tmpdir(), 'mpw-power-'));
    const g = cell(root, 'g', { '3_temporal_reasoning_0': 1, '3_abstention_0': 0.5 });
    const c = cell(root, 'c', { '3_temporal_reasoning_0': 0, '3_abstention_0': 0.5 });
    const rows = pairRows(g, c);
    expect(rows.map(r => r.d)).toEqual([1, 0]);
    expect(new Set(rows.map(r => r.conversation))).toEqual(new Set(['100k/3']));
    expect(estimate(rows).n).toBe(2);
  });

  test('comma-separated answer samples are averaged per question before differencing', () => {
    const root = mkdtempSync(join(tmpdir(), 'mpw-power-'));
    const g1 = cell(root, 'g1', { '3_temporal_reasoning_0': 1, '3_abstention_0': 0 });
    const g2 = cell(root, 'g2', { '3_temporal_reasoning_0': 0, '3_abstention_0': 1 }, false);
    const c1 = cell(root, 'c1', { '3_temporal_reasoning_0': 0.5, '3_abstention_0': 0.5 });
    const rows = pairRows(`${g1},${g2}`, c1);
    expect(rows.map(r => r.d)).toEqual([0, 0]);
  });
});

describe('sealed analysis', () => {
  test('clusters sum paired differences in points per conversation and decides against the margin', async () => {
    const { analyse, clusters } = await import('../../eval/runner/memory-proof-wave-sealed-analysis.ts');
    const rows = [] as { split: string; conversation: string; qid: string; d: number }[];
    for (const [split, convs] of [['100k', 3], ['500k', 3]] as const)
      for (let c = 0; c < convs; c++) for (let q = 0; q < 4; q++) rows.push({ split, conversation: `${split}/${c}`, qid: `${c}_x_${q}`, d: (q % 2 ? 0.1 : -0.05) + c * 0.01 });
    const cl = clusters(rows);
    expect(cl.length).toBe(6);
    expect(cl.find(c => c.id === '100k/0')!.sum).toBeCloseTo(10, 6);
    const out = analyse(rows, 3.5, 199, 20261005);
    expect(out.questions).toBe(24);
    expect(out.primary.lower).toBeLessThanOrEqual(out.estimate_points);
    expect(out.primary.upper).toBeGreaterThanOrEqual(out.estimate_points);
    expect(['ahead', 'non-inferior', 'behind', 'inconclusive']).toContain(out.outcome);
  });

  test('an unscored question, rubric item or failed context gate makes the outcome inconclusive whatever the bounds say', async () => {
    const { analyse, incompleteness } = await import('../../eval/runner/memory-proof-wave-sealed-analysis.ts');
    const root = mkdtempSync(join(tmpdir(), 'mpw-sealed-'));
    const dir = join(root, 'c');
    mkdirSync(join(dir, 'stages/judge'), { recursive: true });
    const schedule = ['1_a_0', '1_a_1', '1_a_2', '1_a_3', '1_a_4'];
    writeFileSync(join(dir, 'cell.json'), JSON.stringify({ cell_id: 'c', spec: { split: '100k' }, resolved: { schedule_sha256: 's', schedule } }));
    const judge = (qid: string, r: object) => writeFileSync(join(dir, 'stages/judge', `${qid}.json`), JSON.stringify({ query_id: qid, ...r }));
    judge('1_a_0', { outcome: 'answered', score: 1, rubric: [{ score: 1 }] });
    judge('1_a_1', { outcome: 'judge_failure', score: null, rubric: [{ score: null }] });
    judge('1_a_2', { outcome: 'answered', score: 0.5, rubric: [{ score: 1 }, { score: null }] });
    judge('1_a_3', { outcome: 'incomplete_ingest', score: 0, rubric: [] });
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({ delivered_context: { ok: false } }));
    expect(incompleteness(dir).map(i => i.kind).sort()).toEqual(['delivered_context_gate', 'judge_failure', 'no_scored_row', 'unscored_rubric_item']);

    const rows = [] as { split: string; conversation: string; qid: string; d: number }[];
    for (let c = 0; c < 6; c++) for (let q = 0; q < 4; q++) rows.push({ split: '100k', conversation: `100k/${c}`, qid: `${c}_x_${q}`, d: 0.2 + 0.01 * q });
    expect(analyse(rows, 3.5, 199, 20261005).outcome).toBe('ahead');
    const out = analyse(rows, 3.5, 199, 20261005, [{ cell_id: 'c', kind: 'judge_failure', query_id: '1_a_1' }]);
    expect(out.outcome_from_bounds).toBe('ahead');
    expect(out.outcome).toBe('inconclusive');
    expect(out.complete).toBe(false);
    expect(out.incomplete).toEqual({ c: { judge_failure: 1 } });
    expect(JSON.stringify(out)).not.toContain('1_a_1');
  });
});

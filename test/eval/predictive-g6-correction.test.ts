/**
 * The 2026-11-17 G6 correction, keyless: the committed log rescored by rescore-probe-race.ts gives exactly the published
 * scorecards and comparison, and touches only the three local episodes the probe race marked.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { scorecards } from '../../eval/runner/predictive/run.ts';
import { G6_DIR, pairedG6, rescoreProbeRace } from '../../eval/runner/predictive/out-of-view/rescore-probe-race.ts';
import type { OutOfViewEpisode } from '../../eval/runner/predictive/out-of-view/agent.ts';

const done = gunzipSync(readFileSync(join(G6_DIR, 'episodes.jsonl.gz'))).toString().trim().split('\n').map(l => JSON.parse(l))
  .filter(r => r.status === 'done').map(r => r.record as OutOfViewEpisode);
const published = JSON.parse(readFileSync(join(G6_DIR, 'scorecard.json'), 'utf8'));

describe('G6 probe-race correction', () => {
  const { fixed, changed } = rescoreProbeRace(done);

  test('only three local episodes differ from the intended view, and each rescores to correct', () => {
    expect(changed.map(c => c.key)).toEqual(['g6:claude-opus-5-5:oov-7-p002:local:0', 'g6:particle-1:oov-7-p012:local:1', 'g6:particle-1:oov-7-p030:local:3']);
    expect(changed.every(c => c.old.verdict === 'answered_without_gold' && c.new.verdict === 'correct')).toBe(true);
    expect(fixed.filter((r, i) => r !== done[i])).toHaveLength(3);
  });

  test('refuses a remote record that differs from the intended view', () => {
    const i = done.findIndex(r => r.caller === 'remote');
    const rows = done.map((r, j) => j === i ? { ...r, out_of_view: [...r.out_of_view, 'notes/not-a-page'] } : r);
    expect(() => rescoreProbeRace(rows)).toThrow(/remote record .* differs from the intended view/);
  });

  test('the committed scorecard holds the rescored cards and the original ones the log reproduces', () => {
    expect(published.scorecards).toEqual(JSON.parse(JSON.stringify(scorecards('g6', fixed, 4))));
    expect(published.correction.original_scorecards).toEqual(JSON.parse(JSON.stringify(scorecards('g6', done, 4))));
    expect(published.correction.rescored).toEqual(changed.map(c => c.key));
  });

  test('the local Opus - particle-1 comparison moves from +2.5 (0.0 to +5.5) to +2.0 (+0.5 to +4.0)', () => {
    const local = (rows: readonly OutOfViewEpisode[]) => pairedG6(rows).find(c => c.caller === 'local' && c.comparison.endsWith('particle-1'))!;
    expect(local(done)).toMatchObject({ difference_points: 2.5, ci95_points: [0, 5.5], tasks_worse: 1, tasks_better: 5 });
    expect(local(fixed)).toMatchObject({ difference_points: 2, ci95_points: [0.5, 4], tasks_worse: 0, tasks_better: 4 });
  });
});

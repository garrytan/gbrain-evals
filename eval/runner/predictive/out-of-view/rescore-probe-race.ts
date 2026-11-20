/**
 * Keyless correction of the counted G6 run (2026-11-17). Before #477 the episode harness probed a task's gold pages
 * concurrently. For the local caller each probe is its own `gbrain call` process on a single-writer PGLite brain, so a
 * second probe could fail while the first held the brain, and the harness then recorded a readable page as out of view.
 * The world's local view holds every gold page by construction, so a local record whose out_of_view isn't empty was
 * marked by that race.
 *
 *   bun eval/runner/predictive/out-of-view/rescore-probe-race.ts [--write]
 *
 * Reads the committed episode log, which stays unchanged, and rescores every such local record with the counted scorer
 * against the intended task. It refuses if any remote record differs from the intended view, because nothing here can
 * tell a race from a real hide for that caller. It checks that the log reproduces the published scorecards, rebuilds
 * them with the rescored records, and recomputes the paired G6 comparisons (per-task success, Opus minus the other
 * model, percentile bootstrap over tasks with 10,000 draws and seed 2005, the published method). With
 * --write it replaces scorecard.json's scorecards, records the correction there, and writes correction-2026-11-17.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { clusteredPairedDelta } from '../../stats/paired.ts';
import { scorecards } from '../run.ts';
import { g6Tasks, g6World, scoreOutOfViewEpisode, type OutOfViewEpisode } from './agent.ts';

export const G6_DIR = 'docs/benchmarks/predictive-measures/g6';
const OPUS = 'claude-opus-5-5';
export const COMPARISONS = [['local', 'particle-1'], ['local', 'gpt-6.1-sol'], ['remote', 'particle-1'], ['remote', 'gpt-6.1-sol']] as const;

export function rescoreProbeRace(records: readonly OutOfViewEpisode[]) {
  const world = g6World();
  const tasks = new Map(g6Tasks(world).map(t => [t.id, t]));
  const same = (a: readonly string[], b: readonly string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const changed: Array<{ key: string; out_of_view: string[]; citations: unknown; old: { verdict: string; cause: string }; new: { verdict: string; cause: string } }> = [];
  const fixed = records.map(r => {
    const task = tasks.get(r.task_id);
    if (!task) throw new Error(`unknown G6 task ${r.task_id}`);
    if (same(r.out_of_view, task.out_of_view[r.caller])) return r;
    if (r.caller !== 'local') throw new Error(`remote record ${r.model}:${r.task_id}:${r.trial} differs from the intended view; this correction covers the local probe race only`);
    const next = scoreOutOfViewEpisode({ world, task, caller: r.caller, model: r.model, trial: r.trial, calls: Array(r.brain_calls).fill(null), final: r.answer, usd: r.usd, stop: r.stop });
    changed.push({ key: `g6:${r.model}:${r.task_id}:${r.caller}:${r.trial}`, out_of_view: r.out_of_view, citations: (r.answer as { citations?: unknown } | null)?.citations ?? null,
      old: { verdict: r.verdict, cause: r.cause }, new: { verdict: next.verdict, cause: next.cause } });
    return next;
  });
  return { fixed, changed };
}

export function pairedG6(records: readonly OutOfViewEpisode[]) {
  const rate = (model: string, caller: string) => {
    const m = new Map<string, number>();
    for (const r of records) if (r.model === model && r.caller === caller) m.set(r.task_id, (m.get(r.task_id) ?? 0) + (r.success ? 1 : 0));
    const trials = new Map<string, number>();
    for (const r of records) if (r.model === model && r.caller === caller) trials.set(r.task_id, (trials.get(r.task_id) ?? 0) + 1);
    return new Map([...m].map(([id, s]) => [id, s / trials.get(id)!]));
  };
  return COMPARISONS.map(([caller, other]) => {
    const a = rate(other, caller), b = rate(OPUS, caller);
    const ids = [...b.keys()].sort();
    if (ids.length !== a.size || ids.some(id => !a.has(id))) throw new Error(`G6 ${caller}: ${OPUS} and ${other} cover different tasks`);
    const d = clusteredPairedDelta(ids.map(id => ({ id, cluster: id, a: a.get(id)!, b: b.get(id)! })), { seed: 2005, draws: 10_000 });
    const pts = (x: number) => Math.round(x * 1000) / 10;
    return { caller, comparison: `${OPUS} - ${other}`, difference_points: pts(d.delta), ci95_points: d.ci95 ? d.ci95.map(pts) : null,
      tasks_worse: ids.filter(id => b.get(id)! < a.get(id)!).length, tasks_better: ids.filter(id => b.get(id)! > a.get(id)!).length };
  });
}

if (import.meta.main) {
  const write = process.argv.includes('--write');
  const log = gunzipSync(readFileSync(join(G6_DIR, 'episodes.jsonl.gz'))).toString().trim().split('\n').map(l => JSON.parse(l));
  const done = log.filter(r => r.status === 'done').map(r => r.record as OutOfViewEpisode);
  const path = join(G6_DIR, 'scorecard.json');
  const published = JSON.parse(readFileSync(path, 'utf8'));
  const original = scorecards('g6', done, 4);
  const reproduces = JSON.stringify(original) === JSON.stringify(published.correction ? published.correction.original_scorecards : published.scorecards);
  if (!reproduces) throw new Error('the committed log does not reproduce the published G6 scorecards; refusing to correct');
  const { fixed, changed } = rescoreProbeRace(done);
  const corrected = scorecards('g6', fixed, 4);
  const report = {
    schema: 'gbrain-evals/predictive-g6-correction/v1', date: '2026-11-17', script: 'eval/runner/predictive/out-of-view/rescore-probe-race.ts',
    reason: 'Local gold marked out of view by a probe race: concurrent gbrain call probes on one single-writer PGLite brain (fixed in #477).',
    rescored: changed,
    paired: { method: 'per-task success, percentile bootstrap over tasks, 10,000 draws, seed 2005 (eval/runner/stats/paired.ts)', uncorrected: pairedG6(done), corrected: pairedG6(fixed) },
    scorecards: { original, corrected },
  };
  console.log(JSON.stringify({ rescored: changed, paired: report.paired }, null, 2));
  if (write) {
    writeFileSync(join(G6_DIR, 'correction-2026-11-17.json'), JSON.stringify(report, null, 2) + '\n');
    const { correction: _drop, ...rest } = published;
    writeFileSync(path, JSON.stringify({ ...rest, scorecards: corrected, correction: { date: '2026-11-17', file: 'correction-2026-11-17.json', rescored: changed.map(c => c.key), original_scorecards: original } }, null, 2) + '\n');
  }
}

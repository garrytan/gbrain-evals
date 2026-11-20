/**
 * The fix ledger (eval/runner/sota/ledger.ts): each contrast on fixture nights, each cluster unit (the conversation for
 * BEAM and RS1, the question for LongMemEval, the task within its world for Cat 40) and the detectable difference each
 * contrast states, plus release shares, revert verdicts at their edges and the kill rule. Keyless.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DevSet } from '../../eval/runner/nightly/devset.ts';
import type { Outcome } from '../../eval/runner/nightly/outcome.ts';
import type { Fix } from '../../eval/runner/nightly/report.ts';
import { clusterOf, compareVersion, devResult, killRule, main, pairedContrast, releaseShares, revertVerdict, type Contrast, type Night } from '../../eval/runner/sota/ledger.ts';
import { row } from './nightly-fixtures.ts';

const roots: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'sota-ledger-')); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

const NIGHT = '2026-11-23';
/** Six conversations of three questions: stable fails all, master passes conversations 1 to 4. */
const beamItems = Array.from({ length: 6 }, (_, c) => Array.from({ length: 3 }, (_, q) => `conv-${c + 1}:event_ordering:${q}`)).flat();
const on = (ref: 'master' | 'stable', suite: string, items: string[], pass: (item: string) => boolean, o: Partial<Outcome> = {}) =>
  items.map(item => row({ night: NIGHT, ref, suite, item, pass: pass(item), score: pass(item) ? 1 : 0, ...o }));
const improved = (item: string) => Number(item.split(':')[0]!.slice(5)) <= 4;

describe('cluster units', () => {
  test('conversation for BEAM and RS1, question for LongMemEval, task within its world for Cat 40, else the item', () => {
    expect(clusterOf('beam-1m-hard', 'beam-1m', '1m-24:event_ordering:0')).toEqual({ unit: 'conversation', cluster: '1m-24' });
    expect(clusterOf('rs1-heldout', null, 'rs1-c07:temporal_reasoning:3')).toEqual({ unit: 'conversation', cluster: 'rs1-c07' });
    expect(clusterOf('lme-s-hard', 'lme-s', '08f4fc43')).toEqual({ unit: 'question', cluster: '08f4fc43' });
    expect(clusterOf('cat40-hard-m', null, 'H1-02')).toEqual({ unit: 'task', cluster: 'm/H1-02' });
    expect(clusterOf('refresh-barrier-agents', null, '1001')).toEqual({ unit: 'item', cluster: '1001' });
  });

  test('the unit sets the clusters, the interval and the detectable difference on the same outcomes', () => {
    const stable = on('stable', 'beam-1m-hard', beamItems, () => false), master = on('master', 'beam-1m-hard', beamItems, improved);
    const beam = pairedContrast(stable, master, { suite: 'beam-1m-hard', benchmark: 'beam-1m' })!;
    expect(beam).toMatchObject({ unit: 'conversation', pairs: 18, clusters: 6, delta_points: 66.67 });
    expect(beam.mde_points).toBeCloseTo(59.06, 1);
    expect(beam.note).toContain('80% power');
    const relabel = (rows: Outcome[]) => rows.map(r => ({ ...r, suite: 'lme-s-hard' }));
    const lme = pairedContrast(relabel(stable), relabel(master), { suite: 'lme-s-hard', benchmark: 'lme-s' })!;
    expect(lme).toMatchObject({ unit: 'question', pairs: 18, clusters: 18, delta_points: 66.67 });
    expect(lme.mde_points).toBeCloseTo(32.03, 1);
    expect(lme.ci95_points![1] - lme.ci95_points![0]).toBeLessThan(beam.ci95_points![1] - beam.ci95_points![0]);
  });

  test('Cat 40 pools a task\'s trials and clusters by task', () => {
    const tasks = ['H1-02', 'H1-03', 'H1-04', 'H1-05'];
    const trials = (ref: 'master' | 'stable', pass: (t: string, k: number) => boolean) => tasks.flatMap(t => [1, 2, 3].map(k => row({ night: NIGHT, ref, suite: 'cat40-hard-m', item: t, trial: k, pass: pass(t, k) })));
    const c = pairedContrast(trials('stable', () => false), trials('master', (t, k) => t !== 'H1-05' && k <= 2), { suite: 'cat40-hard-m', benchmark: null })!;
    expect(c).toMatchObject({ unit: 'task', pairs: 4, clusters: 4, delta_points: 50 });
    expect(c.mde_points).not.toBeNull();
  });

  test('a contrast with one cluster states that nothing is detectable', () => {
    const items = ['conv-1:a:0', 'conv-1:a:1'];
    const c = pairedContrast(on('stable', 'beam-1m-hard', items, () => false), on('master', 'beam-1m-hard', items, i => i.endsWith('0')), { suite: 'beam-1m-hard', benchmark: 'beam-1m' })!;
    expect(c).toMatchObject({ clusters: 1, ci95_points: null, mde_points: null });
    expect(c.note).toContain('only 1 cluster');
    expect(pairedContrast([], [], { suite: 'beam-1m-hard', benchmark: 'beam-1m' })).toBeNull();
  });
});

const DEVSET: DevSet = {
  version: 2, readers: ['gpt-6.1-sol'], k: { agent: 3, qa: 1, replay: 1, trials: 3, smoke: 1 }, reserved: [], digest: 'devset-test',
  suites: [
    { id: 'beam-1m-hard', kind: 'qa', scoring: 'judge', about: 't', source: 't', config: { benchmark: 'beam-1m' }, items: beamItems.map(id => ({ id, role: 'headroom' })) },
    { id: 'refresh-barrier-agents', kind: 'agent', scoring: 'deterministic', about: 't', source: 't', items: ['1001', '1002'].map(id => ({ id, role: 'headroom' })) },
  ],
};
const DEV = beamItems.filter(i => /^conv-[1-3]:/.test(i));
const FIX: Fix = { issue: 'GST-3001', pr: 'gbrain#9200', gbrain_version: '0.60.670.0', suite: 'beam-1m-hard', items: DEV,
  target: { bucket: 'retrieval_lost', cause: 'wrong_ranking', signature: 'sota:retrieval_lost:wrong_ranking', held_out_share: 0.1 } };
const night = (ref: 'master' | 'stable', version: string | null, rows: Outcome[], n = NIGHT): Night => ({ manifest: { night: n, version, suites: [] }, rows: rows.map(r => ({ ...r, ref, night: n })) });
const untouched = beamItems.filter(i => !DEV.includes(i));
function nights(): { master: Night; stable: Night } {
  const stable = [...on('stable', 'beam-1m-hard', beamItems, i => untouched.indexOf(i) >= 0 && untouched.indexOf(i) < 6),
    ...['1001', '1002'].flatMap(i => [1, 2, 3].map(k => row({ suite: 'refresh-barrier-agents', item: i, trial: k, pass: true })))];
  const master = [...on('master', 'beam-1m-hard', beamItems, i => (DEV.includes(i) && !i.startsWith('conv-3:')) || (untouched.indexOf(i) >= 0 && untouched.indexOf(i) < 5)),
    ...['1001', '1002'].flatMap(i => [1, 2, 3].map(k => row({ suite: 'refresh-barrier-agents', item: i, trial: k, pass: i === '1002' })))];
  return { master: night('master', '0.60.671.0', master), stable: night('stable', '0.60.660.0', stable) };
}

describe('dev result', () => {
  test('the dev contrast, noise baseline, collateral losses, success rate and D6a prediction', () => {
    const { master, stable } = nights();
    const r = devResult(FIX, master, stable, DEVSET);
    expect(r).toMatchObject({ issue: 'GST-3001', status: 'measured', reason: null, master_version: '0.60.671.0', stable_version: '0.60.660.0' });
    expect(r.dev).toMatchObject({ unit: 'conversation', pairs: 9, clusters: 3, delta_points: 66.67 });
    expect(r.dev!.mde_points).not.toBeNull();
    expect(r.noise).toMatchObject({ flip_share: 0.1111, outcomes: 9 });
    expect(r.noise.contrast).toMatchObject({ unit: 'conversation', pairs: 9, clusters: 3, delta_points: -11.11 });
    expect(r.collateral).toEqual({ losses: ['refresh-barrier-agents|1001|gpt-6.1-sol', 'beam-1m-hard|conv-5:event_ordering:2|gpt-6.1-sol'].sort(), gains: [], pairs: 11 });
    expect(r.success_rate).toBe(0.6667);
    expect(r.prediction).toMatchObject({ held_out_share: 0.1, prior: 0.5, points: 3.33 });
  });

  test('only on a night when master carries the fix and stable does not', () => {
    const { master, stable } = nights();
    expect(devResult({ ...FIX, gbrain_version: '0.60.672.0' }, master, stable, DEVSET)).toMatchObject({ status: 'not_applicable', reason: 'master 0.60.671.0 predates the fix (0.60.672.0)', dev: null });
    expect(devResult({ ...FIX, gbrain_version: '0.60.660.0' }, master, stable, DEVSET)).toMatchObject({ status: 'not_applicable', reason: 'stable 0.60.660.0 already carries the fix (0.60.660.0)' });
    expect(devResult(FIX, master, night('stable', '0.60.660.0', stable.rows, '2026-11-22'), DEVSET).reason).toContain('same-night only');
    expect(devResult(FIX, night('master', null, master.rows), stable, DEVSET).reason).toBe('a night records no gbrain version');
    expect(devResult({ ...FIX, items: ['conv-9:x:0'] }, master, stable, DEVSET).reason).toBe('no dev item ran on both refs');
  });

  test('no held-out share yet means no prediction in points', () => {
    const { master, stable } = nights();
    expect(devResult({ ...FIX, target: { ...FIX.target!, held_out_share: null } }, master, stable, DEVSET).prediction).toMatchObject({ held_out_share: null, points: null, success_rate: 2 / 3 });
  });

  test('harness and skipped rows stay out of the dev and noise contrasts', () => {
    const { master, stable } = nights();
    const base = devResult(FIX, master, stable, DEVSET);
    const broke = (item: string, patch: Partial<Outcome>) => ({ ...master.rows.find(r => r.item === item)!, trial: 2, pass: false, ...patch });
    const noisy: Night = { ...master, rows: [...master.rows, broke(DEV[0]!, { harness: { error: 'provider 500' } }), broke(untouched[0]!, { skipped: 'not scheduled' })] };
    const r = devResult(FIX, noisy, stable, DEVSET);
    expect(r.dev!.delta_points).toBe(base.dev!.delta_points);
    expect(r.noise.contrast!.delta_points).toBe(base.noise.contrast!.delta_points);
  });

  test('collateral compares only items both refs ran the same number of trials', () => {
    const { master, stable } = nights();
    const oneTrial: Night = { ...stable, rows: stable.rows.filter(r => r.suite !== 'refresh-barrier-agents' || r.trial === 1) };
    expect(devResult(FIX, master, oneTrial, DEVSET).collateral).toEqual({ losses: ['beam-1m-hard|conv-5:event_ordering:2|gpt-6.1-sol'], gains: [], pairs: 9 });
  });

  test('versions compare numerically', () => {
    expect(compareVersion('0.60.671.0', '0.60.670.0')).toBe(1);
    expect(compareVersion('0.60.99.0', '0.60.100.0')).toBe(-1);
    expect(compareVersion('0.60.670', '0.60.670.0')).toBe(0);
  });

  test('the command reads two night directories and writes the ledger', () => {
    const { master, stable } = nights();
    const dir = scratch();
    for (const [ref, n] of [['master', master], ['stable', stable]] as const) {
      mkdirSync(join(dir, ref));
      writeFileSync(join(dir, ref, 'night.json'), JSON.stringify({ schema: 'nightly-night/1', ref, sha: 'a'.repeat(40), tier: 'nightly', fake: true, devset: { path: 'x', digest: 'y' }, started_at: 'z', ...n.manifest }));
      writeFileSync(join(dir, ref, 'outcomes.jsonl'), n.rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    }
    writeFileSync(join(dir, 'fixes.json'), JSON.stringify({ fixes: [FIX] }));
    const logs: string[] = [];
    expect(main(['dev', '--master', join(dir, 'master'), '--stable', join(dir, 'stable'), '--fixes', join(dir, 'fixes.json'), '--out', join(dir, 'ledger.json')], s => logs.push(s), DEVSET)).toBe(0);
    const out = JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8'));
    expect(out).toMatchObject({ schema: 'sota-ledger/1', night: NIGHT, results: [{ issue: 'GST-3001', status: 'measured', dev: { delta_points: 66.67 } }] });
    expect(JSON.parse(logs[0]!)[0]).toMatchObject({ issue: 'GST-3001', status: 'measured', noise: 0.1111, collateral: 2 });
    expect(() => main(['dev', '--master', join(dir, 'nope'), '--stable', join(dir, 'stable'), '--fixes', join(dir, 'fixes.json'), '--out', join(dir, 'x.json')], () => {}, DEVSET)).toThrow('holds no night.json');
  });
});

const contrast = (delta: number, ci: [number, number] | null): Contrast => ({ unit: 'conversation', pairs: 400, clusters: 20, delta_points: delta, ci95_points: ci, mde_points: 4, note: '' });

describe('held-out credit', () => {
  test('a release contrast is shared in proportion to the predictions', () => {
    expect(releaseShares(contrast(2, [0.5, 3.5]), [{ issue: 'a', predicted_points: 3 }, { issue: 'b', predicted_points: 1 }])).toEqual([
      { issue: 'a', share: 0.75, credited_points: 1.5 }, { issue: 'b', share: 0.25, credited_points: 0.5 }]);
    expect(releaseShares(contrast(2, [0.5, 3.5]), [{ issue: 'a', predicted_points: 3 }, { issue: 'b', predicted_points: null }]).map(s => s.share)).toEqual([null, null]);
  });

  test('a revert verdict only at 3 predicted points, decided at the interval edges', () => {
    expect(revertVerdict(2.99, contrast(5, [1, 9])).verdict).toBe('not_eligible');
    expect(revertVerdict(null, contrast(5, [1, 9])).verdict).toBe('not_eligible');
    expect(revertVerdict(3, null).verdict).toBe('pending');
    expect(revertVerdict(3, contrast(5, null)).verdict).toBe('pending');
    expect(revertVerdict(3, contrast(2, [0.01, 4])).verdict).toBe('helps');
    expect(revertVerdict(3, contrast(2, [0, 4])).verdict).toBe('cant_tell');
    expect(revertVerdict(3, contrast(-2, [-4, -0.01])).verdict).toBe('hurts');
    expect(revertVerdict(3, contrast(-2, [-4, 0])).verdict).toBe('cant_tell');
  });

  test('the kill rule needs three scored calls and fires only below the detectable difference with predictions over twice it', () => {
    const call = (quarter: string, gain: number, pred: number, rs1 = true) => ({ quarter, rs1_scored: rs1, targeted_gain_points: gain, mde_points: 3, predicted_points: pred });
    expect(killRule([call('2027Q1', 0, 9), call('2027Q2', 0, 9)]).fires).toBeNull();
    expect(killRule([call('2027Q1', 0, 9), call('2027Q2', 0, 9, false), call('2027Q3', 0, 9)]).fires).toBeNull();
    const fired = killRule([call('2026Q4', 9, 1), call('2027Q1', 1, 4), call('2027Q2', 1, 4), call('2027Q3', 1, 4)]);
    expect(fired).toMatchObject({ fires: true, gain_points: 3, predicted_points: 12, quarters: ['2027Q1', '2027Q2', '2027Q3'] });
    expect(fired.mde_points).toBeCloseTo(5.2, 1);
    expect(killRule([call('a', 2, 3.464), call('b', 2, 3.464), call('c', 2, 3.464)]).fires).toBe(false);
    expect(killRule([call('a', 0, 3.4), call('b', 0, 3.4), call('c', 0, 3.4)]).fires).toBe(false);
  });
});

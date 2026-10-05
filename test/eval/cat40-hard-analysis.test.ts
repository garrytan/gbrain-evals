/**
 * Cat 40 Hard analysis tools (plan 2026-10-05-cat40-hard): v1 and v2 record
 * readers in analyze.ts, rescore.ts, latency-replay.ts and holdout_stats.py
 * on duplicated-key and 5-session fixtures (ENG-F1, ENG-F2, DX-F14); the Hard
 * report (CEO-F8, CEO-F27); the freeze-rule analyzer and each of its
 * conditions (DX-F6, CEO-F5, CEO-F6, CEO-F20, ENG-F15); the Hard comparator,
 * primary endpoint, max-T intervals, weakest-family rule, cost per extra
 * success and planning MDD in holdout_stats.py (CEO-F10, CEO-F15, ENG-T1,
 * ENG-F16, CEO-T8). Everything here is hermetic ($0).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { freezeRule, hardAnalysis, incrementalCost, isHardInput, orderModels, wilson, type FreezeResult } from '../../eval/runner/cat40/analyze.ts';
import { rescore, rescoreHard } from '../../eval/runner/cat40/rescore.ts';
import { harnessToolMs, sampleReplayCalls } from '../../eval/runner/cat40/latency-replay.ts';
import { readRecords, type CellRecordV2 } from '../../eval/runner/cat40/records.ts';
import type { HardStopKind, HardWorld } from '../../eval/generators/hard/schema.ts';

const ROOT = resolve(import.meta.dir, '../..');
const FIX = join(ROOT, 'test/fixtures/cat40-hard');
const STATS = join(ROOT, 'docs/benchmarks/2026-10-02-model-ladder/holdout/holdout_stats.py');
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'cat40-hard-analysis-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const run = (cmd: string, args: string[]) => {
  try { return { code: 0, out: execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { const x = e as { status: number; stdout: string; stderr: string }; return { code: x.status, out: x.stdout + x.stderr }; }
};
const write = (lines: Array<object | string>, name = 'results.jsonl') => { const p = join(tmp(), name); writeFileSync(p, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'); return p; };
const fixtureLines = (name: string) => readFileSync(join(FIX, name), 'utf8').split('\n').filter(Boolean);
const SONNET = 'claude-sonnet-5-5', ASTRA = 'gpt-6-astra';

type Outcome = 'ok' | 'wrong' | HardStopKind;
/** A v2 record with one session (or `sessions` sessions), success when the outcome is 'ok'. */
function v2(model: string, arm: string, task: string, outcome: Outcome, o: { usd?: number; attempt?: number; repeat?: number; sessions?: number; agent_ms?: number } = {}): CellRecordV2 {
  const stop: HardStopKind = outcome === 'ok' || outcome === 'wrong' ? 'submitted' : outcome;
  const n = o.sessions ?? 1, usd = o.usd ?? 0.1, key = `${model}|${arm}|${task}|${o.repeat ?? 0}`, attempt = o.attempt ?? 1;
  const runOf = (i: number) => ({ model, final: stop === 'submitted' ? { answer: i < n ? 'RECORDED' : 'x', sources: [] } : null, stop, turns: 2, usage: { input: 10, output: 1, cache_read: 0, cache_write: 0, requests: 2 },
    usd: usd / n, ms: 1000, model_ms: 900, tool_ms: 100, tool_calls: [{ name: 'grep', ms: 50, chars: 10, truncated: false }] });
  const sessions = Array.from({ length: n }, (_, i) => ({ index: i + 1, role: (i + 1 < n ? 'record' : 'question') as 'record' | 'question', stop, usd: usd / n, run: runOf(i + 1) }));
  return {
    schema: 'cat40-cell-v2', key, attempt_id: `${key}#${attempt}`, attempt, model, provider: 'scripted', arm, task, family: task.slice(0, 2), variant: 'v', repeat: o.repeat ?? 0, stop,
    score: { success: outcome === 'ok', submitted: stop === 'submitted', said_wrong: false, unparseable_set: false, evidence_cited: [], missed_evidence: [], wrote: false },
    claims: null, sessions, run: sessions.at(-1)!.run, cost: { agent_usd: usd, embed_usd: 0, gbrain_usd: 0, judge_usd: 0 }, total_usd: usd, judge_usd: 0,
    timings: { queue_ms: 0, session_start_ms: 0, agent_ms: o.agent_ms ?? 2000, restore_ms: 0, judge_ms: 0 }, budget_run_id: null,
    experiment: { world_digest: 'w', scale: 'v1', max_turns: 8, tool_limits: 'hard', judge: 'gpt-6.1-sol' }, wall_ms: o.agent_ms ?? 2000, started_at: '2026-10-05T00:00:00Z',
  };
}
const asRecords = (xs: CellRecordV2[]) => xs as unknown as Array<Record<string, unknown>>;

describe('analyze.ts Hard report on duplicated-key and 5-session fixtures (ENG-F1, ENG-F2, DX-F14, CEO-F27)', () => {
  const attempts = readRecords([join(FIX, 'attempts.jsonl')]);

  test('canonical cells pick the clean retry, cost counts every attempt, and retries are reported per model and arm', () => {
    const a = hardAnalysis(attempts);
    expect(a).toMatchObject({ cells: 6, attempts: 7, retries: { [`${SONNET}|fs`]: 1 }, incomplete: [], grid_problems: [], cost_warnings: [] });
    const h1 = a.by_arm_family.fs.H1;
    expect(h1).toMatchObject({ cells: 1, successes: 1, attempts: 2, tool_calls_per_task: 2 });
    expect(h1.stops.harness_error).toBe(1);
    expect(h1.usd_per_task).toBeCloseTo(0.05, 12);
    expect(a.by_model_arm[SONNET].fs.usd_all_attempts).toBeCloseTo(0.02 + 0.03 + 0.04 + 0.05, 12);
    expect(a.by_arm.fs.stops.turn_cap).toBe(1);
    expect(a.usd_all_attempts).toBeCloseTo(0.14 + 0.015 + 7 * 0.001, 12);
    const both = hardAnalysis([...attempts, ...readRecords([join(FIX, 'results.jsonl')])]);
    expect(both).toMatchObject({ cells: 6, attempts: 7 });
    expect(both.by_model_arm[SONNET].fs.usd_all_attempts).toBeCloseTo(0.14, 12);
  });

  test('a 5-session H5 cell counts every session for tool calls, stops and cost; agent latency excludes restore', () => {
    const a = hardAnalysis(attempts);
    const h5 = a.by_arm_family.fs.H5;
    expect(h5.tool_calls_per_task).toBe(6);
    expect(h5.usd_per_task).toBeCloseTo(0.05, 12);
    expect(Object.keys(a.by_session.fs)).toEqual(['1', '2', '3', '4', '5']);
    expect(a.by_session.fs[5]).toEqual({ submitted: 1 });
    expect(h5.agent_p50_s).toBe(9);
    expect(h5.restore_p50_s).toBe(70);
    expect(h5.wall_p50_s).toBeCloseTo(79.355, 9);
    const tampered = attempts.map(r => (r.task === 'H5-01' && r.arm === 'fs' ? { ...r, total_usd: 0.01 } : r));
    expect(hardAnalysis(tampered).cost_warnings[0]).toContain('sessions ($0.0500 with embeddings and gbrain) differ from total_usd ($0.0100)');
  });

  test('the CLI prints the Hard report and --expect-grid exits 1 on a missing model', () => {
    const ok = run('bun', ['eval/runner/cat40/analyze.ts', join(FIX, 'attempts.jsonl')]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('## Hard tier');
    expect(ok.out).toContain(`Harness-error retries per model and arm: ${SONNET} / fs 1.`);
    expect(ok.out).toContain('| fs | H1 | 100% (1/1) | 2.00 | 0 | 0 | 0 | 0 | 1 | 0 | $0.0500 | $0.0500 | 4.0 |');
    const grid = run('bun', ['eval/runner/cat40/analyze.ts', join(FIX, 'attempts.jsonl'), '--expect-grid', `models=${SONNET},${ASTRA}`]);
    expect(grid.code).toBe(1);
    expect(grid.out).toContain('6 expected cells are missing');
    expect(run('bun', ['eval/runner/cat40/analyze.ts', join(FIX, 'attempts.jsonl'), '--expect-grid', 'observed;tasks=3']).code).toBe(0);
  });

  test('v1 records are not Hard input; models are listed with the ones people use most first', () => {
    expect(isHardInput([{ key: 'm|fs|A01|0', family: 'A' }])).toBe(false);
    expect(isHardInput([{ key: 'm|fs|H1-01|0', family: 'H1' }])).toBe(true);
    expect(orderModels(['zeta', ASTRA, 'claude-fable-5-1', 'alpha', 'gpt-6.1-sol', 'claude-opus-5-5', SONNET])).toEqual([SONNET, 'claude-opus-5-5', 'gpt-6.1-sol', 'claude-fable-5-1', ASTRA, 'alpha', 'zeta']);
  });
});

describe('incremental cost per extra success, ceilings and family preferences (CEO-T8, CEO-F8)', () => {
  test('dollars per extra success is the cost difference over the success difference, n/a at or below 0', () => {
    expect(incrementalCost({ usd_per_task: 0.3, success: 0.6 }, { usd_per_task: 0.1, success: 0.4 })).toBeCloseTo(1, 12);
    expect(incrementalCost({ usd_per_task: 0.3, success: 0.4 }, { usd_per_task: 0.1, success: 0.4 })).toBeNull();
    expect(incrementalCost({ usd_per_task: 0.05, success: 0.3 }, { usd_per_task: 0.1, success: 0.4 })).toBeNull();
    expect(incrementalCost({ usd_per_task: 0.05, success: 0.5 }, { usd_per_task: 0.1, success: 0.4 })).toBeCloseTo(-0.5, 12);
  });

  test('the report compares every arm with the comparator per model and pooled, flags ceilings and names the favored arm per family', () => {
    const tasks = ['H1-01', 'H1-02', 'H2-01', 'H2-02'];
    const recs = [
      ...tasks.map(t => v2(SONNET, 'fs', t, t === 'H1-01' ? 'wrong' : 'ok', { usd: 0.1 })),
      ...tasks.map(t => v2(SONNET, 'gbrain', t, 'ok', { usd: 0.2 })),
      ...tasks.map(t => v2(ASTRA, 'fs', t, 'ok', { usd: 0.1 })), ...tasks.map(t => v2(ASTRA, 'gbrain', t, 'ok', { usd: 0.3 })),
    ];
    const a = hardAnalysis(asRecords(recs), { comparator: 'fs' });
    const row = (m: string) => a.incremental.find(r => r.model === m && r.arm === 'gbrain')!;
    expect(row(SONNET).usd_per_extra_success).toBeCloseTo(0.1 / 0.25, 12);
    expect(row(ASTRA)).toMatchObject({ usd_per_extra_success: null, ceiling: true });
    expect(row('all').usd_per_extra_success).toBeCloseTo(0.15 / 0.125, 12);
    expect(a.ceiling_models).toEqual([ASTRA]);
    expect(a.favors).toEqual({ H1: { best: ['gbrain'], margin: 0.25 }, H2: { best: ['fs', 'gbrain'], margin: null } });
    const md = run('bun', ['eval/runner/cat40/analyze.ts', write(recs), '--comparator', 'fs']).out;
    expect(md).toContain(`${ASTRA} is at 100% on every arm it ran: uninformative for comparisons, not a tie.`);
    expect(md).toContain(`| ${ASTRA} | gbrain | $0.2000 | +0.0 pts | n/a | both at 100%: uninformative |`);
    expect(md).toContain('| H1 | 75% (3/4) | 100% (4/4) | gbrain by +25.0 pts |');
  });
});

describe('freeze-rule analyzer (DX-F6, CEO-F5, CEO-F6, CEO-F20, ENG-F15)', () => {
  const models = [SONNET, ASTRA];
  const tasks = Array.from({ length: 50 }, (_, i) => `H${Math.floor(i / 10) + 1}-${String((i % 10) + 1).padStart(2, '0')}`);
  type Spec = (model: string, arm: string, i: number) => Outcome;
  const base: Spec = (_m, arm, i) => arm === 'oracle' ? 'ok' : arm === 'fs' ? (i % 2 === 0 ? 'ok' : i % 10 === 1 ? 'turn_cap' : 'wrong') : (i % 5 < 2 ? 'ok' : 'wrong');
  const round = (spec: Spec, arms = ['fs', 'pg', 'oracle']) => models.flatMap(m => arms.flatMap(arm => tasks.map((t, i) => v2(m, arm, t, spec(m, arm, i)))));
  const freeze = (spec: Spec, arms?: string[]) => freezeRule(asRecords(round(spec, arms)));
  const verdicts = (r: FreezeResult) => Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'grid'].map(id => [id, r.checks.filter(c => c.id === id).every(c => c.pass)]));
  const allPass = { a: true, b: true, c: true, d: true, e: true, grid: true };

  test('Wilson intervals match the closed form', () => {
    const [lo, hi] = wilson(25, 50);
    expect(lo).toBeCloseTo(0.3664, 4);
    expect(hi).toBeCloseTo(0.6336, 4);
    expect(wilson(0, 0).every(Number.isNaN)).toBe(true);
    expect(wilson(10, 10)[1]).toBeCloseTo(1, 12);
  });

  test('a round inside the band passes every condition, with an interval beside each estimate', () => {
    const r = freeze(base);
    expect(verdicts(r)).toEqual(allPass);
    expect(r.pass).toBe(true);
    expect(r.pooled_arm).toBe('fs');
    const a = r.checks.find(c => c.id === 'a')!;
    expect(a).toMatchObject({ value: 0.5, k: 50, n: 100 });
    expect(a.ci95[0]).toBeCloseTo(0.4038, 4);
    expect(r.checks.find(c => c.id === 'e')).toMatchObject({ k: 10, n: 50, value: 0.2 });
    expect(r.next.join(' ')).toContain('no knob change');
  });

  test('(a) fails too easy and too hard, and names the first content knob group with the direction', () => {
    const easy = freeze((m, arm, i) => (arm === 'fs' ? (i % 10 < 8 ? 'ok' : 'wrong') : base(m, arm, i)));
    expect(verdicts(easy)).toEqual({ ...allPass, a: false });
    expect(easy.next[0]).toStartWith('Too easy: raise record counts (h1_min_members');
    const hard = freeze((m, arm, i) => (arm === 'fs' ? (i % 10 < 3 ? 'ok' : 'wrong') : arm === 'pg' ? (i % 5 < 1 ? 'ok' : 'wrong') : 'ok'));
    expect(verdicts(hard)).toEqual({ ...allPass, a: false });
    expect(hard.next[0]).toStartWith('Too hard: lower record counts');
  });

  test('(b) fails when one model leaves 20-80%, and reports models that straddle the band', () => {
    const one = freeze((m, arm, i) => (arm === 'fs' ? (m === SONNET ? (i % 10 < 9 ? 'ok' : 'wrong') : (i % 10 < 3 ? 'ok' : 'wrong')) : base(m, arm, i)));
    expect(verdicts(one)).toEqual({ ...allPass, b: false });
    expect(one.checks.filter(c => c.id === 'b' && !c.pass).map(c => c.label)).toEqual([`${SONNET}: better of fs and pg (fs)`]);
    expect(one.next[0]).toStartWith('Too easy');
    const split = freeze((m, arm, i) => (arm === 'fs' ? (m === SONNET ? (i % 10 < 9 ? 'ok' : 'wrong') : (i % 10 < 1 ? 'ok' : 'wrong')) : arm === 'pg' ? 'wrong' : 'ok'));
    expect(verdicts(split)).toEqual({ ...allPass, b: false });
    expect(split.next[0]).toContain('straddle the band');
  });

  test('the better of fs and pg is used for the pooled and per-model rules', () => {
    const r = freeze((m, arm, i) => (arm === 'pg' ? (i % 10 < 6 ? 'ok' : 'wrong') : base(m, arm, i)));
    expect(r.pooled_arm).toBe('pg');
    expect(r.checks.find(c => c.id === 'a')!.value).toBe(0.6);
    expect(r.checks.filter(c => c.id === 'b').every(c => c.label.endsWith('(pg)'))).toBe(true);
    const fsOnly = freeze(base, ['fs', 'oracle']);
    expect(fsOnly.pass).toBe(true);
    expect(fsOnly.checks[0].label).toBe('pooled fs success (fs only; pg not run)');
  });

  test('(c) fails on a model whose oracle is below 90%, and oracle failures must be classified before any knob change', () => {
    const fail = new Set([0, 10, 20, 30, 40, 1]);
    const r = freeze((m, arm, i) => (arm === 'oracle' && m === ASTRA && fail.has(i) ? 'wrong' : base(m, arm, i)));
    expect(verdicts(r)).toEqual({ ...allPass, c: false });
    expect(r.checks.find(c => c.id === 'c' && !c.pass)).toMatchObject({ label: `${ASTRA}: oracle`, k: 44, n: 50 });
    expect(r.next[0]).toContain('classify it as a wording or answer-key defect before any knob change');
    const edge = freeze((m, arm, i) => (arm === 'oracle' && m === ASTRA && i % 10 === 0 ? 'wrong' : base(m, arm, i)));
    expect(verdicts(edge).c).toBe(true);
  });

  test('(d) fails on a family whose pooled oracle is below 80% even when every model clears 90%', () => {
    const r = freeze((m, arm, i) => (arm === 'oracle' && i < 5 ? 'wrong' : base(m, arm, i)));
    expect(verdicts(r)).toEqual({ ...allPass, d: false });
    expect(r.checks.find(c => c.id === 'd' && !c.pass)).toMatchObject({ label: 'family H1: oracle, pooled over models', k: 10, n: 20 });
    expect(r.next[0]).toContain('answer-key defect');
  });

  test('(e) fails when more than half of the pooled arm\'s failures are turn_cap stops; exactly half passes', () => {
    const r = freeze((m, arm, i) => (arm === 'fs' ? (i % 2 === 0 ? 'ok' : [1, 3, 5].includes(i % 10) ? 'turn_cap' : 'wrong') : base(m, arm, i)));
    expect(verdicts(r)).toEqual({ ...allPass, e: false });
    expect(r.checks.find(c => c.id === 'e')).toMatchObject({ k: 30, n: 50 });
    expect(r.next.join(' ')).toContain('move content knobs, starting with record counts, not the turn cap');
    const half = freeze((m, arm, i) => (arm === 'fs' ? (i % 2 === 0 ? 'ok' : (m === SONNET ? [1, 3, 5] : [1, 3]).includes(i % 10) ? 'turn_cap' : 'wrong') : base(m, arm, i)));
    expect(half.checks.find(c => c.id === 'e')).toMatchObject({ k: 25, n: 50, pass: true });
  });

  test('a missing cell or a cell with only harness-error attempts fails the grid check; cost counts every attempt', () => {
    const recs = round(base);
    const dropped = recs.filter(r => !(r.arm === 'oracle' && r.task === 'H3-04' && r.model === SONNET));
    expect(verdicts(freezeRule(asRecords(dropped)))).toEqual({ ...allPass, grid: false });
    const retried = [...dropped, v2(SONNET, 'oracle', 'H3-04', 'harness_error', { usd: 0.5 })];
    const r = freezeRule(asRecords(retried));
    expect(r.grid_problems[0]).toBe('1 cells have no harness-clean attempt');
    expect(r.stops.oracle.stops.harness_error).toBe(1);
    expect(r.usd_all_attempts).toBeCloseTo(299 * 0.1 + 0.5, 9);
  });

  test('the CLI prints PASS or FAIL, appends the round to calibration.md and exits 0 or 1', () => {
    const md = join(tmp(), 'calibration.md');
    writeFileSync(md, '# Calibration\n');
    const ok = run('bun', ['eval/runner/cat40/analyze.ts', write(round(base)), '--freeze-rule', '--round', '3', '--calibration-md', md]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('Freeze rule, round 3: PASS.');
    expect(ok.out).toContain('| (a) pooled fs success (the better of fs and pg) | 50% (50/100) | [40.4, 59.6] | 40-70% | 100 | PASS |');
    const text = readFileSync(md, 'utf8');
    expect(text).toStartWith('# Calibration\n');
    expect(text).toMatch(/\n### Round 3 \(analyzer output, \d{4}-\d{2}-\d{2}\)\n\nFreeze rule, round 3: PASS\./);
    const bad = run('bun', ['eval/runner/cat40/analyze.ts', write(round((m, arm, i) => (arm === 'oracle' && i < 5 ? 'wrong' : base(m, arm, i)))), '--freeze-rule', '--round', '4', '--models', SONNET]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('Freeze rule, round 4: FAIL. Models: claude-sonnet-5-5.');
    expect(run('bun', ['eval/runner/cat40/analyze.ts', write(round(base)), '--freeze-rule']).code).toBe(2);
  });
});

describe('rescore.ts --hard (DX-F14, ENG-F6)', () => {
  const world = JSON.parse(readFileSync(join(FIX, 'world.json'), 'utf8')) as HardWorld;

  test('scores are recomputed from stored session finals and written beside the originals', () => {
    const { records, summary } = rescoreHard({ world, records: readRecords([join(FIX, 'attempts.jsonl')]) });
    expect(records).toHaveLength(7);
    const h5 = records.find(r => r.key === `${SONNET}|fs|H5-01|0`)!;
    expect(h5.score.success).toBe(false);
    expect(h5.rescored.score).toMatchObject({ success: true, wrote: true, recorded: [true, true, true, true] });
    expect(h5.rescored).toMatchObject({ scorer_version: 'cat40-hard-score-v1', success_changed: true });
    const retried = records.filter(r => r.task === 'H1-01' && r.arm === 'fs');
    expect(retried.map(r => r.rescored.score?.success)).toEqual([false, true]);
    expect(summary).toMatchObject({ lines: 7, canonical_cells: 6, changed: [{ key: `${SONNET}|fs|H5-01|0`, original: false, rescored: true }], by_arm: { fs: { cells: 3, success_original: 1, success_rescored: 2 }, oracle: { cells: 3, success_original: 3, success_rescored: 3 } } });
  });

  test('the CLI writes a new file and a summary, never overwrites the input, and v1 mode refuses v2 records', async () => {
    const out = tmp();
    const r = run('bun', ['eval/runner/cat40/rescore.ts', '--hard', '--world', join(FIX, 'world.json'), '--results', join(FIX, 'attempts.jsonl'), '--out', out]);
    expect(r.code).toBe(0);
    expect(existsSync(join(out, 'attempts.jsonl'))).toBe(true);
    expect(JSON.parse(readFileSync(join(out, 'rescore-summary.json'), 'utf8')).changed).toHaveLength(1);
    const after = run('bun', ['eval/runner/cat40/analyze.ts', join(out, 'attempts.jsonl'), '--use-rescored']).out;
    expect(after).toContain(`| ${SONNET} | 100% (3/3) | 67% (2/3) |`);
    const same = run('bun', ['eval/runner/cat40/rescore.ts', '--hard', '--world', join(FIX, 'world.json'), '--results', join(FIX, 'attempts.jsonl'), '--out', FIX]);
    expect(same.code).toBe(2);
    expect(same.out).toContain('never replaces the original records');
    await expect(rescore({ world: {} as never, resultsPath: join(FIX, 'attempts.jsonl'), transcriptsPath: '', receiptPaths: [], arms: ['fs'] })).rejects.toThrow('holds v2 (Hard) records');
  });
});

describe('latency-replay.ts on v2 records and transcripts', () => {
  test('harness tool latency counts every session of the canonical attempt only', () => {
    const ms = harnessToolMs(fixtureLines('attempts.jsonl'), 'fs');
    expect([...ms.grep].sort((a, b) => a - b)).toEqual([100, 110, 120, 130]);
    expect(ms.write).toEqual([20, 21, 22, 23]);
    expect(harnessToolMs(fixtureLines('results.jsonl'), 'fs')).toEqual(ms);
    const v1 = JSON.stringify({ arm: 'fs', run: { tool_calls: [{ name: 'grep', ms: 7 }] } });
    expect(harnessToolMs([...fixtureLines('attempts.jsonl'), v1], 'fs').grep).toContain(7);
  });

  test('replay calls come from the last attempt of each key, across every session', () => {
    const calls = sampleReplayCalls(fixtureLines('transcripts.jsonl'), 'gbrain-hard', 40);
    expect(calls.map(c => c.args.query)).toEqual(['kept-s1-0', 'kept-s3-2', 'h1-0', 'h1-10']);
  });
});

describe('holdout_stats.py on v2 records and the Hard modes (CEO-F10, CEO-F15, ENG-T1, ENG-F16, CEO-T8)', () => {
  const stats = (args: string[]) => run('python3', [STATS, ...args]);

  test('duplicated keys: the clean attempt is the cell and cost counts both; 5-session cells cost every session', () => {
    const r = stats([join(FIX, 'attempts.jsonl')]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Harness-error retries per model and arm: ${SONNET} / fs 1.`);
    expect(r.out).toContain('| fs | 3 | 3 | 1 |');
    expect(r.out).toMatch(/\| fs \| 0\.0467 \| 0\.1400 \|/);
    expect(r.out).toContain('- fs: $0.14');
    const both = stats([join(FIX, 'attempts.jsonl'), join(FIX, 'results.jsonl')]);
    expect(both.out).toContain('| fs | 3 | 3 | 1 |');
    expect(both.out).toContain('7 attempts');
    const lost = stats([write([v2(SONNET, 'fs', 'H1-01', 'harness_error', { usd: 0.2 }), v2(SONNET, 'fs', 'H1-02', 'ok')])]);
    expect(lost.out).toContain('Cells with no harness-clean attempt (missing from every table; $0.20 spent on all such cells): claude-sonnet-5-5|fs|H1-01|0.');
  });

  const tasks = ['H1-01', 'H1-02', 'H1-03', 'H1-04', 'H2-01', 'H2-02', 'H2-03', 'H2-04', 'H3-01', 'H3-02', 'H3-03', 'H3-04'];
  const arm = (name: string, ok: (i: number, m: string) => boolean, o: { models?: string[]; usd?: number } = {}) =>
    (o.models ?? [ASTRA, SONNET]).flatMap(m => tasks.map((t, i) => v2(m, name, t, ok(i, m) ? 'ok' : 'wrong', { usd: o.usd })));
  const simple = [...arm('fs', i => i % 3 !== 0), ...arm('pg', i => i % 4 !== 0), ...arm('memory', () => true, { models: [SONNET] }),
    ...arm('oracle', (i, m) => m === SONNET || i > 1)];

  test('the Hard comparator is the best pooled simple arm run on every model', () => {
    const r = stats([write(simple), '--hard-comparator', 'fs,pg,memory']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('| memory | 12 | 1 | 100.0% | 0.1000 | no: not run on gpt-6-astra |');
    expect(r.out).toContain('Comparator: pg (best pooled success among arms run on every model');
    expect(r.out).toContain(`Models: ${SONNET}, ${ASTRA}.`);
  });

  test('headline: primary endpoint, max-T simultaneous intervals, the weakest family named when its CI excludes 0, bar flags and missing comparisons', () => {
    const r = stats([write([...simple, ...arm('gbrain-hard', i => i < 4 || i > 7, { usd: 0.2 })]), '--hard-headline', 'gbrain-hard,pg']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Primary endpoint: pooled paired difference gbrain-hard minus pg = -8.3 pp');
    expect(r.out).toMatch(/\| family H2 \| 0\.0% \| 75\.0% \| 4 \| -75\.0 pp \|/);
    expect(r.out).toContain('gbrain-hard trails pg most in family H2: -75.0 pp');
    expect(r.out).toContain('which excludes 0. The family-level decision sentence may name family H2.');
    const crit = Number(r.out.match(/critical value ([\d.]+) bootstrap SEs/)![1]);
    expect(crit).toBeGreaterThan(1.9);
    const pointwise = r.out.match(/\| all models \(primary\) \| [^|]+ \| [^|]+ \| 12 \| [^|]+ \| \[([-+\d.]+), ([-+\d.]+)\]/)!;
    const simult = r.out.match(/\| pg \(comparator\) \| [^|]+ \| [^|]+ \| \[([-+\d.]+), ([-+\d.]+)\]/)!;
    expect(Number(simult[2]) - Number(simult[1])).toBeGreaterThan(Number(pointwise[2]) - Number(pointwise[1]) - 0.2);
    expect(r.out).toMatch(/\| fs \| \+0\.0 pp \|/);
    expect(r.out).toContain(`- ${ASTRA}: oracle 83.3% is below 90%`);
    expect(r.out).toContain('- gbrain-hard against memory: memory was not run on gpt-6-astra');
    expect(r.out).toContain('| all | 0.2000 | 0.3000 | 0.1000 | 0.1333 | n/a |');
  });

  test('the weakest-family rule falls back to mechanism evidence when the CI includes 0; ceilings are uninformative; cost per extra success', () => {
    const fallback = stats([write([...simple, ...arm('gbrain-hard', i => i % 4 !== 0 && i !== 5)]), '--hard-headline', 'gbrain-hard,pg']);
    expect(fallback.out).toContain('but its 95% CI');
    expect(fallback.out).toContain('includes 0. No family is named; the choice falls back to mechanism evidence');
    const ceiling = stats([write([...arm('pg', (i, m) => m === SONNET || i % 4 !== 0), ...arm('gbrain-hard', () => true, { usd: 0.2 })]), '--hard-headline', 'gbrain-hard,pg', '--simple', 'pg']);
    expect(ceiling.out).toContain(`- ${SONNET}: comparator 100.0% is above 80%; oracle not run, so the oracle bar is unchecked; gbrain-hard and pg both at 100%: uninformative, not a tie`);
    expect(ceiling.out).toContain('| gpt-6-astra | 0.2000 | 0.2000 | 0.1000 | 0.1333 | 0.4000 |');
    expect(ceiling.out).toContain('| all | 0.2000 | 0.2000 | 0.1000 | 0.1143 | 0.8000 |');
    expect(ceiling.out).toContain('gbrain-hard trails pg in no family');
  });

  test('the headline refuses incomplete coverage', () => {
    const r = stats([write([...simple.filter(x => !(x.arm === 'pg' && x.task === 'H3-02' && x.model === ASTRA)), ...arm('gbrain-hard', () => true)]), '--hard-headline', 'gbrain-hard,pg']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Refused: incomplete coverage (pg is missing 1 of 24 cells (first: gpt-6-astra/H3-02/0))');
  });

  test('planning MDD prints its formula, the stated and worst-case discordance, and the optimistic cell count', () => {
    const r = stats([write(arm('fs', i => i % 2 === 0)), '--hard-mdd', 'fs', '--mdd-tasks', '100']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Formula: MDD = (z_0.975 + z_0.80) * sqrt(psi / n) = 2.8016 * sqrt(psi / n)');
    expect(r.out).toContain('| stated, n = tasks (conservative: a task\'s models move together) | 0.5000 | 100 | 19.8 pts |');
    expect(r.out).toContain('| worst case, n = tasks | 1.0000 | 100 | 28.0 pts |');
    expect(r.out).toContain('| stated, n = cells (optimistic: cells independent) | 0.5000 | 200 | 14.0 pts |');
    expect(stats([write(arm('fs', i => i % 2 === 0)), '--hard-mdd', 'fs', '--discordance', '0.3']).out).toContain('| stated, n = tasks (conservative: a task\'s models move together) | 0.3000 | 12 | 44.3 pts |');
  });
});

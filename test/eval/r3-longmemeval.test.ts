/**
 * R3 (W10 preregistration, amendment of 2026-11-16): keyless checks of the newest-release re-run's guards, judges and
 * analysis. Every provider key is blanked, and every paid entry point must refuse before any client exists.
 */
import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
process.env.W10_STATE_DIR = join(tmpdir(), 'r3-test-' + process.pid);
process.env.W10_PARTICLE_STATE_DIR = join(tmpdir(), 'r3-test-particle-' + process.pid);
const { assertCrossFamily, assertR3Gbrain, r1, requireR3Window, R3_GBRAIN, R3_UNITS, subsets } = await import('../../eval/runner/batch/w10.ts');
const { judgeBody, officialJudgePrompt } = await import('../../eval/runner/batch/sources.ts');
const { kappa, plan, score, PER_SET } = await import('../../eval/runner/batch/r3-judge-check.ts');
const { report, strictRecall, RIDER_BAR } = await import('../../eval/runner/batch/r3-report.ts');
const { readNdjson } = await import('../../eval/runner/batch/sources.ts');
const { REPLAY_ARMS } = await import('../../eval/runner/batch/w10-particle.ts');

const ROOT = resolve(import.meta.dir, '../..');
const KEYLESS = { ...process.env, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', VOYAGE_API_KEY: '', PARTICLE_API_KEY: '', W10_STATE_DIR: process.env.W10_STATE_DIR!, W10_PARTICLE_STATE_DIR: process.env.W10_PARTICLE_STATE_DIR! };
const runBun = (args: string[]) => Bun.spawnSync(['bun', ...args], { cwd: ROOT, env: KEYLESS, stdout: 'pipe', stderr: 'pipe' });

describe('R3 paid-window guards', () => {
  test('a paid R3 step names its own window or refuses', () => {
    expect(() => requireR3Window([], R3_UNITS.batch)).toThrow(/paid window R3-B/);
    expect(() => requireR3Window(['--paid-window', 'R3-A'], R3_UNITS.batch)).toThrow(/got R3-A/);
    expect(() => requireR3Window(['--paid-window', 'R3-B'], R3_UNITS.batch)).not.toThrow();
  });

  test('the capture, the batch lane and the particle runner refuse R3 work without a window, before any client', () => {
    for (const args of [
      ['eval/runner/batch/w10a-capture.ts', '--r3'],
      ['eval/runner/batch/w10.ts', 'run', 'r3-sol-newest'],
      ['eval/runner/batch/w10.ts', 'judge', 'w10c-sol-full', 'opus'],
      ['eval/runner/batch/w10-particle.ts', 'run', 'r3-particle-newest', '--out', join(tmpdir(), 'r3-never-' + process.pid)],
      ['eval/runner/batch/r3-judge-check.ts', 'run', '--out', join(tmpdir(), 'r3-never-' + process.pid)],
    ]) {
      const p = runBun(args);
      expect(p.exitCode).not.toBe(0);
      expect(p.stderr.toString()).toMatch(/runs only inside paid window R3-[ABP]/);
    }
  });

  test('R3 runs only on its frozen gbrain build', () => {
    expect(R3_GBRAIN).toEqual({ version: '0.60.733.0', sha: '6ce7195b44a034f85aec811f11fbf862db376f50' });
    expect(() => assertR3Gbrain(join(ROOT, 'node_modules/gbrain'))).toThrow(/R3 runs gbrain v0\.60\.733\.0/);
  });
});

describe('R3 judges', () => {
  test('the Opus co-judge sends the official prompt with W10 secondary-judge room', () => {
    const q = r1().get('a06e4cfe')!;
    const body = judgeBody('opus', q, 'an answer') as any;
    expect(body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 2000, output_config: { effort: 'low' } });
    expect(body.messages).toEqual([{ role: 'user', content: officialJudgePrompt(q.question_type, q.question, q.answer, 'an answer', q.question_id.includes('_abs')) }]);
  });

  test('no R3 judge grades its own family', () => {
    expect(() => assertCrossFamily('r3-opus55-newest', 'opus')).toThrow(/never judges a Claude/);
    expect(() => assertCrossFamily('r3-sol-newest', 'secondary')).toThrow(/never judges a GPT/);
    expect(() => assertCrossFamily('w10c-sol-full', 'opus')).not.toThrow();
    expect(() => assertCrossFamily('r3-particle-full', 'secondary')).not.toThrow();
    expect(() => assertCrossFamily('r3-opus55-full', 'secondary')).not.toThrow();
  });

  test('the judge check draws a fixed, stratified pool and scores kappa', () => {
    const p = plan();
    expect(plan()).toEqual(p);
    for (const set of ['S', 'N'] as const) {
      const items = p.items.filter(i => i.set === set);
      expect(items.filter(i => i.official === 0).length).toBe(PER_SET.wrong);
      expect(items.filter(i => i.official === 1).length).toBe(PER_SET.right);
    }
    expect(new Set(p.items.filter(i => i.set === 'S').map(i => i.reader))).toEqual(new Set(['sol']));
    expect(new Set(p.items.filter(i => i.set === 'N').map(i => i.reader))).toEqual(new Set(['opus', 'particle']));
    expect(kappa([[true, true], [false, false], [true, false], [false, true]])).toBe(0);
    expect(kappa([[true, true], [false, false]])).toBe(1);
    const grades = p.items.flatMap(it => {
      const truth = it.official === 1;
      const g = (grader: string, verdict: boolean) => ({ grader, item_id: it.item_id, verdict, raw: verdict ? 'yes' : 'no', error: null, finish: 'stop', response_model: null, usage: null, usd: 0 });
      return [g('label-astra', truth), g('label-opus', truth), ...(it.set === 'S' ? [g('cojudge-opus', truth)] : [g('cojudge-sol', !truth)])];
    }) as any;
    const s = score(p.items, grades);
    expect(s.labeller_kappa).toBe(1);
    expect(s.judges['cojudge-opus'].pass).toBe(true);
    expect(s.judges['cojudge-sol'].pass).toBe(false);
    expect(s.pass).toBe(false);
  });
});

describe('R3 analysis inputs', () => {
  test('the rider reads strict recall@5 from harness rows: 449 at c5fb0201 and 451 at 109b992, bar 423', () => {
    const at = (p: string) => [...strictRecall(join(ROOT, p)).values()].reduce<number>((a, v) => a + v, 0);
    expect(at('docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin/capture/harness-rows.ndjson.gz')).toBe(449);
    expect(at('docs/benchmarks/2026-10-04-longmemeval-opaque-followups/1a-harness/FINAL/rows.ndjson.gz')).toBe(451);
    expect(strictRecall(join(ROOT, 'docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin/capture/harness-rows.ndjson.gz')).size).toBe(470);
    expect(RIDER_BAR).toBe(423);
  });

  test('particle-1 R3 arms read the 150 W10c questions at the replay settings', () => {
    expect(subsets.w10c150().length).toBe(150);
    for (const id of ['r3-particle-newest', 'r3-particle-full', 'r3-particle-currentpin']) expect(REPLAY_ARMS[id]).toMatchObject({ workstream: 'R3', effort: 'high' });
    expect(REPLAY_ARMS['r3-particle-full'].text).toBe('full');
    expect(REPLAY_ARMS['r3-particle-currentpin'].text).toBe('currentpin');
  });
});

describe('R3 report on fake rows', () => {
  const W10C_SOL = join(ROOT, 'docs/benchmarks/2026-10-07-longmemeval-w10c-full-context/arms');
  const sol = readNdjson(join(W10C_SOL, 'w10c-sol-full/rows.ndjson')).map(r => ({ id: r.question_id as string, ok: r.correct_official === 1 || r.correct_official === true }));
  const flipped = new Set(sol.filter(r => r.ok).slice(0, 30).map(r => r.id));
  const fixture = (cojudgeSolPasses: boolean) => {
    const r3 = mkdtempSync(join(tmpdir(), 'r3-report-fake-'));
    cpSync(join(ROOT, 'docs/benchmarks/2026-11-16-longmemeval-w10-newest/families'), join(r3, 'families'), { recursive: true });
    const put = (rel: string, rows: Record<string, unknown>[]) => { mkdirSync(join(r3, rel), { recursive: true }); writeFileSync(join(r3, rel, 'rows.ndjson'), rows.map(r => JSON.stringify(r)).join('\n') + '\n'); };
    const opus = sol.map(r => ({ question_id: r.id, correct_official: r.ok ? 1 : 0, correct_secondary: r.ok ? 1 : 0, error: null, usd: 0.01, list_usd: 0.02, finish: 'end_turn' }));
    put('arms/r3-opus55-full', opus);
    put('arms/r3-opus55-newest', opus);
    put('arms/r3-sol-newest', sol.map(r => { const ok = r.ok && !flipped.has(r.id); return { question_id: r.id, correct_official: ok ? 1 : 0, correct_opus: ok ? 1 : 0, error: null, usd: 0.01, list_usd: 0.01, finish: 'stop' }; }));
    for (const arm of ['w10c-sol-full', 'w10c-sol-currentpin']) put('judges/' + arm + '--opus', readNdjson(join(W10C_SOL, arm, 'rows.ndjson')).map(r => ({ question_id: r.question_id, correct: r.correct_official })));
    mkdirSync(join(r3, 'judge-check'), { recursive: true });
    writeFileSync(join(r3, 'judge-check/report.json'), JSON.stringify({ labeller_kappa: 1, judges: { 'cojudge-sol': { pass: cojudgeSolPasses, kappa: 1 }, 'cojudge-opus': { pass: true, kappa: 1 } } }));
    mkdirSync(join(r3, 'capture'), { recursive: true });
    cpSync(join(ROOT, 'docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin/capture/harness-rows.ndjson.gz'), join(r3, 'capture/harness-rows.ndjson.gz'));
    const out = mkdtempSync(join(tmpdir(), 'r3-report-out-'));
    return report(out, r3) as any;
  };

  test('an Opus arm equal to its whole history passes non-inferiority; a Sol arm 30 answers worse reads the loss under both judges', () => {
    const s = fixture(true);
    expect(s.verdicts['claude-opus-5-5'].claim).toBe('within 7 points (both judges)');
    expect(s.verdicts['gpt-6.1-sol'].claim).toBe('whole history better by more than 7 points (both judges)');
    expect(s.arms['r3-sol-newest'].official).toBe(111);
    expect(s.whole_history_wins_official['gpt-6.1-sol'].length).toBe(30);
    expect(s.rider_strict_recall_at_5.newest).toEqual({ hits: 449, of: 470 });
    expect(s.rider_strict_recall_at_5.heading_stays).toBe(true);
    expect(s.rider_strict_recall_at_5.vs_c5fb0201).toMatchObject({ n: 470, base: 449, candidate: 449 });
    expect(s.descriptive).toEqual({});
  }, 60_000);

  test('a co-judge that failed its check leaves its reader with no claim', () => {
    const s = fixture(false);
    expect(s.verdicts['claude-opus-5-5'].cojudge_passed_check).toBe(false);
    expect(s.verdicts['claude-opus-5-5'].claim).toMatch(/^no claim/);
    expect(s.verdicts['gpt-6.1-sol'].claim).toBe('whole history better by more than 7 points (both judges)');
  }, 60_000);
});

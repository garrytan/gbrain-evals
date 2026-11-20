/**
 * The fail-closed fixes the hard company questions' reviews asked for (#536's ruled notes, landed with #538), keyless:
 * the analysis needs both planned worlds and every planned task id, and refuses a counted cell that ended on a provider
 * 5xx or 429 unless it is named; the claims-judge check needs its judge roster and unique real-item ids; and the agent
 * loop retries every 5xx on Anthropic and OpenAI while Particle keeps its listed statuses. No provider is reached.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateHardWorld } from '../../eval/generators/model-ladder-hard.ts';
import { HARD_SEEDS } from '../../eval/generators/hard/schema.ts';
import { constructItems, realItems, report, type Grade } from '../../eval/runner/cat40/judge-check-hard.ts';
import { drive } from './cat40-loop-driver.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'cat40-fail-closed-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('newest_analysis.py refuses an incomplete or unretried run', () => {
  const SCRIPT = 'eval/runner/cat40/newest_analysis.py';
  const TASKS = Array.from({ length: 100 }, (_, i) => `H${(i % 5) + 1}-${String(Math.floor(i / 5) + 1).padStart(2, '0')}`);
  function world(dir: string, name: string, opts: { tasks?: string[]; error?: { cell: string; status: number } } = {}) {
    const lines: string[] = [];
    for (const model of ['claude-opus-5-5', 'gpt-6.2-sol']) for (const arm of ['gbrain-newest', 'fs']) (opts.tasks ?? TASKS).forEach((t, i) => {
      const failed = opts.error?.cell === `${arm}|${model}|${t}`;
      lines.push(JSON.stringify({ attempt_id: `${name}|${model}|${arm}|${t}#1`, arm, model, task: t, family: t.slice(0, 2), variant: '',
        stop: failed ? 'error' : 'submitted', ...(failed ? { error: `session 1: provider error ${opts.error!.status}: upstream` } : {}),
        score: { success: !failed && (arm === 'gbrain-newest' || i >= 10), submitted: !failed, said_wrong: false }, total_usd: 0.1, judge_usd: 0.01 }));
    });
    const p = join(dir, `${name}-${lines.length}-${Math.random().toString(36).slice(2)}.jsonl`);
    writeFileSync(p, lines.join('\n') + '\n');
    return `${name}=${p}`;
  }
  const analyse = (worlds: string[], extra: string[] = []) => {
    const r = spawnSync('python3', [SCRIPT, ...worlds.flatMap(w => ['--world', w]), '--resamples', '200', ...extra], { encoding: 'utf8' });
    return { code: r.status, err: r.stderr };
  };

  test('both planned worlds pass; one world alone, or a world under another name, is refused', () => {
    const d = tmp();
    expect(analyse([world(d, 'N1'), world(d, 'N2')]).code).toBe(0);
    const one = analyse([world(d, 'N1')]);
    expect(one.code).toBe(3);
    expect(one.err).toContain('"N2|*|*": "world missing"');
    const renamed = analyse([world(d, 'N1'), world(d, 'N3')]);
    expect(renamed.code).toBe(3);
    expect(renamed.err).toContain('"N3|*|*": "world not planned"');
    expect(analyse([world(d, 'N1'), world(d, 'N1b')]).code).toBe(3);
  });

  test('every planned task id is needed: 100 cells with one id outside the roster are refused', () => {
    const d = tmp();
    const swapped = TASKS.map(t => (t === 'H1-01' ? 'H1-21' : t));
    const r = analyse([world(d, 'N1', { tasks: swapped }), world(d, 'N2')]);
    expect(r.code).toBe(3);
    expect(r.err).toContain('HEADLINE_INCOMPLETE');
  });

  test('a counted cell that ended on a provider 5xx or 429 is refused unless it is named', () => {
    const d = tmp();
    for (const status of [520, 503, 429]) {
      const w = [world(d, 'N1', { error: { cell: 'gbrain-newest|claude-opus-5-5|H4-13', status } }), world(d, 'N2')];
      const r = analyse(w);
      expect(r.code).toBe(3);
      expect(r.err).toContain('HARNESS_ERROR_SCORED');
      expect(r.err).toContain('N1|gbrain-newest|claude-opus-5-5|H4-13');
      expect(analyse(w, ['--accept-unretried', 'N1|gbrain-newest|claude-opus-5-5|H4-13']).code).toBe(0);
      expect(analyse(w, ['--accept-unretried', 'N2|gbrain-newest|claude-opus-5-5|H4-13']).code).toBe(3);
    }
  });

  test('a provider 400, such as a context-length refusal, stays a counted failure', () => {
    const d = tmp();
    expect(analyse([world(d, 'N1', { error: { cell: 'fs|gpt-6.2-sol|H5-01', status: 400 } }), world(d, 'N2')]).code).toBe(0);
  });
});

describe('the claims-judge check needs its roster and unique real-item ids', () => {
  const hardWorld = generateHardWorld(HARD_SEEDS.calibration);
  const { items } = constructItems(hardWorld, 1);
  const verdict = (bad: boolean) => ({ claims: [{ claim: 'x', verdict: bad ? 'contradicted' : 'supported' }], unsupported: 0, contradicted: bad ? 1 : 0, total: 1 });
  const grades = (judge: string, from = items) => from.map(i => ({ judge, item: i.id, claims: verdict(i.label === 'bad') }) as unknown as Grade);

  test('an empty roster, or no grades, never passes', () => {
    expect(report(items, [], []).passes).toBe(false);
    expect(report(items, grades('gpt-6.1-sol'), []).passes).toBe(false);
  });

  test('a judge on the roster with no grades, or with grades for only some items, fails', () => {
    expect(report(items, grades('gpt-6.1-sol'), ['gpt-6.1-sol']).passes).toBe(true);
    const missing = report(items, grades('gpt-6.1-sol'), ['gpt-6.1-sol', 'claude-opus-5-5']);
    expect(missing.passes).toBe(false);
    expect(missing.judges[1].failures.join(' ')).toContain('graded 0 of 60 items');
    const partial = report(items, grades('gpt-6.1-sol', items.slice(0, 58)), ['gpt-6.1-sol']);
    expect(partial.passes).toBe(false);
    expect(partial.judges[0].failures.join(' ')).toContain('graded 58 of 60 items');
  });

  test('the same reader and task in two arms give two real ids; a row drawn twice is refused', () => {
    const row = (arm: string) => ({ model: 'gpt-6.1-sol', arm, task: 'H3-16', family: 'H3', stop: 'submitted', run: { final: { answer: 'x' } }, claims: null });
    const ids = realItems([row('gbrain-newest'), row('fs')], 1).map(i => i.id).sort();
    expect(ids).toEqual(['r-gpt-6.1-sol-fs-H3-16', 'r-gpt-6.1-sol-gbrain-newest-H3-16']);
    expect(() => realItems([row('fs'), row('fs')], 1)).toThrow('drawn twice');
  });

  test('report on the command line needs --judges', () => {
    const out = tmp();
    writeFileSync(join(out, 'items.json'), JSON.stringify({ items }));
    writeFileSync(join(out, 'grades.jsonl'), grades('gpt-6.1-sol').map(g => JSON.stringify(g)).join('\n') + '\n');
    const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
    const bare = spawnSync('bun', ['eval/runner/cat40/judge-check-hard.ts', 'report', '--out', out], { encoding: 'utf8', env });
    expect(bare.status).toBe(2);
    expect(bare.stderr).toContain('--judges');
    const short = spawnSync('bun', ['eval/runner/cat40/judge-check-hard.ts', 'report', '--out', out, '--judges', 'gpt-6.1-sol,claude-opus-5-5'], { encoding: 'utf8', env });
    expect(short.status).toBe(3);
    expect(JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')).passes).toBe(false);
  });
});

describe('the agent loop retries every 5xx on Anthropic and OpenAI', () => {
  const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PARTICLE_API_KEY', 'PARTICLE_BASE_URL'] as const;
  let saved: Record<string, string | undefined> = {};
  let delays: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const realRandom = Math.random;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
    Object.assign(process.env, { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', PARTICLE_API_KEY: 'test-key' });
    delete process.env.PARTICLE_BASE_URL;
    delays = [];
    globalThis.setTimeout = ((fn: () => void, ms?: number) => { delays.push(ms ?? 0); fn(); return 0; }) as unknown as typeof setTimeout;
    Math.random = () => 0.5;
  });
  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
    Math.random = realRandom;
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  test('an HTTP 520 is retried and the run submits', async () => {
    for (const [p, model] of [['anthropic', 'claude-opus-5-5'], ['openai', 'gpt-6.2-sol']] as const) {
      delays = [];
      const { run, attempts } = await drive(p, model, {}, { faults: [{ status: 520, body: '<html>origin error</html>' }] });
      expect(run.stop).toBe('submitted');
      expect(delays).toEqual([2500]);
      expect(attempts[0].status).toBe('error');
    }
  });

  test('six 520s end the run as a harness error, not a scored failure', async () => {
    const { run, attempts } = await drive('anthropic', 'claude-opus-5-5', { classifyStops: true }, { faults: Array.from({ length: 6 }, () => ({ status: 520 })) });
    expect(run.stop).toBe('harness_error');
    expect(attempts).toHaveLength(6);
  });

  test('Particle still never resends a status outside its listed ones', async () => {
    const { run, attempts } = await drive('particle', 'particle-1', {}, { faults: [{ status: 520 }] });
    expect(run.stop).toBe('error');
    expect(attempts).toHaveLength(1);
    expect(delays).toEqual([]);
  });
});

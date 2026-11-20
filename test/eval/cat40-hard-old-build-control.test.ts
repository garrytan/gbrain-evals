/**
 * Cat 40 Hard old-build control (eval/runner/cat40/old-build-control.ts, newest_analysis.py --look control): every gbrain
 * step is the November 19 counted step with only the control's label, ledger, budget, build, explicit surface, --out and
 * drift note changed; the plan has no particle-1, files or oracle step and no dollar figure; the agent loop records the
 * model id each provider served; and the analysis applies the preregistered outcome rows from one draw stream and
 * refuses while a cell is missing. Keyless: the loop tests answer from a scripted fetch and no test reaches a network.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTROL_BUILD, CONTROL_LABEL, CONTROL_PREREG, controlLedgerFor, controlPlan } from '../../eval/runner/cat40/old-build-control.ts';
import { FRONTIER, JUDGE_FOR, halfTasks } from '../../eval/runner/cat40/newest-confirm.ts';
import { runAgent } from '../../eval/runner/cat40/loop.ts';
import { DRIVER_ARM, scriptedFetch } from './cat40-loop-driver.ts';

const val = (argv: string[], f: string) => argv[argv.indexOf(f) + 1];
const NEWEST = 'docs/benchmarks/2026-11-19-cat40-hard-newest';

/** The flags whose values a control step changes on purpose; --surface starter is the one flag it adds. */
const CHANGED = ['--gbrain-label', '--budget-ledger', '--budget-usd', '--gbrain-ref', '--gbrain-root', '--out', '--accept-freeze-drift'];
function normalize(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--surface' && argv[i + 1] === 'starter') { i++; continue; }
    out.push(argv[i]);
    if (CHANGED.includes(argv[i])) { out.push('<changed>'); i++; }
  }
  return out;
}

describe('old-build-control plan', () => {
  for (const w of ['n1', 'n2'] as const) {
    const steps = controlPlan(w, 'c'.repeat(40), '2026-11-20');
    const gbrainSteps = steps.filter(s => s.argv.includes('--arms'));
    test(`${w}: every counted gbrain step is the November 19 receipt's step but for label, ledger, budget, build, surface, out and drift note`, () => {
      for (const r of ['opus', 'sol']) for (const half of ['a', 'b']) {
        const dir = join(NEWEST, w, `gbrain-${r}-${half}`);
        const receipt = JSON.parse(readFileSync(join(dir, readdirSync(dir).find(f => f.startsWith('receipt-'))!), 'utf8')) as { argv: string[] };
        const step = steps.find(s => s.id === `gbrain-old-${r}-${half}`)!;
        expect(step.argv.slice(0, 2)).toEqual(['bun', 'eval/runner/cat40-model-ladder.ts']);
        expect(normalize(step.argv.slice(2))).toEqual(normalize(receipt.argv));
        expect(val(step.argv, '--tasks')).toBe(halfTasks(half as 'a' | 'b').join(','));
      }
    });
    test(`${w}: every gbrain step and the slot build run 09d21554d on surface starter under the control's label and ledger`, () => {
      const slots = steps.find(s => s.id === 'slots')!;
      for (const s of [...gbrainSteps, slots]) {
        expect(val(s.argv, '--gbrain-ref')).toBe(CONTROL_BUILD);
        expect(val(s.argv, '--surface')).toBe('starter');
        expect(val(s.argv, '--budget-ledger')).toBe(controlLedgerFor(w));
        expect(val(s.argv, '--accept-freeze-drift')).toContain(CONTROL_PREREG);
        expect(val(s.argv, '--out')).toMatch(new RegExp(`^eval/reports/cat40/hard-control/${w}/`));
      }
      for (const s of gbrainSteps) {
        expect(val(s.argv, '--arms')).toBe('gbrain');
        expect(val(s.argv, '--gbrain-label')).toBe(CONTROL_LABEL);
        expect(val(s.argv, '--judge')).toBe(JUDGE_FOR[val(s.argv, '--models')]);
      }
      expect(CONTROL_BUILD).toMatch(/^09d21554d[0-9a-f]{31}$/);
    });
    test(`${w}: no particle-1, files or oracle step; smokes on both readers, then the record hold, then both halves`, () => {
      expect(gbrainSteps.map(s => val(s.argv, '--models')).every(m => (FRONTIER as readonly string[]).includes(m))).toBe(true);
      expect(steps.some(s => s.argv.join(' ').includes('particle'))).toBe(false);
      const at = (id: string) => steps.findIndex(s => s.id === id);
      expect(steps.map(s => s.id)).toEqual(['ledger', 'check-world', 'slots', 'smoke-opus', 'smoke-sol', 'hold-record', 'gbrain-old-opus-a', 'gbrain-old-sol-a', 'gbrain-old-opus-b', 'gbrain-old-sol-b']);
      for (const r of ['opus', 'sol']) expect(val(steps[at(`smoke-${r}`)].argv, '--per-family')).toBe('1');
      expect(steps.filter(s => s.hold).map(s => [s.id, s.argv.length])).toEqual([['hold-record', 0]]);
    });
    test(`${w}: every cap is a placeholder, never a dollar figure (R79)`, () => {
      for (const s of steps) {
        if (s.argv.includes('--budget-usd')) expect(val(s.argv, '--budget-usd')).toMatch(/^\$CAP_[A-Z_]+$/);
        if (s.argv.includes('--program-cap-usd')) expect(val(s.argv, '--program-cap-usd')).toBe('$CAP_PROGRAM');
      }
    });
  }
});

describe('the agent loop records the model id each provider served', () => {
  const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const;
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => { saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]])); Object.assign(process.env, { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' }); });
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  for (const [p, model] of [['anthropic', 'claude-opus-5-5'], ['openai', 'gpt-6.2-sol']] as const) {
    test(`${p}: each distinct served id once, in order`, async () => {
      const { fetchImpl } = scriptedFetch(p, model);
      let turn = 0;
      const served = (async (url: string, init: RequestInit) => {
        const res = await fetchImpl(url, init);
        const body = await res.json() as Record<string, unknown>;
        turn++;
        return new Response(JSON.stringify({ ...body, model: turn === 2 ? `${model}-20261101` : model }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch;
      const run = await runAgent({ model, system: 'You answer from the knowledge base.', user: 'What is a?', arm: DRIVER_ARM, fetchImpl: served });
      expect(run.stop).toBe('submitted');
      expect(turn).toBe(3);
      expect(run.served_models).toEqual([model, `${model}-20261101`]);
    });
  }
});

describe('newest_analysis.py --look control', () => {
  const SCRIPT = 'eval/runner/cat40/newest_analysis.py';
  const tasks = Array.from({ length: 100 }, (_, i) => `H${(i % 5) + 1}-${String(Math.floor(i / 5) + 1).padStart(2, '0')}`);
  type Ok = (i: number) => boolean;
  /** One world's cells for both frontier readers: the old build, the newest build and files succeed where their predicates say. */
  function world(dir: string, name: string, oldOk: Ok, newOk: Ok, fsOk: Ok, drop?: string, stray?: string) {
    const lines: string[] = [];
    for (const model of FRONTIER) for (const [arm, ok] of [[CONTROL_LABEL, oldOk], ['gbrain-newest', newOk], ['fs', fsOk]] as const) tasks.forEach((tt, i) => {
      if (drop === `${arm}|${model}|${tt}`) return;
      const t = stray === `${arm}|${model}|${tt}` ? 'H3-99' : tt;
      lines.push(JSON.stringify({ attempt_id: `${model}|${arm}|${t}|0#1`, arm, model, task: t, family: t.slice(0, 2), variant: '', stop: 'submitted', score: { success: ok(i), submitted: true, said_wrong: false }, total_usd: 0.1, judge_usd: 0.01 }));
    });
    const p = join(dir, `${name}.jsonl`);
    writeFileSync(p, lines.join('\n') + '\n');
    return `${name}=${p}`;
  }
  /** A transcript per old- and newest-build attempt in one world, in which the newest build's Sol session widened itself
   * to the full surface on the given tasks; skip leaves one attempt's transcript out. */
  function widened(dir: string, name: string, tasksWidened: string[], skip?: string) {
    const result = JSON.stringify({ surface: 'full', previous: 'starter' });
    const lines = FRONTIER.flatMap(model => [CONTROL_LABEL, 'gbrain-newest'].flatMap(arm => tasks.map(t => {
      const id = `${model}|${arm}|${t}|0#1`;
      if (id === skip) return [];
      const wide = arm === 'gbrain-newest' && model === 'gpt-6.2-sol' && tasksWidened.includes(t);
      return [JSON.stringify({ key: `${model}|${arm}|${t}|0`, attempt_id: id, tools: wide ? [{ session: 2, name: 'request_tools', args: { surface: 'full' }, result }] : [] })];
    }).flat()));
    const p = join(dir, `${name}-transcripts.jsonl`);
    writeFileSync(p, lines.join('\n') + '\n');
    return `${name}=${p}`;
  }
  function control(oldOk: Ok, newOk: Ok, fsOk: Ok, drop?: string, wide?: Record<string, string[]>, opts: { only?: string[]; skip?: string; stray?: string } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'control-analysis-'));
    const out = join(dir, 'out.json');
    const worlds = (opts.only ?? ['N1', 'N2']).map(w => world(dir, w, oldOk, newOk, fsOk, w === 'N1' ? drop : undefined, w === 'N1' ? opts.stray : undefined));
    const trans = Object.entries(wide ?? {}).flatMap(([w, ts]) => ['--world-transcripts', widened(dir, w, ts, w === 'N1' ? opts.skip : undefined)]);
    const r = spawnSync('python3', [SCRIPT, '--look', 'control', '--old', CONTROL_LABEL, ...worlds.flatMap(w => ['--world', w]), ...trans, '--resamples', '1000', '--json', out], { encoding: 'utf8' });
    const json = r.status === 0 ? JSON.parse(readFileSync(out, 'utf8')) : null;
    rmSync(dir, { recursive: true, force: true });
    return { code: r.status, json, err: r.stderr };
  }
  const below = (n: number): Ok => i => i < n;

  test('an old-build lead of +5.3 or more is a regression whatever newest minus old shows', () => {
    const { json } = control(below(60), i => i < 52 || (i % 5 === 3 && i < 60), below(50));
    expect(json.delta_old.delta_pp).toBeCloseTo(10, 6);
    expect(json.outcome_row).toBe('regression');
    expect(json.h4_regression).toBe(false);
  });
  test('below +5.3, newest minus old wholly below 0 is a smaller regression', () => {
    const { json } = control(below(55), below(45), below(50));
    expect(json.delta_old.delta_pp).toBeCloseTo(5, 6);
    expect(json.newest_minus_old.ci95[1]).toBeLessThan(0);
    expect(json.outcome_row).toBe('smaller regression');
  });
  test('below +5.3, newest minus old wholly above 0 reads newest improved', () => {
    const { json } = control(below(45), below(52), below(50));
    expect(json.outcome_row).toBe('newest improved');
    expect(json.note).toBeNull();
  });
  test('an interval through 0 is not a regression, noted "newest lower, within noise" when newest is lower', () => {
    const { json } = control(i => (i % 2 === 0 && i !== 0) || i === 1 || i === 3, i => i % 2 === 0, below(50));
    expect(json.newest_minus_old.delta_pp).toBeCloseTo(-1, 6);
    expect(json.newest_minus_old.ci95[0]).toBeLessThan(0);
    expect(json.newest_minus_old.ci95[1]).toBeGreaterThan(0);
    expect(json.outcome_row).toBe('not a regression');
    expect(json.note).toBe('newest lower, within noise');
  });
  test('both differences come from one draw stream: newest minus old is newest minus files less old minus files', () => {
    const { json } = control(i => i % 3 !== 0, i => i % 4 !== 0, i => i % 2 === 0);
    const newest = json.per_family.H1.delta_newest.delta_pp - json.per_family.H1.delta_old.delta_pp;
    expect(json.per_family.H1.newest_minus_old.delta_pp).toBeCloseTo(newest, 9);
    expect(Object.keys(json.per_reader)).toEqual([...FRONTIER]);
    expect(Object.keys(json.per_world)).toEqual(['N1', 'N2']);
    expect(json.first_table[`${CONTROL_LABEL}|particle-1`]).toContain('not run in this control');
  });
  test('H4 is a regression when the paired newest-minus-old H4 interval lies below 0', () => {
    const { json } = control(() => true, i => i % 5 !== 3, () => true);
    expect(json.per_family.H4.newest_minus_old.ci95[1]).toBeLessThan(0);
    expect(json.h4_regression).toBe(true);
  });
  test('the widened-session sensitivity drops each widened task in its own world, even where attempt ids repeat across worlds', () => {
    const { json } = control(below(55), below(52), below(50), undefined, { N1: ['H1-01', 'H2-01'], N2: ['H1-01'] });
    expect(json.tool_calls['gbrain-newest|gpt-6.2-sol'].cells_widened_to_full).toBe(3);
    expect(json.without_widened_sessions.dropped_pairs).toBe(3);
    expect(json.without_widened_sessions.delta_old.cells).toBe(400 - 3);
  });
  test('a control run on only one of the planned worlds refuses (CONTROL_INCOMPLETE, exit 3)', () => {
    const r = control(below(55), below(52), below(50), undefined, undefined, { only: ['N1'] });
    expect(r.code).toBe(3);
    expect(r.err).toContain('CONTROL_INCOMPLETE');
  });
  test('a sensitivity run whose transcripts lack an old- or newest-build attempt refuses (exit 3)', () => {
    const r = control(below(55), below(52), below(50), undefined, { N1: ['H1-01'], N2: [] }, { skip: `claude-opus-5-5|${CONTROL_LABEL}|H2-03|0#1` });
    expect(r.code).toBe(3);
    expect(r.err).toContain('have no transcript');
  });
  test('a sensitivity run with transcripts for only one world refuses (exit 3)', () => {
    const r = control(below(55), below(52), below(50), undefined, { N1: ['H1-01'] });
    expect(r.code).toBe(3);
    expect(r.err).toContain('transcripts for every world');
  });
  test('arms that cover different task ids at 100 cells each refuse (exit 3)', () => {
    const r = control(below(55), below(52), below(50), undefined, undefined, { stray: `${CONTROL_LABEL}|gpt-6.2-sol|H3-07` });
    expect(r.code).toBe(3);
    expect(r.err).toContain('task pairs lack a cell');
  });
  test('a missing old-build cell refuses the control (CONTROL_INCOMPLETE, exit 3)', () => {
    const r = control(below(55), below(52), below(50), `${CONTROL_LABEL}|gpt-6.2-sol|H3-07`);
    expect(r.code).toBe(3);
    expect(r.err).toContain('CONTROL_INCOMPLETE');
  });
});

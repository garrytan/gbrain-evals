/**
 * BG1's dev loop (eval/runner/bg1/dev-loop.ts), keyless: the pinned question-day clock with the wall clock set past
 * 2026-11-22 and past every scheduled change in the dev worlds, the refusal before any call when the container clock
 * is not pinned, sealed cells keeping the runner's wall-clock check, the settings check against the comparator cache,
 * scoring and why-rows. The cell runs on the fake memory system with a scripted reader and judge.
 */
import { afterAll, afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BASELINES_PATH, clockProblem, COMPARATORS, DEV_AS_OF, DEV_JUDGE, DEV_READER, DEV_WORLD_END, devCell, devClock, DevLoopRefusal, faketimeOffset, loadBaselines,
  main, neededValues, newestRelease, resolveGbrainRef, runDevCell, scoreRecords, scoreRun, vmCommand, WHY_CLASSES, whyRows, type Baselines, type QuestionRecord,
} from '../../eval/runner/bg1/dev-loop.ts';
import { bg1RunClock, loadCorpus } from '../../eval/runner/memory-qa/corpus.ts';
import type { ChatLike, ChatResult } from '../../eval/runner/memory-qa/qa-v2.ts';
import { FakeMemorySystem } from '../../eval/runner/systems/fake.ts';

const SHA = '6ce7195b44a034f85aec811f11fbf862db376f50';
const NO_META = { finish: null, usage: null, response_model: null, attempt_errors: [] as string[] };
const tmp = mkdtempSync(join(tmpdir(), 'bg1-dev-loop-'));
const PINNED_RUN = join(tmp, 'pinned-2026-11-23');
const priorWorldEnd = process.env.GBRAIN_EVALS_BG1_WORLD_END;
afterEach(() => setSystemTime());
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (priorWorldEnd === undefined) delete process.env.GBRAIN_EVALS_BG1_WORLD_END; else process.env.GBRAIN_EVALS_BG1_WORLD_END = priorWorldEnd;
});

const dead = { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, GEMINI_API_KEY: undefined, PARTICLE_API_KEY: undefined, SHOOTOUT_PROXY: undefined };

function scripted(): { reader: ChatLike; judge: ChatLike; calls: { reader: number; judge: number } } {
  const calls = { reader: 0, judge: 0 };
  return {
    calls,
    reader: { async chat(_m, prompt): Promise<ChatResult> { calls.reader++; return { text: /Question: (.*)\n/.exec(prompt)?.[1] ?? 'unknown', input_tokens: Math.ceil(prompt.length / 4), output_tokens: 8, cached: false, ...NO_META }; } },
    judge: { async chat(): Promise<ChatResult> { calls.judge++; return { text: '{"correct": 0}', input_tokens: 100, output_tokens: 4, cached: false, ...NO_META }; } },
  };
}

class CountingFake extends FakeMemorySystem {
  calls = 0;
  async capabilities() { this.calls++; return super.capabilities(); }
}

const questionsAt = (iso: string) => {
  setSystemTime(new Date(iso));
  process.env.GBRAIN_EVALS_BG1_WORLD_END = DEV_WORLD_END;
  return JSON.stringify(loadCorpus('bg1-dev', undefined, undefined, { keyless: true }).questions.map(q => [q.id, q.question, q.answer, q.question_date, q.bg1]));
};

describe('the pinned question-day clock', () => {
  for (const today of ['2026-11-23T09:30:00Z', '2027-03-15T18:00:00Z']) {
    test(`with today set to ${today.slice(0, 10)}, a dev cell runs on the question day, asks the same questions and a sealed cell still refuses`, async () => {
      const asked = questionsAt('2026-11-09T00:00:00Z');
      expect(questionsAt(today)).toBe(asked);

      const offset = Number(faketimeOffset());
      const pinned = Date.now() + offset * 1000;
      expect(Math.abs(pinned - Date.parse(DEV_AS_OF))).toBeLessThan(1000);
      expect(clockProblem(pinned)).toBeNull();
      expect(clockProblem(Date.now())).toContain('not the pinned');

      expect(() => bg1RunClock({ worldEnd: DEV_WORLD_END })).toThrow();
      expect(() => devClock({ id: 'bg1.gbrain-defaults.rs1-stable', benchmark: 'bg1', split: 'heldout' } as never)).toThrow(DevLoopRefusal);
      expect(devClock(devCell(SHA))).toEqual({ worldEnd: DEV_WORLD_END, asOf: DEV_AS_OF });

      const s = scripted();
      const out = join(tmp, `pinned-${today.slice(0, 10)}`);
      const res = await runDevCell({ sha: SHA, world: 'bg1-dev-01', out, systemUrl: null, env: { ...process.env, ...dead } },
        { system: new FakeMemorySystem(), reader: s.reader, judge: s.judge, clockMs: () => Date.now() + offset * 1000 });
      expect(res.share).toMatchObject({ shard: '0/3', questions: 64, complete: true });
      expect(s.calls.reader).toBe(64);
      const rc = JSON.parse(readFileSync(join(out, 'cells', 'bg1-dev3.gbrain-defaults.rs1-stable.p', 'run-config.json'), 'utf8'));
      expect(rc.cell.launch.env.GBRAIN_SHA).toBe(SHA);
    }, 120_000);
  }

  test('a container clock left on today refuses before the system, the reader or the judge is called', async () => {
    setSystemTime(new Date('2026-12-01T12:00:00Z'));
    const s = scripted();
    const system = new CountingFake();
    const run = runDevCell({ sha: SHA, world: 'bg1-dev-02', out: join(tmp, 'unpinned'), systemUrl: null, env: { ...process.env, ...dead } },
      { system, reader: s.reader, judge: s.judge, clockMs: () => Date.now() });
    await expect(run).rejects.toThrow(/refusing before any paid call: the container clock reads 2026-12-01/);
    expect([system.calls, s.calls.reader, s.calls.judge]).toEqual([0, 0, 0]);
  });

  test('cell refuses without a lease proxy unless the reader and judge are fakes', async () => {
    await expect(runDevCell({ sha: SHA, world: 'bg1-dev-01', out: join(tmp, 'noproxy'), systemUrl: 'http://127.0.0.1:9', env: { ...dead } }, { clockMs: () => Date.parse(DEV_AS_OF) }))
      .rejects.toThrow(/lease proxy/);
  });

  test('every VM command pins the world end and the container clock, and builds with libfaketime', () => {
    const cmd = vmCommand(SHA, 'bg1-dev-03');
    expect(cmd).toContain(`export GBRAIN_EVALS_BG1_WORLD_END=${DEV_WORLD_END}`);
    expect(cmd).toContain('export GBRAIN_FAKETIME="$(bun eval/runner/bg1/dev-loop.ts clock)"');
    expect(cmd).toContain('GBRAIN_FAKETIME_LIB=1');
    expect(cmd).toContain(`GBRAIN_SHA=${SHA}`);
    expect(cmd).toContain('--world bg1-dev-03');
  });
});

describe('the dev cell and its launch', () => {
  test("is stage 1's gbrain cell at another commit, read by claude-opus-5-5 alone and judged by gpt-6-astra alone", () => {
    const def = devCell(SHA);
    expect(def.launch?.env.GBRAIN_SHA).toBe(SHA);
    expect(def.arms.map(a => [a.readers, a.frontier?.judges])).toEqual([[[DEV_READER], [DEV_JUDGE]]]);
    expect(def.snapshot_command ?? null).toBeNull();
    expect(() => devCell('6ce7195b')).toThrow(DevLoopRefusal);
  });

  test('a ref resolves to the peeled tag, then the branch, and a full sha passes through', () => {
    const ls = () => ['aaaa\trefs/tags/stable', `${SHA}\trefs/tags/stable^{}`, 'bbbb\trefs/heads/master'].join('\n');
    expect(resolveGbrainRef('stable', ls)).toBe(SHA);
    expect(resolveGbrainRef('master', ls)).toBe('bbbb');
    expect(resolveGbrainRef(SHA, () => { throw new Error('no network'); })).toBe(SHA);
    expect(() => resolveGbrainRef('nope', ls)).toThrow(DevLoopRefusal);
  });

  test('without --gbrain the newest release tag wins by number, and other tags never do', () => {
    const ls = () => ['c1\trefs/tags/v0.60.99.0', 'c2\trefs/tags/v0.60.733.0', 'c3\trefs/tags/v0.60.733.0-rc1', 'c4\trefs/tags/stable-v0.60.900.0', 'c5\trefs/tags/stable',
      'a6\trefs/tags/v0.60.732.0', 'c6\trefs/tags/v0.60.732.0^{}', 'c7\trefs/heads/master'].join('\n');
    expect(newestRelease(ls)).toEqual({ tag: 'v0.60.733.0', sha: 'c2' });
    expect(newestRelease(() => ls().replace('c2\trefs/tags/v0.60.733.0\n', ''))).toEqual({ tag: 'v0.60.732.0', sha: 'c6' });
    expect(() => newestRelease(() => 'c5\trefs/tags/stable\n')).toThrow(DevLoopRefusal);
  });

  test('run refuses without a paid window, and with unknown worlds', async () => {
    await expect(main(['run'])).rejects.toThrow(/--paid-window/);
    await expect(main(['run', '--gbrain', SHA])).rejects.toThrow(/--paid-window/);
    await expect(main(['run', '--gbrain', SHA, '--worlds', 'bg1-heldout-01'])).rejects.toThrow(/--worlds takes/);
  });
});

describe('scoring against the comparator cache', () => {
  const baselines = loadBaselines();
  const ids = Object.keys(baselines.rows['ext-memory-bank'].questions);

  test('the cache holds both comparators on all 192 dev questions, read at one set of settings', () => {
    expect(ids).toHaveLength(192);
    for (const c of COMPARATORS) expect(baselines.rows[c].settings).toEqual(baselines.rows['ext-memory-bank'].settings);
    expect(baselines.rows['ext-memory-bank'].settings).toMatchObject({ reader: DEV_READER, judge: DEV_JUDGE, budget: 8000, mode: 'packed' });
    expect(BASELINES_PATH).toContain('eval/data/changing-facts-v1/dev/baselines');
  });

  test("a run read at the comparators' settings scores; one read at other settings refuses", () => {
    const s = scoreRun(PINNED_RUN, { baselines });
    expect(s.gbrain_sha).toBe(SHA);
    expect(s.classes.find(c => c.label === 'all')!.n).toBe(192);
    const off: Baselines = structuredClone(baselines);
    off.rows['ext-memory-bank'].settings = { ...off.rows['ext-memory-bank'].settings, budget: 4000 };
    expect(() => scoreRun(PINNED_RUN, { baselines: off })).toThrow(/comparators were read at/);
  });

  test('gaps are gbrain minus each comparator in points, paired over questions both graded', () => {
    const recs = new Map<string, QuestionRecord>(ids.map(id => [id, { id, world: 'bg1-dev-01', stratum: 's1_updated', score: baselines.rows['ext-memory-bank'].questions[id].score === null ? null : 1, gold: true, stale: false, answer: null, context: null }]));
    const s1 = scoreRecords('synthetic', null, recs, baselines).classes.find(c => c.label === 's1_updated')!;
    expect(s1.accuracy).toBe(1);
    expect(s1.comparators['ext-memory-bank'].gap!.delta).toBeCloseTo((1 - s1.comparators['ext-memory-bank'].accuracy!) * 100, 6);
  });
});

describe('why rows', () => {
  test('list each needed value and whether the context held it', () => {
    process.env.GBRAIN_EVALS_BG1_WORLD_END = DEV_WORLD_END;
    const q = loadCorpus('bg1-dev', undefined, undefined, { keyless: true }).questions.find(x => x.bg1?.ordered && x.bg1.gold_values.length > 1)!;
    const held = neededValues(q, `Notes: ${q.bg1!.gold_values[0]}.`);
    expect(held.needed[0]).toEqual({ value: q.bg1!.gold_values[0], in_context: true });
    expect(held.needed.slice(1).every(n => n.in_context === false)).toBe(true);
    expect(neededValues(q, null).needed.every(n => n.in_context === null)).toBe(true);
  });

  test("a run's misses in S1 and S5 to S8 come out with their question, gold, answer and context", () => {
    const rows = whyRows(PINNED_RUN);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => WHY_CLASSES.includes(r.stratum) && r.gbrain.score === 0 && r.world === 'bg1-dev-01' && r.gbrain.answer !== null && r.gold.length > 0)).toBe(true);
  });
});

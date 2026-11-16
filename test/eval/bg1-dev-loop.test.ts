/**
 * BG1's dev loop (eval/runner/bg1/dev-loop.ts), keyless: the pinned question-day clock with the wall clock set past
 * 2026-11-22 and past every scheduled change in the dev worlds, the refusal before any call when the container clock
 * is not pinned, sealed cells keeping the runner's wall-clock check, the settings check against the comparator cache,
 * scoring and why-rows. The cell runs on the fake memory system with a scripted reader and judge.
 */
import { afterAll, afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BASELINES_PATH, clockProblem, COMPARATORS, DEV_AS_OF, DEV_JUDGE, DEV_READER, DEV_WORLD_END, devCell, devClock, DevLoopRefusal, faketimeOffset, loadBaselines,
  main, neededValues, newestRelease, resolveGbrainRef, runDevCell, savedRow, scoreRecords, scoreRun, ubiRoom, vmCommand, WHY_CLASSES, whyRows, type Baselines, type QuestionRecord,
} from '../../eval/runner/bg1/dev-loop.ts';
import { checkOverlayHead, overlaySlug, parseOverlays, renderScore, RUN_SCHEMA, vmPayload } from '../../eval/runner/bg1/dev-loop.ts';
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

  test('a VM starts only when the shared project stays at or under 464 vCPUs and this crew at or under 208', () => {
    const usage = (rows: Array<[string, number, number]>) => ['OWNER           VMS  VCPUS', ...rows.map(r => r.join('  ')), `total  ${rows.reduce((n, r) => n + r[1], 0)}  ${rows.reduce((n, r) => n + r[2], 0)}`].join('\n');
    expect(ubiRoom(usage([['harn61', 9, 144], ['geva520', 2, 76], ['gbev91', 3, 12]]), 4)).toBe(49);
    expect(ubiRoom(usage([['harn61', 30, 440], ['gbev91', 3, 12]]), 4)).toBe(3);
    expect(ubiRoom(usage([['harn61', 30, 452], ['gbev91', 3, 12]]), 4)).toBe(0);
    expect(ubiRoom(usage([['harn61', 30, 480], ['gbev91', 3, 12]]), 4)).toBe(0);
    expect(ubiRoom(usage([['gbev53', 10, 160], ['gbev91', 11, 44]]), 4)).toBe(1);
    expect(ubiRoom(usage([['gbev53', 10, 160], ['gbev91', 12, 48]]), 4)).toBe(0);
    expect(ubiRoom(usage([['gbev53', 10, 160], ['gbev91', 12, 48], ['gbra108', 2, 8]]), 4, 'gbra')).toBe(50);
    expect(ubiRoom('ubi-runner: usage failed (HTTP 502)', 4)).toBe(0);
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

  test('a saved row stands in for its run directory under --against, and carries no answers or contexts', () => {
    const file = join(tmp, 'saved-row.json');
    writeFileSync(file, JSON.stringify(savedRow(PINNED_RUN)));
    expect(readFileSync(file, 'utf8')).not.toContain('"context"');
    const fromDir = scoreRun(PINNED_RUN, { baselines, against: join(tmp, 'pinned-2027-03-15') });
    const fromFile = scoreRun(PINNED_RUN, { baselines, against: file });
    expect(fromFile.classes.map(c => c.against)).toEqual(fromDir.classes.map(c => c.against));
    expect(fromFile.classes.find(c => c.label === 'all')!.against!.delta).toBe(0);
    const off = { ...JSON.parse(readFileSync(file, 'utf8')), settings: { ...savedRow(PINNED_RUN).settings, budget: 4000 } };
    writeFileSync(file, JSON.stringify(off));
    expect(() => scoreRun(PINNED_RUN, { baselines, against: file })).toThrow(/comparators were read at/);
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
    expect(rows.every(r => WHY_CLASSES.includes(r.stratum) && r.gbrain.score === 0 && r.world === 'bg1-dev-01' && r.gbrain.answer !== null && !!r.gold)).toBe(true);
  });
});

describe('overlays', () => {
  const on = { 'search.evidence_date_header': true };
  test('parse into a sorted overlay of the shim\'s six keys, and refuse anything else', () => {
    expect(parseOverlays(['run', '--overlay', 'search.query_budget_unit=auto', '--overlay', 'search.evidence_date_header=false'])).toEqual({ 'search.evidence_date_header': false, 'search.query_budget_unit': 'auto' });
    expect(Object.keys(parseOverlays(['--overlay', 'search.query_budget_unit=auto', '--overlay', 'search.evidence_date_header=true']))).toEqual(['search.evidence_date_header', 'search.query_budget_unit']);
    expect(parseOverlays(['run'])).toEqual({});
    expect(() => parseOverlays(['--overlay', 'search.evidence_date_heder=true'])).toThrow(/not a key the gbrain-defaults shim sets/);
    expect(() => parseOverlays(['--overlay', 'search.evidence_date_header=yes'])).toThrow(/takes true or false/);
    expect(() => parseOverlays(['--overlay', 'search.query_budget_unit=true'])).toThrow(/takes chunk or auto/);
    expect(() => parseOverlays(['--overlay', 'search.evidence_titles'])).toThrow(/takes <gbrain key>=<value>/);
    expect(() => parseOverlays(['--overlay', 'search.evidence_titles=true', '--overlay', 'search.evidence_titles=false'])).toThrow(/given twice/);
    expect(overlaySlug({ 'search.evidence_date_header': true, 'search.evidence_titles': false })).toBe('evidence_date_header=true+evidence_titles=false');
  });

  test('run refuses a bad overlay before it reads a key or starts a VM', async () => {
    await expect(main(['run', '--overlay', 'search.evidence_date_heder=true', '--paid-window', 'w', '--window-cap-usd', '3'])).rejects.toThrow(/not a key the gbrain-defaults shim sets/);
  });

  test('a key gbrain does not list at the resolved commit refuses, and so does an unreadable config', async () => {
    const urls: string[] = [];
    const config = (text: string) => async (url: string) => { urls.push(url); return text; };
    await checkOverlayHead(SHA, on, config("  'search.evidence_date_header', // C1"));
    expect(urls).toEqual([`https://raw.githubusercontent.com/garrytan/gbrain/${SHA}/src/core/config.ts`]);
    await expect(checkOverlayHead(SHA, on, config("  'search.evidence_titles',"))).rejects.toThrow(/does not list search.evidence_date_header/);
    await expect(checkOverlayHead(SHA, on, async () => { throw new Error('HTTP 404'); })).rejects.toThrow(/could not read gbrain's config keys/);
    await checkOverlayHead(SHA, {}, async () => { throw new Error('not called'); });
  });

  test('no overlay leaves the cell, the VM command and the payload as they were; an overlay reaches the arm and the cell command', () => {
    expect(devCell(SHA, {})).toEqual(devCell(SHA));
    expect(vmCommand(SHA, 'bg1-dev-01', {})).toBe(vmCommand(SHA, 'bg1-dev-01'));
    expect(vmPayload(SHA, 'bg1-dev-01', 'l', 12, {})).toEqual(vmPayload(SHA, 'bg1-dev-01', 'l', 12));
    const base = devCell(SHA).arms[0].retrieval!.overlay, set = devCell(SHA, on).arms[0].retrieval!.overlay;
    expect(base['search.evidence_date_header']).toBe(false);
    expect(set).toEqual({ ...base, 'search.evidence_date_header': true });
    const cmd = vmCommand(SHA, 'bg1-dev-01', on);
    expect(cmd).toContain('cell --sha ' + SHA + ' --world bg1-dev-01 --overlay search.evidence_date_header=true --system-url');
    expect(parseOverlays(cmd.split(/\s+/))).toEqual(on);
  });

  const runAt = (name: string, info: Record<string, unknown>) => {
    const dir = join(tmp, name);
    cpSync(PINNED_RUN, dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ schema: RUN_SCHEMA, gbrain_ref: 'v0.60.733.0', gbrain_sha: SHA, worlds: ['bg1-dev-01'], world_end: DEV_WORLD_END, as_of: DEV_AS_OF, reader: DEV_READER, judge: DEV_JUDGE, ...info }));
    return dir;
  };

  test('score opens with both overlays and their difference, and refuses runs that differ in more than overlay and ref', () => {
    const baselines = loadBaselines();
    const a = runAt('overlay-on', { overlay: on }), b = runAt('overlay-off', { overlay: { 'search.evidence_date_header': false }, gbrain_ref: 'v0.60.734.0' });
    const s = scoreRun(a, { baselines, against: b });
    expect(s.overlay).toEqual(on);
    expect(s.against_overlay).toEqual({ 'search.evidence_date_header': false });
    const lines = renderScore(s).split('\n');
    expect(lines[0]).toBe('Overlay: evidence_date_header=true; --against: evidence_date_header=false.');
    expect(lines[1]).toBe('Overlay difference: search.evidence_date_header true (this run) against false (--against).');
    const file = join(tmp, 'overlay-off.json');
    writeFileSync(file, JSON.stringify(savedRow(b)));
    expect(scoreRun(a, { baselines, against: file }).against_overlay).toEqual({ 'search.evidence_date_header': false });
    const plain = runAt('overlay-none', {});
    expect(renderScore(scoreRun(a, { baselines, against: plain })).split('\n')[1]).toBe('Overlay difference: search.evidence_date_header true (this run) against arm default (--against).');
    const other = runAt('overlay-other-worlds', { overlay: on, worlds: ['bg1-dev-02'] });
    expect(() => scoreRun(a, { baselines, against: other })).toThrow(/differ in worlds.*--allow-run-diff/);
    expect(scoreRun(a, { baselines, against: other, allowRunDiff: true }).overlay).toEqual(on);
  });

  test('a run without an overlay scores, saves and renders exactly as before', () => {
    const baselines = loadBaselines();
    const s = scoreRun(PINNED_RUN, { baselines });
    expect('overlay' in s).toBe(false);
    expect('overlay' in savedRow(PINNED_RUN)).toBe(false);
    expect(renderScore(s).startsWith('BG1 dev loop: gbrain')).toBe(true);
    expect(whyRows(PINNED_RUN).some(r => 'overlay' in r)).toBe(false);
  });

  test('why rows carry the overlay, and so must their file name', async () => {
    const a = join(tmp, 'overlay-on');
    expect(whyRows(a).every(r => r.overlay?.['search.evidence_date_header'] === true)).toBe(true);
    await expect(main(['why', '--run', a, '--out', join(tmp, 'why.jsonl')])).rejects.toThrow(/carries it, e.g. why-rows-evidence_date_header=true.jsonl/);
    expect(await main(['why', '--run', a, '--out', join(tmp, 'why-rows-evidence_date_header=true.jsonl')])).toBe(0);
  });
  test('an overlay reaches every retrieval the system serves and the cell\'s run-config and receipt', async () => {
    const seen = new Set<string>();
    class Recording extends FakeMemorySystem {
      async retrieve(ns: string, q: Parameters<FakeMemorySystem['retrieve']>[1], policy: Parameters<FakeMemorySystem['retrieve']>[2]) { seen.add(JSON.stringify((policy.settings as { overlay?: unknown }).overlay ?? null)); return super.retrieve(ns, q, policy); }
    }
    const s = scripted();
    const out = join(tmp, 'overlay-cell');
    await runDevCell({ sha: SHA, world: 'bg1-dev-01', out, systemUrl: null, env: { ...process.env, ...dead }, overlay: on },
      { system: new Recording(), reader: s.reader, judge: s.judge, clockMs: () => Date.parse(DEV_AS_OF) });
    expect([...seen].map(t => JSON.parse(t))).toEqual([devCell(SHA, on).arms[0].retrieval!.overlay]);
    const dir = join(out, 'cells', 'bg1-dev3.gbrain-defaults.rs1-stable.p');
    expect(JSON.parse(readFileSync(join(dir, 'run-config.json'), 'utf8')).arm.retrieval.overlay['search.evidence_date_header']).toBe(true);
    const plain = JSON.parse(readFileSync(join(PINNED_RUN, 'cells', 'bg1-dev3.gbrain-defaults.rs1-stable.p', 'receipt.json'), 'utf8')).config_sha256;
    expect(JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8')).config_sha256).not.toBe(plain);
  }, 120_000);
});

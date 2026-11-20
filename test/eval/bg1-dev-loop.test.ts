/**
 * BG1's dev loop (eval/runner/bg1/dev-loop.ts), keyless: the pinned question-day clock with the wall clock set past
 * 2026-11-22 and past every scheduled change in the dev worlds, the refusal before any call when the container clock
 * is not pinned, sealed cells keeping the runner's wall-clock check, the settings check against the comparator cache,
 * scoring and why-rows. The cell runs on the fake memory system with a scripted reader and judge.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BASELINES_PATH, clockProblem, COMPARATORS, DEV_AS_OF, DEV_JUDGE, DEV_READER, DEV_WORLD_END, devCell, devClock, DevLoopRefusal, faketimeOffset, loadBaselines,
  main, neededValues, newestRelease, resolveGbrainRef, runDevCell, savedRow, scoreRecords, scoreRun, ubiRoom, vmCommand, WHY_CLASSES, whyRows, type Baselines, type QuestionRecord,
} from '../../eval/runner/bg1/dev-loop.ts';
import { BRAIN_SNAPSHOT, crewOf, DEV_VM_HOURS, devVm, devVmName, keptDevVms, reapDevVms, type UbiRunner, checkOverlayHead, overlaySlug, parseOverlays, renderScore, RUN_SCHEMA, upkeepRuns, vmPayload } from '../../eval/runner/bg1/dev-loop.ts';
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

/** PINNED_RUN as the first clock test leaves it, built here when a test that reads it runs on its own (bun test -t). */
async function ensurePinnedRun() {
  if (existsSync(join(PINNED_RUN, 'cells'))) return;
  const s = scripted();
  await runDevCell({ sha: SHA, world: 'bg1-dev-01', out: PINNED_RUN, systemUrl: null, env: { ...process.env, ...dead } },
    { system: new FakeMemorySystem(), reader: s.reader, judge: s.judge, clockMs: () => Date.parse(DEV_AS_OF) });
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

  test("the room check reads the runner's own usage table, the caller's (you) row included, and the runner's owner tag", () => {
    const script = readFileSync('scripts/ubicloud/ubi-runner.sh', 'utf8');
    const program = /awk -v me="\$OWNER" '([\s\S]*?)'\n/.exec(script)?.[1];
    expect(program).toBeDefined();
    const usage = (me: string, vms: Array<[string, number]>) => execFileSync('awk', ['-v', `me=${me}`, program!], {
      encoding: 'utf8', input: vms.flatMap(([owner, n]) => Array.from({ length: n }, () => `${owner} standard-4`)).join('\n') + '\n' });
    const atCap = usage('gbev91', [['gbev91', 52]]);
    expect(atCap).toMatch(/^gbev91 +52 +208 +\(you\)$/m);
    expect(ubiRoom(atCap, 4, crewOf('gbev91'))).toBe(0);
    expect(ubiRoom(usage('gbev91', [['gbev91', 51]]), 4, crewOf('gbev91'))).toBe(1);
    expect(ubiRoom(usage('gbev91', [['gbev53', 40], ['gbev91', 12]]), 4, crewOf('gbev91'))).toBe(0);
    expect(ubiRoom(usage('gbra108', [['gbev91', 52], ['gbra108', 2]]), 4, crewOf('gbra108'))).toBe(50);
    expect(ubiRoom(usage('gbra108', [['gbra108', 52]]), 4, crewOf('gbra108'))).toBe(0);
    expect(execFileSync('bash', ['scripts/ubicloud/ubi-runner.sh', 'owner'], { encoding: 'utf8', env: { ...process.env, UBI_OWNER: 'GBRA-108' } }).trim()).toBe('gbra108');
    expect([crewOf('gbra108'), crewOf('gbev91')]).toEqual(['gbra', 'gbev']);
  });

  test('run refuses without a paid window, and with unknown worlds', async () => {
    await expect(main(['run'])).rejects.toThrow(/--paid-window/);
    await expect(main(['run', '--gbrain', SHA])).rejects.toThrow(/--paid-window/);
    await expect(main(['run', '--gbrain', SHA, '--worlds', 'bg1-heldout-01'])).rejects.toThrow(/--worlds takes/);
  });
});

describe('scoring against the comparator cache', () => {
  beforeAll(ensurePinnedRun, 120_000);
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

  test('a saved row graded on other worlds refuses without --allow-run-diff', () => {
    const row = savedRow(PINNED_RUN);
    const graded = new Set(Object.entries(row.questions).filter(([, q]) => q.score !== null).map(([id]) => id));
    const file = join(tmp, 'saved-row-other-worlds.json');
    writeFileSync(file, JSON.stringify({ ...row, questions: Object.fromEntries(Object.keys(row.questions).map(id => [id, { score: graded.has(id) ? null : 1, gold: null, stale: null }])) }));
    expect(() => scoreRun(PINNED_RUN, { baselines, against: file })).toThrow(/differ in graded worlds.*--allow-run-diff/);
    expect(scoreRun(PINNED_RUN, { baselines, against: file, allowRunDiff: true }).classes.find(c => c.label === 'all')!.against).toBeNull();
  });

  test('the comparator columns cover only the questions gbrain graded, and the n column says so', () => {
    const s = scoreRun(PINNED_RUN, { baselines });
    const all = s.classes.find(c => c.label === 'all')!;
    const graded = Object.entries(savedRow(PINNED_RUN).questions).filter(([, q]) => q.score !== null).map(([id]) => id);
    expect(all.graded).toBe(graded.length);
    expect(graded.length).toBeLessThan(192);
    const mb = graded.map(id => baselines.rows['ext-memory-bank'].questions[id].score).filter((x): x is number => typeof x === 'number');
    expect(all.comparators['ext-memory-bank'].accuracy).toBeCloseTo(mb.reduce((a, b) => a + b, 0) / mb.length, 9);
    expect(renderScore(s)).toContain(`| all | ${graded.length} of 192 |`);
  });

  test('a score refuses two runs mixed under one directory, by build or by question, and run refuses an --out that holds a run', async () => {
    const mixed = join(tmp, 'mixed');
    cpSync(PINNED_RUN, join(mixed, 'worlds', 'a'), { recursive: true });
    cpSync(PINNED_RUN, join(mixed, 'worlds', 'b'), { recursive: true });
    expect(() => scoreRun(mixed, { baselines })).toThrow(/answered under both/);
    const rc = join(mixed, 'worlds', 'b', 'cells', 'bg1-dev3.gbrain-defaults.rs1-stable.p', 'run-config.json');
    const conf = JSON.parse(readFileSync(rc, 'utf8'));
    conf.cell.launch.env.GBRAIN_SHA = 'b'.repeat(40);
    writeFileSync(rc, JSON.stringify(conf));
    expect(() => scoreRun(mixed, { baselines })).toThrow(/ran gbrain b{40}, and the rest of its row ran/);
    mkdirSync(join(tmp, 'used-out'), { recursive: true });
    writeFileSync(join(tmp, 'used-out', 'run.json'), '{}');
    await expect(main(['run', '--out', join(tmp, 'used-out')])).rejects.toThrow(/already holds a run/);
  });

  test('gaps are gbrain minus each comparator in points, paired over questions both graded', () => {
    const recs = new Map<string, QuestionRecord>(ids.map(id => [id, { id, world: 'bg1-dev-01', stratum: 's1_updated', score: baselines.rows['ext-memory-bank'].questions[id].score === null ? null : 1, gold: true, stale: false, answer: null, context: null }]));
    const s1 = scoreRecords('synthetic', null, recs, baselines).classes.find(c => c.label === 's1_updated')!;
    expect(s1.accuracy).toBe(1);
    expect(s1.comparators['ext-memory-bank'].gap!.delta).toBeCloseTo((1 - s1.comparators['ext-memory-bank'].accuracy!) * 100, 6);
  });
});

describe('why rows', () => {
  beforeAll(ensurePinnedRun, 120_000);
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
  beforeAll(ensurePinnedRun, 120_000);
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

  test("an overlay that sets a key to the stage 1 arm's own value refuses, since it would change nothing", () => {
    expect(() => devCell(SHA, { 'search.query_facts_block': true })).toThrow(/already sets search.query_facts_block=true/);
    expect(() => vmCommand(SHA, 'bg1-dev-01', { 'search.query_budget_unit': 'chunk' })).toThrow(/already sets/);
    expect(devCell(SHA, { 'search.query_facts_block': false }).arms[0].retrieval!.overlay['search.query_facts_block']).toBe(false);
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
    const a = runAt('overlay-on-why', { overlay: on });
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

describe('the brain and its upkeep', () => {
  test('every VM snapshots the brain and lists its upkeep after the cell, whatever the cell did, and exits with the cell\'s code', () => {
    const cmd = vmCommand(SHA, 'bg1-dev-02');
    const cell = cmd.indexOf('dev-loop.ts cell'), snap = cmd.indexOf('bootstrap.sh snapshot --system gbrain-defaults --out "$SHOOTOUT_OUT/' + BRAIN_SNAPSHOT + '"');
    const list = cmd.indexOf('dev-loop.ts upkeep --snapshot "$SHOOTOUT_OUT/' + BRAIN_SNAPSHOT + '" --out "$SHOOTOUT_OUT/upkeep.ndjson"'), down = cmd.indexOf('bootstrap.sh down');
    expect([cell, snap, list, down].every(i => i > 0)).toBe(true);
    expect(cell < snap && snap < list && list < down).toBe(true);
    expect(cmd.slice(cell, snap)).toContain('rc=$?;');
    expect(cmd.slice(list)).toContain('|| echo');
    expect(cmd.endsWith('exit $rc')).toBe(true);
  });

  test('upkeep runs are read from serve\'s log in order, and a run cut off has no finish', () => {
    const log = ['[gbrain serve] ready', '[gbrain serve] idle upkeep: started', '[gbrain serve] idle sweep: started',
      '[gbrain serve] idle upkeep: finished in 2875 ms (ran)', '[gbrain serve] idle upkeep: started', '[gbrain serve] idle upkeep: finished in 12 ms (skipped cycle_already_running)',
      '[gbrain serve] idle upkeep: started'].join('\n');
    expect(upkeepRuns(log)).toEqual([
      { run: 1, finished: true, ms: 2875, status: 'ran', code: null },
      { run: 2, finished: true, ms: 12, status: 'skipped', code: 'cycle_already_running' },
      { run: 3, finished: false, ms: null, status: null, code: null },
    ]);
    expect(upkeepRuns('[gbrain serve] ready\n')).toEqual([]);
  });

  test('upkeep lists the runs in a bootstrap.sh snapshot, and refuses a tar without the serve log', async () => {
    const dir = join(tmp, 'snapshot');
    const vol = join(dir, 'vol'), work = join(dir, 'work');
    mkdirSync(join(vol, 'logs'), { recursive: true });
    mkdirSync(work, { recursive: true });
    writeFileSync(join(vol, 'logs', 'serve.log'), '[gbrain serve] idle upkeep: started\n[gbrain serve] idle upkeep: finished in 40 ms (ran)\n');
    execFileSync('tar', ['-C', vol, '-cf', join(work, 'gbrain-data.tar'), '.']);
    writeFileSync(join(work, 'volumes.json'), '{}');
    const tar = join(dir, 'brain.tar');
    execFileSync('tar', ['-C', work, '-cf', tar, '.']);
    const out = join(dir, 'upkeep.ndjson');
    expect(await main(['upkeep', '--snapshot', tar, '--out', out])).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(JSON.stringify({ run: 1, finished: true, ms: 40, status: 'ran', code: null }) + '\n');
    const bare = join(dir, 'bare.tar');
    execFileSync('tar', ['-C', vol, '-cf', bare, '.']);
    await expect(main(['upkeep', '--snapshot', bare, '--out', out])).rejects.toThrow();
  });
});

describe('leftover VMs', () => {
  const NOW = Date.parse('2026-11-16T22:00:00Z');
  const at = (hoursAgo: number) => Math.floor(NOW / 1000 - hoursAgo * 3600);
  const fake = (rows: string[], failDown = false) => {
    const calls: string[][] = [];
    const ubi: UbiRunner = args => {
      calls.push(args);
      if (args[0] === 'owner') return 'gbev91\n';
      if (args[0] === 'list') return rows.join('\n') + '\n';
      if (args[0] === 'down' && failDown) throw new Error('down failed');
      return '';
    };
    return { ubi, calls };
  };

  test('a dev-loop VM name carries the owner, the second it was made and the marker; other names are not dev-loop VMs', () => {
    const name = devVmName('gbev91', 'bg1-dev-02', NOW);
    expect(name).toMatch(new RegExp(`^ubirun-gbev91-\\d{10}-devloop-bg1-dev-02-[0-9a-f]{4}-t${DEV_VM_HOURS}$`));
    expect(name.length).toBeLessThanOrEqual(63);
    expect(devVm(name)).toEqual({ owner: 'gbev91', epoch: Math.floor(NOW / 1000) });
    expect(devVm(`ubirun-gbev91-${at(9)}-1a2b3c4d`)).toBeNull();
    expect(devVm('my-database-vm')).toBeNull();
  });

  test(`run destroys only this owner's dev-loop VMs older than ${DEV_VM_HOURS} hours`, () => {
    const old = `ubirun-gbev91-${at(DEV_VM_HOURS + 1)}-devloop-bg1-dev-01-aaaa`;
    const { ubi, calls } = fake([
      `eu-central-h1  ${old}`,
      `eu-central-h1  ubirun-gbev91-${at(DEV_VM_HOURS - 1)}-devloop-bg1-dev-02-bbbb`,
      `eu-central-h1  ubirun-gbev91-${at(30)}-1a2b3c4d`,
      `eu-central-h1  ubirun-gbra108-${at(30)}-devloop-bg1-dev-03-cccc`,
      'a line the runner would never print',
    ]);
    expect(reapDevVms(ubi, NOW)).toEqual([old]);
    expect(calls.filter(c => c[0] === 'down')).toEqual([['down', old, '-l', 'eu-central-h1']]);
    expect(reapDevVms(fake([]).ubi, NOW)).toEqual([]);
    expect(() => reapDevVms(fake([`eu-central-h1  ${old}`], true).ubi, NOW)).toThrow(/down failed/);
  });

  test('after the run, every VM of its own still standing is listed with its pull and down commands', () => {
    const mine = { name: `ubirun-gbev91-${at(1)}-devloop-bg1-dev-01-aaaa`, remote: 'work/gbrain-evals/eval/reports/bg1-dev-loop/devloop-x', local: '/out/worlds' };
    const gone = { ...mine, name: `ubirun-gbev91-${at(1)}-devloop-bg1-dev-02-bbbb` };
    const { ubi } = fake([`eu-central-h1  ${mine.name}`, `eu-central-h1  ubirun-gbev91-${at(1)}-devloop-bg1-dev-03-cccc`]);
    expect(keptDevVms(ubi, 'ubi-runner.sh', [mine, gone])).toEqual([
      `eu-central-h1/${mine.name} is still running. Pull its outputs: bash ubi-runner.sh pull ${mine.name} ${mine.remote} /out/worlds; then destroy it: bash ubi-runner.sh down ${mine.name} -l eu-central-h1. `
        + `Pull it before ${new Date((at(1) + DEV_VM_HOURS * 3600) * 1000).toISOString()}: after that, this owner's next dev-loop run destroys it, pulled or not`,
    ]);
    expect(keptDevVms(fake([]).ubi, 'ubi-runner.sh', [mine])).toEqual([]);
  });
});

/**
 * The BG1 dev loop's 17 extra public dev worlds (GST-2854), keyless: their own list beside stage 1's frozen three, the
 * gold-audit fixes on their plans, the loader and split that admit them without touching the three, the mint's
 * --worlds, the dev and comparator cells on an extra world, the comparator run's wall-clock check, the extra
 * comparator cache and a score and why rows over the extra worlds. Cells run on the fake memory system with a
 * scripted reader and judge, over the template fixtures.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BG1_DATA_DIR, buildQuestions, devWorldPlan } from '../../eval/generators/changing-facts-gen.ts';
import {
  ALL_WORLDS, buildExtraBaselines, COMPARATORS, comparatorCell, comparatorPayload, comparatorVmCommand, DEV_JUDGE, DEV_READER, DEV_WORLD_END, DEV_WORLDS, devCell, DevLoopRefusal,
  EXTRA_WORLDS, loadAllBaselines, loadBaselines, main, parseWorlds, rowWorlds, RUN_SCHEMA, runDevCell, scoreRun, vmPayload, whyRows, type Comparator,
} from '../../eval/runner/bg1/dev-loop.ts';
import { loadSplit } from '../../eval/runner/decisions/splits.ts';
import { BG1_DEV_CONVERSATIONS, BG1_DEV_EXTRA_CONVERSATIONS } from '../../eval/runner/memory-qa/bg1-names.ts';
import { BG1_FIXTURES_ROOT, loadCorpus, type Corpus } from '../../eval/runner/memory-qa/corpus.ts';
import type { ChatLike, ChatResult } from '../../eval/runner/memory-qa/qa-v2.ts';
import { FakeMemorySystem } from '../../eval/runner/systems/fake.ts';

const REPO = resolve(import.meta.dir, '../..');
const SHA = '6ce7195b44a034f85aec811f11fbf862db376f50';
const NO_META = { finish: null, usage: null, response_model: null, attempt_errors: [] as string[] };
const dead = { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, GEMINI_API_KEY: undefined, PARTICLE_API_KEY: undefined, SHOOTOUT_PROXY: undefined };
const tmp = mkdtempSync(join(tmpdir(), 'bg1-dev-extra-'));
const prior = { root: process.env.GBRAIN_EVALS_BG1_DEV_ROOT, end: process.env.GBRAIN_EVALS_BG1_WORLD_END };
let extraCorpus: Corpus;
beforeAll(() => {
  process.env.GBRAIN_EVALS_BG1_DEV_ROOT = BG1_FIXTURES_ROOT;
  process.env.GBRAIN_EVALS_BG1_WORLD_END = DEV_WORLD_END;
  extraCorpus = loadCorpus('bg1-dev', undefined, new Set(EXTRA_WORLDS), { keyless: true });
});
afterEach(() => setSystemTime());
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of [['GBRAIN_EVALS_BG1_DEV_ROOT', prior.root], ['GBRAIN_EVALS_BG1_WORLD_END', prior.end]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

function scripted(correct: number) {
  const calls = { reader: 0, judge: 0 };
  const reader: ChatLike = { async chat(_m, prompt): Promise<ChatResult> { calls.reader++; return { text: /Question: (.*)\n/.exec(prompt)?.[1] ?? 'unknown', input_tokens: Math.ceil(prompt.length / 4), output_tokens: 8, cached: false, ...NO_META }; } };
  const judge: ChatLike = { async chat(): Promise<ChatResult> { calls.judge++; return { text: '{"correct": ' + correct + '}', input_tokens: 100, output_tokens: 4, cached: false, ...NO_META }; } };
  return { calls, reader, judge };
}

class CountingFake extends FakeMemorySystem {
  calls = 0;
  async capabilities() { this.calls++; return super.capabilities(); }
}

describe('the extra dev worlds as a list of their own', () => {
  test("are bg1-dev-04 to bg1-dev-20, and stage 1's three and bg1-dev's split file stay as they were", () => {
    expect(BG1_DEV_CONVERSATIONS).toEqual(['bg1-dev-01', 'bg1-dev-02', 'bg1-dev-03']);
    expect(BG1_DEV_EXTRA_CONVERSATIONS).toEqual(Array.from({ length: 17 }, (_, i) => 'bg1-dev-' + String(i + 4).padStart(2, '0')));
    expect(DEV_WORLDS).toEqual(['bg1-dev-01', 'bg1-dev-02', 'bg1-dev-03']);
    expect(ALL_WORLDS).toHaveLength(20);
    const file = JSON.parse(readFileSync(join(REPO, 'eval/decisions/splits/bg1-dev.json'), 'utf8')) as { dev: string[] };
    expect(file.dev).toEqual([...BG1_DEV_CONVERSATIONS]);
    expect(loadSplit('bg1-dev').dev).toEqual([...BG1_DEV_CONVERSATIONS, ...BG1_DEV_EXTRA_CONVERSATIONS]);
    expect(loadSplit('bg1').dev).toEqual(JSON.parse(readFileSync(join(REPO, 'eval/decisions/splits/bg1.json'), 'utf8')).dev);
  });

  test('their plans carry the gold-audit fixes, and the three stage 1 plans do not', () => {
    for (const id of BG1_DEV_CONVERSATIONS) expect(devWorldPlan(id).gold_audit).toBeUndefined();
    for (const id of BG1_DEV_EXTRA_CONVERSATIONS) {
      const plan = devWorldPlan(id);
      expect(plan.gold_audit).toBe(true);
      expect(plan.custody).toBeUndefined();
      const slots = new Map(plan.slots.map(s => [s.id, s]));
      for (const q of buildQuestions(plan).filter(q => q.bg1.stratum === 's8_history')) expect(slots.get(q.bg1.slot)!.events.some(e => e.type === 'scheduled')).toBe(false);
      expect(readFileSync(join(BG1_DATA_DIR, 'dev/worlds', id, 'questions.json'), 'utf8')).toBe(JSON.stringify(buildQuestions(plan), null, 1) + '\n');
    }
  });

  test('a load with no world list reads the three; one that names extra worlds reads them', () => {
    expect(loadCorpus('bg1-dev', undefined, undefined, { keyless: true }).conversations.map(c => c.id)).toEqual([...BG1_DEV_CONVERSATIONS]);
    expect(extraCorpus.conversations.map(c => c.id)).toEqual([...BG1_DEV_EXTRA_CONVERSATIONS]);
    expect(extraCorpus.questions).toHaveLength(17 * 64);
    expect(() => loadCorpus('bg1-dev', undefined, new Set(['bg1-dev-21']), { keyless: true })).toThrow(/no world bg1-dev-21/);
  });

  test('--worlds takes ids, extra or dev20, and refuses an unknown or repeated world', () => {
    expect(parseWorlds(undefined, DEV_WORLDS)).toEqual([...DEV_WORLDS]);
    expect(parseWorlds('extra', DEV_WORLDS)).toEqual([...EXTRA_WORLDS]);
    expect(parseWorlds('dev20', DEV_WORLDS)).toEqual([...ALL_WORLDS]);
    expect(parseWorlds('bg1-dev-02,bg1-dev-09', DEV_WORLDS)).toEqual(['bg1-dev-02', 'bg1-dev-09']);
    expect(() => parseWorlds('bg1-dev-21', DEV_WORLDS)).toThrow(/--worlds takes/);
    expect(() => parseWorlds('bg1-dev-04,bg1-dev-04', DEV_WORLDS)).toThrow(/bg1-dev-04 more than once/);
    expect(rowWorlds(['bg1-dev-01'])).toEqual(DEV_WORLDS);
    expect(rowWorlds(['bg1-dev-07'])).toEqual(EXTRA_WORLDS);
    expect(rowWorlds(['bg1-dev-01', 'bg1-dev-07'])).toEqual(ALL_WORLDS);
  });
});

describe('the mint', () => {
  test('mint.sh --dev --worlds renders the extra worlds it names from their committed plans, and refuses anything else', () => {
    const env = { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '' };
    const run = (...args: string[]) => spawnSync('bash', [join(REPO, 'eval/custody/bg1/mint.sh'), ...args], { cwd: REPO, encoding: 'utf8', env, timeout: 120_000 });
    const out = join(tmp, 'mint');
    const ok = run('--dev', '--out', out, '--worlds', 'bg1-dev-04', '--fake', '--target-tokens', '3000');
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('summary=dev mode=fake worlds=1 written=1');
    expect(readFileSync(join(out, 'set/worlds/bg1-dev-04/plan.json'), 'utf8')).toBe(readFileSync(join(BG1_DATA_DIR, 'dev/worlds/bg1-dev-04/plan.json'), 'utf8'));
    expect(run('--dev', '--out', join(tmp, 'mint2'), '--worlds', 'bg1-dev-21', '--fake').stderr).toContain('--worlds takes bg1-dev-01 to bg1-dev-20');
    expect(run('--dev', '--out', join(tmp, 'mint3'), '--worlds', 'bg1-dev-05,bg1-dev-05', '--fake').stderr).toContain('lists a world twice');
    expect(run('--dev', '--out', join(tmp, 'mint4'), '--worlds', '', '--fake').stderr).toContain('--worlds names no world');
    expect(run('--out', join(tmp, 'bg1-custody-x'), '--worlds', 'bg1-dev-04', '--fake').stderr).toContain('--worlds lists public dev worlds, so it needs --dev');
  }, 120_000);
});

describe('cells on an extra world', () => {
  test("gbrain's dev cell runs the 17 extra worlds under its own id; on the three it is stage 1's cell as before", () => {
    const three = devCell(SHA), extra = devCell(SHA, {}, 'bg1-dev-05');
    expect(three.id).toBe('bg1-dev3.gbrain-defaults.rs1-stable');
    expect(devCell(SHA, {}, 'bg1-dev-02')).toEqual(three);
    expect(extra.id).toBe('bg1-dev-extra.gbrain-defaults.rs1-stable');
    expect(extra.only_conversations).toEqual([...EXTRA_WORLDS]);
    expect(extra.arms.map(a => a.cell_id)).toEqual(['bg1-dev-extra.gbrain-defaults.rs1-stable.p']);
    expect({ ...extra, id: three.id, only_conversations: three.only_conversations, arms: extra.arms.map(a => ({ ...a, cell_id: three.arms[0].cell_id })), estimate: three.estimate } as unknown).toEqual(three);
    expect(vmPayload(SHA, 'bg1-dev-05', 'l', 3).cell).toBe('bg1-dev-extra.gbrain-defaults.rs1-stable');
  });

  test("a comparator's cell is its stage 1 cell, read by claude-opus-5-5 and judged by gpt-6-astra, without snapshot or restore", () => {
    for (const c of COMPARATORS) {
      const def = comparatorCell(c, 'bg1-dev-04');
      expect(def.system).toBe(c);
      expect(def.id).toBe(c === 'ext-memory-bank' ? 'bg1-dev-extra.ext-memory-bank.recipe' : 'bg1-dev-extra.ext-extract-first.common');
      expect(def.arms.map(a => [a.readers, a.frontier?.judges])).toEqual([[[DEV_READER], [DEV_JUDGE]]]);
      expect(def.snapshot_command ?? def.restore_command ?? null).toBeNull();
      const cmd = comparatorVmCommand(c, 'bg1-dev-04');
      expect(cmd).toContain('bash eval/systems/bootstrap.sh up --system ' + c + ' --config ' + def.launch!.config + ' && bun eval/runner/bg1/dev-loop.ts cell --system ' + c + ' --world bg1-dev-04');
      expect(cmd).toContain('bash eval/systems/bootstrap.sh down --system ' + c + '; exit $rc');
      expect(cmd).not.toContain('FAKETIME');
      expect(comparatorPayload(c, 'bg1-dev-04', 'l', 5)).toMatchObject({ cell: def.id, command: cmd, lease_usd: 5 });
    }
  });

  test("gbrain's cell on an extra world runs that world's shard on the pinned clock", async () => {
    setSystemTime(new Date('2026-12-02T10:00:00Z'));
    const s = scripted(0);
    const out = join(tmp, 'gbrain-extra', 'worlds');
    const res = await runDevCell({ sha: SHA, world: 'bg1-dev-05', out, systemUrl: null, env: { ...process.env, ...dead } },
      { system: new FakeMemorySystem(), reader: s.reader, judge: s.judge, corpus: extraCorpus, clockMs: () => Date.parse('2026-11-09T00:00:00Z') });
    expect(res.share).toMatchObject({ shard: '1/17', questions: 64, complete: true });
    const rc = JSON.parse(readFileSync(join(out, 'cells', 'bg1-dev-extra.gbrain-defaults.rs1-stable.p', 'run-config.json'), 'utf8'));
    expect(rc.cell.only_conversations).toEqual([...EXTRA_WORLDS]);
    writeFileSync(join(tmp, 'gbrain-extra', 'run.json'), JSON.stringify({ schema: RUN_SCHEMA, gbrain_ref: 'v0.60.733.0', gbrain_sha: SHA, worlds: ['bg1-dev-05'], world_end: DEV_WORLD_END }));
  }, 120_000);

  test("a comparator cell takes the runner's wall-clock check: past 14 days after the world end it refuses before any call", async () => {
    const s = scripted(1);
    const system = new CountingFake();
    await expect(runDevCell({ system: 'ext-memory-bank', world: 'bg1-dev-05', out: join(tmp, 'late'), systemUrl: null, env: { ...process.env, ...dead } },
      { system, reader: s.reader, judge: s.judge, corpus: extraCorpus, now: new Date('2026-11-23T08:00:00Z') })).rejects.toThrow(/refusing before any paid call: .*more than 14 days past the world end/);
    expect([system.calls, s.calls.reader, s.calls.judge]).toEqual([0, 0, 0]);
    await expect(runDevCell({ sha: SHA, system: 'ext-memory-bank', world: 'bg1-dev-05', out: join(tmp, 'both'), systemUrl: null, env: { ...process.env, ...dead } })).rejects.toThrow(/one of them/);
  });

  test("with no corpus given, a cell on an extra world loads the 17 rendered extra worlds and runs that world's questions", async () => {
    const s = scripted(1);
    const root = process.env.GBRAIN_EVALS_BG1_DEV_ROOT;
    delete process.env.GBRAIN_EVALS_BG1_DEV_ROOT;
    try {
      const out = join(tmp, 'rendered', 'worlds');
      const res = await runDevCell({ system: 'ext-memory-bank', world: 'bg1-dev-05', out, systemUrl: null, env: { ...process.env, ...dead } },
        { system: new FakeMemorySystem(), reader: s.reader, judge: s.judge, now: new Date('2026-11-17T08:00:00Z') });
      expect(res.share).toMatchObject({ shard: '1/17', questions: 64, complete: true });
      const rc = JSON.parse(readFileSync(join(out, 'cells', 'bg1-dev-extra.ext-memory-bank.recipe.component-b8000', 'run-config.json'), 'utf8'));
      expect(rc.dataset.files.map((f: { path: string }) => f.path.split('/').at(-2))).toEqual([...EXTRA_WORLDS, ...EXTRA_WORLDS].sort());
    } finally { process.env.GBRAIN_EVALS_BG1_DEV_ROOT = root; }
  }, 300_000);

  for (const c of ['ext-memory-bank', 'ext-extract-first'] as Comparator[]) {
    test(c + ' runs its shard of an extra world within the 14 days', async () => {
      const s = scripted(1);
      const dir = join(tmp, c + '-run');
      const res = await runDevCell({ system: c, world: 'bg1-dev-05', out: join(dir, 'worlds'), systemUrl: null, env: { ...process.env, ...dead } },
        { system: new FakeMemorySystem(), reader: s.reader, judge: s.judge, corpus: extraCorpus, now: new Date('2026-11-17T08:00:00Z') });
      expect(res.share).toMatchObject({ shard: '1/17', questions: 64, complete: true });
      writeFileSync(join(dir, 'run.json'), JSON.stringify({ schema: RUN_SCHEMA, system: c, worlds: ['bg1-dev-05'], world_end: DEV_WORLD_END }));
    }, 120_000);
  }
});

describe('the extra comparator cache, scores and why rows', () => {
  const runs = () => COMPARATORS.map(c => join(tmp, c + '-run'));

  test('baselines --extra reads one run per comparator at the stage 1 settings, and a score covers the extra worlds against it', () => {
    const extra = buildExtraBaselines(runs());
    expect(Object.keys(extra.rows).sort()).toEqual([...COMPARATORS].sort());
    for (const c of COMPARATORS) {
      expect(extra.rows[c].settings).toEqual(loadBaselines().rows[c].settings);
      expect(Object.keys(extra.rows[c].questions)).toHaveLength(17 * 64);
      expect(Object.values(extra.rows[c].questions).filter(q => q.score === 1)).toHaveLength(64);
    }
    expect(() => buildExtraBaselines([runs()[0]])).toThrow(/ext-extract-first has none/);
    expect(() => buildExtraBaselines([runs()[0], runs()[0]])).toThrow(/two ext-memory-bank runs/);
    expect(() => buildExtraBaselines([join(tmp, 'gbrain-extra')])).toThrow(/not a comparator run/);

    const file = join(tmp, 'extra-opus.json');
    writeFileSync(file, JSON.stringify(extra));
    const merged = loadAllBaselines(undefined, file);
    for (const c of COMPARATORS) expect(Object.keys(merged.rows[c].questions)).toHaveLength(20 * 64);
    expect(loadAllBaselines(undefined, join(tmp, 'absent.json'))).toEqual(loadBaselines());

    const s = scoreRun(join(tmp, 'gbrain-extra'), { baselines: merged });
    const all = s.classes.find(k => k.label === 'all')!;
    expect([s.questions, all.graded, all.accuracy]).toEqual([17 * 64, 64, 0]);
    for (const c of COMPARATORS) expect(all.comparators[c]).toMatchObject({ accuracy: 1, gap: { delta: -100, n: 64 } });
  });

  test('why rows read the comparator runs beside gbrain on the extra worlds', () => {
    const rows = whyRows(join(tmp, 'gbrain-extra'), { extra: runs() });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.world === 'bg1-dev-05')).toBe(true);
    for (const r of rows) for (const c of COMPARATORS) expect(r.comparators![c].score).toBe(1);
    expect(() => whyRows(join(tmp, 'gbrain-extra'), { extra: [runs()[0]] })).toThrow(/no ext-extract-first comparator run/);
  });
});

describe('run refuses a comparator run that does not fit', () => {
  test('before any window, key or VM', async () => {
    await expect(main(['run', '--system', 'ext-memory-bank', '--worlds', 'bg1-dev-01'])).rejects.toThrow(/comparator run takes extra worlds only/);
    await expect(main(['run', '--system', 'ext-memory-bank', '--gbrain', SHA])).rejects.toThrow(/runs no gbrain/);
    await expect(main(['run', '--system', 'ext-temporal-graph'])).rejects.toThrow(/--system takes/);
    await expect(main(['run', '--worlds', 'bg1-dev-04,bg1-dev-04'])).rejects.toThrow(DevLoopRefusal);
    mkdirSync(join(tmp, 'vm-size'), { recursive: true });
    await expect(main(['run', '--vm-size', 'big', '--out', join(tmp, 'vm-size')])).rejects.toThrow(/--vm-size takes/);
  });
});

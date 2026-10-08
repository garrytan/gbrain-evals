/**
 * Cat 40 exploratory arm `gbrain-fs` (plan 2026-10-07-cat40-hard-fix C16): gbrain's tools plus the fs arm's read
 * tools over the same files, no write_file; tool-name collisions refused; its own cell label; refused outside the
 * development world. Hermetic: fake gbrain slots, scripted agents, no paid call.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateHardWorld } from '../../eval/generators/model-ladder-hard.ts';
import { generateLadderWorld, type LadderTask } from '../../eval/generators/model-ladder-gen.ts';
import { HARD_SEEDS } from '../../eval/generators/hard/schema.ts';
import { FileStore, FsArm, HARD_GREP_TOOL, normalizeDocRef } from '../../eval/runner/cat40/arms.ts';
import {
  GbrainArm, GbrainFsArm, GBRAIN_FS_HINT, GBRAIN_FS_READ_TOOLS, assertNoGbrainFsCollision, cellLabel, instructionsOverride, type GbrainSlot,
} from '../../eval/runner/cat40/gbrain-arm.ts';
import { HardStop, hardRefusals, runHardCell } from '../../eval/runner/cat40/hard.ts';
import { scoreHardTask } from '../../eval/runner/cat40/score-hard.ts';
import { terminateGrepWorkers } from '../../eval/runner/cat40/hard-grep.ts';
import { main, scheduleCells, cellKey } from '../../eval/runner/cat40-model-ladder.ts';
import type { AgentRun } from '../../eval/runner/cat40/loop.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'cat40-gbrain-fs-')); dirs.push(d); return d; };
afterEach(() => {
  instructionsOverride.dropTools = [];
  instructionsOverride.served = null;
  instructionsOverride.servedTools = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(() => terminateGrepWorkers());

const world = generateHardWorld(HARD_SEEDS.calibration);
const writeWorld = (w: unknown) => { const p = join(tmp(), 'world.json'); writeFileSync(p, JSON.stringify(w)); return p; };
const files = new Map([['accounts/acme/crm.md', '---\ntitle: "CRM record"\n---\nowner: Alice Example\n'], ['notes/x.md', 'note']]);

const GBRAIN_TOOLS = [
  { name: 'search', description: 'search the brain', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'get_page', description: 'read a page', inputSchema: { type: 'object', properties: { slug: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'put_page', description: 'write a page', inputSchema: { type: 'object', properties: { slug: { type: 'string' }, content: { type: 'string' } } } },
];
function fakeSlot(tools = GBRAIN_TOOLS) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const lifecycle: string[] = [];
  const client = { instructions: 'fake gbrain instructions', tools, toolsVersion: 0, call: async (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return `gbrain ${name}`; } };
  const slot = { id: 'slot0', client, newSession: async () => { lifecycle.push('newSession'); }, restore: async () => { lifecycle.push('restore'); } } as unknown as GbrainSlot;
  return { slot, calls, lifecycle };
}

describe('gbrain-fs tools, hint and routing', () => {
  test('tools are the gbrain tools plus the fs read tools with the Hard limits, and no write_file', () => {
    const { slot } = fakeSlot();
    const arm = new GbrainFsArm(slot, new FileStore(files), { limits: 'hard' });
    const gbrain = new GbrainArm(slot).tools();
    const fsRead = new FsArm('fs', new FileStore(files), { limits: 'hard' }).tools().filter(t => t.name !== 'write_file');
    expect(arm.tools()).toEqual([...gbrain, ...fsRead]);
    expect(arm.tools().map(t => t.name)).toEqual(['search', 'get_page', 'put_page', ...GBRAIN_FS_READ_TOOLS]);
    expect(arm.tools().find(t => t.name === 'grep')).toEqual(HARD_GREP_TOOL);
    expect(arm.tools().some(t => t.name === 'write_file')).toBe(false);
    expect(arm.writeTools()).toEqual(['put_page']);
    expect(arm.name).toBe('gbrain-fs');
  });

  test('the system hint is the gbrain hint followed by one sentence on the read-only files', () => {
    const { slot } = fakeSlot();
    const arm = new GbrainFsArm(slot, new FileStore(files));
    expect(arm.systemHint()).toBe(`${new GbrainArm(slot).systemHint()}\n${GBRAIN_FS_HINT}`);
    for (const t of GBRAIN_FS_READ_TOOLS) expect(GBRAIN_FS_HINT).toContain(t);
    expect(GBRAIN_FS_HINT).toContain('read-only');
  });

  test('read tools reach the corpus files; every other call reaches gbrain', async () => {
    const { slot, calls } = fakeSlot();
    const arm = new GbrainFsArm(slot, new FileStore(files), { limits: 'hard' });
    expect(await arm.call('read_file', { path: 'accounts/acme/crm.md' })).toContain('owner: Alice Example');
    expect(await arm.call('list_dir', { path: 'accounts' })).toBe('acme/');
    expect(await arm.call('grep', { pattern: 'Alice' })).toBe('accounts/acme/crm.md:4: owner: Alice Example\n[1 matches]');
    expect(await arm.call('search', { query: 'acme' })).toBe('gbrain search');
    expect(await arm.call('write_file', { path: 'notes/y.md', content: 'x' })).toBe('gbrain write_file');
    expect(calls.map(c => c.name)).toEqual(['search', 'write_file']);
  });

  test('a gbrain tool named like an fs read tool is refused, unless withheld with --gbrain-drop-tools', () => {
    const { slot } = fakeSlot([...GBRAIN_TOOLS, { name: 'grep', description: 'gbrain grep', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }]);
    const arm = new GbrainFsArm(slot, new FileStore(files));
    expect(() => arm.tools()).toThrow('gbrain-fs: the gbrain server serves grep, which collides with the fs read tool of the same name; withhold it with --gbrain-drop-tools grep');
    expect(() => assertNoGbrainFsCollision(['search', 'read_file', 'list_dir'])).toThrow('serves read_file, list_dir');
    expect(() => assertNoGbrainFsCollision(GBRAIN_TOOLS.map(t => t.name))).not.toThrow();
    instructionsOverride.dropTools = ['grep'];
    expect(arm.tools().filter(t => t.name === 'grep')).toEqual([new FsArm('fs', new FileStore(files)).tools().find(t => t.name === 'grep')!]);
  });
});

describe('gbrain-fs cells', () => {
  test('cells are labelled <gbrain-label>+fs and never share a key with gbrain cells', () => {
    expect(cellLabel('gbrain-fs', 'gbrain-hard-fix')).toBe('gbrain-hard-fix+fs');
    expect(cellLabel('gbrain', 'gbrain-hard-fix')).toBe('gbrain-hard-fix');
    expect(cellLabel('fs', 'gbrain-hard-fix')).toBe('fs');
    const tasks = generateLadderWorld().tasks.slice(0, 1) as LadderTask[];
    const done = new Set([cellKey('m', 'gbrain-hard-fix', tasks[0].id, 0)]);
    const cells = scheduleCells({ tasks, models: ['m'], arms: ['gbrain', 'gbrain-fs'], repeats: 1, order: 'task', gbrainLabel: 'gbrain-hard-fix', done });
    expect(cells.map(c => c.arm)).toEqual(['gbrain-fs']);
  });

  test('scripted H5 cell: gbrain slot lifecycle, gbrain writes, fs reads, label +fs, write diagnostic', async () => {
    const { slot, calls, lifecycle } = fakeSlot();
    const pool = { acquire: async () => slot, restoreOrQuarantine: async () => { lifecycle.push('restoreOrQuarantine'); return null; }, quarantined: new Map() };
    const proxy = { bind: () => {}, unbind: () => {}, finalize: async () => ({ usd: 0, requests: 0, unpriced: 0, byModel: {} }) };
    const h5 = world.tasks.find(t => t.family === 'H5')!;
    const rec = await runHardCell({ world, worldDigest: 'd', files: { all: files }, pool: pool as never, proxy: proxy as never, scripted: true, judge: null, gbrainLabel: 'gbrain-hard-fix', maxToolChars: null, maxTurns: 4, toolLimits: 'hard', budgetRunId: null, logJudge: () => {} }, 'scripted', 'gbrain-fs', h5, 0, 1);
    expect(rec.arm).toBe('gbrain-hard-fix+fs');
    expect(rec.key).toBe(`scripted|gbrain-hard-fix+fs|${h5.id}|0`);
    expect(rec.stop).toBe('submitted');
    expect(lifecycle).toEqual(['newSession', 'newSession', 'newSession', 'newSession', 'restoreOrQuarantine']);
    expect(calls.map(c => c.name)).toEqual(['put_page', 'put_page', 'put_page', 'put_page']);
    expect(rec.sessions.slice(0, 4).every(s => s.writes.length === 1 && s.writes[0].startsWith('notes/session-'))).toBe(true);
    expect(rec.sessions[4].run.tool_calls.map(t => t.name)).toEqual(['list_dir']);
    expect(rec.score.wrote).toBe(true);
    expect(rec.write_diagnostic!.length).toBeGreaterThan(0);
    expect(rec.gbrain_internal).toBeDefined();
  });

  test('evidence counts whether cited as a gbrain slug or a file path', () => {
    const task = world.tasks.find(t => t.gold.evidence.length >= 2)!;
    const [a, b] = task.gold.evidence;
    expect(normalizeDocRef(a)).toBe(normalizeDocRef(`${a}.md`));
    expect(normalizeDocRef(a)).toBe(normalizeDocRef(`./${a}.md`));
    const run = { final: { answer: 'UNKNOWN', sources: [a, `${b}.md`] }, stop: 'submitted' } as unknown as AgentRun;
    const score = scoreHardTask(world, task, [run]);
    expect(score.evidence_cited).toEqual([a, b].map(normalizeDocRef));
  });
});

describe('gbrain-fs runs only on the development world', () => {
  const code = (f: () => void) => { try { f(); return null; } catch (e) { return e instanceof HardStop ? e : null; } };
  const base = { models: ['claude-sonnet-5-5'], judge: 'gpt-6.1-sol', arms: ['gbrain-fs'], scripted: false };

  test('refused on the held-out and smoke seeds, an unknown (confirmation) seed, and in any program step', () => {
    for (const seed of [HARD_SEEDS.heldout, HARD_SEEDS.smoke, 20261234, undefined]) expect(code(() => hardRefusals({ ...base, seed }))!.code).toBe('HARD_ARM_EXPLORATORY');
    for (const step of ['calibrate', 'smoke', 'cells-50k']) expect(code(() => hardRefusals({ ...base, seed: HARD_SEEDS.calibration, step }))!.code).toBe('HARD_ARM_EXPLORATORY');
    expect(code(() => hardRefusals({ ...base, seed: HARD_SEEDS.calibration }))).toBeNull();
    expect(code(() => hardRefusals({ ...base, arms: ['gbrain', 'fs'], seed: HARD_SEEDS.heldout }))).toBeNull();
  });

  test('the runner refuses it on a held-out world and in a step before anything runs, and on v1 worlds', async () => {
    await expect(main(['--world', writeWorld(generateHardWorld(HARD_SEEDS.heldout)), '--models', 'claude-sonnet-5-5', '--judge', 'gpt-6.1-sol', '--arms', 'gbrain-fs', '--out', tmp(), '--preflight'])).rejects.toThrow('HARD_ARM_EXPLORATORY');
    await expect(main(['--scripted', '--world', writeWorld(world), '--arms', 'gbrain-fs', '--step', 'calibrate', '--out', tmp()])).rejects.toThrow('HARD_ARM_EXPLORATORY');
    await expect(main(['--scripted', '--arms', 'gbrain-fs', '--out', tmp()])).rejects.toThrow('gbrain-fs is an exploratory Hard arm');
  }, 60_000);
});

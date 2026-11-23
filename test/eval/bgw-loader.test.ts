/**
 * The bgw loader (Set W, the weekly outcome line's own worlds; docs/benchmarks/2026-11-23-weekly-outcome-line-
 * preregistration.md, "The worlds" and "Custody and exposure"): slots 1001 and up with four-digit ids, minted in monthly
 * batches named by their first world, each batch a sealed set of its own with its committed manifest template and split
 * entries; one week's eight worlds per launch unit; each week's world end the Sunday before its Tuesday launch, through
 * the existing world-end mechanism and run clock. A batch is planned from a test seed and rendered from templates into a
 * temporary custody root, in the layout mint.sh --bgw writes. Keyless and offline; no sealed byte is used here.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BG1_CUSTODY_MARKER, PUBLIC_PHRASING, buildQuestions, bgwWorldSeed, planWorld, renderTemplateWorld, sealedWorldSeed } from '../../eval/generators/changing-facts-gen.ts';
import { DecideError } from '../../eval/runner/decisions/errors.ts';
import { loadSplit } from '../../eval/runner/decisions/splits.ts';
import {
  BG1_CONVERSATIONS, BG1C_CONVERSATIONS, BGW_BATCH_KEPT, BGW_BATCH_SLOTS, BGW_CAMPAIGN, BGW_DROP_CAP, BGW_SEED_SETS, BGW_SPLIT, bgwBatchDataset, bgwBatchIds, bgwBatchManifest,
  bgwBatchSlots, bgwFilledManifest, bgwSlotOf, bgwWorldId,
} from '../../eval/runner/bg1/types.ts';
import {
  BG1_MANIFEST, BG1_SET, BG1C_MANIFEST, BG1C_SET, bg1Kept, bg1ManifestFiles, bg1RunClock, bg1SealedSet, bg1Source, bg1UnitScope, bg1WorldEnd, bg1WorldFiles, bgwCommittedProblems,
  bgwSet, bgwWeekWorldEnd, bgwWeekWorlds, fetchDataset, filesFor, loadBg1, loadBg1c, loadBgw, loadCorpus, readBg1Manifest, verifyBg1Custody, type Bg1Manifest,
} from '../../eval/runner/memory-qa/corpus.ts';
import { DATASET_PINS } from '../../eval/runner/q1/reuse-check.ts';

const REPO = resolve(import.meta.dir, '../..');
const ENV = ['GBRAIN_EVALS_BGW_SOURCE', 'GBRAIN_EVALS_BGW_MANIFEST', 'GBRAIN_EVALS_BGW_UNIT', 'GBRAIN_EVALS_BGW_BATCH', 'GBRAIN_EVALS_BG1C_SOURCE', 'GBRAIN_EVALS_BG1C_MANIFEST',
  'GBRAIN_EVALS_BG1_SOURCE', 'GBRAIN_EVALS_BG1_MANIFEST', 'GBRAIN_EVALS_BG1_WORLD_END', 'GBRAIN_EVALS_CUSTODY_LOG', 'GBRAIN_EVALS_DECISION_ID'] as const;
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
const dirs: string[] = [];
const tmp = (name: string) => { const d = mkdtempSync(join(tmpdir(), `bgw-loader-${name}-`)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const END = '2026-11-15';
const code = (f: () => unknown) => { try { f(); } catch (e) { return e instanceof DecideError ? e.op.code : (e as Error).message; } return 'no error'; };
const message = (f: () => unknown) => { try { f(); } catch (e) { return e instanceof DecideError ? e.op.message : (e as Error).message; } return 'no error'; };
const custody = (log: string) => ({ log, decisionId: 'test', purpose: 'bgw loader test' });
const SLOTS = [1001, 1002, 1003];
const IDS = SLOTS.map(bgwWorldId);
const W1 = () => bgwSet(1001);
const SEED_LINE = ['bgw', 'seed', 'v1'].join('-') + ':' + sha('bgw loader test seed');

let set = '';
beforeAll(() => {
  set = join(tmp('custody'), 'bgw-custody-1001', 'set');
  const phrasing = { ...PUBLIC_PHRASING, custody: BG1_CUSTODY_MARKER };
  const json = (v: unknown) => JSON.stringify(v, null, 1) + '\n';
  for (const slot of SLOTS) {
    const plan = planWorld(bgwWorldId(slot), bgwWorldSeed(SEED_LINE, slot), { phrasing, custody: true });
    const dir = join(set, 'worlds', bgwWorldId(slot));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plan.json'), json(plan));
    writeFileSync(join(dir, 'questions.json'), json(buildQuestions(plan, phrasing)));
    writeFileSync(join(dir, 'world.json'), json(renderTemplateWorld(plan, 4000)));
  }
}, 120_000);

/** A filled manifest from a committed template (batch bgw-1001's by default) over the test set's three worlds. */
const fill = (m: Partial<Bg1Manifest> = {}, template = bgwBatchManifest(1001)): string => {
  const path = join(tmp('manifest'), 'manifest.json');
  const base = JSON.parse(readFileSync(join(REPO, template), 'utf8')) as Bg1Manifest;
  writeFileSync(path, JSON.stringify({ ...base, status: 'filled', files: bg1ManifestFiles(set, IDS, W1()), filled_at: '2026-11-23', kept: IDS, ...m }));
  return path;
};
/** A filled manifest object whose kept worlds are pinned by placeholder hashes, for the kept-list and week rules. */
const keptManifest = (kept: string[], n_final?: number, dataset = bgwBatchDataset(1001)): Bg1Manifest => ({ dataset, status: 'filled', layout: 'test', note: 'test', filled_at: '2026-11-23', kept,
  files: kept.flatMap(id => ['world.json', 'questions.json'].map(f => ({ path: `worlds/${id}/${f}`, sha256: 'a'.repeat(64) }))), ...(n_final === undefined ? {} : { n_final }) });

describe('Set W\'s slots, ids and batches', () => {
  // Value: protects=Set W lives on its own four-digit slots, apart from BG1's and BG1-C's, and a batch is 56 slots inside one seed set; fails_when=a Set W id has three digits, overlaps BG1 or BG1-C, or a batch crosses its seed set's end; why_new=weekly-line preregistration "The worlds" (set W on slots 1001 and up, bgw-1001 onward); seam=bg1-names.ts; no_claim=custody
  test('W1 holds slots 1001 to 1999 with ids bgw-1001 to bgw-1999, four digits, and no slot outside a seed set has an id', () => {
    expect(BGW_SEED_SETS).toEqual([{ id: 'W1', first: 1001, last: 1999 }]);
    expect([1001, 1056, 1999].map(bgwWorldId)).toEqual(['bgw-1001', 'bgw-1056', 'bgw-1999']);
    for (const slot of [1000, 2000, 31, 96, 1001.5]) expect(() => bgwWorldId(slot)).toThrow('is not in any Set W seed set');
    expect(['bgw-1001', 'bgw-1999', 'bgw-01001', 'bgw-101', 'bgw-2000', 'bgw-1001x', 'bg1-031', 'bg1-1001'].map(bgwSlotOf)).toEqual([1001, 1999, null, null, null, null, null, null]);
    expect([BGW_BATCH_SLOTS, BGW_BATCH_KEPT, BGW_DROP_CAP]).toEqual([56, 34, 2]);
    const ids = bgwBatchIds(1001);
    expect([ids.length, ids[0], ids.at(-1)]).toEqual([56, 'bgw-1001', 'bgw-1056']);
    expect(ids.filter(id => BG1_CONVERSATIONS.includes(id) || BG1C_CONVERSATIONS.includes(id))).toEqual([]);
    expect(bgwBatchSlots(1944).at(-1)).toBe(1999);
    expect(() => bgwBatchSlots(1945)).toThrow('would run to slot 2000, past seed set W1\'s last slot 1999');
    expect([bgwBatchManifest(1001), bgwFilledManifest(1001), bgwBatchDataset(1001)]).toEqual(['eval/decisions/datasets/bgw-1001-manifest.json', 'bgw-1001-manifest.json', 'Set W weekly outcome line, batch bgw-1001']);
  });

  // Value: protects=the first batch's split entries and manifest template are committed before any Set W world is minted, and a batch without them cannot load; fails_when=the split misses a slot of bgw-1001, the template is filled or carries another dataset, or an uncommitted batch loads; why_new=weekly-line preregistration "Custody and exposure" (a filled manifest of the line's own pins every file of set W); seam=the committed split and template and corpus.ts bgwSet; no_claim=later batches' files
  test('batch bgw-1001 has its committed split entries and unfilled template; an uncommitted batch refuses', () => {
    expect(loadSplit('bgw')).toMatchObject({ benchmark: 'bgw', dev: [], sealed: bgwBatchIds(1001), dev_fraction: 0 });
    expect(BGW_SPLIT).toBe('eval/decisions/splits/bgw.json');
    const { manifest } = readBg1Manifest(join(REPO, bgwBatchManifest(1001)), W1());
    expect(manifest).toMatchObject({ dataset: bgwBatchDataset(1001), status: 'unfilled', files: [], filled_at: null });
    expect(bgwCommittedProblems(1001)).toEqual([]);
    expect(W1()).toMatchObject({ benchmark: 'bgw', label: 'Set W batch bgw-1001', dataset: bgwBatchDataset(1001), manifest: bgwBatchManifest(1001), nFloor: 1, nCap: 34, campaign: BGW_CAMPAIGN,
      env: { source: 'GBRAIN_EVALS_BGW_SOURCE', manifest: 'GBRAIN_EVALS_BGW_MANIFEST', unit: 'GBRAIN_EVALS_BGW_UNIT' }, split: BGW_SPLIT });
    expect(W1().ids).toEqual(bgwBatchIds(1001));
    expect(code(() => bgwSet(1036))).toBe('DATASET_MISSING');
    expect(message(() => bgwSet(1036))).toContain('eval/decisions/datasets/bgw-1036-manifest.json is not committed');
    expect(message(() => bgwSet(1036))).toContain('does not list 35 of the batch\'s slots as sealed (first bgw-1057)');
    expect(code(() => bgwSet(1000))).toBe('SPEC_INVALID');
    expect(code(() => bgwSet(1950))).toBe('SPEC_INVALID');
    expect(DATASET_PINS[bgwBatchManifest(1001)]).toEqual(['bgw']);
  });

  test('GBRAIN_EVALS_BGW_BATCH names the batch by its first world id, and nothing else picks one', () => {
    expect(bg1SealedSet('bgw', { GBRAIN_EVALS_BGW_BATCH: 'bgw-1001' })).toBe(W1());
    expect(code(() => bg1SealedSet('bgw', {}))).toBe('SPEC_MISSING');
    expect(message(() => bg1SealedSet('bgw', {}))).toBe('bgw: GBRAIN_EVALS_BGW_BATCH is not set');
    for (const raw of ['1001', 'bgw-01001', 'bgw-101', 'bg1-031']) expect(code(() => bg1SealedSet('bgw', { GBRAIN_EVALS_BGW_BATCH: raw }))).toBe('SPEC_INVALID');
    expect(code(() => bg1SealedSet('bgw', { GBRAIN_EVALS_BGW_BATCH: 'bgw-1002' }))).toBe('DATASET_MISSING');
  });

  // Value: protects=a slot's Set W seed is never the seed BG1's seed gives that slot; fails_when=bgwWorldSeed derives from BG1's message or key, so Set W re-plans a BG1 or BG1-C world; why_new=weekly-line preregistration "A new seed and a new phrasing set"; seam=changing-facts-gen.ts bgwWorldSeed; no_claim=the custody seeds (bgw-checks.ts seed checks those)
  test('Set W\'s world seed differs from BG1\'s for the same slot, even from the same 64 hex digits', () => {
    const hex = sha('one secret');
    const bg1Line = ['bg1', 'seed', 'v1'].join('-') + ':' + hex, bgwLine = ['bgw', 'seed', 'v1'].join('-') + ':' + hex;
    for (const slot of [31, 96, 1001, 1999]) expect(bgwWorldSeed(bgwLine, slot)).not.toBe(sealedWorldSeed(bg1Line, slot));
    expect(bgwWorldSeed(bg1Line, 1001)).not.toBe(sealedWorldSeed(bg1Line, 1001));
  });
});

describe('the bgw loader', () => {
  test('loads a batch with a custody log, logging each world under bgw first, and pins it against the batch\'s manifest', () => {
    const log = join(tmp('log'), 'access.jsonl');
    const manifest = fill();
    const c = loadBgw(custody(log), { batch: 1001, root: set, manifestPath: manifest, worldEnd: END, only: new Set(IDS) });
    expect(c.benchmark).toBe('bgw');
    expect(c.conversations.map(x => x.id)).toEqual(IDS);
    expect(c.questions).toHaveLength(3 * 64);
    expect(c.questions.every(q => q.question_date === '2026-11-16')).toBe(true);
    expect(c.source.name).toBe(`${bgwBatchDataset(1001)} (minted in custody, world end ${END})`);
    expect(c.source.files[0]).toEqual({ path: bgwBatchManifest(1001), sha256: sha(readFileSync(manifest)) });
    const lines = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { purpose: string });
    expect(lines.map(l => l.purpose)).toEqual(IDS.map(id => `bgw ${id}: bgw loader test`));
  });

  // Value: protects=the bgw loader opens only its batch's four-digit worlds; fails_when=loadBgw, its file lookup, unit scope or kept list accepts a three-digit BG1 id, another batch's id or a malformed four-digit id; why_new=weekly-line harness item 2 (four-digit ids everywhere a bg1-NNN pattern is assumed); seam=corpus.ts bgwSet ids; no_claim=forged ids
  test('refuses BG1 and BG1-C worlds, another batch\'s worlds and malformed ids in a load, a file lookup, the unit scope and the kept list', () => {
    const log = join(tmp('log'), 'access.jsonl');
    expect(message(() => loadBgw(custody(log), { batch: 1001, root: set, manifestPath: fill(), worldEnd: END, only: new Set(['bgw-1001', 'bg1-031']) }))).toBe('bgw has no world bg1-031');
    expect(message(() => loadBgw(custody(log), { batch: 1001, root: set, manifestPath: fill(), worldEnd: END, only: new Set(['bgw-1057']) }))).toBe('bgw has no world bgw-1057');
    expect(() => bg1WorldFiles(set, 'bgw-1057', W1())).toThrow('bgw has no world bgw-1057');
    expect(() => bg1WorldFiles(set, 'bgw-01001', W1())).toThrow('bgw has no world bgw-01001');
    expect(bg1WorldFiles(set, 'bgw-1001', W1())).toEqual({ world: 'worlds/bgw-1001/world.json', questions: 'worlds/bgw-1001/questions.json' });
    expect(code(() => bg1UnitScope({ GBRAIN_EVALS_BGW_UNIT: 'bgw-1001,bg1-031' }, W1()))).toBe('CUSTODY_MISSING');
    expect(code(() => bg1UnitScope({ GBRAIN_EVALS_BGW_UNIT: 'bgw-1001,bgw-1057' }, W1()))).toBe('CUSTODY_MISSING');
    expect(bg1UnitScope({ GBRAIN_EVALS_BGW_UNIT: 'bgw-1001,bgw-1002', GBRAIN_EVALS_BG1C_UNIT: 'bg1-031' }, W1())).toEqual(['bgw-1001', 'bgw-1002']);
    expect(message(() => bg1Kept(keptManifest(['bgw-1001', 'bgw-1057']), W1()))).toBe('bgw: kept bgw-1057 is not one of the 56 mint slots');
    expect(message(() => bg1Kept(keptManifest(['bg1-031', 'bgw-1001']), W1()))).toBe('bgw: kept bg1-031 is not one of the 56 mint slots');
    expect(() => readFileSync(log)).toThrow();
  });

  // Value: protects=each set's loader reads only its own manifest, and a Set W batch only its own batch's; fails_when=the bgw loader runs on BG1's, BG1-C's or another batch's manifest, or BG1's or BG1-C's loader runs on a Set W manifest; why_new=weekly-line preregistration "Custody and exposure" (a filled manifest of the line's own); seam=corpus.ts readBg1Manifest; no_claim=forged manifests (a manifest relabelled by hand)
  test('refuses BG1\'s, BG1-C\'s and another batch\'s manifests, and BG1\'s and BG1-C\'s loaders refuse a Set W manifest', () => {
    const log = join(tmp('log'), 'access.jsonl');
    expect(code(() => loadBgw(custody(log), { batch: 1001, root: set, manifestPath: join(REPO, BG1C_MANIFEST), worldEnd: END }))).toBe('DATASET_MISSING');
    expect(message(() => loadBgw(custody(log), { batch: 1001, root: set, manifestPath: fill({}, BG1_MANIFEST), worldEnd: END }))).toContain('is the manifest of "BG1 changing-facts set", not of the Set W batch bgw-1001 set');
    expect(code(() => loadBgw(custody(log), { batch: 1001, root: set, manifestPath: fill({ dataset: bgwBatchDataset(1036) }), worldEnd: END }))).toBe('DATASET_MISSING');
    expect(code(() => readBg1Manifest(join(REPO, bgwBatchManifest(1001))))).toBe('DATASET_MISSING');
    expect(code(() => readBg1Manifest(join(REPO, bgwBatchManifest(1001)), BG1C_SET))).toBe('DATASET_MISSING');
    expect(code(() => loadBg1(custody(log), { root: set, manifestPath: fill(), worldEnd: END, only: new Set(['bg1-001']) }))).toBe('DATASET_MISSING');
    expect(code(() => loadBg1c(custody(log), { root: set, manifestPath: fill(), worldEnd: END, only: new Set(['bg1-031']) }))).toBe('DATASET_MISSING');
    expect(message(() => loadBg1(custody(log), { root: set, worldEnd: END, only: new Set(['bgw-1001']) }))).toBe('bg1 has no world bgw-1001');
    expect(readBg1Manifest(undefined, W1()).manifest.status).toBe('unfilled');
    expect(readBg1Manifest(join(REPO, BG1_MANIFEST)).manifest.dataset).toBe(BG1_SET.dataset);
    expect(() => readFileSync(log)).toThrow();
  });

  test('loadCorpus, filesFor and decide fetch read Set W\'s own variables and campaign, and the unit scope holds a load to its week', () => {
    process.env.GBRAIN_EVALS_BG1C_SOURCE = set;
    expect(message(() => loadCorpus('bgw'))).toBe('bgw: GBRAIN_EVALS_BGW_BATCH is not set');
    process.env.GBRAIN_EVALS_BGW_BATCH = 'bgw-1001';
    expect(message(() => loadCorpus('bgw'))).toBe('bgw: GBRAIN_EVALS_BGW_SOURCE is not set');
    expect(code(() => bg1Source({ GBRAIN_EVALS_BGW_SOURCE: join(REPO, 'eval') }, W1()))).toBe('CUSTODY_MISSING');
    expect(code(() => filesFor('bgw'))).toBe('CUSTODY_MISSING');
    process.env.GBRAIN_EVALS_BGW_SOURCE = set;
    expect(message(() => loadCorpus('bgw'))).toBe('bgw questions open only on the custodian host');
    const log = join(tmp('log'), 'access.jsonl');
    process.env.GBRAIN_EVALS_CUSTODY_LOG = log;
    process.env.GBRAIN_EVALS_BGW_MANIFEST = fill();
    process.env.GBRAIN_EVALS_BG1_WORLD_END = END;
    const c = loadCorpus('bgw', undefined, new Set(['bgw-1002']));
    expect(c.conversations.map(x => x.id)).toEqual(['bgw-1002']);
    expect((JSON.parse(readFileSync(log, 'utf8').trim()) as { decision_id: string }).decision_id).toBe(BGW_CAMPAIGN);
    process.env.GBRAIN_EVALS_BGW_UNIT = 'bgw-1001';
    expect(code(() => loadCorpus('bgw', undefined, new Set(['bgw-1002'])))).toBe('CUSTODY_MISSING');
    expect(code(() => verifyBg1Custody(() => {}, W1()))).toBe('CUSTODY_MISSING');
    delete process.env.GBRAIN_EVALS_BGW_UNIT;
    expect(verifyBg1Custody(() => {}, W1())).toBe(6);
  });

  test('decide fetch for bgw verifies the batch\'s pinned files and refuses a changed one', async () => {
    process.env.GBRAIN_EVALS_BGW_BATCH = 'bgw-1001';
    process.env.GBRAIN_EVALS_BGW_SOURCE = set;
    process.env.GBRAIN_EVALS_BGW_MANIFEST = fill({ files: bg1ManifestFiles(set, IDS, W1()).map((f, i) => (i === 0 ? { ...f, sha256: 'b'.repeat(64) } : f)) });
    expect(code(() => verifyBg1Custody(() => {}, W1()))).toBe('DATASET_HASH_MISMATCH');
    process.env.GBRAIN_EVALS_BGW_MANIFEST = fill();
    expect(await fetchDataset('bgw', { log: () => {} })).toEqual({ fetched: 0, verified: 6 });
  });
});

describe('weeks', () => {
  const ids = bgwBatchIds(1001);
  // Value: protects=week k reads kept worlds 8(k-1)+1 to 8k in slot order, the two spares never form a week, and a short batch loses spares before weeks; fails_when=a week reads another week's or a spare world, week 5 exists, a partial week runs before the batch is final, or n_final passes 34; why_new=weekly-line preregistration "Minting" (four weeks of worlds plus two spares, a week uses its 8 worlds in slot order); seam=corpus.ts bgwWeekWorlds over bg1UnitConversations; no_claim=the weekly runner
  test('each week is eight kept worlds in slot order; spares are kept worlds 33 and 34; a final short batch runs a partial last week', () => {
    const full = keptManifest(ids.slice(0, 34), 34);
    expect([1, 2, 3, 4].map(w => bgwWeekWorlds(full, w, W1()))).toEqual([ids.slice(0, 8), ids.slice(8, 16), ids.slice(16, 24), ids.slice(24, 32)]);
    for (const week of [0, 5, 1.5]) expect(() => bgwWeekWorlds(full, week, W1())).toThrow(`bgw: week ${week} is not one of a batch's weeks, 1 to 4`);
    expect(() => bgwWeekWorlds(full, 1, BG1C_SET)).toThrow('bg1c has no weeks');
    const skipping = keptManifest([...ids.slice(0, 5), ...ids.slice(7, 36)], 34);
    expect(bgwWeekWorlds(skipping, 1, W1())).toEqual([...ids.slice(0, 5), ...ids.slice(7, 10)]);
    expect(bgwWeekWorlds(keptManifest(ids.slice(0, 33), 33), 4, W1())).toEqual(ids.slice(24, 32));
    const growing = keptManifest(ids.slice(0, 20));
    expect(bgwWeekWorlds(growing, 2, W1())).toEqual(ids.slice(8, 16));
    expect(message(() => bgwWeekWorlds(growing, 3, W1()))).toBe('bgw: launch unit 2 needs kept worlds 17 to 24, and the kept list holds 20');
    expect(bgwWeekWorlds(keptManifest(ids.slice(0, 30), 30), 4, W1())).toEqual(ids.slice(24, 30));
    expect(message(() => bgwWeekWorlds(keptManifest(ids.slice(0, 20), 20), 4, W1()))).toBe('bgw: launch unit 3 needs kept worlds 25 to 32, and the kept list holds 20 (final)');
    expect(message(() => bg1Kept(keptManifest(ids.slice(0, 35), 35), W1()))).toBe('bgw: n_final 35 must be a whole number from 1 to 34, at least the kept list\'s 35');
  });

  // Value: protects=each week's worlds resolve their dates from that week's own world end, the Sunday before its Tuesday launch, and the run refuses once the clock passes it by 14 days; fails_when=a launch on another weekday gets a world end, the world end is not the Sunday before, or a cell runs more than 14 days late; why_new=weekly-line preregistration "Dates"; seam=corpus.ts bgwWeekWorldEnd, bg1WorldEnd and bg1RunClock; no_claim=the runner's own wiring of GBRAIN_EVALS_BG1_WORLD_END
  test('a week\'s world end is the Sunday before its Tuesday launch, its dates resolve from it, and the run clock refuses past 14 days', () => {
    expect(bgwWeekWorldEnd('2026-11-17')).toBe('2026-11-15');
    expect(bgwWeekWorldEnd('2026-12-01')).toBe('2026-11-29');
    expect(message(() => bgwWeekWorldEnd('2026-11-18'))).toBe('bgw: launch 2026-11-18 is a Wednesday, not a Tuesday');
    expect(code(() => bgwWeekWorldEnd('2026-11-31'))).toBe('SPEC_INVALID');
    expect(bg1WorldEnd({ env: { GBRAIN_EVALS_BG1_WORLD_END: bgwWeekWorldEnd('2026-11-24') } })).toBe('2026-11-22');
    const worldEnd = bgwWeekWorldEnd('2026-11-17');
    expect(bg1RunClock({ worldEnd, now: new Date('2026-11-17T09:00:00Z') })).toBe(worldEnd);
    expect(bg1RunClock({ worldEnd, now: new Date('2026-11-29T23:00:00Z') })).toBe(worldEnd);
    expect(message(() => bg1RunClock({ worldEnd, now: new Date('2026-11-30T00:00:00Z') }))).toBe('bg1: today (2026-11-30) is more than 14 days past the world end 2026-11-15');
    expect(message(() => bg1RunClock({ worldEnd, now: new Date('2026-11-15T12:00:00Z') }))).toBe('bg1: today (2026-11-15) is not after the world end 2026-11-15');
    const log = join(tmp('log'), 'access.jsonl');
    const one = (end: string) => loadBgw(custody(log), { batch: 1001, root: set, manifestPath: fill(), worldEnd: end, only: new Set(['bgw-1001']) });
    const [a, b] = [one(bgwWeekWorldEnd('2026-11-17')), one(bgwWeekWorldEnd('2026-11-24'))];
    expect(a.questions[0].question_date).toBe('2026-11-16');
    expect(b.questions[0].question_date).toBe('2026-11-23');
    const last = (c: typeof a) => c.conversations[0].sessions.at(-1)!.date!;
    expect(new Date(last(b)).getTime() - new Date(last(a)).getTime()).toBe(7 * 86_400_000);
  });
});

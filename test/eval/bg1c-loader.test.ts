/**
 * The bg1c loader (BG1-C, docs/benchmarks/2026-11-19-changing-facts-confirmation-preregistration.md, harness item 1):
 * BG1's set shrinks to its kept slots 1 to 30, BG1-C holds 31 to 96, and each set's loader, unit scope, kept list,
 * custody check and manifest refuse the other set's worlds. A BG1-C set is planned from a test seed and rendered from
 * templates into a temporary custody root, in the layout mint.sh --bg1c writes. Keyless and offline; no sealed byte is
 * used here.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BG1_CUSTODY_MARKER, PUBLIC_PHRASING, buildQuestions, planWorld, renderTemplateWorld, sealedWorldSeed } from '../../eval/generators/changing-facts-gen.ts';
import { DecideError } from '../../eval/runner/decisions/errors.ts';
import { loadSplit } from '../../eval/runner/decisions/splits.ts';
import { BG1_CONVERSATIONS, BG1C_CAMPAIGN, BG1C_CONVERSATIONS, BG1C_DATASET, BG1C_FIRST_SLOT, BG1C_LAST_SLOT, BG1C_N_FINAL, bg1WorldId } from '../../eval/runner/bg1/types.ts';
import {
  BG1_MANIFEST, BG1_SET, BG1C_MANIFEST, BG1C_SET, bg1Kept, bg1ManifestFiles, bg1Source, bg1UnitConversations, bg1UnitScope, bg1WorldFiles, fetchDataset, filesFor, loadBg1, loadBg1c,
  loadCorpus, readBg1Manifest, verifyBg1Custody, type Bg1Manifest,
} from '../../eval/runner/memory-qa/corpus.ts';

const REPO = resolve(import.meta.dir, '../..');
const ENV = ['GBRAIN_EVALS_BG1_SOURCE', 'GBRAIN_EVALS_BG1_MANIFEST', 'GBRAIN_EVALS_BG1_UNIT', 'GBRAIN_EVALS_BG1C_SOURCE', 'GBRAIN_EVALS_BG1C_MANIFEST', 'GBRAIN_EVALS_BG1C_UNIT',
  'GBRAIN_EVALS_BG1_WORLD_END', 'GBRAIN_EVALS_CUSTODY_LOG', 'GBRAIN_EVALS_DECISION_ID'] as const;
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
const dirs: string[] = [];
const tmp = (name: string) => { const d = mkdtempSync(join(tmpdir(), `bg1c-loader-${name}-`)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const END = '2026-11-15';
const code = (f: () => unknown) => { try { f(); } catch (e) { return e instanceof DecideError ? e.op.code : (e as Error).message; } return 'no error'; };
const message = (f: () => unknown) => { try { f(); } catch (e) { return e instanceof DecideError ? e.op.message : (e as Error).message; } return 'no error'; };
const custody = (log: string) => ({ log, decisionId: 'test', purpose: 'bg1c loader test' });
const SLOTS = [31, 32, 33];
const IDS = SLOTS.map(bg1WorldId);

let set = '';
beforeAll(() => {
  set = join(tmp('custody'), 'bg1-custody-c', 'set');
  const line = ['bg1', 'seed', 'v1'].join('-') + ':' + sha('bg1c loader test seed');
  const phrasing = { ...PUBLIC_PHRASING, custody: BG1_CUSTODY_MARKER };
  const json = (v: unknown) => JSON.stringify(v, null, 1) + '\n';
  for (const slot of SLOTS) {
    const plan = planWorld(bg1WorldId(slot), sealedWorldSeed(line, slot), { phrasing, custody: true });
    const dir = join(set, 'worlds', bg1WorldId(slot));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plan.json'), json(plan));
    writeFileSync(join(dir, 'questions.json'), json(buildQuestions(plan, phrasing)));
    writeFileSync(join(dir, 'world.json'), json(renderTemplateWorld(plan, 4000)));
  }
}, 120_000);

/** A filled manifest from a committed template (BG1-C's by default) over the test set's three worlds. */
const fill = (m: Partial<Bg1Manifest> = {}, template = BG1C_MANIFEST): string => {
  const path = join(tmp('manifest'), 'manifest.json');
  const base = JSON.parse(readFileSync(join(REPO, template), 'utf8')) as Bg1Manifest;
  writeFileSync(path, JSON.stringify({ ...base, status: 'filled', files: bg1ManifestFiles(set, IDS, BG1C_SET), filled_at: '2026-11-20', kept: IDS, ...m }));
  return path;
};
/** A filled manifest object whose kept worlds are pinned by placeholder hashes, for the kept-list and unit rules. */
const keptManifest = (kept: string[], n_final?: number, dataset = BG1C_DATASET): Bg1Manifest => ({ dataset, status: 'filled', layout: 'test', note: 'test', filled_at: '2026-11-20', kept,
  files: kept.flatMap(id => ['world.json', 'questions.json'].map(f => ({ path: `worlds/${id}/${f}`, sha256: 'a'.repeat(64) }))), ...(n_final === undefined ? {} : { n_final }) });

describe('the slots', () => {
  // Value: protects=BG1's set is its 30 kept slots and BG1-C's is 31 to 96, with no overlap, in the names, the split files and the manifests; fails_when=BG1 still claims slots 31 to 48, or BG1-C's list starts anywhere but 31; why_new=BG1-C preregistration harness item 1; seam=bg1-names.ts, the split files and the committed manifest; no_claim=custody
  test('BG1 keeps bg1-001 to bg1-030, BG1-C holds bg1-031 to bg1-096, and the split files and manifests say so', () => {
    expect(BG1_CONVERSATIONS).toEqual(Array.from({ length: 30 }, (_, i) => bg1WorldId(i + 1)));
    expect([BG1C_FIRST_SLOT, BG1C_LAST_SLOT, BG1C_N_FINAL, BG1C_CONVERSATIONS.length]).toEqual([31, 96, 40, 66]);
    expect(BG1C_CONVERSATIONS[0]).toBe('bg1-031');
    expect(BG1C_CONVERSATIONS.at(-1)).toBe('bg1-096');
    expect(BG1C_CONVERSATIONS.filter(id => BG1_CONVERSATIONS.includes(id))).toEqual([]);
    expect(loadSplit('bg1').sealed).toEqual([...BG1_CONVERSATIONS]);
    expect(loadSplit('bg1').note).toContain('2026-11-19: BG1 minted slots 1 to 30 and kept all 30');
    expect(loadSplit('bg1c')).toMatchObject({ dev: [], sealed: [...BG1C_CONVERSATIONS], dev_fraction: 0 });
    const { manifest } = readBg1Manifest(join(REPO, BG1C_MANIFEST), BG1C_SET);
    expect(manifest).toMatchObject({ dataset: BG1C_DATASET, status: 'unfilled', files: [], filled_at: null });
    expect(readBg1Manifest(join(REPO, BG1_MANIFEST)).manifest.dataset).toBe(BG1_SET.dataset);
    expect([BG1C_SET.campaign, BG1C_SET.env]).toEqual([BG1C_CAMPAIGN, { source: 'GBRAIN_EVALS_BG1C_SOURCE', manifest: 'GBRAIN_EVALS_BG1C_MANIFEST', unit: 'GBRAIN_EVALS_BG1C_UNIT' }]);
  });
});

describe('the bg1c loader', () => {
  test('loads a BG1-C set with a custody log, logging each world under bg1c first, and pins it against BG1-C\'s manifest', () => {
    const log = join(tmp('log'), 'access.jsonl');
    const manifest = fill();
    const c = loadBg1c(custody(log), { root: set, manifestPath: manifest, worldEnd: END, only: new Set(IDS) });
    expect(c.benchmark).toBe('bg1c');
    expect(c.conversations.map(x => x.id)).toEqual(IDS);
    expect(c.questions).toHaveLength(3 * 64);
    expect(c.source.name).toBe(`${BG1C_DATASET} (minted in custody, world end ${END})`);
    expect(c.source.files[0]).toEqual({ path: BG1C_MANIFEST, sha256: sha(readFileSync(manifest)) });
    const lines = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { purpose: string; decision_id: string });
    expect(lines.map(l => l.purpose)).toEqual(IDS.map(id => `bg1c ${id}: bg1c loader test`));
  });

  // Value: protects=the bg1c loader never opens one of BG1's worlds; fails_when=loadBg1c, its file lookup, its unit scope or its kept list accepts bg1-001 to bg1-030; why_new=BG1-C preregistration harness item 1 (refuses bg1-001 to bg1-030); seam=corpus.ts BG1C_SET; no_claim=BG1's own loader rules
  test('refuses BG1\'s worlds bg1-001 to bg1-030 in a load, a file lookup, the unit scope and the kept list', () => {
    const log = join(tmp('log'), 'access.jsonl');
    expect(message(() => loadBg1c(custody(log), { root: set, manifestPath: fill(), worldEnd: END, only: new Set(['bg1-031', 'bg1-030']) }))).toBe('bg1c has no world bg1-030');
    expect(() => bg1WorldFiles(set, 'bg1-001', 'bg1c')).toThrow('bg1c has no world bg1-001');
    expect(code(() => bg1UnitScope({ GBRAIN_EVALS_BG1C_UNIT: 'bg1-031,bg1-001' }, BG1C_SET))).toBe('CUSTODY_MISSING');
    expect(bg1UnitScope({ GBRAIN_EVALS_BG1C_UNIT: 'bg1-031,bg1-032', GBRAIN_EVALS_BG1_UNIT: 'bg1-001' }, BG1C_SET)).toEqual(['bg1-031', 'bg1-032']);
    expect(message(() => bg1Kept(keptManifest(['bg1-030', 'bg1-031']), BG1C_SET))).toBe('bg1c: kept bg1-030 is not one of the 66 mint slots');
    expect(() => readFileSync(log)).toThrow();
  });

  // Value: protects=the bg1c loader reads only BG1-C's manifest, and BG1's loader never reads BG1-C's; fails_when=either set's loader, custody check or kept list runs on the other set's manifest; why_new=BG1-C preregistration harness item 1 (reads only the BG1-C manifest); seam=corpus.ts readBg1Manifest; no_claim=forged manifests (a manifest relabelled by hand)
  test('refuses BG1\'s manifest, filled or not, and BG1\'s loader refuses BG1-C\'s', () => {
    const log = join(tmp('log'), 'access.jsonl');
    expect(code(() => loadBg1c(custody(log), { root: set, manifestPath: join(REPO, BG1_MANIFEST), worldEnd: END }))).toBe('DATASET_MISSING');
    expect(message(() => loadBg1c(custody(log), { root: set, manifestPath: fill({}, BG1_MANIFEST), worldEnd: END }))).toContain('is the manifest of "BG1 changing-facts set", not of the BG1-C set');
    expect(code(() => readBg1Manifest(join(REPO, BG1C_MANIFEST)))).toBe('DATASET_MISSING');
    expect(code(() => loadBg1(custody(log), { root: set, manifestPath: fill(), worldEnd: END, only: new Set(['bg1-001']) }))).toBe('DATASET_MISSING');
    expect(() => readFileSync(log)).toThrow();
  });

  test('BG1-C\'s kept list is at most 40 with n_final exactly 40, and its launch units are whole slices of it', () => {
    const forty = BG1C_CONVERSATIONS.slice(0, 40);
    expect(bg1Kept(keptManifest(forty, 40), BG1C_SET)).toEqual({ kept: forty, n_final: 40 });
    expect(message(() => bg1Kept(keptManifest(forty.slice(0, 30), 30), BG1C_SET))).toBe('bg1c: n_final 30 must be exactly 40, at least the kept list\'s 30');
    expect(code(() => bg1Kept(keptManifest(BG1C_CONVERSATIONS.slice(0, 41), 40), BG1C_SET))).toBe('DATASET_MISSING');
    expect(bg1UnitConversations(keptManifest(forty, 40), 4, 8, BG1C_SET)).toEqual(BG1C_CONVERSATIONS.slice(32, 40));
    expect(message(() => bg1UnitConversations(keptManifest(forty.slice(0, 12)), 1, 8, BG1C_SET))).toBe('bg1c: launch unit 1 needs kept worlds 9 to 16, and the kept list holds 12');
  });

  test('loadCorpus, filesFor and decide fetch read BG1-C\'s own variables and campaign, never BG1\'s', () => {
    process.env.GBRAIN_EVALS_BG1_SOURCE = set;
    expect(message(() => loadCorpus('bg1c'))).toBe('bg1c: GBRAIN_EVALS_BG1C_SOURCE is not set');
    expect(code(() => bg1Source({ GBRAIN_EVALS_BG1C_SOURCE: join(REPO, 'eval') }, BG1C_SET))).toBe('CUSTODY_MISSING');
    expect(code(() => filesFor('bg1c'))).toBe('CUSTODY_MISSING');
    process.env.GBRAIN_EVALS_BG1C_SOURCE = set;
    expect(message(() => loadCorpus('bg1c'))).toBe('bg1c questions open only on the custodian host');
    const log = join(tmp('log'), 'access.jsonl');
    process.env.GBRAIN_EVALS_CUSTODY_LOG = log;
    process.env.GBRAIN_EVALS_BG1C_MANIFEST = fill();
    process.env.GBRAIN_EVALS_BG1_WORLD_END = END;
    const c = loadCorpus('bg1c', undefined, new Set(['bg1-032']));
    expect(c.conversations.map(x => x.id)).toEqual(['bg1-032']);
    expect((JSON.parse(readFileSync(log, 'utf8').trim()) as { decision_id: string }).decision_id).toBe(BG1C_CAMPAIGN);
    process.env.GBRAIN_EVALS_BG1C_UNIT = 'bg1-031';
    expect(code(() => loadCorpus('bg1c', undefined, new Set(['bg1-032'])))).toBe('CUSTODY_MISSING');
    delete process.env.GBRAIN_EVALS_BG1C_UNIT;
    expect(verifyBg1Custody(() => {}, BG1C_SET)).toBe(6);
  });

  test('decide fetch for bg1c verifies BG1-C\'s pinned files and refuses a changed one', async () => {
    process.env.GBRAIN_EVALS_BG1C_SOURCE = set;
    process.env.GBRAIN_EVALS_BG1C_MANIFEST = fill({ files: bg1ManifestFiles(set, IDS, BG1C_SET).map((f, i) => (i === 0 ? { ...f, sha256: 'b'.repeat(64) } : f)) });
    expect(code(() => verifyBg1Custody(() => {}, BG1C_SET))).toBe('DATASET_HASH_MISMATCH');
    process.env.GBRAIN_EVALS_BG1C_MANIFEST = fill();
    expect(await fetchDataset('bg1c', { log: () => {} })).toEqual({ fetched: 0, verified: 6 });
  });
});

describe('BG1\'s loader refuses BG1-C\'s worlds', () => {
  // Value: protects=BG1's loader, unit scope and kept list never open a BG1-C world; fails_when=BG1_CONVERSATIONS still holds bg1-031 to bg1-048; why_new=BG1-C preregistration harness item 1 (BG1's loader refuses BG1-C worlds); seam=corpus.ts BG1_SET; no_claim=BG1's other loader rules (bg1-loader.test.ts)
  test('a load, a file lookup, the unit scope and the kept list refuse bg1-031 onward', () => {
    const log = join(tmp('log'), 'access.jsonl');
    expect(message(() => loadBg1(custody(log), { root: set, worldEnd: END, only: new Set(['bg1-031']) }))).toBe('bg1 has no world bg1-031');
    expect(message(() => loadBg1(custody(log), { root: set, worldEnd: END, only: new Set(['bg1-048']) }))).toBe('bg1 has no world bg1-048');
    expect(() => bg1WorldFiles(set, 'bg1-031')).toThrow('bg1 has no world bg1-031');
    expect(code(() => bg1UnitScope({ GBRAIN_EVALS_BG1_UNIT: 'bg1-030,bg1-031' }))).toBe('CUSTODY_MISSING');
    expect(message(() => bg1Kept(keptManifest(['bg1-030', 'bg1-031'], undefined, BG1_SET.dataset)))).toBe('bg1: kept bg1-031 is not one of the 30 mint slots');
    expect(() => readFileSync(log)).toThrow();
  });
});

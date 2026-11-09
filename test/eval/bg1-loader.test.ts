/**
 * The BG1 loaders (GST-2010): bg1-dev on the committed template fixtures, and bg1 on a sealed set planned from a test
 * seed and rendered from templates into a temporary custody root, in the layout mint.sh writes. Dates, the world-end clock, the manifest, the kept list,
 * launch units, the unit scope, the access log, the split files and the registry cases. Keyless and offline; no
 * sealed BG1 byte is used here.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BG1_CUSTODY_MARKER, BG1_WORLD_END_WEEKDAY, PUBLIC_PHRASING, buildQuestions, planWorld, renderTemplateWorld, sealedWorldSeed } from '../../eval/generators/changing-facts-gen.ts';
import { DecideError } from '../../eval/runner/decisions/errors.ts';
import { devConversations, loadSplit } from '../../eval/runner/decisions/splits.ts';
import { DATASET_PINS } from '../../eval/runner/q1/reuse-check.ts';
import { BG1_CONVERSATIONS, BG1_DEV_CONVERSATIONS, BG1_STRATA } from '../../eval/runner/bg1/types.ts';
import {
  BG1_MANIFEST, bg1Kept, bg1ManifestFiles, bg1Source, bg1UnitConversations, bg1UnitScope, bg1WorldEnd, fetchDataset, filesFor, loadBg1, loadBg1Dev, loadCorpus,
  readBg1Manifest, resolveBg1Dates, verifyBg1Custody, type Bg1Manifest,
} from '../../eval/runner/memory-qa/corpus.ts';

const REPO = resolve(import.meta.dir, '../..');
const FIXTURES = join(REPO, 'eval/data/changing-facts-v1/fixtures');
const ENV = ['GBRAIN_EVALS_BG1_SOURCE', 'GBRAIN_EVALS_BG1_MANIFEST', 'GBRAIN_EVALS_BG1_UNIT', 'GBRAIN_EVALS_BG1_WORLD_END', 'GBRAIN_EVALS_BG1_DEV_ROOT', 'GBRAIN_EVALS_CUSTODY_LOG', 'GBRAIN_EVALS_DECISION_ID'] as const;
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
const dirs: string[] = [];
const tmp = (name: string) => { const d = mkdtempSync(join(tmpdir(), `bg1-loader-${name}-`)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
/** The latest Sunday on or before today: a world end the clock rule accepts. */
const lastSunday = () => { const n = new Date(); return isoDay(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() - n.getUTCDay()))); };
const END = '2026-11-15', NOW = new Date('2026-11-16T12:00:00Z');
const code = (f: () => unknown) => { try { f(); } catch (e) { return e instanceof DecideError ? e.op.code : (e as Error).message; } return 'no error'; };

let custody = '', set = '';
beforeAll(() => {
  custody = tmp('custody');
  set = join(custody, 'bg1-custody-t', 'set');
  const line = ['bg1', 'seed', 'v1'].join('-') + ':' + sha('loader test seed');
  const phrasing = { ...PUBLIC_PHRASING, custody: BG1_CUSTODY_MARKER };
  const json = (v: unknown) => JSON.stringify(v, null, 1) + '\n';
  for (const slot of [1, 2, 3]) {
    const id = BG1_CONVERSATIONS[slot - 1];
    const plan = planWorld(id, sealedWorldSeed(line, slot), { phrasing, custody: true });
    const dir = join(set, 'worlds', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plan.json'), json(plan));
    writeFileSync(join(dir, 'questions.json'), json(buildQuestions(plan, phrasing)));
    writeFileSync(join(dir, 'world.json'), json(renderTemplateWorld(plan, 4000)));
  }
}, 120_000);

const fill = (m: Partial<Bg1Manifest>, root = set): string => {
  const path = join(tmp('manifest'), 'bg1-manifest.json');
  const base = JSON.parse(readFileSync(join(REPO, BG1_MANIFEST), 'utf8')) as Bg1Manifest;
  writeFileSync(path, JSON.stringify({ ...base, status: 'filled', files: bg1ManifestFiles(root, ['bg1-001', 'bg1-002', 'bg1-003']), filled_at: '2026-11-20', ...m }));
  return path;
};

describe('dates and the world-end clock', () => {
  test('the world end must be a Sunday, and the clock may pass it by at most 14 days', () => {
    expect(bg1WorldEnd({ worldEnd: END, now: NOW })).toBe(END);
    expect(bg1WorldEnd({ worldEnd: END, now: new Date('2026-11-29T23:00:00Z') })).toBe(END);
    expect(code(() => bg1WorldEnd({ worldEnd: END, now: new Date('2026-11-30T00:00:00Z') }))).toBe('SPEC_INVALID');
    expect(code(() => bg1WorldEnd({ worldEnd: '2026-11-14', now: NOW }))).toBe('SPEC_INVALID');
    expect(code(() => bg1WorldEnd({ worldEnd: '2026-02-30', now: NOW }))).toBe('SPEC_INVALID');
    expect(code(() => bg1WorldEnd({ env: {}, now: NOW }))).toBe('SPEC_MISSING');
    expect(bg1WorldEnd({ env: { GBRAIN_EVALS_BG1_WORLD_END: END }, now: NOW })).toBe(END);
    expect(new Date(`${END}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })).toBe(BG1_WORLD_END_WEEKDAY);
  });

  test('tokens resolve to dates and weekdays relative to the world end; a damaged token refuses', () => {
    expect(resolveBg1Dates('On [[D:0]], a [[W:0]]; [[D:-1]] was a [[W:-1]], and [[D:-365]].', END)).toBe('On November 15, 2026, a Sunday; November 14, 2026 was a Saturday, and November 15, 2025.');
    expect(() => resolveBg1Dates('On [[D:-3]', END)).toThrow('damaged');
    expect(() => resolveBg1Dates('On [[X:-3]]', END)).toThrow('damaged');
  });
});

describe('bg1-dev', () => {
  test('loads the three fixture worlds with resolved dates, strata as categories and evidence sessions as gold', () => {
    const c = loadBg1Dev({ root: FIXTURES, worldEnd: END, now: NOW });
    expect(c.benchmark).toBe('bg1-dev');
    expect(c.conversations.map(x => x.id)).toEqual([...BG1_DEV_CONVERSATIONS]);
    expect(c.questions).toHaveLength(3 * 64);
    for (const q of c.questions) {
      expect(BG1_STRATA as readonly string[]).toContain(q.category);
      expect(q.category).toBe(q.bg1!.stratum);
      expect(q.question_date).toBe('2026-11-16');
      expect(q.abstention).toBe(false);
      expect(q.gold.length).toBeGreaterThan(0);
      const sessions = new Set(c.conversations.find(x => x.id === q.conversation)!.sessions.map(s => s.id));
      for (const g of q.gold) expect(sessions.has(g)).toBe(true);
      expect(q.question + q.answer + (q.bg1!.deciding_line ?? '')).not.toContain('[[');
    }
    for (const conv of c.conversations) {
      const dates = conv.sessions.map(s => s.date!);
      expect(dates.every(d => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(d))).toBe(true);
      expect([...dates].sort()).toEqual(dates);
      expect(dates.at(-1)! <= '2026-11-15T23:59').toBe(true);
      expect(dates[0] < '2025-06-01').toBe(true);
      expect(conv.sessions.every(s => s.turns.every(t => !t.content.includes('[[')))).toBe(true);
    }
    expect(c.source.files).toHaveLength(6);
    expect(c.source.files[0].path).toBe('eval/data/changing-facts-v1/fixtures/worlds/bg1-dev-01/world.json');
  });

  test('a later world end shifts every date by whole weeks and keeps the weekdays', () => {
    const a = loadBg1Dev({ root: FIXTURES, worldEnd: END, now: NOW, only: new Set(['bg1-dev-01']) });
    const b = loadBg1Dev({ root: FIXTURES, worldEnd: '2026-11-22', now: NOW, only: new Set(['bg1-dev-01']) });
    const day = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00Z`);
    a.conversations[0].sessions.forEach((s, i) => {
      const t = b.conversations[0].sessions[i];
      expect((day(t.date!).getTime() - day(s.date!).getTime()) / 86_400_000).toBe(7);
      expect(day(t.date!).getUTCDay()).toBe(day(s.date!).getUTCDay());
    });
  });

  test('the committed dev root has no rendered worlds until stage 1, so bg1-dev refuses there and names the fixtures', () => {
    expect(existsSync(join(REPO, 'eval/data/changing-facts-v1/dev/worlds/bg1-dev-01/plan.json'))).toBe(true);
    expect(code(() => loadBg1Dev({ worldEnd: END, now: NOW }))).toBe('DATASET_MISSING');
    expect(code(() => loadBg1Dev({ root: FIXTURES, worldEnd: END, now: NOW, only: new Set(['bg1-001']) }))).toContain('has no world');
  });

  test('loadCorpus reads GBRAIN_EVALS_BG1_DEV_ROOT and GBRAIN_EVALS_BG1_WORLD_END, and refuses without a world end', () => {
    process.env.GBRAIN_EVALS_BG1_DEV_ROOT = FIXTURES;
    delete process.env.GBRAIN_EVALS_BG1_WORLD_END;
    expect(code(() => loadCorpus('bg1-dev'))).toBe('SPEC_MISSING');
    process.env.GBRAIN_EVALS_BG1_WORLD_END = lastSunday();
    const c = loadCorpus('bg1-dev', undefined, devConversations('bg1-dev')!);
    expect(c.conversations).toHaveLength(3);
    expect(filesFor('bg1-dev')).toEqual([]);
  });
});

describe('bg1 (sealed)', () => {
  test('the custody root must be set and outside the repository', () => {
    expect(code(() => bg1Source({}))).toBe('CUSTODY_MISSING');
    expect(code(() => bg1Source({ GBRAIN_EVALS_BG1_SOURCE: join(REPO, 'eval') }))).toBe('CUSTODY_MISSING');
    expect(bg1Source({ GBRAIN_EVALS_BG1_SOURCE: set })).toBe(set);
    expect(code(() => filesFor('bg1'))).toBe('CUSTODY_MISSING');
  });

  test('loads a minted set only with a custody log, logging each world before it is read; unfilled, it warns that nothing is pinned', () => {
    const log = join(tmp('log'), 'access.jsonl');
    expect(code(() => loadBg1({ log: '', decisionId: 'd', purpose: 'p' }, { root: set, worldEnd: END, now: NOW }))).toBe('CUSTODY_MISSING');
    const c = loadBg1({ log, decisionId: 'q1-scoreboard-bg1-changing-facts', purpose: 'loader test' }, { root: set, worldEnd: END, now: NOW, only: new Set(['bg1-001', 'bg1-002']) });
    expect(c.conversations.map(x => x.id)).toEqual(['bg1-001', 'bg1-002']);
    expect(c.questions).toHaveLength(128);
    expect(c.source.revision).toBe('unfilled');
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('bg1 bg1-001: loader test');
    expect(code(() => loadBg1({ log, decisionId: 'd', purpose: 'p' }, { root: set, worldEnd: END, now: NOW, only: new Set(['bg1-049']) }))).toContain('has no world');
  });

  test('with a filled manifest, every read file must be pinned and match', () => {
    const log = join(tmp('log'), 'access.jsonl');
    const opts = { root: set, worldEnd: END, now: NOW, only: new Set(['bg1-001']) };
    const good = fill({ kept: ['bg1-001', 'bg1-002', 'bg1-003'] });
    const c = loadBg1({ log, decisionId: 'd', purpose: 'p' }, { ...opts, manifestPath: good });
    expect(c.source.revision).toBe(sha(readFileSync(good)).slice(0, 7));
    const bad = fill({ files: bg1ManifestFiles(set, ['bg1-001']).map((f, i) => (i === 0 ? { ...f, sha256: '0'.repeat(64) } : f)) });
    expect(code(() => loadBg1({ log, decisionId: 'd', purpose: 'p' }, { ...opts, manifestPath: bad }))).toBe('DATASET_HASH_MISMATCH');
    const short = fill({ files: bg1ManifestFiles(set, ['bg1-001']).slice(1) });
    expect(code(() => loadBg1({ log, decisionId: 'd', purpose: 'p' }, { ...opts, manifestPath: short }))).toBe('DATASET_HASH_MISMATCH');
    const extra = fill({ files: [...bg1ManifestFiles(set, ['bg1-001']), { path: 'worlds/bg1-001/extra.json', sha256: '1'.repeat(64) }] });
    expect(code(() => loadBg1({ log, decisionId: 'd', purpose: 'p' }, { ...opts, manifestPath: extra }))).toBe('DATASET_MISSING');
  });

  test('the kept list: slot order, pinned, at most n_final, and n_final from 30 to 40', () => {
    const m = (x: Partial<Bg1Manifest>) => readBg1Manifest(fill(x)).manifest;
    expect(bg1Kept(m({ kept: ['bg1-001', 'bg1-003'] }))).toEqual({ kept: ['bg1-001', 'bg1-003'], n_final: null });
    expect(code(() => bg1Kept(readBg1Manifest(join(REPO, BG1_MANIFEST)).manifest))).toBe('DATASET_MISSING');
    expect(code(() => bg1Kept(m({ kept: ['bg1-003', 'bg1-001'] })))).toBe('DATASET_MISSING');
    expect(code(() => bg1Kept(m({ kept: ['bg1-004'] })))).toBe('DATASET_MISSING');
    expect(code(() => bg1Kept(m({ kept: ['bg1-049'] })))).toBe('DATASET_MISSING');
    expect(code(() => bg1Kept(m({ kept: ['bg1-001'], n_final: 20 })))).toBe('DATASET_MISSING');
    expect(bg1Kept(m({ kept: ['bg1-001'], n_final: 30 })).n_final).toBe(30);
  });

  test('launch units run whole kept slices, the last one partial only once n_final completes the list', () => {
    const open = readBg1Manifest(fill({ kept: ['bg1-001', 'bg1-002', 'bg1-003'] })).manifest;
    expect(bg1UnitConversations(open, 0, 2)).toEqual(['bg1-001', 'bg1-002']);
    expect(code(() => bg1UnitConversations(open, 1, 2))).toBe('DATASET_MISSING');
    expect(code(() => bg1UnitConversations(open, 2, 2))).toBe('DATASET_MISSING');
    const done = { ...open, n_final: 3 } as Bg1Manifest;
    expect(code(() => bg1Kept(done))).toBe('DATASET_MISSING');
    const full = { ...open, kept: ['bg1-001', 'bg1-002', 'bg1-003'], n_final: 30 } as Bg1Manifest;
    expect(code(() => bg1UnitConversations(full, 1, 2))).toBe('DATASET_MISSING');
    expect(() => bg1UnitConversations(open, -1, 2)).toThrow('whole unit');
    const thirty = BG1_CONVERSATIONS.slice(0, 30);
    const complete = { ...open, kept: thirty, n_final: 30, files: thirty.flatMap(id => ['world.json', 'questions.json'].map(f => ({ path: `worlds/${id}/${f}`, sha256: '0'.repeat(64) }))) } as Bg1Manifest;
    expect(bg1UnitConversations(complete, 7, 4)).toEqual(['bg1-029', 'bg1-030']);
    expect(code(() => bg1UnitConversations(complete, 8, 4))).toBe('DATASET_MISSING');
  });

  test('the unit scope: distinct BG1 ids only, the load limited to them, and verify checks exactly their files', () => {
    expect(bg1UnitScope({})).toBeNull();
    expect(bg1UnitScope({ GBRAIN_EVALS_BG1_UNIT: 'bg1-001, bg1-002' })).toEqual(['bg1-001', 'bg1-002']);
    for (const bad of ['', 'bg1-001,bg1-001', 'rs1-001', 'bg1-dev-01']) expect(code(() => bg1UnitScope({ GBRAIN_EVALS_BG1_UNIT: bad }))).toBe('CUSTODY_MISSING');
    const log = join(tmp('log'), 'access.jsonl');
    process.env.GBRAIN_EVALS_BG1_UNIT = 'bg1-002';
    expect(code(() => loadBg1({ log, decisionId: 'd', purpose: 'p' }, { root: set, worldEnd: END, now: NOW }))).toBe('CUSTODY_MISSING');
    expect(loadBg1({ log, decisionId: 'd', purpose: 'p' }, { root: set, worldEnd: END, now: NOW, only: new Set(['bg1-002']) }).conversations).toHaveLength(1);
    process.env.GBRAIN_EVALS_BG1_SOURCE = set;
    process.env.GBRAIN_EVALS_BG1_MANIFEST = fill({ kept: ['bg1-001', 'bg1-002', 'bg1-003'] });
    expect(code(() => verifyBg1Custody(() => {}))).toBe('CUSTODY_MISSING');
    const vm = join(tmp('vm'), 'set');
    mkdirSync(join(vm, 'worlds', 'bg1-002'), { recursive: true });
    for (const f of ['world.json', 'questions.json']) writeFileSync(join(vm, 'worlds', 'bg1-002', f), readFileSync(join(set, 'worlds', 'bg1-002', f)));
    process.env.GBRAIN_EVALS_BG1_SOURCE = vm;
    const logged: string[] = [];
    expect(verifyBg1Custody(s => logged.push(s))).toBe(2);
    expect(logged[0]).toContain('launch unit bg1-002');
    process.env.GBRAIN_EVALS_BG1_UNIT = 'bg1-004';
    expect(code(() => verifyBg1Custody(() => {}))).toBe('DATASET_MISSING');
  });

  test('decide fetch verifies the pinned files on the custody host and refuses an unfilled manifest', async () => {
    process.env.GBRAIN_EVALS_BG1_SOURCE = set;
    process.env.GBRAIN_EVALS_BG1_MANIFEST = join(REPO, BG1_MANIFEST);
    await expect(fetchDataset('bg1', { log: () => {} })).rejects.toThrow('no hashes yet');
    process.env.GBRAIN_EVALS_BG1_MANIFEST = fill({ kept: ['bg1-001'] });
    expect(await fetchDataset('bg1', { log: () => {} })).toEqual({ fetched: 0, verified: 6 });
    writeFileSync(join(set, 'worlds', 'bg1-003', 'questions.json'), '[]\n');
    await expect(fetchDataset('bg1', { log: () => {} })).rejects.toThrow('expected');
  });

  test('loadCorpus opens bg1 only with a custody log', () => {
    process.env.GBRAIN_EVALS_BG1_SOURCE = set;
    process.env.GBRAIN_EVALS_BG1_WORLD_END = lastSunday();
    delete process.env.GBRAIN_EVALS_CUSTODY_LOG;
    expect(code(() => loadCorpus('bg1', undefined, new Set(['bg1-001'])))).toBe('CUSTODY_MISSING');
    process.env.GBRAIN_EVALS_CUSTODY_LOG = join(tmp('log'), 'access.jsonl');
    expect(loadCorpus('bg1', undefined, new Set(['bg1-001'])).conversations).toHaveLength(1);
  });
});

describe('the committed manifest and splits', () => {
  test('the manifest is unfilled and pins nothing, and only bg1 cells compare it on reuse; bg1 is all sealed and bg1-dev all dev', () => {
    expect(DATASET_PINS[BG1_MANIFEST]).toEqual(['bg1']);
    const { manifest } = readBg1Manifest(join(REPO, BG1_MANIFEST));
    expect(manifest.status).toBe('unfilled');
    expect(manifest.files).toEqual([]);
    expect(manifest.filled_at).toBeNull();
    const sealed = loadSplit('bg1');
    expect(sealed.dev).toEqual([]);
    expect(sealed.sealed).toEqual([...BG1_CONVERSATIONS]);
    const dev = loadSplit('bg1-dev');
    expect(dev.dev).toEqual([...BG1_DEV_CONVERSATIONS]);
    expect(dev.sealed).toEqual([]);
  });
});

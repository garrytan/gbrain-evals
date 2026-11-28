import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterDateFor, attributeRanks, dateFor, filters, pageAttributes, SHARES } from './attributes.ts';
import { attemptKind, boostedSlug, firstSentence, queryPlan } from './harness.ts';
import { ARM_PATCHES, applyPatch } from './patch-arm.ts';
import { MACHINE_LOCAL_PATH } from '../receipt.ts';
import { applyReruns, decide, publishedManifest, recountDir, truthCheck, type CellResult } from './recount.ts';
import { latencyState, outcome, recallAt, recallState, type CellVerdict } from './stats.ts';
import { flipsUnderRule } from './tables.ts';
import { specSha } from '../gbrain-pin.ts';
import { cellStats, pooledRatio } from './stats.ts';

const GBRAIN = resolve(import.meta.dir, '../../../node_modules/gbrain');
const MEASURED_GBRAIN = '3a360389f152e62ccb627ab96eccfad8a9204e75';
const atMeasuredGbrain = specSha(JSON.parse(readFileSync(resolve(import.meta.dir, '../../../package.json'), 'utf8')).dependencies.gbrain) === MEASURED_GBRAIN;

describe('arm patch', () => {
  test.skipIf(!atMeasuredGbrain)('each shipped predicate occurs exactly once in the measured gbrain', () => {
    for (const patch of ARM_PATCHES) {
      const text = readFileSync(join(GBRAIN, patch.file), 'utf8');
      const after = applyPatch(text, patch);
      expect(after.includes(patch.to)).toBe(true);
      expect(after.includes(patch.from)).toBe(false);
    }
  });
  test('a missing or repeated predicate is refused', () => {
    const p = { file: 'x.ts', from: 'aa', to: 'bb' };
    expect(() => applyPatch('cc', p)).toThrow('not found');
    expect(() => applyPatch('aa aa', p)).toThrow('more than once');
  });
});

describe('attempt kinds', () => {
  test.skipIf(!atMeasuredGbrain)('classifies the four statements the measured gbrain builds', async () => {
    const vs = await import(join(GBRAIN, 'src/core/search/vector-statement.ts'));
    const column = { name: 'embedding', type: 'vector', dimensions: 4, embeddingModel: 'bench:latent' };
    const plain = vs.buildVectorSearchStatement({ dialect: 'postgres', embedding: new Float32Array(4), limit: 20, offset: 0, opts: { embeddingColumn: column } });
    expect(attemptKind(plain.sql)).toBe('joined');
    expect(attemptKind(plain.exactSql)).toBe('exact');
    expect(attemptKind(plain.indexWalkSql)).toBe('walk');
    const scoped = vs.buildVectorSearchStatement({ dialect: 'postgres', embedding: new Float32Array(4), limit: 20, offset: 0, opts: { embeddingColumn: column, sourceIds: ['a'] }, scope: { share: 0.01, chunks: 50 } });
    expect(attemptKind(scoped.scopeScanSql)).toBe('scope');
    const typed = vs.buildVectorSearchStatement({ dialect: 'postgres', embedding: new Float32Array(4), limit: 20, offset: 0, opts: { embeddingColumn: column, type: 'note' } });
    expect(typed.indexWalkSql).toBeUndefined();
    expect(attemptKind(typed.sql)).toBe('joined');
    expect(attemptKind('SELECT 1')).toBe('other');
  });
});

describe('oracle factor', () => {
  test('corpus slugs take no boost and no exclude; boosted prefixes are caught', async () => {
    const sb = await import(join(GBRAIN, 'src/core/search/source-boost.ts'));
    const boosts = sb.resolveBoostMap(undefined, null), excludes = sb.resolveHardExcludes(undefined, undefined, undefined);
    expect(boostedSlug('bench/latent/p12', boosts, excludes)).toBe(false);
    expect(boostedSlug('bench/wiki/12345', boosts, excludes)).toBe(false);
    expect(boostedSlug('originals/essay', boosts, excludes)).toBe(true);
    expect(boostedSlug('test/page', boosts, excludes)).toBe(true);
  });
});

describe('queries', () => {
  test('first sentence rule', () => {
    expect(firstSentence('A short one. Then the rest of a long chunk that goes on.')).toBe('A short one. Then the rest of a long chunk that goes on.');
    expect(firstSentence('This first sentence is long enough to stand. Second.')).toBe('This first sentence is long enough to stand.');
    expect(firstSentence('x'.repeat(400)).length).toBe(300);
  });
  test('query set rule', () => {
    expect(queryPlan('independent', 'type', 5, 5)).toBe('independent');
    expect(queryPlan('clustered', 'sanity', 5, 5)).toBe('independent');
    expect(queryPlan('clustered', 'type', 0, 5)).toBe('independent');
    expect(queryPlan('clustered', 'type', 5, 0)).toBe('independent');
    expect(queryPlan('clustered', 'type', 5, 5)).toBe('stratified');
  });
});

describe('attributes', () => {
  const n = 20_000;
  const ids = Int32Array.from({ length: n }, (_, i) => i + 1);
  const buckets = Int32Array.from({ length: n }, (_, i) => (i * 7919) % 256);
  test('clustered ranks give each filter its exact share', () => {
    const ranks = { type: attributeRanks(ids, buckets, 9818, 'type'), tag: attributeRanks(ids, buckets, 9818, 'tag'), date: attributeRanks(ids, buckets, 9818, 'date'), source: attributeRanks(ids, buckets, 9818, 'source') };
    const pages = Array.from({ length: n }, (_, p) => pageAttributes({ type: ranks.type[p]!, tag: ranks.tag[p]!, date: ranks.date[p]!, source: ranks.source[p]! }, 0));
    for (const f of filters().filter(x => x.kind === 'type' || x.kind === 'where' || x.kind === 'date')) {
      const share = pages.filter(p => f.matches(p)).length / n;
      expect(Math.abs(share - f.share)).toBeLessThan(1.5 / n + 1e-9);
    }
  });
  test('independent ranks give each filter its share within sampling error', () => {
    const r = attributeRanks(ids, null, 9818, 'type');
    for (const s of SHARES) {
      const f = filters().find(x => x.kind === 'type' && x.share === s)!;
      const got = Array.from(r).filter(u => f.matches(pageAttributes({ type: u, tag: 0.99, date: 0.5, source: 0.9 }, 0))).length / n;
      expect(Math.abs(got - s)).toBeLessThan(4 * Math.sqrt(s * (1 - s) / n) + 1 / n);
    }
  });
  test('afterDate selects the latest share', () => {
    for (const s of SHARES) {
      let hit = 0;
      for (let i = 0; i < 10_000; i++) if (dateFor((i + 0.5) / 10_000) > afterDateFor(s)) hit++;
      expect(Math.abs(hit / 10_000 - s)).toBeLessThan(2e-4);
    }
  });
  test('ranks differ between attributes', () => {
    expect(Array.from(attributeRanks(ids, buckets, 9818, 'type')).slice(0, 50)).not.toEqual(Array.from(attributeRanks(ids, buckets, 9818, 'tag')).slice(0, 50));
  });
});

describe('statistics', () => {
  test('recall at k', () => {
    expect(recallAt([1, 2, 3], [1, 2, 4], 3)).toBeCloseTo(2 / 3);
    expect(recallAt([1], [1], 20)).toBe(1);
    expect(recallAt([], [], 20)).toBeNull();
  });
  test('recall states', () => {
    expect(recallState(null)).toBe('safe');
    expect(recallState({ est: 0, lo: -0.005, hi: 0.005 })).toBe('safe');
    expect(recallState({ est: -0.03, lo: -0.05, hi: -0.01 })).toBe('loss');
    expect(recallState({ est: -0.005, lo: -0.02, hi: 0.01 })).toBe('unresolved');
  });
  test('latency states', () => {
    const s = (r50: [number, number], r95: [number, number], c50 = 10, t50 = 10, c95 = 20, t95 = 20) => ({ p50: { c: c50, t: t50, ratio: { est: 1, lo: r50[0], hi: r50[1] } }, p95: { c: c95, t: t95, ratio: { est: 1, lo: r95[0], hi: r95[1] } } });
    expect(latencyState(s([0.5, 0.8], [0.6, 0.95]))).toBe('improves');
    expect(latencyState(s([0.5, 0.8], [0.6, 1.05]))).toBe('neutral');
    expect(latencyState(s([1.2, 1.4], [0.9, 1.1], 10, 16))).toBe('regresses');
    expect(latencyState(s([1.2, 1.4], [0.9, 1.1], 10, 12))).toBe('neutral');
  });
  test('outcomes', () => {
    const v = (o: Partial<CellVerdict>): CellVerdict => ({ realistic: true, affected: true, warm: true, recall: 'safe', latency: 'improves', size: 'latent-15000', reached: true, ...o });
    const good = { p50: { est: 0.5, lo: 0.4, hi: 0.6 }, p95: { est: 0.5, lo: 0.4, hi: 0.6 } };
    const nan = { p50: { est: NaN, lo: NaN, hi: NaN }, p95: { est: NaN, lo: NaN, hi: NaN } };
    expect(outcome([v({})], good).outcome).toBe('flip');
    expect(outcome([v({}), v({ recall: 'loss' })], good).outcome).toBe('limited-flip');
    expect(outcome([v({}), v({ recall: 'unresolved' })], good).outcome).toBe('limited-flip');
    expect(outcome([v({})], nan).outcome).toBe('close');
    expect(outcome([v({ latency: 'neutral' })], good).outcome).toBe('close');
  });
});

describe('recount', () => {
  function fixture(perQueryT: (q: number) => { ms: number; pages: number[] }, label = 'fx'): string {
    const dir = mkdtempSync(join(tmpdir(), 'fv-recount-'));
    const cell = label + '|latent|15000|independent|trusted|type-5|k20|warm|qs9819';
    const truth = Array.from({ length: 20 }, (_, i) => i + 1);
    const w = (f: string, rows: unknown[]) => writeFileSync(join(dir, f), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    w('cells.jsonl', [{ cell, label, engine: 'postgres', corpus: 'latent', chunks: 15000, pages: 2000, mode: 'independent', caller: 'trusted', filter: 'type-5', kind: 'type', affected: true, share_measured: 0.05, eligible_pages: 100, limit: 20, cache: 'warm', queries: 40, query_set: 'independent' }]);
    w('cells-done.jsonl', [{ cell }]);
    w('exact.jsonl', Array.from({ length: 40 }, (_, q) => ({ cell, q, pages: truth, inside: null })));
    const s: unknown[] = [];
    for (let q = 0; q < 40; q++) for (let rep = 0; rep < 3; rep++) {
      s.push({ cell, arm: 'C', q, rep, ms: 100 + ((q * 7 + rep) % 11), pages: truth, attempts: ['joined'], joined: true, incomplete: false });
      s.push({ cell, arm: 'T', q, rep, ...perQueryT(q), attempts: ['joined'], joined: true, incomplete: false });
    }
    w('searches.jsonl', s);
    w('plans.jsonl', []);
    w('manifest.json', []);
    return dir;
  }
  test('a faster T with equal pages improves and is safe; a pooled test decides flip', () => {
    const dir = fixture(q => ({ ms: 20 + (q % 5), pages: Array.from({ length: 20 }, (_, i) => i + 1) }));
    const cells = recountDir(dir, 400);
    expect(cells.length).toBe(1);
    expect(cells[0]!.final_recall).toBe('safe');
    expect(cells[0]!.final_latency).toBe('improves');
    expect(cells[0]!.reached).toBe(1);
    expect(decide([dir], cells, 400).outcome).toBe('flip');
  });
  test('a recall loss stands only when its re-run agrees', () => {
    const lossy = (q: number) => ({ ms: 20, pages: q % 2 ? [1, 2, 3] : Array.from({ length: 20 }, (_, i) => i + 1) });
    const cells = recountDir(fixture(lossy), 400);
    expect(cells[0]!.recall_state).toBe('loss');
    applyReruns(cells, recountDir(fixture(() => ({ ms: 20, pages: Array.from({ length: 20 }, (_, i) => i + 1) })), 400));
    expect(cells[0]!.final_recall).toBe('safe');
    const again = recountDir(fixture(lossy), 400);
    applyReruns(again, recountDir(fixture(lossy), 400));
    expect(again[0]!.final_recall).toBe('loss');
  });
});

describe('truth check', () => {
  test('a disagreement or a stop makes the check unclean; agreement on every checked query is clean', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fv-truth-'));
    const cells = [{ cell: 'a' }, { cell: 'b' }] as CellResult[];
    writeFileSync(join(dir, 'oracle-check.jsonl'), [{ cell: 'a', ok: true }, { cell: 'a', ok: true }, { cell: 'b', ok: true }].map(r => JSON.stringify(r)).join('\n') + '\n');
    expect(truthCheck([dir], cells)).toMatchObject({ cells_checked: 2, clean: true, disagreements: [], stops: [] });
    writeFileSync(join(dir, 'oracle-check.jsonl'), [{ cell: 'a', ok: true }, { cell: 'b', ok: false }].map(r => JSON.stringify(r)).join('\n') + '\n');
    expect(truthCheck([dir], cells)).toMatchObject({ clean: false, disagreements: [{ cell: 'b', ok: 0, n: 1 }] });
    writeFileSync(join(dir, 'oracle-check.jsonl'), JSON.stringify({ cell: 'a', ok: true }) + '\n');
    writeFileSync(join(dir, 'truth-stops.jsonl'), JSON.stringify({ cell: 'c' }) + '\n');
    expect(truthCheck([dir], cells)).toMatchObject({ clean: false, stops: ['c'], unchecked: ['b'] });
  });
});

describe('the stage 1b rule', () => {
  test('flips date filters, alone or with a type filter, at 375,000 chunks or more, and nothing else', () => {
    const cell = (kind: string, chunks: number) => ({ kind, chunks });
    expect(flipsUnderRule(cell('date', 375_000))).toBe(true);
    expect(flipsUnderRule(cell('date', 1_500_000))).toBe(true);
    expect(flipsUnderRule(cell('combo', 375_000))).toBe(true);
    expect(flipsUnderRule(cell('date', 75_000))).toBe(false);
    expect(flipsUnderRule(cell('type', 375_000))).toBe(false);
    expect(flipsUnderRule(cell('where', 375_000))).toBe(false);
    expect(flipsUnderRule(cell('scope', 375_000))).toBe(false);
  });
});

describe('latency ratio intervals', () => {
  test('T at half of C on constant latencies gives 0.5 with a zero-width interval', () => {
    const rows = Array.from({ length: 10 }, () => ({ c: [10, 10, 10], t: [5, 5, 5], recallC: 1, recallT: 1 }));
    const s = cellStats(rows, 1, 200);
    expect(s.p50.ratio).toEqual({ est: 0.5, lo: 0.5, hi: 0.5 });
    expect(s.p95.ratio).toEqual({ est: 0.5, lo: 0.5, hi: 0.5 });
    expect(s.recall!.diff.est).toBe(0);
    expect(pooledRatio([rows, rows], 0.5, 1, 200)).toEqual({ est: 0.5, lo: 0.5, hi: 0.5 });
  });
  test('a cell with one query has finite bounds', () => {
    const s = cellStats([{ c: [10, 12, 11], t: [4, 6, 5], recallC: 0.9, recallT: 1 }], 1, 200);
    for (const v of [s.p50.ratio.lo, s.p50.ratio.hi, s.p95.ratio.lo, s.p95.ratio.hi]) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('published manifests', () => {
  test('the run VM home in a PGLite data directory is written as ~/', () => {
    const manifest = publishedManifest({ label: 'pglite', db: '/home/ubi/pgl/data-15000', chunks: 15000 });
    expect(manifest).toEqual({ label: 'pglite', db: '~/pgl/data-15000', chunks: 15000 });
    expect(MACHINE_LOCAL_PATH.test(JSON.stringify(manifest))).toBe(false);
    expect(MACHINE_LOCAL_PATH.test(JSON.stringify({ db: '/home/ubi/pgl/data-15000' }))).toBe(true);
  });
});

describe('embed-wiki', () => {
  test('a failed batch waits for its siblings, so every request settles before the guard comes off', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fv-embed-'));
    writeFileSync(join(dir, 'pages.tsv'), 'a\tx\t128\nb\tx\t128\n');
    writeFileSync(join(dir, 'chunks.txt'), Array.from({ length: 256 }, (_, i) => 'chunk ' + i + '\n').join(''));
    writeFileSync(join(dir, 'fake-fetch.ts'), [
      "import { appendFileSync, existsSync } from 'node:fs';",
      "const dir = process.env.FAKE_DIR!;",
      "globalThis.fetch = (async (_url: string, init: RequestInit) => {",
      "  const first = (JSON.parse(String(init.body)) as { input: string[] }).input[0];",
      "  if (first === 'chunk 0') return new Response('bad request', { status: 400 });",
      "  await Bun.sleep(300);",
      "  appendFileSync(dir + '/responses.log', first + (existsSync(dir + '/embed-receipt.json') ? ' after' : ' before') + ' the receipt\\n');",
      "  return new Response('slow down', { status: 429 });",
      "}) as typeof fetch;",
    ].join('\n'));
    const run = Bun.spawnSync([process.execPath, '--preload', join(dir, 'fake-fetch.ts'), resolve(import.meta.dir, 'embed-wiki.ts'),
      '--corpus-dir', dir, '--chunks', '256', '--concurrency', '2', '--budget-usd', '1', '--program-cap-usd', '1', '--budget-ledger', join(dir, 'ledger.sqlite')], {
      env: { PATH: process.env.PATH, HOME: dir, FAKE_DIR: dir, VOYAGE_API_KEY: 'keyless-test' },
    });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain('voyage 400');
    expect(existsSync(join(dir, 'responses.log')) ? readFileSync(join(dir, 'responses.log'), 'utf8') : '').toBe('chunk 128 before the receipt\n');
    expect(JSON.parse(readFileSync(join(dir, 'embed-receipt.json'), 'utf8')).ledger.requests).toBe(2);
  });
});

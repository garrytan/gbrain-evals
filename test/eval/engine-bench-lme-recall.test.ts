import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  armAgreement, comparePair, countEmbedPlan, EmbedCacheMiss, fillCache, hashVector, LME_RECALL_TOP_K, main, refuseNetwork, runLmeRecall,
  stubTransport, type QuestionRow,
} from '../../eval/runner/engine-bench/lme-recall.ts';
import { resolveGbrainUnderTest, type GbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { BudgetRun, closeLedgers } from '../../eval/runner/budget-ledger.ts';
import { EmbeddingCache } from '../../eval/runner/longmemeval-cache.ts';

const work = mkdtempSync(join(tmpdir(), 'lme-recall-test-'));
const pinned = resolveGbrainUnderTest(null);

const FILLER = [
  'We talked about sourdough starters and how long the dough should rest before baking.',
  'The train from Lisbon to Porto takes about three hours and the coastal views are lovely.',
  'My cousin is learning the cello and practises scales every evening after dinner.',
  'The garden needs more compost this spring; the tomatoes were small last year.',
  'I am reading a history of the printing press and the spread of pamphlets.',
  'Our team switched the weekly standup to Tuesday mornings at nine.',
];

/** A tiny LongMemEval-shaped dataset: each question has one evidence session among filler, plus one abstention question. */
function writeDataset(): string {
  const facts = [
    { id: 'q1', type: 'single-session-user', question: 'What colour did I paint my bicycle?', fact: 'I finally painted my bicycle turquoise last weekend.' },
    { id: 'q2', type: 'single-session-user', question: 'Which marathon did I sign up for?', fact: 'I signed up for the Rotterdam marathon in April.' },
    { id: 'q3_abs', type: 'single-session-user', question: 'What is the name of my pet iguana?', fact: null },
  ];
  const questions = facts.map(f => {
    const sessions = FILLER.map((text, i) => [{ role: 'user', content: text }, { role: 'assistant', content: 'Noted, thanks for sharing (' + i + ').' }]);
    const ids = FILLER.map((_, i) => 'sharegpt_' + f.id + '_' + i);
    if (f.fact) {
      sessions.splice(3, 0, [{ role: 'user', content: f.fact }, { role: 'assistant', content: 'That sounds great.' }]);
      ids.splice(3, 0, 'answer_' + f.id + '_1');
    }
    return {
      question_id: f.id, question_type: f.type, question: f.question, answer: f.fact ? 'x' : 'unknown',
      question_date: '2023/05/30 (Tue) 23:40', haystack_dates: ids.map(() => '2023/05/20 (Sat) 10:00'),
      haystack_session_ids: ids, haystack_sessions: sessions, answer_session_ids: f.fact ? ['answer_' + f.id + '_1'] : [],
    };
  });
  const path = join(work, 'lme-mini.json');
  writeFileSync(path, JSON.stringify(questions));
  return path;
}

/** A gbrain root that carries a "Rust engine": PGLite behind the rust kind, every other module re-exported from the pin. */
function fakeRustGbrain(): GbrainUnderTest {
  const root = mkdtempSync(join(work, 'fake-rust-'));
  mkdirSync(join(root, 'src/core/rust-engine'), { recursive: true });
  mkdirSync(join(root, 'src/core/search'), { recursive: true });
  mkdirSync(join(root, 'src/core/ai'), { recursive: true });
  const p = (sub: string) => JSON.stringify(join(pinned.root, sub));
  writeFileSync(join(root, 'src/core/engine-construct.ts'),
    'import { PGLiteEngine } from ' + p('src/core/pglite-engine.ts') + ';\n'
    + 'export async function constructEngine() { return new PGLiteEngine(); }\n');
  for (const sub of ['src/core/import-file.ts', 'src/core/search/hybrid.ts', 'src/core/embedding.ts', 'src/core/ai/gateway.ts', 'src/core/embedding-pricing.ts']) {
    writeFileSync(join(root, sub), 'export * from ' + p(sub) + ';\n');
  }
  return { root, version: '0.0.0-fake-rust', overlay: null };
}

const quiet = () => {};
let dataset = '';
beforeAll(() => { dataset = writeDataset(); });
afterAll(() => { closeLedgers(); rmSync(work, { recursive: true, force: true }); });

function row(engine: 'pglite' | 'postgres' | 'rust', id: string, retrieved: string[], recall: number | null, extra: Partial<QuestionRow> = {}): QuestionRow {
  return {
    engine, question_id: id, question_type: 't', is_abs: recall === null, num_sessions: 10,
    arms: { keyword: { retrieved, recall_all: recall, recall_any: recall, search_ms: 1 } }, timing_ms: { open: 1, import: 1, search: 1, total: 3 }, ...extra,
  };
}

describe('per-question comparison', () => {
  const rows = [
    row('pglite', 'a', ['s1', 's2', 's3'], 1), row('postgres', 'a', ['s1', 's2', 's3'], 1),
    row('pglite', 'b', ['s1', 's2', 's3'], 1), row('postgres', 'b', ['s2', 's1', 's3'], 1),
    row('pglite', 'c', ['s1', 's4'], 1), row('postgres', 'c', ['s5', 's4'], 0),
    row('pglite', 'd_abs', ['s1'], null), row('postgres', 'd_abs', ['s9'], null),
    row('pglite', 'e', ['s1'], 1), row('postgres', 'e', [], null, { error: 'boom', arms: {} }),
  ];
  test('lists which sessions differ, keeps order-only changes apart, and excludes errors by name', () => {
    const c = comparePair(rows, 'keyword', 'pglite', 'postgres');
    expect(c.n_questions).toBe(4);
    expect(c.excluded_errors).toEqual(['e']);
    expect(c.differences).toEqual([
      { question_id: 'b', only_a: [], only_b: [], order_only: true },
      { question_id: 'c', only_a: ['s1'], only_b: ['s5'], order_only: false },
      { question_id: 'd_abs', only_a: ['s1'], only_b: ['s9'], order_only: false },
    ]);
    expect(c.identical_top5_ordered).toBe(0.25);
    expect(c.identical_top5_set).toBe(0.5);
  });
  test('the paired recall_all delta leaves abstention questions out and is B minus A', () => {
    const d = comparePair(rows, 'keyword', 'pglite', 'postgres').recall_all_delta!;
    expect(d.n_pairs).toBe(3);
    expect(d.mean_a).toBe(1);
    expect(d.delta).toBeCloseTo(-1 / 3, 10);
    expect(d.losses_b).toBe(1);
    expect(d.wins_b).toBe(0);
    expect(d.ci95).not.toBeNull();
  });
  test('only the top 5 count, and agreement needs every engine', () => {
    const long = ['s1', 's2', 's3', 's4', 's5'];
    const r = [row('pglite', 'x', [...long, 's6'], 1), row('postgres', 'x', [...long, 's7'], 1), row('rust', 'x', long, 1), row('pglite', 'y', ['s1'], 1), row('postgres', 'y', ['s1'], 1)];
    expect(LME_RECALL_TOP_K).toBe(5);
    expect(armAgreement(r, 'keyword', ['pglite', 'postgres', 'rust'])).toMatchObject({ n_questions: 1, identical_top5_share: 1 });
    expect(armAgreement(r, 'keyword', ['pglite', 'postgres'])).toMatchObject({ n_questions: 2, identical_top5_share: 1 });
    expect(armAgreement([], 'keyword', ['pglite']).identical_top5_share).toBeNull();
  });
});

describe('runLmeRecall', () => {
  test('keyword arm on PGLite finds the evidence session; the pinned build refuses rust with the reason', async () => {
    const r = await runLmeRecall({ gut: pinned, engines: ['pglite', 'rust'], datasetPath: dataset, arms: ['keyword'], log: quiet });
    const [pg, rust] = r.engines;
    expect(rust).toMatchObject({ kind: 'rust', status: 'refused', reason: 'rust_engine_not_in_build' });
    expect(pg.status).toBe('ran');
    expect(pg.n_errors).toBe(0);
    expect(pg.recall.keyword).toEqual({ recall_all_at_5: 1, recall_any_at_5: 1, n_scored: 2 });
    const q1 = r.rows.find(x => x.question_id === 'q1')!;
    expect(q1.arms.keyword!.retrieved[0]).toBe('answer_q1_1');
    expect(r.rows.find(x => x.question_id === 'q3_abs')!.arms.keyword!.recall_all).toBeNull();
    expect(r.embedder.mode).toBe('none');
    expect(r.dataset).toMatchObject({ selected: 3, abstention_selected: 1, matches_published_sha256: false });
    expect(r.search_config).toEqual({ 'search.mode': 'balanced', 'search.reranker.enabled': 'false', 'search.autocut': 'false' });
    expect(r.comparisons).toEqual([]);
  }, 120_000);

  test('a build that carries the rust engine runs it through openEvalEngine and lands in the paired comparison', async () => {
    const r = await runLmeRecall({ gut: fakeRustGbrain(), engines: ['pglite', 'rust'], datasetPath: dataset, arms: ['keyword'], limit: 2, log: quiet });
    expect(r.engines.map(e => [e.kind, e.status, e.n_errors])).toEqual([['pglite', 'ran', 0], ['rust', 'ran', 0]]);
    expect(r.comparisons).toHaveLength(1);
    expect(r.comparisons[0]).toMatchObject({ a: 'pglite', b: 'rust', n_questions: 2, identical_top5_ordered: 1, differences: [] });
    expect(r.comparisons[0].recall_all_delta).toMatchObject({ n_pairs: 2, delta: 0 });
    expect(r.agreement[0].identical_top5_share).toBe(1);
  }, 120_000);

  test('postgres without a server URL is refused, not skipped silently', async () => {
    const r = await runLmeRecall({ gut: pinned, engines: ['postgres'], datasetPath: dataset, arms: ['keyword'], limit: 1, log: quiet });
    expect(r.engines[0]).toMatchObject({ kind: 'postgres', status: 'refused', reason: 'postgres_url_missing' });
  }, 60_000);

  test('the plumbing check labels its scores as meaningless', async () => {
    const r = await runLmeRecall({ gut: pinned, engines: ['pglite'], datasetPath: dataset, arms: ['vector', 'hybrid'], embedder: 'plumbing-stub', limit: 1, log: quiet });
    expect(r.engines[0].n_errors).toBe(0);
    expect(r.embedder).toMatchObject({ mode: 'plumbing-stub', plumbing_only: true, model: 'voyage:voyage-4', dimensions: 1024 });
    expect(r.embedder.note).toMatch(/PLUMBING CHECK/);
  }, 120_000);

  test('the runner source never sends raw SQL through an engine', () => {
    const src = readFileSync(join(import.meta.dir, '../../eval/runner/engine-bench/lme-recall.ts'), 'utf8');
    expect(src).not.toMatch(/\.executeRaw\s*[<(]/);
    const adminSql = [...src.matchAll(/\.unsafe\('([A-Z ]+)/g)].map(m => m[1].trim());
    expect(adminSql.length).toBeGreaterThan(0);
    expect(adminSql.every(x => x === 'CREATE DATABASE' || x === 'DROP DATABASE IF EXISTS')).toBe(true);
  });
});

describe('embedding cache: count, fill, read-only counted run', () => {
  const cachePath = join(work, 'cache', 'embed.sqlite');
  const ledgerPath = join(work, 'ledger', 'ledger.sqlite');
  const calls: string[][] = [];
  const recording = (dims: number) => {
    const stub = stubTransport(dims);
    return async (params: { values: string[] } & Record<string, unknown>) => { calls.push(params.values); return stub(params); };
  };

  test('the counted run fails closed when the cache file does not exist', async () => {
    await expect(runLmeRecall({ gut: pinned, engines: ['pglite'], datasetPath: dataset, arms: ['vector'], cachePath, limit: 1, log: quiet })).rejects.toBeInstanceOf(EmbedCacheMiss);
  });

  test('fill-cache refuses without --paid and without --budget-run-id', async () => {
    const budget = { budgetUsd: 1, ledgerPath, programCapUsd: null, runId: null };
    await expect(fillCache({ gut: pinned, paid: false, budget, datasetPath: dataset, cachePath, log: quiet })).rejects.toThrow(/--paid/);
    await expect(fillCache({ gut: pinned, paid: true, budget, datasetPath: dataset, cachePath, log: quiet })).rejects.toThrow(/--budget-run-id/);
    expect(existsSync(cachePath)).toBe(false);
  });

  test('count reports what fill would embed, fill writes it through the ledger, and the counted run then reads only the cache', async () => {
    const before = await countEmbedPlan({ gut: pinned, datasetPath: dataset, cachePath, limit: 2, log: quiet });
    expect(before).toMatchObject({ model: 'voyage:voyage-4', dimensions: 1024, questions: 2, texts_cached: 0, price_per_mtok_usd: 0.06 });
    expect(before.texts_to_embed).toBeGreaterThan(2);
    expect(before.est_tokens_to_embed).toBe(Math.ceil(before.chars_to_embed / 3.5));

    const run = BudgetRun.open({ runner: 'lme-recall-test', budgetUsd: 1, ledgerPath, programCapUsd: 5 });
    const filled = await fillCache({
      gut: pinned, paid: true, budget: { budgetUsd: null, ledgerPath, programCapUsd: null, runId: run.runId }, datasetPath: dataset, cachePath, limit: 2,
      transport: recording(1024), env: { VOYAGE_API_KEY: 'test-placeholder' }, log: quiet,
    });
    run.close();
    expect(calls.length).toBeGreaterThan(0);
    expect(filled.cache_entries).toBe(before.texts_to_embed);
    expect(filled.cost.usd).toBe(0);

    const after = await countEmbedPlan({ gut: pinned, datasetPath: dataset, cachePath, limit: 2, log: quiet });
    expect(after).toMatchObject({ texts_to_embed: 0, chars_to_embed: 0, texts_cached: before.texts_to_embed });

    const n = calls.length;
    const r = await runLmeRecall({ gut: pinned, engines: ['pglite'], datasetPath: dataset, arms: ['keyword', 'vector', 'hybrid'], cachePath, limit: 2, log: quiet });
    expect(calls.length).toBe(n);
    expect(r.engines[0]).toMatchObject({ status: 'ran', n_errors: 0 });
    expect(r.embedder).toMatchObject({ mode: 'cache', plumbing_only: false, cache_path: cachePath });
  }, 240_000);

  test('a cache that lacks a text stops the counted run instead of calling a provider', async () => {
    const empty = join(work, 'cache', 'empty.sqlite');
    new EmbeddingCache(empty, 'voyage:voyage-4@1024').close();
    await expect(runLmeRecall({ gut: pinned, engines: ['pglite'], datasetPath: dataset, arms: ['vector'], cachePath: empty, limit: 1, log: quiet })).rejects.toBeInstanceOf(EmbedCacheMiss);
  }, 120_000);
});

describe('no provider calls', () => {
  test('refuseNetwork refuses a non-loopback request and restores fetch', async () => {
    const original = globalThis.fetch;
    const restore = refuseNetwork();
    await expect(fetch('https://api.voyageai.com/v1/embeddings')).rejects.toThrow(/refused a request to api.voyageai.com/);
    restore();
    expect(globalThis.fetch).toBe(original);
  });
  test('hash vectors are unit length and deterministic', () => {
    const v = hashVector('hello', 1024);
    expect(v).toHaveLength(1024);
    expect(Math.sqrt(v.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 6);
    expect(hashVector('hello', 1024)).toEqual(v);
  });
  test('the CLI prints usage for an unknown command', async () => {
    expect(await main(['nope'])).toBe(2);
  });
});

const PG_URL = process.env.ENGINE_BENCH_PG_URL;
describe.skipIf(!PG_URL)('postgres (set ENGINE_BENCH_PG_URL to a pgvector server)', () => {
  test('postgres and pglite return the same keyword top 5 on the mini dataset', async () => {
    const r = await runLmeRecall({ gut: pinned, engines: ['pglite', 'postgres'], postgresUrl: PG_URL, datasetPath: dataset, arms: ['keyword'], log: quiet });
    expect(r.engines.map(e => e.status)).toEqual(['ran', 'ran']);
    expect(r.agreement[0].identical_top5_share).toBe(1);
  }, 120_000);
});

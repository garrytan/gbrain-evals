import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregateLmeRows, armAgreement, comparePair, countEmbedPlan, readLmeRows, EmbedCacheMiss, fillCache, hashVector, LME_RECALL_TOP_K, main, refuseNetwork, runLmeRecall, RUST_RECALL_DELTA,
  RUST_RECALL_NONINFERIORITY_MARGIN,
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
function writeDataset(facts: { id: string; type: string; question: string; fact: string | null }[] = [
  { id: 'q1', type: 'single-session-user', question: 'What colour did I paint my bicycle?', fact: 'The colour I chose to paint my bicycle was turquoise.' },
  { id: 'q2', type: 'single-session-user', question: 'Which marathon did I sign up for?', fact: 'Which marathon did I sign up for? The Rotterdam marathon in April.' },
  { id: 'q3_abs', type: 'single-session-user', question: 'What is the name of my pet iguana?', fact: null },
], name = 'lme-mini.json'): string {
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
  const path = join(work, name);
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
  writeFileSync(join(root, 'src/cli.ts'), '');
  writeFileSync(join(root, 'src/core/engine-construct.ts'),
    'import { PGLiteEngine } from ' + p('src/core/pglite-engine.ts') + ';\n'
    + '// The real Rust brain gets its schema from gbrain init; this PGLite stand-in brings it up at connect.\n'
    + 'export async function constructEngine() { const e = new PGLiteEngine(); const connect = e.connect.bind(e); e.connect = async c => { await connect(c); await e.initSchema(); }; return e; }\n');
  for (const sub of ['src/core/import-file.ts', 'src/core/search/hybrid.ts', 'src/core/embedding.ts', 'src/core/ai/gateway.ts', 'src/core/embedding-pricing.ts', 'src/core/embed-retry.ts']) {
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
  test('agreement counts the questions where every engine returned nothing', () => {
    const r = [row('pglite', 'x', [], 0), row('postgres', 'x', [], 0), row('pglite', 'y', ['s1'], 1), row('postgres', 'y', ['s1'], 1), row('pglite', 'z', [], 0), row('postgres', 'z', ['s2'], 0)];
    expect(armAgreement(r, 'keyword', ['pglite', 'postgres'])).toMatchObject({ n_questions: 3, identical_top5_share: 2 / 3, n_all_empty: 1 });
  });
});

describe('the Rust verdict per arm', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => 'q' + String(i).padStart(3, '0'));
  const recallOf = (i: number) => (i % 3 === 0 ? 0 : 1);
  const engineRows = (engine: 'pglite' | 'rust', n: number, f: (i: number) => Partial<QuestionRow> | number = recallOf) =>
    ids(n).map((id, i) => { const v = f(i); return typeof v === 'number' ? row(engine, id, ['s' + i], v) : row(engine, id, [], 0, v); });

  test('Rust timing out on 100 of 500 questions with otherwise identical recall fails the arm, whichever side Rust is on', () => {
    const timeout = { error: 'question_timeout_120000ms: import and search', arms: {} };
    const rows = [...engineRows('pglite', 500), ...engineRows('rust', 500, i => (i % 5 === 0 ? timeout : recallOf(i)))];
    for (const [a, b] of [['pglite', 'rust'], ['rust', 'pglite']] as const) {
      const c = comparePair(rows, 'keyword', a, b);
      expect(c.rust_verdict).toBe('fail');
      expect(c.rust_errors).toHaveLength(100);
      expect(c.excluded_errors).toEqual([]);
      expect(c.n_questions).toBe(400);
      expect(c.recall_all_delta!.n_pairs).toBe(500);
      expect(c.recall_all_delta!.ci95).not.toEqual([0, 0]);
    }
  });

  test('a question the other engine answered and Rust has no row for fails the arm, whichever side Rust is on', () => {
    const rows = [...engineRows('pglite', 50), ...engineRows('rust', 40)];
    for (const [a, b] of [['pglite', 'rust'], ['rust', 'pglite']] as const) {
      const c = comparePair(rows, 'keyword', a, b);
      expect(c.rust_errors).toEqual(ids(50).slice(40));
      expect(c.rust_verdict).toBe('fail');
      expect(c.recall_all_delta!.n_pairs).toBe(50);
    }
  });

  test('a clean identical run passes; a pair without Rust carries no Rust verdict', () => {
    const rows = [...engineRows('pglite', 60), ...engineRows('rust', 60), ...engineRows('pglite', 60).map(r => ({ ...r, engine: 'postgres' as const }))];
    for (const [a, b] of [['pglite', 'rust'], ['rust', 'pglite']] as const) {
      expect(comparePair(rows, 'keyword', a, b)).toMatchObject({ rust_verdict: 'pass', rust_errors: [], recall_all_delta: { delta: 0, ci95: [0, 0] } });
    }
    const ts = comparePair(rows, 'keyword', 'pglite', 'postgres');
    expect('rust_verdict' in ts || 'rust_errors' in ts).toBe(false);
  });

  test('a Rust-only drop below the margin fails, and a TypeScript-only drop does not', () => {
    const dropped = (engine: 'pglite' | 'rust') => ids(100).map((id, i) => (i < 10 ? row(engine, id, ['miss' + i], 0) : row(engine, id, ['s' + i], 1)));
    const rustWorse = [...engineRows('pglite', 100, () => 1), ...dropped('rust')];
    const rustBetter = [...dropped('pglite'), ...engineRows('rust', 100, () => 1)];
    for (const [a, b] of [['pglite', 'rust'], ['rust', 'pglite']] as const) {
      const worse = comparePair(rustWorse, 'keyword', a, b);
      expect(worse.rust_errors).toEqual([]);
      expect(worse.rust_verdict).toBe('fail');
      expect(comparePair(rustBetter, 'keyword', a, b).rust_verdict).toBe('pass');
    }
    expect(RUST_RECALL_DELTA).toBe(0.018);
    expect(RUST_RECALL_NONINFERIORITY_MARGIN).toBe(-0.02);
  });

  const planned = 470;
  const both = (rust: (i: number) => QuestionRow | undefined) => ids(planned).flatMap((id, i) => {
    const ts = row('pglite', id, ['s' + i], recallOf(i));
    return [ts, rust(i) ?? { ...ts, engine: 'rust' as const }];
  });
  const flip = (id: string, i: number, recall: number) => row('rust', id, ['other' + i], recall);
  const rustRows = (wins: number[], losses: number[]) => both(i => {
    const id = ids(planned)[i];
    if (wins.includes(i)) return flip(id, i, 1);
    if (losses.includes(i)) return flip(id, i, 0);
    return undefined;
  });
  const winners = (k: number) => ids(planned).map((_, i) => i).filter(i => recallOf(i) === 0).slice(0, k);
  const losers = (k: number) => ids(planned).map((_, i) => i).filter(i => recallOf(i) === 1).slice(0, k);

  test('Rust level on points with a lower bound of -0.019 fails the gate, though it sits inside the old -0.02 margin', () => {
    for (const [a, b] of [['pglite', 'rust'], ['rust', 'pglite']] as const) {
      const c = comparePair(rustRows(winners(10), losers(10)), 'keyword', a, b);
      const lower = b === 'rust' ? c.recall_all_delta!.ci95![0] : -c.recall_all_delta!.ci95![1];
      expect(lower).toBeGreaterThanOrEqual(-0.02);
      expect(lower).toBeLessThan(-RUST_RECALL_DELTA);
      expect(c.rust_point_estimate).toBe(0);
      expect(c.exact_ties).toBe(planned - 20);
      expect(c.rust_verdict).toBe('fail');
      expect(c.rust_secondary).toEqual({ lower_bound_at_least_0: 'fail', non_inferiority_minus_0_02: 'pass' });
    }
  });

  test('the gate reads only the lower bound, and the point estimate is reported beside it', () => {
    for (const [a, b] of [['pglite', 'rust'], ['rust', 'pglite']] as const) {
      const behind = comparePair(rustRows([], losers(1)), 'keyword', a, b);
      expect(behind.rust_point_estimate).toBeCloseTo(-1 / planned, 10);
      expect(behind.rust_verdict).toBe('pass');
      expect(behind.rust_secondary).toEqual({ lower_bound_at_least_0: 'fail', non_inferiority_minus_0_02: 'pass' });
      const close = comparePair(rustRows(winners(10), losers(5)), 'keyword', a, b);
      expect(close.rust_verdict).toBe('pass');
      const noisy = comparePair(rustRows(winners(60), losers(55)), 'keyword', a, b);
      expect(noisy.rust_point_estimate).toBeGreaterThan(0);
      expect(noisy.rust_verdict).toBe('fail');
      const clear = comparePair(rustRows(winners(30), []), 'keyword', a, b);
      expect(clear.rust_verdict).toBe('pass');
      expect(clear.rust_secondary).toEqual({ lower_bound_at_least_0: 'pass', non_inferiority_minus_0_02: 'pass' });
    }
  });

  test('the same top-5 session ids are an exact tie whatever the rows score, and an arm where every question ties passes', () => {
    const sameIdsLowerScore = both(i => (recallOf(i) === 1 && i < 60 ? row('rust', ids(planned)[i], ['s' + i], 0) : undefined));
    const c = comparePair(sameIdsLowerScore, 'keyword', 'pglite', 'rust');
    expect(c.exact_ties).toBe(planned);
    expect(c.recall_all_delta).toMatchObject({ delta: 0, ci95: [0, 0] });
    expect(c.rust_verdict).toBe('pass');
    const one = [row('pglite', 'q1', ['s1', 's2'], 1), row('rust', 'q1', ['s2', 's1'], 1)];
    expect(comparePair(one, 'keyword', 'pglite', 'rust')).toMatchObject({ exact_ties: 1, rust_verdict: 'pass', rust_secondary: { lower_bound_at_least_0: 'pass', non_inferiority_minus_0_02: 'pass' } });
  });

  test('abstention-only questions leave the arm unmeasured; a TypeScript error is excluded, not charged to Rust', () => {
    const abs = [row('pglite', 'x_abs', ['s1'], null), row('rust', 'x_abs', [], null, { error: 'boom', arms: {} })];
    expect(comparePair(abs, 'keyword', 'pglite', 'rust')).toMatchObject({ rust_verdict: 'unmeasured', rust_errors: [], excluded_errors: ['x_abs'], recall_all_delta: null });
    const tsError = [...engineRows('pglite', 20), ...engineRows('rust', 20), row('pglite', 'y', [], 0, { error: 'boom', arms: {} }), row('rust', 'y', ['s1'], 1)];
    expect(comparePair(tsError, 'keyword', 'pglite', 'rust')).toMatchObject({ rust_verdict: 'pass', rust_errors: [], excluded_errors: ['y'] });
  });
});

describe('runLmeRecall', () => {
  test('keyword arm on PGLite finds the evidence session; the pinned build refuses rust with the reason', async () => {
    const r = await runLmeRecall({ gut: pinned, engines: ['pglite', 'rust'], datasetPath: dataset, arms: ['keyword'], log: quiet });
    const [pg, rust] = r.engines;
    expect(rust).toMatchObject({ kind: 'rust', status: 'refused', reason: 'rust_kind_unsupported' });
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

  test('keyword arm searches as a keyless brain does: a question with a word no session holds still finds the evidence', async () => {
    const anyWord = writeDataset([{ id: 'q4', type: 'single-session-user', question: 'Which city did I run the marathon in last spring?', fact: 'I ran the Rotterdam marathon in April.' }], 'lme-any-word.json');
    const r = await runLmeRecall({ gut: pinned, engines: ['pglite'], datasetPath: anyWord, arms: ['keyword'], log: quiet });
    expect(r.rows[0]!.arms.keyword!.retrieved).toContain('answer_q4_1');
    expect(r.engines[0]!.recall.keyword).toEqual({ recall_all_at_5: 1, recall_any_at_5: 1, n_scored: 1 });
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
    return async (params: { values: string[] } & Record<string, unknown>) => { calls.push(params.values); return { ...(await stub(params)), usage: { tokens: params.values.length * 7 } }; };
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
    expect(filled.provider_usage).toMatchObject({ tokens: calls.reduce((s, v) => s + v.length * 7, 0), requests: calls.length, requests_without_usage: 0 });

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

  test('a failed embed call stops every fill worker before the paid-request guard comes off', async () => {
    const stub = stubTransport(1024);
    let bad: string | undefined, transportCalls = 0, lateFetches = 0, settled = false;
    const transport = async (params: { values: string[] } & Record<string, unknown>) => {
      transportCalls++;
      bad ??= params.values[0];
      if (params.values[0] === bad) throw new Error('provider down');
      await new Promise(r => setTimeout(r, 40));
      return { ...(await stub(params)), usage: { tokens: 1 } };
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { if (settled) lateFetches++; throw new Error('no network in tests'); }) as unknown as typeof fetch;
    const run = BudgetRun.open({ runner: 'lme-recall-test', budgetUsd: 1, ledgerPath, programCapUsd: 5 });
    try {
      await expect(fillCache({
        gut: pinned, paid: true, budget: { budgetUsd: null, ledgerPath, programCapUsd: null, runId: run.runId }, datasetPath: dataset,
        cachePath: join(work, 'cache', 'fail.sqlite'), limit: 2, batch: 1, parallel: 4, transport: transport as never, env: { VOYAGE_API_KEY: 'test-placeholder' }, log: quiet,
      })).rejects.toThrow(/provider down/);
      settled = true;
      const after = transportCalls;
      await new Promise(r => setTimeout(r, 500));
      expect(transportCalls).toBe(after);
      expect(lateFetches).toBe(0);
    } finally {
      settled = false;
      globalThis.fetch = realFetch;
      run.close();
    }
  }, 120_000);
});

describe('sharding and NDJSON resume', () => {
  const nd = (name: string) => join(work, 'nd', name);
  const lines = (path: string) => readFileSync(path, 'utf8').split('\n').filter(Boolean).length;

  test('two workers split the questions, a rerun resumes without new rows, and aggregate joins the shards', async () => {
    const a = nd('w0.ndjson'), b = nd('w1.ndjson');
    const r0 = await runLmeRecall({ gut: pinned, engines: ['pglite'], datasetPath: dataset, arms: ['keyword'], ndjsonPath: a, workerId: 0, totalWorkers: 2, log: quiet });
    const r1 = await runLmeRecall({ gut: pinned, engines: ['pglite'], datasetPath: dataset, arms: ['keyword'], ndjsonPath: b, workerId: 1, totalWorkers: 2, log: quiet });
    expect(r0.rows.map(r => r.question_id)).toEqual(['q1', 'q3_abs']);
    expect(r1.rows.map(r => r.question_id)).toEqual(['q2']);
    expect(r0.shard).toEqual({ worker_id: 0, total_workers: 2, questions: 2 });
    expect(lines(a)).toBe(2);
    expect(r0.rows.every(r => r.run_config_hash === r0.run_config_hashes.pglite)).toBe(true);

    const again = await runLmeRecall({ gut: pinned, engines: ['pglite'], datasetPath: dataset, arms: ['keyword'], ndjsonPath: a, workerId: 0, totalWorkers: 2, log: quiet });
    expect(again.resumed_rows).toBe(2);
    expect(lines(a)).toBe(2);
    expect(again.engines[0].recall.keyword).toEqual(r0.engines[0].recall.keyword);

    const agg = aggregateLmeRows([a, b]);
    expect(agg.rows).toHaveLength(3);
    expect(agg.engines[0]).toMatchObject({ kind: 'pglite', n_questions: 3, n_errors: 0 });
    expect(agg.engines[0].recall.keyword).toEqual({ recall_all_at_5: 1, recall_any_at_5: 1, n_scored: 2 });
  }, 180_000);

  test('an error row runs again, and a clean row from another configuration refuses to mix', async () => {
    const path = nd('errors.ndjson');
    const first = await runLmeRecall({ gut: pinned, engines: ['pglite'], datasetPath: dataset, arms: ['keyword'], limit: 1, ndjsonPath: path, log: quiet });
    const hash = first.run_config_hashes.pglite!;
    writeFileSync(path, JSON.stringify({ ...first.rows[0], arms: {}, error: 'boom' }) + '\n{"truncated":');
    const rerun = await runLmeRecall({ gut: pinned, engines: ['pglite'], datasetPath: dataset, arms: ['keyword'], limit: 1, ndjsonPath: path, log: quiet });
    expect(rerun.resumed_rows).toBe(0);
    expect(rerun.rows[0].error).toBeUndefined();
    expect(readLmeRows(path).map(r => r.error ?? 'clean')).toEqual(['boom', 'clean']);

    writeFileSync(path, JSON.stringify({ ...first.rows[0], run_config_hash: 'other' }) + '\n');
    await expect(runLmeRecall({ gut: pinned, engines: ['pglite'], datasetPath: dataset, arms: ['keyword'], limit: 1, ndjsonPath: path, log: quiet })).rejects.toThrow(/different run configuration/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  }, 180_000);

  test('a Rust error is never retried away: resume keeps it and aggregate keeps it over a later clean row', async () => {
    const path = nd('rust-error.ndjson');
    const first = await runLmeRecall({ gut: fakeRustGbrain(), engines: ['pglite', 'rust'], datasetPath: dataset, arms: ['keyword'], limit: 2, ndjsonPath: path, log: quiet });
    const failed = { ...first.rows.find(r => r.engine === 'rust' && r.question_id === 'q1')!, arms: {}, error: 'question_timeout_600000ms: import and search' };
    writeFileSync(path, first.rows.filter(r => !(r.engine === 'rust' && r.question_id === 'q1')).concat(failed).map(r => JSON.stringify(r)).join('\n') + '\n');
    const resumed = await runLmeRecall({ gut: fakeRustGbrain(), engines: ['pglite', 'rust'], datasetPath: dataset, arms: ['keyword'], limit: 2, ndjsonPath: path, log: quiet });
    expect(resumed.rows.find(r => r.engine === 'rust' && r.question_id === 'q1')!.error).toMatch(/question_timeout/);
    expect(resumed.comparisons[0]).toMatchObject({ a: 'pglite', b: 'rust', rust_errors: ['q1'], rust_verdict: 'fail' });

    const later = nd('rust-error-then-clean.ndjson');
    writeFileSync(later, [failed, first.rows.find(r => r.engine === 'rust' && r.question_id === 'q1')!].map(r => JSON.stringify(r)).join('\n') + '\n');
    const agg = aggregateLmeRows([path, later]);
    expect(agg.comparisons[0]).toMatchObject({ rust_errors: ['q1'], rust_verdict: 'fail' });
  }, 180_000);

  test('a worker id outside the worker count is refused', async () => {
    await expect(runLmeRecall({ gut: pinned, engines: ['pglite'], datasetPath: dataset, arms: ['keyword'], workerId: 2, totalWorkers: 2, log: quiet })).rejects.toThrow(/worker-id/);
  });

  test('aggregate refuses rows from two configurations of one engine', () => {
    const path = nd('mixed.ndjson');
    const base = { engine: 'pglite', question_type: 't', is_abs: false, num_sessions: 1, arms: {}, timing_ms: { open: 0, import: 0, search: 0, total: 0 } };
    writeFileSync(path, [{ ...base, question_id: 'a', run_config_hash: 'x' }, { ...base, question_id: 'b', run_config_hash: 'y' }].map(r => JSON.stringify(r)).join('\n') + '\n');
    expect(() => aggregateLmeRows([path])).toThrow(/more than one run configuration/);
  });

  test('aggregate carries each shard attestation and refuses counted shards mixed with dev shards', () => {
    const base = { engine: 'pglite', question_type: 't', is_abs: false, num_sessions: 1, arms: {}, timing_ms: { open: 0, import: 0, search: 0, total: 0 }, run_config_hash: 'c' };
    const attestation = { preregistration: 'docs/p.md', preregistration_commit: 'abc', runner_commit: 'def', worktree_clean_for_preregistration: true, on_origin: true, attested_at: '2026-11-17T00:00:00.000Z' };
    const gbrain = { version: '0.61.0.0', overlay: { commit: 'c0ffee', ref: 'v0.61.0.0' }, rust_addon: { sha256: 'addon-sha', target: 'linux-x64-glibc' } };
    const [a, b, dev] = [nd('counted-0.ndjson'), nd('counted-1.ndjson'), nd('dev.ndjson')];
    writeFileSync(a, JSON.stringify({ preregistration_attestation: attestation, gbrain, shard: { worker_id: 0, total_workers: 2 } }) + '\n' + JSON.stringify({ ...base, question_id: 'a' }) + '\n');
    writeFileSync(b, JSON.stringify({ preregistration_attestation: attestation, gbrain, shard: { worker_id: 1, total_workers: 2 } }) + '\n' + JSON.stringify({ ...base, question_id: 'b' }) + '\n');
    writeFileSync(dev, JSON.stringify({ ...base, question_id: 'c' }) + '\n');
    const counted = aggregateLmeRows([a, b]);
    expect(counted.counted).toBe(true);
    expect(counted.rows).toHaveLength(2);
    expect(counted.preregistration_attestation?.map(x => x.ndjson)).toEqual([a, b]);
    expect(aggregateLmeRows([dev]).preregistration_attestation).toBeNull();
    expect(() => aggregateLmeRows([a, dev])).toThrow(/counted and dev shards are mixed/);
  });

  test('a counted aggregate carries the one gbrain build its shards recorded, and refuses shards from two builds or with none', () => {
    const base = { engine: 'rust', question_type: 't', is_abs: false, num_sessions: 1, arms: {}, timing_ms: { open: 0, import: 0, search: 0, total: 0 }, run_config_hash: 'c' };
    const attestation = { preregistration: 'docs/p.md', preregistration_commit: 'abc', runner_commit: 'def', worktree_clean_for_preregistration: true, on_origin: true, attested_at: '2026-11-17T00:00:00.000Z' };
    const gbrain = (addon: string) => ({ version: '0.61.0.0', overlay: { commit: 'c0ffee', ref: 'v0.61.0.0' }, rust_addon: { sha256: addon, target: 'linux-x64-glibc' } });
    const shard = (name: string, id: string, g: unknown) => {
      const p = nd(name);
      writeFileSync(p, JSON.stringify({ preregistration_attestation: attestation, ...(g ? { gbrain: g } : {}), shard: { worker_id: 0, total_workers: 1 } }) + '\n' + JSON.stringify({ ...base, question_id: id }) + '\n');
      return p;
    };
    const [x, y, other, bare] = [shard('b-0.ndjson', 'a', gbrain('addon-sha')), shard('b-1.ndjson', 'b', gbrain('addon-sha')), shard('b-2.ndjson', 'c', gbrain('other')), shard('b-3.ndjson', 'd', null)];
    expect(aggregateLmeRows([x, y]).gbrain).toEqual(gbrain('addon-sha'));
    expect(() => aggregateLmeRows([x, other])).toThrow(/one gbrain build and Rust addon/);
    expect(() => aggregateLmeRows([x, bare])).toThrow(/one gbrain build and Rust addon/);
  });
});

describe('counted runs', () => {
  test('a run without --dev and without --prereg is refused, and so is one with both', async () => {
    await expect(main(['run', '--limit', '1'])).rejects.toThrow(/counted run needs --prereg/);
    await expect(main(['run', '--dev', '--prereg', 'docs/x.md', '--limit', '1'])).rejects.toThrow(/not both/);
  });

  test('a counted run refuses the plumbing stub and a preregistration that is not committed', async () => {
    await expect(runLmeRecall({ gut: pinned, engines: ['pglite'], arms: ['vector'], embedder: 'plumbing-stub', prereg: 'docs/x.md', log: quiet })).rejects.toThrow(/--dev runs only/);
    await expect(runLmeRecall({ gut: pinned, engines: ['pglite'], arms: ['keyword'], prereg: 'docs/no-such-preregistration.md', log: quiet })).rejects.toThrow(/does not exist/);
  });
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

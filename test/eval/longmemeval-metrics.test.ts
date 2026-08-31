/**
 * LongMemEval runner regression tests — hermetic, no API keys, no network.
 *
 * Load-bearing regressions (audit 2026-08-31):
 *   - longmemeval-01: headline is recall_all@k (official definition), NOT the
 *     inflating any-hit. A multi-evidence question with one of two answer
 *     sessions retrieved scores recall_any=1 but recall_all=0 — and the chart
 *     REFUSES legacy any-hit summaries.
 *   - longmemeval-02: `_abs` abstention questions are excluded from recall
 *     denominators and scored separately as abs_noise@k.
 *   - longmemeval-03: NDJSON error rows are re-queued on resume (not
 *     permanent misses); the aggregate dedupe prefers a success row over an
 *     earlier error row. Truncated final lines tolerated + re-run.
 *   - longmemeval-04: aggregate reads top_k/dataset from rows; mixed values
 *     or missing-without-CLI is an error, never a hardcoded 5/'s'.
 *   - longmemeval-05: cache key comes from the gateway's RESOLVED
 *     model/dims, whose configless fallback is zembed-1@1280 — not the old
 *     hand-rolled 'text-embedding-3-large@1536'.
 *   - longmemeval-06: cache key includes the embedding input_type so
 *     query-side and document-side vectors never alias.
 *   - longmemeval-07: zero-result (resume-complete) invocations produce a
 *     valid summary/markdown instead of NaN + a fmt() crash.
 *   - longmemeval-12: search mode/reranker/autocut pinned via engine.setConfig
 *     and recorded in the receipt resolved_config.
 *   - longmemeval-13: stratified sampling is seeded-random per type bucket,
 *     not first-N in dataset order.
 *   - verdict gate: computeVerdict is REAL and failable — proven both in unit
 *     form and end-to-end (a run whose ground truth is absent from the
 *     haystack must exit non-zero with verdict 'fail').
 *
 * The end-to-end tests run the real gbrain pipeline (PGLite + importFromContent
 * + engine.searchKeyword) with the keyword adapter — no embedding provider, no
 * LLM, fully offline.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  scoreQuestion,
  isAbsQuestion,
  readCompletedPairs,
  stratifiedSample,
  mulberry32,
  classifyErrorOrigin,
  summarizeAdapterRows,
  computeVerdict,
  defaultMinRecallAll,
  fmt,
  run,
  parseOpts,
  PINNED_SEARCH_CONFIG,
  type NdjsonRow,
  type Question,
  type RunSummary,
  type Opts,
} from '../../eval/runner/longmemeval.ts';
import { dedupeRows, inferRunParams, aggregateRows } from '../../eval/runner/longmemeval-aggregate.ts';
import { assertChartable, chartTitle, headlineCard, nLabel } from '../../eval/runner/longmemeval-chart.ts';
import { EmbeddingCache, makeCachingTransport, inputTypeFromParams } from '../../eval/runner/longmemeval-cache.ts';
import { loadReceipt } from '../../eval/runner/receipt.ts';

const TMP = mkdtempSync(join(tmpdir(), 'lme-test-'));

beforeAll(() => {
  // Keep gbrain (PGLite home, config) away from the real user home.
  process.env.GBRAIN_HOME = mkdtempSync(join(tmpdir(), 'lme-gbrain-home-'));
});

// ─── Metric definitions (longmemeval-01) ─────────────────────────────

describe('scoreQuestion', () => {
  test('multi-evidence: any-hit inflates, recall_all does not', () => {
    // gt = 2 sessions, only 1 retrieved → the OLD headline said hit; the
    // official recall_all says miss. This is the inflation the audit caught.
    const m = scoreQuestion(['s1', 'x', 'y'], ['s1', 's2'], 5);
    expect(m.recall_any).toBe(1);
    expect(m.recall_all).toBe(0);
  });

  test('recall_all=1 only when every gt session is in top-k', () => {
    const m = scoreQuestion(['s2', 'x', 's1'], ['s1', 's2'], 5);
    expect(m.recall_all).toBe(1);
    // Same retrieval at k=2 misses s1 → recall_all 0.
    expect(scoreQuestion(['s2', 'x', 's1'], ['s1', 's2'], 2).recall_all).toBe(0);
  });

  test('case-insensitive on both sides (slugs are lowercased by gbrain)', () => {
    const m = scoreQuestion(['sharegpt_yywfirx_0'], ['ShareGPT_yywfIrx_0'], 5);
    expect(m.recall_all).toBe(1);
  });

  test('ndcg_any rewards early ranks', () => {
    const atRank1 = scoreQuestion(['s1', 'x'], ['s1'], 5).ndcg_any;
    const atRank3 = scoreQuestion(['x', 'y', 's1'], ['s1'], 5).ndcg_any;
    expect(atRank1).toBe(1);
    expect(atRank3).toBeGreaterThan(0);
    expect(atRank3).toBeLessThan(atRank1);
  });

  test('abs_noise is fraction of top-k slots holding claimed evidence', () => {
    expect(scoreQuestion(['e1', 'x', 'y', 'z', 'w'], ['e1', 'e2'], 5).abs_noise).toBeCloseTo(1 / 5);
    expect(scoreQuestion(['x', 'y'], ['e1'], 5).abs_noise).toBe(0);
  });
});

// ─── _abs handling (longmemeval-02) ──────────────────────────────────

describe('abstention questions', () => {
  test('isAbsQuestion matches the official substring rule', () => {
    expect(isAbsQuestion('q123_abs')).toBe(true);
    expect(isAbsQuestion('gpt4_abs_2')).toBe(true);
    expect(isAbsQuestion('q123')).toBe(false);
  });

  test('summarize excludes _abs from recall denominators, reports abs_noise', () => {
    const rows: NdjsonRow[] = [
      row('q1', ['g1'], ['g1']),                    // recall_all 1
      row('q2', ['x'], ['g2']),                     // recall_all 0
      row('q3_abs', ['e1', 'x', 'y', 'z', 'w'], ['e1']), // abs: noise 1/5
    ];
    const s = summarizeAdapterRows('a', rows, 5, 'test');
    expect(s.total).toBe(2);                         // _abs NOT in denominator
    expect(s.n_abs).toBe(1);
    expect(s.recall_all_at_k).toBeCloseTo(0.5);
    expect(s.abs_noise_at_k).toBeCloseTo(1 / 5);
    // _abs must not leak into per-type recall either.
    const typeTotals = Object.values(s.recall_by_type).reduce((n, b) => n + b.total, 0);
    expect(typeTotals).toBe(2);
  });
});

// ─── Resume parser (longmemeval-03 + directive c) ────────────────────

describe('readCompletedPairs', () => {
  test('error rows are re-queued; truncated final line tolerated + re-run', () => {
    const p = join(TMP, 'resume.ndjson');
    writeFileSync(p, [
      JSON.stringify({ adapter: 'a', question_id: 'q1', hit_at_k: true }),
      JSON.stringify({ adapter: 'a', question_id: 'q2', hit_at_k: false, error: 'question_timeout_90000ms' }),
      JSON.stringify({ adapter: 'a', question_id: 'q3', hit_at_k: true }),
      '{"adapter":"a","question_id":"q4","hit_at', // kill -9 mid-append
    ].join('\n'));
    const done = readCompletedPairs(p);
    expect(done.has('a::q1')).toBe(true);
    expect(done.has('a::q3')).toBe(true);
    expect(done.has('a::q2')).toBe(false); // errored → re-run
    expect(done.has('a::q4')).toBe(false); // truncated → re-run
    expect(done.size).toBe(2);
  });

  test('missing file → empty set', () => {
    expect(readCompletedPairs(join(TMP, 'nope.ndjson')).size).toBe(0);
  });
});

// ─── Seeded stratified sampling (longmemeval-13) ─────────────────────

describe('stratifiedSample', () => {
  const qs: Question[] = [];
  for (const t of ['alpha', 'beta']) {
    for (let i = 0; i < 10; i++) {
      qs.push({
        question_id: `${t}_${i}`,
        question_type: t,
        question: 'q',
        answer: 'a',
        haystack_sessions: [],
        answer_session_ids: [],
      });
    }
  }

  test('deterministic for a fixed seed', () => {
    const a = stratifiedSample(qs, 3, 42).map(q => q.question_id);
    const b = stratifiedSample(qs, 3, 42).map(q => q.question_id);
    expect(a).toEqual(b);
    expect(a).toHaveLength(6);
  });

  test('covers every type with perType questions', () => {
    const s = stratifiedSample(qs, 3, 7);
    expect(s.filter(q => q.question_type === 'alpha')).toHaveLength(3);
    expect(s.filter(q => q.question_type === 'beta')).toHaveLength(3);
  });

  test('NOT first-N in dataset order (position bias removed)', () => {
    const firstN = ['alpha_0', 'alpha_1', 'alpha_2', 'beta_0', 'beta_1', 'beta_2'];
    // At least one of several seeds must differ from first-N; all of them
    // matching would mean the shuffle is dead code.
    const anyDiffers = [1, 2, 3, 42, 1337].some(seed => {
      const picked = stratifiedSample(qs, 3, seed).map(q => q.question_id);
      return JSON.stringify(picked) !== JSON.stringify(firstN);
    });
    expect(anyDiffers).toBe(true);
  });

  test('different seeds draw different samples', () => {
    const seeds = [1, 2, 3, 4, 5];
    const draws = new Set(seeds.map(s => stratifiedSample(qs, 3, s).map(q => q.question_id).join(',')));
    expect(draws.size).toBeGreaterThan(1);
  });

  test('mulberry32 stream is stable', () => {
    const r = mulberry32(42);
    const seq = [r(), r(), r()];
    const r2 = mulberry32(42);
    expect([r2(), r2(), r2()]).toEqual(seq);
    for (const v of seq) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

// ─── Error typing (WS0 policy) ───────────────────────────────────────

describe('classifyErrorOrigin', () => {
  test('watchdog timeout → harness (excluded + capped)', () => {
    expect(classifyErrorOrigin('question_timeout_90000ms')).toBe('harness');
  });
  test('provider outage/ratelimit → dependency', () => {
    expect(classifyErrorOrigin('OpenAI rate limit exceeded')).toBe('dependency');
    expect(classifyErrorOrigin('HTTP 429 Too Many Requests')).toBe('dependency');
    expect(classifyErrorOrigin('fetch failed: ECONNRESET')).toBe('dependency');
  });
  test('gbrain throwing during ingest/search → sut (scored 0)', () => {
    expect(classifyErrorOrigin('Page not found: chat/foo')).toBe('sut');
  });
});

// ─── Summary accounting incl. zero-row guard (longmemeval-07) ────────

describe('summarizeAdapterRows', () => {
  test('sut errors stay in the denominator as 0; infra errors are excluded', () => {
    const rows: NdjsonRow[] = [
      row('q1', ['g1'], ['g1']),
      { ...row('q2', [], ['g2']), error: 'Page not found', error_origin: 'sut' },
      { ...row('q3', [], ['g3']), error: 'question_timeout_90000ms', error_origin: 'harness' },
    ];
    const s = summarizeAdapterRows('a', rows, 5, 'test');
    expect(s.total).toBe(2);                       // q1 + q2(sut); q3 excluded
    expect(s.recall_all_at_k).toBeCloseTo(0.5);    // (1 + 0) / 2
    expect(s.n_errors_sut).toBe(1);
    expect(s.n_errors_infra).toBe(1);
  });

  test('legacy rows (no per-row metrics, no top_k) summarize identically', () => {
    const legacy: NdjsonRow[] = [
      { adapter: 'a', question_id: 'q1', question_type: 't', retrieved: ['s1'], ground_truth: ['s1', 's2'], hit_at_k: true, num_haystack: 2, latency_ms: 10 },
      { adapter: 'a', question_id: 'q2', question_type: 't', retrieved: ['s1', 's2'], ground_truth: ['s1', 's2'], hit_at_k: true, num_haystack: 2, latency_ms: 12 },
    ];
    const s = summarizeAdapterRows('a', legacy, 5, 's');
    // Old pipeline would have called this 100% (any-hit). recall_all says 50%.
    expect(s.recall_all_at_k).toBeCloseTo(0.5);
    expect(s.recall_any_at_k).toBeCloseTo(1.0);
  });

  test('zero rows → null metrics, and fmt() renders without crashing', () => {
    const s = summarizeAdapterRows('a', [], 5, 'test');
    expect(s.recall_all_at_k).toBeNull();
    expect(s.p50_latency_ms).toBeNull();
    expect(s.p99_latency_ms).toBeNull();
    // The old fmt() crashed on `undefined.toFixed(0)` here (finding 07).
    expect(() => fmt([s])).not.toThrow();
    expect(() => fmt([])).not.toThrow();
    expect(fmt([s])).toContain('—');
  });
});

// ─── Verdict gate is real + failable ─────────────────────────────────

describe('computeVerdict', () => {
  const summaryWith = (recallAll: number | null, total = 10): RunSummary => ({
    adapter: 'gbrain-hybrid', dataset: 's', topK: 5, total, n_rows: total,
    n_abs: 0, n_errors_sut: 0, n_errors_infra: 0,
    recall_all_at_k: recallAll, recall_any_at_k: recallAll, ndcg_any_at_k: recallAll,
    abs_noise_at_k: null, recall_by_type: {}, avg_latency_ms: 1, p50_latency_ms: 1,
    p99_latency_ms: 1, total_seconds: 1,
  });

  test('fails below the gate, passes at/above it', () => {
    expect(computeVerdict([summaryWith(0.2)], 0.75).verdict).toBe('fail');
    expect(computeVerdict([summaryWith(0.9)], 0.75).verdict).toBe('pass');
    expect(computeVerdict([summaryWith(0.75)], 0.75).verdict).toBe('pass');
  });

  test('nothing scored → partial, never a silent pass', () => {
    expect(computeVerdict([], 0.75).verdict).toBe('partial');
    expect(computeVerdict([summaryWith(null, 0)], 0.75).verdict).toBe('partial');
  });

  test('default gate is stricter for embedding-backed runs', () => {
    expect(defaultMinRecallAll(['keyword'])).toBeLessThan(defaultMinRecallAll(['keyword', 'hybrid']));
  });
});

// ─── Cache: input_type keying (longmemeval-06) + resolved key (05) ───

describe('embedding cache', () => {
  test('inputTypeFromParams reads the gateway providerOptions shape', () => {
    expect(inputTypeFromParams({ providerOptions: { openaiCompatible: { input_type: 'query' } } })).toBe('query');
    expect(inputTypeFromParams({ providerOptions: { openaiCompatible: { input_type: 'document' } } })).toBe('document');
    expect(inputTypeFromParams({})).toBe('document'); // symmetric providers omit it
  });

  test('query-side and document-side vectors never alias', async () => {
    const cache = new EmbeddingCache(join(TMP, 'cache.sqlite'), 'test-model@4');
    let realCalls = 0;
    const real = async (params: { values: string[] } & Record<string, unknown>) => {
      realCalls++;
      // Distinct vector per call so cross-side aliasing would be visible.
      return { embeddings: params.values.map(() => [realCalls, 0.5, -1.25, 0]) };
    };
    const transport = makeCachingTransport(real, cache);

    const doc1 = await transport({ values: ['hello'], providerOptions: { openaiCompatible: { input_type: 'document' } } });
    expect(realCalls).toBe(1);
    // Same text, query side: MUST miss (old side-blind key returned the
    // document vector here — the exact bug on asymmetric models).
    const qry = await transport({ values: ['hello'], providerOptions: { openaiCompatible: { input_type: 'query' } } });
    expect(realCalls).toBe(2);
    expect(qry.embeddings[0][0]).toBe(2);
    expect(doc1.embeddings[0][0]).toBe(1);
    // Warm hits on both sides, no further real calls.
    const doc2 = await transport({ values: ['hello'], providerOptions: { openaiCompatible: { input_type: 'document' } } });
    const qry2 = await transport({ values: ['hello'], providerOptions: { openaiCompatible: { input_type: 'query' } } });
    expect(realCalls).toBe(2);
    expect(doc2.embeddings[0]).toEqual([1, 0.5, -1.25, 0]);
    expect(qry2.embeddings[0]).toEqual([2, 0.5, -1.25, 0]);
    // Absent providerOptions keys as 'document' (embed()'s default side).
    const bare = await transport({ values: ['hello'] });
    expect(realCalls).toBe(2);
    expect(bare.embeddings[0][0]).toBe(1);
    cache.close();
  });

  test('cache key derives from the gateway resolved model, not a local fallback', async () => {
    const { configureGateway, getEmbeddingModel, getEmbeddingDimensions } = await import('gbrain/ai/gateway');
    // Configless machine: gbrain's OWN fallback applies. The old hand-rolled
    // 'text-embedding-3-large'/1536 fallback (finding 05) diverged from it
    // and mislabeled cached vectors.
    configureGateway({ env: {} });
    expect(`${getEmbeddingModel()}@${getEmbeddingDimensions()}`).not.toBe('text-embedding-3-large@1536');
    expect(getEmbeddingModel()).toBe('zeroentropyai:zembed-1');
    expect(getEmbeddingDimensions()).toBe(1280);
    // Explicit config resolves verbatim (what run() records in the receipt).
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
    expect(`${getEmbeddingModel()}@${getEmbeddingDimensions()}`).toBe('openai:text-embedding-3-large@1536');
  });
});

// ─── Aggregate: dedupe + inferred params (longmemeval-03/04) ─────────

describe('aggregate', () => {
  test('dedupe prefers a success row over an earlier error row', () => {
    const lines = [
      JSON.stringify({ ...row('q1', [], ['g1']), error: 'question_timeout_90000ms' }),
      JSON.stringify(row('q1', ['g1'], ['g1'])),
      JSON.stringify(row('q2', ['g2'], ['g2'])),
      JSON.stringify({ ...row('q2', [], ['g2']), error: 'later flake' }),
      '{"trunc',
    ].join('\n');
    const { rows, dupes, parseErrors } = dedupeRows(lines);
    expect(rows).toHaveLength(2);
    expect(dupes).toBe(2);
    expect(parseErrors).toBe(1);
    for (const r of rows) expect(r.error).toBeUndefined();
  });

  test('top_k/dataset come from rows; mixed values are an error (finding 04)', () => {
    const r8 = { ...row('q1', ['g1'], ['g1']), top_k: 8, dataset: 's' };
    const r5 = { ...row('q2', ['g2'], ['g2']), top_k: 5, dataset: 's' };
    expect(inferRunParams([r8, { ...row('q2', ['g2'], ['g2']), top_k: 8, dataset: 's' }], { topK: null, dataset: null }))
      .toEqual({ topK: 8, dataset: 's' });
    expect(() => inferRunParams([r8, r5], { topK: null, dataset: null })).toThrow(/mixed top_k/);
    // Legacy rows without top_k: refuse to guess, accept explicit CLI.
    const legacy = row('q1', ['g1'], ['g1']);
    expect(() => inferRunParams([legacy], { topK: null, dataset: 's' })).toThrow(/no top_k/);
    expect(inferRunParams([legacy], { topK: 5, dataset: 's' })).toEqual({ topK: 5, dataset: 's' });
    // CLI contradicting the rows is an error, not a silent relabel.
    expect(() => inferRunParams([r8], { topK: 5, dataset: null })).toThrow(/contradicts/);
  });

  test('aggregateRows reproduces summarizeAdapterRows per adapter', () => {
    const rows = [
      { ...row('q1', ['g1'], ['g1', 'g2']), adapter: 'gbrain-hybrid' },
      { ...row('q2', ['g1', 'g2'], ['g1', 'g2']), adapter: 'gbrain-hybrid' },
      { ...row('q1', ['g1'], ['g1', 'g2']), adapter: 'gbrain-keyword' },
    ];
    const summaries = aggregateRows(rows, 5, 's');
    expect(summaries.map(s => s.adapter)).toEqual(['gbrain-keyword', 'gbrain-hybrid']);
    const hybrid = summaries.find(s => s.adapter === 'gbrain-hybrid')!;
    expect(hybrid.recall_all_at_k).toBeCloseTo(0.5);
    expect(hybrid.recall_any_at_k).toBeCloseTo(1.0);
  });
});

// ─── Chart guards (longmemeval-01/09) ────────────────────────────────

describe('chart', () => {
  const goodSummary: RunSummary = {
    adapter: 'gbrain-hybrid', dataset: 'oracle', topK: 5, total: 42, n_rows: 42,
    n_abs: 0, n_errors_sut: 0, n_errors_infra: 0,
    recall_all_at_k: 0.9, recall_any_at_k: 0.95, ndcg_any_at_k: 0.8,
    abs_noise_at_k: null, recall_by_type: { t1: { total: 42, hit_all: 38, recall_all: 0.9, hit_any: 40, recall_any: 0.95 } },
    avg_latency_ms: 1, p50_latency_ms: 1, p99_latency_ms: 1, total_seconds: 1,
  };

  test('legacy any-hit summaries are rejected, not silently charted', () => {
    const legacy = { opts: { datasetName: 's', topK: 5 }, summaries: [{ ...goodSummary, recall_all_at_k: undefined as unknown as number, recall_at_k: 0.99 }] };
    expect(() => assertChartable(legacy as any, 'x.json')).toThrow(/legacy any-hit/);
    expect(() => assertChartable({ opts: { datasetName: 'oracle', topK: 5 }, summaries: [goodSummary] }, 'x.json')).not.toThrow();
  });

  test('title carries actual dataset + n, never "full 500 questions" (finding 09)', () => {
    const data = { opts: { datasetName: 'oracle', topK: 5 }, summaries: [goodSummary] };
    expect(chartTitle(data)).toBe('recall_all@5 on LongMemEval _oracle — n=42');
    const svg = headlineCard(data);
    expect(svg).toContain('recall_all@5');
    expect(svg).not.toContain('full 500 questions');
    // Differing per-adapter n is flagged instead of misstated.
    expect(nLabel([goodSummary, { ...goodSummary, adapter: 'gbrain-keyword', total: 10 }])).toBe('n varies 10–42 per adapter');
  });
});

// ─── End-to-end: real gbrain pipeline, keyword adapter, offline ──────

function row(qid: string, retrieved: string[], gt: string[]): NdjsonRow {
  const m = scoreQuestion(retrieved, gt, 5);
  return {
    adapter: 'a',
    question_id: qid,
    question_type: qid.includes('multi') ? 'multi-session' : 'single-session-user',
    retrieved,
    ground_truth: gt,
    hit_at_k: m.recall_any === 1,
    ...(isAbsQuestion(qid)
      ? { is_abs: true, abs_noise: m.abs_noise }
      : { recall_all: m.recall_all, recall_any: m.recall_any, ndcg_any: Number.isFinite(m.ndcg_any) ? m.ndcg_any : 0 }),
    num_haystack: 2,
    latency_ms: 5,
  };
}

function makeSession(id: string, text: string) {
  return { session_id: id, turns: [{ role: 'user', content: text }, { role: 'assistant', content: 'noted.' }] };
}

/** Tiny dataset in oracle shape. Every gt session literally contains the question text so keyword FTS must find it. */
function makeDataset(opts: { goldInHaystack: boolean }): Question[] {
  const q1 = 'Where did the zanzibar flamingo expedition land?';
  const q2 = 'Which harbor hosted the quokka wombat badge ceremony?';
  return [
    {
      question_id: 'e2e_q1',
      question_type: 'single-session-user',
      question: q1,
      answer: 'Port Kelp',
      haystack_sessions: [
        makeSession(opts.goldInHaystack ? 'sess-gold-1' : 'sess-decoy-1', `${q1} It landed at Port Kelp after a long voyage.`),
        makeSession('sess-noise-1', 'Completely unrelated grocery list: milk, eggs, bread.'),
      ] as any,
      answer_session_ids: ['sess-gold-1'],
    },
    {
      question_id: 'e2e_q2_multi',
      question_type: 'multi-session',
      question: q2,
      answer: 'Osprey Harbor',
      haystack_sessions: [
        makeSession(opts.goldInHaystack ? 'sess-Gold-2A' : 'sess-decoy-2a', `${q2} The first half happened at Osprey Harbor.`),
        makeSession(opts.goldInHaystack ? 'sess-gold-2b' : 'sess-decoy-2b', `${q2} The second half also happened at Osprey Harbor.`),
        makeSession('sess-noise-2', 'Another unrelated note about bicycle repair.'),
      ] as any,
      answer_session_ids: ['sess-Gold-2A', 'sess-gold-2b'],
    },
    {
      question_id: 'e2e_q3_abs',
      question_type: 'single-session-user',
      question: 'What did I say about the imaginary kraken regatta?',
      answer: 'N/A (abstention)',
      haystack_sessions: [
        makeSession('sess-noise-3', 'Notes about a pottery class schedule.'),
      ] as any,
      answer_session_ids: ['sess-removed-evidence'],
    },
  ];
}

function e2eOpts(dir: string, datasetPath: string, overrides: Partial<Opts> = {}): Opts {
  return {
    ...parseOpts([]),
    datasetPath,
    datasetName: 'e2emini',
    adapters: ['keyword'],
    keywordOnly: true,
    topK: 5,
    noCache: true,
    minRecallAll: 0.6,
    output: join(dir, 'report.json'),
    ndjsonPath: join(dir, 'rows.ndjson'),
    reportsDir: join(dir, 'reports'),
    ...overrides,
  };
}

describe('end-to-end (keyword adapter, hermetic)', () => {
  test('good corpus: recall_all counted right, _abs excluded, receipt pass', async () => {
    const dir = mkdtempSync(join(TMP, 'e2e-pass-'));
    const datasetPath = join(dir, 'dataset.json');
    writeFileSync(datasetPath, JSON.stringify(makeDataset({ goldInHaystack: true })));

    const result = await run(e2eOpts(dir, datasetPath));
    expect(result.exitCode).toBe(0);

    const receipt = loadReceipt(result.receiptFile);
    expect(receipt.run_status).toBe('completed');
    expect(receipt.verdict).toBe('pass');
    expect(receipt.n_total).toBe(3);
    expect(receipt.n_scored).toBe(3);
    // WS5: pins recorded in the receipt (finding 12).
    expect(receipt.resolved_config?.['search.reranker.enabled']).toBe('false');
    expect(receipt.resolved_config?.['search.mode']).toBe(PINNED_SEARCH_CONFIG['search.mode']);
    expect(receipt.resolved_config?.['search.autocut']).toBe('false');

    const s = result.summaries[0];
    expect(s.adapter).toBe('gbrain-keyword');
    expect(s.total).toBe(2);              // _abs excluded from recall denominator
    expect(s.n_abs).toBe(1);
    expect(s.recall_all_at_k).toBe(1);    // both gt sessions of the multi question found
    expect(s.abs_noise_at_k).toBe(0);     // nothing "found" for the unanswerable question

    // NDJSON rows carry top_k + dataset (finding 04) and round-trip through
    // the aggregate to the same headline number.
    const ndRows = dedupeRows(readFileSync(join(dir, 'rows.ndjson'), 'utf8')).rows;
    expect(ndRows).toHaveLength(3);
    for (const r of ndRows) {
      expect(r.top_k).toBe(5);
      expect(r.dataset).toBe('e2emini');
    }
    const { topK, dataset } = inferRunParams(ndRows, { topK: null, dataset: null });
    const agg = aggregateRows(ndRows, topK, dataset);
    expect(agg[0].recall_all_at_k).toBe(1);

    // Report JSON is chartable with honest labels.
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
    expect(() => assertChartable({ opts: { datasetName: report.opts.datasetName, topK: report.opts.topK }, summaries: report.summaries }, 'report.json')).not.toThrow();
    expect(report.resolved.pinned_search_config['search.reranker.enabled']).toBe('false');
  }, 180_000);

  test('gate is failable end-to-end: gold absent from haystack → verdict fail, exit 1', async () => {
    const dir = mkdtempSync(join(TMP, 'e2e-fail-'));
    const datasetPath = join(dir, 'dataset.json');
    writeFileSync(datasetPath, JSON.stringify(makeDataset({ goldInHaystack: false })));

    const result = await run(e2eOpts(dir, datasetPath));
    expect(result.exitCode).toBe(1);
    const receipt = loadReceipt(result.receiptFile);
    expect(receipt.run_status).toBe('completed');
    expect(receipt.verdict).toBe('fail');
    expect(result.summaries[0].recall_all_at_k).toBe(0);
  }, 180_000);

  test('resume-complete invocation: no NaN, no crash, partial verdict, exit 0 (finding 07)', async () => {
    const dir = mkdtempSync(join(TMP, 'e2e-resume-'));
    const datasetPath = join(dir, 'dataset.json');
    writeFileSync(datasetPath, JSON.stringify(makeDataset({ goldInHaystack: true })));

    const first = await run(e2eOpts(dir, datasetPath));
    expect(first.exitCode).toBe(0);
    // Second invocation on the same NDJSON: everything already complete.
    const second = await run(e2eOpts(dir, datasetPath, { output: join(dir, 'report2.json') }));
    expect(second.exitCode).toBe(0);
    expect(second.summaries).toHaveLength(0);
    const receipt = loadReceipt(second.receiptFile);
    expect(receipt.run_status).toBe('completed');
    expect(receipt.verdict).toBe('partial');
    expect(receipt.n_total).toBe(0);
    // Old code crashed before writing markdown; now the report + md exist.
    expect(existsSync(join(dir, 'report2.json'))).toBe(true);
    expect(readFileSync(join(dir, 'report2.md'), 'utf8')).toContain('No adapter processed any question');
  }, 180_000);

  test('hybrid adapter runs the pinned pipeline with a stubbed embed transport', async () => {
    // Full gbrain pipeline (import + chunk embed + hybridSearch RRF) with a
    // deterministic token-hash embedding via gbrain's test seam. Proves the
    // WS5 pins (search.mode/reranker/autocut via engine.setConfig) hold on
    // the embedding path and that resolved model/dims land in the receipt —
    // without any provider key or network call.
    const { __setEmbedTransportForTests, getEmbeddingDimensions } = await import('gbrain/ai/gateway');
    const hadOpenai = process.env.OPENAI_API_KEY;
    const hadZe = process.env.ZEROENTROPY_API_KEY;
    process.env.OPENAI_API_KEY = 'dummy-stub-key';
    // A ZE key present must NOT re-enable the reranker — the pin turns it off.
    process.env.ZEROENTROPY_API_KEY = 'dummy-ze-key';
    const hashVec = (text: string, dim: number): number[] => {
      const v = new Array<number>(dim).fill(0);
      for (const tok of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
        let h = 0x811c9dc5;
        for (let i = 0; i < tok.length; i++) {
          h ^= tok.charCodeAt(i);
          h = Math.imul(h, 0x01000193) >>> 0;
        }
        v[h % dim] += ((h >>> 8) & 1) ? 1 : -1;
      }
      let norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
      if (norm === 0) { v[0] = 1; norm = 1; }
      return v.map(x => x / norm);
    };
    __setEmbedTransportForTests((async (params: { values: string[] }) => ({
      embeddings: params.values.map(t => hashVec(t, getEmbeddingDimensions())),
      values: params.values,
      warnings: [],
    })) as unknown as Parameters<typeof __setEmbedTransportForTests>[0]);

    try {
      const dir = mkdtempSync(join(TMP, 'e2e-hybrid-'));
      const datasetPath = join(dir, 'dataset.json');
      writeFileSync(datasetPath, JSON.stringify(makeDataset({ goldInHaystack: true })));
      // noCache: true keeps the stub transport installed (the caching wrapper
      // would replace it with a real-aiSdk fallthrough).
      const result = await run(e2eOpts(dir, datasetPath, {
        adapters: ['hybrid'],
        keywordOnly: false,
        embeddingModel: 'openai:text-embedding-3-large',
        embeddingDimensions: 64,
      }));
      expect(result.exitCode).toBe(0);
      const receipt = loadReceipt(result.receiptFile);
      expect(receipt.verdict).toBe('pass');
      expect(receipt.resolved_config?.embedding_model).toBe('openai:text-embedding-3-large');
      expect(receipt.resolved_config?.embedding_dimensions).toBe(64);
      expect(receipt.resolved_config?.['search.reranker.enabled']).toBe('false');
      const s = result.summaries[0];
      expect(s.adapter).toBe('gbrain-hybrid');
      expect(s.total).toBe(2);
      expect(s.recall_all_at_k).toBe(1);
    } finally {
      __setEmbedTransportForTests(null);
      if (hadOpenai === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = hadOpenai;
      if (hadZe === undefined) delete process.env.ZEROENTROPY_API_KEY;
      else process.env.ZEROENTROPY_API_KEY = hadZe;
    }
  }, 180_000);

  test('errored rows in the NDJSON are re-run on the next invocation (finding 03)', async () => {
    const dir = mkdtempSync(join(TMP, 'e2e-requeue-'));
    const datasetPath = join(dir, 'dataset.json');
    writeFileSync(datasetPath, JSON.stringify(makeDataset({ goldInHaystack: true })));
    const nd = join(dir, 'rows.ndjson');
    // Pre-seed a transient failure for q1, as if a prior invocation died.
    appendFileSync(nd, JSON.stringify({
      adapter: 'gbrain-keyword', question_id: 'e2e_q1', question_type: 'single-session-user',
      retrieved: [], ground_truth: ['sess-gold-1'], hit_at_k: false, num_haystack: 0,
      latency_ms: 90000, top_k: 5, dataset: 'e2emini',
      error: 'question_timeout_90000ms', error_origin: 'harness',
    }) + '\n');

    const result = await run(e2eOpts(dir, datasetPath));
    expect(result.exitCode).toBe(0);
    // q1 was re-run (a clean row now exists) — the aggregate's dedupe picks
    // the success, so the transient error never becomes a permanent miss.
    const { rows } = dedupeRows(readFileSync(nd, 'utf8'));
    const q1 = rows.find(r => r.question_id === 'e2e_q1')!;
    expect(q1.error).toBeUndefined();
    expect(q1.recall_all).toBe(1);
    const agg = aggregateRows(rows, 5, 'e2emini');
    expect(agg[0].recall_all_at_k).toBe(1);
    expect(agg[0].n_errors_infra).toBe(0);
  }, 180_000);
});

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
  normalizeIds,
  sessdivRetrieve,
  pinSearchConfig,
  resolvedSearchConfig,
  rerankPreflight,
  buildRunConfigPreimage,
  canonicalJson,
  runConfigHash,
  PINNED_SEARCH_CONFIG,
  ADAPTER_SPECS,
  type AdapterSpec,
  type NdjsonRow,
  type Question,
  type RunSummary,
  type Opts,
} from '../../eval/runner/longmemeval.ts';
import { dedupeRows, inferRunParams, aggregateRows, findMixedRunConfigHashes } from '../../eval/runner/longmemeval-aggregate.ts';
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

// ─── Adapter specs + sessdiv retrieval (PR B methodology) ────────────

describe('ADAPTER_SPECS', () => {
  test('legacy keys unchanged; new keys compose the toggles', () => {
    expect(ADAPTER_SPECS.keyword).toEqual({ name: 'gbrain-keyword', base: 'keyword', expansion: false, sessdiv: false, rerank: false });
    expect(ADAPTER_SPECS.vector).toEqual({ name: 'gbrain-vector', base: 'vector', expansion: false, sessdiv: false, rerank: false });
    expect(ADAPTER_SPECS.hybrid).toEqual({ name: 'gbrain-hybrid', base: 'hybrid', expansion: false, sessdiv: false, rerank: false });
    expect(ADAPTER_SPECS['hybrid+expansion']).toEqual({ name: 'gbrain-hybrid+expansion', base: 'hybrid', expansion: true, sessdiv: false, rerank: false });
    expect(ADAPTER_SPECS['hybrid-sessdiv']).toEqual({ name: 'gbrain-hybrid-sessdiv', base: 'hybrid', expansion: false, sessdiv: true, rerank: false });
    expect(ADAPTER_SPECS['hybrid+expansion-sessdiv']).toEqual({ name: 'gbrain-hybrid+expansion-sessdiv', base: 'hybrid', expansion: true, sessdiv: true, rerank: false });
    expect(ADAPTER_SPECS['hybrid+rerank']).toEqual({ name: 'gbrain-hybrid+rerank', base: 'hybrid', expansion: false, sessdiv: false, rerank: true });
    expect(ADAPTER_SPECS['hybrid-sessdiv+rerank']).toEqual({ name: 'gbrain-hybrid-sessdiv+rerank', base: 'hybrid', expansion: false, sessdiv: true, rerank: true });
  });
});

describe('sessdivRetrieve', () => {
  // sessdivRetrieve reads only .slug and .length; a slug-only stub is the
  // whole contract.
  const chunks = (slugs: string[]) => slugs.map(slug => ({ slug })) as unknown as Parameters<typeof sessdivRetrieve>[0];

  test('8 chunks / 6 sessions → the 5 highest-ranked DISTINCT sessions', () => {
    // One descending ranked list: the first occurrence of a session id is
    // its best chunk (the vector-grep-rrf-fusion.ts:169-183 equivalence).
    const results = chunks([
      'chat/s1', 'chat/s2', 'chat/s1', 'chat/s3', 'chat/s4', 'chat/s5', 'chat/s2', 'chat/s6',
    ]);
    const out = sessdivRetrieve(results, 5);
    expect(out.retrieved).toEqual(['s1', 's2', 's3', 's4', 's5']); // s6 ranked below the 5 best
    expect(out.candidates_total).toBe(8);
    expect(out.distinct_before_slice).toBe(6);
  });

  test('empty searchResults → retrieved=[] and the question scores 0', () => {
    const out = sessdivRetrieve(chunks([]), 5);
    expect(out.retrieved).toEqual([]);
    expect(out.candidates_total).toBe(0);
    expect(out.distinct_before_slice).toBe(0);
    const m = scoreQuestion(out.retrieved, ['g1'], 5);
    expect(m.recall_all).toBe(0);
    expect(m.recall_any).toBe(0);
  });

  test('supply below topK: returns what exists; shortfall visible in distinct_before_slice', () => {
    const out = sessdivRetrieve(chunks(['chat/a', 'chat/b', 'chat/a']), 5);
    expect(out.retrieved).toEqual(['a', 'b']);
    expect(out.distinct_before_slice).toBe(2);
  });
});

// ─── Session-diversity diagnostics (amendment 6) ─────────────────────

describe('session-diversity diagnostics', () => {
  test('mean_distinct_sessions + session_shortfall_rate across row generations', () => {
    const rows: NdjsonRow[] = [
      // Legacy row (no sessdiv fields): 3 distinct after normalizeIds ('S1'≡'s1').
      { adapter: 'a', question_id: 'q1', question_type: 't1', retrieved: ['S1', 's1', 's2', 's3'], ground_truth: ['s1'], hit_at_k: true, num_haystack: 5, latency_ms: 1 },
      // Sessdiv row sliced to 5 distinct, pre-slice supply 6 → NO shortfall.
      { ...row('q2', ['a', 'b', 'c', 'd', 'e'], ['a']), question_type: 't1', candidates_total: 15, distinct_before_slice: 6, overfetch_factor: 3 },
      // Sessdiv row whose pre-slice supply 4 < 5 → shortfall (supply, not slice).
      { ...row('q3', ['a', 'b', 'c', 'd'], ['a']), question_type: 't2', candidates_total: 15, distinct_before_slice: 4, overfetch_factor: 3 },
      // sut-error row: retrieved=[] → 0 distinct, shortfall, stays in denominator.
      { ...row('q4', [], ['g']), question_type: 't2', error: 'Page not found', error_origin: 'sut' },
      // infra-error row: excluded from the diagnostics denominator entirely.
      { ...row('q5', [], ['g']), error: 'question_timeout_90000ms', error_origin: 'harness' },
      // _abs row: excluded from recall AND diversity denominators.
      row('q6_abs', ['x'], ['e1']),
    ];
    const s = summarizeAdapterRows('a', rows, 5, 'test');
    expect(s.mean_distinct_sessions).toBeCloseTo((3 + 5 + 4 + 0) / 4);
    // q1 supply 3 <5, q2 supply 6 ok, q3 supply 4 <5, q4 supply 0 <5 → 3/4.
    expect(s.session_shortfall_rate).toBeCloseTo(3 / 4);
    expect(s.recall_by_type['t1'].mean_distinct_sessions).toBeCloseTo((3 + 5) / 2);
    expect(s.recall_by_type['t1'].session_shortfall_rate).toBeCloseTo(1 / 2);
    expect(s.recall_by_type['t2'].mean_distinct_sessions).toBeCloseTo((4 + 0) / 2);
    expect(s.recall_by_type['t2'].session_shortfall_rate).toBeCloseTo(1);
  });

  test('diversity uses the SAME normalization as scoring (shared normalizeIds, eng E2)', () => {
    expect(normalizeIds(['S1', 's1', 'S2'])).toEqual(['s1', 's2']);
  });

  test('zero rows → null diagnostics; fmt renders the div@k + shortfall columns', () => {
    const empty = summarizeAdapterRows('a', [], 5, 'test');
    expect(empty.mean_distinct_sessions).toBeNull();
    expect(empty.session_shortfall_rate).toBeNull();
    expect(() => fmt([empty])).not.toThrow();
    const s = summarizeAdapterRows('a', [row('q1', ['g1', 'x'], ['g1'])], 5, 'test');
    const md = fmt([s]);
    expect(md).toContain('div@k');
    expect(md).toContain('shortfall');
    expect(md).toContain('2.00'); // 2 distinct sessions retrieved
    expect(md).toContain('100.00%'); // shortfall: 2 < 5 on every scored row
  });
});

// ─── Opts: sessdiv over-fetch factor ─────────────────────────────────

describe('parseOpts overfetch-factor', () => {
  test('defaults to 3; --overfetch-factor overrides', () => {
    expect(parseOpts([]).overfetchFactor).toBe(3);
    expect(parseOpts(['--overfetch-factor', '5']).overfetchFactor).toBe(5);
  });
});

// ─── Search-config pinning per adapter spec ──────────────────────────

describe('pinSearchConfig / resolvedSearchConfig', () => {
  test('rerank specs overlay reranker.enabled=true; everything else keeps the pin', async () => {
    expect(resolvedSearchConfig(ADAPTER_SPECS['hybrid+rerank'])['search.reranker.enabled']).toBe('true');
    expect(resolvedSearchConfig(ADAPTER_SPECS.hybrid)['search.reranker.enabled']).toBe('false');
    expect(resolvedSearchConfig(ADAPTER_SPECS['hybrid-sessdiv'])['search.reranker.enabled']).toBe('false');
    expect(resolvedSearchConfig()['search.reranker.enabled']).toBe('false');
    // The overlay never mutates the frozen base pin.
    expect(PINNED_SEARCH_CONFIG['search.reranker.enabled']).toBe('false');

    const setConfigCalls = async (spec?: AdapterSpec) => {
      const seen: Record<string, string> = {};
      const stub = { setConfig: async (k: string, v: string) => { seen[k] = v; } } as unknown as Parameters<typeof pinSearchConfig>[0];
      await pinSearchConfig(stub, spec);
      return seen;
    };
    const rerank = await setConfigCalls(ADAPTER_SPECS['hybrid-sessdiv+rerank']);
    expect(rerank['search.reranker.enabled']).toBe('true');
    expect(rerank['search.mode']).toBe('balanced');
    expect(rerank['search.autocut']).toBe('false');
    const plain = await setConfigCalls(ADAPTER_SPECS['hybrid-sessdiv']);
    expect(plain['search.reranker.enabled']).toBe('false');
  });
});

// ─── Rerank preflight (fail-closed, amendment 7) ─────────────────────

describe('rerankPreflight', () => {
  test('no provider key → keyPresent false via the pinned Voyage model (gbrain ≥ 0.48.2.0 default)', () => {
    const missing = rerankPreflight({});
    expect(missing.model).toBe('voyage:rerank-2.5');
    expect(missing.provider).toBe('voyage');
    expect(missing.envKey).toBe('VOYAGE_API_KEY');
    expect(missing.keyPresent).toBe(false);
    expect(rerankPreflight({ VOYAGE_API_KEY: 'pa-k' }).keyPresent).toBe(true);
    // A ZeroEntropy key alone no longer satisfies the pinned model.
    expect(rerankPreflight({ ZEROENTROPY_API_KEY: 'k' }).keyPresent).toBe(false);
  });

  test('rerank contract violation is typed sut (scored 0, stays in denominator)', () => {
    expect(classifyErrorOrigin("rerank_missing_score: search.reranker.enabled pinned 'true' but no rerank_score")).toBe('sut');
  });
});

// ─── run_config_hash (amendment 5) ───────────────────────────────────

describe('run_config_hash', () => {
  test('canonicalJson sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, 1] } })).toBe('{"a":{"c":[2,1]},"b":1}');
  });

  test('preimage reflects the adapter config; hash is deterministic', () => {
    const optsLike = { datasetName: 's', topK: 5, overfetchFactor: 3 };
    const resolved = { embeddingModel: 'openai:m', embeddingDims: 64, expansionModel: 'anthropic:haiku' };
    const hybrid = buildRunConfigPreimage(ADAPTER_SPECS.hybrid, optsLike, resolved);
    const sessdiv = buildRunConfigPreimage(ADAPTER_SPECS['hybrid-sessdiv'], optsLike, resolved);
    const rerank = buildRunConfigPreimage(ADAPTER_SPECS['hybrid+rerank'], optsLike, resolved);
    const keyword = buildRunConfigPreimage(ADAPTER_SPECS.keyword, optsLike, resolved);
    expect(hybrid.overfetch_factor).toBeUndefined();      // non-sessdiv: factor not in the preimage
    expect(sessdiv.overfetch_factor).toBe(3);
    expect(rerank.search_config['search.reranker.enabled']).toBe('true');
    expect(keyword.embedding_model).toBeUndefined();      // keyword ingests with noEmbed
    expect(hybrid.embedding_model).toBe('openai:m');
    expect(hybrid.expansion_model).toBeUndefined();       // expansion_model only for expansion specs
    expect(buildRunConfigPreimage(ADAPTER_SPECS['hybrid+expansion'], optsLike, resolved).expansion_model).toBe('anthropic:haiku');
    expect(runConfigHash(hybrid)).toBe(runConfigHash(buildRunConfigPreimage(ADAPTER_SPECS.hybrid, optsLike, resolved)));
    expect(runConfigHash(hybrid)).not.toBe(runConfigHash(sessdiv));
    expect(runConfigHash(hybrid)).not.toBe(runConfigHash(rerank));
    expect(runConfigHash(hybrid)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('aggregator run_config_hash guard', () => {
  test('legacy all-absent consistent; mixed hashes or hash+absent rejected per adapter', () => {
    const legacy = [row('q1', ['g1'], ['g1']), row('q2', ['g2'], ['g2'])];
    expect(findMixedRunConfigHashes(legacy)).toEqual([]);
    const consistent = [
      { ...row('q1', ['g1'], ['g1']), run_config_hash: 'h1' },
      { ...row('q2', ['g2'], ['g2']), run_config_hash: 'h1' },
    ];
    expect(findMixedRunConfigHashes(consistent)).toEqual([]);
    const mixed = [
      { ...row('q1', ['g1'], ['g1']), run_config_hash: 'h1' },
      { ...row('q2', ['g2'], ['g2']), run_config_hash: 'h2' },
    ];
    const findings = findMixedRunConfigHashes(mixed);
    expect(findings).toHaveLength(1);
    expect(findings[0].adapter).toBe('a');
    expect(findings[0].hashes).toEqual(['h1', 'h2']);
    // hash + hash-less within one adapter = two writer generations → mixed.
    const partial = [
      { ...row('q1', ['g1'], ['g1']), run_config_hash: 'h1' },
      row('q2', ['g2'], ['g2']),
    ];
    expect(findMixedRunConfigHashes(partial)).toHaveLength(1);
    expect(findMixedRunConfigHashes(partial)[0].n_without_hash).toBe(1);
    // Different hashes across DIFFERENT adapters is fine — per-adapter guard.
    const crossAdapter = [
      { ...row('q1', ['g1'], ['g1']), adapter: 'a1', run_config_hash: 'h1' },
      { ...row('q1', ['g1'], ['g1']), adapter: 'a2', run_config_hash: 'h2' },
    ];
    expect(findMixedRunConfigHashes(crossAdapter)).toEqual([]);
  });

  test('CLI: mixed hashes exit non-zero; --allow-mixed prints the banner and proceeds', () => {
    const p = join(TMP, 'mixed.ndjson');
    writeFileSync(p, [
      JSON.stringify({ ...row('q1', ['g1'], ['g1']), top_k: 5, dataset: 's', run_config_hash: 'h1' }),
      JSON.stringify({ ...row('q2', ['g2'], ['g2']), top_k: 5, dataset: 's', run_config_hash: 'h2' }),
    ].join('\n'));
    const script = join(import.meta.dir, '../../eval/runner/longmemeval-aggregate.ts');
    const rejected = Bun.spawnSync(['bun', script, p, '--output', join(TMP, 'mixed-out.json')], { cwd: TMP });
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr.toString()).toContain('MIXED run_config_hash');
    const allowed = Bun.spawnSync(['bun', script, p, '--output', join(TMP, 'mixed-out2.json'), '--allow-mixed'], { cwd: TMP });
    expect(allowed.exitCode).toBe(0);
    expect(allowed.stderr.toString()).toContain('--allow-mixed');
    expect(existsSync(join(TMP, 'mixed-out2.json'))).toBe(true);
  }, 30_000);
});

// ─── Verdict gate is real + failable ─────────────────────────────────

describe('computeVerdict', () => {
  const summaryWith = (recallAll: number | null, total = 10): RunSummary => ({
    adapter: 'gbrain-hybrid', dataset: 's', topK: 5, total, n_rows: total,
    n_abs: 0, n_errors_sut: 0, n_errors_infra: 0,
    recall_all_at_k: recallAll, recall_any_at_k: recallAll, ndcg_any_at_k: recallAll,
    abs_noise_at_k: null, mean_distinct_sessions: null, session_shortfall_rate: null,
    recall_by_type: {}, avg_latency_ms: 1, p50_latency_ms: 1,
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
    abs_noise_at_k: null, mean_distinct_sessions: 3.2, session_shortfall_rate: 0.4,
    recall_by_type: { t1: { total: 42, hit_all: 38, recall_all: 0.9, hit_any: 40, recall_any: 0.95, mean_distinct_sessions: 3.2, session_shortfall_rate: 0.4 } },
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
    // WS5: pins recorded PER ADAPTER in the receipt (finding 12 + eng E1).
    const cfgByAdapter = receipt.resolved_config?.search_config_by_adapter as Record<string, Record<string, string>>;
    expect(cfgByAdapter['gbrain-keyword']['search.reranker.enabled']).toBe('false');
    expect(cfgByAdapter['gbrain-keyword']['search.mode']).toBe(PINNED_SEARCH_CONFIG['search.mode']);
    expect(cfgByAdapter['gbrain-keyword']['search.autocut']).toBe('false');

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
    expect(report.resolved.search_config_by_adapter['gbrain-keyword']['search.reranker.enabled']).toBe('false');
    // run_config provenance: every row hashes to the adapter's recorded
    // preimage, and the preimage is stored in the report's resolved block.
    const preimage = report.resolved.run_config_preimages['gbrain-keyword'];
    expect(preimage.adapter).toBe('gbrain-keyword');
    expect(preimage.search_config['search.reranker.enabled']).toBe('false');
    for (const r of ndRows) expect(r.run_config_hash).toBe(runConfigHash(preimage));
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
    const hadVoyage = process.env.VOYAGE_API_KEY;
    process.env.OPENAI_API_KEY = 'dummy-stub-key';
    // A reranker key present (ZE historically, Voyage since gbrain 0.48.2.0)
    // must NOT re-enable the reranker — the pin turns it off.
    process.env.ZEROENTROPY_API_KEY = 'dummy-ze-key';
    process.env.VOYAGE_API_KEY = 'dummy-voyage-key';
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
      const hybridCfg = (receipt.resolved_config?.search_config_by_adapter as Record<string, Record<string, string>>)['gbrain-hybrid'];
      expect(hybridCfg['search.reranker.enabled']).toBe('false');
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
      if (hadVoyage === undefined) delete process.env.VOYAGE_API_KEY;
      else process.env.VOYAGE_API_KEY = hadVoyage;
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

  test('sessdiv adapter end-to-end: over-fetch + per-row diagnostics with the stubbed embed transport', async () => {
    const { __setEmbedTransportForTests, getEmbeddingDimensions } = await import('gbrain/ai/gateway');
    const hadOpenai = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'dummy-stub-key';
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
      const dir = mkdtempSync(join(TMP, 'e2e-sessdiv-'));
      const datasetPath = join(dir, 'dataset.json');
      writeFileSync(datasetPath, JSON.stringify(makeDataset({ goldInHaystack: true })));
      const result = await run(e2eOpts(dir, datasetPath, {
        adapters: ['hybrid-sessdiv'],
        keywordOnly: false,
        embeddingModel: 'openai:text-embedding-3-large',
        embeddingDimensions: 64,
      }));
      expect(result.exitCode).toBe(0);
      const s = result.summaries[0];
      expect(s.adapter).toBe('gbrain-hybrid-sessdiv');
      expect(s.recall_all_at_k).toBe(1);
      // Corpus has ≤3 sessions per question < topK 5 → every row shortfalls.
      expect(s.session_shortfall_rate).toBe(1);
      expect(s.mean_distinct_sessions).toBeGreaterThan(0);
      const rows = dedupeRows(readFileSync(join(dir, 'rows.ndjson'), 'utf8')).rows;
      for (const r of rows) {
        expect(r.overfetch_factor).toBe(3);
        expect(typeof r.candidates_total).toBe('number');
        expect(typeof r.distinct_before_slice).toBe('number');
        expect(r.candidates_total!).toBeGreaterThanOrEqual(r.distinct_before_slice!);
        expect(r.retrieved.length).toBeLessThanOrEqual(5);
        expect(typeof r.run_config_hash).toBe('string');
      }
      // One configuration → one hash: the aggregator guard stays quiet.
      expect(findMixedRunConfigHashes(rows)).toEqual([]);
    } finally {
      __setEmbedTransportForTests(null);
      if (hadOpenai === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = hadOpenai;
    }
  }, 180_000);

  test('rerank adapter without provider key: fail-closed skip, exit 0, zero rows (amendment 7)', async () => {
    const dir = mkdtempSync(join(TMP, 'e2e-rerank-skip-'));
    const datasetPath = join(dir, 'dataset.json');
    writeFileSync(datasetPath, JSON.stringify(makeDataset({ goldInHaystack: true })));
    const hadZe = process.env.VOYAGE_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    try {
      const result = await run(e2eOpts(dir, datasetPath, { adapters: ['hybrid+rerank'], keywordOnly: false }));
      // Skip-only run: fail-closed skip is the designed response, exit 0.
      expect(result.exitCode).toBe(0);
      expect(result.summaries).toHaveLength(0);
      const receipt = loadReceipt(result.receiptFile);
      expect(receipt.run_status).toBe('skipped');
      expect(receipt.skip_reason).toContain('VOYAGE_API_KEY');
      expect(receipt.publishable).toBe(false);
      const skipped = receipt.resolved_config?.adapters_skipped as Array<{ adapter: string; skip_reason: string }>;
      expect(skipped).toHaveLength(1);
      expect(skipped[0].adapter).toBe('gbrain-hybrid+rerank');
      expect(skipped[0].skip_reason).toContain('rerank preflight failed');
      expect(receipt.resolved_config?.rerank_adapters_pending_acceptance).toEqual(['gbrain-hybrid+rerank']);
      // The receipt still records the config the adapter WOULD have pinned.
      const cfg = (receipt.resolved_config?.search_config_by_adapter as Record<string, Record<string, string>>)['gbrain-hybrid+rerank'];
      expect(cfg['search.reranker.enabled']).toBe('true');
      // do NOT emit rows: preflight fires before question 1.
      expect(existsSync(join(dir, 'rows.ndjson'))).toBe(false);
    } finally {
      if (hadZe !== undefined) process.env.VOYAGE_API_KEY = hadZe;
      else delete process.env.VOYAGE_API_KEY;
    }
  }, 60_000);
});

/**
 * BrainBench Cat 13b — Source Swamp Resistance
 *
 * Tests whether a curated `originals/` page wins ranking against multiple
 * competing `openclaw/chat/` pages that contain the same multi-word phrase.
 *
 * Where Cat 13 (Conceptual Recall) measures vector retrieval on paraphrase
 * and synonym, Cat 13b measures gbrain's source-aware ranking signal: a
 * corpus-level prior that says "curated directories like originals/ should
 * outrank bulk dumps like openclaw/chat/ for non-temporal queries"
 * (DEFAULT_SOURCE_BOOSTS in gbrain src/core/search/source-boost.ts, applied
 * by buildSourceFactorCase in the engines' search SQL).
 *
 * AUDIT REMEDIATIONS baked into this runner:
 *   - retrieval-cats-07: the corpus swamp prefix is `openclaw/chat/` — the
 *     prefix the CURRENT gbrain boost map actually demotes (0.5x). The old
 *     `wintermute/chat/` key was renamed in gbrain v0.24.0 and the demotion
 *     path went silently dead. `assertBoostPremise()` now fails the run
 *     loudly if the swamp prefix ever stops resolving to a < 1.0 factor.
 *   - retrieval-cats-09: the pass criterion (gbrain top1 >= 80%) drives the
 *     process exit code AND the receipt verdict, and the full per-query
 *     results land as JSON in eval/reports/cat13b-source-swamp/.
 *   - retrieval-cats-16: a `gbrain-no-source-boost` ablation arm runs the
 *     SAME hybrid pipeline with the boost map neutralized to 1.0 (via
 *     GBRAIN_SOURCE_BOOST, the only override gbrain exposes — there is no
 *     engine.setConfig key for source-boost as of v0.47.6.0; resolveBoostMap
 *     reads the env var at query-build time). The paired delta
 *     gbrain-minus-ablation is the headline source-boost effect. If the two
 *     arms produce identical rankings on every query, the ablation plumbing
 *     is broken and the run is declared invalid.
 *
 * Corpus: eval/data/source-swamp-v1 (10 short curated + 10 long swamp pages).
 *
 * Qrels: 30 hand-curated queries. Each query is a multi-word phrase that
 *        appears in BOTH the curated target page AND >=1 chat page (chat
 *        pages typically have higher per-byte keyword density). The strict
 *        target is the curated `originals/` page.
 *
 * Metrics:
 *   - **top1_hit_rate** (primary): fraction of queries where the
 *     `originals/` target ranks #1.
 *   - **top3_hit_rate**: fraction where the target is in top-3.
 *   - **swamp_at_top**: fraction where >=1 chat page ranks above the
 *     curated target. The bad-state metric — should be near zero with
 *     source-boost on.
 *
 * Pass criterion (gbrain adapter): top1_hit_rate >= 80%. Enforced: verdict
 * 'fail' + exit 1 below the bar. Stub-embed runs that clear the bar report
 * verdict 'partial' (hermetic plumbing check, not the published claim).
 *
 * Run:
 *   bun eval/runner/cat13b-source-swamp.ts                 # live embeds (OPENAI_API_KEY)
 *   bun eval/runner/cat13b-source-swamp.ts --stub-embed    # hermetic, no keys
 *   bun eval/runner/cat13b-source-swamp.ts --adapter gbrain
 */

import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { configureGateway, __setEmbedTransportForTests } from 'gbrain/ai/gateway';
import { resolveBoostMap } from '../../node_modules/gbrain/src/core/search/source-boost.ts';
import type { Adapter, AdapterConfig, BrainState, Page, PublicQuery, Query, RankedDoc } from './types.ts';
import { sanitizePage, sanitizeQuery } from './types.ts';
import { rankOfFirstHit } from './metrics.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import {
  writeReceipt, receiptPath, RECEIPT_SCHEMA_VERSION, BENCHMARK_VERSION,
  type Receipt, type ReceiptVerdict,
} from './receipt.ts';
import { gbrainVersion, gbrainPin } from './gbrain-version.ts';
import { RipgrepBm25Adapter } from './adapters/grep-only.ts';
import { VectorOnlyAdapter } from './adapters/vector.ts';
import { HybridNoGraphAdapter } from './adapters/vector-grep-rrf-fusion.ts';
import { GbrainInlineAdapter } from './adapters/gbrain-inline.ts';

export const TOP_K = 5;
export const PASS_TOP1 = 0.80;
export const CURATED_PREFIX = 'originals/';
export const SWAMP_PREFIX = 'openclaw/chat/';
const CATEGORY = 'cat13b-source-swamp';

// ─── Boost-map premise (audit retrieval-cats-07) ───────────────────
//
// gbrain renamed the swamp key once already (wintermute/chat/ →
// openclaw/chat/, v0.24.0) and this eval silently tested nothing for
// months. Resolve the factors THE WAY THE ENGINE DOES (longest-prefix
// match over resolveBoostMap()) and refuse to run when the corpus
// prefixes no longer land in the demote/boost tiers they exist to test.

export class BoostPremiseError extends Error {}

export function boostFactorFor(slug: string, map: Record<string, number> = resolveBoostMap()): number {
  const entries = Object.entries(map)
    .filter(([prefix, factor]) => prefix.length > 0 && Number.isFinite(factor) && factor >= 0)
    .sort((a, b) => b[0].length - a[0].length); // longest-prefix-match wins (sql-ranking.ts)
  for (const [prefix, factor] of entries) {
    if (slug.startsWith(prefix)) return factor;
  }
  return 1.0;
}

export function assertBoostPremise(
  map: Record<string, number> = resolveBoostMap(),
): { curated_factor: number; swamp_factor: number } {
  const swamp = boostFactorFor(`${SWAMP_PREFIX}2026-01-01`, map);
  const curated = boostFactorFor(`${CURATED_PREFIX}essays/example`, map);
  if (!(swamp < 1.0)) {
    throw new BoostPremiseError(
      `swamp prefix '${SWAMP_PREFIX}' resolves to factor ${swamp} (need < 1.0) in gbrain's boost map — `
      + `the demote tier this eval exists to measure is not firing. Did gbrain rename the prefix again `
      + `(see node_modules/gbrain/src/core/search/source-boost.ts)? Rebuild the corpus around a demoted prefix.`,
    );
  }
  if (!(curated > 1.0)) {
    throw new BoostPremiseError(
      `curated prefix '${CURATED_PREFIX}' resolves to factor ${curated} (need > 1.0) in gbrain's boost map — `
      + `the boost tier this eval exists to measure is not firing.`,
    );
  }
  return { curated_factor: curated, swamp_factor: swamp };
}

/** GBRAIN_SOURCE_BOOST value that neutralizes every prefix of the resolved map to 1.0. */
export function neutralBoostEnv(map: Record<string, number> = resolveBoostMap()): string {
  return Object.keys(map).map(p => `${p}:1.0`).join(',');
}

// ─── Corpus loader + premise ────────────────────────────────────────

interface SwampPage extends Page {
  _facts?: { type?: string; name?: string; primary_phrase?: string };
}

export function loadCorpus(dir: string): SwampPage[] {
  const files = readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  const out: SwampPage[] = [];
  for (const f of files) {
    const raw = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
    if (Array.isArray(raw.timeline)) raw.timeline = raw.timeline.join('\n');
    if (Array.isArray(raw.compiled_truth)) raw.compiled_truth = raw.compiled_truth.join('\n\n');
    raw.title = String(raw.title ?? '');
    raw.compiled_truth = String(raw.compiled_truth ?? '');
    raw.timeline = String(raw.timeline ?? '');
    out.push(raw as SwampPage);
  }
  return out;
}

export class CorpusPremiseError extends Error {}

/** Every page must sit in exactly one of the two tiers; every qrel slug must exist. */
export function assertCorpusPremise(pages: Page[], queries: SwampQuery[]): void {
  const slugs = new Set(pages.map(p => p.slug));
  const curated = pages.filter(p => p.slug.startsWith(CURATED_PREFIX));
  const swamp = pages.filter(p => p.slug.startsWith(SWAMP_PREFIX));
  if (curated.length === 0 || swamp.length === 0) {
    throw new CorpusPremiseError(
      `corpus must contain both tiers: ${curated.length} ${CURATED_PREFIX} pages, ${swamp.length} ${SWAMP_PREFIX} pages`,
    );
  }
  const stray = pages.filter(p => !p.slug.startsWith(CURATED_PREFIX) && !p.slug.startsWith(SWAMP_PREFIX));
  if (stray.length > 0) {
    throw new CorpusPremiseError(`corpus pages outside both tiers (stale prefix rename?): ${stray.map(p => p.slug).join(', ')}`);
  }
  for (const q of queries) {
    if (!q.target.startsWith(CURATED_PREFIX)) throw new CorpusPremiseError(`${q.id}: target ${q.target} is not a ${CURATED_PREFIX} page`);
    if (!slugs.has(q.target)) throw new CorpusPremiseError(`${q.id}: target ${q.target} not in corpus`);
    for (const c of q.competing) {
      if (!c.startsWith(SWAMP_PREFIX)) throw new CorpusPremiseError(`${q.id}: competing slug ${c} is not a ${SWAMP_PREFIX} page (stale prefix rename?)`);
      if (!slugs.has(c)) throw new CorpusPremiseError(`${q.id}: competing slug ${c} not in corpus`);
    }
  }
}

// ─── 30 hand-curated queries ───────────────────────────────────────
//
// Each query: a multi-word phrase that appears in BOTH the curated
// target AND >=1 chat distractor. The query text is NOT one of the
// _facts fields (no leakage). Each curated page is targeted by 3 queries.

export interface SwampQuery {
  id: string;
  text: string;
  /** The curated `originals/` page that should rank #1. */
  target: string;
  /** Chat pages known to contain the phrase (the "wrong-but-plausible" set). */
  competing: string[];
}

export const QUERIES: SwampQuery[] = [
  // T1 — fat code thin harness (3 chat distractors)
  { id: 'q01', text: 'fat code thin harness pattern', target: 'originals/talks/article-outline-fat-code',
    competing: ['openclaw/chat/2026-04-01', 'openclaw/chat/2026-04-08', 'openclaw/chat/2026-04-17'] },
  { id: 'q02', text: 'thin harness fat skill files', target: 'originals/talks/article-outline-fat-code',
    competing: ['openclaw/chat/2026-04-08'] },
  { id: 'q03', text: 'fat code thin harness Part 3', target: 'originals/talks/article-outline-fat-code',
    competing: ['openclaw/chat/2026-04-08'] },

  // T2 — do things that don't scale, revisited (2 chat distractors)
  { id: 'q04', text: "do things that don't scale revisited", target: 'originals/essays/do-things-that-don-t-scale-revisited',
    competing: ['openclaw/chat/2026-04-15'] },
  { id: 'q05', text: 'unscalable founder work essay', target: 'originals/essays/do-things-that-don-t-scale-revisited',
    competing: ['openclaw/chat/2026-04-03', 'openclaw/chat/2026-04-15'] },
  { id: 'q06', text: 'do things that don\'t scale AI era', target: 'originals/essays/do-things-that-don-t-scale-revisited',
    competing: ['openclaw/chat/2026-04-03', 'openclaw/chat/2026-04-15'] },

  // T3 — product market fit trap (4 chat distractors, the most-swamped)
  { id: 'q07', text: 'product market fit trap article', target: 'originals/essays/product-market-fit-trap',
    competing: ['openclaw/chat/2026-04-01', 'openclaw/chat/2026-04-05', 'openclaw/chat/2026-04-15', 'openclaw/chat/2026-04-20'] },
  { id: 'q08', text: 'PMF threshold worship premature scaling', target: 'originals/essays/product-market-fit-trap',
    competing: ['openclaw/chat/2026-04-01', 'openclaw/chat/2026-04-15'] },
  { id: 'q09', text: 'channel confusion product market fit', target: 'originals/essays/product-market-fit-trap',
    competing: ['openclaw/chat/2026-04-01', 'openclaw/chat/2026-04-20'] },

  // T4 — founder mode reality check (3 chat distractors)
  { id: 'q10', text: 'founder mode reality check', target: 'originals/talks/founder-mode-reality-check',
    competing: ['openclaw/chat/2026-04-01', 'openclaw/chat/2026-04-10', 'openclaw/chat/2026-04-20'] },
  { id: 'q11', text: 'founder mode hands-on detail work', target: 'originals/talks/founder-mode-reality-check',
    competing: ['openclaw/chat/2026-04-01'] },
  { id: 'q12', text: 'founder default-mode organizational drag', target: 'originals/talks/founder-mode-reality-check',
    competing: ['openclaw/chat/2026-04-01', 'openclaw/chat/2026-04-10'] },

  // T5 — agentic workflows overhyped (4 chat distractors)
  { id: 'q13', text: 'agentic workflows overhyped take', target: 'originals/essays/agentic-workflows-overhyped',
    competing: ['openclaw/chat/2026-04-03', 'openclaw/chat/2026-04-08', 'openclaw/chat/2026-04-12', 'openclaw/chat/2026-04-20'] },
  { id: 'q14', text: 'multi-agent orchestration counter argument', target: 'originals/essays/agentic-workflows-overhyped',
    competing: ['openclaw/chat/2026-04-03'] },
  { id: 'q15', text: 'agentic workflows deterministic pipelines', target: 'originals/essays/agentic-workflows-overhyped',
    competing: ['openclaw/chat/2026-04-03', 'openclaw/chat/2026-04-12', 'openclaw/chat/2026-04-20'] },

  // T6 — late stage unit economics (3 chat distractors)
  { id: 'q16', text: 'late stage unit economics analysis', target: 'originals/essays/unit-economics-late-stage',
    competing: ['openclaw/chat/2026-04-05', 'openclaw/chat/2026-04-15', 'openclaw/chat/2026-04-22'] },
  { id: 'q17', text: 'CAC payback discount rates Series C', target: 'originals/essays/unit-economics-late-stage',
    competing: ['openclaw/chat/2026-04-05'] },
  { id: 'q18', text: 'revenue durability net retention compound', target: 'originals/essays/unit-economics-late-stage',
    competing: ['openclaw/chat/2026-04-05'] },

  // T7 — usage based pricing (2 chat distractors)
  { id: 'q19', text: 'usage based pricing YC talk', target: 'originals/talks/usage-based-pricing-yc',
    competing: ['openclaw/chat/2026-04-05', 'openclaw/chat/2026-04-22'] },
  { id: 'q20', text: 'commit and overage hybrid pricing', target: 'originals/talks/usage-based-pricing-yc',
    competing: ['openclaw/chat/2026-04-05', 'openclaw/chat/2026-04-22'] },
  { id: 'q21', text: 'usage based pricing customer bill predictability', target: 'originals/talks/usage-based-pricing-yc',
    competing: ['openclaw/chat/2026-04-05'] },

  // T8 — vertical SaaS thesis (2 chat distractors)
  { id: 'q22', text: 'vertical SaaS thesis investment writeup', target: 'originals/essays/vertical-saas-thesis',
    competing: ['openclaw/chat/2026-04-10', 'openclaw/chat/2026-04-22'] },
  { id: 'q23', text: 'industry-specific software AI commoditizes', target: 'originals/essays/vertical-saas-thesis',
    competing: ['openclaw/chat/2026-04-10'] },
  { id: 'q24', text: 'vertical SaaS marine logistics dental', target: 'originals/essays/vertical-saas-thesis',
    competing: ['openclaw/chat/2026-04-10', 'openclaw/chat/2026-04-22'] },

  // T9 — foundation models as utilities (3 chat distractors)
  { id: 'q25', text: 'foundation models as utilities essay', target: 'originals/essays/foundation-models-as-utilities',
    competing: ['openclaw/chat/2026-04-10', 'openclaw/chat/2026-04-12', 'openclaw/chat/2026-04-17'] },
  { id: 'q26', text: 'foundation models commoditize utility framing', target: 'originals/essays/foundation-models-as-utilities',
    competing: ['openclaw/chat/2026-04-10', 'openclaw/chat/2026-04-12'] },
  { id: 'q27', text: 'foundation models substitutability vendor diversification', target: 'originals/essays/foundation-models-as-utilities',
    competing: ['openclaw/chat/2026-04-12', 'openclaw/chat/2026-04-17'] },

  // T10 — RAG anti-patterns (3 chat distractors)
  { id: 'q28', text: 'RAG anti patterns talk', target: 'originals/talks/rag-pattern-anti-patterns',
    competing: ['openclaw/chat/2026-04-03', 'openclaw/chat/2026-04-12', 'openclaw/chat/2026-04-17'] },
  { id: 'q29', text: 'eight RAG anti patterns chunk-first cosine-only', target: 'originals/talks/rag-pattern-anti-patterns',
    competing: ['openclaw/chat/2026-04-12', 'openclaw/chat/2026-04-17'] },
  { id: 'q30', text: 'RAG swamp problem source-blind ranking', target: 'originals/talks/rag-pattern-anti-patterns',
    competing: ['openclaw/chat/2026-04-03', 'openclaw/chat/2026-04-12', 'openclaw/chat/2026-04-17'] },
];

// ─── Stub embed transport (hermetic runs; mirrors cat26's pattern) ──

const EMBED_DIMS = 1536;

export function hashEmbed(text: string): number[] {
  const vec = new Array<number>(EMBED_DIMS).fill(0);
  const tokens = new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2));
  for (const tok of tokens) {
    const h = createHash('sha256').update(tok).digest();
    vec[h.readUInt32BE(0) % EMBED_DIMS] += 1;
  }
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
  return vec.map(x => x / norm);
}

async function hashEmbedTransport(
  params: { values: string[] } & Record<string, unknown>,
): Promise<{ embeddings: number[][]; values: string[]; warnings: unknown[]; usage: { tokens: number } }> {
  return {
    embeddings: params.values.map(v => hashEmbed(v)),
    values: params.values,
    warnings: [],
    usage: { tokens: 0 },
  };
}

let gatewayMode: 'stub' | 'live' | null = null;
export function ensureGateway(stubEmbed: boolean): void {
  const want = stubEmbed ? 'stub' : 'live';
  if (gatewayMode === want) return;
  if (stubEmbed && !process.env.OPENAI_API_KEY) {
    // ai-sdk model construction needs a non-empty key even when the transport
    // is stubbed; the dummy never reaches the network.
    process.env.OPENAI_API_KEY = 'dummy-embed-transport-stubbed';
  }
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: EMBED_DIMS,
    env: process.env as Record<string, string | undefined>,
  });
  __setEmbedTransportForTests(
    stubEmbed
      ? (hashEmbedTransport as unknown as Parameters<typeof __setEmbedTransportForTests>[0])
      : null,
  );
  gatewayMode = want;
}

// ─── Adapters ─────────────────────────────────────────────────────
//
// WS5: both gbrain arms pin the search knobs that could confound the
// boost A/B (reranker keys in the ambient env, expansion, query cache).
// The ONLY difference between the two arms is the boost map.

export const GBRAIN_SEARCH_CONFIG: Record<string, string> = {
  'search.mode': 'balanced',
  'search.reranker.enabled': 'false',
  'search.expansion': 'false',
  'search.cache.enabled': 'false',
};

/**
 * Ablation arm (audit retrieval-cats-16): the identical gbrain pipeline
 * with every boost-map prefix neutralized to 1.0. gbrain resolves
 * GBRAIN_SOURCE_BOOST at query-build time (resolveBoostMap() default arg
 * in pglite-engine searchKeyword/searchVector), so wrapping only the
 * query calls is exact: ingest is boost-independent, and the env is
 * restored before any other arm runs.
 */
export class GbrainNoSourceBoostAdapter implements Adapter {
  readonly name = 'gbrain-no-source-boost';
  private inner: GbrainInlineAdapter;

  constructor(topK: number) {
    this.inner = new GbrainInlineAdapter({ topK, searchConfig: GBRAIN_SEARCH_CONFIG }, this.name);
  }

  init(rawPages: Page[], config: AdapterConfig): Promise<BrainState> {
    return this.inner.init(rawPages, config);
  }

  async query(q: PublicQuery, state: BrainState): Promise<RankedDoc[]> {
    const prev = process.env.GBRAIN_SOURCE_BOOST;
    process.env.GBRAIN_SOURCE_BOOST = neutralBoostEnv();
    try {
      return await this.inner.query(q, state);
    } finally {
      if (prev === undefined) delete process.env.GBRAIN_SOURCE_BOOST;
      else process.env.GBRAIN_SOURCE_BOOST = prev;
    }
  }

  teardown(state: BrainState): Promise<void> {
    return this.inner.teardown(state);
  }
}

export function buildAdapters(): Adapter[] {
  return [
    new GbrainInlineAdapter({ topK: TOP_K, searchConfig: GBRAIN_SEARCH_CONFIG }),
    new GbrainNoSourceBoostAdapter(TOP_K),
    new HybridNoGraphAdapter(),
    new RipgrepBm25Adapter(),
    new VectorOnlyAdapter(),
  ];
}

// ─── Scorer ────────────────────────────────────────────────────────

export interface SwampPerQuery {
  id: string;
  topSlug: string | null;
  targetRank: number;
  chatBeforeTarget: number;
  top_slugs: string[];
  error?: string;
}

export interface SwampResult {
  name: string;
  top1_hit_rate: number;
  top3_hit_rate: number;
  swamp_at_top: number;
  per_query: SwampPerQuery[];
  wallMs: number;
}

export async function scoreAdapter(
  adapter: Adapter,
  pages: Page[],
  queries: SwampQuery[],
  acc: ProbeAccounting,
): Promise<SwampResult> {
  const t0 = Date.now();
  const publicPages = pages.map(sanitizePage);
  const state = await adapter.init(publicPages, { name: adapter.name });
  let top1 = 0, top3 = 0, swamp = 0;
  const perQuery: SwampPerQuery[] = [];

  for (const sq of queries) {
    const probeId = `${adapter.name}:${sq.id}`;
    const q: Query = {
      id: sq.id,
      tier: 'fuzzy',
      text: sq.text,
      expected_output_type: 'cited-source-pages',
      gold: { relevant: [sq.target] },
      tags: ['cat-13b', 'source-swamp'],
    };
    let results: RankedDoc[];
    try {
      results = await adapter.query(sanitizeQuery(q), state);
    } catch (err) {
      // The system under test failed the probe: scored as a MISS and kept in
      // the denominator (probe-accounting sut policy).
      acc.error(probeId, 'sut', String(err));
      perQuery.push({ id: sq.id, topSlug: null, targetRank: -1, chatBeforeTarget: 0, top_slugs: [], error: String(err) });
      continue;
    }
    const top = results.slice(0, TOP_K);
    const topIds = top.map(r => r.page_id);
    const topSlug = topIds[0] ?? null;
    const rank = rankOfFirstHit(topIds, new Set([sq.target]));
    const targetRank = Number.isFinite(rank) ? rank : -1;
    let chatBefore = 0;
    for (const id of topIds) {
      if (id === sq.target) break;
      if (id.startsWith(SWAMP_PREFIX)) chatBefore++;
    }
    const hitTop1 = topSlug === sq.target;
    if (hitTop1) top1++;
    if (targetRank > 0 && targetRank <= 3) top3++;
    if (chatBefore > 0) swamp++;
    acc.score(probeId, hitTop1 ? 1 : 0);
    perQuery.push({ id: sq.id, topSlug, targetRank, chatBeforeTarget: chatBefore, top_slugs: topIds });
  }

  if (adapter.teardown) await adapter.teardown(state);
  const n = queries.length;
  return {
    name: adapter.name,
    top1_hit_rate: top1 / n,
    top3_hit_rate: top3 / n,
    swamp_at_top: swamp / n,
    per_query: perQuery,
    wallMs: Date.now() - t0,
  };
}

// ─── Ablation control (audit retrieval-cats-16) ─────────────────────

/**
 * If boost-on and boost-off produce identical top-K lists on EVERY query,
 * the ablation is not isolating anything (env hook dead, or corpus premise
 * dead). Returns the number of queries whose rankings differ.
 */
export function ablationDivergence(boosted: SwampResult, ablated: SwampResult): number {
  const byId = new Map(ablated.per_query.map(pq => [pq.id, pq]));
  let differing = 0;
  for (const pq of boosted.per_query) {
    const other = byId.get(pq.id);
    if (!other) continue;
    if (JSON.stringify(pq.top_slugs) !== JSON.stringify(other.top_slugs)) differing++;
  }
  return differing;
}

// ─── Verdict (audit retrieval-cats-09: the gate must be able to fail) ─

/**
 * The pass criterion drives the receipt verdict (and, via runCat13b, the
 * exit code). Stub-embed runs that clear the bar are 'partial' — hermetic
 * plumbing proof, never the published claim. A run without the gating
 * 'gbrain' arm cannot evaluate the criterion: 'partial'.
 */
export function computeVerdict13b(
  gbrain: Pick<SwampResult, 'top1_hit_rate'> | undefined,
  stubEmbed: boolean,
): { verdict: ReceiptVerdict; gatePass: boolean } {
  const gatePass = gbrain !== undefined && gbrain.top1_hit_rate >= PASS_TOP1;
  if (!gbrain) return { verdict: 'partial', gatePass };
  if (!gatePass) return { verdict: 'fail', gatePass };
  return { verdict: stubEmbed ? 'partial' : 'pass', gatePass };
}

// ─── Runner ─────────────────────────────────────────────────────────

export interface Cat13bOptions {
  stubEmbed?: boolean;
  only?: string;
  allowSkip?: boolean;
  reportsDir?: string;
  quiet?: boolean;
}

export interface Cat13bRunResult {
  receipt: Receipt;
  results: SwampResult[];
  exitCode: number;
}

export async function runCat13b(opts: Cat13bOptions = {}): Promise<Cat13bRunResult> {
  const startedAt = new Date().toISOString();
  const stubEmbed = opts.stubEmbed ?? false;
  const reportsDir = opts.reportsDir ?? join(process.cwd(), 'eval/reports');
  const receiptFile = receiptPath(CATEGORY, reportsDir);
  const log = opts.quiet ? (_: string) => {} : (s: string) => console.log(s);

  const baseReceipt = (): Pick<Receipt, 'schema_version' | 'benchmark_version' | 'category' | 'gbrain_version' | 'gbrain_pin' | 'started_at' | 'finished_at'> => ({
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CATEGORY,
    gbrain_version: gbrainVersion(),
    gbrain_pin: gbrainPin(),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  });

  if (!stubEmbed && !process.env.OPENAI_API_KEY) {
    const reason = 'OPENAI_API_KEY required for live embeds (run with --stub-embed for the hermetic plumbing run)';
    const receipt: Receipt = {
      ...baseReceipt(),
      run_status: 'skipped',
      skip_reason: reason,
      n_total: 0,
      n_scored: 0,
      completion_rate: 0,
      errors: [],
      publishable: false,
    };
    writeReceipt(receiptFile, receipt);
    console.error(`[cat13b] SKIPPED — ${reason}`);
    return { receipt, results: [], exitCode: opts.allowSkip ? 0 : 2 };
  }

  // Determinism: an ambient GBRAIN_SOURCE_BOOST would skew the boost-ON arm
  // and double-neutralize the ablation arm. Clear it for the run.
  const ambientBoost = process.env.GBRAIN_SOURCE_BOOST;
  if (ambientBoost !== undefined) delete process.env.GBRAIN_SOURCE_BOOST;

  // Premises fail LOUDLY (audit retrieval-cats-07): a boost-map rename or a
  // stale corpus prefix is a broken eval, not a quiet 1.0-factor run.
  const factors = assertBoostPremise();
  const corpusDir = join(import.meta.dir, '..', 'data', 'source-swamp-v1');
  const pages = loadCorpus(corpusDir);
  assertCorpusPremise(pages, QUERIES);

  ensureGateway(stubEmbed);

  log(`# BrainBench Cat 13b — Source Swamp Resistance\n`);
  log(`Generated: ${new Date().toISOString().replace(/\..*$/, '')}`);
  log(`Corpus: ${pages.length} pages (${pages.filter(p => p.slug.startsWith(CURATED_PREFIX)).length} ${CURATED_PREFIX}, ${pages.filter(p => p.slug.startsWith(SWAMP_PREFIX)).length} ${SWAMP_PREFIX})`);
  log(`Boost premise: ${CURATED_PREFIX} ×${factors.curated_factor}, ${SWAMP_PREFIX} ×${factors.swamp_factor}`);
  log(`Queries: ${QUERIES.length} hand-curated source-swamp queries`);
  log(`Embeds: ${stubEmbed ? 'stubbed deterministic hash (hermetic)' : 'live OpenAI'}`);
  log(`Top-K: ${TOP_K}\n`);

  const allAdapters = buildAdapters();
  const adapters = opts.only ? allAdapters.filter(a => a.name === opts.only) : allAdapters;
  if (adapters.length === 0) {
    throw new Error(`--adapter ${opts.only} matches none of: ${allAdapters.map(a => a.name).join(', ')}`);
  }

  const acc = new ProbeAccounting(adapters.length * QUERIES.length);

  log(`## Running adapters\n`);
  const results: SwampResult[] = [];
  for (const a of adapters) {
    log(`- ${a.name} ...`);
    try {
      const r = await scoreAdapter(a, pages, QUERIES, acc);
      log(`  done (${(r.wallMs / 1000).toFixed(1)}s). top1=${(r.top1_hit_rate * 100).toFixed(1)}%, top3=${(r.top3_hit_rate * 100).toFixed(1)}%, swamp=${(r.swamp_at_top * 100).toFixed(1)}%`);
      results.push(r);
    } catch (err) {
      // init/teardown failure: not a per-probe sut miss — the whole arm is
      // gone (missing dependency or harness bug). Excluded + capped.
      for (const sq of QUERIES) acc.error(`${a.name}:${sq.id}`, 'harness', `adapter init/teardown failed: ${String(err)}`);
      log(`  FAILED to run: ${String(err)}`);
    }
  }

  results.sort((a, b) => b.top1_hit_rate - a.top1_hit_rate);

  log(`\n## Scorecard\n`);
  log(`| Adapter | Top-1 hit | Top-3 hit | Swamp@top (lower=better) | Wall (s) |`);
  log(`|---------|-----------|-----------|--------------------------|----------|`);
  for (const r of results) {
    log(`| ${r.name.padEnd(22)} | ${(r.top1_hit_rate * 100).toFixed(1)}% | ${(r.top3_hit_rate * 100).toFixed(1)}% | ${(r.swamp_at_top * 100).toFixed(1)}% | ${(r.wallMs / 1000).toFixed(1)} |`);
  }

  const gbrainRes = results.find(r => r.name === 'gbrain');
  const ablationRes = results.find(r => r.name === 'gbrain-no-source-boost');

  if (gbrainRes) {
    log(`\n## Per-query breakdown (gbrain only)\n`);
    log(`| Query | Top slug | Target rank | Chat above target |`);
    log(`|-------|----------|-------------|-------------------|`);
    for (const pq of gbrainRes.per_query) {
      const tgt = QUERIES.find(q => q.id === pq.id)!;
      const win = pq.topSlug === tgt.target ? 'Y' : 'N';
      const slugShort = (pq.topSlug ?? 'none').replace(SWAMP_PREFIX, 'chat/').replace(CURATED_PREFIX, 'orig/');
      log(`| ${pq.id} ${win} | \`${slugShort}\` | ${pq.targetRank > 0 ? pq.targetRank : 'none'} | ${pq.chatBeforeTarget} |`);
    }
  }

  // The paired A/B this eval exists to report (audit retrieval-cats-16):
  // same pipeline, boost on vs off.
  let sourceBoostEffect: { top1_delta: number; top3_delta: number; swamp_delta: number; queries_reranked: number } | null = null;
  let ablationDead = false;
  if (gbrainRes && ablationRes) {
    const differing = ablationDivergence(gbrainRes, ablationRes);
    ablationDead = differing === 0;
    sourceBoostEffect = {
      top1_delta: gbrainRes.top1_hit_rate - ablationRes.top1_hit_rate,
      top3_delta: gbrainRes.top3_hit_rate - ablationRes.top3_hit_rate,
      swamp_delta: gbrainRes.swamp_at_top - ablationRes.swamp_at_top,
      queries_reranked: differing,
    };
    log(`\n## Source-boost effect (gbrain minus gbrain-no-source-boost, same pipeline)\n`);
    log(`- top-1 delta: ${(sourceBoostEffect.top1_delta * 100).toFixed(1)}pt`);
    log(`- top-3 delta: ${(sourceBoostEffect.top3_delta * 100).toFixed(1)}pt`);
    log(`- swamp@top delta: ${(sourceBoostEffect.swamp_delta * 100).toFixed(1)}pt (negative = boost suppresses swamp)`);
    log(`- queries whose top-${TOP_K} changed: ${differing}/${QUERIES.length}`);
    if (ablationDead) {
      acc.error('ablation-control', 'harness',
        `gbrain and gbrain-no-source-boost produced identical top-${TOP_K} lists on all ${QUERIES.length} queries — the ablation is not isolating the boost (env hook dead or corpus premise dead)`);
    }
  }

  log(`\n## Methodology\n`);
  log(`- Corpus: ${pages.filter(p => p.slug.startsWith(CURATED_PREFIX)).length} short curated \`${CURATED_PREFIX}\` pages + ${pages.filter(p => p.slug.startsWith(SWAMP_PREFIX)).length} long \`${SWAMP_PREFIX}\` pages.`);
  log(`- Each query is a multi-word phrase appearing in BOTH the curated target AND >=1 chat distractor.`);
  log(`- Strict target: the curated \`${CURATED_PREFIX}\` page. Chat pages: distractors.`);
  log(`- Pass criterion (gbrain adapter): top1_hit_rate >= ${(PASS_TOP1 * 100).toFixed(0)}%. Drives verdict + exit code.`);
  log(`- gbrain arms pin ${JSON.stringify(GBRAIN_SEARCH_CONFIG)}; the ablation arm additionally sets GBRAIN_SOURCE_BOOST to neutralize every prefix to 1.0 at query time.`);
  log(`- Source-blind adapters (grep-only, vector) are EXPECTED to lose — that is the point of the corpus.`);

  const summary = acc.summary();

  // Persist the full per-query results (audit retrieval-cats-09: the runner
  // previously produced no machine-readable artifact at all).
  const reportFile = join(reportsDir, CATEGORY, 'report.json');
  mkdirSync(dirname(reportFile), { recursive: true });
  writeFileSync(reportFile, JSON.stringify({
    ran_at: startedAt,
    stub_embed: stubEmbed,
    boost_factors: factors,
    results,
    source_boost_effect: sourceBoostEffect,
    accounting: summary,
  }, null, 2) + '\n');

  const resolvedConfig: Record<string, unknown> = {
    top_k: TOP_K,
    pass_criterion: `gbrain top1_hit_rate >= ${PASS_TOP1}`,
    curated_prefix: CURATED_PREFIX,
    swamp_prefix: SWAMP_PREFIX,
    boost_factors: factors,
    gbrain_search_config: GBRAIN_SEARCH_CONFIG,
    ablation_env: 'GBRAIN_SOURCE_BOOST=<every resolved prefix>:1.0 (query-time only)',
    embedding_transport: stubEmbed ? 'stubbed deterministic hash-embed (__setEmbedTransportForTests)' : 'live openai:text-embedding-3-large',
    ambient_source_boost_cleared: ambientBoost !== undefined,
    adapters_run: results.map(r => r.name),
  };
  const data: Record<string, unknown> = {
    scorecard: results.map(r => ({
      name: r.name,
      top1_hit_rate: r.top1_hit_rate,
      top3_hit_rate: r.top3_hit_rate,
      swamp_at_top: r.swamp_at_top,
      wall_ms: r.wallMs,
    })),
    source_boost_effect: sourceBoostEffect,
    report_file: reportFile,
  };

  if (summary.run_invalid || ablationDead) {
    const receipt: Receipt = {
      ...baseReceipt(),
      run_status: 'error',
      n_total: summary.n_total,
      n_scored: summary.n_scored,
      completion_rate: summary.completion_rate,
      errors: summary.errors,
      publishable: false,
      resolved_config: resolvedConfig,
      data,
    };
    writeReceipt(receiptFile, receipt);
    console.error(`[cat13b] RUN INVALID — ${ablationDead ? 'ablation control failed (arms identical)' : `infra error rate ${(summary.infra_error_rate * 100).toFixed(1)}% over cap`}`);
    return { receipt, results, exitCode: 3 };
  }

  // Pass criterion drives verdict + exit code (audit retrieval-cats-09).
  const { verdict, gatePass } = computeVerdict13b(gbrainRes, stubEmbed);

  const receipt: Receipt = {
    ...baseReceipt(),
    run_status: 'completed',
    verdict,
    n_total: summary.n_total,
    n_scored: summary.n_scored,
    completion_rate: summary.completion_rate,
    errors: summary.errors,
    publishable: summary.publishable && !stubEmbed && gbrainRes !== undefined,
    resolved_config: resolvedConfig,
    data: { ...data, gate_pass: gatePass },
  };
  writeReceipt(receiptFile, receipt);

  if (gbrainRes) {
    if (gatePass) {
      log(`\n**${verdict === 'partial' ? 'PASS (stub-embed, verdict partial)' : 'PASS'}**: gbrain top-1 hit rate ${(gbrainRes.top1_hit_rate * 100).toFixed(1)}% >= ${(PASS_TOP1 * 100).toFixed(0)}%.`);
    } else {
      console.error(`\n**FAIL**: gbrain top-1 hit rate ${(gbrainRes.top1_hit_rate * 100).toFixed(1)}% < ${(PASS_TOP1 * 100).toFixed(0)}%. Tune source-boost defaults.`);
    }
  } else {
    log(`\nGating arm 'gbrain' did not run (--adapter filter) — verdict partial, gate not evaluated.`);
  }

  return { receipt, results, exitCode: verdict === 'fail' ? 1 : 0 };
}

// ─── CLI ────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const onlyIdx = argv.indexOf('--adapter');
  const { exitCode } = await runCat13b({
    stubEmbed: argv.includes('--stub-embed') || process.env.CAT13B_STUB_EMBED === '1',
    only: onlyIdx >= 0 ? argv[onlyIdx + 1] : undefined,
    allowSkip: argv.includes('--allow-skip'),
  });
  return exitCode;
}

if (import.meta.main) {
  main()
    .then(code => process.exit(code)) // explicit: PGLite's WASM runtime pollutes ambient process.exitCode
    .catch(err => {
      console.error(err);
      process.exit(3);
    });
}

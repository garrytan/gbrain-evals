/**
 * Synthetic live-recall brain (GBEV-55 G2): builds an in-process PGLite brain
 * from a directory written by eval/generators/conditions-recall-gen.ts (schema
 * conditions-recall/v1) or eval/generators/batch3-synthetic-gen.ts (schema
 * live-recall-b3-synthetic/v1, batch 3's freshness and entity questions under
 * the batch3 protocol, with gbrain's default knobs), applies the directory's
 * recorded knobs, then marks it as a copy and sets it read-only exactly like
 * buildFixtureBrain in run.ts, so the six live-recall arms (runQuestions) score
 * it the way they score the fixture.
 *
 * Transports:
 *   - hash (the default, keyless, a control): the fixture transports, hash
 *     embeddings and a token-overlap reranker, at gbrain's balanced mode.
 *   - voyage (paid, only through run.ts run --synthetic --paid --budget-run-id):
 *     the configuration live recall's counted brain ran in batches 1 and 2
 *     (VOYAGE_SYNTHETIC): gbrain's real Voyage embedder for pages and queries,
 *     tokenmax mode and the configured arm's rerank-2.5. The import runs under
 *     gbrain's AI invocation guard and may make embedding calls only, so the
 *     per-chunk synopsis tier (a chat model) is never reached and chunks get
 *     the title tier, as on every keyless build. run.ts reserves and settles
 *     every request on the budget ledger.
 *
 * Knobs, as the generator header defines them:
 *   - synopsis_vectors_off sets search.contextual_retrieval_disabled before
 *     import, so chunks embed with no contextual prefix (gbrain's default
 *     title tier otherwise; the per-chunk synopsis tier needs a model).
 *   - unembedded_chunk_share clears the vector of that share of chunks after
 *     import (embedding and embedded_at NULL, embedding_pending_since set),
 *     chosen by sha256(seed:slug:chunk_index), so the choice is the same on
 *     every build and nested across shares.
 *   - keyword_candidate_bound wraps engine.searchKeyword: when more chunks
 *     match than the bound, only a fixed sample of that many matching chunks
 *     (ordered by md5 of the chunk id, standing in for Postgres plan order)
 *     can be returned, and the caller hears keyword_candidates_incomplete
 *     through onKeywordIncomplete, as gbrain's Postgres engine reports past
 *     KEYWORD_RANK_CANDIDATES. A page counts only through a sampled chunk.
 *   - shell pages are already in the page files.
 *
 * The directory's digest is recomputed before anything is built; a directory
 * edited after generation is refused. Every gold page, and on a batch-3
 * directory every stale page, must be in the directory.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { importGbrain, type GbrainUnderTest } from '../gbrain-under-test.ts';
import { COPY_MARKER_TABLE } from './brain.ts';
import { parseQuestions, useFixtureTransports } from './run.ts';
import { SCHEMA, corpusDigest, validateKnobs, type Manifest, type Page } from '../../generators/conditions-recall-gen.ts';
import { B3_SCHEMA, batch3Digest, type Batch3Manifest } from '../../generators/batch3-synthetic-gen.ts';
import { priceRequest } from '../budget-ledger.ts';
import type { Protocol } from './scorecard.ts';

export type Transports = 'hash' | 'voyage';

/**
 * Live recall's counted configuration: the run block of
 * docs/benchmarks/2026-11-07-live-recall-batch2/b2-593-scorecard.json (and both batch 1
 * attempts) records voyage:voyage-4 embeddings, tokenmax and voyage:rerank-2.5. The
 * dimension is voyage-4's default (gbrain's Voyage recipe, default_dims 1024); the
 * counted scorecards do not record one.
 */
export const VOYAGE_SYNTHETIC = { embedding_model: 'voyage:voyage-4', embedding_dimensions: 1024, search_mode: 'tokenmax', reranker_model: 'voyage:rerank-2.5' } as const;
/** tokenmax's reranker_top_n_in: the most chunks one configured-arm query sends to the reranker. */
export const VOYAGE_RERANK_TOP_N_IN = 50;
/** Arms that may embed one query form: hybrid, vector, configured and configured_window (an upper bound; vector reuses hybrid's). */
const QUERY_EMBEDS_PER_FORM = 4;
/** Context prefix and chunk overlap on top of the page text, an allowance on the ledger's 3 bytes a token. */
const CORPUS_OVERHEAD = 1.5;

export type SyntheticManifest = Manifest | Batch3Manifest;

export interface SyntheticApplied {
  transports: Transports;
  chunks: number;
  unembedded_chunks: number;
  contextual_retrieval_mode: string[];
  keyword_candidate_bound: number | null;
}

function walkPages(dir: string, root = dir): Page[] {
  return readdirSync(dir).sort().flatMap(name => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walkPages(full, root);
    return name.endsWith('.md') ? [{ slug: relative(root, full).replace(/\.md$/, ''), body: readFileSync(full, 'utf8') }] : [];
  });
}

/** Read and check a generated directory: schema, knobs, digest, and gold (and batch-3 stale) pages present. protocol is set for a batch-3 directory. */
export function readSyntheticDir(dir: string): { manifest: SyntheticManifest; pages: Page[]; questionsText: string; protocol?: Protocol } {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as SyntheticManifest;
  const batch3 = manifest?.schema === B3_SCHEMA;
  if (!batch3 && manifest?.schema !== SCHEMA) throw new Error('synthetic: ' + dir + ' has no ' + SCHEMA + ' or ' + B3_SCHEMA + ' manifest');
  const knobs = validateKnobs(manifest.knobs);
  const pages = walkPages(join(dir, 'pages'));
  const questionsText = readFileSync(join(dir, 'questions.jsonl'), 'utf8');
  const digest = (batch3 ? batch3Digest : corpusDigest)(knobs, pages, questionsText);
  if (digest !== manifest.digest) throw new Error('synthetic: ' + dir + ' does not match its manifest digest (expected ' + manifest.digest + ', got ' + digest + '); regenerate it');
  const slugs = new Set(pages.map(p => p.slug));
  for (const q of parseQuestions(questionsText, batch3 ? 'batch3' : undefined)) {
    for (const g of q.gold) if (!slugs.has(g.slug)) throw new Error('synthetic: question ' + q.id + ' has no gold page');
    for (const s of q.stale ?? []) if (!slugs.has(s.slug)) throw new Error('synthetic: question ' + q.id + ' has no stale page');
  }
  return { manifest: { ...manifest, knobs }, pages, questionsText, ...(batch3 ? { protocol: 'batch3' as const } : {}) };
}

/** The Voyage cost of one paid synthetic run over a directory, from the ledger's own prices and its 3-bytes-a-token reservation rule; an upper-leaning estimate, printed before the first request. */
export function estimateVoyageUsd(dir: string): { usd: number; embedding_tokens: number; rerank_tokens: number; embedding_usd_per_mtok: number; rerank_usd_per_mtok: number } {
  const { pages, questionsText, protocol } = readSyntheticDir(dir);
  const questions = parseQuestions(questionsText, protocol);
  const bytes = (s: string) => Buffer.byteLength(s);
  const pageBytes = pages.reduce((n, p) => n + bytes(p.body), 0);
  const docs = Math.min(VOYAGE_RERANK_TOP_N_IN, pages.length);
  const docBytes = pages.length ? pageBytes / pages.length : 0;
  let queryTokens = 0, rerankTokens = 0;
  for (const q of questions) for (const form of [q.forms.exact, q.forms.paraphrase]) {
    queryTokens += (Math.ceil(bytes(form) / 3) + 16) * QUERY_EMBEDS_PER_FORM;
    rerankTokens += (q.window ? 2 : 1) * (Math.ceil((bytes(form) * docs + docs * docBytes) / 3) + 16);
  }
  const embeddingTokens = Math.ceil((pageBytes * CORPUS_OVERHEAD) / 3) + 16 * pages.length + queryTokens;
  const embed = priceRequest('https://api.voyageai.com/v1/embeddings', { model: VOYAGE_SYNTHETIC.embedding_model.split(':')[1], input: ['x'] })!.input;
  const rerank = priceRequest('https://api.voyageai.com/v1/rerank', { model: VOYAGE_SYNTHETIC.reranker_model.split(':')[1], query: 'x', documents: ['y'] })!.input;
  return { usd: (embeddingTokens * embed + rerankTokens * rerank) / 1e6, embedding_tokens: embeddingTokens, rerank_tokens: rerankTokens, embedding_usd_per_mtok: embed, rerank_usd_per_mtok: rerank };
}

/** gbrain's real Voyage transports with the key from this process's environment. */
async function useVoyageTransports(gut: GbrainUnderTest): Promise<() => void> {
  if (!process.env.VOYAGE_API_KEY) throw new Error('synthetic: voyage transports need VOYAGE_API_KEY in the environment');
  const gateway = await importGbrain<any>(gut, 'src/core/ai/gateway.ts');
  gateway.__setEmbedTransportForTests(null);
  gateway.__setRerankTransportForTests(null);
  gateway.configureGateway({ embedding_model: VOYAGE_SYNTHETIC.embedding_model, embedding_dimensions: VOYAGE_SYNTHETIC.embedding_dimensions, env: { VOYAGE_API_KEY: process.env.VOYAGE_API_KEY } });
  return () => {};
}

export async function buildSyntheticBrain(gut: GbrainUnderTest, dir: string, transports: Transports = 'hash'): Promise<{ engine: any; close: () => Promise<void>; questionsText: string; manifest: SyntheticManifest; protocol?: Protocol; applied: SyntheticApplied }> {
  const { manifest, pages, questionsText, protocol } = readSyntheticDir(dir);
  const { knobs, seed } = manifest;
  const reset = transports === 'voyage' ? await useVoyageTransports(gut) : await useFixtureTransports(gut);
  const { PGLiteEngine } = await importGbrain<any>(gut, 'src/core/pglite-engine.ts');
  const engine = new PGLiteEngine();
  try {
    await engine.connect({});
    await engine.initSchema();
    if (transports === 'voyage') {
      await engine.setConfig('search.mode', VOYAGE_SYNTHETIC.search_mode);
      await engine.setConfig('search.reranker.model', VOYAGE_SYNTHETIC.reranker_model);
    }
    if (knobs.synopsis_vectors_off) await engine.setConfig('search.contextual_retrieval_disabled', 'true');
    const { assertEmbedded } = await import('../import-embedded.ts');
    const { importFromContent } = await importGbrain<any>(gut, 'src/core/import-file.ts');
    const importAll = async () => { for (const page of pages) assertEmbedded(await importFromContent(engine, page.slug, page.body, { noEmbed: false }), page.slug); };
    if (transports === 'voyage') {
      const { withAIInvocationGuard } = await importGbrain<any>(gut, 'src/core/ai/invocation-guard.ts');
      await withAIInvocationGuard(async (call: { kind: string }) => {
        if (call.kind !== 'embedding') throw new Error('synthetic: the voyage import refused a ' + call.kind + ' call');
        return { settle: async () => {} };
      }, importAll);
    } else await importAll();

    const chunks = await engine.executeRaw('SELECT cc.id, p.slug, cc.chunk_index FROM content_chunks cc JOIN pages p ON p.id = cc.page_id') as Array<{ id: number; slug: string; chunk_index: number }>;
    const ranked = chunks.map(c => ({ id: Number(c.id), h: createHash('sha256').update(seed + ':unembedded:' + c.slug + ':' + c.chunk_index).digest('hex') })).sort((a, b) => a.h.localeCompare(b.h));
    const cleared = ranked.slice(0, Math.round(knobs.unembedded_chunk_share * chunks.length)).map(c => c.id);
    if (cleared.length) await engine.executeRaw('UPDATE content_chunks SET embedding = NULL, embedded_at = NULL, embedding_pending_since = now() WHERE id = ANY($1::int[])', [cleared]);
    const modes = await engine.executeRaw("SELECT DISTINCT COALESCE(contextual_retrieval_mode, 'unset') AS mode FROM pages ORDER BY 1") as Array<{ mode: string }>;

    const bound = knobs.keyword_candidate_bound;
    if (bound !== null) {
      const { getFtsLanguage } = await importGbrain<any>(gut, 'src/core/fts-language.ts');
      const { collapseWebsearchDashRuns } = await importGbrain<any>(gut, 'src/core/search/sql-ranking.ts');
      const { searchLimitCap } = await importGbrain<any>(gut, 'src/core/search/eval-pool-depth.ts');
      const searchKeyword = engine.searchKeyword.bind(engine);
      engine.searchKeyword = async (query: string, opts: any = {}) => {
        const sql = "SELECT cc.id FROM content_chunks cc WHERE cc.modality = 'text' AND cc.search_vector @@ websearch_to_tsquery('" + getFtsLanguage() + "', $1) ORDER BY md5(cc.id::text) LIMIT $2";
        const sample = await engine.executeRaw(sql, [collapseWebsearchDashRuns(query), bound + 1]) as Array<{ id: number }>;
        if (sample.length <= bound) return searchKeyword(query, opts);
        opts.onKeywordIncomplete?.('candidate_budget');
        const kept = new Set(sample.slice(0, bound).map(r => Number(r.id)));
        const rows = await searchKeyword(query, { ...opts, limit: searchLimitCap() });
        return rows.filter((r: any) => kept.has(Number(r.chunk_id))).slice(0, opts.limit ?? 20);
      };
    }

    await engine.executeRaw('CREATE TABLE public.' + COPY_MARKER_TABLE + ' (made_at timestamptz NOT NULL DEFAULT now())');
    await engine.executeRaw('SET default_transaction_read_only = on');
    return {
      engine,
      questionsText,
      manifest,
      ...(protocol ? { protocol } : {}),
      applied: { transports, chunks: chunks.length, unembedded_chunks: cleared.length, contextual_retrieval_mode: modes.map(m => m.mode), keyword_candidate_bound: bound },
      close: async () => {
        reset();
        await engine.disconnect();
      },
    };
  } catch (error) {
    reset();
    await engine.disconnect().catch(() => {});
    throw error;
  }
}

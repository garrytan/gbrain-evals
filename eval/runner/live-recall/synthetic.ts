/**
 * Synthetic live-recall brain (GBEV-55 G2): builds an in-process PGLite brain
 * from a directory written by eval/generators/conditions-recall-gen.ts, with
 * the keyless fixture transports (hash embeddings and a token-overlap
 * reranker), applies the directory's recorded knobs, then marks it as a copy
 * and sets it read-only exactly like buildFixtureBrain in run.ts, so the six
 * live-recall arms (runQuestions) score it the way they score the fixture.
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
 * edited after generation is refused.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { importGbrain, type GbrainUnderTest } from '../gbrain-under-test.ts';
import { COPY_MARKER_TABLE } from './brain.ts';
import { parseQuestions, useFixtureTransports } from './run.ts';
import { SCHEMA, corpusDigest, validateKnobs, type Manifest, type Page } from '../../generators/conditions-recall-gen.ts';

export interface SyntheticApplied {
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

/** Read and check a generated directory: schema, knobs, digest, and gold pages present. */
export function readSyntheticDir(dir: string): { manifest: Manifest; pages: Page[]; questionsText: string } {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest?.schema !== SCHEMA) throw new Error('synthetic: ' + dir + ' has no ' + SCHEMA + ' manifest');
  const knobs = validateKnobs(manifest.knobs);
  const pages = walkPages(join(dir, 'pages'));
  const questionsText = readFileSync(join(dir, 'questions.jsonl'), 'utf8');
  const digest = corpusDigest(knobs, pages, questionsText);
  if (digest !== manifest.digest) throw new Error('synthetic: ' + dir + ' does not match its manifest digest (expected ' + manifest.digest + ', got ' + digest + '); regenerate it');
  const slugs = new Set(pages.map(p => p.slug));
  for (const q of parseQuestions(questionsText)) for (const g of q.gold) if (!slugs.has(g.slug)) throw new Error('synthetic: question ' + q.id + ' has no gold page');
  return { manifest: { ...manifest, knobs }, pages, questionsText };
}

export async function buildSyntheticBrain(gut: GbrainUnderTest, dir: string): Promise<{ engine: any; close: () => Promise<void>; questionsText: string; manifest: Manifest; applied: SyntheticApplied }> {
  const { manifest, pages, questionsText } = readSyntheticDir(dir);
  const { knobs, seed } = manifest;
  const reset = await useFixtureTransports(gut);
  const { PGLiteEngine } = await importGbrain<any>(gut, 'src/core/pglite-engine.ts');
  const engine = new PGLiteEngine();
  try {
    await engine.connect({});
    await engine.initSchema();
    if (knobs.synopsis_vectors_off) await engine.setConfig('search.contextual_retrieval_disabled', 'true');
    const { assertEmbedded } = await import('../import-embedded.ts');
    const { importFromContent } = await importGbrain<any>(gut, 'src/core/import-file.ts');
    for (const page of pages) assertEmbedded(await importFromContent(engine, page.slug, page.body, { noEmbed: false }), page.slug);

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
      applied: { chunks: chunks.length, unembedded_chunks: cleared.length, contextual_retrieval_mode: modes.map(m => m.mode), keyword_candidate_bound: bound },
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

/**
 * Freeze the evidence once (plan amendment 4 and the late Eng amendment).
 *
 * For every question: import its haystack into a fresh in-memory brain at the
 * pinned gbrain commit (the shared embedding cache supplies vectors), run the
 * R1 retrieval pins at top-5 and top-10, store the hits with chunk text and
 * index, store every chunk of every hit page, and ask gbrain's shipped stage
 * (assembleEvidenceForHits, a trusted local caller) for each product arm's
 * evidence. The harness arms (chunk, k10, page_legacy) are built from the
 * same frozen rows. Agreement with R1 is reported, never used to drop rows.
 * Resumable: questions already in the manifest are skipped. The brain is
 * replaced every 40 questions (#5092).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packK10 } from './arms.ts';
import type { DecisionManifest } from './decision.ts';
import { sha256, type LmeQuestion } from './data.ts';
import { configureGbrainGateway, gbrainIdentity, type GbrainModules } from './gbrain.ts';
import {
  BlobStore, HEADER_FILE, appendFrozen, compareWithR1, duplicateBodies, evidenceSha, indexSha, readFrozen,
  type FrozenArm, type FrozenBlock, type FrozenHeader, type FrozenHit, type FrozenPage, type FrozenQuestion,
} from './store.ts';

export interface FreezeInput {
  question: Pick<LmeQuestion, 'question_id' | 'question' | 'question_date' | 'haystack_dates' | 'haystack_session_ids' | 'haystack_sessions'> & { question_type?: string; answer_session_ids?: string[] };
  set: FrozenQuestion['set'];
  r1Retrieved?: Array<{ rank: number; slug: string; chunk_id: number }>;
}

export interface FreezeOptions {
  g: GbrainModules;
  manifest: DecisionManifest;
  manifestSha: string;
  outDir: string;
  inputs: FreezeInput[];
  embedCachePath: string;
  datasetSha: string;
  smoke: boolean;
  log?: (line: string) => void;
}

export const EMBEDDING = 'openai:text-embedding-3-large@1536';
/**
 * Voyage reranks of some haystacks take longer than gbrain's 5 s default at
 * this commit, and a timed-out rerank falls back to unreranked order. The
 * timeout never changes a completed rerank's order, so it is raised for
 * questions frozen from 2026-09-30T14:30Z on and recorded per question.
 */
export const RERANK_TIMEOUT_MS = 30_000;

export function productArmSpecs(m: DecisionManifest) {
  return m.arms.filter(a => a.source === 'product').map(a => ({ id: a.id, unit: a.unit, ...(a.return_window ? { return_window: a.return_window } : {}), budget_tokens: a.budget_tokens ?? null }));
}

function fileSha(path: string): string | null {
  return existsSync(path) ? sha256(readFileSync(path)) : null;
}

async function configure(engine: any, m: DecisionManifest) {
  await engine.setConfig('search.mode', String((m as any).retrieval?.mode ?? 'balanced'));
  await engine.setConfig('search.reranker.enabled', 'true');
  await engine.setConfig('search.autocut', 'false');
  await engine.setConfig('search.reranker.timeout_ms', String(RERANK_TIMEOUT_MS));
}

export async function freeze(o: FreezeOptions): Promise<{ frozen: number; skipped: number; errors: Array<{ question_id: string; error: string }> }> {
  const log = o.log ?? ((l: string) => process.stderr.write(l + '\n'));
  const { g, manifest } = o;
  mkdirSync(o.outDir, { recursive: true });
  const identity = gbrainIdentity(g.dir);
  if (!o.smoke) {
    if (!manifest.candidate_commits.gbrain) throw new Error('decision manifest has no pinned gbrain commit; pin it before the freeze');
    if (identity.commit !== manifest.candidate_commits.gbrain) throw new Error(`GBRAIN_DIR is at ${identity.commit}, the manifest pins ${manifest.candidate_commits.gbrain}`);
    if (identity.dirty) throw new Error('GBRAIN_DIR has uncommitted changes under src/; the freeze measures the committed candidate only');
    if (!g.evidence) throw new Error('the pinned gbrain commit has no evidence-delivery stage');
  }
  configureGbrainGateway(g);
  const headerPath = join(o.outDir, HEADER_FILE);
  const products = productArmSpecs(manifest);
  if (existsSync(headerPath)) {
    const prior = JSON.parse(readFileSync(headerPath, 'utf8')) as FrozenHeader;
    if (prior.gbrain.commit !== identity.commit || prior.gbrain.dirty_sha256 !== identity.dirty_sha256) throw new Error(`${o.outDir} was frozen at ${prior.gbrain.commit}; use a new --out-dir for ${identity.commit}`);
  } else {
    const header: FrozenHeader = {
      schema: 'gbrain-evals/evidence-delivery-frozen/v1', created_at: new Date().toISOString(), smoke: o.smoke, decision_manifest_sha256: o.manifestSha,
      gbrain: identity, dataset_sha256: o.datasetSha,
      retrieval: { top_k: 5, comparator_top_k: 10, mode: 'balanced', reranker: true, autocut: false, expansion: false, trajectory: false, embedding: EMBEDDING },
      embed_cache: { sha256_before: fileSha(o.embedCachePath), sha256_after: null, misses: null },
      product_arms: Object.fromEntries(products.map(p => [p.id, { unit: p.unit, ...(p.return_window ? { return_window: p.return_window } : {}), budget_tokens: p.budget_tokens }])),
      note: g.evidence ? 'product arms produced by assembleEvidenceForHits at this commit' : 'this commit has no evidence-delivery stage; only the harness arms (chunk, k10, page_legacy) are frozen',
    };
    writeFileSync(headerPath, JSON.stringify(header, null, 2) + '\n');
  }
  const done = new Set(readFrozen(o.outDir).questions.keys());
  const store = new BlobStore(o.outDir);
  const count = (s: string) => g.tokens.estimateTokens(s);
  const k10Budget = manifest.arms.find(a => a.id === 'k10')?.budget_tokens ?? 6000;
  const cache = new g.embedCache.EmbeddingCache(o.embedCachePath);
  const installed = g.embedCache.installEmbedCache(cache, { realTransport: null });
  const first = await g.harness.createBenchmarkBrain();
  await configure(first, manifest);
  const brains = g.harness.brainRecycler
    ? g.harness.brainRecycler(first, g.harness.LME_BRAIN_RECYCLE_EVERY ?? 40, g.harness.createBenchmarkBrain, e => configure(e, manifest))
    : { next: async () => first, close: async () => {} };
  const errors: Array<{ question_id: string; error: string }> = [];
  let frozen = 0, skipped = 0;
  try {
    for (const input of o.inputs) {
      const q = input.question;
      if (done.has(q.question_id)) { skipped++; continue; }
      const engine = await brains.next();
      try {
        const line = await freezeOne(g, engine, input, store, cache, products, count, k10Budget);
        appendFrozen(o.outDir, line);
        frozen++;
        log(`[freeze] ${q.question_id} (${frozen}/${o.inputs.length - skipped}) r1=${line.r1 ? (line.r1.identical_slug_chunk_rank ? 'same' : 'diff') : 'n/a'} arms=${Object.keys(line.arms).length}`);
      } catch (e: any) {
        errors.push({ question_id: q.question_id, error: String(e?.message ?? e).slice(0, 500) });
        log(`[freeze] ${q.question_id} ERROR ${String(e?.message ?? e).slice(0, 300)}`);
      }
    }
  } finally {
    const stats = cache.stats?.() ?? null;
    installed.uninstall();
    cache.close?.();
    await brains.close();
    await first.disconnect();
    const header = JSON.parse(readFileSync(headerPath, 'utf8')) as FrozenHeader;
    header.embed_cache.sha256_after = fileSha(o.embedCachePath);
    header.embed_cache.misses = (header.embed_cache.misses ?? 0) + (stats?.misses ?? 0);
    writeFileSync(headerPath, JSON.stringify(header, null, 2) + '\n');
  }
  return { frozen, skipped, errors };
}

async function freezeOne(g: GbrainModules, engine: any, input: FreezeInput, store: BlobStore, cache: any, products: ReturnType<typeof productArmSpecs>, count: (s: string) => number, k10Budget: number): Promise<FrozenQuestion> {
  const q = input.question;
  await g.harness.resetTables(engine);
  const pages = g.adapter.haystackToPages(q);
  const dates = q.haystack_dates ?? [];
  // Last occurrence wins, as in the harness reader (generateAnswer's Map) and the import (a later page overwrites an earlier one).
  const bodyBySlug = new Map<string, { content: string; date: string | null }>();
  pages.forEach((p, i) => { bodyBySlug.set(p.slug, { content: p.content, date: dates[i] ?? null }); });
  const [raw5, raw10] = await cache.withTransaction(async () => {
    for (const p of pages) await g.importFile.importFromContent(engine, p.slug, p.content, { noEmbed: false });
    const h5 = await g.hybrid.hybridSearch(engine, q.question, { limit: 5, expansion: false });
    const h10 = await g.hybrid.hybridSearch(engine, q.question, { limit: 10, expansion: false });
    return [h5, h10];
  });
  const reranked = raw5.some((r: any) => Number.isFinite(r.rerank_score)) && raw10.some((r: any) => Number.isFinite(r.rerank_score));
  if (!reranked) throw new Error('retrieval was not reranked (reranker skipped or failed); refusing to freeze an un-reranked list');
  const toHit = (r: any, i: number): FrozenHit => ({ rank: i + 1, slug: r.slug, page_id: r.page_id, chunk_id: r.chunk_id, chunk_index: r.chunk_index, chunk_source: r.chunk_source, score: r.rerank_score ?? r.score, text: store.put(r.chunk_text) });
  const hits5: FrozenHit[] = raw5.map(toHit), hits10: FrozenHit[] = raw10.map(toHit);

  // Every chunk of every page in the haystack enters the index hash; hit pages keep their chunk texts.
  const hitSlugs = new Set(hits10.map(h => h.slug));
  const allChunks: Array<{ slug: string; chunks: Array<{ chunk_index: number; chunk_source: string; text: string; chunk_id: number }> }> = [];
  const frozenPages: FrozenPage[] = [];
  for (const slug of bodyBySlug.keys()) {
    const chunks = ((await engine.getChunks(slug)) as any[]).sort((a, b) => a.chunk_index - b.chunk_index || String(a.chunk_source).localeCompare(String(b.chunk_source)));
    allChunks.push({ slug, chunks: chunks.map(c => ({ chunk_index: c.chunk_index, chunk_source: c.chunk_source, text: c.chunk_text, chunk_id: c.id })) });
    if (!hitSlugs.has(slug)) continue;
    const body = bodyBySlug.get(slug)!;
    frozenPages.push({
      slug, page_id: chunks[0]?.page_id ?? hits10.find(h => h.slug === slug)!.page_id, date: body.date, harness_body: store.put(body.content),
      chunks: chunks.map(c => ({ chunk_id: c.id, chunk_index: c.chunk_index, chunk_source: c.chunk_source, text: store.put(c.chunk_text) })),
    });
  }
  frozenPages.sort((a, b) => hits10.findIndex(h => h.slug === a.slug) - hits10.findIndex(h => h.slug === b.slug));

  const arms: Record<string, FrozenArm> = {};
  const textOf = (hash: string) => store.get(hash);
  const harnessArm = (blocks: FrozenBlock[], extra: Partial<FrozenArm> = {}): FrozenArm => {
    const texts = blocks.map(b => textOf(b.text));
    return { source: 'frozen', blocks, evidence_sha256: evidenceSha(blocks), product_encoding_tokens: texts.reduce((s, t) => s + count(t), 0), serialized_tool_tokens: null, duplicate_bodies: duplicateBodies(texts), ...extra };
  };
  arms.chunk = harnessArm(hits5.map(h => ({ slug: h.slug, text: h.text })));
  const sig = (hs: FrozenHit[]) => hs.slice(0, 5).map(h => `${h.slug}#${h.chunk_id}`).join(',');
  const k10 = packK10(hits10, h => textOf(h.text), count, k10Budget);
  arms.k10 = harnessArm(k10.kept.map(h => ({ slug: h.slug, text: h.text })), { shared_stream: sig(hits10) === sig(hits5) });
  const legacySlugs = [...new Set(hits5.map(h => h.slug))];
  arms.page_legacy = { ...harnessArm(legacySlugs.map(slug => ({ slug, text: store.put(bodyBySlug.get(slug)!.content) }))), source: 'harness' };

  if (g.evidence) {
    const hits = hits5.map(h => ({ source_id: 'default', slug: h.slug, chunk_id: h.chunk_id }));
    const assemble = async (unit: string, returnWindow: number | undefined, budget: number | null) => g.evidence!.assembleEvidenceForHits(engine, {
      hits, return_unit: unit, ...(returnWindow ? { return_window: returnWindow } : {}), ...(budget !== null ? { budget_tokens: budget } : {}), caller: { remote: false },
    });
    const productChunk = await assemble('chunk', undefined, null);
    const chunkTexts = productChunk.results.map((r: any) => r.chunk_text);
    const sameChunk = JSON.stringify(chunkTexts) === JSON.stringify(hits5.map(h => textOf(h.text)));
    arms.chunk = {
      ...arms.chunk, results: store.put(JSON.stringify(productChunk.results)), product_fingerprint: g.evidence.evidenceFingerprint(productChunk.results),
      delivery: productChunk.delivery ?? undefined, serialized_tool_tokens: count(JSON.stringify(productChunk.results, null, 2)),
      ...(sameChunk ? {} : { note: 'product chunk-mode text differs from the hybridSearch chunk text; the frozen chunk text is used' }),
    };
    for (const p of products) {
      const out = await assemble(p.unit, p.return_window, p.budget_tokens);
      const blocks = out.results.map((r: any) => ({ slug: r.slug, text: store.put(r.chunk_text) }));
      const texts = out.results.map((r: any) => r.chunk_text as string);
      arms[p.id] = {
        source: 'product', blocks, evidence_sha256: evidenceSha(blocks), results: store.put(JSON.stringify(out.results)),
        product_fingerprint: g.evidence.evidenceFingerprint(out.results), delivery: out.delivery,
        product_encoding_tokens: out.results.reduce((s: number, r: any) => s + (Number.isFinite(r.delivered?.tokens) ? r.delivered.tokens : count(r.chunk_text)), 0),
        serialized_tool_tokens: count(JSON.stringify(out.results, null, 2)), duplicate_bodies: duplicateBodies(texts),
        ...(out.unresolved?.length ? { note: `unresolved hits: ${JSON.stringify(out.unresolved)}` } : {}),
      };
    }
  }

  return {
    question_id: q.question_id, set: input.set, question_type: q.question_type ?? null, question_sha256: sha256(q.question), question_date: q.question_date,
    index_sha256: indexSha(allChunks, EMBEDDING), search_meta: { reranked, degraded: [], reranker_timeout_ms: RERANK_TIMEOUT_MS },
    hits5, hits10, pages: frozenPages, r1: compareWithR1(hits5, input.r1Retrieved), arms,
  };
}

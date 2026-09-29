// Component study, step 1: reproduce arm (a)'s retrieval for the seeded
// 100-question subset with gbrain's own functions (same pins as the harness:
// balanced, reranker off, autocut off, no expansion, top-k 5, the SAME embed
// cache) to recover the top-5 chunk TEXTS, which the harness rows do not store.
// Every question is checked against arm (a)'s recorded (slug, chunk_id) list.
// Run only when no other LongMemEval process is using the embed cache.
import { readFileSync } from 'node:fs';
import { embedMany } from 'ai';
import { M6, appendNdjson, dataset, readNdjson } from './lib.ts';
import { withBenchmarkBrain, resetTables } from 'GBRAIN_DIR/src/eval/longmemeval/harness.ts';
import { haystackToPages } from 'GBRAIN_DIR/src/eval/longmemeval/adapter.ts';
import { buildSlugToRawMap, rawSessionId } from 'GBRAIN_DIR/src/eval/longmemeval/metrics.ts';
import { importFromContent } from 'GBRAIN_DIR/src/core/import-file.ts';
import { hybridSearch } from 'GBRAIN_DIR/src/core/search/hybrid.ts';
import { EmbeddingCache, installEmbedCache } from 'GBRAIN_DIR/src/eval/shared/embed-cache.ts';

const ids = readFileSync(`${M6}/subset100_seed20260929.txt`, 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#'));
const aByQid = new Map(readNdjson(`${M6}/a/rows.ndjson`).filter(r => r.question_id).map(r => [r.question_id, r]));
const out = process.env.M6_CHUNKS_OUT ?? `${M6}/c/chunks.ndjson`;
const limit = Number(process.env.M6_LIMIT ?? 1e9);
const done = new Set(readNdjson(out).map(r => r.question_id));
const ds = dataset();
let misses = 0;
const transport = (async (p: any) => { misses += p.values.length; return embedMany(p); }) as typeof embedMany;

await withBenchmarkBrain(async (engine) => {
  await engine.setConfig('search.mode', 'balanced');
  await engine.setConfig('search.reranker.enabled', 'false');
  await engine.setConfig('search.autocut', 'false');
  const cache = new EmbeddingCache(process.env.M6_CACHE ?? `${M6}/embed-cache.sqlite`);
  const installed = installEmbedCache(cache, { realTransport: transport });
  try {
    for (const qid of ids.slice(0, limit)) {
      if (done.has(qid)) continue;
      const q: any = ds.get(qid)!;
      const slugToRaw = buildSlugToRawMap(q);
      await resetTables(engine);
      const pages = haystackToPages(q);
      const results = await cache.withTransaction(async () => {
        for (const p of pages) await importFromContent(engine, p.slug, p.content, { noEmbed: false });
        return hybridSearch(engine, q.question, { limit: 5, expansion: false });
      });
      const a = aByQid.get(qid);
      const aSig = (a?.retrieved ?? []).map((r: any) => `${r.slug}#${r.chunk_id}`).join(',');
      const sig = results.map(r => `${r.slug}#${r.chunk_id}`).join(',');
      const dateBySlug = new Map(pages.map((p, i) => [p.slug, q.haystack_dates[i]]));
      appendNdjson(out, {
        question_id: qid, matches_arm_a: aSig === sig, arm_a_sig: aSig, sig,
        chunks: results.map((r, i) => ({ rank: i + 1, slug: r.slug, chunk_id: r.chunk_id, chunk_index: (r as any).chunk_index,
          session_id: rawSessionId(r.slug, slugToRaw), date: dateBySlug.get(r.slug), chunk_text: r.chunk_text, score: r.score })),
      });
    }
  } finally {
    const s = cache.stats();
    console.error(`[c-retrieve] cache hits ${s.hits} misses ${s.misses}; transport values ${misses}`);
    installed.uninstall();
    cache.close();
  }
});
const rows = readNdjson(out);
console.error(`[c-retrieve] ${rows.length} rows; matches arm a: ${rows.filter(r => r.matches_arm_a).length}`);
process.exit(0);

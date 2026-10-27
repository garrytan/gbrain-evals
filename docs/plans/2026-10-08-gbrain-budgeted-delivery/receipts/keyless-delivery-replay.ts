// Keyless replay ($0): hash vectors, reranker off, no provider key in the environment. It measures delivery mechanics
// (what hybridSearch returns, what the query op's evidence stage delivers at a budget), never retrieval quality.
// Usage, from a gbrain-evals checkout at 9c07b7e2 with datasets fetched:
//   env -u OPENAI_API_KEY -u VOYAGE_API_KEY -u ANTHROPIC_API_KEY GBRAIN_DIR=<gbrain checkout> \
//     bun keyless-delivery-replay.ts locomo|lme-s [question-limit] > /dev/null   (writes replay-<bench>.json in the cwd)
// The committed outputs ran at gbrain master 7aa2caa, whose search and delivery files are identical to c5fb0201.
import { createHash } from 'node:crypto';
const MQA = `${process.cwd()}/eval/runner/memory-qa`;
const { loadLocomo, loadLmeS, renderSessionPage } = await import(`${MQA}/corpus.ts`);
const { selectQuestions, hashEmbed } = await import(`${MQA}/run.ts`);
const { approxTokens, renderHistory } = await import(`${MQA}/qa.ts`);
const G = `${process.env.GBRAIN_DIR ?? '../gbrain'}/src`;
const gateway = await import(`${G}/core/ai/gateway.ts`);
process.env.OPENAI_API_KEY = 'hash-embed-transport-no-provider-call';
gateway.configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: process.env });
gateway.__setEmbedTransportForTests(async (p: { values: string[] }) => ({ embeddings: p.values.map(v => hashEmbed(v, 1536)), values: p.values, warnings: [], usage: { tokens: 0 } }));
const { PGLiteEngine } = await import(`${G}/core/pglite-engine.ts`);
const { importFromContent } = await import(`${G}/core/import-file.ts`);
const { hybridSearch } = await import(`${G}/core/search/hybrid.ts`);
const ED = await import(`${G}/core/search/evidence-delivery.ts`);

const bench = process.argv[2]; const limitQ = Number(process.argv[3] ?? 0);
const corpus = bench === 'locomo' ? loadLocomo() : loadLmeS();
let qs = corpus.questions;
if (bench === 'locomo') { const dev = new Set(['conv-44', 'conv-47', 'conv-48']); qs = qs.filter(q => dev.has(q.conversation)); }
else qs = selectQuestions(qs, 100, 42);
if (limitQ) qs = qs.slice(0, limitQ);
const convs = new Map(corpus.conversations.map(c => [c.id, c]));
const slug = (sid: string) => `chat/${createHash('sha256').update(sid).digest('hex').slice(0, 16)}`;
const B = 8000;
const itemTok = (t: string) => approxTokens(`- (1, chunk) ${t.replace(/\s+/g, ' ').trim()}\n`);
const out: any[] = [];
let engine: any = null; let cur = '';
for (const q of qs) {
  const conv = convs.get(q.conversation)!;
  if (cur !== conv.id) {
    if (engine) await engine.disconnect();
    engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
    await engine.setConfig('search.reranker.enabled', 'false');
    for (const s of conv.sessions) await importFromContent(engine, slug(s.id), renderSessionPage(s, { as: 'conversation' }), {});
    cur = conv.id;
  }
  const bySlug = new Map(conv.sessions.map((s: any) => [slug(s.id), s] as const));
  const goldSlugs = new Set(q.gold.map(slug));
  const allGold = (slugs: Iterable<string>) => { const s = new Set(slugs); return goldSlugs.size > 0 && [...goldSlugs].every(g => s.has(g)); };
  // A: shootout adapter (limit 40 chunks, harness native pack)
  const hits40 = await hybridSearch(engine, q.question, { limit: 40 });
  let t = 0; const packedA: any[] = [];
  for (const h of hits40) { const c = itemTok(h.chunk_text ?? ''); if (t + c > B) break; t += c; packedA.push(h); }
  // D: harness rehydrated pack from A
  const order: string[] = []; for (const h of hits40) if (!order.includes(h.slug)) order.push(h.slug);
  let td = 0; const packedD: string[] = [];
  for (const sl of order) { const s = bySlug.get(sl); if (!s) continue; const c = approxTokens(renderHistory([s])); if (td + c > B) break; td += c; packedD.push(sl); }
  const row: any = { id: q.id, cat: q.category, gold: goldSlugs.size,
    A: { items: hits40.length, gbrain_ret_tokens: hits40.reduce((n: number, h: any) => n + itemTok(h.chunk_text ?? ''), 0), packed: packedA.length, tokens: t, sessions: new Set(packedA.map(h => h.slug)).size, all_gold: allGold(packedA.map(h => h.slug)), sessions_returned: order.length },
    D: { sessions: packedD.length, tokens: td, all_gold: allGold(packedD) } };
  for (const [name, limit, budget] of [['auto8k_l25', 25, 8000], ['auto24k_l25', 25, undefined], ['auto8k_l5', 5, 8000]] as const) {
    const hits = await hybridSearch(engine, q.question, { limit });
    const plan = await ED.resolveEvidencePlan(engine, { remote: false, returnUnit: 'auto', returnWindow: undefined, budget, snippetChars: undefined, snippetCap: 0, op: 'query' });
    const applied = ED.effectivePlan(plan, hits);
    const d = await ED.deliverEvidence(engine, hits, applied, {}, { liveHits: true });
    const res = d.results;
    let tp = 0; const packed: any[] = [];
    for (const r of res) { const c = itemTok(`${r.title ?? ''} ${r.chunk_text ?? ''}`); if (t !== null && tp + c > B) break; tp += c; packed.push(r); }
    row[name] = { hits: hits.length, blocks: res.length, pages: res.filter((r: any) => r.delivered?.unit === 'page').length,
      whole_pages: res.filter((r: any) => r.delivered?.unit === 'page' && !r.delivered.truncated).length,
      spilled: res.filter((r: any) => r.delivered?.reason === 'conversation_over_budget').length,
      budget: d.delivery.budget_tokens, budget_used: d.delivery.budget_used, harness_tokens_all: res.reduce((n: number, r: any) => n + itemTok(`${r.title ?? ''} ${r.chunk_text ?? ''}`), 0),
      harness_packed_blocks: packed.length, harness_packed_tokens: tp, all_gold_delivered: allGold(res.map((r: any) => r.slug)), all_gold_packed8k: allGold(packed.map((r: any) => r.slug)),
      gold_whole_pages: res.filter((r: any) => goldSlugs.has(r.slug) && r.delivered?.unit === 'page' && !r.delivered.truncated).length };
  }
  out.push(row);
  if (out.length % 25 === 0) console.error(`${out.length}/${qs.length}`);
}
if (engine) await engine.disconnect();
await Bun.write(`replay-${bench}.json`, JSON.stringify(out));
console.log('done', out.length);

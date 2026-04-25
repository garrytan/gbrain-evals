/**
 * BrainBench Cat 13b — Source Swamp Resistance
 *
 * Tests whether a curated `originals/` page wins ranking against multiple
 * competing `wintermute/chat/` pages that contain the same multi-word phrase.
 *
 * Where Cat 13 (Conceptual Recall) measures vector retrieval on paraphrase
 * and synonym, Cat 13b measures the source-aware ranking signal that
 * landed in gbrain v0.22.0 ... a corpus-level signal that says "curated
 * directories like originals/ should outrank bulk dumps like
 * wintermute/chat/ for non-temporal queries."
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
 * Pass criterion (gbrain adapter): top1_hit_rate >= 80%.
 *
 * Run:
 *   bun eval/runner/cat13b-source-swamp.ts
 *   bun eval/runner/cat13b-source-swamp.ts --adapter gbrain
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { runExtract } from 'gbrain/extract';
import { hybridSearch } from 'gbrain/search/hybrid';
import { importFromContent } from 'gbrain/import-file';
import type { Adapter, Page, Query, RankedDoc } from './types.ts';
import { sanitizePage, sanitizeQuery } from './types.ts';
import { RipgrepBm25Adapter } from './adapters/grep-only.ts';
import { VectorOnlyAdapter } from './adapters/vector.ts';
import { HybridNoGraphAdapter } from './adapters/vector-grep-rrf-fusion.ts';

const TOP_K = 5;

// ─── Corpus loader ────────────────────────────────────────────────

interface SwampPage extends Page {
  _facts?: { type?: string; name?: string; primary_phrase?: string };
}

function loadCorpus(dir: string): SwampPage[] {
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

// ─── 30 hand-curated queries ───────────────────────────────────────
//
// Each query: a multi-word phrase that appears in BOTH the curated
// target AND >=1 chat distractor. The query text is NOT one of the
// _facts fields (no leakage). Each curated page is targeted by 3 queries.

interface SwampQuery {
  id: string;
  text: string;
  /** The curated `originals/` page that should rank #1. */
  target: string;
  /** Chat pages known to contain the phrase (the "wrong-but-plausible" set). */
  competing: string[];
}

const QUERIES: SwampQuery[] = [
  // T1 — fat code thin harness (3 chat distractors)
  { id: 'q01', text: 'fat code thin harness pattern', target: 'originals/talks/article-outline-fat-code',
    competing: ['wintermute/chat/2026-04-01', 'wintermute/chat/2026-04-08', 'wintermute/chat/2026-04-17'] },
  { id: 'q02', text: 'thin harness fat skill files', target: 'originals/talks/article-outline-fat-code',
    competing: ['wintermute/chat/2026-04-08'] },
  { id: 'q03', text: 'fat code thin harness Part 3', target: 'originals/talks/article-outline-fat-code',
    competing: ['wintermute/chat/2026-04-08'] },

  // T2 — do things that don't scale, revisited (2 chat distractors)
  { id: 'q04', text: "do things that don't scale revisited", target: 'originals/essays/do-things-that-don-t-scale-revisited',
    competing: ['wintermute/chat/2026-04-15'] },
  { id: 'q05', text: 'unscalable founder work essay', target: 'originals/essays/do-things-that-don-t-scale-revisited',
    competing: ['wintermute/chat/2026-04-03', 'wintermute/chat/2026-04-15'] },
  { id: 'q06', text: 'do things that don\'t scale AI era', target: 'originals/essays/do-things-that-don-t-scale-revisited',
    competing: ['wintermute/chat/2026-04-03', 'wintermute/chat/2026-04-15'] },

  // T3 — product market fit trap (4 chat distractors, the most-swamped)
  { id: 'q07', text: 'product market fit trap article', target: 'originals/essays/product-market-fit-trap',
    competing: ['wintermute/chat/2026-04-01', 'wintermute/chat/2026-04-05', 'wintermute/chat/2026-04-15', 'wintermute/chat/2026-04-20'] },
  { id: 'q08', text: 'PMF threshold worship premature scaling', target: 'originals/essays/product-market-fit-trap',
    competing: ['wintermute/chat/2026-04-01', 'wintermute/chat/2026-04-15'] },
  { id: 'q09', text: 'channel confusion product market fit', target: 'originals/essays/product-market-fit-trap',
    competing: ['wintermute/chat/2026-04-01', 'wintermute/chat/2026-04-20'] },

  // T4 — founder mode reality check (3 chat distractors)
  { id: 'q10', text: 'founder mode reality check', target: 'originals/talks/founder-mode-reality-check',
    competing: ['wintermute/chat/2026-04-01', 'wintermute/chat/2026-04-10', 'wintermute/chat/2026-04-20'] },
  { id: 'q11', text: 'founder mode hands-on detail work', target: 'originals/talks/founder-mode-reality-check',
    competing: ['wintermute/chat/2026-04-01'] },
  { id: 'q12', text: 'founder default-mode organizational drag', target: 'originals/talks/founder-mode-reality-check',
    competing: ['wintermute/chat/2026-04-01', 'wintermute/chat/2026-04-10'] },

  // T5 — agentic workflows overhyped (4 chat distractors)
  { id: 'q13', text: 'agentic workflows overhyped take', target: 'originals/essays/agentic-workflows-overhyped',
    competing: ['wintermute/chat/2026-04-03', 'wintermute/chat/2026-04-08', 'wintermute/chat/2026-04-12', 'wintermute/chat/2026-04-20'] },
  { id: 'q14', text: 'multi-agent orchestration counter argument', target: 'originals/essays/agentic-workflows-overhyped',
    competing: ['wintermute/chat/2026-04-03'] },
  { id: 'q15', text: 'agentic workflows deterministic pipelines', target: 'originals/essays/agentic-workflows-overhyped',
    competing: ['wintermute/chat/2026-04-03', 'wintermute/chat/2026-04-12', 'wintermute/chat/2026-04-20'] },

  // T6 — late stage unit economics (3 chat distractors)
  { id: 'q16', text: 'late stage unit economics analysis', target: 'originals/essays/unit-economics-late-stage',
    competing: ['wintermute/chat/2026-04-05', 'wintermute/chat/2026-04-15', 'wintermute/chat/2026-04-22'] },
  { id: 'q17', text: 'CAC payback discount rates Series C', target: 'originals/essays/unit-economics-late-stage',
    competing: ['wintermute/chat/2026-04-05'] },
  { id: 'q18', text: 'revenue durability net retention compound', target: 'originals/essays/unit-economics-late-stage',
    competing: ['wintermute/chat/2026-04-05'] },

  // T7 — usage based pricing (2 chat distractors)
  { id: 'q19', text: 'usage based pricing YC talk', target: 'originals/talks/usage-based-pricing-yc',
    competing: ['wintermute/chat/2026-04-05', 'wintermute/chat/2026-04-22'] },
  { id: 'q20', text: 'commit and overage hybrid pricing', target: 'originals/talks/usage-based-pricing-yc',
    competing: ['wintermute/chat/2026-04-05', 'wintermute/chat/2026-04-22'] },
  { id: 'q21', text: 'usage based pricing customer bill predictability', target: 'originals/talks/usage-based-pricing-yc',
    competing: ['wintermute/chat/2026-04-05'] },

  // T8 — vertical SaaS thesis (2 chat distractors)
  { id: 'q22', text: 'vertical SaaS thesis investment writeup', target: 'originals/essays/vertical-saas-thesis',
    competing: ['wintermute/chat/2026-04-10', 'wintermute/chat/2026-04-22'] },
  { id: 'q23', text: 'industry-specific software AI commoditizes', target: 'originals/essays/vertical-saas-thesis',
    competing: ['wintermute/chat/2026-04-10'] },
  { id: 'q24', text: 'vertical SaaS marine logistics dental', target: 'originals/essays/vertical-saas-thesis',
    competing: ['wintermute/chat/2026-04-10', 'wintermute/chat/2026-04-22'] },

  // T9 — foundation models as utilities (3 chat distractors)
  { id: 'q25', text: 'foundation models as utilities essay', target: 'originals/essays/foundation-models-as-utilities',
    competing: ['wintermute/chat/2026-04-10', 'wintermute/chat/2026-04-12', 'wintermute/chat/2026-04-17'] },
  { id: 'q26', text: 'foundation models commoditize utility framing', target: 'originals/essays/foundation-models-as-utilities',
    competing: ['wintermute/chat/2026-04-10', 'wintermute/chat/2026-04-12'] },
  { id: 'q27', text: 'foundation models substitutability vendor diversification', target: 'originals/essays/foundation-models-as-utilities',
    competing: ['wintermute/chat/2026-04-12', 'wintermute/chat/2026-04-17'] },

  // T10 — RAG anti-patterns (3 chat distractors)
  { id: 'q28', text: 'RAG anti patterns talk', target: 'originals/talks/rag-pattern-anti-patterns',
    competing: ['wintermute/chat/2026-04-03', 'wintermute/chat/2026-04-12', 'wintermute/chat/2026-04-17'] },
  { id: 'q29', text: 'eight RAG anti patterns chunk-first cosine-only', target: 'originals/talks/rag-pattern-anti-patterns',
    competing: ['wintermute/chat/2026-04-12', 'wintermute/chat/2026-04-17'] },
  { id: 'q30', text: 'RAG swamp problem source-blind ranking', target: 'originals/talks/rag-pattern-anti-patterns',
    competing: ['wintermute/chat/2026-04-03', 'wintermute/chat/2026-04-12', 'wintermute/chat/2026-04-17'] },
];

// ─── Adapters ─────────────────────────────────────────────────────

class GbrainAdapter implements Adapter {
  readonly name = 'gbrain';
  async init(rawPages: Page[]): Promise<unknown> {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    const origLog = console.log;
    const origErr = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      for (const p of rawPages) {
        const fm: string[] = [
          `---`,
          `type: ${p.type}`,
          `title: ${JSON.stringify(p.title)}`,
          `---`,
          '',
          `# ${p.title}`,
          '',
          p.compiled_truth,
        ];
        if (p.timeline && p.timeline.trim().length > 0) {
          fm.push('', '## Timeline', '', p.timeline);
        }
        await importFromContent(engine, p.slug, fm.join('\n'));
      }
      await runExtract(engine, ['links', '--source', 'db']);
      await runExtract(engine, ['timeline', '--source', 'db']);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    return { engine };
  }

  async query(q: Query, state: unknown): Promise<RankedDoc[]> {
    const { engine } = state as { engine: PGLiteEngine };
    const chunkResults = await hybridSearch(engine, q.text, { limit: TOP_K * 6 });
    const pageBest = new Map<string, number>();
    for (const r of chunkResults) {
      const existing = pageBest.get(r.slug);
      if (existing === undefined || r.score > existing) pageBest.set(r.slug, r.score);
    }
    return [...pageBest.entries()]
      .map(([slug, score]) => ({ slug, score }))
      .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
      .slice(0, TOP_K)
      .map((p, i) => ({ page_id: p.slug, score: p.score, rank: i + 1 }));
  }

  async teardown(state: unknown): Promise<void> {
    const { engine } = state as { engine: PGLiteEngine };
    await engine.disconnect();
  }
}

// ─── Scorer ────────────────────────────────────────────────────────

interface SwampResult {
  name: string;
  top1_hit_rate: number;
  top3_hit_rate: number;
  swamp_at_top: number;
  per_query: { id: string; topSlug: string | null; targetRank: number; chatBeforeTarget: number }[];
  wallMs: number;
}

async function scoreAdapter(adapter: Adapter, pages: Page[], queries: SwampQuery[]): Promise<SwampResult> {
  const t0 = Date.now();
  const publicPages = pages.map(sanitizePage);
  const state = await adapter.init(publicPages, { name: adapter.name });
  let top1 = 0, top3 = 0, swamp = 0;
  const perQuery: SwampResult['per_query'] = [];

  for (const sq of queries) {
    const q: Query = {
      id: sq.id,
      tier: 'fuzzy',
      text: sq.text,
      expected_output_type: 'cited-source-pages',
      gold: { relevant: [sq.target] },
      tags: ['cat-13b', 'source-swamp'],
    };
    const results = await adapter.query(sanitizeQuery(q) as unknown as Query, state);
    const top = results.slice(0, TOP_K);
    const topSlug = top[0]?.page_id ?? null;
    const targetIdx = top.findIndex(r => r.page_id === sq.target);
    const targetRank = targetIdx >= 0 ? targetIdx + 1 : -1;
    let chatBefore = 0;
    for (const r of top) {
      if (r.page_id === sq.target) break;
      if (r.page_id.startsWith('wintermute/chat/')) chatBefore++;
    }
    if (topSlug === sq.target) top1++;
    if (targetIdx >= 0 && targetIdx < 3) top3++;
    if (chatBefore > 0) swamp++;
    perQuery.push({ id: sq.id, topSlug, targetRank, chatBeforeTarget: chatBefore });
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

async function main() {
  const argv = process.argv.slice(2);
  const onlyIdx = argv.indexOf('--adapter');
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : undefined;

  const corpusDir = join(import.meta.dir, '..', 'data', 'source-swamp-v1');
  const pages = loadCorpus(corpusDir);

  console.log(`# BrainBench Cat 13b — Source Swamp Resistance\n`);
  console.log(`Generated: ${new Date().toISOString().replace(/\..*$/, '')}`);
  console.log(`Corpus: ${pages.length} pages (${pages.filter(p => p.slug.startsWith('originals/')).length} originals/, ${pages.filter(p => p.slug.startsWith('wintermute/chat/')).length} chat/)`);
  console.log(`Queries: ${QUERIES.length} hand-curated source-swamp queries`);
  console.log(`Top-K: ${TOP_K}\n`);

  const allAdapters: Adapter[] = [
    new GbrainAdapter(),
    new HybridNoGraphAdapter(),
    new RipgrepBm25Adapter(),
    new VectorOnlyAdapter(),
  ];
  const adapters = only ? allAdapters.filter(a => a.name === only) : allAdapters;

  console.log(`## Running adapters\n`);
  const results: SwampResult[] = [];
  for (const a of adapters) {
    process.stdout.write(`- ${a.name} ...\n`);
    const r = await scoreAdapter(a, pages, QUERIES);
    console.log(`  done (${(r.wallMs / 1000).toFixed(1)}s). top1=${(r.top1_hit_rate * 100).toFixed(1)}%, top3=${(r.top3_hit_rate * 100).toFixed(1)}%, swamp=${(r.swamp_at_top * 100).toFixed(1)}%`);
    results.push(r);
  }

  results.sort((a, b) => b.top1_hit_rate - a.top1_hit_rate);

  console.log(`\n## Scorecard\n`);
  console.log(`| Adapter | Top-1 hit | Top-3 hit | Swamp@top (lower=better) | Wall (s) |`);
  console.log(`|---------|-----------|-----------|--------------------------|----------|`);
  for (const r of results) {
    console.log(`| ${r.name.padEnd(22)} | ${(r.top1_hit_rate * 100).toFixed(1)}% | ${(r.top3_hit_rate * 100).toFixed(1)}% | ${(r.swamp_at_top * 100).toFixed(1)}% | ${(r.wallMs / 1000).toFixed(1)} |`);
  }

  console.log(`\n## Per-query breakdown (gbrain only)\n`);
  const gbrainRes = results.find(r => r.name === 'gbrain');
  if (gbrainRes) {
    console.log(`| Query | Top slug | Target rank | Chat above target |`);
    console.log(`|-------|----------|-------------|-------------------|`);
    for (const pq of gbrainRes.per_query) {
      const tgt = QUERIES.find(q => q.id === pq.id)!;
      const win = pq.topSlug === tgt.target ? '✓' : '✗';
      const slugShort = (pq.topSlug ?? 'none').replace(/^wintermute\/chat\//, 'chat/').replace(/^originals\//, 'orig/');
      console.log(`| ${pq.id} ${win} | \`${slugShort}\` | ${pq.targetRank > 0 ? pq.targetRank : 'none'} | ${pq.chatBeforeTarget} |`);
    }
  }

  console.log(`\n## Methodology\n`);
  console.log(`- Corpus: 10 short curated \`originals/\` pages + 10 long \`wintermute/chat/\` pages.`);
  console.log(`- Each query is a multi-word phrase appearing in BOTH the curated target AND >=1 chat distractor.`);
  console.log(`- Strict target: the curated \`originals/\` page (qrel grade 3). Chat pages: distractors (grade 0).`);
  console.log(`- Pass criterion (gbrain adapter): top1_hit_rate >= 80%.`);
  console.log(`- Source-blind adapters (grep-only, vector) are EXPECTED to lose ... that's the point of the corpus.`);

  const gbrainPass = gbrainRes && gbrainRes.top1_hit_rate >= 0.80;
  if (gbrainPass) {
    console.log(`\n**PASS**: gbrain top-1 hit rate ${(gbrainRes!.top1_hit_rate * 100).toFixed(1)}% >= 80%.`);
  } else if (gbrainRes) {
    console.log(`\n**BELOW THRESHOLD**: gbrain top-1 hit rate ${(gbrainRes.top1_hit_rate * 100).toFixed(1)}% < 80%. Tune source-boost defaults.`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

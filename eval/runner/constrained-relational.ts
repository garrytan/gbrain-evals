/**
 * Constrained relational retrieval (plan P3, E4): seeded worlds from
 * eval/generators/constrained-relational-gen.ts, indexed with extraction and
 * real embeddings, then each question through gbrain's hybrid search. Arm
 * config comes from GBRAIN_EVAL_SEARCH_PINS (the decision kit sets it per arm,
 * e.g. `search.triplet_scoring=true`), so baseline and candidate builds run the
 * same questions on the same pages.
 *
 * Rows (one per question): ndcg_at_10, hit_at_1, hit_at_3, recall_all_at_5 over
 * distinct pages, and `fired` (the relational arm fired). The receipt reports
 * the fire rate; plan E4 requires at least 80%.
 *
 * Dev:       bun eval/runner/constrained-relational.ts [--seeds 11,13] [--gbrain <checkout>@<sha>] [--output <dir>] --paid --budget-usd 1
 * Options:   --embed-cache routes page and query embeddings through the shared content-addressed cache.
 * Custodian: --phrasing-file <custody path> --seeds <held-out seeds> --decision-id <id> --purpose <text>; the access is
 *            logged next to the phrasing file before it is read. Implementers run development seeds only.
 */
import './budget-ledger.ts';
import { join } from 'node:path';
import { budgetOptionsFrom, receiptCost, startPaidRun } from './budget-ledger.ts';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest } from './gbrain-under-test.ts';
import { GbrainInlineAdapter } from './adapters/gbrain-inline.ts';
import { ndcgAtK, recallAllAtK, uniqueInOrder } from './metrics.ts';
import { evalSearchPins, RELATIONAL_PINS } from './relational-ab.ts';
import { custodyTemplatesInput } from './sealed-confirmation-lib.ts';
import { EmbeddingCache, makeCachingTransport } from './longmemeval-cache.ts';
import { homedir } from 'node:os';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, receiptPath, sourceTreeIdentity, writeReceipt, type Receipt } from './receipt.ts';
import { gbrainPin } from './gbrain-version.ts';
import {
  CONSTRAINED_RELATIONAL_GENERATOR_VERSION, DEV_SEEDS, generateConstrainedRelationalWorld, validatePhrasing, type PhrasingTemplates,
} from '../generators/constrained-relational-gen.ts';

export const CATEGORY = 'constrained-relational';
const TOP_K = 10;

export interface CrRow {
  id: string; seed: number; template: string; neighbors: number; gold_count: number;
  fired: number; ndcg_at_10: number; hit_at_1: number; hit_at_3: number; recall_all_at_5: number; retrieved: string[];
}

const argValue = (argv: readonly string[], flag: string) => { const at = argv.indexOf(flag); return at >= 0 ? argv[at + 1] : undefined; };

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const seeds = (argValue(argv, '--seeds') ?? DEV_SEEDS.join(',')).split(',').map(Number);
  let sealedPhrasing: { id: string; templates: PhrasingTemplates } | undefined;
  let phrasingSha: string | null = null;
  const custody = custodyTemplatesInput(argv, seeds, DEV_SEEDS);
  if (custody) { phrasingSha = custody.sha256; sealedPhrasing = { id: custody.parsed.id, templates: validatePhrasing(custody.parsed.templates) }; }
  const outPath = argValue(argv, '--output') ? join(argValue(argv, '--output')!, 'receipt.json') : receiptPath(CATEGORY);
  const startedAt = new Date().toISOString();
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  const pins = { ...RELATIONAL_PINS, ...evalSearchPins() };
  const paid = startPaidRun(CATEGORY, { ...budgetOptionsFrom(argv), estimateUsd: 0.2 * seeds.length });
  const { hybridSearch } = await importGbrain<any>(gut, 'src/core/search/hybrid.ts');
  // --embed-cache: page and query embeddings go through one content-addressed cache, so arms run in separate processes
  // read identical vectors once the cache is warm (the receipt records hits and misses; a warm run has 0 misses).
  let cache: EmbeddingCache | null = null;
  if (argv.includes('--embed-cache')) {
    const gateway = await importGbrain<any>(gut, 'src/core/ai/gateway.ts');
    const { embedMany } = await import(Bun.resolveSync('ai', gut.root)) as { embedMany: (p: unknown) => Promise<unknown> };
    cache = new EmbeddingCache(join(process.env.GBRAIN_EVALS_EMBED_CACHE ?? join(homedir(), '.cache', 'gbrain-evals', 'embed-cache'), 'embed-cache-openai_text-embedding-3-large@1536.sqlite'), 'openai:text-embedding-3-large@1536');
    gateway.__setEmbedTransportForTests(makeCachingTransport(async (p: any) => embedMany(p) as never, cache));
  }

  const rows: CrRow[] = [];
  const fingerprints: Record<string, string> = {};
  const errors: Array<{ probe_id: string; origin: 'harness' | 'sut'; message: string }> = [];
  for (const seed of seeds) {
    const world = generateConstrainedRelationalWorld({ seed, sealedPhrasing });
    fingerprints[`world_seed_${seed}`] = world.fingerprint;
    const adapter = new GbrainInlineAdapter({
      topK: TOP_K, extract: true, searchConfig: pins, embeddingModel: 'openai:text-embedding-3-large', embeddingDimensions: 1536,
      expectStubTransport: false, embed: true, productRoot: gut.root,
    } as never);
    let state: unknown;
    try {
      state = await adapter.init(world.pages as never, { name: `${CATEGORY}-${seed}` } as never);
      const engine = adapter.engineOf(state as never) as any;
      for (const q of world.questions) {
        try {
          let fired = false;
          const results = await hybridSearch(engine, q.text, { limit: TOP_K * 3, expansion: false, onRelationalMeta: (m: { fired: boolean }) => { fired = fired || m.fired; } }) as Array<{ slug: string }>;
          const retrieved = uniqueInOrder(results.map(r => r.slug)).slice(0, TOP_K);
          const gold = new Set(q.gold);
          rows.push({ id: q.id, seed, template: q.template, neighbors: q.neighbors, gold_count: q.gold.length, fired: fired ? 1 : 0,
            ndcg_at_10: ndcgAtK(retrieved, new Map(q.gold.map(g => [g, 1])), 10), hit_at_1: retrieved.slice(0, 1).some(s => gold.has(s)) ? 1 : 0,
            hit_at_3: retrieved.slice(0, 3).some(s => gold.has(s)) ? 1 : 0, recall_all_at_5: recallAllAtK(retrieved, gold, 5), retrieved });
        } catch (e) {
          errors.push({ probe_id: q.id, origin: 'sut', message: String(e).slice(0, 300) });
        }
      }
    } catch (e) {
      errors.push({ probe_id: `seed-${seed}`, origin: 'harness', message: String(e).slice(0, 300) });
    } finally {
      if (state !== undefined) await adapter.teardown(state as never).catch(() => {});
    }
  }
  const cost = paid.run.close();
  paid.guard.uninstall();
  const embedCache = cache ? { ...cache.stats } : null;
  cache?.close();
  const mean = (k: keyof CrRow, rs = rows) => (rs.length ? rs.reduce((s, r) => s + Number(r[k]), 0) / rs.length : null);
  const summary = {
    n: rows.length, fire_rate: mean('fired'), ndcg_at_10: mean('ndcg_at_10'), hit_at_1: mean('hit_at_1'), hit_at_3: mean('hit_at_3'), recall_all_at_5: mean('recall_all_at_5'),
    by_template: Object.fromEntries([...new Set(rows.map(r => r.template))].map(t => {
      const rs = rows.filter(r => r.template === t);
      return [t, { n: rs.length, fire_rate: mean('fired', rs), ndcg_at_10: mean('ndcg_at_10', rs), hit_at_3: mean('hit_at_3', rs) }];
    })),
  };
  const total = rows.length + errors.length;
  const receipt = {
    schema_version: RECEIPT_SCHEMA_VERSION, benchmark_version: BENCHMARK_VERSION, category: CATEGORY,
    run_status: errors.some(e => e.origin === 'harness') ? 'error' : 'completed', ...(errors.length ? {} : { verdict: 'pass' }),
    n_total: total, n_scored: rows.length, completion_rate: total ? rows.length / total : 0, errors, publishable: false,
    gbrain_version: gut.version, gbrain_pin: gbrainPin(), execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(gut) },
    cost: receiptCost(cost),
    resolved_config: {
      engine: 'pglite-in-memory, extraction on, openai:text-embedding-3-large@1536', search_pins: pins, top_k: TOP_K, seeds,
      phrasing: sealedPhrasing ? `held-out set ${sealedPhrasing.id} (custody file sha256 ${phrasingSha})` : 'A (development)',
      generator_version: CONSTRAINED_RELATIONAL_GENERATOR_VERSION, gbrain_overlay: overlaySummary(gut), embed_cache: embedCache,
    },
    hashes: fingerprints, started_at: startedAt, finished_at: new Date().toISOString(),
    data: { summary, rows },
  } as unknown as Receipt;
  writeReceipt(outPath, receipt);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`receipt: ${outPath}`);
  process.exit(receipt.run_status === 'error' ? 3 : 0);
}

if (import.meta.main) main().catch(e => { console.error(e); process.exit(3); });

/**
 * memory-qa arm runner: one gbrain build, one benchmark split, one process.
 *
 *   bun eval/runner/memory-qa/run.ts --benchmark locomo|lme-s|beam-100k|beam-1m|fixture
 *     [--split dev] [--gbrain <checkout>[@ref]] [--config key=value]... [--pin key=value]...
 *     [--embed hash|real] [--embedding-model provider:model --embedding-dims N]
 *     [--categories a,b] [--limit N] [--seed N] [--top-k 10] [--shard i/n]
 *     [--paid --budget-run-id <id>] --output <dir>
 *
 * What it measures: judge-free session retrieval. Each conversation's
 * sessions are imported as pages into a fresh in-memory gbrain (PGLite), the
 * question goes through gbrain's hybrid search with the pinned search config
 * plus this arm's config overrides, and the retrieved chunks are reduced to
 * distinct sessions in rank order. Rows carry recall_all@5 (every gold
 * session in the top five distinct sessions), recall_any@5, recall_all@10,
 * nDCG@10 and latency. Abstention questions have no gold and are marked so a
 * comparison family excludes them.
 *
 * The arm imports gbrain only through `importGbrain`, so `--gbrain` really
 * selects the build under test; the decision kit runs baseline and candidate
 * as separate processes. Gold ids, categories and answers never reach gbrain.
 *
 * Fidelity: a page saved without vectors (embedding_deferred) under an
 * embedding arm, or a pinned reranker that never stamps a rerank score, marks
 * the run `invalid` — it measured a different pipeline than the one named.
 */
import '../budget-ledger.ts';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { budgetOptionsFrom, startPaidRun, receiptCost, type BudgetRun, type PaidRequestGuard } from '../budget-ledger.ts';
import { requirePaidArm } from '../paid-arm.ts';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from '../gbrain-under-test.ts';
import { EmbeddingCache, makeCachingTransport } from '../longmemeval-cache.ts';
import { ndcgAtK, recallAllAtK, recallAnyAtK, uniqueInOrder, percentile } from '../metrics.ts';
import { loadCorpus, occurrenceId, renderSessionPage, type Corpus, type MemoryQuestion } from './corpus.ts';
import { devConversations } from '../decisions/splits.ts';
import { decideError, DecideError, renderOperatorMessage } from '../decisions/errors.ts';

export interface RunArgs {
  benchmark: string;
  split: 'dev';
  gbrain: string | null;
  config: Record<string, string>;
  pins: Record<string, string>;
  embed: 'hash' | 'real';
  embeddingModel: string;
  embeddingDims: number;
  categories: string[] | null;
  limit: number | null;
  seed: number;
  topK: number;
  shard: { index: number; count: number };
  output: string;
  argv: string[];
}

export interface MemoryQaRow {
  id: string;
  conversation: string;
  category: string;
  abstention: boolean;
  gold_count: number;
  recall_all_at_5?: number;
  recall_any_at_5?: number;
  recall_all_at_10?: number;
  ndcg_at_10?: number;
  retrieved?: string[];
  latency_ms?: number;
  error?: string | null;
  error_origin?: 'sut' | 'harness' | 'dependency';
}

const DEFAULT_PINS: Record<string, string> = { 'search.mode': 'balanced', 'search.reranker.enabled': 'false', 'search.autocut': 'false' };
const RECYCLE_EVERY = 25;
const PRESERVE_TABLES = new Set(['sources', 'config', 'gbrain_cycle_locks', 'subagent_rate_leases']);

function kv(list: string[], flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of list) {
    const at = item.indexOf('=');
    if (at <= 0) throw new Error(`${flag} needs key=value (got ${item})`);
    out[item.slice(0, at)] = item.slice(at + 1);
  }
  return out;
}

export function parseRunArgs(argv: string[]): RunArgs {
  const one = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const many = (name: string) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
  const benchmark = one('--benchmark');
  if (!benchmark) throw new Error('--benchmark is required');
  const output = one('--output');
  if (!output) throw new Error('--output <dir> is required');
  const split = one('--split') ?? 'dev';
  if (split !== 'dev') throw decideError({ code: 'SEALED_SOURCE_IN_DEV', message: `--split ${split} is not available to dev runs`,
    why: 'sealed conversations open only through the custodian at a preregistered decision', fix: { next: 'ask_user', user_message: 'request a held-out run from the custodian with `bun run eval:decide request`' } });
  const shardRaw = one('--shard') ?? '0/1';
  const [si, sn] = shardRaw.split('/').map(Number);
  if (!Number.isInteger(si) || !Number.isInteger(sn) || sn < 1 || si < 0 || si >= sn) throw new Error('--shard must look like i/n with 0 <= i < n');
  const embed = (one('--embed') ?? (benchmark === 'fixture' ? 'hash' : 'real')) as 'hash' | 'real';
  if (!['hash', 'real'].includes(embed)) throw new Error('--embed must be hash or real');
  return {
    benchmark, split: 'dev', gbrain: gbrainSpecFrom(argv), config: kv(many('--config'), '--config'),
    pins: { ...DEFAULT_PINS, ...kv(many('--pin'), '--pin') }, embed,
    embeddingModel: one('--embedding-model') ?? 'openai:text-embedding-3-large',
    embeddingDims: Number(one('--embedding-dims') ?? 1536),
    categories: one('--categories') ? one('--categories')!.split(',').map(s => s.trim()).filter(Boolean) : null,
    limit: one('--limit') ? Number(one('--limit')) : null,
    seed: Number(one('--seed') ?? 42), topK: Number(one('--top-k') ?? 10),
    shard: { index: si, count: sn }, output: resolve(output), argv,
  };
}

/** Deterministic, category-stratified subset: questions sorted by sha256(seed, id) within each category, round-robin across categories. */
export function selectQuestions(questions: MemoryQuestion[], limit: number | null, seed: number): MemoryQuestion[] {
  if (limit === null || limit >= questions.length) return questions;
  const key = (q: MemoryQuestion) => createHash('sha256').update(`${seed}\u0000${q.id}`).digest('hex');
  const byCat = new Map<string, MemoryQuestion[]>();
  for (const q of questions) byCat.set(q.category, [...(byCat.get(q.category) ?? []), q]);
  for (const list of byCat.values()) list.sort((a, b) => (key(a) < key(b) ? -1 : 1));
  const cats = [...byCat.keys()].sort();
  const out: MemoryQuestion[] = [];
  for (let round = 0; out.length < limit; round++) {
    let added = false;
    for (const c of cats) {
      const q = byCat.get(c)![round];
      if (q && out.length < limit) { out.push(q); added = true; }
    }
    if (!added) break;
  }
  return out;
}

export function scoreRetrieval(retrieved: string[], gold: string[]): Pick<MemoryQaRow, 'recall_all_at_5' | 'recall_any_at_5' | 'recall_all_at_10' | 'ndcg_at_10'> {
  const rel = new Set(gold);
  const grades = new Map(gold.map(g => [g, 1]));
  return {
    recall_all_at_5: recallAllAtK(retrieved, rel, 5), recall_any_at_5: recallAnyAtK(retrieved, rel, 5),
    recall_all_at_10: recallAllAtK(retrieved, rel, 10), ndcg_at_10: ndcgAtK(retrieved, grades, 10),
  };
}

export function hashEmbed(text: string, dims: number): number[] {
  const vec = new Array<number>(dims).fill(0);
  const tokens = new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2));
  for (const tok of tokens) vec[createHash('sha256').update(tok).digest().readUInt32BE(0) % dims] += 1;
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
  return vec.map(x => x / norm);
}

const PROVIDER_KEY: Record<string, string> = { openai: 'OPENAI_API_KEY', voyage: 'VOYAGE_API_KEY', google: 'GOOGLE_GENERATIVE_AI_API_KEY' };

export function runConfigHash(a: RunArgs, gut: GbrainUnderTest, corpus: Corpus): string {
  const pre = { benchmark: a.benchmark, split: a.split, config: a.config, pins: a.pins, embed: a.embed, model: a.embeddingModel, dims: a.embeddingDims,
    categories: a.categories, limit: a.limit, seed: a.seed, topK: a.topK, gbrain: gut.overlay?.build.commit ?? gut.version, data: corpus.source.files };
  return createHash('sha256').update(JSON.stringify(pre)).digest('hex');
}

export async function runArm(a: RunArgs): Promise<{ receipt: Record<string, unknown>; rows: MemoryQaRow[] }> {
  const started = new Date().toISOString();
  mkdirSync(a.output, { recursive: true });
  const gut = resolveGbrainUnderTest(a.gbrain);
  const corpus = loadCorpus(a.benchmark);
  const allowed = devConversations(a.benchmark);
  let questions = corpus.questions.filter(q => !allowed || allowed.has(q.conversation));
  if (a.categories) questions = questions.filter(q => a.categories!.includes(q.category));
  questions = selectQuestions(questions, a.limit, a.seed);
  const convIds = uniqueInOrder(questions.map(q => q.conversation)).sort();
  const myConvs = convIds.filter((_, i) => i % a.shard.count === a.shard.index);
  const byConv = new Map(corpus.conversations.map(c => [c.id, c]));

  const hash = runConfigHash(a, gut, corpus);
  const rowsPath = join(a.output, 'rows.ndjson');
  const headerPath = join(a.output, 'run-config.json');
  const done = new Set<string>();
  if (existsSync(headerPath)) {
    const prior = JSON.parse(readFileSync(headerPath, 'utf8')) as { run_config_hash: string };
    if (prior.run_config_hash !== hash) throw new Error(`${a.output} holds rows from a different run configuration; use a fresh --output`);
    if (existsSync(rowsPath)) for (const line of readFileSync(rowsPath, 'utf8').split('\n')) if (line.trim()) {
      const r = JSON.parse(line) as MemoryQaRow;
      if (!r.error) done.add(r.id);
    }
  }
  writeFileSync(headerPath, JSON.stringify({ run_config_hash: hash, benchmark: a.benchmark, shard: a.shard }, null, 2));

  // Gateway: hash vectors (keyless) or the real provider through the budget ledger and the content-addressed cache.
  const gateway = await importGbrain<{ configureGateway: (c: Record<string, unknown>) => void; __setEmbedTransportForTests: (fn: unknown) => void }>(gut, 'src/core/ai/gateway.ts');
  let paid: { run: BudgetRun; guard: PaidRequestGuard } | null = null;
  let cache: EmbeddingCache | null = null;
  const provider = a.embeddingModel.split(':')[0];
  if (a.embed === 'hash') {
    const keyEnv = PROVIDER_KEY[provider] ?? 'OPENAI_API_KEY';
    if (!process.env[keyEnv]) process.env[keyEnv] = 'hash-embed-transport-no-provider-call';
    gateway.configureGateway({ embedding_model: a.embeddingModel, embedding_dimensions: a.embeddingDims, env: process.env });
    gateway.__setEmbedTransportForTests(async (params: { values: string[] }) => ({ embeddings: params.values.map(v => hashEmbed(v, a.embeddingDims)), values: params.values, warnings: [], usage: { tokens: 0 } }));
  } else {
    const perQuestion: Record<string, number> = { 'lme-s': 0.012, locomo: 0.002, 'beam-100k': 0.01, 'beam-1m': 0.03, fixture: 0 };
    const mine = questions.filter(q => myConvs.includes(q.conversation)).length;
    const estimate = Math.max(0.05, Math.round((perQuestion[a.benchmark] ?? 0.02) * mine * 100) / 100);
    try { requirePaidArm(a.argv, { arm: `memory-qa ${a.benchmark}`, estimateUsd: estimate }); }
    catch (e) {
      throw decideError({ code: 'PAID_FLAGS_MISSING', message: (e as Error).message, why: 'real embeddings call a paid provider, and every paid request is reserved in the budget ledger first',
        fix: { next: 'run', argv: ['bun', 'eval/runner/budget-ledger.ts', 'status'], verify: ['bun', 'eval/runner/budget-ledger.ts', 'status'] } });
    }
    paid = startPaidRun(`memory-qa:${a.benchmark}`, { ...budgetOptionsFrom(a.argv), estimateUsd: estimate });
    gateway.configureGateway({ embedding_model: a.embeddingModel, embedding_dimensions: a.embeddingDims, env: process.env });
    const aiPath = Bun.resolveSync('ai', gut.root);
    const { embedMany } = await import(aiPath) as { embedMany: (p: unknown) => Promise<unknown> };
    const cacheDir = process.env.GBRAIN_EVALS_EMBED_CACHE ?? join(homedir(), '.cache', 'gbrain-evals', 'embed-cache');
    mkdirSync(cacheDir, { recursive: true });
    const key = `${a.embeddingModel}@${a.embeddingDims}`;
    cache = new EmbeddingCache(join(cacheDir, `embed-cache-${key.replace(/[^a-z0-9@-]/gi, '_')}.sqlite`), key);
    gateway.__setEmbedTransportForTests(makeCachingTransport(async (p: { values: string[] } & Record<string, unknown>) => embedMany(p) as never, cache));
  }

  const { PGLiteEngine } = await importGbrain<{ PGLiteEngine: new () => any }>(gut, 'src/core/pglite-engine.ts');
  const { importFromContent } = await importGbrain<{ importFromContent: (e: unknown, slug: string, content: string, o?: Record<string, unknown>) => Promise<{ embedding_deferred?: boolean }> }>(gut, 'src/core/import-file.ts');
  const { hybridSearch } = await importGbrain<{ hybridSearch: (e: unknown, q: string, o?: Record<string, unknown>) => Promise<Array<{ slug: string; rerank_score?: number }>> }>(gut, 'src/core/search/hybrid.ts');

  const openEngine = async () => {
    const e = new PGLiteEngine();
    await e.connect({});
    await e.initSchema();
    for (const [k, v] of Object.entries({ ...a.pins, ...a.config })) await e.setConfig(k, v);
    return e;
  };
  const reset = async (e: any) => {
    const rows = await e.executeRaw(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`) as Array<{ tablename: string }>;
    const targets = rows.map(r => r.tablename).filter(t => !PRESERVE_TABLES.has(t));
    if (targets.length) await e.executeRaw(`TRUNCATE ${targets.map(t => `"${t.replace(/"/g, '""')}"`).join(', ')} RESTART IDENTITY CASCADE`);
  };

  const rerankPinned = (a.config['search.reranker.enabled'] ?? a.pins['search.reranker.enabled']) === 'true';
  const fidelity = { embedding_deferred_pages: 0, rerank_missing_queries: 0, reranked_queries: 0 };
  const rows: MemoryQaRow[] = [];
  let engine = await openEngine();
  let processed = 0;
  try {
    for (const convId of myConvs) {
      const qs = questions.filter(q => q.conversation === convId && !done.has(q.id));
      if (!qs.length) continue;
      if (paid?.guard.exhausted) break;
      if (processed > 0 && processed % RECYCLE_EVERY === 0) { try { await engine.disconnect(); } catch { /* ignore */ } engine = await openEngine(); }
      else if (processed > 0) await reset(engine);
      processed++;
      const conv = byConv.get(convId)!;
      const bySlug = new Map<string, string>();
      let importError: string | null = null;
      for (const s of conv.sessions) {
        const slug = `chat/${occurrenceId(conv.id, s.id)}`;
        bySlug.set(slug, s.id);
        try {
          const res = await importFromContent(engine, slug, renderSessionPage(s), {});
          if (res?.embedding_deferred) fidelity.embedding_deferred_pages++;
        } catch (e) { importError = (e as Error).message; break; }
      }
      for (const q of qs) {
        const base: MemoryQaRow = { id: q.id, conversation: q.conversation, category: q.category, abstention: q.abstention, gold_count: q.gold.length };
        let row: MemoryQaRow;
        if (importError) row = { ...base, error: `import failed: ${importError}`, error_origin: 'sut' };
        else {
          const t0 = performance.now();
          try {
            const results = await hybridSearch(engine, q.question, { limit: a.topK * 3, expansion: false });
            const latency = performance.now() - t0;
            if (rerankPinned && results.length) {
              if (results.some(r => r.rerank_score !== undefined)) fidelity.reranked_queries++;
              else fidelity.rerank_missing_queries++;
            }
            const retrieved = uniqueInOrder(results.map(r => bySlug.get(r.slug) ?? `?${r.slug}`)).slice(0, a.topK);
            row = { ...base, ...scoreRetrieval(retrieved, q.gold), retrieved, latency_ms: Math.round(latency * 10) / 10, error: null };
          } catch (e) {
            row = { ...base, error: (e as Error).message, error_origin: /budget|BudgetExceeded/i.test((e as Error).message) ? 'harness' : 'sut' };
          }
        }
        rows.push(row);
        appendFileSync(rowsPath, JSON.stringify(row) + '\n');
      }
    }
  } finally {
    try { await engine.disconnect(); } catch { /* ignore */ }
    cache?.close();
  }

  const allRows: MemoryQaRow[] = readFileSync(rowsPath, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  const scored = allRows.filter(r => !r.abstention && !r.error && r.gold_count > 0);
  const mean = (k: keyof MemoryQaRow) => scored.length ? scored.reduce((s, r) => s + Number(r[k] ?? 0), 0) / scored.length : null;
  const invalidReasons: string[] = [];
  if (fidelity.embedding_deferred_pages > 0) invalidReasons.push(`${fidelity.embedding_deferred_pages} pages were saved without vectors (embedding_deferred), so vector retrieval was not what ran`);
  if (rerankPinned && fidelity.rerank_missing_queries > 0) invalidReasons.push(`${fidelity.rerank_missing_queries} queries came back without rerank scores although the reranker is pinned on`);
  const expected = questions.filter(q => myConvs.includes(q.conversation)).length;
  const runStatus = invalidReasons.length ? 'invalid' : allRows.length < expected ? 'partial' : 'complete';
  let cost: Record<string, unknown> | null = null;
  if (paid) {
    const summary = paid.run.close();
    paid.guard.uninstall();
    cost = receiptCost(summary) as unknown as Record<string, unknown>;
  }
  const receipt = {
    kind: 'memory-qa-arm', schema_version: 1, benchmark: a.benchmark, split: a.split, run_status: runStatus, invalid_reasons: invalidReasons,
    started_at: started, finished_at: new Date().toISOString(), run_config_hash: hash,
    product: productIdentityFor(gut), overlay: overlaySummary(gut), arm_config: a.config, search_pins: a.pins,
    retrieval_path: 'hybridSearch (expansion off), chunks reduced to distinct sessions',
    embedding: { mode: a.embed, model: a.embeddingModel, dims: a.embeddingDims, cache_stats: cache ? { ...cache.stats } : null },
    dataset: corpus.source, selection: { categories: a.categories, limit: a.limit, seed: a.seed, shard: a.shard, conversations: myConvs.length, questions_expected: expected },
    counts: { rows: allRows.length, scored: scored.length, errors: allRows.filter(r => r.error).length, abstention: allRows.filter(r => r.abstention).length },
    summary: { recall_all_at_5: mean('recall_all_at_5'), recall_any_at_5: mean('recall_any_at_5'), recall_all_at_10: mean('recall_all_at_10'), ndcg_at_10: mean('ndcg_at_10'),
      latency_p50_ms: scored.length ? percentile(scored.map(r => r.latency_ms ?? 0), 50) : null, latency_p95_ms: scored.length ? percentile(scored.map(r => r.latency_ms ?? 0), 95) : null },
    fidelity, cost, rows_file: 'rows.ndjson',
  };
  writeFileSync(join(a.output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  return { receipt, rows: allRows };
}

if (import.meta.main) {
  try {
    const a = parseRunArgs(process.argv.slice(2));
    const { receipt } = await runArm(a);
    const s = receipt.summary as Record<string, number | null>;
    process.stderr.write(`[memory-qa] ${a.benchmark} ${receipt.run_status}: ${(receipt.counts as Record<string, number>).scored} scored, recall_all@5 ${s.recall_all_at_5?.toFixed(4) ?? 'n/a'}; receipt ${join(a.output, 'receipt.json')}\n`);
    process.exit(receipt.run_status === 'invalid' ? 4 : 0);
  } catch (e) {
    if (e instanceof DecideError) { process.stderr.write(renderOperatorMessage(e.op) + '\n'); process.exit(e.op.fix.next === 'ask_user' ? 3 : 2); }
    throw e;
  }
}

/**
 * BrainBench: LongMemEval (public benchmark adapter)
 *
 * Runs gbrain's hybrid retrieval against the public LongMemEval benchmark
 * (xiaowu0162/longmemeval on HuggingFace). Each question carries a haystack
 * of conversation sessions plus ground-truth `answer_session_ids` — the
 * sessions that actually contain the answer. We measure retrieval recall@k:
 * "did at least one ground-truth session land in the top K results?"
 *
 * Design decisions:
 *
 *   1. **One PGLite per benchmark run, not per question.** Reset-in-place
 *      via TRUNCATE between questions. Runtime-enumerated tables via
 *      pg_tables so future schema migrations don't silently leak data
 *      across questions. Same architecture as `gbrain eval longmemeval`.
 *
 *   2. **Two adapters compared:** keyword-only (no embedding API calls)
 *      and hybrid (keyword + vector via OpenAI text-embedding-3-large).
 *      No --expansion: deterministic, comparable across runs.
 *
 *   3. **Retrieval recall, not QA accuracy.** No LLM judge required. The
 *      LongMemEval `_s` split labels every question with the session_ids
 *      that contain the answer. Recall@k against that set is unambiguous.
 *      We do NOT generate answers via Claude/GPT here — that's a separate
 *      benchmark dimension that needs an LLM judge to score.
 *
 * Run:
 *   bun eval/runner/longmemeval.ts                    # full 500-Q run
 *   bun eval/runner/longmemeval.ts --limit 25         # smoke test
 *   bun eval/runner/longmemeval.ts --keyword-only     # skip embeddings
 *   bun eval/runner/longmemeval.ts --dataset oracle   # easy split (3 sess/Q)
 *   bun eval/runner/longmemeval.ts --top-k 5          # default 8
 *
 * Dataset: download to ~/datasets/longmemeval/longmemeval_s.json from
 *   https://huggingface.co/datasets/xiaowu0162/longmemeval
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { hybridSearch } from 'gbrain/search/hybrid';
import { expandQuery } from 'gbrain/search/expansion';
import type { SearchResult } from 'gbrain/types';
import { loadConfig } from 'gbrain/config';
import { embed } from 'gbrain/embedding';
import { configureGateway, __setEmbedTransportForTests } from 'gbrain/ai/gateway';
// `ai` is a direct dependency of this repo (pinned to gbrain's major) — the
// old deep import into gbrain's nested node_modules broke on any packaged
// install because bun hoists the dependency (audit finding longmemeval-07).
import { embedMany as aiSdkEmbedMany } from 'ai';
import { EmbeddingCache, makeCachingTransport } from './longmemeval-cache.ts';

// ─── CLI ──────────────────────────────────────────────────────────

interface Opts {
  datasetPath: string;
  datasetName: string;
  limit: number | null;
  stratify: number | null;
  topK: number;
  keywordOnly: boolean;
  /** Comma-separated subset of {keyword,vector,hybrid,hybrid+expansion}; default: all four. */
  adapters: string[];
  cacheDir: string;
  noCache: boolean;
  output: string;
  /** Per-question NDJSON stream path. Resume-friendly: existing rows are skipped. */
  ndjsonPath: string;
  /** Wall-clock budget; exit cleanly when exceeded so a wrapper can restart. */
  maxWallSeconds: number | null;
  /** Worker shard: this process handles questions where `i % totalWorkers === workerId`. */
  workerId: number;
  totalWorkers: number;
}

function parseOpts(): Opts {
  const args = process.argv.slice(2);
  const datasetSplit = arg(args, '--dataset') ?? 's';
  const home = homedir();
  const fname = datasetSplit === 'oracle'
    ? 'longmemeval_oracle.json'
    : datasetSplit === 's'
      ? 'longmemeval_s.json'
      : `longmemeval_${datasetSplit}.json`;
  const adaptersArg = arg(args, '--adapters');
  const adapters = adaptersArg
    ? adaptersArg.split(',').map(s => s.trim()).filter(Boolean)
    : args.includes('--keyword-only')
      ? ['keyword']
      : ['keyword', 'vector', 'hybrid', 'hybrid+expansion'];
  return {
    datasetPath: arg(args, '--path') ?? join(home, 'datasets', 'longmemeval', fname),
    datasetName: datasetSplit,
    limit: arg(args, '--limit') ? Number(arg(args, '--limit')) : null,
    stratify: arg(args, '--stratify') ? Number(arg(args, '--stratify')) : null,
    topK: Number(arg(args, '--top-k') ?? '8'),
    keywordOnly: args.includes('--keyword-only'),
    adapters,
    // Default cache lives under eval/reports/ which is gitignored — the
    // SQLite cache for the full _s split is ~700MB, too big to commit
    // under plain git. First run pays ~$2 in OpenAI embeddings; the
    // SHA-256(text) keying makes the cache content-addressed so subsequent
    // runs hit cache and complete in minutes for ~$0. To share warm cache
    // across machines, copy the file in the embed-cache/ directory.
    cacheDir: arg(args, '--cache-dir') ?? join(import.meta.dir, '..', 'reports', 'longmemeval', 'embed-cache'),
    noCache: args.includes('--no-cache'),
    output: arg(args, '--output') ?? '',
    ndjsonPath: arg(args, '--ndjson') ?? '',
    maxWallSeconds: arg(args, '--max-wall-seconds') ? Number(arg(args, '--max-wall-seconds')) : null,
    workerId: arg(args, '--worker-id') ? Number(arg(args, '--worker-id')) : 0,
    totalWorkers: arg(args, '--total-workers') ? Number(arg(args, '--total-workers')) : 1,
  };
}

/**
 * Read an existing NDJSON stream and return the set of (adapter, question_id)
 * pairs already completed. The wrapper loop relies on this for resume.
 */
function readCompletedPairs(path: string): Set<string> {
  const done = new Set<string>();
  if (!path || !existsSync(path)) return done;
  const raw = readFileSync(path, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj?.adapter && obj?.question_id) {
        done.add(`${obj.adapter}::${obj.question_id}`);
      }
    } catch { /* skip malformed line */ }
  }
  return done;
}

/**
 * Pick the first N questions of each question_type (deterministic, dataset
 * order). Falls back to all-of-type if N exceeds the type's count.
 */
function stratifiedSample(questions: Question[], perType: number): Question[] {
  const buckets: Record<string, Question[]> = {};
  for (const q of questions) {
    (buckets[q.question_type] ??= []).push(q);
  }
  const out: Question[] = [];
  for (const t of Object.keys(buckets).sort()) {
    out.push(...buckets[t].slice(0, perType));
  }
  return out;
}

function arg(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

// ─── Dataset shape ────────────────────────────────────────────────

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

interface Session {
  session_id?: string;
  turns?: Turn[];
}

interface Question {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  haystack_dates?: string[];
  haystack_session_ids?: string[];
  haystack_sessions: Session[] | Turn[][];
  answer_session_ids: string[];
}

// LongMemEval _s shape uses array of arrays for haystack_sessions (each
// inner array is the turns of that session). Oracle uses {session_id, turns}.
// Normalize to {session_id, turns}.
function normalizeSessions(q: Question): Array<{ session_id: string; turns: Turn[]; date?: string }> {
  const sessions: Array<{ session_id: string; turns: Turn[]; date?: string }> = [];
  const ids = q.haystack_session_ids ?? [];
  const dates = q.haystack_dates ?? [];
  const raw = q.haystack_sessions;
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as any;
    if (Array.isArray(item)) {
      // _s shape: array of turns
      const sid = ids[i] ?? `lme_${q.question_id}_${i}`;
      sessions.push({ session_id: sid, turns: item, date: dates[i] });
    } else if (item && typeof item === 'object' && Array.isArray(item.turns)) {
      // Oracle shape: {session_id, turns}
      sessions.push({
        session_id: item.session_id ?? `lme_${q.question_id}_${i}`,
        turns: item.turns,
        date: dates[i],
      });
    }
  }
  return sessions;
}

function renderSession(session: { session_id: string; turns: Turn[]; date?: string }): string {
  const fm: string[] = ['---', 'type: note'];
  if (session.date) fm.push(`date: ${session.date}`);
  fm.push(`session_id: ${session.session_id}`, '---', '');
  const body: string[] = [];
  for (const turn of session.turns) {
    body.push(`**${turn.role}:** ${turn.content}`);
    body.push('');
  }
  return fm.join('\n') + body.join('\n');
}

// ─── Harness ──────────────────────────────────────────────────────

const PRESERVE_TABLES = new Set(['sources', 'config', 'gbrain_cycle_locks', 'subagent_rate_leases']);

async function resetTables(engine: PGLiteEngine): Promise<void> {
  const rows = await engine.executeRaw<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const targets = rows.map(r => r.tablename).filter(t => !PRESERVE_TABLES.has(t));
  if (targets.length === 0) return;
  const list = targets.map(t => `"${t.replace(/"/g, '""')}"`).join(', ');
  await engine.executeRaw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

function sessionIdFromSlug(slug: string): string {
  const idx = slug.indexOf('/');
  return idx >= 0 ? slug.slice(idx + 1) : slug;
}

function uniqSessionIds(results: SearchResult[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of results) {
    const sid = sessionIdFromSlug(r.slug);
    if (!seen.has(sid)) {
      seen.add(sid);
      out.push(sid);
    }
  }
  return out;
}

// ─── Run ──────────────────────────────────────────────────────────

interface QuestionResult {
  question_id: string;
  question_type: string;
  retrieved: string[];
  ground_truth: string[];
  hit_at_k: boolean;
  num_haystack: number;
  latency_ms: number;
}

interface RunSummary {
  adapter: string;
  dataset: string;
  total: number;
  topK: number;
  recall_at_k: number;
  recall_by_type: Record<string, { hit: number; total: number; recall: number }>;
  avg_latency_ms: number;
  p50_latency_ms: number;
  p99_latency_ms: number;
  total_seconds: number;
}

async function run(opts: Opts): Promise<RunSummary[]> {
  if (!existsSync(opts.datasetPath)) {
    console.error(`Dataset not found: ${opts.datasetPath}`);
    console.error(`Download from https://huggingface.co/datasets/xiaowu0162/longmemeval`);
    process.exit(1);
  }
  process.stderr.write(`[longmemeval] loading ${opts.datasetPath}...\n`);
  const raw: Question[] = JSON.parse(readFileSync(opts.datasetPath, 'utf8'));
  let all = raw;
  if (opts.stratify) all = stratifiedSample(raw, opts.stratify);
  if (opts.limit) all = all.slice(0, opts.limit);
  process.stderr.write(`[longmemeval] dataset=${opts.datasetName} questions=${all.length}${opts.stratify ? ` (stratified ${opts.stratify}/type)` : ''} top_k=${opts.topK}\n`);

  type AdapterMode = 'keyword' | 'vector' | 'hybrid' | 'hybrid+expansion';
  const adapterMap: Record<string, { name: string; mode: AdapterMode }> = {
    keyword: { name: 'gbrain-keyword', mode: 'keyword' },
    vector: { name: 'gbrain-vector', mode: 'vector' },
    hybrid: { name: 'gbrain-hybrid', mode: 'hybrid' },
    'hybrid+expansion': { name: 'gbrain-hybrid+expansion', mode: 'hybrid+expansion' },
  };
  const adapters = opts.adapters.map(k => {
    const a = adapterMap[k];
    if (!a) {
      console.error(`Unknown adapter: "${k}". Allowed: keyword, vector, hybrid, hybrid+expansion`);
      process.exit(1);
    }
    return a;
  });

  const summaries: RunSummary[] = [];

  // Recycle the engine every RECYCLE_EVERY questions to bound memory AND
  // bound PGLite WASM state. The WASM module accumulates internal state
  // beyond what TRUNCATE clears; on long runs (500Q × 50 sessions ×
  // chunked + indexed) we've seen it lock up in an abort() loop after
  // ~75 questions. Recycling every 25Q keeps the WASM healthy at the
  // cost of ~2s cold-start × 20 cycles = ~40s extra wall time. Cheap
  // insurance against silent hangs that wasted hours of API spend.
  const RECYCLE_EVERY = 25;

  // Configure the AI gateway once (v0.27+ requires this before embed() works).
  // Mirror cli.ts#connectEngine: read config + env, hand to configureGateway.
  // Used by hybridSearch + importFromContent's chunk-embedding path.
  const needsEmbeddings = adapters.some(a => a.mode !== 'keyword');
  let cache: EmbeddingCache | null = null;
  if (needsEmbeddings) {
    const cfg = loadConfig() || ({} as any);
    configureGateway({
      embedding_model: cfg.embedding_model,
      embedding_dimensions: cfg.embedding_dimensions,
      expansion_model: cfg.expansion_model,
      chat_model: cfg.chat_model,
      chat_fallback_chain: cfg.chat_fallback_chain,
      base_urls: cfg.provider_base_urls,
      env: { ...process.env },
    });
    if (!opts.noCache) {
      // Wire the content-addressed cache. Hits skip the OpenAI API entirely;
      // misses fall through to the original ai-sdk embedMany. First run pays
      // full cost, every subsequent run on the same dataset is essentially
      // free. SHA-256(text) keying makes this fair: different content →
      // different key → cache miss. We're remembering past computation, not
      // borrowing future data.
      //
      // The cache is keyed by `(model_id, dimensions, sha256(text))` so any
      // change to the embedding model or output-dimension config invalidates
      // the entire cache automatically — no chance of returning a 1536-dim
      // vector when the schema expects 3072.
      const cacheModel = cfg.embedding_model || 'text-embedding-3-large';
      const cacheDims = cfg.embedding_dimensions || 1536;
      const cacheKey = `${cacheModel}@${cacheDims}`;
      const cachePath = join(opts.cacheDir, `embed-cache-${cacheKey.replace(/[^a-z0-9@-]/gi, '_')}.sqlite`);
      cache = new EmbeddingCache(cachePath, cacheKey);
      // Pass the params straight through to the real ai-sdk embedMany so
      // model + providerOptions + dimensions arrive intact. gbrain's gateway
      // already builds the model object with the right dimensions config.
      const realTransport = async (params: { values: string[] } & Record<string, unknown>) =>
        aiSdkEmbedMany(params as Parameters<typeof aiSdkEmbedMany>[0]);
      // The caching wrapper satisfies the transport contract structurally
      // (embeddings + values + warnings); the cast crosses gbrain's
      // test-seam type, which demands the full ai-sdk embedMany signature.
      __setEmbedTransportForTests(
        makeCachingTransport(realTransport, cache) as unknown as Parameters<typeof __setEmbedTransportForTests>[0],
      );
      process.stderr.write(`[longmemeval] embedding cache at ${cachePath} (${cache.size()} entries warm)\n`);
    }
  }

  // Resume support: when --ndjson is given, every per-question result is
  // appended immediately. On restart we read it back and skip already-done
  // (adapter, question_id) pairs. Pair this with --max-wall-seconds and a
  // wrapper bash loop to chip through the full run in 10-min batches:
  // each batch processes questions until the budget runs out, then exits
  // cleanly. The next invocation picks up exactly where the prior one left
  // off. PGLite WASM aborts can't strand us anymore — at worst we lose the
  // current question and resume on the next.
  const completed = readCompletedPairs(opts.ndjsonPath);
  if (opts.ndjsonPath) {
    mkdirSync(dirname(opts.ndjsonPath) || '.', { recursive: true });
    process.stderr.write(`[longmemeval] ndjson stream: ${opts.ndjsonPath} (${completed.size} pairs already complete)\n`);
  }
  const wallStart = Date.now();
  const wallBudgetMs = opts.maxWallSeconds ? opts.maxWallSeconds * 1000 : Infinity;
  let timedOut = false;

  for (const adapter of adapters) {
    if (timedOut) break;
    process.stderr.write(`\n[longmemeval] adapter=${adapter.name} (mode=${adapter.mode})\n`);
    let engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    const runStart = Date.now();
    const results: QuestionResult[] = [];

    try {
      // Per-question watchdog: PGLite's WASM has been observed to enter a
      // tight Aborted() loop on certain inputs after ~75 vector questions —
      // process keeps using CPU but writes nothing for hours. Catching is
      // not enough (Aborted() is a WASM-level trap, not a JS throw); we
      // bound each question with a wall-clock timeout. On timeout we
      // forcibly disconnect, recreate the engine, and skip the question.
      const PER_QUESTION_TIMEOUT_MS = 90_000;

      async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
        return await Promise.race([
          p,
          new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`question_timeout_${ms}ms`)), ms),
          ),
        ]);
      }

      async function resetEngineHard(): Promise<void> {
        try { await engine.disconnect(); } catch { /* WASM aborted; ignore */ }
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
      }

      for (let i = 0; i < all.length; i++) {
        const q = all[i];
        // Worker shard: each parallel worker handles 1/N of the questions.
        // Deterministic by index so workers don't fight over the same row.
        if (opts.totalWorkers > 1 && i % opts.totalWorkers !== opts.workerId) continue;
        // Skip pairs already streamed to NDJSON (resume + cross-worker dedup).
        if (completed.has(`${adapter.name}::${q.question_id}`)) continue;
        // Wall-budget exit: clean exit lets the wrapper restart cleanly.
        if (Date.now() - wallStart > wallBudgetMs) {
          process.stderr.write(`[longmemeval] wall budget reached (${opts.maxWallSeconds}s); exiting for restart\n`);
          timedOut = true;
          break;
        }
        const qStart = Date.now();
        try {
          if (i > 0 && i % RECYCLE_EVERY === 0) {
            await resetEngineHard();
          } else {
            await resetTables(engine);
          }
          const sessions = normalizeSessions(q);
          for (const s of sessions) {
            // gbrain's putPage lowercases via validateSlug, but upsertChunks
            // (also called by importFromContent) does NOT lowercase — passing
            // a mixed-case slug throws "Page not found" on the chunk write.
            // Normalize at the boundary so the dataset's mixed-case session_ids
            // (e.g. "sharegpt_yywfIrx_0") work end-to-end.
            const slug = `chat/${s.session_id}`.toLowerCase();
            await withTimeout(
              importFromContent(engine, slug, renderSession(s), {
                noEmbed: adapter.mode === 'keyword',
              }),
              PER_QUESTION_TIMEOUT_MS,
            );
          }
          let searchResults: SearchResult[];
          if (adapter.mode === 'keyword') {
            searchResults = await engine.searchKeyword(q.question, { limit: opts.topK });
          } else if (adapter.mode === 'vector') {
            // Vector-only: hybridSearch with the keyword half disabled isn't a
            // direct flag, so call engine.searchVector after embedding the
            // query. Mirrors what hybridSearch does for the vector half.
            // Embedding goes through the cached transport just like imports.
            const queryEmb = await embed(q.question);
            searchResults = await engine.searchVector(queryEmb, { limit: opts.topK });
          } else if (adapter.mode === 'hybrid') {
            searchResults = await hybridSearch(engine, q.question, { limit: opts.topK, expansion: false });
          } else {
            // hybrid + multi-query expansion via Haiku (gbrain's prod default)
            searchResults = await hybridSearch(engine, q.question, {
              limit: opts.topK,
              expansion: true,
              expandFn: expandQuery,
            });
          }

          const retrieved = uniqSessionIds(searchResults);
          // Normalize both sides — slugs are stored lowercase (validateSlug),
          // so retrieved IDs come back lowercase. answer_session_ids from the
          // dataset preserve original case. Lowercase both for comparison.
          const gt = new Set(q.answer_session_ids.map(s => s.toLowerCase()));
          const hit = retrieved.some(s => gt.has(s.toLowerCase()));

          const row = {
            question_id: q.question_id,
            question_type: q.question_type,
            retrieved,
            ground_truth: q.answer_session_ids,
            hit_at_k: hit,
            num_haystack: sessions.length,
            latency_ms: Date.now() - qStart,
          };
          results.push(row);
          if (opts.ndjsonPath) {
            appendFileSync(opts.ndjsonPath, JSON.stringify({ adapter: adapter.name, ...row }) + '\n');
          }

          if ((i + 1) % 25 === 0 || i === all.length - 1) {
            const hits = results.filter(r => r.hit_at_k).length;
            const elapsed = ((Date.now() - runStart) / 1000).toFixed(0);
            process.stderr.write(
              `[${adapter.name}] ${i + 1}/${all.length}  recall@${opts.topK}=${(hits / results.length * 100).toFixed(1)}%  ${elapsed}s\n`,
            );
          }
        } catch (err: any) {
          const msg = String(err?.message ?? err);
          process.stderr.write(`[${adapter.name}] ${q.question_id} error: ${msg}\n`);
          if (i === 0) process.stderr.write(`stack: ${err?.stack ?? ''}\n`);
          // On timeout (WASM hang / abort loop), the engine is unrecoverable.
          // Force a hard reset so the next question starts clean.
          if (msg.startsWith('question_timeout_')) {
            try { await resetEngineHard(); } catch (e: any) {
              process.stderr.write(`[${adapter.name}] engine reset failed: ${e?.message ?? e}\n`);
            }
          }
          const errRow = {
            question_id: q.question_id,
            question_type: q.question_type,
            retrieved: [],
            ground_truth: q.answer_session_ids,
            hit_at_k: false,
            num_haystack: 0,
            latency_ms: Date.now() - qStart,
            error: msg,
          };
          results.push(errRow);
          if (opts.ndjsonPath) {
            appendFileSync(opts.ndjsonPath, JSON.stringify({ adapter: adapter.name, ...errRow }) + '\n');
          }
        }
      }
    } finally {
      await engine.disconnect();
    }

    const hits = results.filter(r => r.hit_at_k).length;
    const recallByType: Record<string, { hit: number; total: number; recall: number }> = {};
    for (const r of results) {
      const bucket = recallByType[r.question_type] ?? (recallByType[r.question_type] = { hit: 0, total: 0, recall: 0 });
      bucket.total++;
      if (r.hit_at_k) bucket.hit++;
    }
    for (const k of Object.keys(recallByType)) {
      recallByType[k].recall = recallByType[k].hit / recallByType[k].total;
    }
    const latencies = results.map(r => r.latency_ms).sort((a, b) => a - b);
    const summary: RunSummary = {
      adapter: adapter.name,
      dataset: opts.datasetName,
      total: results.length,
      topK: opts.topK,
      recall_at_k: hits / results.length,
      recall_by_type: recallByType,
      avg_latency_ms: latencies.reduce((s, x) => s + x, 0) / latencies.length,
      p50_latency_ms: latencies[Math.floor(latencies.length * 0.5)],
      p99_latency_ms: latencies[Math.floor(latencies.length * 0.99)],
      total_seconds: (Date.now() - runStart) / 1000,
    };
    summaries.push(summary);

    process.stderr.write(
      `\n[${adapter.name}] done. recall@${opts.topK}=${(summary.recall_at_k * 100).toFixed(2)}% in ${summary.total_seconds.toFixed(0)}s\n`,
    );
  }

  if (cache) {
    const c = cache.stats;
    const total = c.hits + c.misses;
    const hitPct = total > 0 ? (c.hits / total * 100).toFixed(1) : '0.0';
    process.stderr.write(`\n[longmemeval] embed cache: ${c.hits} hits / ${c.misses} misses (${hitPct}% hit) | ${c.inserts} new entries | ${(c.bytes / 1024).toFixed(0)} KB written | ${cache.size()} total entries\n`);
    cache.close();
  }
  return summaries;
}

// ─── Output ───────────────────────────────────────────────────────

function fmt(summaries: RunSummary[]): string {
  const out: string[] = [];
  out.push('# LongMemEval results\n');
  out.push(`Dataset: \`${summaries[0].dataset}\`  |  Questions: ${summaries[0].total}  |  Top-K: ${summaries[0].topK}\n`);
  out.push('| Adapter | Recall@k | p50 latency | p99 latency | Wall time |');
  out.push('|---|---|---|---|---|');
  for (const s of summaries) {
    out.push(
      `| ${s.adapter} | ${(s.recall_at_k * 100).toFixed(2)}% | ${s.p50_latency_ms.toFixed(0)}ms | ${s.p99_latency_ms.toFixed(0)}ms | ${s.total_seconds.toFixed(0)}s |`,
    );
  }
  out.push('');
  out.push('## Recall by question_type\n');
  const types = Object.keys(summaries[0].recall_by_type).sort();
  out.push('| question_type | total | ' + summaries.map(s => s.adapter).join(' | ') + ' |');
  out.push('|---|---|' + summaries.map(() => '---').join('|') + '|');
  for (const t of types) {
    const total = summaries[0].recall_by_type[t].total;
    const cells = summaries.map(s => {
      const b = s.recall_by_type[t];
      return b ? `${(b.recall * 100).toFixed(1)}% (${b.hit}/${b.total})` : '—';
    });
    out.push(`| ${t} | ${total} | ${cells.join(' | ')} |`);
  }
  return out.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────

const opts = parseOpts();
const summaries = await run(opts);

// Raw run outputs land under eval/reports/ which is gitignored. Baselines
// (the canonical numbers + SVG charts that drive a published report) get
// hand-copied into docs/benchmarks/<slug>/ for permanent record.
const reportDir = join(import.meta.dir, '..', 'reports', 'longmemeval');
mkdirSync(reportDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const reportPath = opts.output || join(reportDir, `longmemeval-${opts.datasetName}-${ts}.json`);
writeFileSync(reportPath, JSON.stringify({ opts, summaries }, null, 2) + '\n');
process.stderr.write(`\n[longmemeval] raw results: ${reportPath}\n`);

const md = fmt(summaries);
const mdPath = reportPath.replace(/\.json$/, '.md');
writeFileSync(mdPath, md + '\n');
process.stderr.write(`[longmemeval] markdown: ${mdPath}\n`);
process.stderr.write('\n' + md + '\n');

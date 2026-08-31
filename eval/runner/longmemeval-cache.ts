/**
 * Content-addressed embedding cache for LongMemEval (and any other
 * fixed-corpus benchmark). Keyed by (model, input_type, sha256(text)) so:
 *
 *   - The cache is correct: different content → different embedding → cache miss.
 *   - The cache is side-aware: asymmetric providers (zembed-1, Voyage v3+)
 *     return DIFFERENT vectors for the same text depending on whether it is
 *     embedded as a query or as a document. gbrain threads that discriminator
 *     through `providerOptions.openaiCompatible.input_type` (see gateway.ts
 *     embedSubBatch); the cache key includes it so a document-side vector can
 *     never be served for a query-side embed (audit finding longmemeval-06).
 *   - The cache is fair: we're remembering past computation, not borrowing
 *     future data. First run fills the cache; subsequent runs hit it.
 *   - The cache is share-friendly: anyone with the dataset re-derives the same
 *     keys and can warm their own cache from a fresh run.
 *
 * KEY CHANGE NOTE (2026-08-31): adding input_type to the text hash deliberately
 * orphans every entry written by the old side-blind key. Those entries were
 * unsound for asymmetric models (a warm run silently reused document-side
 * vectors for query embeds), so re-paying the embed cost once is the correct
 * trade. Symmetric providers (OpenAI text-3) key both sides as 'document'
 * (the gateway drops input_type for them), so no double storage there.
 *
 * Wires into gbrain's gateway via __setEmbedTransportForTests — the test seam
 * is the cleanest interception point for benchmarks (production never calls it).
 *
 * Storage: bun:sqlite at <evals-root>/eval/reports/longmemeval/embed-cache.sqlite.
 * Single-file, durable, concurrent-write-safe via SQLite WAL mode.
 */

import { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

interface CacheStats {
  hits: number;
  misses: number;
  inserts: number;
  bytes: number;
}

export type EmbedInputType = 'query' | 'document';

/**
 * Extract the asymmetric-embedding side from an ai-sdk embedMany params
 * object. gbrain's gateway emits `providerOptions.openaiCompatible.input_type`
 * ('query' | 'document') for asymmetric models and omits it entirely for
 * symmetric ones — an absent discriminator means the document/default side
 * (embed()/embedOne are document-side; only embedQuery threads 'query').
 */
export function inputTypeFromParams(params: Record<string, unknown>): EmbedInputType {
  const po = params.providerOptions as { openaiCompatible?: { input_type?: unknown } } | undefined;
  return po?.openaiCompatible?.input_type === 'query' ? 'query' : 'document';
}

export class EmbeddingCache {
  private db: Database;
  private model: string;
  public stats: CacheStats = { hits: 0, misses: 0, inserts: 0, bytes: 0 };

  constructor(path: string, model: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    // Concurrent workers (longmemeval-batch.sh runs 3+ workers in parallel)
    // share this cache file. WAL handles the readers-vs-writer case, but the
    // writer-vs-writer case still serializes. Without busy_timeout, the second
    // writer hits SQLITE_BUSY immediately and the embed call dies as
    // "database is locked". Wait up to 10s before giving up.
    this.db.exec('PRAGMA busy_timeout = 10000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        model TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        vector BLOB NOT NULL,
        dims INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (model, text_hash)
      ) WITHOUT ROWID
    `);
    this.model = model;
  }

  /**
   * text_hash = sha256(input_type || NUL || text). The NUL separator cannot
   * appear in the input_type enum, so 'query' + text can never collide with
   * 'document' + text' for any text/text' pair. Old entries hashed plain
   * sha256(text) — they no longer resolve, which is deliberate (see header).
   */
  private hash(text: string, inputType: EmbedInputType): string {
    return createHash('sha256').update(inputType).update('\u0000').update(text).digest('hex');
  }

  /**
   * Look up a single text for one embedding side. Returns the vector or null.
   * The vector is stored as a Float32 little-endian blob; we deserialize back
   * to number[] (the shape ai-sdk's embedMany expects) on the way out.
   */
  get(text: string, inputType: EmbedInputType = 'document'): number[] | null {
    const h = this.hash(text, inputType);
    const row = this.db
      .query<{ vector: Uint8Array; dims: number }, [string, string]>(
        'SELECT vector, dims FROM embeddings WHERE model = ? AND text_hash = ?',
      )
      .get(this.model, h);
    if (!row) {
      this.stats.misses++;
      return null;
    }
    this.stats.hits++;
    const buf = row.vector;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const out = new Array<number>(row.dims);
    for (let i = 0; i < row.dims; i++) out[i] = view.getFloat32(i * 4, true);
    return out;
  }

  put(text: string, vector: number[], inputType: EmbedInputType = 'document'): void {
    const h = this.hash(text, inputType);
    const buf = new ArrayBuffer(vector.length * 4);
    const view = new DataView(buf);
    for (let i = 0; i < vector.length; i++) view.setFloat32(i * 4, vector[i], true);
    const blob = new Uint8Array(buf);
    this.db
      .query(
        'INSERT OR REPLACE INTO embeddings (model, text_hash, vector, dims, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(this.model, h, blob, vector.length, Date.now());
    this.stats.inserts++;
    this.stats.bytes += blob.byteLength;
  }

  size(): number {
    const row = this.db
      .query<{ n: number }, []>('SELECT COUNT(*) as n FROM embeddings')
      .get();
    return row?.n ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Wrap the gateway's embed transport so cached vectors are returned without
 * an API call. Misses fall through to the real embedMany. Aligned with the
 * ai-sdk's `embedMany({values})` signature. The per-call input_type is read
 * from providerOptions and folded into the cache key so query-side and
 * document-side vectors of the same text never alias.
 *
 * Returns a function suitable for `__setEmbedTransportForTests(fn)`.
 */
export function makeCachingTransport(
  realEmbedMany: (params: { values: string[] } & Record<string, unknown>) => Promise<{ embeddings: number[][]; usage?: any }>,
  cache: EmbeddingCache,
) {
  return async function cachingEmbedMany(
    params: { values: string[] } & Record<string, unknown>,
  ): Promise<{ embeddings: number[][]; values: string[]; warnings: unknown[]; usage?: any }> {
    const values = params.values;
    const inputType = inputTypeFromParams(params);
    const cached: Array<number[] | null> = values.map(v => cache.get(v, inputType));
    const missingIdx: number[] = [];
    for (let i = 0; i < cached.length; i++) {
      if (cached[i] === null) missingIdx.push(i);
    }
    if (missingIdx.length === 0) {
      // Mirror ai-sdk EmbedManyResult structurally (values/warnings) so the
      // gateway's transport seam sees a complete result on cache hits too.
      return { embeddings: cached as number[][], values, warnings: [] };
    }
    // Fetch only the missing values via the real transport.
    const missingValues = missingIdx.map(i => values[i]);
    const realResult = await realEmbedMany({ ...params, values: missingValues });
    for (let i = 0; i < missingIdx.length; i++) {
      const idx = missingIdx[i];
      const vec = realResult.embeddings[i];
      cached[idx] = vec;
      cache.put(values[idx], vec, inputType);
    }
    return { embeddings: cached as number[][], values, warnings: [], usage: realResult.usage };
  };
}

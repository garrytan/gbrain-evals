/**
 * Cat 40 `pg` arm: plain Postgres retrieval with no gbrain logic.
 *
 * One table of whole documents (the corpus documents are short, so a
 * document is one chunk), Postgres full-text search (`websearch_to_tsquery`,
 * `ts_rank_cd`) and pgvector cosine search over the same embedder gbrain uses
 * in this experiment (OpenAI `text-embedding-3-large` at 1536 dimensions).
 * No access control: restricted documents are rows like any other.
 *
 * Embeddings are cached on disk by content hash (append-only JSONL), so
 * repeated runs do not pay for them again.
 *
 * Hard worlds (plan 2026-10-05) add two options. `chunking: 'hard'` (ENG-F11)
 * embeds each document in overlapping chunks (`PG_CHUNKING_ID`), because Hard
 * transcripts run past the embedder's 24,000-character input cut and a
 * deciding line there would otherwise never be embedded; vector_search ranks
 * documents by their best chunk, keyword_search and get_document still use
 * the whole document. `limits: 'hard'` (CEO-T4) lets searches page with
 * `offset`, up to 100 rows, and report the total and whether the results are
 * exhausted. Every paid embedding request is priced from the response's usage
 * (ENG-F12) and charged to the counter of whoever caused it: `PgStore.setupEmbed`
 * for the build, `PgArm.embedUsage` for a session's queries and notes.
 */
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { HarnessError, type Arm, type ToolSpec } from './loop.ts';
import type { LadderDoc } from '../../generators/model-ladder-gen.ts';
import { renderDoc } from '../../generators/model-ladder-gen.ts';
import { priceRequest, reservationUsd, usageCost } from '../budget-ledger.ts';
import type { ToolLimits } from './arms.ts';

export const PG_EMBED_MODEL = 'text-embedding-3-large';
export const PG_EMBED_DIMS = 1536;
/** The embedder sends at most this many characters of one input. */
export const PG_EMBED_INPUT_CHARS = 24_000;

/** Paid embedding usage, added to by an embedder for each request it sends. Cache hits add nothing. */
export interface EmbedUsage {
  usd: number;
  requests: number;
  tokens: number;
  /** Requests whose response reported no usage, charged at their reservation (not free). */
  unpriced: number;
}
export const newEmbedUsage = (): EmbedUsage => ({ usd: 0, requests: 0, tokens: 0, unpriced: 0 });

export interface EmbedOptions {
  /** Counter charged for the paid requests this call sends. */
  usage?: EmbedUsage;
  /** Cache-key namespace (a chunking identity), so chunk embeddings never share keys with whole documents. */
  namespace?: string;
}
export type Embedder = (texts: string[], options?: EmbedOptions) => Promise<number[][]>;

/**
 * OpenAI `text-embedding-3-large` with an on-disk cache. Each request is priced from the response's
 * `usage` at the price the budget ledger uses (gbrain's `embedding-pricing.ts`, $0.13 per million tokens
 * for this model) and added to the caller's `usage` counter. A failed request throws HarnessError
 * (infrastructure, not the agent); a refused ledger reservation passes through unchanged.
 */
export function cachedOpenAIEmbedder(cachePath: string, fetchImpl: typeof fetch = fetch): Embedder {
  // Legacy cache: one JSON object. New entries are appended to a JSONL file beside it (base64 float32), so a
  // 50,000-document corpus neither rewrites a gigabyte of JSON per query nor exceeds the maximum string length.
  const linesPath = cachePath.replace(/\.json$/, '') + '.jsonl';
  const cache: Record<string, number[]> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
  if (existsSync(linesPath)) {
    for (const line of readFileSync(linesPath, 'utf8').split('\n')) {
      if (!line) continue;
      const { k, v } = JSON.parse(line) as { k: string; v: string };
      const buf = Buffer.from(v, 'base64');
      cache[k] = Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
    }
  }
  const key = (t: string, ns?: string) => createHash('sha256').update(ns ? `${PG_EMBED_MODEL}:${PG_EMBED_DIMS}:${ns}:${t}` : `${PG_EMBED_MODEL}:${PG_EMBED_DIMS}:${t}`).digest('hex');
  const url = 'https://api.openai.com/v1/embeddings';
  const fetchBatch = async (batch: string[], ns: string | undefined, usage: EmbedUsage | undefined) => {
    const payload = { model: PG_EMBED_MODEL, input: batch.map(t => t.slice(0, PG_EMBED_INPUT_CHARS)), dimensions: PG_EMBED_DIMS };
    const price = priceRequest(url, payload);
    let res: Response, text: string;
    try {
      res = await fetchImpl(url, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}` },
        body: JSON.stringify(payload),
      });
      text = await res.text();
    } catch (e) {
      if ((e as Error).name === 'BudgetExceededError') throw e;
      if (usage && price) { usage.requests++; usage.unpriced++; usage.usd += reservationUsd(price); }
      throw new HarnessError(`embedding request failed: ${(e as Error).message}`);
    }
    let body: { data?: Array<{ index: number; embedding: number[] }>; usage?: unknown } | null = null;
    try { body = JSON.parse(text); } catch { body = null; }
    if (usage && price) {
      const cost = usageCost(price, body);
      usage.requests++;
      usage.usd += cost ? cost.usd : reservationUsd(price);
      usage.tokens += cost?.input_tokens ?? 0;
      if (!cost) usage.unpriced++;
    }
    if (!res.ok) throw new HarnessError(`embedding error ${res.status}: ${text.slice(0, 300)}`);
    if (!Array.isArray(body?.data)) throw new HarnessError(`embedding response without data: ${text.slice(0, 300)}`);
    const lines: string[] = [];
    for (const d of body.data) {
      const k = key(batch[d.index], ns);
      cache[k] = d.embedding;
      lines.push(JSON.stringify({ k, v: Buffer.from(new Float32Array(d.embedding).buffer).toString('base64') }));
    }
    mkdirSync(dirname(linesPath), { recursive: true });
    appendFileSync(linesPath, lines.join('\n') + '\n');
  };
  return async (texts: string[], options: EmbedOptions = {}) => {
    const ns = options.namespace;
    const missing = [...new Set(texts.filter(t => !cache[key(t, ns)]))];
    const batches: string[][] = [];
    for (let i = 0; i < missing.length; i += 96) batches.push(missing.slice(i, i + 96));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, batches.length) }, async () => { while (next < batches.length) await fetchBatch(batches[next++], ns, options.usage); }));
    return texts.map(t => cache[key(t, ns)]);
  };
}

export type PgChunking = 'whole' | 'hard';
/**
 * Hard chunking: chunks of at most 6,000 characters overlapping by 600, cut at a line end where one falls in
 * the last 600 characters, so every line of up to 600 characters lies whole in some chunk. 6,000 characters is
 * a quarter of the embedder's 24,000-character input cut (about 1,500 tokens, far under the model's 8,191-token
 * limit), so nothing in a chunk goes unembedded. Chunks after the first are embedded with the document title
 * as a first line, since only the first chunk carries the frontmatter. A change to any of this changes the id.
 */
export const PG_CHUNK_CHARS = 6000;
export const PG_CHUNK_OVERLAP = 600;
export const PG_CHUNKING_ID = `chunks-v1:${PG_CHUNK_CHARS}:${PG_CHUNK_OVERLAP}`;

export function chunkDocument(text: string, size = PG_CHUNK_CHARS, overlap = PG_CHUNK_OVERLAP): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  for (let start = 0; ;) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) { const nl = text.lastIndexOf('\n', end - 1); if (nl >= end - overlap) end = nl + 1; }
    out.push(text.slice(start, end));
    if (end >= text.length) return out;
    let next = end - overlap;
    const nl = text.indexOf('\n', next);
    if (nl >= 0 && nl + 1 < end) next = nl + 1;
    start = next;
  }
}

/** The texts embedded for one document's chunks. */
export const chunkEmbedTexts = (title: string, chunks: string[]) => chunks.map((c, i) => i === 0 ? c : `title: ${title}\n${c}`);

/** pg search limits per tool-limit setting. The tool descriptions state these. */
export const PG_SEARCH_LIMITS: Record<ToolLimits, { defaultLimit: number; maxLimit: number; offset: boolean }> = {
  v1: { defaultLimit: 10, maxLimit: 25, offset: false },
  hard: { defaultLimit: 10, maxLimit: 100, offset: true },
};

const lit = (v: number[]) => `[${v.join(',')}]`;

export class PgStore {
  /** Paid embedding usage of the build (setup cost, not any cell's). */
  readonly setupEmbed = newEmbedUsage();
  private constructor(readonly db: PGlite, readonly embed: Embedder, readonly chunking: PgChunking) {}
  get setupEmbedUsd() { return this.setupEmbed.usd; }
  static async build(world: { docs: LadderDoc[] }, embed: Embedder, options: { chunking?: PgChunking } = {}): Promise<PgStore> {
    const chunking = options.chunking ?? 'whole';
    const db = await PGlite.create({ extensions: { vector } });
    await db.exec(`CREATE EXTENSION IF NOT EXISTS vector;
      CREATE TABLE docs (id text NOT NULL, run_id text, title text, body text NOT NULL, tsv tsvector, embedding vector(${PG_EMBED_DIMS}));
      CREATE INDEX docs_tsv ON docs USING gin(tsv);`);
    const store = new PgStore(db, embed, chunking);
    const texts = world.docs.map(renderDoc);
    if (chunking === 'hard') {
      await db.exec(`CREATE TABLE chunks (id text NOT NULL, run_id text, chunk int NOT NULL, text text NOT NULL, embedding vector(${PG_EMBED_DIMS}));`);
      for (let i = 0; i < world.docs.length; i++) {
        const d = world.docs[i];
        await db.query(`INSERT INTO docs (id, run_id, title, body, tsv, embedding) VALUES ($1, NULL, $2, $3, to_tsvector('english', $2 || ' ' || $3), NULL)`, [d.id, d.title, texts[i]]);
      }
      const chunks = world.docs.map((d, i) => ({ d, parts: chunkDocument(texts[i]) }));
      const vecs = await embed(chunks.flatMap(c => chunkEmbedTexts(c.d.title, c.parts)), { usage: store.setupEmbed, namespace: PG_CHUNKING_ID });
      let k = 0;
      for (const { d, parts } of chunks) for (let j = 0; j < parts.length; j++) {
        await db.query(`INSERT INTO chunks (id, run_id, chunk, text, embedding) VALUES ($1, NULL, $2, $3, $4::vector)`, [d.id, j, parts[j], lit(vecs[k++])]);
      }
      return store;
    }
    const vecs = await embed(texts, { usage: store.setupEmbed });
    for (let i = 0; i < world.docs.length; i++) {
      const d = world.docs[i];
      await db.query(`INSERT INTO docs (id, run_id, title, body, tsv, embedding) VALUES ($1, NULL, $2, $3, to_tsvector('english', $2 || ' ' || $3), $4::vector)`, [d.id, d.title, texts[i], lit(vecs[i])]);
    }
    return store;
  }
  /** Visible rows for one run: its own overlay wins over the base row with the same id. */
  visible(run: string) {
    return `(SELECT DISTINCT ON (id) * FROM docs WHERE run_id IS NULL OR run_id = '${run.replace(/'/g, "''")}' ORDER BY id, run_id NULLS LAST)`;
  }
}

function snippet(body: string) {
  const text = body.replace(/^---[\s\S]*?---\n/, '').replace(/\s+/g, ' ').trim();
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

const HARD_PAGE = 'Results are ranked; the first line reads "total: N; showing A-B; exhausted: true|false" and names the next offset while results remain. Pass offset to page; limit default 10, max 100.';
/** The Hard search tools (paged, with totals). */
export const HARD_PG_SEARCH_TOOLS: ToolSpec[] = [
  { name: 'keyword_search', description: `Full-text keyword search (Postgres websearch syntax) over whole documents. Returns id, title and a snippet per document. total counts every matching document. ${HARD_PAGE}`, input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', description: 'Default 10, max 100.' }, offset: { type: 'number', description: 'Results to skip, for paging; default 0.' } }, required: ['query'] } },
  { name: 'vector_search', description: `Semantic similarity search over document embeddings (long documents are embedded in passages; a document ranks by its best passage). Returns id, title and a snippet of the best passage per document. Every document is ranked, so total is the number of documents. ${HARD_PAGE}`, input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', description: 'Default 10, max 100.' }, offset: { type: 'number', description: 'Results to skip, for paging; default 0.' } }, required: ['query'] } },
];

export interface PgArmOptions {
  /** Default `v1`. */
  limits?: ToolLimits;
}

export class PgArm implements Arm {
  readonly name = 'pg';
  readonly limits: ToolLimits;
  /** Paid embedding usage of this arm's calls (query and note embeddings); see takeEmbedUsage. */
  embedUsage = newEmbedUsage();
  constructor(private store: PgStore, private run: string, options: PgArmOptions = {}) { this.limits = options.limits ?? 'v1'; }
  get embedUsd() { return this.embedUsage.usd; }
  /** Return the usage since the last call and start a new count (read once per session). */
  takeEmbedUsage(): EmbedUsage { const u = this.embedUsage; this.embedUsage = newEmbedUsage(); return u; }
  systemHint() {
    return 'The knowledge base is a Postgres document database. Use keyword_search (Postgres full-text search) and vector_search (semantic similarity) to find documents, get_document to read one, and save_document to store a new note.';
  }
  tools(): ToolSpec[] {
    const tools: ToolSpec[] = [
      { name: 'keyword_search', description: 'Full-text keyword search (Postgres websearch syntax). Returns id, title and a snippet per document.', input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', description: 'Default 10, max 25.' } }, required: ['query'] } },
      { name: 'vector_search', description: 'Semantic similarity search over document embeddings. Returns id, title and a snippet per document.', input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', description: 'Default 10, max 25.' } }, required: ['query'] } },
      { name: 'get_document', description: 'Read a whole document by id.', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      { name: 'save_document', description: 'Create or replace a document.', input_schema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' } }, required: ['id', 'content'] } },
    ];
    return this.limits === 'hard' ? tools.map(t => HARD_PG_SEARCH_TOOLS.find(h => h.name === t.name) ?? t) : tools;
  }
  writeTools() { return ['save_document']; }
  async call(name: string, a: Record<string, unknown>): Promise<string> {
    const db = this.store.db;
    const hard = this.limits === 'hard';
    const limit = hard ? Math.max(1, Math.min(100, Math.floor(Number(a.limit ?? 10)) || 10)) : Math.max(1, Math.min(25, Number(a.limit ?? 10) || 10));
    const offset = hard ? Math.max(0, Math.floor(Number(a.offset ?? 0)) || 0) : 0;
    const fmt = (rows: Array<Record<string, unknown>>) => rows.length
      ? rows.map((r, i) => `${i + 1}. id: ${r.id}\n   title: ${r.title}\n   ${snippet(String(r.body))}`).join('\n')
      : 'No results.';
    const page = (rows: Array<Record<string, unknown>>, total: number) => {
      if (!total) return 'No results.\ntotal: 0; exhausted: true';
      if (!rows.length) return `total: ${total}; showing none (offset ${offset} is past the last result); exhausted: true`;
      const last = offset + rows.length;
      const head = `total: ${total}; showing ${offset + 1}-${last}; exhausted: ${last >= total}${last < total ? `; next offset: ${last}` : ''}`;
      return [head, ...rows.map((r, i) => `${offset + i + 1}. id: ${r.id}\n   title: ${r.title}\n   ${snippet(String(r.body))}`)].join('\n');
    };
    const visible = this.store.visible(this.run);
    const count = async (sql: string, params: unknown[] = []) => Number(((await db.query(sql, params)).rows[0] as { n: number }).n);
    if (name === 'keyword_search') {
      const q = String(a.query ?? '');
      const r = await db.query(`SELECT id, title, body, ts_rank_cd(tsv, q) AS rank FROM ${visible} d, websearch_to_tsquery('english', $1) q WHERE tsv @@ q ORDER BY rank DESC, id LIMIT ${limit}${hard ? ` OFFSET ${offset}` : ''}`, [q]);
      if (!hard) return fmt(r.rows as Array<Record<string, unknown>>);
      return page(r.rows as Array<Record<string, unknown>>, await count(`SELECT count(*)::int AS n FROM ${visible} d, websearch_to_tsquery('english', $1) q WHERE tsv @@ q`, [q]));
    }
    if (name === 'vector_search') {
      const [v] = await this.store.embed([String(a.query ?? '')], { usage: this.embedUsage });
      const tail = `LIMIT ${limit}${hard ? ` OFFSET ${offset}` : ''}`;
      const r = this.store.chunking === 'hard'
        ? await db.query(`SELECT id, title, body FROM (SELECT DISTINCT ON (c.id) c.id, d.title, c.text AS body, c.embedding <=> $1::vector AS dist FROM chunks c JOIN ${visible} d ON d.id = c.id AND c.run_id IS NOT DISTINCT FROM d.run_id ORDER BY c.id, dist) b ORDER BY dist, id ${tail}`, [lit(v)])
        : await db.query(`SELECT id, title, body FROM ${visible} d ORDER BY embedding <=> $1::vector, id ${tail}`, [lit(v)]);
      if (!hard) return fmt(r.rows as Array<Record<string, unknown>>);
      return page(r.rows as Array<Record<string, unknown>>, await count(`SELECT count(*)::int AS n FROM ${visible} d`));
    }
    if (name === 'get_document') {
      const id = String(a.id ?? '').replace(/\.md$/, '');
      const r = await db.query(`SELECT body FROM ${visible} d WHERE id = $1`, [id]);
      return r.rows.length ? String((r.rows[0] as Record<string, unknown>).body) : `No document with id ${id}.`;
    }
    if (name === 'save_document') {
      const id = String(a.id ?? '').replace(/\.md$/, '');
      const title = String(a.title ?? id);
      const body = String(a.content ?? '');
      if (this.store.chunking === 'hard') {
        const parts = chunkDocument(body);
        const vecs = await this.store.embed(chunkEmbedTexts(title, parts), { usage: this.embedUsage, namespace: PG_CHUNKING_ID });
        await db.query(`DELETE FROM docs WHERE id = $1 AND run_id = $2`, [id, this.run]);
        await db.query(`DELETE FROM chunks WHERE id = $1 AND run_id = $2`, [id, this.run]);
        await db.query(`INSERT INTO docs (id, run_id, title, body, tsv, embedding) VALUES ($1, $2, $3, $4, to_tsvector('english', $3 || ' ' || $4), NULL)`, [id, this.run, title, body]);
        for (let j = 0; j < parts.length; j++) await db.query(`INSERT INTO chunks (id, run_id, chunk, text, embedding) VALUES ($1, $2, $3, $4, $5::vector)`, [id, this.run, j, parts[j], lit(vecs[j])]);
        return `Saved document ${id}.`;
      }
      const [v] = await this.store.embed([body], { usage: this.embedUsage });
      await db.query(`DELETE FROM docs WHERE id = $1 AND run_id = $2`, [id, this.run]);
      await db.query(`INSERT INTO docs (id, run_id, title, body, tsv, embedding) VALUES ($1, $2, $3, $4, to_tsvector('english', $3 || ' ' || $4), $5::vector)`, [id, this.run, title, body, lit(v)]);
      return `Saved document ${id}.`;
    }
    throw new Error(`unknown tool ${name}`);
  }
}

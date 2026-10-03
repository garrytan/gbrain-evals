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
 */
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Arm, ToolSpec } from './loop.ts';
import type { LadderWorld } from '../../generators/model-ladder-gen.ts';
import { renderDoc } from '../../generators/model-ladder-gen.ts';

export const PG_EMBED_MODEL = 'text-embedding-3-large';
export const PG_EMBED_DIMS = 1536;

export type Embedder = (texts: string[]) => Promise<number[][]>;

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
  const key = (t: string) => createHash('sha256').update(`${PG_EMBED_MODEL}:${PG_EMBED_DIMS}:${t}`).digest('hex');
  const fetchBatch = async (batch: string[]) => {
    const res = await fetchImpl('https://api.openai.com/v1/embeddings', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}` },
      body: JSON.stringify({ model: PG_EMBED_MODEL, input: batch.map(t => t.slice(0, 24_000)), dimensions: PG_EMBED_DIMS }),
    });
    if (!res.ok) throw new Error(`embedding error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json() as { data: Array<{ index: number; embedding: number[] }> };
    const lines: string[] = [];
    for (const d of body.data) {
      const k = key(batch[d.index]);
      cache[k] = d.embedding;
      lines.push(JSON.stringify({ k, v: Buffer.from(new Float32Array(d.embedding).buffer).toString('base64') }));
    }
    mkdirSync(dirname(linesPath), { recursive: true });
    appendFileSync(linesPath, lines.join('\n') + '\n');
  };
  return async (texts: string[]) => {
    const missing = [...new Set(texts.filter(t => !cache[key(t)]))];
    const batches: string[][] = [];
    for (let i = 0; i < missing.length; i += 96) batches.push(missing.slice(i, i + 96));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, batches.length) }, async () => { while (next < batches.length) await fetchBatch(batches[next++]); }));
    return texts.map(t => cache[key(t)]);
  };
}

const lit = (v: number[]) => `[${v.join(',')}]`;

export class PgStore {
  private constructor(readonly db: PGlite, readonly embed: Embedder) {}
  static async build(world: LadderWorld, embed: Embedder): Promise<PgStore> {
    const db = await PGlite.create({ extensions: { vector } });
    await db.exec(`CREATE EXTENSION IF NOT EXISTS vector;
      CREATE TABLE docs (id text NOT NULL, run_id text, title text, body text NOT NULL, tsv tsvector, embedding vector(${PG_EMBED_DIMS}));
      CREATE INDEX docs_tsv ON docs USING gin(tsv);`);
    const texts = world.docs.map(renderDoc);
    const vecs = await embed(texts);
    for (let i = 0; i < world.docs.length; i++) {
      const d = world.docs[i];
      await db.query(`INSERT INTO docs (id, run_id, title, body, tsv, embedding) VALUES ($1, NULL, $2, $3, to_tsvector('english', $2 || ' ' || $3), $4::vector)`, [d.id, d.title, texts[i], lit(vecs[i])]);
    }
    return new PgStore(db, embed);
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

export class PgArm implements Arm {
  readonly name = 'pg';
  constructor(private store: PgStore, private run: string) {}
  systemHint() {
    return 'The knowledge base is a Postgres document database. Use keyword_search (Postgres full-text search) and vector_search (semantic similarity) to find documents, get_document to read one, and save_document to store a new note.';
  }
  tools(): ToolSpec[] {
    return [
      { name: 'keyword_search', description: 'Full-text keyword search (Postgres websearch syntax). Returns id, title and a snippet per document.', input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', description: 'Default 10, max 25.' } }, required: ['query'] } },
      { name: 'vector_search', description: 'Semantic similarity search over document embeddings. Returns id, title and a snippet per document.', input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', description: 'Default 10, max 25.' } }, required: ['query'] } },
      { name: 'get_document', description: 'Read a whole document by id.', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      { name: 'save_document', description: 'Create or replace a document.', input_schema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' } }, required: ['id', 'content'] } },
    ];
  }
  writeTools() { return ['save_document']; }
  async call(name: string, a: Record<string, unknown>): Promise<string> {
    const db = this.store.db;
    const limit = Math.max(1, Math.min(25, Number(a.limit ?? 10) || 10));
    const fmt = (rows: Array<Record<string, unknown>>) => rows.length
      ? rows.map((r, i) => `${i + 1}. id: ${r.id}\n   title: ${r.title}\n   ${snippet(String(r.body))}`).join('\n')
      : 'No results.';
    if (name === 'keyword_search') {
      const r = await db.query(`SELECT id, title, body, ts_rank_cd(tsv, q) AS rank FROM ${this.store.visible(this.run)} d, websearch_to_tsquery('english', $1) q WHERE tsv @@ q ORDER BY rank DESC, id LIMIT ${limit}`, [String(a.query ?? '')]);
      return fmt(r.rows as Array<Record<string, unknown>>);
    }
    if (name === 'vector_search') {
      const [v] = await this.store.embed([String(a.query ?? '')]);
      const r = await db.query(`SELECT id, title, body FROM ${this.store.visible(this.run)} d ORDER BY embedding <=> $1::vector, id LIMIT ${limit}`, [lit(v)]);
      return fmt(r.rows as Array<Record<string, unknown>>);
    }
    if (name === 'get_document') {
      const id = String(a.id ?? '').replace(/\.md$/, '');
      const r = await db.query(`SELECT body FROM ${this.store.visible(this.run)} d WHERE id = $1`, [id]);
      return r.rows.length ? String((r.rows[0] as Record<string, unknown>).body) : `No document with id ${id}.`;
    }
    if (name === 'save_document') {
      const id = String(a.id ?? '').replace(/\.md$/, '');
      const title = String(a.title ?? id);
      const body = String(a.content ?? '');
      const [v] = await this.store.embed([body]);
      await db.query(`DELETE FROM docs WHERE id = $1 AND run_id = $2`, [id, this.run]);
      await db.query(`INSERT INTO docs (id, run_id, title, body, tsv, embedding) VALUES ($1, $2, $3, $4, to_tsvector('english', $3 || ' ' || $4), $5::vector)`, [id, this.run, title, body, lit(v)]);
      return `Saved document ${id}.`;
    }
    throw new Error(`unknown tool ${name}`);
  }
}

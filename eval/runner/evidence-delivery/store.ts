/**
 * Content-addressed frozen evidence manifest (plan amendment 4).
 *
 * Every text the study can show a reader is stored once, under its SHA-256,
 * in a blob store; the manifest holds only hashes and structure. One line per
 * question records the ordered top-5 and top-10 hits with their chunk text,
 * every chunk of every hit page (the neighbors any policy may use), the
 * harness reader's page bodies, the evidence each arm delivers, and the
 * product's own fingerprints. The header records the gbrain code, parser and
 * index identities. Nothing here carries gold labels.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256 } from './data.ts';
import type { GbrainIdentity } from './gbrain.ts';

export class BlobStore {
  constructor(readonly dir: string) { mkdirSync(join(dir, 'blobs'), { recursive: true }); }
  private path(hash: string) { return join(this.dir, 'blobs', hash.slice(0, 2), `${hash}.txt`); }
  put(text: string): string {
    const hash = sha256(text);
    const p = this.path(hash);
    if (!existsSync(p)) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); }
    return hash;
  }
  get(hash: string): string {
    const text = readFileSync(this.path(hash), 'utf8');
    if (sha256(text) !== hash) throw new Error(`blob ${hash} is corrupt`);
    return text;
  }
  has(hash: string): boolean { return existsSync(this.path(hash)); }
}

export interface FrozenChunk { chunk_id: number; chunk_index: number; chunk_source: string; text: string }
export interface FrozenPage { slug: string; page_id: number; date: string | null; harness_body: string; chunks: FrozenChunk[] }
export interface FrozenHit { rank: number; slug: string; page_id: number; chunk_id: number; chunk_index: number; chunk_source: string; score: number; text: string }

/** One delivered block: the page it came from and the exact text a reader sees (a blob hash). */
export interface FrozenBlock { slug: string; text: string }

export interface FrozenArm {
  source: 'frozen' | 'product' | 'harness';
  blocks: FrozenBlock[];
  /** SHA-256 of JSON [[slug, text sha], ...]: the study's own evidence fingerprint. */
  evidence_sha256: string;
  /** Product arms: blob hash of JSON.stringify(results) exactly as assembleEvidenceForHits returned them. */
  results?: string;
  /** Product arms: gbrain's evidenceFingerprint(results). */
  product_fingerprint?: string;
  /** Product arms: the delivery meta block. */
  delivery?: Record<string, unknown>;
  /** cl100k tokens of the delivered texts (the product's delivered.tokens sum for product arms). */
  product_encoding_tokens: number;
  /** cl100k tokens of JSON.stringify(results, null, 2), what the MCP tool would return; null when no product results exist. */
  serialized_tool_tokens: number | null;
  duplicate_bodies: number;
  /** k10 only: whether the limit-10 list's top five equal the frozen top five. */
  shared_stream?: boolean;
  note?: string;
}

export interface FrozenQuestion {
  question_id: string;
  set: 'pilot' | 'confirmatory' | 'sealed';
  question_type: string | null;
  question_sha256: string;
  question_date: string;
  index_sha256: string;
  search_meta: { reranked: boolean | null; degraded: unknown[] };
  hits5: FrozenHit[];
  hits10: FrozenHit[];
  pages: FrozenPage[];
  r1: null | { identical_slug_chunk_rank: boolean; identical_slug_rank: boolean; r1_sig: string };
  arms: Record<string, FrozenArm>;
}

export interface FrozenHeader {
  schema: 'gbrain-evals/evidence-delivery-frozen/v1';
  created_at: string;
  smoke: boolean;
  decision_manifest_sha256: string;
  gbrain: GbrainIdentity;
  dataset_sha256: string;
  retrieval: Record<string, unknown>;
  embed_cache: { sha256_before: string | null; sha256_after: string | null; misses: number | null; shards?: Array<Record<string, unknown>> };
  product_arms: Record<string, { unit: string; return_window?: number; budget_tokens: number | null }>;
  note: string;
}

export const MANIFEST_FILE = 'frozen-manifest.jsonl';
export const HEADER_FILE = 'frozen-header.json';

export function evidenceSha(blocks: FrozenBlock[]): string {
  return sha256(JSON.stringify(blocks.map(b => [b.slug, b.text])));
}

/** Number of blocks whose text equals, or is contained in, another block's text. */
export function duplicateBodies(texts: string[]): number {
  return texts.filter((t, i) => t.length > 0 && texts.some((u, j) => j !== i && u.includes(t))).length;
}

/** Order-independent content address of all question lines (sorted by question id). */
export function manifestSha(lines: FrozenQuestion[]): string {
  return sha256([...lines].sort((a, b) => (a.question_id < b.question_id ? -1 : 1)).map(l => JSON.stringify(l)).join('\n'));
}

export function readFrozen(dir: string): { header: FrozenHeader; questions: Map<string, FrozenQuestion>; sha256: string; store: BlobStore } {
  const header = JSON.parse(readFileSync(join(dir, HEADER_FILE), 'utf8')) as FrozenHeader;
  const lines = existsSync(join(dir, MANIFEST_FILE))
    ? readFileSync(join(dir, MANIFEST_FILE), 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as FrozenQuestion) : [];
  const questions = new Map<string, FrozenQuestion>();
  for (const q of lines) questions.set(q.question_id, q);
  return { header, questions, sha256: manifestSha([...questions.values()]), store: new BlobStore(dir) };
}

export function appendFrozen(dir: string, q: FrozenQuestion) {
  appendFileSync(join(dir, MANIFEST_FILE), JSON.stringify(q) + '\n');
}

/** Per-question index identity: every chunk of every page, in slug and chunk order. */
export function indexSha(pages: Array<{ slug: string; chunks: Array<{ chunk_index: number; chunk_source: string; text: string }> }>, embedding: string): string {
  const rows = [...pages].sort((a, b) => (a.slug < b.slug ? -1 : 1)).flatMap(p => p.chunks.map(c => `${p.slug}\t${c.chunk_index}\t${c.chunk_source}\t${c.text}`));
  return sha256(`${embedding}\n${rows.join('\n')}`);
}

/** Compare a frozen top-5 list with R1's stored list. */
export function compareWithR1(hits5: Array<{ rank: number; slug: string; chunk_id: number }>, r1Retrieved: Array<{ rank: number; slug: string; chunk_id: number }> | undefined) {
  if (!r1Retrieved) return null;
  const sig = (xs: Array<{ rank: number; slug: string; chunk_id: number }>, withChunk: boolean) => xs.filter(x => x.rank <= 5).sort((a, b) => a.rank - b.rank).map(x => withChunk ? `${x.slug}#${x.chunk_id}` : x.slug).join(',');
  return { identical_slug_chunk_rank: sig(hits5, true) === sig(r1Retrieved, true), identical_slug_rank: sig(hits5, false) === sig(r1Retrieved, false), r1_sig: sig(r1Retrieved, true) };
}

/**
 * Keyless $0 summary of the W6 embedding matrix (2026-10 follow-up round).
 *
 *   bun eval/runner/w6-embedding-matrix.ts summarize <results dir>
 *
 * Reads the Cat 13 receipts (`cat13-<embedder>-rerank-<on|off>.receipt.json`)
 * and the Cat 18b receipts (`cat18b*.receipt.json`) in the directory and
 * prints, per cell: held-out exact-target-first and nDCG@5 (181 questions),
 * all-548 values, query-phase cost per 1,000 queries, latency, data egress
 * and validity (a reranked run is invalid unless the reranker scored every
 * query). Paired comparisons on held-out exact-target-first are clustered by
 * concept (exact sign-flip test, cluster bootstrap), with exact McNemar beside;
 * Holm runs within each family. The primary family is reranker on, each
 * embedder against voyage-4.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { clusteredPairedDelta, exactMcNemar, holmAdjusted, type PairedItem } from './stats/paired.ts';

export const SEED = 20261006;
export const DRAWS = 10_000;
export const COMPARATOR = 'voyage-4';

interface Cat13Row { id: string; subset: string; p1_strict: number; ndcg5: number; cluster_id: string }
interface Cat13Receipt {
  resolved_config: { embedder: { model: string; dims: number }; observed_by_adapter?: Record<string, { rerank_scored_queries?: number; queries?: number } | null>; pins?: Record<string, unknown> };
  data: { scorecard: Array<{ name: string; ndcg5: number; p1_strict: number; holdout?: { ndcg5: number; p1_strict: number; count: number }; phase?: { cost_per_1000_queries_usd: number | null; query_cost_usd: number | null; ingest_cost_usd: number | null; query_ms: { mean: number; p50: number; p95: number } | null } }>; per_query: Record<string, Cat13Row[]> };
  cost?: { usd: number } | null;
}

export interface Cell {
  file: string; embedder: string; rerank: boolean; valid: boolean; invalid_reason: string | null;
  heldout_first: number; heldout_n: number; heldout_ndcg5: number; all_first: number; all_ndcg5: number;
  cost_per_1000_queries_usd: number | null; query_ms_mean: number | null; query_ms_p95: number | null; run_cost_usd: number | null; egress: string;
  rows: Cat13Row[];
}

export function egressFor(embedder: string, rerank: boolean): string {
  const local = embedder.startsWith('ollama:');
  if (local) return rerank ? 'local embedding, hosted reranking' : 'local: no text leaves the machine';
  return rerank ? 'hosted embedding, hosted reranking' : 'hosted embedding';
}

export function cellFrom(file: string, r: Cat13Receipt): Cell {
  const card = r.data.scorecard[0]!;
  const rows = r.data.per_query[card.name] ?? [];
  const held = rows.filter(x => x.subset === 'holdout');
  const rerank = /rerank-on/.test(file);
  const observed = r.resolved_config.observed_by_adapter?.[card.name] ?? null;
  const scored = observed?.rerank_scored_queries ?? 0;
  const valid = !rerank || scored === rows.length;
  const short = r.resolved_config.embedder.model.replace(/^[a-z]+:/, '');
  return {
    file, embedder: short === 'text-embedding-3-large' ? 'openai-1536' : short.startsWith('qwen3') ? 'qwen3-local' : short, rerank, valid,
    invalid_reason: valid ? null : `reranker scored ${scored} of ${rows.length} queries`,
    heldout_first: held.filter(x => x.p1_strict === 1).length, heldout_n: held.length,
    heldout_ndcg5: held.reduce((a, x) => a + x.ndcg5, 0) / Math.max(1, held.length),
    all_first: rows.filter(x => x.p1_strict === 1).length, all_ndcg5: card.ndcg5,
    cost_per_1000_queries_usd: card.phase?.cost_per_1000_queries_usd ?? null, query_ms_mean: card.phase?.query_ms?.mean ?? null, query_ms_p95: card.phase?.query_ms?.p95 ?? null,
    run_cost_usd: r.cost?.usd ?? null, egress: egressFor(r.resolved_config.embedder.model, rerank), rows,
  };
}

export function compare(a: Cell, b: Cell) {
  const bm = new Map(b.rows.filter(x => x.subset === 'holdout').map(x => [x.id, x]));
  const pairs: PairedItem[] = a.rows.filter(x => x.subset === 'holdout' && bm.has(x.id)).map(x => ({ id: x.id, cluster: x.cluster_id, a: x.p1_strict, b: bm.get(x.id)!.p1_strict }));
  const d = clusteredPairedDelta(pairs, { seed: SEED, draws: DRAWS });
  const m = exactMcNemar(pairs);
  return { a: `${a.embedder}${a.rerank ? '+rerank' : ''}`, b: `${b.embedder}${b.rerank ? '+rerank' : ''}`, n: d.n_pairs, clusters: d.n_clusters, delta: d.delta, ci95: d.ci95,
    p_sign_flip: d.p_two_sided, mcnemar: { gained: m.wins, lost: m.losses, p: m.p_two_sided } };
}

export function summarize(cells: Cell[]) {
  const find = (e: string, r: boolean) => cells.find(c => c.embedder === e && c.rerank === r && c.valid);
  const family = (name: string, pairs: Array<[Cell | undefined, Cell | undefined]>) => {
    const rows = pairs.filter((p): p is [Cell, Cell] => !!p[0] && !!p[1]).map(([a, b]) => compare(a, b));
    const holm = holmAdjusted(rows.map(r => r.p_sign_flip));
    return { family: name, comparisons: rows.map((r, i) => ({ ...r, p_holm: holm[i]! })) };
  };
  const others = ['voyage-4-large', 'openai-1536', 'qwen3-local'];
  return {
    cells: cells.map(({ rows: _rows, ...c }) => c),
    families: [
      family('primary: reranker on, each embedder vs voyage-4', others.map(e => [find(COMPARATOR, true), find(e, true)])),
      family('report-only: reranker off, each embedder vs voyage-4', others.map(e => [find(COMPARATOR, false), find(e, false)])),
      family('report-only: reranker effect per embedder (off vs on)', [COMPARATOR, ...others].map(e => [find(e, false), find(e, true)])),
    ],
  };
}

if (import.meta.main) {
  const [cmd, dir] = process.argv.slice(2);
  if (cmd !== 'summarize' || !dir) { console.error('usage: bun eval/runner/w6-embedding-matrix.ts summarize <results dir>'); process.exit(2); }
  const load = (f: string) => JSON.parse(f.endsWith('.gz') ? gunzipSync(readFileSync(join(dir, f))).toString('utf8') : readFileSync(join(dir, f), 'utf8'));
  const files = readdirSync(dir).filter(f => /^cat13-.*\.receipt\.json(\.gz)?$/.test(f)).sort();
  const parsed = files.map(f => [f.replace(/\.gz$/, ''), load(f)] as const);
  const cells = parsed.filter(([, r]) => r.data?.scorecard?.length).map(([f, r]) => cellFrom(f, r as Cat13Receipt));
  const notScored = parsed.filter(([, r]) => !r.data?.scorecard?.length).map(([f, r]) => ({ file: f, run_status: r.run_status, reason: r.skip_reason ?? r.errors?.[0]?.message ?? null }));
  const cat18b = readdirSync(dir).filter(f => /^cat18b.*\.receipt\.json$/.test(f)).sort().flatMap(f => {
    const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { data?: { cells?: Array<Record<string, unknown>> } };
    return (r.data?.cells ?? []).map(c => ({ file: f, cell: c.cell, valid: c.valid, invalid_reasons: c.invalid_reasons, mrr: c.mrr, recall_at_10: c.recall_at_10, top1_hit_rate: c.top1_hit_rate,
      rerank_scored_queries: c.rerank_scored_queries, queries_total: c.queries_total, cost_per_1000_queries_usd: c.cost_per_1000_queries_usd ?? null, ingest_cost_usd: c.ingest_cost_usd ?? null,
      mean_query_ms: c.mean_query_ms, p95_query_ms: c.p95_query_ms ?? null, data_egress: c.data_egress ?? null }));
  });
  console.log(JSON.stringify({ cat13: { ...summarize(cells), not_scored: notScored }, cat18b }, null, 2));
}

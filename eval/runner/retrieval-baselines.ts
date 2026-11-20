/**
 * No-gbrain retrieval baselines for README's relationship and attendance rows
 * (docs/plans/2026-11-17-readme-baselines/PREREG.md).
 *
 * Runs one baseline arm over a world-v1-shaped corpus with the questions,
 * ingestion orders and recall@5 definition of the published gbrain rows
 * (relational-ab.ts and n9-multi-hop-paraphrase.ts), then pairs its
 * per-question rows with a committed gbrain receipt. No gbrain search,
 * import or extraction code runs in an arm:
 *
 *   bm25          adapters/grep-only.ts (BM25, k1 1.5, b 0.75), keyless
 *   vector        adapters/vector.ts: one text-embedding-3-large vector per
 *                 page at 1,536 dims, cosine ranking; gbrain's embedding
 *                 client is the only gbrain code it calls
 *   plain-hybrid  systems/baselines.ts PlainHybridSystem: Postgres full-text
 *                 plus pgvector, reciprocal-rank fusion, one row per page,
 *                 OpenAI embeddings through cat40/pg-arm.ts
 *
 * Scoring is relational-ab's: the first five distinct pages in rank order,
 * recall@5 = listed gold pages among them / gold pages (metrics.ts). Each
 * ingestion seed shuffles the pages with relational-ab's LCG, so the order
 * hashes match the gbrain receipts' indices.
 *
 *   bun eval/runner/retrieval-baselines.ts run --arm bm25|vector|plain-hybrid --split template|paraphrase
 *     [--corpus <dir>] [--template attended] [--seeds 1,2,3] [--stub-embed] --output <rows.json>
 *     [--paid --budget-run-id <id>]   (vector and plain-hybrid without --stub-embed)
 *   bun eval/runner/retrieval-baselines.ts pair --baseline <rows.json> --gbrain <receipt.json> [--gbrain-arm on|off] --output <pair.json>
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RipgrepBm25Adapter } from './adapters/grep-only.ts';
import { PlainHybridSystem } from './systems/baselines.ts';
import { cachedOpenAIEmbedder, type Embedder } from './cat40/pg-arm.ts';
import { buildRelationalQueries, loadWorldCorpus, type RichPage } from './queries/relational.ts';
import { renderParaphraseFile, templateOfText, type ParaphraseFile } from '../generators/relational-paraphrase-gen.ts';
import { precisionAtK, recallAnyAtK, recallAtK } from './metrics.ts';
import { sanitizePage, sanitizeQuery, type Adapter, type AdapterConfig, type BrainState, type Page, type PublicQuery, type Query, type RankedDoc } from './types.ts';
import { budgetOptionsFrom, receiptCost, startPaidRun } from './budget-ledger.ts';
import { requirePaidArm } from './paid-arm.ts';

export const TOP_K = 5;
export const ARMS = ['bm25', 'vector', 'plain-hybrid'] as const;
export type Arm = (typeof ARMS)[number];
export const ESTIMATE_USD = 0.1;

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/** relational-ab's seeded shuffle, byte for byte, so ingestion orders match the gbrain receipts. */
export function ingestionOrder<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    const j = Math.floor((state / 0x100000000) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export type SplitQuery = Query & { split: string; template: string };

/** The one-hop questions and gold the gbrain rows ran: template wording, or the frozen paraphrase grammar with -p ids. */
export function buildQueries(pages: RichPage[], split: 'template' | 'paraphrase', corpusDir?: string): SplitQuery[] {
  const templates = buildRelationalQueries(pages).map(q => ({ ...q, split: 'template', template: templateOfText(q.text) }));
  if (split === 'template') return templates;
  const file = JSON.parse(renderParaphraseFile(corpusDir)) as ParaphraseFile;
  const byId = new Map(file.paraphrases.map(p => [p.query_id, p]));
  return templates.map(q => ({ ...q, id: q.id + '-p', text: byId.get(q.id)!.text, split: 'paraphrase', template: byId.get(q.id)!.template }));
}

/** PlainHybridSystem over pages: one row per page (title, then body), retrieved at k = TOP_K. */
export class PlainHybridPageAdapter implements Adapter {
  readonly name = 'plain-hybrid';
  constructor(private readonly embed: Embedder) {}

  async init(pages: Page[], _config: AdapterConfig): Promise<BrainState> {
    const system = new PlainHybridSystem(this.embed);
    for (const p of pages) {
      await system.ingestSession('pages', { source_id: p.slug, turns: [{ role: 'user', speaker: p.title, content: p.compiled_truth + '\n\n' + p.timeline }] }, null);
    }
    const finish = await system.finishIngest('pages');
    if (!finish.ready) throw new Error('plain-hybrid ingest incomplete: ' + JSON.stringify(finish.raw ?? {}));
    return system;
  }

  async query(q: PublicQuery, state: BrainState): Promise<RankedDoc[]> {
    const r = await (state as PlainHybridSystem).retrieve('pages', { text: q.text, query_time: null }, { name: 'plain-hybrid:vendor-default', mode: 'vendor-default', settings: { k: TOP_K } });
    return r.items.map((item, i) => ({ page_id: item.id, score: 1 / (i + 1), rank: i + 1 }));
  }

  async snapshot(_state: BrainState): Promise<string> { return ''; }
  async teardown(state: BrainState): Promise<void> { await (state as PlainHybridSystem).close(); }
}

/** Keyless stand-in embedder for plumbing tests: token hashes, never a provider call. */
export function hashEmbedder(dims = 1536): Embedder {
  return async texts => texts.map(text => {
    const v = new Array<number>(dims).fill(0);
    for (const t of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) v[createHash('sha256').update(t).digest().readUInt32LE() % dims] += 1;
    const n = Math.hypot(...v) || 1;
    return v.map(x => x / n);
  });
}

export interface BaselineRow {
  seed: number; query_id: string; text: string; template: string; split: string; relevant: string[];
  pages: string[]; metrics: { precision_at_5: number; recall_at_5: number; hit_at_1: number; hit_at_5: number } | null; error: string | null;
}

export async function runBaseline(o: { adapter: Adapter; pages: RichPage[]; queries: SplitQuery[]; seeds: number[] }) {
  const rows: BaselineRow[] = [];
  const indices: Array<{ seed: number; ingestion_order_sha256: string }> = [];
  for (const seed of o.seeds) {
    const shuffled = ingestionOrder(o.pages, seed);
    indices.push({ seed, ingestion_order_sha256: sha256(JSON.stringify(shuffled.map(p => p.slug))) });
    const state = await o.adapter.init(shuffled.map(p => sanitizePage(p) as Page), { name: o.adapter.name });
    try {
      for (const q of o.queries) {
        const relevant = new Set(q.gold.relevant ?? []);
        const base = { seed, query_id: q.id, text: q.text, template: q.template, split: q.split, relevant: [...relevant] };
        try {
          const ranked = await o.adapter.query(sanitizeQuery(q), state);
          const seen = new Set<string>();
          const pages = ranked.map(r => r.page_id).filter(id => !seen.has(id) && seen.add(id)).slice(0, TOP_K);
          rows.push({ ...base, pages, error: null, metrics: {
            precision_at_5: precisionAtK(pages, relevant, TOP_K), recall_at_5: recallAtK(pages, relevant, TOP_K),
            hit_at_1: recallAnyAtK(pages, relevant, 1), hit_at_5: recallAnyAtK(pages, relevant, TOP_K),
          } });
        } catch (error) {
          rows.push({ ...base, pages: [], error: String(error), metrics: null });
        }
      }
    } finally {
      await o.adapter.teardown?.(state);
    }
  }
  return { rows, indices };
}

// ─── Pairing ─────────────────────────────────────────────────────────

/** Exact two-sided binomial sign test, ties dropped. */
export function signTest(better: number, worse: number): number {
  const n = better + worse;
  if (n === 0) return 1;
  const k = Math.min(better, worse);
  let tail = 0;
  for (let i = 0; i <= k; i++) {
    let c = 1;
    for (let j = 0; j < i; j++) c = (c * (n - j)) / (j + 1);
    tail += c / 2 ** n;
  }
  return Math.min(1, 2 * tail);
}

/** Percentile bootstrap interval of a mean, with a fixed LCG so the interval is reproducible. */
export function bootstrapMeanCI(xs: number[], reps = 10_000, seed = 20261117): [number, number] {
  if (!xs.length) return [NaN, NaN];
  let s = seed >>> 0;
  const means: number[] = [];
  for (let r = 0; r < reps; r++) {
    let sum = 0;
    for (let i = 0; i < xs.length; i++) { s = (Math.imul(1664525, s) + 1013904223) >>> 0; sum += xs[Math.floor((s / 0x100000000) * xs.length)]!; }
    means.push(sum / xs.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * reps)]!, means[Math.ceil(0.975 * reps) - 1]!];
}

export interface GbrainRow { seed: number; query_id: string; split: string; template: string; text: string; relevant?: string[]; on?: Record<string, unknown> | null; off?: Record<string, unknown> | null }

/** recall@5 of one gbrain arm, from either receipt shape (relational-ab nests metrics; N9 one-hop rows hold them flat). */
const gbrainRecall = (arm: Record<string, unknown> | null | undefined): number | null => {
  if (!arm) return null;
  const m = (arm.metrics ?? arm) as { recall_at_5?: number } | null;
  return typeof m?.recall_at_5 === 'number' ? m.recall_at_5 : null;
};

export function gbrainRows(receipt: { data: { per_query?: GbrainRow[]; one_hop?: { per_query?: GbrainRow[] } } }): GbrainRow[] {
  return receipt.data.per_query ?? receipt.data.one_hop?.per_query ?? [];
}

export function pairRows(baseline: BaselineRow[], gbrain: GbrainRow[], arm: 'on' | 'off') {
  const key = (seed: number, id: string) => seed + ':' + id;
  const g = new Map(gbrain.map(r => [key(r.seed, r.query_id), r]));
  const mismatches: string[] = [];
  const perRun = baseline.map(b => {
    const r = g.get(key(b.seed, b.query_id));
    if (!r) { mismatches.push(key(b.seed, b.query_id) + ': no gbrain row'); return null; }
    if (r.text !== b.text) mismatches.push(key(b.seed, b.query_id) + ': text differs');
    if (r.relevant && JSON.stringify([...r.relevant].sort()) !== JSON.stringify([...b.relevant].sort())) mismatches.push(key(b.seed, b.query_id) + ': gold differs');
    if (b.error || !b.metrics) mismatches.push(key(b.seed, b.query_id) + ': baseline row errored');
    const gr = gbrainRecall(r[arm]);
    if (gr === null) mismatches.push(key(b.seed, b.query_id) + ': gbrain row has no recall_at_5');
    return { seed: b.seed, query_id: b.query_id, baseline: b.metrics?.recall_at_5 ?? 0, gbrain: gr ?? 0 };
  }).filter((x): x is NonNullable<typeof x> => x !== null);
  const byQ = new Map<string, { b: number[]; g: number[] }>();
  for (const r of perRun) {
    const e = byQ.get(r.query_id) ?? { b: [], g: [] };
    e.b.push(r.baseline); e.g.push(r.gbrain); byQ.set(r.query_id, e);
  }
  const mean = (xs: number[]) => xs.reduce((a, c) => a + c, 0) / xs.length;
  const perQuestion = [...byQ.entries()].map(([query_id, e]) => ({ query_id, baseline: mean(e.b), gbrain: mean(e.g), diff: mean(e.g) - mean(e.b) }));
  const eps = 1e-12;
  const gbrainBetter = perQuestion.filter(q => q.diff > eps).length;
  const baselineBetter = perQuestion.filter(q => q.diff < -eps).length;
  const p = signTest(gbrainBetter, baselineBetter);
  const classification = p < 0.05 ? (gbrainBetter > baselineBetter ? 'win' : 'loss') : 'no measurable difference';
  return {
    gbrain_arm: arm, runs: perRun.length, questions: perQuestion.length, mismatches,
    baseline_recall_at_5: perRun.length ? mean(perRun.map(r => r.baseline)) : NaN,
    gbrain_recall_at_5: perRun.length ? mean(perRun.map(r => r.gbrain)) : NaN,
    runs_gbrain_better: perRun.filter(r => r.gbrain - r.baseline > eps).length,
    runs_baseline_better: perRun.filter(r => r.baseline - r.gbrain > eps).length,
    questions_gbrain_better: gbrainBetter, questions_baseline_better: baselineBetter,
    questions_same: perQuestion.length - gbrainBetter - baselineBetter,
    sign_test_p: p, mean_diff_gbrain_minus_baseline: perQuestion.length ? mean(perQuestion.map(q => q.diff)) : NaN,
    ci95_bootstrap_questions: bootstrapMeanCI(perQuestion.map(q => q.diff)),
    classification, per_question: perQuestion,
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]) {
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const command = argv[0];
  if (command !== 'run' && command !== 'pair') throw new Error('usage: retrieval-baselines.ts run|pair ...');
  const output = one('--output');
  if (!output) throw new Error('--output is required');
  if (command === 'pair') {
    const baseline = one('--baseline'), gbrain = one('--gbrain');
    if (!baseline || !gbrain) throw new Error('pair needs --baseline and --gbrain');
    const arm = (one('--gbrain-arm') ?? 'on') as 'on' | 'off';
    if (arm !== 'on' && arm !== 'off') throw new Error('--gbrain-arm must be on or off');
    return { command, output, baseline, gbrain, arm } as const;
  }
  const arm = one('--arm') as Arm | undefined;
  if (!arm || !ARMS.includes(arm)) throw new Error('--arm must be one of ' + ARMS.join(', '));
  const split = one('--split') as 'template' | 'paraphrase' | undefined;
  if (split !== 'template' && split !== 'paraphrase') throw new Error('--split must be template or paraphrase');
  const seeds = (one('--seeds') ?? '1,2,3').split(',').map(Number);
  if (seeds.some(s => !Number.isInteger(s) || s < 1)) throw new Error('--seeds must be positive integers');
  const stubEmbed = argv.includes('--stub-embed');
  if (arm === 'vector' && stubEmbed) throw new Error('--stub-embed applies to plain-hybrid only; the vector arm needs live embeddings');
  return { command, output, arm, split, seeds, corpus: one('--corpus'), template: one('--template'), stubEmbed, argv } as const;
}

export async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  mkdirSync(dirname(a.output), { recursive: true });
  if (a.command === 'pair') {
    const baseline = JSON.parse(readFileSync(a.baseline, 'utf8')) as { rows: BaselineRow[]; indices: Array<{ seed: number; ingestion_order_sha256: string }> };
    const receipt = JSON.parse(readFileSync(a.gbrain, 'utf8'));
    const gIndices = (receipt.data.indices ?? []) as Array<{ seed: number; ingestion_order_sha256: string }>;
    const orderMatches = baseline.indices.every(i => gIndices.some(g => g.seed === i.seed && g.ingestion_order_sha256 === i.ingestion_order_sha256));
    const ids = new Set(baseline.rows.map(r => r.query_id));
    const pair = pairRows(baseline.rows, gbrainRows(receipt).filter(r => ids.has(r.query_id)), a.arm);
    writeFileSync(a.output, JSON.stringify({ gbrain_receipt: a.gbrain, gbrain_pin: receipt.gbrain_pin ?? null, ingestion_orders_match: orderMatches, ...pair }, null, 2) + '\n');
    console.log(JSON.stringify({ ...pair, per_question: undefined, ingestion_orders_match: orderMatches }));
    return pair.mismatches.length || !orderMatches ? 1 : 0;
  }
  const corpusDir = a.corpus ?? join(import.meta.dir, '../data/world-v1');
  const pages = loadWorldCorpus(corpusDir);
  const queries = buildQueries(pages, a.split, a.corpus).filter(q => !a.template || q.template === a.template);
  let paid: ReturnType<typeof startPaidRun> | null = null;
  if (a.arm !== 'bm25' && !a.stubEmbed) {
    requirePaidArm(a.argv, { arm: 'retrieval-baselines ' + a.arm, estimateUsd: ESTIMATE_USD });
    paid = startPaidRun('retrieval-baselines:' + a.arm, { ...budgetOptionsFrom(a.argv), estimateUsd: ESTIMATE_USD });
  }
  const started = new Date().toISOString();
  let result: Awaited<ReturnType<typeof runBaseline>>;
  let cost: unknown = null;
  try {
    const adapter: Adapter = a.arm === 'bm25' ? new RipgrepBm25Adapter()
      : a.arm === 'vector' ? new (await import('./adapters/vector.ts')).VectorOnlyAdapter()
      : new PlainHybridPageAdapter(a.stubEmbed ? hashEmbedder() : cachedOpenAIEmbedder(join(import.meta.dir, '../reports/retrieval-baselines/embed-cache.json')));
    result = await runBaseline({ adapter, pages, queries, seeds: a.seeds });
  } finally {
    if (paid) { cost = receiptCost(paid.run.close()); paid.guard.uninstall(); }
  }
  const scored = result.rows.filter(r => r.metrics);
  const mean = (k: keyof NonNullable<BaselineRow['metrics']>) => scored.reduce((s, r) => s + r.metrics![k], 0) / (scored.length || 1);
  const summary = { runs: result.rows.length, errors: result.rows.length - scored.length, recall_at_5: mean('recall_at_5'), hit_at_1: mean('hit_at_1'), hit_at_5: mean('hit_at_5'), precision_at_5: mean('precision_at_5') };
  writeFileSync(a.output, JSON.stringify({
    runner: 'eval/runner/retrieval-baselines.ts', runner_sha256: sha256(readFileSync(import.meta.path, 'utf8')), started_at: started, finished_at: new Date().toISOString(),
    arm: a.arm, split: a.split, template_filter: a.template ?? null, corpus: a.corpus ?? 'eval/data/world-v1', seeds: a.seeds,
    embedder: a.arm === 'bm25' ? null : a.stubEmbed ? 'hash stub (plumbing only)' : 'openai:text-embedding-3-large@1536',
    top_k: TOP_K, scoring_unit: 'first five distinct pages in rank order; recall@5 = gold pages among them / gold pages',
    corpus_sha256: sha256(JSON.stringify(pages.map(p => sanitizePage(p)))), queries_sha256: sha256(JSON.stringify(queries)),
    cost, summary, indices: result.indices, rows: result.rows,
  }, null, 2) + '\n');
  console.log(JSON.stringify({ arm: a.arm, split: a.split, ...summary, cost }));
  return summary.errors ? 1 : 0;
}

if (import.meta.main) main(process.argv.slice(2)).then(code => { process.exitCode = code; });

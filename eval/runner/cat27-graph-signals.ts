/**
 * BrainBench Cat 27 — Graph signals A/B (v0.40.4).
 *
 * The headline product question for gbrain v0.40.4: do the per-query graph
 * signals (adjacency boost, cross-source boost, session-demote) actually
 * surface better top-K results than the same hybrid search without them?
 *
 * ── Feature boundary ─────────────────────────────────────────────────
 * UNDER TEST: gbrain's import → link-graph → hybridSearch pipeline with the
 * graph_signals stage toggled per cell (applyGraphSignals in
 * search/graph-signals.ts, threaded via SearchOpts.graph_signals and the
 * `search.graph_signals` config key). Search mode + reranker are pinned
 * identically in BOTH cells (WS5) so the ONLY difference is the toggle.
 * LEGITIMATELY SEEDED/STUBBED: the hand-curated probe corpora (each probe is
 * a controlled experiment, committed inline), the links table rows (inserted
 * directly from extractEntityRefs because importFromContent does not fire
 * the put_page auto-link op), and the embed HTTP transport — a deterministic
 * feature-hash embedding via gbrain's __setEmbedTransportForTests seam, so
 * the run is truly hermetic (audit cats26-29-03: the previous header claimed
 * "no API keys" while importFromContent's inline embed required
 * OPENAI_API_KEY, and every keyless probe crashed into an empty scorecard
 * that exited 0). Hash-embed runs exercise the full pipeline but are stamped
 * resolved_config.embed_transport='stubbed-hash'; they are a regression
 * gate on the graph-signal code path, not an embedder-quality claim.
 *
 * ── Scoring policy (WS0) ─────────────────────────────────────────────
 * nDCG@10 + top-1 come from eval/runner/metrics.ts on page-normalized
 * unique slug lists (uniqueInOrder collapses duplicate chunk rows before
 * scoring, so nDCG can never exceed 1.0 — audit cats26-29-04). Probe
 * failures route through eval/runner/probe-accounting.ts with origin 'sut'
 * (scored 0, kept in the denominator) — never silently dropped (audit
 * cats26-29-05).
 *
 * ── Verdict (real + failable) ────────────────────────────────────────
 * pass — every probe scored with zero sut errors AND the wave does not
 *        regress the baseline on either aggregate (top-1 hit-rate delta >= 0
 *        AND mean nDCG@10 delta >= 0).
 * fail — any probe errored, nothing scored, or the signals regressed an
 *        aggregate. Exit code is non-zero unless verdict === 'pass'.
 *
 * Per-probe flow:
 *   1. Seed a federated PGLite brain with the probe's pages distributed
 *      across N sources; insert `[[wiki/...]]` link rows.
 *   2. hybridSearch with graph_signals OFF (baseline), then ON (wave).
 *   3. Score both against the probe's hand-curated relevant set.
 *   4. Emit shared receipt + per-family scorecard.
 *
 * Run (no API keys needed):
 *   bun eval/runner/cat27-graph-signals.ts
 *   CAT27_PROBES=adjacency-hub-acme-ai bun eval/runner/cat27-graph-signals.ts
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { extractEntityRefs } from 'gbrain/link-extraction';
import { hybridSearch } from 'gbrain/search/hybrid';
import {
  configureGateway,
  getEmbeddingDimensions,
  __setEmbedTransportForTests,
} from 'gbrain/ai/gateway';
import { uniqueInOrder, ndcgAtK } from './metrics.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { writeReceipt, receiptPath, BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, type Receipt } from './receipt.ts';
import { gbrainVersion as gbrainVersionResolved, gbrainPin } from './gbrain-version.ts';

export const CAT27_CATEGORY = 'cat27-graph-signals';

/**
 * WS5 pin — applied via engine.setConfig BEFORE ingest in every probe brain
 * and echoed into the receipt's resolved_config. Both A/B cells share these;
 * only graph_signals differs. Never rely on mode defaults: gbrain's
 * 'balanced' bundle silently enables the zerank-2 reranker when
 * ZEROENTROPY_API_KEY is set, plus relational retrieval (autocut is off in
 * balanced since v0.48.4.0 but stays pinned so older pins read the same) —
 * any of which would confound a graph-signal-only A/B. The metadata boost
 * gate is pinned to `always`: under the v0.48.4.0 default (`lexical`) the
 * graph-signal stage only runs when a keyword/title/relational row fused, so
 * the A/B would silently measure "graph signals given a lexical vote".
 */
export const PINNED_CONFIG: Record<string, string> = {
  'search.mode': 'balanced',
  'search.reranker.enabled': 'false',
  'search.expansion': 'false',
  'search.autocut': 'false',
  'search.cache.enabled': 'false',
  'search.relational_retrieval': 'false',
  'search.metadata_boost_gate': 'always',
};

// ─── Deterministic hash embedding (hermetic transport) ────────────────

/**
 * FNV-1a feature-hash embedding: same text → same unit vector, token overlap
 * → cosine similarity. Exercises the real embed/store/query pipeline without
 * network or keys. (Same construction as cat18's stub; duplicated locally so
 * this runner has no cross-runner import coupling.)
 */
export function hashEmbedVector(text: string, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1);
  for (const tok of tokens) {
    let h = 0x811c9dc5;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    v[h % dim] += ((h >>> 8) & 1) ? 1 : -1;
  }
  let norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  if (norm === 0) { v[0] = 1; norm = 1; }
  return v.map(x => x / norm);
}

/**
 * Install the deterministic hash-embed transport + dummy provider key.
 * Model construction requires a non-empty OPENAI_API_KEY even when the
 * transport is stubbed, so we set a dummy when the env has none — no real
 * key is ever required or used.
 */
export function installStubEmbed(failOn?: (text: string) => boolean): void {
  if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = 'dummy-stub-embed';
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: process.env as Record<string, string | undefined>,
  });
  __setEmbedTransportForTests((async (params: { values: string[] }) => {
    const dim = getEmbeddingDimensions();
    const embeddings = params.values.map(t => {
      if (failOn?.(t)) throw new Error('stub embed transport: forced failure (test hook)');
      return hashEmbedVector(t, dim);
    });
    return { embeddings, values: params.values, warnings: [] };
  }) as unknown as Parameters<typeof __setEmbedTransportForTests>[0]);
}

// ─── Probe DSL ─────────────────────────────────────────────────────────

export interface ProbePage {
  slug: string;
  source_id: string;
  title: string;
  body: string;  // markdown body; `[[wiki/...]]` refs feed the links table
  session_id?: string;  // for `session` probes
}

export interface Probe {
  id: string;
  family: 'adjacency' | 'cross_source' | 'session';
  description: string;
  pages: ProbePage[];
  query: string;
  relevant_slugs: string[];  // gold (most-relevant FIRST)
}

// Hand-curated probes. Small + transparent — each one is a controlled
// experiment, not a fuzz set. The point isn't statistical power across
// 500 probes; it's a clear illustration of each signal under conditions
// the signal was designed for.
//
// Design discipline: the GOLD page must NOT contain the literal query
// keywords. If it did, keyword + title matching alone would win and the
// signal's contribution would be invisible. Every probe is designed so
// the baseline picks the WRONG page, and the signal flips the ranking.
export const PROBES: Probe[] = [
  // ── adjacency: hub page surfaces because peer pages linking to it dominate ─
  {
    id: 'adjacency-hub-acme-ai',
    family: 'adjacency',
    description: 'companies/acme-ai is the hub. 4 people pages and 2 deal pages reference it. The hub page itself has NO keyword overlap with the query — without adjacency boost a single keyword-rich employee bio wins.',
    pages: [
      // Hub page: short, generic, NO overlap with "AI infrastructure stack"
      { slug: 'companies/acme-ai', source_id: 'default', title: 'Acme AI', body: 'Founded 2024. Series A.' },
      // 4 employee bios that all match "AI infrastructure stack" strongly AND link to the hub
      { slug: 'people/alice-okafor', source_id: 'default', title: 'Alice Okafor', body: 'Alice Okafor is the CEO of [[companies/acme-ai]]. Previously built the AI infrastructure stack at OpenAI.' },
      { slug: 'people/bob-chen', source_id: 'default', title: 'Bob Chen', body: 'Bob Chen is CTO at [[companies/acme-ai]]. Built the AI infrastructure stack and inference layer.' },
      { slug: 'people/carol-singh', source_id: 'default', title: 'Carol Singh', body: 'Carol Singh, VP Eng at [[companies/acme-ai]], owns the AI infrastructure stack and GPU scheduling.' },
      { slug: 'people/dan-park', source_id: 'default', title: 'Dan Park', body: 'Dan Park leads ML research at [[companies/acme-ai]]. Co-authored the AI infrastructure stack paper.' },
      { slug: 'deal/acme-ai-series-a', source_id: 'default', title: 'Acme AI Series A', body: '[[companies/acme-ai]] raised $30M Series A to scale the AI infrastructure stack.' },
      { slug: 'deal/acme-ai-seed', source_id: 'default', title: 'Acme AI seed', body: '[[companies/acme-ai]] earlier seed round of $4M to validate the AI infrastructure stack thesis.' },
      // Distractor: keyword-rich but no inbound links from peers
      { slug: 'companies/widget-co', source_id: 'default', title: 'Widget Co', body: 'Widget Co does AI infrastructure stack consulting for enterprise. Founded 2024.' },
    ],
    query: 'who is the AI infrastructure stack company',
    relevant_slugs: ['companies/acme-ai'],
  },
  // ── cross_source: page wins because 3 different sources corroborate it ──
  {
    id: 'cross-source-corroborated-fund-x',
    family: 'cross_source',
    description: 'companies/fund-x is referenced by pages in 3 sources (notes/meetings/deal). The fund page itself does NOT contain the query keywords. Without cross-source boost, the keyword-rich single-source competitor wins.',
    pages: [
      // Gold: minimal body, no query-term overlap
      { slug: 'companies/fund-x', source_id: 'default', title: 'Fund X', body: 'Based in SF.' },
      // 3 sources reference fund-x
      { slug: 'people/anna-notes-fund-x', source_id: 'notes', title: 'Notes from meeting', body: 'Met with [[companies/fund-x]] partner. They lead seed rounds in early ML and AI.' },
      { slug: 'meetings/2026-05-fund-x-quarterly', source_id: 'meetings', title: 'Quarterly review', body: 'Quarterly with [[companies/fund-x]]. They focus on early-stage seed-round investments in ML and AI infra.' },
      { slug: 'deal/widget-co-seed', source_id: 'deal', title: 'Widget Co seed', body: '[[companies/fund-x]] led the seed round in [[companies/widget-co]]. Their thesis is early-stage AI infra investing.' },
      // Single-source competitor: keyword-rich, ONE source mention
      { slug: 'companies/fund-y', source_id: 'default', title: 'Fund Y', body: 'Fund Y is a seed-stage venture fund focused on early ML and AI investments. They lead seed rounds and partner with founders early.' },
      { slug: 'people/bob-notes-fund-y', source_id: 'notes', title: 'Fund Y note', body: 'Brief note on [[companies/fund-y]]. Met once.' },
      { slug: 'companies/widget-co', source_id: 'deal', title: 'Widget Co', body: 'Widget Co does ML consulting.' },
    ],
    query: 'seed-stage fund early ML and AI',
    relevant_slugs: ['companies/fund-x'],
  },
  // ── adjacency-close: hub is rank-2 in baseline, boost should flip to rank-1
  {
    id: 'adjacency-close-hub-foundry',
    family: 'adjacency',
    description: 'Hub page IS in baseline top-3 (one keyword match). Adjacency boost from 2+ peers should flip the close ranking to top-1.',
    pages: [
      // Hub: title matches the query weakly, body has one match
      { slug: 'companies/foundry-labs', source_id: 'default', title: 'Foundry Labs', body: 'Foundry Labs is a robotics company. Working on autonomous picking.' },
      // 4 peers that ALL link the hub, all stronger keyword matches
      { slug: 'people/erin-yu', source_id: 'default', title: 'Erin Yu', body: 'Erin Yu leads autonomous picking at [[companies/foundry-labs]] — robotics company stack.' },
      { slug: 'people/frank-osman', source_id: 'default', title: 'Frank Osman', body: 'Frank Osman, robotics company CTO at [[companies/foundry-labs]], owns the autonomous picking platform.' },
      { slug: 'people/grace-park', source_id: 'default', title: 'Grace Park', body: 'Grace Park: robotics company VP at [[companies/foundry-labs]] for autonomous picking.' },
      { slug: 'people/henry-davis', source_id: 'default', title: 'Henry Davis', body: 'Henry Davis advises [[companies/foundry-labs]] on robotics company autonomous picking.' },
      // Distractor: keyword-rich, no inbound
      { slug: 'companies/orbit-tech', source_id: 'default', title: 'Orbit Tech', body: 'Orbit Tech robotics company autonomous picking platform consulting.' },
    ],
    query: 'robotics company autonomous picking',
    relevant_slugs: ['companies/foundry-labs'],
  },
  // ── session: chatty session crowds top-K, demote rescues the curated note ──
  {
    id: 'session-demote-chat-spam',
    family: 'session',
    description: '4 chunks of one chat session match the query keywords heavily; the curated note matches less literally but is the answer. Without session-demote, 4 chunks crowd top-5 and push the note out. With demote, only the best chunk survives, freeing slots for the note.',
    pages: [
      // Gold: substantive answer with weaker literal keyword overlap
      { slug: 'concepts/agent-memory', source_id: 'default', title: 'Personal-knowledge agent recall', body: 'Personal-knowledge agent recall depends on: short-term context windows, long-term vector retrieval, episodic recall via timeline, semantic recall via embeddings. The canonical reference.' },
      // 4 chat chunks, same session, heavy literal keyword overlap
      { slug: 'chat/2026-04-15-alpha/chunk-1', source_id: 'default', title: 'Chat agent memory architectures 1', body: 'agent memory architectures question what about agent memory architectures and recall' },
      { slug: 'chat/2026-04-15-alpha/chunk-2', source_id: 'default', title: 'Chat agent memory architectures 2', body: 'agent memory architectures discussion continued, agent memory architectures and recall' },
      { slug: 'chat/2026-04-15-alpha/chunk-3', source_id: 'default', title: 'Chat agent memory architectures 3', body: 'more agent memory architectures back-and-forth, agent memory architectures recall debate' },
      { slug: 'chat/2026-04-15-alpha/chunk-4', source_id: 'default', title: 'Chat agent memory architectures 4', body: 'agent memory architectures wrap-up, agent memory architectures and recall summary' },
    ],
    query: 'agent memory architectures and recall',
    relevant_slugs: ['concepts/agent-memory'],
  },
];

// ─── Scoring (metrics.ts primitives on page-normalized slug lists) ─────

export interface SlugScore {
  top1: string | null;
  ndcg10: number;
}

/**
 * Page-normalize a chunk-grained ranked slug list (first occurrence wins)
 * and score it. gbrain's dedup allows up to 2 chunks per page, so the raw
 * list can repeat a slug; scoring the raw list would let nDCG exceed 1.0
 * (audit cats26-29-04).
 */
export function scoreSlugs(rankedSlugs: string[], relevantSlugs: string[]): SlugScore {
  const pageRank = uniqueInOrder(rankedSlugs);
  const grades = new Map(relevantSlugs.map(s => [s, 1]));
  return {
    top1: pageRank[0] ?? null,
    ndcg10: ndcgAtK(pageRank, grades, 10),
  };
}

// ─── Per-probe runner ───────────────────────────────────────────────────

export interface ProbeResult {
  probe_id: string;
  family: Probe['family'];
  query: string;
  top1_baseline: string | null;
  top1_with_signals: string | null;
  top1_correct_baseline: boolean;
  top1_correct_with_signals: boolean;
  ndcg10_baseline: number;
  ndcg10_with_signals: number;
  ndcg_delta: number;
}

async function ensureSource(engine: any, source_id: string): Promise<void> {
  if (source_id === 'default') return;
  // Sources schema: id TEXT PK, name TEXT, config JSONB. The 'default' row
  // is seeded by initSchema; everything else we register here so per-source
  // page writes don't FK-fail on `pages.source_id`.
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{"federated": true}'::jsonb) ON CONFLICT (id) DO NOTHING`,
    [source_id],
  );
}

async function seedBrain(engine: any, probe: Probe, log: (s: string) => void): Promise<void> {
  await engine.setConfig('auto_link', 'true');
  // WS5: pin search mode + reranker + confounding knobs BEFORE ingest.
  for (const [key, value] of Object.entries(PINNED_CONFIG)) {
    await engine.setConfig(key, value);
  }

  // Pre-register every non-default source so per-source page writes don't FK-fail.
  const sources = new Set(probe.pages.map(p => p.source_id));
  for (const s of sources) await ensureSource(engine, s);

  // Seed pages. importFromContent populates chunks + embeddings (through the
  // stubbed transport). Session-demote uses `sessionPrefix(slug)` to detect
  // chat sessions from slug shape (`chat/2026-04-15-alpha/...`).
  for (const p of probe.pages) {
    await importFromContent(engine, p.slug, `${p.body}\n`, { sourceId: p.source_id });
  }

  // Populate the links graph directly from `[[wiki/...]]` refs.
  // importFromContent does NOT fire auto-link (only the put_page op handler
  // does); we insert the rows applyGraphSignals' SQL reads.
  for (const p of probe.pages) {
    const refs = extractEntityRefs(p.body);
    if (refs.length === 0) continue;
    const fromRows = await engine.executeRaw(
      `SELECT id FROM pages WHERE slug = $1 AND source_id = $2 LIMIT 1`,
      [p.slug, p.source_id],
    ) as any[];
    if (!fromRows[0]) continue;
    const fromId = fromRows[0].id;
    for (const ref of refs) {
      const toRows = await engine.executeRaw(
        `SELECT id FROM pages WHERE slug = $1 LIMIT 1`,
        [ref.slug],
      ) as any[];
      if (!toRows[0]) continue;
      const toId = toRows[0].id;
      if (toId === fromId) continue;
      await engine.executeRaw(
        `INSERT INTO links (from_page_id, to_page_id, link_type, link_source) VALUES ($1, $2, 'mentions', 'markdown') ON CONFLICT DO NOTHING`,
        [fromId, toId],
      );
    }
  }

  const linkCount = await engine.executeRaw(`SELECT COUNT(*)::int AS n FROM links`, []) as any[];
  const pageCount = await engine.executeRaw(`SELECT COUNT(*)::int AS n FROM pages`, []) as any[];
  log(`[cat27]   seeded ${pageCount[0]?.n ?? 0} pages, ${linkCount[0]?.n ?? 0} links\n`);
}

async function runProbe(probe: Probe, log: (s: string) => void): Promise<ProbeResult> {
  const origLog = console.log;
  console.log = () => {}; // initSchema/import are chatty
  const engine: any = new PGLiteEngine();
  try {
    await engine.connect({});
    await engine.initSchema();
    await seedBrain(engine, probe, log);

    // BASELINE: graph_signals off
    await engine.setConfig('search.graph_signals', 'false');
    const baseline = await hybridSearch(engine, probe.query, {
      limit: 10,
      detail: 'normal',
      graph_signals: false,
    } as any);

    // WAVE: graph_signals on
    await engine.setConfig('search.graph_signals', 'true');
    const wave = await hybridSearch(engine, probe.query, {
      limit: 10,
      detail: 'normal',
      graph_signals: true,
    } as any);

    const base = scoreSlugs(baseline.map((r: any) => r.slug as string), probe.relevant_slugs);
    const withSignals = scoreSlugs(wave.map((r: any) => r.slug as string), probe.relevant_slugs);

    return {
      probe_id: probe.id,
      family: probe.family,
      query: probe.query,
      top1_baseline: base.top1,
      top1_with_signals: withSignals.top1,
      top1_correct_baseline: probe.relevant_slugs.includes(base.top1 ?? ''),
      top1_correct_with_signals: probe.relevant_slugs.includes(withSignals.top1 ?? ''),
      ndcg10_baseline: base.ndcg10,
      ndcg10_with_signals: withSignals.ndcg10,
      ndcg_delta: withSignals.ndcg10 - base.ndcg10,
    };
  } finally {
    console.log = origLog;
    // Disconnect even when seed/search throws — a leaked in-process PGLite
    // holds its whole in-memory database for the rest of the run (cats26-29-06).
    try { await engine.disconnect(); } catch { /* already dead */ }
  }
}

// ─── Aggregate ─────────────────────────────────────────────────────────

export interface FamilyBreakdown {
  family: Probe['family'];
  n_probes: number;
  top1_hits_baseline: number;
  top1_hits_with_signals: number;
  mean_ndcg10_baseline: number;
  mean_ndcg10_with_signals: number;
}

export interface Cat27Aggregate {
  n_probes: number;
  top1_hit_rate_baseline: number;
  top1_hit_rate_with_signals: number;
  top1_hit_rate_delta: number;
  mean_ndcg10_baseline: number;
  mean_ndcg10_with_signals: number;
  mean_ndcg10_delta: number;
  probes_improved: number;
  probes_unchanged: number;
  probes_regressed: number;
  by_family: FamilyBreakdown[];
}

export function aggregate(probes: ProbeResult[]): Cat27Aggregate {
  const n = probes.length;
  const hits = (rows: ProbeResult[], key: keyof ProbeResult) => rows.filter(p => p[key] === true).length;
  const meanNdcg = (rows: ProbeResult[], key: keyof ProbeResult) =>
    rows.reduce((a, p) => a + (p[key] as number), 0) / Math.max(1, rows.length);

  const families = [...new Set(probes.map(p => p.family))];
  const byFamily: FamilyBreakdown[] = families.map(f => {
    const rows = probes.filter(p => p.family === f);
    return {
      family: f,
      n_probes: rows.length,
      top1_hits_baseline: hits(rows, 'top1_correct_baseline'),
      top1_hits_with_signals: hits(rows, 'top1_correct_with_signals'),
      mean_ndcg10_baseline: meanNdcg(rows, 'ndcg10_baseline'),
      mean_ndcg10_with_signals: meanNdcg(rows, 'ndcg10_with_signals'),
    };
  });

  const top1Base = hits(probes, 'top1_correct_baseline') / Math.max(1, n);
  const top1Wave = hits(probes, 'top1_correct_with_signals') / Math.max(1, n);
  const ndcgBase = meanNdcg(probes, 'ndcg10_baseline');
  const ndcgWave = meanNdcg(probes, 'ndcg10_with_signals');
  return {
    n_probes: n,
    top1_hit_rate_baseline: top1Base,
    top1_hit_rate_with_signals: top1Wave,
    top1_hit_rate_delta: top1Wave - top1Base,
    mean_ndcg10_baseline: ndcgBase,
    mean_ndcg10_with_signals: ndcgWave,
    mean_ndcg10_delta: ndcgWave - ndcgBase,
    probes_improved: probes.filter(p => p.ndcg_delta > 0).length,
    probes_unchanged: probes.filter(p => p.ndcg_delta === 0).length,
    probes_regressed: probes.filter(p => p.ndcg_delta < 0).length,
    by_family: byFamily,
  };
}

/**
 * The gate. pass = every probe scored with no sut errors AND the wave does
 * not regress either aggregate. A run where graph signals HURT retrieval, or
 * where any probe crashed the engine, fails — this is a real, failable gate
 * (the pre-audit version always exited 0, even on an empty scorecard).
 */
export function computeVerdict(agg: Cat27Aggregate, sutErrors: number, nExpected: number): 'pass' | 'fail' {
  if (agg.n_probes === 0 || agg.n_probes < nExpected) return 'fail';
  if (sutErrors > 0) return 'fail';
  if (agg.top1_hit_rate_delta < 0) return 'fail';
  if (agg.mean_ndcg10_delta < 0) return 'fail';
  return 'pass';
}

// ─── Entry point ───────────────────────────────────────────────────────

export interface Cat27Options {
  probes?: Probe[];
  reportsDir?: string;
  quiet?: boolean;
  /** Test hook: force stub-transport failures for texts matching this predicate. */
  stubFailOn?: (text: string) => boolean;
}

export interface Cat27RunResult {
  receipt: Receipt;
  results: ProbeResult[];
  exitCode: number;
  receiptFile: string;
}

export async function runCat27(options: Cat27Options = {}): Promise<Cat27RunResult> {
  const startedAt = new Date().toISOString();
  const log = options.quiet ? (_: string) => {} : (s: string) => process.stderr.write(s);
  const reportsDir = options.reportsDir ?? join(process.cwd(), 'eval/reports');
  const receiptFile = receiptPath(CAT27_CATEGORY, reportsDir);

  // Isolate GBRAIN_HOME so a user's file-plane config can't override the
  // gateway embedding setup.
  const home = join(tmpdir(), `cat27-gbrain-home-${process.pid}-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  process.env.GBRAIN_HOME = home;

  installStubEmbed(options.stubFailOn);

  const onlyId = process.env.CAT27_PROBES;
  const subset = options.probes ?? (onlyId ? PROBES.filter(p => p.id === onlyId) : PROBES);
  if (subset.length === 0) {
    throw new Error(`[cat27] no probes selected (CAT27_PROBES=${onlyId ?? ''})`);
  }

  const acc = new ProbeAccounting(subset.length);
  const results: ProbeResult[] = [];
  try {
    for (const probe of subset) {
      log(`[cat27] running ${probe.id} (${probe.family})...\n`);
      try {
        const r = await runProbe(probe, log);
        results.push(r);
        acc.score(probe.id, r.ndcg10_with_signals);
        const arrow = r.ndcg_delta > 0 ? '↑' : r.ndcg_delta < 0 ? '↓' : '·';
        log(
          `[cat27]   nDCG@10 ${(r.ndcg10_baseline * 100).toFixed(1)}% → ${(r.ndcg10_with_signals * 100).toFixed(1)}% ${arrow}  ` +
          `top1 ${r.top1_correct_baseline ? '✓' : '✗'} → ${r.top1_correct_with_signals ? '✓' : '✗'}\n`,
        );
      } catch (err: any) {
        // The system under test (gbrain import/search) failed the probe:
        // scored 0, kept in the denominator, surfaced in the receipt.
        acc.error(probe.id, 'sut', String(err?.message ?? err));
        log(`[cat27]   ERROR (sut): ${err?.message ?? err}\n`);
      }
    }
  } finally {
    __setEmbedTransportForTests(null);
  }

  const agg = aggregate(results);
  const summary = acc.summary();
  const sutErrors = summary.errors.filter(e => e.origin === 'sut').length;
  const verdict = computeVerdict(agg, sutErrors, subset.length);

  const receipt: Receipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CAT27_CATEGORY,
    run_status: 'completed',
    verdict,
    n_total: summary.n_total,
    n_scored: summary.n_scored,
    completion_rate: summary.completion_rate,
    errors: summary.errors,
    publishable: summary.publishable && !options.stubFailOn && subset.length === PROBES.length,
    gbrain_version: gbrainVersionResolved(),
    gbrain_pin: gbrainPin(),
    resolved_config: {
      ...PINNED_CONFIG,
      embed_transport: 'stubbed-hash',
      ab_toggle: 'search.graph_signals + SearchOpts.graph_signals (false → true)',
    },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: {
      probes: results,
      aggregate: agg,
    },
  };
  writeReceipt(receiptFile, receipt);

  // Dated human-readable scorecard (legacy location, same payload).
  const outDir = join(reportsDir, CAT27_CATEGORY);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat27.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  log(`\n[cat27] ─── Scorecard ───────────────────\n`);
  log(`[cat27]   probes:         ${agg.n_probes}/${subset.length} scored (${sutErrors} sut errors)\n`);
  log(`[cat27]   top-1 hit:      ${(agg.top1_hit_rate_baseline * 100).toFixed(1)}% → ${(agg.top1_hit_rate_with_signals * 100).toFixed(1)}%  Δ${agg.top1_hit_rate_delta >= 0 ? '+' : ''}${(agg.top1_hit_rate_delta * 100).toFixed(1)}pt\n`);
  log(`[cat27]   mean nDCG@10:   ${(agg.mean_ndcg10_baseline * 100).toFixed(1)}% → ${(agg.mean_ndcg10_with_signals * 100).toFixed(1)}%  Δ${agg.mean_ndcg10_delta >= 0 ? '+' : ''}${(agg.mean_ndcg10_delta * 100).toFixed(1)}pt\n`);
  for (const f of agg.by_family) {
    log(`[cat27]   ${f.family.padEnd(14)} top1 ${f.top1_hits_baseline}/${f.n_probes} → ${f.top1_hits_with_signals}/${f.n_probes}  nDCG ${(f.mean_ndcg10_baseline * 100).toFixed(1)}% → ${(f.mean_ndcg10_with_signals * 100).toFixed(1)}%\n`);
  }
  log(`[cat27]   probes ↑/·/↓:   ${agg.probes_improved}/${agg.probes_unchanged}/${agg.probes_regressed}\n`);
  log(`[cat27]   verdict:        ${verdict} (run_invalid=${summary.run_invalid})\n`);
  log(`[cat27]   receipt:        ${receiptFile}\n`);

  const exitCode = summary.run_invalid || agg.n_probes === 0 ? 1 : (verdict === 'pass' ? 0 : 1);
  return { receipt, results, exitCode, receiptFile };
}

if (import.meta.main) {
  try {
    const result = await runCat27();
    process.exit(result.exitCode);
  } catch (e: any) {
    // Crash backstop: write an error receipt so the aggregator never
    // mistakes a dead run for a missing one.
    try {
      writeReceipt(receiptPath(CAT27_CATEGORY), {
        schema_version: RECEIPT_SCHEMA_VERSION,
        benchmark_version: BENCHMARK_VERSION,
        category: CAT27_CATEGORY,
        run_status: 'error',
        n_total: 0,
        n_scored: 0,
        completion_rate: 0,
        errors: [{ probe_id: 'preflight', origin: 'harness', message: String(e?.message ?? e).slice(0, 500) }],
        publishable: false,
        gbrain_version: gbrainVersionResolved(),
        gbrain_pin: gbrainPin(),
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      });
    } catch { /* receipt write failed too — exit code carries the failure */ }
    process.stderr.write(`[cat27] FATAL: ${e?.stack ?? e}\n`);
    process.exit(1);
  }
}

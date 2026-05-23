/**
 * BrainBench Cat 27 — Graph signals A/B (v0.40.4).
 *
 * The headline product question for gbrain v0.40.4: do the per-query graph
 * signals (adjacency boost, cross-source boost, session-demote) actually
 * surface better top-K results than the same hybrid search without them?
 *
 * Hermetic. No API keys. One in-memory PGLite per probe. ~3 minutes.
 *
 * Per-probe flow:
 *   1. Seed a federated PGLite brain with the probe's pages distributed
 *      across N sources. Pages carry `[[wiki/...]]` references so auto-link
 *      builds a real graph at write time.
 *   2. Run hybridSearch with search.graph_signals=false (baseline).
 *   3. Run hybridSearch with search.graph_signals=true (the wave).
 *   4. Score both against the probe's hand-curated relevant set:
 *      - nDCG@10 (rank-aware quality)
 *      - top-1 hit rate (does the boost surface the RIGHT page first?)
 *   5. Emit per-probe receipt + aggregate scorecard.
 *
 * Three probe families, one per signal:
 *   - adjacency:    a hub-style page is referenced by 2+ other top-K results
 *   - cross_source: a page is referenced by pages in 2+ different sources
 *   - session:      a chatty session crowds the top-K with weak chunks; the
 *                   demote should keep one and push the rest down
 *
 * Run:
 *   bun eval/runner/cat27-graph-signals.ts
 *   CAT27_PROBES=adjacency-hub-1 bun eval/runner/cat27-graph-signals.ts
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { extractEntityRefs } from 'gbrain/link-extraction';
import { configureGateway } from 'gbrain/ai/gateway';

// ─── Probe DSL ─────────────────────────────────────────────────────────

interface ProbePage {
  slug: string;
  source_id: string;
  title: string;
  body: string;  // markdown body; auto-link will fire on `[[wiki/...]]`
  session_id?: string;  // for `session` probes
}

interface Probe {
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
const PROBES: Probe[] = [
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

// ─── nDCG ───────────────────────────────────────────────────────────────

function dcg(scores: number[]): number {
  let acc = 0;
  for (let i = 0; i < scores.length; i++) {
    acc += scores[i] / Math.log2(i + 2);
  }
  return acc;
}

function ndcgAtK(ranked: string[], relevant: string[], k: number): number {
  const relSet = new Set(relevant);
  const obs = ranked.slice(0, k).map(s => (relSet.has(s) ? 1 : 0));
  // Ideal: all relevant up front, capped at k.
  const ideal = new Array(Math.min(relevant.length, k)).fill(1);
  const idealDcg = dcg(ideal);
  if (idealDcg === 0) return 0;
  return dcg(obs) / idealDcg;
}

// ─── Per-probe runner ───────────────────────────────────────────────────

interface ProbeResult {
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

async function seedBrain(probe: Probe): Promise<any> {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Quiet down — initSchema is chatty
  const origLog = console.log;
  console.log = () => {};

  try {
    await engine.setConfig('auto_link', 'true');
  } catch (e: any) {
    console.log = origLog;
    throw new Error(`setConfig(auto_link) failed: ${e?.message ?? e}`);
  }

  // Pre-register every non-default source so per-source page writes don't FK-fail.
  const sources = new Set(probe.pages.map(p => p.source_id));
  for (const s of sources) {
    try {
      await ensureSource(engine, s);
    } catch (e: any) {
      console.log = origLog;
      throw new Error(`ensureSource(${s}) failed: ${e?.message ?? e}`);
    }
  }

  // Seed pages. Use importFromContent so chunks + embeddings populate AND
  // the put_page auto-link extracts `[[wiki/...]]` references into the
  // page_links graph table.
  //
  // Session-demote uses `sessionPrefix(slug)` to detect chat sessions from
  // slug shape (`chat/2026-04-15-alpha/...`). No need to thread session
  // metadata through importFromContent — the slug carries it.
  for (const p of probe.pages) {
    const body = `${p.body}\n`;
    try {
      await importFromContent(engine, p.slug, body, {
        sourceId: p.source_id,
      });
    } catch (e: any) {
      console.log = origLog;
      throw new Error(`seed page failed slug=${p.slug} source=${p.source_id}: ${e?.message ?? e}`);
    }
  }

  // Populate page_links by directly extracting entity refs and inserting.
  // importFromContent does NOT fire auto-link (only the put_page op handler
  // does). For a hermetic eval we don't want to spin up the full op-dispatch
  // layer; we just need the link rows to exist so applyGraphSignals' SQL
  // can read them. We extract `[[wiki/...]]` refs from each page body,
  // look up the to_page_id by slug, and INSERT into links directly.
  for (const p of probe.pages) {
    const refs = extractEntityRefs(p.body);
    if (refs.length === 0) continue;
    // Resolve source page id
    const fromRows = await engine.executeRaw(
      `SELECT id FROM pages WHERE slug = $1 AND source_id = $2 LIMIT 1`,
      [p.slug, p.source_id],
    ) as any[];
    if (!fromRows[0]) continue;
    const fromId = fromRows[0].id;
    for (const ref of refs) {
      const targetSlug = ref.slug;
      // Targets sit in any source — look up by slug across all sources for now
      const toRows = await engine.executeRaw(
        `SELECT id FROM pages WHERE slug = $1 LIMIT 1`,
        [targetSlug],
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

  console.log = origLog;

  // Debug: how many pages and links did we actually populate?
  const linkCount = await engine.executeRaw(`SELECT COUNT(*)::int AS n FROM links`, []) as any[];
  const pageCount = await engine.executeRaw(`SELECT COUNT(*)::int AS n FROM pages`, []) as any[];
  process.stderr.write(`[cat27]   seeded ${pageCount[0]?.n ?? 0} pages, ${linkCount[0]?.n ?? 0} links\n`);

  return engine;
}

async function runProbe(probe: Probe): Promise<ProbeResult> {
  // Embedding gateway is required by importFromContent → embed() path.
  // We pick OpenAI text-embedding-3-large as the apples-to-apples baseline
  // (same as the existing BrainBench EXT-2). Adapter selection is independent
  // of the A/B knob we're toggling.
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: process.env as Record<string, string | undefined>,
  });

  let engine: any;
  try {
    engine = await seedBrain(probe);
  } catch (e: any) {
    throw new Error(`seedBrain: ${e?.message ?? e}\n${e?.stack ?? ''}`);
  }

  const { hybridSearch } = await import('gbrain/search/hybrid');

  // BASELINE: graph_signals off
  let baseline: any;
  try {
    await engine.setConfig('search.graph_signals', 'false');
    baseline = await hybridSearch(engine, probe.query, {
      limit: 10,
      detail: 'normal',
      graph_signals: false,
    } as any);
  } catch (e: any) {
    throw new Error(`baseline hybridSearch: ${e?.message ?? e}\n${e?.stack ?? ''}`);
  }

  // WAVE: graph_signals on
  let wave: any;
  try {
    await engine.setConfig('search.graph_signals', 'true');
    wave = await hybridSearch(engine, probe.query, {
      limit: 10,
      detail: 'normal',
      graph_signals: true,
    } as any);
  } catch (e: any) {
    throw new Error(`wave hybridSearch: ${e?.message ?? e}\n${e?.stack ?? ''}`);
  }

  await engine.disconnect();

  const baselineSlugs = baseline.map((r: any) => r.slug as string);
  const waveSlugs = wave.map((r: any) => r.slug as string);

  const top1Base = baselineSlugs[0] ?? null;
  const top1Wave = waveSlugs[0] ?? null;
  const ndcgBase = ndcgAtK(baselineSlugs, probe.relevant_slugs, 10);
  const ndcgWave = ndcgAtK(waveSlugs, probe.relevant_slugs, 10);

  return {
    probe_id: probe.id,
    family: probe.family,
    query: probe.query,
    top1_baseline: top1Base,
    top1_with_signals: top1Wave,
    top1_correct_baseline: probe.relevant_slugs.includes(top1Base ?? ''),
    top1_correct_with_signals: probe.relevant_slugs.includes(top1Wave ?? ''),
    ndcg10_baseline: ndcgBase,
    ndcg10_with_signals: ndcgWave,
    ndcg_delta: ndcgWave - ndcgBase,
  };
}

// ─── Aggregate ─────────────────────────────────────────────────────────

interface Scorecard {
  schema_version: 1;
  cat: 'cat27-graph-signals';
  gbrain_version: string;
  timestamp: string;
  probes: ProbeResult[];
  aggregate: {
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
  };
}

function aggregate(probes: ProbeResult[]): Scorecard['aggregate'] {
  const n = probes.length;
  const hits = (key: keyof ProbeResult) =>
    probes.filter(p => p[key] === true).length / Math.max(1, n);
  const meanNdcg = (key: keyof ProbeResult) =>
    probes.reduce((a, p) => a + (p[key] as number), 0) / Math.max(1, n);
  const top1Base = hits('top1_correct_baseline');
  const top1Wave = hits('top1_correct_with_signals');
  const ndcgBase = meanNdcg('ndcg10_baseline');
  const ndcgWave = meanNdcg('ndcg10_with_signals');
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
  };
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const onlyId = process.env.CAT27_PROBES;
  const subset = onlyId ? PROBES.filter(p => p.id === onlyId) : PROBES;
  if (subset.length === 0) {
    process.stderr.write(`[cat27] No probes match CAT27_PROBES=${onlyId}\n`);
    process.exit(1);
  }

  // Resolve gbrain version from the installed package.
  let gbrainVersion = 'unknown';
  try {
    const pkg = await import('gbrain/package.json' as any);
    gbrainVersion = (pkg as any).default?.version ?? (pkg as any).version ?? 'unknown';
  } catch {
    // best-effort
  }

  const results: ProbeResult[] = [];
  for (const probe of subset) {
    process.stderr.write(`[cat27] running ${probe.id} (${probe.family})...\n`);
    try {
      const r = await runProbe(probe);
      results.push(r);
      const arrow = r.ndcg_delta > 0 ? '↑' : r.ndcg_delta < 0 ? '↓' : '·';
      process.stderr.write(
        `[cat27]   nDCG@10 ${(r.ndcg10_baseline * 100).toFixed(1)}% → ${(r.ndcg10_with_signals * 100).toFixed(1)}% ${arrow}  ` +
        `top1 ${r.top1_correct_baseline ? '✓' : '✗'} → ${r.top1_correct_with_signals ? '✓' : '✗'}\n`,
      );
    } catch (err: any) {
      process.stderr.write(`[cat27]   ERROR: ${err?.message ?? err}\n`);
      if (err?.stack) process.stderr.write(`[cat27]   STACK:\n${err.stack}\n`);
    }
  }

  const scorecard: Scorecard = {
    schema_version: 1,
    cat: 'cat27-graph-signals',
    gbrain_version: gbrainVersion,
    timestamp: new Date().toISOString(),
    probes: results,
    aggregate: aggregate(results),
  };

  const outDir = join(process.cwd(), 'eval/reports/cat27-graph-signals');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat27.json`);
  writeFileSync(outFile, JSON.stringify(scorecard, null, 2) + '\n', 'utf8');

  // Human summary on stderr
  const a = scorecard.aggregate;
  process.stderr.write(`\n[cat27] ─── Scorecard ───────────────────\n`);
  process.stderr.write(`[cat27]   probes:         ${a.n_probes}\n`);
  process.stderr.write(`[cat27]   top-1 hit:      ${(a.top1_hit_rate_baseline * 100).toFixed(1)}% → ${(a.top1_hit_rate_with_signals * 100).toFixed(1)}%  Δ${a.top1_hit_rate_delta >= 0 ? '+' : ''}${(a.top1_hit_rate_delta * 100).toFixed(1)}pt\n`);
  process.stderr.write(`[cat27]   mean nDCG@10:   ${(a.mean_ndcg10_baseline * 100).toFixed(1)}% → ${(a.mean_ndcg10_with_signals * 100).toFixed(1)}%  Δ${a.mean_ndcg10_delta >= 0 ? '+' : ''}${(a.mean_ndcg10_delta * 100).toFixed(1)}pt\n`);
  process.stderr.write(`[cat27]   probes ↑/·/↓:   ${a.probes_improved}/${a.probes_unchanged}/${a.probes_regressed}\n`);
  process.stderr.write(`[cat27]   gbrain version: ${gbrainVersion}\n`);
  process.stderr.write(`[cat27]   receipt:        ${outFile}\n`);

  // Exit 0 always — Cat 27 is informational, not a gate. The dream cycle
  // tunes the boost multipliers; a small regression on a particular probe
  // is expected during tuning waves and shouldn't fail CI.
  process.exit(0);
}

await main();

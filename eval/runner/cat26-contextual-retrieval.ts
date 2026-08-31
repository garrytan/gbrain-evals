/**
 * BrainBench Cat 26 — contextual retrieval modes A/B (v0.40.3.0 knob).
 *
 * FEATURE BOUNDARY — what is under test vs what is scaffolding:
 *
 *   UNDER TEST: gbrain's contextual-retrieval embedding wrap on the inline
 *     import path — the `search.contextual_retrieval` config knob resolved
 *     through loadSearchModeConfig/resolveSearchMode (mode.ts), consumed by
 *     importFromContent (resolveContextualRetrievalMode → buildContextualPrefix
 *     → wrapChunkForEmbedding), and its downstream effect on hybridSearch
 *     ranking. Stored chunk_text stays canonical; only the embedding input is
 *     wrapped, so mode deltas come from the vector leg of RRF fusion.
 *
 *   SEEDED / STUBBED (legitimately):
 *     - A deterministic 30-page corpus generated in-file (10 gold pages with
 *       the answer sentence buried in a chunk that does NOT contain the page
 *       title, + 20 keyword-rich distractor pages). No randomness anywhere.
 *     - Under --stub-embed: gbrain's embed transport is replaced with a
 *       deterministic token-bag hash embedding (__setEmbedTransportForTests
 *       + OPENAI_API_KEY=dummy). This preserves the contrast under test —
 *       the wrap changes the embed INPUT string — but does NOT measure real
 *       embedding-model quality, so stub runs are publishable:false.
 *     - No LLM runs in any mode.
 *
 *   NOT EXERCISED: per-chunk synopsis GENERATION. gbrain's inline import
 *     path hard-forces per_chunk_synopsis down to the title tier
 *     (import-file.ts: "per_chunk_synopsis is too expensive for the inline
 *     import path"; the Minion backfill owns the real synopsis sweep). The
 *     'per_chunk_synopsis' cell therefore measures the requested-mode
 *     CONFIG PLUMBING with title-tier effect, and the receipt labels it
 *     `mode_effective_inline: 'title'` (audit finding cats26-29-16 — never
 *     present it as a measured synopsis number).
 *
 * HISTORY (audit findings cats26-29-01/-02): the previous version set the
 * knob under the bare key 'contextual_retrieval' — gbrain only reads
 * 'search.contextual_retrieval' (mode.ts SEARCH_MODE_CONFIG_KEYS) — so all
 * three cells ran identically at the balanced default ('title'); and the
 * corpus was 3 pages scored at K=10, so recall was structurally 1.0. This
 * version asserts the RESOLVED mode per cell before ingest (abort on
 * mismatch), scores R@3 / MRR via eval/runner/metrics.ts over a 30-page
 * corpus, and adds a mismatched-gold headroom control.
 *
 * GATES (real + failable):
 *   - config conformance: resolveSearchMode(loadSearchModeConfig(engine))
 *     .contextual_retrieval must equal the requested mode per cell (abort,
 *     exit 2 otherwise — this is exactly the bug class of finding -01).
 *   - corpus premises: every gold page chunks to >= 2 chunks AND the chunk
 *     containing the gold sentence does not contain the page's name token
 *     (otherwise "context is missing from the chunk" is not being tested).
 *   - headroom (negative control): scoring the best cell against ROTATED
 *     gold labels must yield <= 0.5 × its real mean R@3, and the real mean
 *     must be > 0. A saturated corpus (the old 3-page bug) fails this.
 *   - inline-fallback conformance (stub mode only, deterministic): the
 *     per_chunk_synopsis cell must score identically to the title cell,
 *     because gbrain documents the inline fallback. If gbrain ever starts
 *     exercising real synopsis inline, this fails loudly and the eval gets
 *     updated instead of silently mislabeling.
 *
 * best_mode uses a STRICT tie-break: equal means report 'tie' (+ the tied
 * list) instead of deterministically crowning the first cell (finding -02).
 *
 * Run:
 *   bun eval/runner/cat26-contextual-retrieval.ts --stub-embed   # hermetic, no keys
 *   bun eval/runner/cat26-contextual-retrieval.ts                # live OpenAI embeds (OPENAI_API_KEY)
 *   bun eval/runner/cat26-contextual-retrieval.ts --allow-skip   # missing key → skip receipt, exit 0
 */

import { createHash } from 'crypto';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { configureGateway, __setEmbedTransportForTests } from 'gbrain/ai/gateway';
import { hybridSearch } from 'gbrain/search/hybrid';
// Not in gbrain's export map (unlike 'gbrain/think'); deep import is the only
// way to reach the mode resolver this eval must assert against.
import { loadSearchModeConfig, resolveSearchMode } from '../../node_modules/gbrain/src/core/search/mode.ts';
import { uniqueInOrder, recallAtK, reciprocalRank } from './metrics.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import {
  writeReceipt,
  receiptPath,
  RECEIPT_SCHEMA_VERSION,
  BENCHMARK_VERSION,
  type Receipt,
  type ReceiptVerdict,
} from './receipt.ts';
import { gbrainVersion, gbrainPin } from './gbrain-version.ts';

// Isolate GBRAIN_HOME so a developer's ~/.gbrain/config.json can't leak in.
const ISOLATED_HOME = join(tmpdir(), `cat26-gbrain-home-${process.pid}-${Date.now()}`);
mkdirSync(ISOLATED_HOME, { recursive: true });
process.env.GBRAIN_HOME = ISOLATED_HOME;

export const CATEGORY = 'cat26-contextual-retrieval';
export const K = 3;

export type Mode = 'none' | 'title' | 'per_chunk_synopsis';
export const MODES: Mode[] = ['none', 'title', 'per_chunk_synopsis'];

// ─── Deterministic corpus ────────────────────────────────────────────
// 10 gold pages: the page name lives in the H1 + the first paragraph ONLY;
// the gold sentence sits past the first chunk boundary in name-free text.
// Queries combine the page name (only recoverable from chunk context under
// the title wrap) with topic keywords the distractors also use heavily.
// 20 distractors: chunk 1 = intro naming OTHER companies (spreads name
// tokens so names alone can't solve a query), chunk 2 = keyword-dense
// name-free text overlapping every query's topic vocabulary.

interface GoldSpec {
  slug: string;
  name: string;
  sector: string;
  gold_sentence: string;
  query: string;
  /** Distinctive lowercase token of the name; must be ABSENT from the gold chunk. */
  name_token: string;
}

export const GOLD_SPECS: GoldSpec[] = [
  {
    slug: 'companies/meridian-circuits', name: 'Meridian Circuits', sector: 'power-electronics',
    gold_sentence: 'The Series A round was led by Halvorsen Capital, whose partner took the board seat after the close.',
    query: 'who led the Series A round for Meridian Circuits', name_token: 'meridian',
  },
  {
    slug: 'companies/halcyon-grid', name: 'Halcyon Grid', sector: 'grid-software',
    gold_sentence: 'The chief financial officer is Tomas Reyes, who previously ran finance at a national utility.',
    query: 'who is the CFO of Halcyon Grid', name_token: 'halcyon',
  },
  {
    slug: 'companies/bluepine-robotics', name: 'Bluepine Robotics', sector: 'warehouse-robotics',
    gold_sentence: 'The picking system was trained on forty terabytes of bin picking demonstrations collected over two years.',
    query: 'how much training data does the Bluepine Robotics picking system use', name_token: 'bluepine',
  },
  {
    slug: 'companies/cobalt-harbor', name: 'Cobalt Harbor', sector: 'fleet-telematics',
    gold_sentence: 'Enterprise pricing starts at sixty thousand dollars per year for the fleet tier with volume discounts above two hundred vehicles.',
    query: 'what does the Cobalt Harbor enterprise fleet tier cost', name_token: 'cobalt',
  },
  {
    slug: 'companies/sable-peak', name: 'Sable Peak Analytics', sector: 'product-analytics',
    gold_sentence: 'The retention dashboard refreshes every fifteen minutes from the event stream with no manual rebuild step.',
    query: 'how often does the Sable Peak retention dashboard refresh', name_token: 'sable',
  },
  {
    slug: 'companies/juniper-forge', name: 'Juniper Forge', sector: 'metal-additive',
    gold_sentence: 'The seed round closed at four million dollars with Redgate Ventures leading and two operator angels participating.',
    query: 'who led the seed round for Juniper Forge', name_token: 'juniper',
  },
  {
    slug: 'companies/quartz-meadow', name: 'Quartz Meadow Bio', sector: 'biotech',
    gold_sentence: 'The lead molecule targets fibrosis in the liver and enters first clinical trials next spring.',
    query: 'what disease does the Quartz Meadow lead molecule target', name_token: 'quartz',
  },
  {
    slug: 'companies/ember-line', name: 'Ember Line Freight', sector: 'logistics',
    gold_sentence: 'The routing engine cut average delivery time by nineteen percent across the three month pilot.',
    query: 'how much did the Ember Line routing engine cut delivery time', name_token: 'ember',
  },
  {
    slug: 'companies/willow-array', name: 'Willow Array', sector: 'solar-hardware',
    gold_sentence: 'The inverter ships with a twelve year warranty on the power stage and a five year warranty on the enclosure.',
    query: 'how long is the Willow Array inverter warranty', name_token: 'willow',
  },
  {
    slug: 'companies/onyx-current', name: 'Onyx Current', sector: 'ev-batteries',
    gold_sentence: 'The battery pack holds ninety kilowatt hours and charges to eighty percent in under forty minutes.',
    query: 'how big is the Onyx Current battery pack', name_token: 'onyx',
  },
];

const DISTRACTOR_NAMES = [
  'Argent Systems', 'Bristlecone Works', 'Cinder Path', 'Dovetail Metrics', 'Eastlake Dynamo',
  'Fernwood Labs', 'Gantry Nine', 'Harrow Point', 'Ironquill', 'Jetty Row',
  'Kestrel Loop', 'Lantern Field', 'Mosswood Data', 'Northbank Forge', 'Ossify',
  'Pinewheel', 'Quill Harbor', 'Rooksmith', 'Stonebriar Ops', 'Tidegate',
];

// Name-free neutral operations filler. Cycled deterministically per page.
const FILLER_SENTENCES = [
  'The operations team reviews weekly planning notes every Monday morning before standup.',
  'Hiring loops run in two stages with a written exercise reviewed asynchronously by the panel.',
  'Quarterly planning documents are drafted collaboratively and archived in the shared workspace.',
  'The onboarding checklist covers accounts, hardware, and a first-week shadowing rotation.',
  'Support rotations run in weekly shifts with a handoff document updated each Friday.',
  'The internal wiki holds runbooks for deploys, incident response, and vendor escalation.',
  'Office hours with the founding team happen twice a month and notes are circulated afterward.',
  'Expense policy requires receipts within thirty days and manager approval above a small threshold.',
  'The design review meeting alternates between product walkthroughs and technical deep dives.',
  'All-hands meetings close with a questions segment sourced from an anonymous form.',
  'Engineering pairs rotate every sprint so context spreads beyond the original authors.',
  'Customer interview recordings are summarized into a searchable digest every other week.',
  'The security checklist is re-audited each quarter and findings tracked to closure.',
  'Performance reviews use a lightweight written packet rather than live presentation.',
  'Travel bookings route through a single agency to keep reporting consolidated.',
  'The documentation style guide asks for short sentences and concrete examples.',
];

// Name-free keyword-dense text overlapping every query's topic vocabulary.
// Lives in distractor chunk 2 so distractors compete on content tokens.
const DISTRACTOR_KEYWORD_SENTENCES = [
  'The Series A round discussion covered which fund led and how the board seat was allocated.',
  'A fractional CFO handles finance reporting while the search for a full time chief financial officer continues.',
  'The picking system roadmap debates how much training data the warehouse demonstrations should contribute.',
  'Enterprise pricing conversations keep circling the fleet tier and what the annual cost per vehicle should be.',
  'The retention dashboard project tracks how often the metrics refresh from the event stream.',
  'Notes from the seed round retro cover which ventures firm led and how the close was sequenced.',
  'The research memo compares lead molecule candidates and which disease each targets before clinical trials.',
  'The routing engine experiment measures how much average delivery time improves during a pilot.',
  'Warranty policy drafts propose how long the inverter power stage coverage should run.',
  'The battery pack spec sheet argues about kilowatt hours of capacity and charge time targets.',
];

function cycleSentences(bank: string[], startIdx: number, minWords: number): string {
  const out: string[] = [];
  let words = 0;
  let i = startIdx;
  while (words < minWords) {
    const s = bank[i % bank.length]!;
    out.push(s);
    words += s.split(/\s+/).length;
    i++;
  }
  return out.join(' ');
}

function slugSeed(slug: string): number {
  return createHash('sha256').update(slug).digest().readUInt16BE(0);
}

export interface CorpusPage {
  slug: string;
  body: string;
  kind: 'gold' | 'distractor';
}

export interface CorpusQuery {
  id: string;
  query: string;
  gold_slug: string;
}

export function buildCorpus(): { pages: CorpusPage[]; queries: CorpusQuery[] } {
  const pages: CorpusPage[] = [];

  for (const g of GOLD_SPECS) {
    const seed = slugSeed(g.slug);
    // The name lives in the H1 + intro only. ~650 words of name-free filler
    // push the gold sentence several chunk boundaries away (the recursive
    // chunker merges past its 300-word target and applies overlap, so a
    // short gap would leak the name into the gold chunk).
    const intro = `${g.name} is a ${g.sector} company. ${g.name} keeps most of its working notes in this page.`;
    const fillerA = cycleSentences(FILLER_SENTENCES, seed % FILLER_SENTENCES.length, 650);
    // Keep the gold chunk lean: heavy filler around the gold sentence
    // dilutes its token-level similarity and drowns the mode contrast.
    const fillerB = cycleSentences(FILLER_SENTENCES, (seed + 5) % FILLER_SENTENCES.length, 30);
    const fillerC = cycleSentences(FILLER_SENTENCES, (seed + 9) % FILLER_SENTENCES.length, 30);
    const body = [
      `# ${g.name}`, '',
      intro, '',
      fillerA, '',
      fillerB, '',
      g.gold_sentence, '',
      fillerC, '',
    ].join('\n');
    pages.push({ slug: g.slug, body, kind: 'gold' });
  }

  DISTRACTOR_NAMES.forEach((name, di) => {
    const slug = `companies/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    const seed = slugSeed(slug);
    // Mention 2 gold-company names in the intro chunk (spreads name tokens),
    // never in the keyword chunk.
    const m1 = GOLD_SPECS[di % GOLD_SPECS.length]!.name;
    const m2 = GOLD_SPECS[(di + 3) % GOLD_SPECS.length]!.name;
    const intro = `${name} is an operations-heavy company. The team tracks competitors including ${m1} and ${m2} in a separate research digest.`;
    // ~600 words of filler so the trailing keyword section lands in its own
    // LEAN chunk (mirrors the gold pages' lean gold chunk — distractors must
    // compete at comparable dilution or the contrast is an artifact).
    const fillerA = cycleSentences(FILLER_SENTENCES, seed % FILLER_SENTENCES.length, 600);
    // Each distractor covers a rotating window of 3 query topics (so every
    // topic gets ~6 keyword-competing distractors without any single
    // distractor being a universal keyword magnet).
    const keywords = [0, 1, 2]
      .map(o => DISTRACTOR_KEYWORD_SENTENCES[(di + o) % DISTRACTOR_KEYWORD_SENTENCES.length]!)
      .join(' ');
    const body = [
      `# ${name}`, '',
      intro, '',
      fillerA, '',
      keywords, '',
    ].join('\n');
    pages.push({ slug, body, kind: 'distractor' });
  });

  const queries: CorpusQuery[] = GOLD_SPECS.map((g, i) => ({
    id: `q${String(i + 1).padStart(2, '0')}-${g.name_token}`,
    query: g.query,
    gold_slug: g.slug,
  }));

  return { pages, queries };
}

// ─── Gateway (+ optional deterministic hash-embed transport) ─────────

const EMBED_DIMS = 1536;

// Function words the synthetic embedder drops. Real embedding models learn
// to downweight these; a bag-of-tokens toy must do it explicitly or query
// stopwords ('the', 'for', 'how') dominate every similarity.
const EMBED_STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'of', 'in',
  'on', 'at', 'to', 'for', 'with', 'and', 'or', 'who', 'what', 'when',
  'where', 'why', 'how', 'much', 'many', 'does', 'do', 'did', 'this',
  'that', 'these', 'those', 'by', 'from', 'as', 'it', 'its', 'which',
  'should', 'would', 'could', 'their', 'they', 'we', 'our', 'us', 'i',
  'you', 'your', 'about', 'above', 'under', 'over', 'per', 'each', 'every',
]);

export function hashEmbed(text: string): number[] {
  const vec = new Array<number>(EMBED_DIMS).fill(0);
  // UNIQUE content-token presence (not counts): repeated filler must not
  // dominate the vector, or the title wrap's few added tokens can never
  // move a ranking and the A/B loses its contrast. All-positive weights
  // (no ± sign) so hash collisions never CANCEL a genuine token match —
  // signed variants add rank noise at exactly the margins under test.
  const tokens = new Set(
    text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 0 && !EMBED_STOPWORDS.has(t)),
  );
  for (const tok of tokens) {
    const h = createHash('sha256').update(tok).digest();
    const idx = h.readUInt32BE(0) % EMBED_DIMS;
    vec[idx] += 1;
  }
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
  return vec.map(x => x / norm);
}

async function hashEmbedTransport(
  params: { values: string[] } & Record<string, unknown>,
): Promise<{ embeddings: number[][]; values: string[]; warnings: unknown[]; usage: { tokens: number } }> {
  return {
    embeddings: params.values.map(v => hashEmbed(v)),
    values: params.values,
    warnings: [],
    usage: { tokens: 0 },
  };
}

let gatewayMode: 'stub' | 'live' | null = null;
export function ensureGateway(stubEmbed: boolean): void {
  const want = stubEmbed ? 'stub' : 'live';
  if (gatewayMode === want) return;
  if (stubEmbed && !process.env.OPENAI_API_KEY) {
    // ai-sdk model construction needs a non-empty key even when the transport
    // is stubbed; the dummy never reaches the network.
    process.env.OPENAI_API_KEY = 'dummy-embed-transport-stubbed';
  }
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: EMBED_DIMS,
    env: process.env as Record<string, string | undefined>,
  });
  __setEmbedTransportForTests(
    stubEmbed
      ? (hashEmbedTransport as unknown as Parameters<typeof __setEmbedTransportForTests>[0])
      : null,
  );
  gatewayMode = want;
}

// ─── WS5 config pinning + conformance ────────────────────────────────
// Pinned per cell BEFORE ingest. 'balanced' would silently enable the
// zerank-2 reranker when ZEROENTROPY_API_KEY is set — never rely on defaults.

const BASE_SEARCH_CONFIG: Record<string, string> = {
  'search.mode': 'balanced',
  'search.reranker.enabled': 'false',
  'search.expansion': 'false',
  'search.cache.enabled': 'false',
};

export interface ResolvedCellConfig {
  mode_requested: Mode;
  /** What the inline import path actually applies (synopsis → title). */
  mode_effective_inline: Mode | 'title';
  resolved_mode: string;
  contextual_retrieval: string;
  contextual_retrieval_disabled: boolean;
  reranker_enabled: boolean;
  expansion: boolean;
}

/** Re-read the knob the way gbrain does (finding cats26-29-01: the old runner
 *  set a bare key gbrain never reads; this assertion makes that impossible). */
export async function resolveEffectiveConfig(engine: PGLiteEngine, requested: Mode): Promise<ResolvedCellConfig> {
  const knobs = resolveSearchMode(await loadSearchModeConfig(engine));
  return {
    mode_requested: requested,
    mode_effective_inline: requested === 'per_chunk_synopsis' ? 'title' : requested,
    resolved_mode: knobs.resolved_mode,
    contextual_retrieval: knobs.contextual_retrieval,
    contextual_retrieval_disabled: knobs.contextual_retrieval_disabled,
    reranker_enabled: knobs.reranker_enabled,
    expansion: knobs.expansion,
  };
}

export class ConfigConformanceError extends Error {}
export class CorpusPremiseError extends Error {}

// ─── Corpus premise checks ───────────────────────────────────────────

async function assertCorpusPremises(engine: PGLiteEngine): Promise<{ gold_chunk_counts: Record<string, number> }> {
  const counts: Record<string, number> = {};
  for (const g of GOLD_SPECS) {
    const rows = await engine.executeRaw<{ chunk_text: string }>(
      `SELECT cc.chunk_text
         FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
        WHERE p.slug = $1
        ORDER BY cc.chunk_index`,
      [g.slug],
    );
    counts[g.slug] = rows.length;
    if (rows.length < 2) {
      throw new CorpusPremiseError(`gold page ${g.slug} produced ${rows.length} chunk(s); need >= 2 so the gold sentence can sit outside the title chunk`);
    }
    const goldNeedle = g.gold_sentence.split(' ').slice(0, 5).join(' ');
    // Chunk overlap can duplicate the gold sentence into a neighbor; the
    // premise must hold for EVERY chunk that carries it.
    const goldChunks = rows.filter(r => r.chunk_text.includes(goldNeedle));
    if (goldChunks.length === 0) {
      throw new CorpusPremiseError(`gold page ${g.slug}: no chunk contains the gold sentence`);
    }
    for (const c of goldChunks) {
      if (c.chunk_text.toLowerCase().includes(g.name_token)) {
        throw new CorpusPremiseError(`gold page ${g.slug}: a chunk carrying the gold sentence also contains the name token "${g.name_token}" — the buried-context premise is void`);
      }
    }
  }
  return { gold_chunk_counts: counts };
}

// ─── Per-mode cell ───────────────────────────────────────────────────

export interface QueryScore {
  query_id: string;
  gold_slug: string;
  recall_at_k: number;
  reciprocal_rank: number;
  top_slugs: string[];
  error?: string;
}

export interface ModeResult {
  config: ResolvedCellConfig;
  per_query: QueryScore[];
  mean_recall_at_k: number;
  mrr: number;
  /** Same result lists scored against ROTATED gold labels (headroom control). */
  mismatched_gold_mean_recall_at_k: number;
}

export interface RunModeOpts {
  stubEmbed: boolean;
  /** Probe accounting for (mode,query) cells; optional for tests. */
  acc?: ProbeAccounting;
}

export async function runMode(mode: Mode, opts: RunModeOpts): Promise<ModeResult> {
  ensureGateway(opts.stubEmbed);
  const { pages, queries } = buildCorpus();

  const engine = new PGLiteEngine();
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    await engine.connect({});
    await engine.initSchema();

    // WS5: pin BEFORE ingest — the wrap is applied at embed time.
    for (const [key, value] of Object.entries(BASE_SEARCH_CONFIG)) {
      await engine.setConfig(key, value);
    }
    await engine.setConfig('search.contextual_retrieval', mode);

    // Conformance: gbrain must actually resolve the requested mode.
    const config = await resolveEffectiveConfig(engine, mode);
    if (config.contextual_retrieval !== mode) {
      throw new ConfigConformanceError(
        `requested contextual_retrieval=${mode} but gbrain resolved '${config.contextual_retrieval}' (resolved_mode=${config.resolved_mode}) — config key not wired`,
      );
    }
    if (config.reranker_enabled || config.expansion) {
      throw new ConfigConformanceError(
        `reranker_enabled=${config.reranker_enabled} expansion=${config.expansion} — WS5 pins not applied`,
      );
    }

    for (const p of pages) {
      await importFromContent(engine, p.slug, p.body, { noEmbed: false });
    }

    await assertCorpusPremises(engine);

    const perQuery: QueryScore[] = [];
    for (const q of queries) {
      const cellId = `${mode}:${q.id}`;
      try {
        const results = await hybridSearch(engine, q.query, { limit: 30 });
        // Chunk → page normalization (metrics.ts contract): first occurrence
        // per slug, order preserved.
        const slugs = uniqueInOrder(results.map((r: { slug: string }) => r.slug));
        const gold = new Set([q.gold_slug]);
        const score: QueryScore = {
          query_id: q.id,
          gold_slug: q.gold_slug,
          recall_at_k: recallAtK(slugs, gold, K),
          reciprocal_rank: reciprocalRank(slugs, gold),
          top_slugs: slugs.slice(0, K),
        };
        perQuery.push(score);
        opts.acc?.score(cellId, score.recall_at_k);
      } catch (e) {
        // The retrieval pipeline failing a query is the SUT misbehaving:
        // scored 0, kept in the denominator (probe-accounting policy).
        const msg = e instanceof Error ? e.message : String(e);
        perQuery.push({ query_id: q.id, gold_slug: q.gold_slug, recall_at_k: 0, reciprocal_rank: 0, top_slugs: [], error: msg });
        opts.acc?.error(cellId, 'sut', `hybridSearch failed: ${msg}`);
      }
    }

    const mean = (f: (s: QueryScore) => number): number =>
      perQuery.length === 0 ? NaN : perQuery.reduce((a, s) => a + f(s), 0) / perQuery.length;

    // Headroom control: score the SAME ranked lists against rotated gold
    // labels. On a saturated corpus (every page always in top-K) this equals
    // the real mean and the headroom gate fails — exactly the old bug.
    const n = queries.length;
    const mismatched = perQuery.map((s, i) => {
      const wrongGold = new Set([queries[(i + 1) % n]!.gold_slug]);
      return recallAtK(s.top_slugs, wrongGold, K);
    });
    const mismatchedMean = mismatched.length === 0 ? NaN : mismatched.reduce((a, b) => a + b, 0) / mismatched.length;

    return {
      config,
      per_query: perQuery,
      mean_recall_at_k: mean(s => s.recall_at_k),
      mrr: mean(s => s.reciprocal_rank),
      mismatched_gold_mean_recall_at_k: mismatchedMean,
    };
  } finally {
    console.log = origLog;
    console.error = origErr;
    await engine.disconnect().catch(() => {});
  }
}

// ─── Best-mode selection (strict tie-break, finding -02) ─────────────

export function chooseBestMode(results: ModeResult[]): { best_mode: Mode | 'tie'; tied: Mode[] } {
  if (results.length === 0) return { best_mode: 'tie', tied: [] };
  const max = Math.max(...results.map(r => r.mean_recall_at_k));
  const tied = results.filter(r => r.mean_recall_at_k === max).map(r => r.config.mode_requested);
  return { best_mode: tied.length === 1 ? tied[0]! : 'tie', tied };
}

/** Stub-mode gate: the title cell must observably differ from the none cell.
 *  All-identical cells are the exact failure mode of finding cats26-29-01
 *  (knob set under a key gbrain never reads). */
export function cellsDifferGate(noneR: ModeResult, titleR: ModeResult): { pass: boolean; reason?: string } {
  const differs = noneR.per_query.some((s, i) => s.recall_at_k !== titleR.per_query[i]!.recall_at_k
    || s.reciprocal_rank !== titleR.per_query[i]!.reciprocal_rank);
  return differs
    ? { pass: true }
    : { pass: false, reason: 'title cell is per-query identical to the none cell — the contextual_retrieval knob had no observable effect on retrieval (audit finding cats26-29-01 regression)' };
}

/** Stub-mode gate: synopsis-requested must equal title (gbrain's documented
 *  inline fallback). Divergence means the eval's labeling is stale. */
export function synopsisFallbackGate(titleR: ModeResult, synR: ModeResult): { pass: boolean; reason?: string } {
  const same = synR.per_query.every((s, i) => s.recall_at_k === titleR.per_query[i]!.recall_at_k
    && s.reciprocal_rank === titleR.per_query[i]!.reciprocal_rank);
  return same
    ? { pass: true }
    : { pass: false, reason: "per_chunk_synopsis cell diverged from title cell under deterministic embeds — gbrain's documented inline title-fallback no longer holds; update the eval to exercise the real synopsis path" };
}

/** Headroom gate over the best-scoring cell. Fails on a saturated corpus. */
export function headroomGate(results: ModeResult[]): { pass: boolean; reason?: string } {
  if (results.length === 0) return { pass: false, reason: 'no mode results' };
  const best = results.reduce((a, b) => (b.mean_recall_at_k > a.mean_recall_at_k ? b : a));
  if (!(best.mean_recall_at_k > 0)) {
    return { pass: false, reason: `best cell (${best.config.mode_requested}) mean R@${K} is 0 — retrieval found nothing, the A/B cannot discriminate` };
  }
  if (best.mismatched_gold_mean_recall_at_k > 0.5 * best.mean_recall_at_k) {
    return {
      pass: false,
      reason: `headroom control: mismatched-gold R@${K} ${best.mismatched_gold_mean_recall_at_k.toFixed(2)} > 0.5 × real ${best.mean_recall_at_k.toFixed(2)} on the '${best.config.mode_requested}' cell — the metric is saturated (every page ranks top-K regardless of relevance)`,
    };
  }
  return { pass: true };
}

// ─── Paths + receipt ─────────────────────────────────────────────────

const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));
const REPORTS_ROOT = join(RUNNER_DIR, '..', 'reports');
const DUMPS_DIR = join(REPORTS_ROOT, CATEGORY);

function baseReceipt(startedAt: string): Omit<Receipt, 'run_status' | 'n_total' | 'n_scored' | 'completion_rate' | 'errors' | 'publishable'> {
  return {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CATEGORY,
    gbrain_version: gbrainVersion(),
    gbrain_pin: gbrainPin(),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };
}

function resolvedConfig(stubEmbed: boolean, cellConfigs: ResolvedCellConfig[]): Record<string, unknown> {
  return {
    ...BASE_SEARCH_CONFIG,
    k: K,
    corpus_pages: buildCorpus().pages.length,
    queries: buildCorpus().queries.length,
    embedding_transport: stubEmbed
      ? 'stubbed deterministic hash-embed (__setEmbedTransportForTests)'
      : 'live openai:text-embedding-3-large',
    per_cell: cellConfigs,
    note: "per_chunk_synopsis is title-tier on the inline import path (gbrain import-file.ts); the cell measures config plumbing, not synopsis generation",
  };
}

// ─── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const argv = process.argv.slice(2);
  const stubEmbed = argv.includes('--stub-embed') || process.env.CAT26_STUB_EMBED === '1';
  const allowSkip = argv.includes('--allow-skip');

  if (!stubEmbed && !process.env.OPENAI_API_KEY) {
    const reason = 'OPENAI_API_KEY required for live embeds (run with --stub-embed for the hermetic conformance run)';
    console.error(`[cat26] SKIP: ${reason}`);
    writeReceipt(receiptPath(CATEGORY, REPORTS_ROOT), {
      ...baseReceipt(startedAt),
      run_status: 'skipped',
      skip_reason: reason,
      n_total: MODES.length * buildCorpus().queries.length,
      n_scored: 0,
      completion_rate: 0,
      errors: [],
      publishable: false,
      resolved_config: resolvedConfig(stubEmbed, []),
    });
    process.exit(allowSkip ? 0 : 3);
  }

  const { pages, queries } = buildCorpus();
  console.log(`[cat26] ${pages.length} pages (${GOLD_SPECS.length} gold + ${pages.length - GOLD_SPECS.length} distractors) × ${queries.length} queries × ${MODES.length} modes, K=${K}, embeds=${stubEmbed ? 'stubbed-hash' : 'live-openai'}`);

  const acc = new ProbeAccounting(MODES.length * queries.length);
  const results: ModeResult[] = [];
  for (const mode of MODES) {
    process.stderr.write(`  mode=${mode}... `);
    try {
      const r = await runMode(mode, { stubEmbed, acc });
      results.push(r);
      process.stderr.write(`R@${K}=${(r.mean_recall_at_k * 100).toFixed(1)}% MRR=${r.mrr.toFixed(3)} (resolved cr=${r.config.contextual_retrieval}, effective inline=${r.config.mode_effective_inline})\n`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const origin = e instanceof ConfigConformanceError || e instanceof CorpusPremiseError ? 'harness' : 'harness';
      console.error(`\n[cat26] CELL ABORT (${mode}): ${msg}`);
      for (const q of queries) acc.error(`${mode}:${q.id}`, origin, msg);
      const s = acc.summary();
      writeReceipt(receiptPath(CATEGORY, REPORTS_ROOT), {
        ...baseReceipt(startedAt),
        run_status: 'error',
        n_total: s.n_total,
        n_scored: s.n_scored,
        completion_rate: s.completion_rate,
        errors: s.errors,
        publishable: false,
        resolved_config: resolvedConfig(stubEmbed, results.map(r => r.config)),
      });
      process.exit(2);
    }
  }

  const noneR = results.find(r => r.config.mode_requested === 'none')!;
  const titleR = results.find(r => r.config.mode_requested === 'title')!;
  const synR = results.find(r => r.config.mode_requested === 'per_chunk_synopsis')!;

  const gateReasons: string[] = [];
  const headroom = headroomGate(results);
  if (!headroom.pass) gateReasons.push(headroom.reason!);

  // Stub-mode determinism gates (see the exported gate helpers).
  if (stubEmbed) {
    const fallback = synopsisFallbackGate(titleR, synR);
    if (!fallback.pass) gateReasons.push(fallback.reason!);
    const differ = cellsDifferGate(noneR, titleR);
    if (!differ.pass) gateReasons.push(differ.reason!);
  }

  const { best_mode, tied } = chooseBestMode(results);
  const accSummary = acc.summary();

  const summary = {
    mode: stubEmbed ? 'stub-embed' : 'live-embed',
    k: K,
    corpus_pages: pages.length,
    queries: queries.length,
    per_mode: results.map(r => ({
      mode_requested: r.config.mode_requested,
      mode_effective_inline: r.config.mode_effective_inline,
      resolved_contextual_retrieval: r.config.contextual_retrieval,
      mean_recall_at_k: r.mean_recall_at_k,
      mrr: r.mrr,
      mismatched_gold_mean_recall_at_k: r.mismatched_gold_mean_recall_at_k,
    })),
    best_mode,
    tied_modes: tied,
    title_vs_none_delta: titleR.mean_recall_at_k - noneR.mean_recall_at_k,
    // Named for what it is: synopsis was REQUESTED; inline effect is title.
    synopsis_requested_vs_none_delta: synR.mean_recall_at_k - noneR.mean_recall_at_k,
    synopsis_not_exercised_inline_import: true,
    gate: gateReasons.length === 0 ? 'pass' : 'fail',
    gate_reasons: gateReasons,
  };

  if (!existsSync(DUMPS_DIR)) mkdirSync(DUMPS_DIR, { recursive: true });
  writeFileSync(
    join(DUMPS_DIR, `${new Date().toISOString().slice(0, 10)}-cat26.json`),
    JSON.stringify({ summary, per_mode: results, accounting: accSummary }, null, 2) + '\n',
  );

  if (accSummary.run_invalid) {
    writeReceipt(receiptPath(CATEGORY, REPORTS_ROOT), {
      ...baseReceipt(startedAt),
      run_status: 'error',
      n_total: accSummary.n_total,
      n_scored: accSummary.n_scored,
      completion_rate: accSummary.completion_rate,
      errors: accSummary.errors,
      publishable: false,
      resolved_config: resolvedConfig(stubEmbed, results.map(r => r.config)),
      data: { summary: summary as unknown as Record<string, unknown> },
    });
    console.error(`[cat26] RUN INVALID: infra error rate ${(accSummary.infra_error_rate * 100).toFixed(0)}% over cap`);
    process.exit(2);
  }

  // Stub-embed runs verify plumbing + corpus headroom with a synthetic
  // embedder; they can never claim a full 'pass' (or publishable).
  const verdict: ReceiptVerdict = summary.gate === 'fail' ? 'fail' : stubEmbed ? 'partial' : 'pass';
  writeReceipt(receiptPath(CATEGORY, REPORTS_ROOT), {
    ...baseReceipt(startedAt),
    run_status: 'completed',
    verdict,
    n_total: accSummary.n_total,
    n_scored: accSummary.n_scored,
    completion_rate: accSummary.completion_rate,
    errors: accSummary.errors,
    publishable: accSummary.publishable && !stubEmbed,
    resolved_config: resolvedConfig(stubEmbed, results.map(r => r.config)),
    data: { summary: summary as unknown as Record<string, unknown> },
  });

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`cat26 contextual retrieval A/B — summary (${summary.mode})`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  for (const m of summary.per_mode) {
    console.log(`  ${String(m.mode_requested).padEnd(22)} R@${K}=${(m.mean_recall_at_k * 100).toFixed(1).padStart(5)}%  MRR=${m.mrr.toFixed(3)}  (effective inline: ${m.mode_effective_inline}, control=${(m.mismatched_gold_mean_recall_at_k * 100).toFixed(1)}%)`);
  }
  console.log(`best mode:                    ${best_mode}${best_mode === 'tie' ? ` (${tied.join(' = ')})` : ''}`);
  console.log(`title vs none:                ${(summary.title_vs_none_delta * 100).toFixed(1)}pt`);
  console.log(`synopsis-requested vs none:   ${(summary.synopsis_requested_vs_none_delta * 100).toFixed(1)}pt (inline path = title tier; synopsis NOT exercised)`);
  if (accSummary.errors.length > 0) {
    console.log(`errors: ${accSummary.errors.map(e => `${e.probe_id}:${e.origin}`).join(', ')}`);
  }
  console.log('');
  console.log(`gate: ${summary.gate.toUpperCase()}${verdict === 'partial' && summary.gate === 'pass' ? ' (verdict partial: stub-embed run)' : ''}`);
  if (summary.gate === 'fail') {
    for (const reason of gateReasons) console.log(`  ✗ ${reason}`);
    process.exit(1);
  }
  console.log('  ✓ all gates pass');
}

if (import.meta.main) {
  main().catch(err => {
    console.error('[cat26] fatal:', err);
    process.exit(2);
  });
}

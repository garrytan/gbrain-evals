/**
 * BrainBench multi-adapter runner (Phase 2).
 *
 * Runs multiple adapter implementations against the same corpus and the
 * same query sets, emitting a side-by-side scorecard. This is the
 * neutrality unlock — external baselines scored on the same bar as
 * gbrain, so the scorecard answers "how does gbrain compare to what any
 * agent could do?" rather than just "what changed between gbrain versions?"
 *
 * Query families (one scorecard row per adapter x family):
 *   - relational            auto-built from world-v1 _facts (4 templates,
 *                           shared with shootout-driver.ts via
 *                           queries/relational.ts)
 *   - fuzzy                 Tier 5 hand-authored vague-recall queries
 *   - externally-authored   Tier 5.5 synthetic-outsider queries
 * Tier 5/5.5 items whose gold.relevant is empty (abstention, judge-only
 * answer-string) are excluded from retrieval means per the NaN contract in
 * types.ts recallAtK and reported as excluded (audit adapters-queries-07:
 * these 80 queries used to be validated but never executed).
 *
 * Usage:
 *   bun eval/runner/multi-adapter.ts [--adapter <name>] [--queries <set>] [--json]
 *
 *   --adapter <name>        gbrain | vector-grep-rrf-fusion | grep-only |
 *                           vector | all (default all). Both `--adapter NAME`
 *                           and `--adapter=NAME` parse; an unknown name is an
 *                           error, never a silent run-everything
 *                           (audit orchestrators-11).
 *   --queries <set>         relational | tier5 | tier5.5 | all (default all)
 *   --include-subset=<name> REPLACE all families with the curated subset at
 *                           eval/data/gold/brainbench-<name>-subset.json
 *   --json                  machine-readable JSON on stdout
 *   --receipt-path <path>   override the receipt location (tests)
 *
 * Env:
 *   BRAINBENCH_N            runs per adapter (default 5). Non-numeric / < 1
 *                           values fall back to 5 with a warning instead of
 *                           producing zero runs + a crash
 *                           (audit orchestrators-12).
 *
 * Receipt: eval/reports/multi-adapter/receipt.json (WS0 contract). Probe
 * universe = adapter x applicable gold-bearing query; an adapter crash is a
 * sut failure — its probes are scored 0 and stay in the denominator
 * (probe-accounting policy).
 */

import { readFileSync } from 'fs';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { runExtract } from 'gbrain/extract';
import { RipgrepBm25Adapter } from './adapters/grep-only.ts';
import { VectorOnlyAdapter } from './adapters/vector.ts';
import { HybridNoGraphAdapter } from './adapters/vector-grep-rrf-fusion.ts';
import type { Adapter, Page, Query, RankedDoc } from './types.ts';
import { precisionAtK, recallAtK, sanitizePage, sanitizeQuery } from './types.ts';
import { buildRelationalQueries, loadWorldCorpus, type RichPage } from './queries/relational.ts';
import { getTier5FuzzyQueries, getTier5_5SyntheticQueries } from './queries/index.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { writeReceipt, receiptPath, RECEIPT_SCHEMA_VERSION, BENCHMARK_VERSION } from './receipt.ts';
import { gbrainVersion, gbrainPin } from './gbrain-version.ts';

const TOP_K = 5;

// ─── Query families ─────────────────────────────────────────────────

export type QuerySource = 'relational' | 'tier5' | 'tier5.5' | 'all';

export interface QueryFamily {
  family: string;
  /** Gold-bearing queries (non-empty gold.relevant) — the scored set. */
  queries: Query[];
  /**
   * Ids excluded from retrieval scoring because gold.relevant is empty
   * (abstention / judge-only answer-string items). Excluded, not zeroed:
   * metrics.recallAtK returns NaN on an empty relevant set by contract.
   */
  excluded_no_gold: string[];
}

function splitByGold(family: string, raw: Query[]): QueryFamily {
  const queries: Query[] = [];
  const excluded: string[] = [];
  for (const q of raw) {
    if ((q.gold.relevant ?? []).length > 0) queries.push(q);
    else excluded.push(q.id);
  }
  return { family, queries, excluded_no_gold: excluded };
}

/** Assemble the requested query families against the loaded corpus. */
export function collectFamilies(pages: RichPage[], source: QuerySource): QueryFamily[] {
  const out: QueryFamily[] = [];
  if (source === 'relational' || source === 'all') {
    out.push(splitByGold('relational', buildRelationalQueries(pages)));
  }
  if (source === 'tier5' || source === 'all') {
    out.push(splitByGold('fuzzy', getTier5FuzzyQueries()));
  }
  if (source === 'tier5.5' || source === 'all') {
    out.push(splitByGold('externally-authored', getTier5_5SyntheticQueries()));
  }
  return out;
}

/**
 * The inline GbrainAfterAdapter below only understands the 4 relational
 * templates — it parses query text into a graph traversal and returns []
 * for anything else. Scoring it on fuzzy / externally-authored questions
 * would publish a 0% row that says nothing about gbrain-the-product (whose
 * fuzzy path is hybridSearch, represented here by vector-grep-rrf-fusion).
 * Rows are omitted as "not applicable" instead of shipped as fake zeros.
 * Curated subsets keep their historical behavior (run on every adapter).
 */
const RELATIONAL_ONLY_ADAPTERS = new Set(['gbrain']);

export function familiesForAdapter(adapterName: string, families: QueryFamily[]): QueryFamily[] {
  if (!RELATIONAL_ONLY_ADAPTERS.has(adapterName)) return families;
  return families.filter(f => f.family === 'relational' || f.family.startsWith('subset:'));
}

// ─── gbrain adapter (inline, wraps existing engine) ─────────

/**
 * Minimal gbrain adapter for the side-by-side run. Wraps PGLiteEngine +
 * extract + the same graph-first-then-grep strategy used in before-after.ts.
 *
 * When the dedicated GbrainAdapter class ships (separate commit), this
 * inline wrapper is the bridge — same semantics, different surface.
 */
class GbrainAfterAdapter implements Adapter {
  readonly name = 'gbrain';

  async init(rawPages: Page[]): Promise<unknown> {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    for (const p of rawPages) {
      await engine.putPage(p.slug, {
        type: p.type,
        title: p.title,
        compiled_truth: p.compiled_truth,
        timeline: p.timeline,
      });
    }
    // Silence extract's console.error noise during benchmark runs.
    const origErr = console.error;
    console.error = () => {};
    try {
      await runExtract(engine, ['links', '--source', 'db']);
      await runExtract(engine, ['timeline', '--source', 'db']);
    } finally {
      console.error = origErr;
    }
    // Build a text map for grep fallback identical to before-after.ts.
    const contentBySlug = new Map<string, string>();
    for (const p of rawPages) {
      contentBySlug.set(p.slug, `${p.title}\n${p.compiled_truth}\n${p.timeline}`);
    }
    return { engine, contentBySlug };
  }

  async query(q: Query, state: unknown): Promise<RankedDoc[]> {
    const { engine, contentBySlug } = state as {
      engine: PGLiteEngine;
      contentBySlug: Map<string, string>;
    };

    // Parse the relational query text to extract seed + direction + linkTypes.
    // Format matches what buildRelationalQueries() emits; for EXT adapters
    // this parsing is skipped and they just do text-match on query.text.
    const { seed, direction, linkTypes } = parseRelationalQuery(q, contentBySlug);

    // Graph-first ranking.
    const graphHits: string[] = [];
    if (seed && linkTypes.length > 0) {
      for (const lt of linkTypes) {
        const paths = await engine.traversePaths(seed, {
          depth: 1,
          direction,
          linkType: lt,
        });
        for (const p of paths) {
          const target = direction === 'out' ? p.to_slug : p.from_slug;
          if (target !== seed && !graphHits.includes(target)) graphHits.push(target);
        }
      }
    }
    // Grep fallback for entities the extractor missed.
    const grepHits: string[] = [];
    if (seed) {
      if (direction === 'out') {
        // No explicit grep fallback for outgoing — graph has it.
      } else {
        for (const [slug, content] of contentBySlug) {
          if (slug === seed) continue;
          if (graphHits.includes(slug)) continue;
          if (content.includes(seed)) grepHits.push(slug);
        }
        grepHits.sort();
      }
    }
    const ranked = [...graphHits, ...grepHits];
    return ranked.map((id, i) => ({
      page_id: id,
      score: ranked.length - i,  // synthetic descending score
      rank: i + 1,
    }));
  }

  async teardown(state: unknown): Promise<void> {
    const { engine } = state as { engine: PGLiteEngine };
    await engine.disconnect();
  }
}

/**
 * Parse a relational query template into (seed, direction, linkTypes).
 * Matches the templates emitted by buildRelationalQueries(). Returns empty
 * linkTypes if the query doesn't match a known template (adapter falls back
 * to grep).
 */
function parseRelationalQuery(
  q: Query,
  contentBySlug: Map<string, string>,
): { seed: string; direction: 'in' | 'out'; linkTypes: string[] } {
  // Title->slug lookup table for resolving the entity named in the query.
  const titleToSlug = new Map<string, string>();
  for (const [slug, content] of contentBySlug) {
    const title = content.split('\n')[0] ?? '';
    if (title) titleToSlug.set(title.toLowerCase(), slug);
  }
  const text = q.text;

  // "Who attended <title>?" → meeting seed, direction=out, attended
  let m = /^Who attended (.+)\?$/.exec(text);
  if (m) {
    const seed = titleToSlug.get(m[1].toLowerCase()) ?? '';
    return { seed, direction: 'out', linkTypes: ['attended'] };
  }
  // "Who works at <title>?" → company seed, in, works_at+founded
  m = /^Who works at (.+)\?$/.exec(text);
  if (m) {
    const seed = titleToSlug.get(m[1].toLowerCase()) ?? '';
    return { seed, direction: 'in', linkTypes: ['works_at', 'founded'] };
  }
  // "Who invested in <title>?" → company seed, in, invested_in
  m = /^Who invested in (.+)\?$/.exec(text);
  if (m) {
    const seed = titleToSlug.get(m[1].toLowerCase()) ?? '';
    return { seed, direction: 'in', linkTypes: ['invested_in'] };
  }
  // "Who advises <title>?" → company seed, in, advises
  m = /^Who advises (.+)\?$/.exec(text);
  if (m) {
    const seed = titleToSlug.get(m[1].toLowerCase()) ?? '';
    return { seed, direction: 'in', linkTypes: ['advises'] };
  }
  return { seed: '', direction: 'in', linkTypes: [] };
}

// ─── Tolerance bands (N-run variance measurement) ──────────────────

/**
 * N=5 per eng pass 3 decision. For current adapters (all deterministic
 * over sorted page input) bands will be ~0. Per-run variance surfaces
 * when any of these enter the benchmark:
 *   - LLM-judge scoring (future)
 *   - Non-deterministic embedding providers
 *   - Page-ordering-dependent dedup tie-breaks (induced here by shuffle)
 *
 * Shuffling ingestion order per run reveals order-sensitive bugs. An
 * adapter with hidden order-dependence (e.g. a tie-break that favors
 * first-seen slug) shows up as non-zero stddev.
 */

/**
 * Guarded BRAINBENCH_N parse (audit orchestrators-12: Number('') is 0 and
 * Number('garbage') is NaN — either made the run loop execute zero times and
 * crash on runResults[0]). Mirrors the all.ts concurrency guard.
 */
export function resolveRunsPerAdapter(raw: string | undefined): number {
  if (raw === undefined) return 5;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  console.error(`[multi-adapter] BRAINBENCH_N=${JSON.stringify(raw)} is not a number >= 1; falling back to 5 runs.`);
  return 5;
}

interface PerQueryScore {
  query_id: string;
  family: string;
  precision: number;
  recall: number;
  hits: number;
  expected: number;
}

interface FamilyRunAggregate {
  family: string;
  n: number;
  mean_precision: number;
  mean_recall: number;
  correct: number;
  expected: number;
}

export interface AdapterScorecard {
  adapter: string;
  family: string;
  queries: number;
  runs: number;
  /** Mean across N runs. */
  mean_precision_at_k: number;
  mean_recall_at_k: number;
  /** Sample stddev across N runs (n-1 denominator). Zero means deterministic. */
  stddev_precision_at_k: number;
  stddev_recall_at_k: number;
  /** From the first run (for the headline "correct/gold" column). */
  correct_in_top_k: number;
  total_expected: number;
}

/**
 * Seeded Fisher-Yates shuffle. Deterministic given the same seed so
 * N-run results are reproducible by anyone re-running with the same seed.
 * Uses a linear congruential generator (LCG) — good enough for benchmark
 * permutations, not cryptographic.
 */
function shuffleSeeded<T>(arr: T[], seed: number): T[] {
  const out = [...arr];
  let s = seed >>> 0;
  const next = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function scoreOneRun(
  adapter: Adapter,
  pages: Page[],
  families: QueryFamily[],
): Promise<PerQueryScore[]> {
  // Day 9 sealed qrels enforcement (codex fix #1, #2, #3):
  // Build sanitized copies with no `_facts` and no `gold` fields before
  // handing them to the adapter. The scorer retains the full Query shape
  // (including gold.relevant) to compute precision/recall below.
  const publicPages = pages.map(sanitizePage);
  const state = await adapter.init(publicPages, { name: adapter.name });
  const out: PerQueryScore[] = [];
  try {
    for (const fam of families) {
      for (const q of fam.queries) {
        const publicQ = sanitizeQuery(q);
        const results = await adapter.query(publicQ, state);
        // collectFamilies already excluded empty-gold queries per the NaN
        // contract, so relevant is guaranteed non-empty here.
        const relevant = new Set(q.gold.relevant ?? []);
        const topK = results.slice(0, TOP_K);
        const seen = new Set<string>();
        let hits = 0;
        for (const r of topK) {
          if (relevant.has(r.page_id) && !seen.has(r.page_id)) {
            seen.add(r.page_id);
            hits++;
          }
        }
        out.push({
          query_id: q.id,
          family: fam.family,
          precision: precisionAtK(results, relevant, TOP_K),
          recall: recallAtK(results, relevant, TOP_K),
          hits,
          expected: relevant.size,
        });
      }
    }
  } finally {
    if (adapter.teardown) await adapter.teardown(state);
  }
  return out;
}

function aggregateByFamily(perQuery: PerQueryScore[]): Map<string, FamilyRunAggregate> {
  const acc = new Map<string, { p: number; r: number; n: number; correct: number; expected: number }>();
  for (const s of perQuery) {
    let a = acc.get(s.family);
    if (!a) {
      a = { p: 0, r: 0, n: 0, correct: 0, expected: 0 };
      acc.set(s.family, a);
    }
    a.p += s.precision;
    a.r += s.recall;
    a.n++;
    a.correct += s.hits;
    a.expected += s.expected;
  }
  const out = new Map<string, FamilyRunAggregate>();
  for (const [family, a] of acc) {
    out.set(family, {
      family,
      n: a.n,
      mean_precision: a.n > 0 ? a.p / a.n : 0,
      mean_recall: a.n > 0 ? a.r / a.n : 0,
      correct: a.correct,
      expected: a.expected,
    });
  }
  return out;
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function stddev(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}

async function scoreAdapter(
  adapter: Adapter,
  pages: Page[],
  families: QueryFamily[],
  runs: number,
): Promise<{ scorecards: AdapterScorecard[]; firstRun: PerQueryScore[] }> {
  const perRunAggregates: Map<string, FamilyRunAggregate>[] = [];
  let firstRun: PerQueryScore[] = [];
  for (let i = 0; i < runs; i++) {
    // Shuffle pages per run with a per-run seed. Seed = i + 1 (not 0,
    // since LCG iterates once at start of next()). Run 0 uses the seed
    // that produces a minimally-scrambled permutation; doesn't matter
    // for correctness since we aggregate across runs.
    const shuffled = shuffleSeeded(pages, i + 1);
    const perQuery = await scoreOneRun(adapter, shuffled, families);
    if (i === 0) firstRun = perQuery;
    perRunAggregates.push(aggregateByFamily(perQuery));
  }
  const scorecards: AdapterScorecard[] = [];
  for (const fam of families) {
    const aggs = perRunAggregates
      .map(m => m.get(fam.family))
      .filter((a): a is FamilyRunAggregate => a !== undefined);
    if (aggs.length === 0) continue; // family had zero gold-bearing queries
    const pVals = aggs.map(a => a.mean_precision);
    const rVals = aggs.map(a => a.mean_recall);
    scorecards.push({
      adapter: adapter.name,
      family: fam.family,
      queries: fam.queries.length,
      runs,
      mean_precision_at_k: mean(pVals),
      mean_recall_at_k: mean(rVals),
      stddev_precision_at_k: stddev(pVals),
      stddev_recall_at_k: stddev(rVals),
      correct_in_top_k: aggs[0].correct,
      total_expected: aggs[0].expected,
    });
  }
  return { scorecards, firstRun };
}

function pct(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`;
}

function pctBand(mean: number, sd: number, digits = 1): string {
  if (sd === 0) return pct(mean, digits);
  return `${pct(mean, digits)} ±${(sd * 100).toFixed(digits)}`;
}

// ─── Subset loader (v0.35.1.0 embedder-shootout) ───────────────────

/**
 * Load a curated query subset from eval/data/gold/brainbench-<name>.json.
 * Used by the embedder-shootout matrix to run a Cat 13 conceptual-recall
 * cell that's actually embedder-sensitive (the relational corpus is
 * graph/keyword-dominated and produces near-zero embedder signal).
 *
 * The JSON file shape MUST match:
 *   {
 *     "schema_version": 1,
 *     "subset": "<name>",
 *     "queries": [
 *       { "id": "...", "text": "...", "relevant_chunk_ids": ["..."],
 *         "inclusion_reason": "..." (optional) },
 *       ...
 *     ]
 *   }
 *
 * Loaded entries are normalized to the runner's `Query` type so the
 * existing scoring pipeline runs unchanged.
 */
function loadSubset(name: string): Query[] {
  const path = `eval/data/gold/brainbench-${name}-subset.json`;
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.queries)) {
    throw new Error(`Subset ${path}: missing or malformed "queries" array`);
  }
  const out: Query[] = [];
  for (const q of parsed.queries) {
    if (typeof q.id !== 'string' || typeof q.text !== 'string' || !Array.isArray(q.relevant_chunk_ids)) {
      throw new Error(`Subset ${path}: entry ${JSON.stringify(q.id)} missing id/text/relevant_chunk_ids`);
    }
    out.push({
      id: q.id,
      tier: 'medium',
      text: q.text,
      expected_output_type: 'cited-source-pages',
      gold: { relevant: q.relevant_chunk_ids as string[] },
      tags: ['embedder-sensitive'],
    });
  }
  return out;
}

// ─── CLI parsing ────────────────────────────────────────────────────

export interface CliArgs {
  json: boolean;
  /** undefined or 'all' → run every adapter. */
  adapter?: string;
  subset?: string;
  queries: QuerySource;
  receiptPathOverride?: string;
}

const QUERY_SOURCES: readonly QuerySource[] = ['relational', 'tier5', 'tier5.5', 'all'];

/**
 * Strict argv parsing. Both `--flag value` and `--flag=value` forms are
 * accepted; unknown tokens throw instead of being silently ignored (audit
 * orchestrators-11: the documented `--adapter grep-only` space form used to
 * parse as nothing and run all four adapters, burning embedding spend).
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const out: CliArgs = { json: false, queries: 'all' };
  const takeValue = (flag: string, i: number): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--adapter') out.adapter = takeValue('--adapter', ++i);
    else if (a.startsWith('--adapter=')) out.adapter = a.slice('--adapter='.length);
    else if (a === '--queries') out.queries = takeValue('--queries', ++i) as QuerySource;
    else if (a.startsWith('--queries=')) out.queries = a.slice('--queries='.length) as QuerySource;
    else if (a === '--include-subset') out.subset = takeValue('--include-subset', ++i);
    else if (a.startsWith('--include-subset=')) out.subset = a.slice('--include-subset='.length);
    else if (a === '--receipt-path') out.receiptPathOverride = takeValue('--receipt-path', ++i);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!QUERY_SOURCES.includes(out.queries)) {
    throw new Error(`--queries must be one of ${QUERY_SOURCES.join(' | ')}, got "${out.queries}"`);
  }
  return out;
}

/** Resolve --adapter to the adapter list. Unknown names are an error. */
export function selectAdapters(all: Adapter[], only: string | undefined): Adapter[] {
  if (only === undefined || only === 'all') return all;
  const matched = all.filter(a => a.name === only);
  if (matched.length === 0) {
    throw new Error(
      `No adapter named "${only}". Available: ${all.map(a => a.name).join(', ')}, all`,
    );
  }
  return matched;
}

// ─── Main ──────────────────────────────────────────────────────────

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const cli = parseCliArgs(argv);
  const startedAt = new Date().toISOString();
  const runsPerAdapter = resolveRunsPerAdapter(process.env.BRAINBENCH_N);
  const log = cli.json ? () => {} : console.log;

  log('# BrainBench — multi-adapter side-by-side\n');
  log(`Generated: ${new Date().toISOString().slice(0, 19)}`);

  const pages = loadWorldCorpus('eval/data/world-v1');
  log(`Corpus: ${pages.length} rich-prose pages from eval/data/world-v1/`);

  // v0.35.1.0 embedder-shootout: optional curated subset. When set, ALL
  // query families are REPLACED by the JSON subset's queries. Run twice —
  // once without the flag, once with — to get both numbers on the same cell.
  let families: QueryFamily[];
  if (cli.subset) {
    families = [splitByGold(`subset:${cli.subset}`, loadSubset(cli.subset))];
  } else {
    families = collectFamilies(pages, cli.queries);
  }
  for (const f of families) {
    const excl = f.excluded_no_gold.length > 0
      ? ` (+${f.excluded_no_gold.length} excluded: empty gold.relevant — abstention/judge-only items are out of retrieval scope per the NaN contract)`
      : '';
    log(`Queries [${f.family}]: ${f.queries.length} scored${excl}`);
  }
  log('');

  const allAdapters: Adapter[] = [
    new GbrainAfterAdapter(),
    new HybridNoGraphAdapter(),
    new RipgrepBm25Adapter(),
    new VectorOnlyAdapter(),
  ];
  const adapters = selectAdapters(allAdapters, cli.adapter);

  // Probe universe: adapter x applicable gold-bearing query.
  let expectedProbes = 0;
  for (const a of adapters) {
    for (const f of familiesForAdapter(a.name, families)) expectedProbes += f.queries.length;
  }
  const acc = new ProbeAccounting(expectedProbes);

  log(`## Running adapters (N=${runsPerAdapter} runs per adapter, page-order shuffled per run)\n`);
  const scorecards: AdapterScorecard[] = [];
  const failedAdapters: string[] = [];
  for (const a of adapters) {
    const fams = familiesForAdapter(a.name, families);
    const skippedFams = families.filter(f => !fams.includes(f)).map(f => f.family);
    if (skippedFams.length > 0) {
      log(`- ${a.name}: not applicable to [${skippedFams.join(', ')}] (inline relational wrapper; gbrain's fuzzy path is hybridSearch, see vector-grep-rrf-fusion)`);
    }
    if (fams.length === 0 || fams.every(f => f.queries.length === 0)) {
      log(`- ${a.name}: no applicable gold-bearing queries; skipping init.`);
      continue;
    }
    log(`- ${a.name} ...`);
    const t0 = Date.now();
    try {
      const { scorecards: sc, firstRun } = await scoreAdapter(a, pages, fams, runsPerAdapter);
      for (const p of firstRun) acc.score(`${a.name}:${p.query_id}`, p.recall);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      for (const s of sc) {
        log(`  ${s.family}: P@${TOP_K} ${pctBand(s.mean_precision_at_k, s.stddev_precision_at_k)}, R@${TOP_K} ${pctBand(s.mean_recall_at_k, s.stddev_recall_at_k)}, ${s.correct_in_top_k}/${s.total_expected} correct (run 1)`);
      }
      log(`  done (${elapsed}s).`);
      scorecards.push(...sc);
    } catch (err) {
      // SUT failure: every probe this adapter owned is a scored miss (0),
      // never silently dropped from the denominator (probe-accounting).
      failedAdapters.push(a.name);
      const ids = fams.flatMap(f => f.queries.map(q => q.id));
      if (ids.length > 0) {
        acc.error(`${a.name}:${ids[0]}`, 'sut', `adapter run failed: ${String(err)}`);
        for (const qid of ids.slice(1)) acc.score(`${a.name}:${qid}`, 0);
      }
      log(`  FAILED (scored as misses): ${String(err)}`);
    }
  }

  log('\n## Side-by-side scorecard (mean ± stddev across N runs)\n');
  log(`| Adapter             | Family              | Runs | Queries | P@${TOP_K} (mean ± sd)    | R@${TOP_K} (mean ± sd)    |`);
  log('|---------------------|---------------------|------|---------|---------------------|---------------------|');
  for (const sc of scorecards) {
    log(`| ${sc.adapter.padEnd(19)} | ${sc.family.padEnd(19)} | ${String(sc.runs).padStart(4)} | ${String(sc.queries).padStart(7)} | ${pctBand(sc.mean_precision_at_k, sc.stddev_precision_at_k).padStart(19)} | ${pctBand(sc.mean_recall_at_k, sc.stddev_recall_at_k).padStart(19)} |`);
  }
  log('');
  log('*Stddev = 0 means the adapter is deterministic over page ordering. Non-zero stddev surfaces order-dependent bugs (e.g. tie-break that favors first-seen slug). LLM-judge-based metrics will produce non-zero stddev once added.*\n');

  // Per-family deltas vs the first adapter that has a row in that family.
  const familyNames = [...new Set(scorecards.map(s => s.family))];
  for (const fam of familyNames) {
    const rows = scorecards.filter(s => s.family === fam);
    if (rows.length < 2) continue;
    const [first, ...rest] = rows;
    log(`## Deltas vs ${first.adapter} [${fam}]\n`);
    for (const other of rest) {
      const dP = (other.mean_precision_at_k - first.mean_precision_at_k) * 100;
      const dR = (other.mean_recall_at_k - first.mean_recall_at_k) * 100;
      const dC = other.correct_in_top_k - first.correct_in_top_k;
      log(`- ${other.adapter}: P@${TOP_K} ${dP >= 0 ? '+' : ''}${dP.toFixed(1)}pts, R@${TOP_K} ${dR >= 0 ? '+' : ''}${dR.toFixed(1)}pts, correct-in-top-${TOP_K} ${dC >= 0 ? '+' : ''}${dC}`);
    }
    log('');
  }

  log('## Methodology\n');
  log(`- Corpus: ${pages.length} rich-prose fictional pages (eval/data/world-v1/).`);
  for (const f of families) {
    log(`- [${f.family}] ${f.queries.length} gold-bearing queries scored, ${f.excluded_no_gold.length} excluded (empty gold.relevant).`);
  }
  log(`- Metrics: mean P@${TOP_K} and R@${TOP_K} per family (eval/runner/metrics.ts denominators).`);
  log(`- Top-K: ${TOP_K} (what agents actually read in ranked results).`);
  log(`- Each adapter reingests raw pages. No gold data visible to adapters.`);

  // ── Receipt (WS0 contract) ──
  const summary = acc.summary();
  const verdict: 'pass' | 'partial' | 'fail' = failedAdapters.length === 0
    ? 'pass'
    : (scorecards.length > 0 ? 'partial' : 'fail');
  const receiptFile = cli.receiptPathOverride ?? receiptPath('multi-adapter');
  writeReceipt(receiptFile, {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: 'multi-adapter',
    run_status: 'completed',
    verdict,
    n_total: summary.n_total,
    n_scored: summary.n_scored,
    completion_rate: summary.completion_rate,
    errors: summary.errors,
    publishable: summary.publishable && failedAdapters.length === 0,
    gbrain_version: gbrainVersion(),
    gbrain_pin: gbrainPin(),
    resolved_config: {
      adapters: adapters.map(a => a.name),
      failed_adapters: failedAdapters,
      runs_per_adapter: runsPerAdapter,
      top_k: TOP_K,
      query_source: cli.subset ? `subset:${cli.subset}` : cli.queries,
      families: families.map(f => ({
        family: f.family,
        scored: f.queries.length,
        excluded_no_gold: f.excluded_no_gold,
      })),
      relational_builder: 'eval/runner/queries/relational.ts buildRelationalQueries (shared with shootout-driver.ts)',
    },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: { scorecards },
  });
  log(`\nReceipt: ${receiptFile}`);

  if (cli.json) {
    console.log(JSON.stringify({
      scorecards,
      families: families.map(f => ({ family: f.family, scored: f.queries.length, excluded_no_gold: f.excluded_no_gold })),
      corpus: pages.length,
      runs_per_adapter: runsPerAdapter,
      failed_adapters: failedAdapters,
      receipt: receiptFile,
    }, null, 2));
  }
  return failedAdapters.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  main()
    .then(code => process.exit(code)) // explicit: PGLite's WASM runtime pollutes ambient process.exitCode
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}

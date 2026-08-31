/**
 * BrainBench Cat 19 — `gbrain doctor --remediate` conformance loop.
 *
 * Headline question: does gbrain's doctor/remediate path actually drive a
 * sick brain to a healthier one — plan the right steps, execute them, and
 * move the real brain_score?
 *
 * ── Feature boundary ─────────────────────────────────────────────────
 * UNDER TEST: gbrain's doctor code path end to end —
 *   - `engine.getHealth()` and its REAL BrainHealth fields (brain_score,
 *     missing_embeddings, per-component scores). The previous version read
 *     `h.chunk_count` / `h.link_count`, which do not exist on BrainHealth,
 *     so the receipt reported 0 links before AND after remediation (audit
 *     cats18-21-08). Link/chunk counts now come from direct SQL.
 *   - `computeRecommendations()` — the doctor planner (exported at
 *     gbrain src/core/brain-score-recommendations.ts; imported via direct
 *     source path since it has no subpath export).
 *   - Execution of the plan's mechanical steps via gbrain's OWN entry
 *     points: `runEmbedCore({stale:true})` (what the embed.stale remediation
 *     job runs) and `runExtract(engine, ['links','--source','db'])` (the
 *     extract job in DB mode).
 * LEGITIMATELY SEEDED/STUBBED: the 30-page seed corpus with intentional
 * gaps (imported noEmbed so missing_embeddings > 0; no link extraction so
 * link_count == 0), and — by default — the embed HTTP transport
 * (deterministic hash vectors via the gateway test seam). Embedding QUALITY
 * is not under test; the remediation LOOP is: missing_embeddings must
 * converge to 0 and brain_score must climb. CAT19_LIVE_EMBED=1 +
 * OPENAI_API_KEY runs the live transport instead.
 *
 * ── Verdict (real + failable, audit cats18-21-09) ────────────────────
 * Five gates, each a scored probe (1/0), step crashes typed 'sut':
 *   g1 seed_gaps_present            — baseline really has the gaps (harness
 *                                     sanity; failure = harness error)
 *   g2 plan_recommends_embed_stale  — computeRecommendations emits embed.stale
 *   g3 embeddings_converge          — post-remediation missing_embeddings == 0,
 *                                     zero embed failures
 *   g4 links_extracted              — link_count grew by >= minLinksInserted
 *   g5 brain_score_climbs           — brain_score delta >= minScoreDelta
 * verdict 'pass' iff every gate scores 1; otherwise 'fail'. Exit code is
 * non-zero unless verdict === 'pass'. brain_score_delta is always computed
 * from real getHealth scores — the old null-scored fallback path (which made
 * delta read 0 when unmeasurable, audit cats18-21-17) is gone; a getHealth
 * failure is now a typed harness error, not a silent 0.
 *
 * Run:
 *   bun eval/runner/cat19-doctor-remediate.ts                    # hermetic (stub embed)
 *   CAT19_LIVE_EMBED=1 bun eval/runner/cat19-doctor-remediate.ts # live OpenAI embeds
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { runExtract } from 'gbrain/extract';
import { configureGateway, __setEmbedTransportForTests } from 'gbrain/ai/gateway';
import type { BrainHealth } from 'gbrain/types';
// No subpath exports for these; direct source imports (same pattern cat20
// uses for the brainstorm orchestrator).
import { computeRecommendations } from '../../node_modules/gbrain/src/core/brain-score-recommendations.ts';
import { runEmbedCore } from '../../node_modules/gbrain/src/commands/embed.ts';
import { makeHashEmbedTransport } from './cat18-embedding-providers.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { writeReceipt, receiptPath, BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, type Receipt } from './receipt.ts';
import { gbrainVersion as gbrainVersionResolved, gbrainPin } from './gbrain-version.ts';

export const CAT19_CATEGORY = 'cat19-doctor-remediate';

/** Wiki-link rows the seed corpus contains: 15 people x 2 refs + 5 topics x 1
 *  ref = 35 distinct (from, to) pairs, none self-referential. The floor sits
 *  well under that so minor extractor dedup changes don't flake the gate,
 *  while a broken extract path (0 links) still fails hard. */
export const DEFAULT_MIN_LINKS_INSERTED = 20;
/** brain_score floor for the remediation delta. Embed coverage alone is worth
 *  up to 35 of the 100-point composite (embed_coverage_score), and link
 *  density + orphan avoidance add more; an empty remediation moves 0. */
export const DEFAULT_MIN_SCORE_DELTA = 15;
export const EMBED_MODEL = 'openai:text-embedding-3-large';
export const EMBED_DIM = 1536;

export interface SeedPage {
  slug: string;
  title: string;
  body: string;
}

/** 30 pages with deliberate gaps: wiki refs in bodies but no link extraction,
 *  and noEmbed import so every chunk starts with a NULL embedding. */
export function defaultSeedPages(): SeedPage[] {
  const pages: SeedPage[] = [];
  for (let i = 0; i < 10; i++) {
    pages.push({
      slug: `companies/co-${i}`,
      title: `Company ${i}`,
      body: `Company ${i} is in AI/ML. Founded ${2018 + (i % 8)}. Series ${['Seed', 'A', 'B', 'C'][i % 4]}.`,
    });
  }
  for (let i = 0; i < 15; i++) {
    const company = `companies/co-${i % 10}`;
    const peer = `people/p-${(i + 3) % 15}`;
    pages.push({
      slug: `people/p-${i}`,
      title: `Person ${i}`,
      body: `Person ${i} works at [[${company}]] and collaborates with [[${peer}]]. Background in research.`,
    });
  }
  for (let i = 0; i < 5; i++) {
    pages.push({
      slug: `concepts/topic-${i}`,
      title: `Topic ${i}`,
      body: `Topic ${i} is a research area. See [[companies/co-${i}]] for industry context.`,
    });
  }
  return pages;
}

/** Real BrainHealth fields + direct SQL counts. No invented fields: BrainHealth
 *  has no chunk_count/link_count (audit cats18-21-08), so those come from the
 *  links / content_chunks tables directly. */
export interface HealthSnapshot {
  brain_score: number;
  page_count: number;
  missing_embeddings: number;
  embed_coverage: number;
  stale_pages: number;
  orphan_pages: number;
  dead_links: number;
  embed_coverage_score: number;
  link_density_score: number;
  no_orphans_score: number;
  /** SQL: SELECT COUNT(*) FROM links (not a BrainHealth field). */
  link_count: number;
  /** SQL: SELECT COUNT(*) FROM content_chunks (not a BrainHealth field). */
  chunk_count: number;
}

export async function captureHealth(engine: PGLiteEngine): Promise<{ snapshot: HealthSnapshot; health: BrainHealth }> {
  // getHealth failure propagates — a typed harness error upstream, never a
  // silently-null score that reads as "delta 0".
  const health = await engine.getHealth();
  const rows = await engine.executeRaw(
    `SELECT
       (SELECT COUNT(*)::int FROM links) AS link_count,
       (SELECT COUNT(*)::int FROM content_chunks) AS chunk_count`,
    [],
  ) as Array<{ link_count: number; chunk_count: number }>;
  return {
    snapshot: {
      brain_score: health.brain_score,
      page_count: health.page_count,
      missing_embeddings: health.missing_embeddings,
      embed_coverage: health.embed_coverage,
      stale_pages: health.stale_pages,
      orphan_pages: health.orphan_pages,
      dead_links: health.dead_links,
      embed_coverage_score: health.embed_coverage_score,
      link_density_score: health.link_density_score,
      no_orphans_score: health.no_orphans_score,
      link_count: rows[0]?.link_count ?? 0,
      chunk_count: rows[0]?.chunk_count ?? 0,
    },
    health,
  };
}

export interface StepRecord {
  id: string;
  description: string;
  duration_ms: number;
  outcome: string;
  error: string | null;
}

export interface Cat19Options {
  seedPages?: SeedPage[];
  /** Hermetic embed transport (default true unless CAT19_LIVE_EMBED=1). */
  stubEmbed?: boolean;
  /** Test hook: skip every remediation step so the gates must fail. */
  skipRemediation?: boolean;
  minLinksInserted?: number;
  minScoreDelta?: number;
  /** Acknowledge a missing-key skip (exit 0 instead of 1). */
  allowSkip?: boolean;
  reportsDir?: string;
  quiet?: boolean;
}

export interface Cat19RunResult {
  receipt: Receipt;
  exitCode: number;
  receiptFile: string;
  baseline: HealthSnapshot | null;
  achieved: HealthSnapshot | null;
  steps: StepRecord[];
}

export function optionsFromEnv(argv: string[] = process.argv.slice(2)): Cat19Options {
  return {
    stubEmbed: process.env.CAT19_LIVE_EMBED !== '1',
    allowSkip: argv.includes('--allow-skip') || process.env.BRAINBENCH_ALLOW_SKIP === '1',
    minLinksInserted: process.env.CAT19_MIN_LINKS ? parseInt(process.env.CAT19_MIN_LINKS, 10) : undefined,
    minScoreDelta: process.env.CAT19_MIN_SCORE_DELTA ? parseFloat(process.env.CAT19_MIN_SCORE_DELTA) : undefined,
  };
}

const GATES = [
  'seed_gaps_present',
  'plan_recommends_embed_stale',
  'embeddings_converge',
  'links_extracted',
  'brain_score_climbs',
] as const;

export async function runCat19(options: Cat19Options = {}): Promise<Cat19RunResult> {
  const startedAt = new Date().toISOString();
  const stubEmbed = options.stubEmbed ?? (process.env.CAT19_LIVE_EMBED !== '1');
  const minLinks = options.minLinksInserted ?? DEFAULT_MIN_LINKS_INSERTED;
  const minDelta = options.minScoreDelta ?? DEFAULT_MIN_SCORE_DELTA;
  const seedPages = options.seedPages ?? defaultSeedPages();
  const reportsDir = options.reportsDir ?? join(process.cwd(), 'eval/reports');
  const receiptFile = receiptPath(CAT19_CATEGORY, reportsDir);
  const log = options.quiet ? (_: string) => {} : (s: string) => process.stderr.write(s);

  // Isolated GBRAIN_HOME: the embedding-column registry reads file-plane
  // config first; the user's real ~/.gbrain must not leak into the cell.
  const home = join(tmpdir(), `cat19-gbrain-home-${process.pid}-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  process.env.GBRAIN_HOME = home;

  const baseReceipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CAT19_CATEGORY,
    gbrain_version: gbrainVersionResolved(),
    gbrain_pin: gbrainPin(),
    started_at: startedAt,
  } as const;

  // Skip gate: a live-embed run without a key writes a skipped receipt and
  // exits non-zero unless the skip is explicitly acknowledged.
  if (!stubEmbed && !process.env.OPENAI_API_KEY) {
    const receipt: Receipt = {
      ...baseReceipt,
      run_status: 'skipped',
      skip_reason: 'CAT19_LIVE_EMBED=1 requires OPENAI_API_KEY (default run is hermetic — drop CAT19_LIVE_EMBED)',
      n_total: GATES.length,
      n_scored: 0,
      completion_rate: 0,
      errors: [],
      publishable: false,
      finished_at: new Date().toISOString(),
    };
    writeReceipt(receiptFile, receipt);
    log(`[cat19] SKIPPED: ${receipt.skip_reason}\n[cat19] receipt: ${receiptFile}\n`);
    return { receipt, exitCode: options.allowSkip ? 0 : 1, receiptFile, baseline: null, achieved: null, steps: [] };
  }

  if (stubEmbed) {
    // Model construction needs a non-empty key even with the transport
    // stubbed; the stub never lets a request leave the process.
    if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = 'dummy-stub-embed';
    __setEmbedTransportForTests(makeHashEmbedTransport());
  }

  const acc = new ProbeAccounting(GATES.length);
  const attempted = new Set<string>();
  const score = (id: (typeof GATES)[number], v: number) => { attempted.add(id); acc.score(id, v); };
  const gateError = (id: (typeof GATES)[number], origin: 'sut' | 'harness', msg: string) => { attempted.add(id); acc.error(id, origin, msg); };
  const steps: StepRecord[] = [];
  let baseline: HealthSnapshot | null = null;
  let achieved: HealthSnapshot | null = null;
  let planIds: string[] = [];
  const t0 = Date.now();

  configureGateway({
    embedding_model: EMBED_MODEL,
    embedding_dimensions: EMBED_DIM,
    env: process.env as Record<string, string | undefined>,
  });

  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  try {
    // ── Seed with intentional gaps ─────────────────────────────────
    log(`[cat19] seeding ${seedPages.length} pages (noEmbed, no link extraction)...\n`);
    const origLog = console.log;
    console.log = () => {};
    try {
      for (const p of seedPages) {
        await importFromContent(engine, p.slug, p.body, { noEmbed: true });
      }
    } finally {
      console.log = origLog;
    }

    const base = await captureHealth(engine);
    baseline = base.snapshot;
    log(`[cat19] baseline: score=${baseline.brain_score} links=${baseline.link_count} missing_embed=${baseline.missing_embeddings} chunks=${baseline.chunk_count}\n`);

    // g1 — the seed must actually be sick, or nothing downstream measures
    // remediation. A healthy baseline is a harness bug (seed drift).
    if (baseline.missing_embeddings > 0 && baseline.link_count === 0) {
      score('seed_gaps_present', 1);
    } else {
      gateError('seed_gaps_present', 'harness',
        `seed corpus lost its gaps: missing_embeddings=${baseline.missing_embeddings} (want >0), link_count=${baseline.link_count} (want 0)`);
    }

    // g2 — the doctor planner (the real computeRecommendations export; the
    // old header claimed it "isn't exported", which was false — cats18-21-09).
    try {
      const plan = computeRecommendations(base.health, {
        embeddingModel: EMBED_MODEL,
        embeddingDimensions: EMBED_DIM,
        // Key presence is not under test; the stub run holds a dummy key.
        embeddingProviderConfigured: true,
        hasChatApiKey: false,
      });
      planIds = plan.map(r => r.id);
      score('plan_recommends_embed_stale', planIds.includes('embed.stale') ? 1 : 0);
      log(`[cat19] doctor plan: [${planIds.join(', ') || 'empty'}]\n`);
    } catch (e: any) {
      gateError('plan_recommends_embed_stale', 'sut', `computeRecommendations threw: ${e?.message ?? e}`);
    }

    // ── Execute the mechanical remediations via gbrain's own entry points ──
    if (!options.skipRemediation) {
      // Step 1: extract.links (DB source — the extract job's checkout-less mode)
      {
        const t = Date.now();
        let outcome = '';
        let error: string | null = null;
        const orig = console.log;
        console.log = () => {};
        try {
          await runExtract(engine, ['links', '--source', 'db']);
          outcome = 'extract links --source db completed';
        } catch (e: any) {
          error = String(e?.message ?? e).slice(0, 300);
          outcome = 'threw';
        } finally {
          console.log = orig;
        }
        steps.push({ id: 'extract.links', description: 'gbrain extract links --source db (runExtract)', duration_ms: Date.now() - t, outcome, error });
      }
      // Step 2: embed.stale (the exact runEmbedCore path the embed.stale
      // remediation job executes)
      {
        const t = Date.now();
        let outcome = '';
        let error: string | null = null;
        const orig = console.log;
        console.log = () => {};
        try {
          const res = await runEmbedCore(engine, { stale: true });
          outcome = `embedded ${res.embedded}, skipped ${res.skipped}, failures ${res.failures}`;
          if (res.failures > 0) error = `embed failures: ${res.failures} (${JSON.stringify(res).slice(0, 200)})`;
        } catch (e: any) {
          error = String(e?.message ?? e).slice(0, 300);
          outcome = 'threw';
        } finally {
          console.log = orig;
        }
        steps.push({ id: 'embed.stale', description: 'gbrain embed --stale (runEmbedCore)', duration_ms: Date.now() - t, outcome, error });
      }
    } else {
      log(`[cat19] skipRemediation set — no steps executed (gate-failability hook)\n`);
    }

    const ach = await captureHealth(engine);
    achieved = ach.snapshot;

    // g3 — embeddings converged through the embed.stale path
    const embedStep = steps.find(s => s.id === 'embed.stale');
    if (embedStep?.error) {
      gateError('embeddings_converge', 'sut', `embed.stale step failed: ${embedStep.error}`);
    } else {
      score('embeddings_converge', achieved.missing_embeddings === 0 && baseline.missing_embeddings > 0 ? 1 : 0);
    }

    // g4 — the extract path materialized real link rows
    const extractStep = steps.find(s => s.id === 'extract.links');
    const linksInserted = achieved.link_count - baseline.link_count;
    if (extractStep?.error) {
      gateError('links_extracted', 'sut', `extract.links step failed: ${extractStep.error}`);
    } else {
      score('links_extracted', linksInserted >= minLinks ? 1 : 0);
    }

    // g5 — the composite score the doctor optimizes actually climbed
    const scoreDelta = achieved.brain_score - baseline.brain_score;
    score('brain_score_climbs', scoreDelta >= minDelta ? 1 : 0);

    log(`[cat19] achieved: score=${achieved.brain_score} (Δ${scoreDelta.toFixed(1)}) links=${achieved.link_count} (+${linksInserted}) missing_embed=${achieved.missing_embeddings}\n`);
  } catch (e: any) {
    // Harness-level crash (seed/health/connect) — every gate not yet
    // attempted becomes a typed harness error so the receipt can never read
    // as a clean pass.
    for (const g of GATES) {
      if (!attempted.has(g)) gateError(g, 'harness', `run crashed before gate: ${String(e?.message ?? e).slice(0, 300)}`);
    }
  } finally {
    if (stubEmbed) __setEmbedTransportForTests(null);
    await engine.disconnect().catch(() => {});
  }

  const summary = acc.summary();
  // pass requires: every gate attempted and scored 1, zero recorded errors
  // (sut errors score 0 so they fail the every() too; infra errors fail the
  // errors.length check).
  const allGatesPassed = summary.n_scored === GATES.length
    && summary.errors.length === 0
    && acc.scoredValues().every(v => v === 1);

  const verdict: 'pass' | 'fail' = allGatesPassed ? 'pass' : 'fail';
  const runInvalid = summary.run_invalid;
  const brainScoreDelta = baseline && achieved ? achieved.brain_score - baseline.brain_score : null;

  const receipt: Receipt = {
    ...baseReceipt,
    run_status: runInvalid ? 'error' : 'completed',
    ...(runInvalid ? {} : { verdict }),
    n_total: summary.n_total,
    n_scored: summary.n_scored,
    completion_rate: summary.completion_rate,
    errors: summary.errors,
    publishable: summary.publishable,
    resolved_config: {
      embed_transport: stubEmbed ? 'stubbed-hash' : 'live',
      embedding_model: EMBED_MODEL,
      embedding_dimensions: EMBED_DIM,
      min_links_inserted: minLinks,
      min_score_delta: minDelta,
      skip_remediation: options.skipRemediation ?? false,
      // No retrieval comparison in this runner (WS5 pinning n/a): the doctor
      // loop never calls hybridSearch.
      search_mode: null,
      reranker_enabled: null,
    },
    finished_at: new Date().toISOString(),
    data: {
      seed_pages: seedPages.length,
      baseline,
      achieved,
      brain_score_delta: brainScoreDelta,
      links_inserted: baseline && achieved ? achieved.link_count - baseline.link_count : null,
      doctor_plan_ids: planIds,
      steps,
      wall_clock_ms: Date.now() - t0,
    },
  };
  writeReceipt(receiptFile, receipt);

  // Dated human-readable detail file (legacy location, same payload).
  const outDir = join(reportsDir, CAT19_CATEGORY);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat19.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  log(`\n[cat19] ─── Scorecard ───────────────────\n`);
  log(`[cat19]   baseline:  score=${baseline?.brain_score ?? 'n/a'} links=${baseline?.link_count ?? 'n/a'} missing_embed=${baseline?.missing_embeddings ?? 'n/a'}\n`);
  log(`[cat19]   achieved:  score=${achieved?.brain_score ?? 'n/a'} links=${achieved?.link_count ?? 'n/a'} missing_embed=${achieved?.missing_embeddings ?? 'n/a'}\n`);
  log(`[cat19]   delta:     ${brainScoreDelta === null ? 'n/a' : brainScoreDelta.toFixed(1)} (gate >= ${minDelta})\n`);
  for (const s of steps) log(`[cat19]   step ${s.id}: ${s.outcome} (${s.duration_ms}ms)${s.error ? ` ERROR: ${s.error}` : ''}\n`);
  log(`[cat19]   gates:     ${summary.n_scored}/${GATES.length} scored, ${summary.errors.length} errors\n`);
  log(`[cat19]   run_status=${receipt.run_status} verdict=${receipt.verdict ?? 'n/a'} publishable=${receipt.publishable}\n`);
  log(`[cat19]   receipt:   ${receiptFile}\n`);

  const exitCode = runInvalid ? 1 : (verdict === 'pass' ? 0 : 1);
  return { receipt, exitCode, receiptFile, baseline, achieved, steps };
}

if (import.meta.main) {
  try {
    const result = await runCat19(optionsFromEnv());
    process.exit(result.exitCode);
  } catch (e: any) {
    try {
      writeReceipt(receiptPath(CAT19_CATEGORY), {
        schema_version: RECEIPT_SCHEMA_VERSION,
        benchmark_version: BENCHMARK_VERSION,
        category: CAT19_CATEGORY,
        run_status: 'error',
        n_total: GATES.length,
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
    process.stderr.write(`[cat19] FATAL: ${e?.stack ?? e}\n`);
    process.exit(1);
  }
}

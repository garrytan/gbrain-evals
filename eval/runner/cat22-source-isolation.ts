/**
 * BrainBench Cat 22 — federated source-isolation fuzz.
 *
 * Headline question: when a caller is scoped to one source on a multi-source
 * brain, can it ever see rows from neighboring sources?
 *
 * ── Feature boundary ─────────────────────────────────────────────────
 * UNDER TEST: gbrain's read-surface source scoping —
 *   - hybridSearch's sourceId threading into engine.searchKeyword's SQL filter
 *   - engine.listPages with PageFilters.sourceId / sourceIds (federated array)
 *   - engine.getPage with opts.sourceId
 *   - engine.traverseGraph with TraverseGraphOpts.sourceId (the v0.34.1 #861
 *     P0 leak seal: seed, step, AND link-aggregation scope)
 * LEGITIMATELY SEEDED/STUBBED: the corpus (importFromContent with noEmbed —
 * the embedding pipeline is out of scope; the keyword arm is what carries
 * hybridSearch here), the sources-table rows, and the cross-source link edges
 * (inserted directly into `links`; link EXTRACTION is not under test — the
 * scoped graph WALK is). The gateway env is sanitized of every provider key
 * so hybridSearch's no-provider keyword-only path is what runs: hermetic by
 * construction, not by an invalid opt (the old `detail: 'normal'` no-op).
 *
 * ── Non-vacuous probes + negative control ────────────────────────────
 * Every scoped probe asserts PRESENCE (expected totals derived from the
 * actually-seeded corpus, never hardcoded) in addition to zero leaks, so an
 * engine that returns nothing can no longer be declared "provably clean"
 * (audit cats22-25-03). A result row with a missing source_id counts as a
 * violation, not a skip. The negative control re-runs the same surfaces with
 * isolation OFF (no source opts) and REQUIRES cross-source rows to appear —
 * proving the probes can detect leakage when it exists.
 *
 * Run:
 *   bun eval/runner/cat22-source-isolation.ts
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { configureGateway } from 'gbrain/ai/gateway';
import { hybridSearch } from 'gbrain/search/hybrid';
import { ProbeAccounting } from './probe-accounting.ts';
import { writeReceipt, receiptPath, BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, type Receipt } from './receipt.ts';
import { gbrainVersion as gbrainVersionResolved, gbrainPin } from './gbrain-version.ts';

export const CAT22_CATEGORY = 'cat22-source-isolation';

export const SOURCES = ['alpha', 'beta', 'gamma'] as const;
export const PAGES_PER_SOURCE = 10;

/**
 * WS5 pin — applied via engine.setConfig BEFORE ingest and echoed into the
 * receipt's resolved_config. gbrain's default 'balanced' mode silently
 * enables the zerank-2 reranker when ZEROENTROPY_API_KEY is set; never rely
 * on defaults. Expansion/autocut off: no LLM in the loop, no result trimming
 * confounding the presence assertions.
 */
export const PINNED_CONFIG: Record<string, string> = {
  'search.mode': 'balanced',
  'search.reranker.enabled': 'false',
  'search.expansion': 'false',
  'search.autocut': 'false',
};

/** Embedding/LLM provider keys stripped from the gateway env for hermeticity. */
const PROVIDER_KEYS = [
  'OPENAI_API_KEY', 'VOYAGE_API_KEY', 'ZEROENTROPY_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY',
];

export interface SurfaceProbe {
  surface: string;
  scope_source: string;
  /** Rows the surface actually returned (getPage: non-null lookups). */
  total_results: number;
  /** Rows the surface was REQUIRED to return for the probe to be non-vacuous. */
  expected_results: number;
  leaked_results: number;
  /** Result rows with no source_id at all — treated as violations, not skips. */
  missing_source_id: number;
  leak_sample: string[];
  pass: boolean;
  fail_reason: string | null;
}

export interface ControlProbe {
  surface: string;
  total_results: number;
  cross_source_rows: number;
  /** True when the unscoped run observed cross-source rows — the probe CAN detect leaks. */
  detected_leak: boolean;
}

interface SeededCorpus {
  /** source id → slugs successfully imported into that source. */
  bySource: Map<string, Set<string>>;
}

async function ensureSource(engine: any, source_id: string): Promise<void> {
  if (source_id === 'default') return;
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{"federated": true}'::jsonb) ON CONFLICT (id) DO NOTHING`,
    [source_id],
  );
}

async function pageId(engine: any, sourceId: string, slug: string): Promise<number> {
  const rows = await engine.executeRaw(
    `SELECT id FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL`,
    [sourceId, slug],
  ) as Array<{ id: number }>;
  if (rows.length !== 1) throw new Error(`seed lookup failed: ${sourceId}/${slug} → ${rows.length} rows`);
  return Number(rows[0].id);
}

/**
 * Seed: 3 sources with identical slug shapes (people/p-N, companies/co-N) so
 * a scope leak is observable, plus a graph triad for the traverseGraph probe:
 * alpha graph/hub-alpha → alpha graph/spoke-alpha (in-scope edge) and
 * alpha graph/hub-alpha → beta graph/leak-beta (the cross-source edge a
 * scoped walk must never follow).
 */
export async function seedCorpus(engine: any): Promise<SeededCorpus> {
  const bySource = new Map<string, Set<string>>();
  for (const s of SOURCES) {
    await ensureSource(engine, s);
    bySource.set(s, new Set());
  }

  for (const s of SOURCES) {
    for (let i = 0; i < PAGES_PER_SOURCE; i++) {
      const personSlug = `people/p-${i}`;
      const companySlug = `companies/co-${i}`;
      await importFromContent(engine, personSlug, `Person ${i} of source ${s}. Topic AI.`, { sourceId: s, noEmbed: true });
      await importFromContent(engine, companySlug, `Company ${i} of source ${s}. Topic AI.`, { sourceId: s, noEmbed: true });
      bySource.get(s)!.add(personSlug);
      bySource.get(s)!.add(companySlug);
    }
  }

  // Graph triad. Bodies avoid the 'AI' keyword so the hybridSearch corpus
  // stays the 20-per-source page set; the graph probe has its own edges.
  await importFromContent(engine, 'graph/hub-alpha', 'Hub node in alpha for graph isolation probes.', { sourceId: 'alpha', noEmbed: true });
  await importFromContent(engine, 'graph/spoke-alpha', 'Spoke node in alpha, linked from the hub.', { sourceId: 'alpha', noEmbed: true });
  await importFromContent(engine, 'graph/leak-beta', 'Beta-only node a scoped alpha walk must never reach.', { sourceId: 'beta', noEmbed: true });
  bySource.get('alpha')!.add('graph/hub-alpha');
  bySource.get('alpha')!.add('graph/spoke-alpha');
  bySource.get('beta')!.add('graph/leak-beta');

  const hub = await pageId(engine, 'alpha', 'graph/hub-alpha');
  const spoke = await pageId(engine, 'alpha', 'graph/spoke-alpha');
  const leak = await pageId(engine, 'beta', 'graph/leak-beta');
  // Direct link seeding: the extraction pipeline is not under test, the
  // scoped WALK over these edges is.
  await engine.executeRaw(
    `INSERT INTO links (from_page_id, to_page_id, link_type) VALUES ($1, $2, 'mentions'), ($1, $3, 'mentions')`,
    [hub, spoke, leak],
  );

  return { bySource };
}

/**
 * Score one scoped read surface. Exported for the regression tests: empty
 * result sets, missing source_id, and leaked rows must all FAIL (the old
 * probe passed vacuously on all three — audit cats22-25-03).
 */
export function probeResult(
  surface: string,
  scope: string,
  expected: number,
  rows: Array<{ slug: string; source_id: string | undefined }>,
  allowed: Set<string>,
): SurfaceProbe {
  let leaked = 0;
  let missing = 0;
  const leakSample: string[] = [];
  for (const r of rows) {
    if (r.source_id === undefined || r.source_id === null) {
      missing++;
      if (leakSample.length < 5) leakSample.push(`${r.slug}@<missing source_id>`);
    } else if (!allowed.has(r.source_id)) {
      leaked++;
      if (leakSample.length < 5) leakSample.push(`${r.slug}@${r.source_id}`);
    }
  }
  let failReason: string | null = null;
  if (rows.length < expected) failReason = `vacuous: returned ${rows.length} rows, expected >= ${expected}`;
  if (missing > 0) failReason = `${missing} row(s) missing source_id (unattributable — counted as violations)`;
  if (leaked > 0) failReason = `${leaked} leaked row(s)`;
  return {
    surface,
    scope_source: scope,
    total_results: rows.length,
    expected_results: expected,
    leaked_results: leaked,
    missing_source_id: missing,
    leak_sample: leakSample,
    pass: failReason === null,
    fail_reason: failReason,
  };
}

export interface Cat22Options {
  reportsDir?: string;
  quiet?: boolean;
  /**
   * Test hook: skip corpus seeding for the named sources. Lets the
   * regression test construct the "engine returns nothing" world that used
   * to pass vacuously and prove the gate now fails on it.
   */
  skipSeedSources?: string[];
}

export interface Cat22RunResult {
  receipt: Receipt;
  probes: SurfaceProbe[];
  controls: ControlProbe[];
  exitCode: number;
  receiptFile: string;
}

export async function runCat22(options: Cat22Options = {}): Promise<Cat22RunResult> {
  const startedAt = new Date().toISOString();
  const reportsDir = options.reportsDir ?? join(process.cwd(), 'eval/reports');
  const receiptFile = receiptPath(CAT22_CATEGORY, reportsDir);
  const log = options.quiet ? (_: string) => {} : (s: string) => process.stderr.write(s);

  // Isolate GBRAIN_HOME so user config (embedding column pins, search mode
  // overrides) can't bleed into the run.
  const home = join(tmpdir(), `cat22-gbrain-home-${process.pid}-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  process.env.GBRAIN_HOME = home;

  // Hermetic: strip every provider key from the gateway env so hybridSearch's
  // keyword-only path falls out of the documented no-provider short-circuit
  // (hybrid.ts: `!isAvailable('embedding', ...)`), not out of an invalid opt.
  const sanitizedEnv: Record<string, string | undefined> = { ...process.env } as Record<string, string | undefined>;
  for (const k of PROVIDER_KEYS) delete sanitizedEnv[k];
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: sanitizedEnv,
  });

  const engine: any = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // WS5: pin search mode + reranker BEFORE ingest. Never rely on defaults.
  for (const [key, value] of Object.entries(PINNED_CONFIG)) {
    await engine.setConfig(key, value);
  }

  const scope = 'alpha';
  const probes: SurfaceProbe[] = [];
  const controls: ControlProbe[] = [];
  // 5 scoped isolation probes + 3 negative controls.
  const acc = new ProbeAccounting(8);

  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  let seeded: SeededCorpus;
  try {
    seeded = await seedCorpus(engine);
    for (const s of options.skipSeedSources ?? []) {
      // Test hook: simulate the empty-result regression by deleting a
      // source's rows after seeding (keeps import plumbing identical).
      await engine.executeRaw(`DELETE FROM pages WHERE source_id = $1`, [s]);
      seeded.bySource.set(s, new Set());
    }
  } catch (e: any) {
    console.log = origLog;
    console.error = origErr;
    await engine.disconnect();
    const receipt: Receipt = {
      schema_version: RECEIPT_SCHEMA_VERSION,
      benchmark_version: BENCHMARK_VERSION,
      category: CAT22_CATEGORY,
      run_status: 'error',
      n_total: 8,
      n_scored: 0,
      completion_rate: 0,
      errors: [{ probe_id: 'seed', origin: 'harness', message: String(e?.message ?? e).slice(0, 500) }],
      publishable: false,
      gbrain_version: gbrainVersionResolved(),
      gbrain_pin: gbrainPin(),
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    };
    writeReceipt(receiptFile, receipt);
    log(`[cat22] seed failed: ${e?.message ?? e}\n`);
    return { receipt, probes: [], controls: [], exitCode: 1, receiptFile };
  }

  const alphaCount = seeded.bySource.get('alpha')!.size;
  const betaCount = seeded.bySource.get('beta')!.size;
  const totalCount = [...seeded.bySource.values()].reduce((a, s) => a + s.size, 0);
  const scopeAllowed = new Set([scope]);

  const runProbe = async (id: string, fn: () => Promise<SurfaceProbe>): Promise<void> => {
    try {
      const p = await fn();
      probes.push(p);
      if (p.pass) acc.score(id, 1);
      else acc.error(id, 'sut', `${p.surface}: ${p.fail_reason}`);
    } catch (e: any) {
      // A thrown read on a scoped surface is the SUT failing the probe.
      acc.error(id, 'sut', `${id} threw: ${e?.message ?? e}`);
      probes.push({
        surface: id, scope_source: scope, total_results: 0, expected_results: -1,
        leaked_results: 0, missing_source_id: 0,
        leak_sample: [`error: ${String(e?.message ?? e).slice(0, 200)}`],
        pass: false, fail_reason: `threw: ${String(e?.message ?? e).slice(0, 200)}`,
      });
    }
  };

  // ── Probe 1: hybridSearch scoped to alpha (keyword arm, no provider) ──
  await runProbe('hybridSearch', async () => {
    const results = await hybridSearch(engine, 'AI', { limit: 100, sourceId: scope });
    return probeResult(
      'hybridSearch', scope,
      1, // presence floor: the corpus has 20 alpha pages matching 'AI'
      (results as any[]).map(r => ({ slug: r.slug as string, source_id: r.source_id as string | undefined })),
      scopeAllowed,
    );
  });

  // ── Probe 2: listPages with PageFilters.sourceId ──
  await runProbe('listPages', async () => {
    const pages = await engine.listPages({ sourceId: scope, limit: 500 });
    const p = probeResult(
      'listPages', scope,
      alphaCount, // exact seeded count, derived from actual imports
      (pages as any[]).map(pg => ({ slug: pg.slug as string, source_id: pg.source_id as string | undefined })),
      scopeAllowed,
    );
    if (p.pass && pages.length !== alphaCount) {
      p.pass = false;
      p.fail_reason = `count mismatch: returned ${pages.length}, seeded ${alphaCount}`;
    }
    return p;
  });

  // ── Probe 3: getPage with sourceId — slug exists in all 3 sources ──
  await runProbe('getPage', async () => {
    const rows: Array<{ slug: string; source_id: string | undefined }> = [];
    let found = 0;
    for (let i = 0; i < PAGES_PER_SOURCE; i++) {
      const slug = `people/p-${i}`;
      const page = await engine.getPage(slug, { sourceId: scope });
      if (page) {
        found++;
        rows.push({ slug: page.slug, source_id: page.source_id });
      }
    }
    // total_results reflects lookups that actually returned a page —
    // never a hardcoded constant (audit cats22-25-03).
    return probeResult('getPage', scope, PAGES_PER_SOURCE, rows, scopeAllowed);
  });

  // ── Probe 4: federated listPages with sourceIds=['alpha','beta'] ──
  await runProbe('listPages-federated', async () => {
    const pages = await engine.listPages({ sourceIds: ['alpha', 'beta'], limit: 500 });
    const p = probeResult(
      'listPages-federated', 'alpha+beta',
      alphaCount + betaCount,
      (pages as any[]).map(pg => ({ slug: pg.slug as string, source_id: pg.source_id as string | undefined })),
      new Set(['alpha', 'beta']),
    );
    if (p.pass && pages.length !== alphaCount + betaCount) {
      p.pass = false;
      p.fail_reason = `count mismatch: returned ${pages.length}, seeded ${alphaCount + betaCount}`;
    }
    return p;
  });

  // ── Probe 5: traverseGraph scoped — cross-source edge must not be walked ──
  await runProbe('traverseGraph', async () => {
    const nodes = await engine.traverseGraph('graph/hub-alpha', 2, { sourceId: scope });
    const slugs = new Set((nodes as any[]).map(n => n.slug as string));
    // GraphNode carries no source_id; the leak signal is the beta-only slug
    // appearing either as a visited node or inside a node's links array.
    const linkTargets = (nodes as any[]).flatMap(n => (n.links ?? []).map((l: any) => l.to_slug as string));
    const leakedNode = slugs.has('graph/leak-beta');
    const leakedLink = linkTargets.includes('graph/leak-beta');
    const leakCount = (leakedNode ? 1 : 0) + (leakedLink ? 1 : 0);
    const p: SurfaceProbe = {
      surface: 'traverseGraph',
      scope_source: scope,
      total_results: nodes.length,
      expected_results: 2, // hub + spoke must both be visited (non-vacuous)
      leaked_results: leakCount,
      missing_source_id: 0,
      leak_sample: leakCount > 0 ? [`graph/leak-beta (${leakedNode ? 'node' : 'link target'})`] : [],
      pass: false,
      fail_reason: null,
    };
    if (nodes.length < 2 || !slugs.has('graph/hub-alpha') || !slugs.has('graph/spoke-alpha')) {
      p.fail_reason = `vacuous: expected hub+spoke visited, got [${[...slugs].join(', ')}]`;
    } else if (leakCount > 0) {
      p.fail_reason = 'cross-source edge walked under sourceId scope';
    }
    p.pass = p.fail_reason === null;
    return p;
  });

  // ── Negative controls: isolation OFF must show cross-source rows ──
  // These prove the probes can detect leaks: an unscoped read observes rows
  // from multiple sources. If a control sees NO cross-source rows, the
  // scoped probes above proved nothing and the run fails.
  // (getPage has no unscoped control: with no opts it deterministically
  // anchors to one row — engine tiebreak — so it cannot demonstrate leakage.)
  const runControl = async (id: string, fn: () => Promise<ControlProbe>): Promise<void> => {
    try {
      const c = await fn();
      controls.push(c);
      if (c.detected_leak) acc.score(id, 1);
      else acc.error(id, 'harness', `${c.surface} control saw no cross-source rows — scoped probes are not proven able to detect leaks`);
    } catch (e: any) {
      acc.error(id, 'harness', `${id} control threw: ${e?.message ?? e}`);
      controls.push({ surface: id, total_results: 0, cross_source_rows: 0, detected_leak: false });
    }
  };

  await runControl('control-hybridSearch', async () => {
    const results = await hybridSearch(engine, 'AI', { limit: 100 });
    const cross = (results as any[]).filter(r => (r.source_id ?? 'default') !== scope).length;
    return { surface: 'hybridSearch-unscoped', total_results: results.length, cross_source_rows: cross, detected_leak: cross > 0 };
  });

  await runControl('control-listPages', async () => {
    const pages = await engine.listPages({ limit: 500 });
    const cross = (pages as any[]).filter(pg => pg.source_id !== scope).length;
    return {
      surface: 'listPages-unscoped',
      total_results: pages.length,
      cross_source_rows: cross,
      detected_leak: cross > 0 && pages.length === totalCount,
    };
  });

  await runControl('control-traverseGraph', async () => {
    const nodes = await engine.traverseGraph('graph/hub-alpha', 2);
    const hasLeakNode = (nodes as any[]).some(n => n.slug === 'graph/leak-beta');
    return {
      surface: 'traverseGraph-unscoped',
      total_results: nodes.length,
      cross_source_rows: hasLeakNode ? 1 : 0,
      detected_leak: hasLeakNode,
    };
  });

  console.log = origLog;
  console.error = origErr;
  await engine.disconnect();

  const summary = acc.summary();
  const isolationClean = probes.length === 5 && probes.every(p => p.pass);
  const controlsDetect = controls.length === 3 && controls.every(c => c.detected_leak);
  const verdict: 'pass' | 'fail' = isolationClean && controlsDetect ? 'pass' : 'fail';
  const runInvalid = summary.run_invalid;

  const receipt: Receipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CAT22_CATEGORY,
    run_status: runInvalid ? 'error' : 'completed',
    ...(runInvalid ? {} : { verdict }),
    n_total: summary.n_total,
    n_scored: summary.n_scored,
    completion_rate: summary.completion_rate,
    errors: summary.errors,
    publishable: summary.publishable && verdict === 'pass' && !options.skipSeedSources?.length,
    gbrain_version: gbrainVersionResolved(),
    gbrain_pin: gbrainPin(),
    resolved_config: {
      search_mode: PINNED_CONFIG['search.mode'],
      reranker_enabled: false,
      pinned_config: PINNED_CONFIG,
      embed_transport: 'none (provider keys stripped; keyword-only)',
      sources: SOURCES.length,
      seeded_pages: Object.fromEntries([...seeded.bySource.entries()].map(([k, v]) => [k, v.size])),
    },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: {
      probes,
      negative_controls: controls,
      isolation_clean: isolationClean,
      controls_detect_leak: controlsDetect,
    },
  };
  writeReceipt(receiptFile, receipt);

  // Dated human-readable detail file (legacy location, same payload).
  const outDir = join(reportsDir, CAT22_CATEGORY);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat22.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  log(`\n[cat22] ─── Scorecard ───────────────────\n`);
  log(`[cat22]   sources:           ${SOURCES.length} (${SOURCES.join(', ')})\n`);
  log(`[cat22]   isolation clean:   ${isolationClean ? 'YES' : 'NO'}\n`);
  log(`[cat22]   controls detect:   ${controlsDetect ? 'YES' : 'NO'}\n`);
  for (const p of probes) {
    const status = p.pass ? '✓' : '✗';
    log(`[cat22]   ${status} ${p.surface.padEnd(22)} scope=${p.scope_source.padEnd(12)} rows=${p.total_results}/${p.expected_results} leaked=${p.leaked_results} missing_src=${p.missing_source_id}${p.fail_reason ? ` — ${p.fail_reason}` : ''}\n`);
  }
  for (const c of controls) {
    log(`[cat22]   ${c.detected_leak ? '✓' : '✗'} ${c.surface.padEnd(22)} [control] rows=${c.total_results} cross-source=${c.cross_source_rows}\n`);
  }
  log(`[cat22]   run_status=${receipt.run_status} verdict=${receipt.verdict ?? 'n/a'}\n`);
  log(`[cat22]   receipt:           ${receiptFile}\n`);

  const exitCode = runInvalid ? 1 : (verdict === 'pass' ? 0 : 1);
  return { receipt, probes, controls, exitCode, receiptFile };
}

if (import.meta.main) {
  try {
    const result = await runCat22();
    process.exit(result.exitCode);
  } catch (e: any) {
    try {
      writeReceipt(receiptPath(CAT22_CATEGORY), {
        schema_version: RECEIPT_SCHEMA_VERSION,
        benchmark_version: BENCHMARK_VERSION,
        category: CAT22_CATEGORY,
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
    process.stderr.write(`[cat22] FATAL: ${e?.stack ?? e}\n`);
    process.exit(1);
  }
}

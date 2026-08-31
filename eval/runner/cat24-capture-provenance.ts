/**
 * BrainBench Cat 24 — ingestion provenance write-through + trust gate + dedup.
 *
 * Headline question: do gbrain's REAL ingestion paths round-trip the
 * source_kind / source_uri / ingested_via provenance columns correctly —
 * including the op-layer trust gate that must OVERRIDE spoofed provenance
 * from remote callers?
 *
 * ── Feature boundary (audit cats22-25-04 redesign) ───────────────────
 * The old runner claimed "5 ingestion surfaces" but called importFromContent
 * five times with different label strings. This is the honest set of
 * genuinely distinct, library-drivable ingestion paths at this gbrain pin:
 *
 *   1. importFromContent (core/import-file.ts) — the content-import path
 *      with the v0.39.3.0 provenance write-through opts. What trusted local
 *      plumbing (capture, sync auto-writes) funnels into.
 *   2. importFromFile (core/import-file.ts) — the disk-file path used by
 *      sync/import. It accepts NO channel-provenance opts BY DESIGN: file
 *      imports stamp pages.source_path and leave source_kind / source_uri /
 *      ingested_via / ingested_at NULL. That boundary is pinned here.
 *   3. The put_page OP (core/ops/pages.ts) with ctx.remote === false —
 *      the exact call `gbrain capture` makes on a local install
 *      (src/commands/capture.ts drives operations['put_page'].handler with
 *      source_kind 'capture-cli'). Trusted client provenance must land.
 *   4. The put_page OP with ctx.remote === true and SPOOFED provenance —
 *      the CV6 trust gate must server-stamp source_kind/ingested_via to
 *      'mcp:put_page' and source_uri to NULL, ignoring the client values.
 *      This is the MCP-caller posture at the documented trust boundary
 *      (OperationContext.remote); the MCP transport itself is not spun up.
 *
 * NOT drivable and out of scope (documented, not faked): the ingestion
 * daemon's webhook / inbox-folder / fs-watcher sources (gbrain deliberately
 * does not export the daemon; gbrain/ingestion/test-harness exercises source
 * contracts without a brain), and the thin-client remote transport. The old
 * 'webhook' and 'inbox-folder' rows were labels on importFromContent — gone.
 *
 * Plus two semantics probes on the engine's putPage upsert:
 *   5. dedup: re-importing identical content on the same slug hash-matches
 *      and creates no second row (asserts the BEFORE state has exactly one
 *      row — a failed first import can no longer pass vacuously, audit
 *      cats22-25-10).
 *   6. CV12 preservation: a later write with NULL provenance (plain
 *      importFromContent) COALESCE-preserves the first-write provenance and
 *      ingested_at.
 *
 * Hermetic: no API keys. Gateway env sanitized; ctx.deferEmbeds + noEmbed —
 * the embedding pipeline is out of scope.
 *
 * Run:
 *   bun eval/runner/cat24-capture-provenance.ts
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent, importFromFile } from 'gbrain/import-file';
import { configureGateway } from 'gbrain/ai/gateway';
import { operationsByName, type OperationContext } from 'gbrain/operations';
import { ProbeAccounting } from './probe-accounting.ts';
import { writeReceipt, receiptPath, BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, type Receipt } from './receipt.ts';
import { gbrainVersion as gbrainVersionResolved, gbrainPin } from './gbrain-version.ts';

export const CAT24_CATEGORY = 'cat24-capture-provenance';

const PROVIDER_KEYS = [
  'OPENAI_API_KEY', 'VOYAGE_API_KEY', 'ZEROENTROPY_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY',
];

export interface ProvenanceRow {
  source_kind: string | null;
  source_uri: string | null;
  ingested_via: string | null;
  ingested_at: string | Date | null;
  source_path: string | null;
}

export interface PathProbe {
  probe_id: string;
  path: string;
  slug: string;
  expected: { source_kind: string | null; source_uri: string | null; ingested_via: string | null; ingested_at_null: boolean };
  actual: ProvenanceRow | null;
  pass: boolean;
  fail_reason: string | null;
}

async function readProvenance(engine: any, slug: string): Promise<ProvenanceRow | null> {
  const rows = await engine.executeRaw(
    `SELECT source_kind, source_uri, ingested_via, ingested_at, source_path
     FROM pages WHERE slug = $1 AND source_id = 'default' AND deleted_at IS NULL`,
    [slug],
  ) as ProvenanceRow[];
  if (rows.length !== 1) return null;
  return rows[0];
}

/** Compare a provenance row against expectations; null = must be NULL. */
export function checkProvenance(
  actual: ProvenanceRow | null,
  expected: { source_kind: string | null; source_uri: string | null; ingested_via: string | null; ingested_at_null: boolean },
): string | null {
  if (!actual) return 'page row not found (or not exactly one row)';
  if (actual.source_kind !== expected.source_kind) return `source_kind: expected ${JSON.stringify(expected.source_kind)}, got ${JSON.stringify(actual.source_kind)}`;
  if (actual.source_uri !== expected.source_uri) return `source_uri: expected ${JSON.stringify(expected.source_uri)}, got ${JSON.stringify(actual.source_uri)}`;
  if (actual.ingested_via !== expected.ingested_via) return `ingested_via: expected ${JSON.stringify(expected.ingested_via)}, got ${JSON.stringify(actual.ingested_via)}`;
  const atNull = actual.ingested_at == null;
  if (atNull !== expected.ingested_at_null) return `ingested_at: expected ${expected.ingested_at_null ? 'NULL' : 'server-stamped'}, got ${actual.ingested_at ?? 'NULL'}`;
  return null;
}

function makeCtx(engine: any, remote: boolean): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' } as OperationContext['config'],
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    dryRun: false,
    remote,
    sourceId: 'default',
    // Server-side-only flag: chunks land embedding IS NULL — the embedding
    // pipeline is out of scope for this eval.
    deferEmbeds: true,
  } as OperationContext;
}

export interface Cat24Options {
  reportsDir?: string;
  quiet?: boolean;
  /**
   * Test hook: pretend the remote put_page trust gate is broken by driving
   * the remote probe through a TRUSTED ctx instead. The spoof-override probe
   * must then FAIL — proving the gate assertion is not vacuous.
   */
  simulateBrokenTrustGate?: boolean;
}

export interface Cat24RunResult {
  receipt: Receipt;
  probes: PathProbe[];
  exitCode: number;
  receiptFile: string;
}

export async function runCat24(options: Cat24Options = {}): Promise<Cat24RunResult> {
  const startedAt = new Date().toISOString();
  const reportsDir = options.reportsDir ?? join(process.cwd(), 'eval/reports');
  const receiptFile = receiptPath(CAT24_CATEGORY, reportsDir);
  const log = options.quiet ? (_: string) => {} : (s: string) => process.stderr.write(s);

  // Isolate GBRAIN_HOME (config reads: active pack, sync.repo_path — with a
  // fresh home there is no repo, so put_page write-through skips with the
  // deliberate 'no_repo_configured' outcome).
  const home = join(tmpdir(), `cat24-gbrain-home-${process.pid}-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  process.env.GBRAIN_HOME = home;

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

  const PROBE_IDS = [
    'provenance-columns-present',
    'content-import',
    'file-import-no-channel-provenance',
    'op-put-page-local-trusted',
    'op-put-page-remote-spoof-override',
    'dedup-hash-short-circuit',
    'provenance-preserved-on-reimport',
  ];
  const acc = new ProbeAccounting(PROBE_IDS.length);
  const probes: PathProbe[] = [];
  const dedup = { before_rows: -1, after_rows: -1, distinct_page_ids: -1, reimport_status: '' };

  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    // ── Probe 0: schema precondition — provenance columns exist ──
    let columnsPresent = true;
    try {
      await engine.executeRaw(`SELECT source_kind, source_uri, ingested_via, ingested_at FROM pages LIMIT 0`, []);
      acc.score('provenance-columns-present', 1);
    } catch (e: any) {
      columnsPresent = false;
      acc.error('provenance-columns-present', 'sut', `provenance columns missing from pages: ${e?.message ?? e}`);
    }
    if (!columnsPresent) {
      // Nothing downstream can be measured; every path probe fails as SUT.
      for (const id of PROBE_IDS.slice(1)) acc.error(id, 'sut', 'provenance columns missing — path unmeasurable');
    } else {
      const runPathProbe = async (
        probeId: string,
        path: string,
        slug: string,
        expected: PathProbe['expected'],
        drive: () => Promise<void>,
      ): Promise<void> => {
        let failReason: string | null = null;
        let actual: ProvenanceRow | null = null;
        try {
          await drive();
          actual = await readProvenance(engine, slug);
          failReason = checkProvenance(actual, expected);
        } catch (e: any) {
          failReason = `ingestion path threw: ${String(e?.message ?? e).slice(0, 300)}`;
        }
        probes.push({ probe_id: probeId, path, slug, expected, actual, pass: failReason === null, fail_reason: failReason });
        if (failReason === null) acc.score(probeId, 1);
        else acc.error(probeId, 'sut', `${probeId} (${slug}): ${failReason}`);
      };

      // ── Probe 1: importFromContent with provenance write-through ──
      const contentSlug = 'inbox/2026-05-23-content-import';
      const contentBody = '# Content import probe\n\nCaptured via the library content-import path.\n';
      await runPathProbe(
        'content-import', 'importFromContent (trusted library caller)', contentSlug,
        { source_kind: 'capture-cli', source_uri: 'file:///tmp/probe.md', ingested_via: 'capture-cli', ingested_at_null: false },
        async () => {
          await importFromContent(engine, contentSlug, contentBody, {
            noEmbed: true,
            source_kind: 'capture-cli',
            source_uri: 'file:///tmp/probe.md',
            ingested_via: 'capture-cli',
          });
        },
      );

      // ── Probe 2: importFromFile — no channel provenance BY DESIGN ──
      // The file path stamps source_path; source_kind/source_uri/ingested_via
      // stay NULL and ingested_at is only server-stamped when a provenance
      // field is written. This pins the boundary honestly instead of
      // relabeling importFromContent as an 'inbox folder' surface.
      const fileDir = join(tmpdir(), `cat24-files-${process.pid}-${Date.now()}`);
      mkdirSync(join(fileDir, 'inbox'), { recursive: true });
      const relPath = 'inbox/2026-05-23-file-import.md';
      const absPath = join(fileDir, relPath);
      writeFileSync(absPath, '# File import probe\n\nImported from disk via importFromFile.\n', 'utf8');
      await runPathProbe(
        'file-import-no-channel-provenance', 'importFromFile (disk file — sync/import path)', 'inbox/2026-05-23-file-import',
        { source_kind: null, source_uri: null, ingested_via: null, ingested_at_null: true },
        async () => {
          const res = await importFromFile(engine, absPath, relPath, { noEmbed: true });
          if (res.status === 'error' || res.status === 'skipped') {
            throw new Error(`importFromFile ${res.status}: ${res.error ?? 'no error detail'}`);
          }
        },
      );
      // source_path is the file path's actual provenance carrier — verify.
      const fileRow = await readProvenance(engine, 'inbox/2026-05-23-file-import');
      const fileProbe = probes.find(p => p.probe_id === 'file-import-no-channel-provenance');
      if (fileProbe && fileProbe.pass && fileRow?.source_path !== relPath) {
        fileProbe.pass = false;
        fileProbe.fail_reason = `source_path: expected ${JSON.stringify(relPath)}, got ${JSON.stringify(fileRow?.source_path ?? null)}`;
        acc.error('file-import-no-channel-provenance', 'sut', fileProbe.fail_reason);
      }

      const putPage = operationsByName['put_page'];
      if (!putPage) throw new Error('put_page operation missing from gbrain/operations');

      // ── Probe 3: put_page op, trusted local — the capture-cli call shape ──
      const localSlug = 'inbox/2026-05-23-op-local';
      await runPathProbe(
        'op-put-page-local-trusted', 'put_page op, ctx.remote=false (gbrain capture local install)', localSlug,
        { source_kind: 'capture-cli', source_uri: 'stdin', ingested_via: 'capture-cli', ingested_at_null: false },
        async () => {
          await putPage.handler(makeCtx(engine, false), {
            slug: localSlug,
            content: '# Local op probe\n\nWritten through the put_page operation by a trusted local caller.\n',
            source_kind: 'capture-cli',
            source_uri: 'stdin',
            ingested_via: 'capture-cli',
          });
        },
      );

      // ── Probe 4: put_page op, remote — spoofed provenance MUST be overridden ──
      const remoteSlug = 'inbox/2026-05-23-op-remote';
      await runPathProbe(
        'op-put-page-remote-spoof-override', 'put_page op, ctx.remote=true (MCP posture, CV6 trust gate)', remoteSlug,
        { source_kind: 'mcp:put_page', source_uri: null, ingested_via: 'mcp:put_page', ingested_at_null: false },
        async () => {
          await putPage.handler(makeCtx(engine, options.simulateBrokenTrustGate ? false : true), {
            slug: remoteSlug,
            content: '# Remote op probe\n\nWritten through the put_page operation by an untrusted remote caller.\n',
            // Deliberately spoofed — the trust gate must ignore all three.
            source_kind: 'capture-cli',
            source_uri: 'https://attacker.example/poison',
            ingested_via: 'capture-cli',
          });
        },
      );

      // ── Probe 5: dedup — identical re-import creates no second row ──
      try {
        const before = await engine.executeRaw(
          `SELECT id FROM pages WHERE slug = $1 AND source_id = 'default' AND deleted_at IS NULL`,
          [contentSlug],
        ) as Array<{ id: number }>;
        dedup.before_rows = before.length;
        if (before.length !== 1) {
          // First import failed or duplicated — the dedup check would be
          // vacuous (audit cats22-25-10). Fail loudly instead.
          acc.error('dedup-hash-short-circuit', 'sut', `expected exactly 1 pre-existing row for ${contentSlug}, found ${before.length}`);
        } else {
          const res = await importFromContent(engine, contentSlug, contentBody, {
            noEmbed: true,
            source_kind: 'capture-cli',
            source_uri: 'file:///tmp/probe.md',
            ingested_via: 'capture-cli',
          });
          dedup.reimport_status = res.status;
          const after = await engine.executeRaw(
            `SELECT id FROM pages WHERE slug = $1 AND source_id = 'default' AND deleted_at IS NULL`,
            [contentSlug],
          ) as Array<{ id: number }>;
          dedup.after_rows = after.length;
          dedup.distinct_page_ids = new Set([...before, ...after].map(r => Number(r.id))).size;
          if (dedup.distinct_page_ids === 1 && after.length === 1) {
            acc.score('dedup-hash-short-circuit', 1);
          } else {
            acc.error('dedup-hash-short-circuit', 'sut', `re-import produced ${dedup.distinct_page_ids} distinct page id(s), ${after.length} row(s)`);
          }
        }
      } catch (e: any) {
        acc.error('dedup-hash-short-circuit', 'sut', `dedup probe threw: ${e?.message ?? e}`);
      }

      // ── Probe 6: CV12 — NULL-provenance rewrite preserves first-write stamps ──
      try {
        const beforeRow = await readProvenance(engine, contentSlug);
        if (!beforeRow || beforeRow.source_kind !== 'capture-cli') {
          acc.error('provenance-preserved-on-reimport', 'sut', 'precondition failed: content-import row missing its provenance');
        } else {
          // Different body, NO provenance opts: COALESCE must preserve.
          await importFromContent(engine, contentSlug, contentBody + '\nEdited later by a plain writer.\n', { noEmbed: true });
          const afterRow = await readProvenance(engine, contentSlug);
          const drift = checkProvenance(afterRow, {
            source_kind: 'capture-cli', source_uri: 'file:///tmp/probe.md', ingested_via: 'capture-cli', ingested_at_null: false,
          });
          const atBefore = beforeRow.ingested_at instanceof Date ? beforeRow.ingested_at.toISOString() : String(beforeRow.ingested_at);
          const atAfter = afterRow?.ingested_at instanceof Date ? afterRow.ingested_at.toISOString() : String(afterRow?.ingested_at);
          if (drift === null && atBefore === atAfter) {
            acc.score('provenance-preserved-on-reimport', 1);
          } else {
            acc.error('provenance-preserved-on-reimport', 'sut', drift ?? `ingested_at drifted: ${atBefore} → ${atAfter}`);
          }
        }
      } catch (e: any) {
        acc.error('provenance-preserved-on-reimport', 'sut', `preservation probe threw: ${e?.message ?? e}`);
      }
    }
  } finally {
    console.log = origLog;
    console.error = origErr;
    await engine.disconnect();
  }

  const summary = acc.summary();
  const scoredValues = acc.scoredValues();
  const verdict: 'pass' | 'fail' =
    summary.n_scored === PROBE_IDS.length && scoredValues.every(v => v === 1) ? 'pass' : 'fail';
  const runInvalid = summary.run_invalid;

  const receipt: Receipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CAT24_CATEGORY,
    run_status: runInvalid ? 'error' : 'completed',
    ...(runInvalid ? {} : { verdict }),
    n_total: summary.n_total,
    n_scored: summary.n_scored,
    completion_rate: summary.completion_rate,
    errors: summary.errors,
    publishable: summary.publishable && verdict === 'pass' && !options.simulateBrokenTrustGate,
    gbrain_version: gbrainVersionResolved(),
    gbrain_pin: gbrainPin(),
    resolved_config: {
      embed_transport: 'none (provider keys stripped; noEmbed + ctx.deferEmbeds)',
      distinct_ingestion_paths: [
        'importFromContent (content import, provenance opts)',
        'importFromFile (disk file — no channel provenance by design)',
        'put_page op ctx.remote=false (capture-cli local shape)',
        'put_page op ctx.remote=true (MCP posture, spoof override)',
      ],
      out_of_scope: 'ingestion daemon sources (webhook/inbox/fs-watcher — not exported), thin-client transport',
      simulate_broken_trust_gate: options.simulateBrokenTrustGate === true,
    },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: {
      per_path: probes,
      dedup_test: dedup,
    },
  };
  writeReceipt(receiptFile, receipt);

  const outDir = join(reportsDir, CAT24_CATEGORY);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat24.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  log(`\n[cat24] ─── Scorecard ───────────────────\n`);
  log(`[cat24]   probes: ${summary.n_scored}/${PROBE_IDS.length} scored, ${summary.errors.length} error(s)\n`);
  for (const p of probes) {
    log(`[cat24]   ${p.pass ? '✓' : '✗'} ${p.probe_id.padEnd(36)} kind=${p.actual?.source_kind ?? 'NULL'}${p.fail_reason ? ` — ${p.fail_reason}` : ''}\n`);
  }
  log(`[cat24]   dedup: before=${dedup.before_rows} after=${dedup.after_rows} distinct_ids=${dedup.distinct_page_ids} (1 = clean) status=${dedup.reimport_status || 'n/a'}\n`);
  log(`[cat24]   run_status=${receipt.run_status} verdict=${receipt.verdict ?? 'n/a'}\n`);
  log(`[cat24]   receipt: ${receiptFile}\n`);

  const exitCode = runInvalid ? 1 : (verdict === 'pass' ? 0 : 1);
  return { receipt, probes, exitCode, receiptFile };
}

if (import.meta.main) {
  try {
    const result = await runCat24();
    process.exit(result.exitCode);
  } catch (e: any) {
    try {
      writeReceipt(receiptPath(CAT24_CATEGORY), {
        schema_version: RECEIPT_SCHEMA_VERSION,
        benchmark_version: BENCHMARK_VERSION,
        category: CAT24_CATEGORY,
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
    process.stderr.write(`[cat24] FATAL: ${e?.stack ?? e}\n`);
    process.exit(1);
  }
}

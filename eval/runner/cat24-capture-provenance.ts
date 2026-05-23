/**
 * BrainBench Cat 24 — capture/ingest provenance + dedup (v0.38.0.0+).
 *
 * Headline question: does `gbrain capture` (via the importFromContent path
 * with the v0.39.3.0 provenance write-through fields) round-trip the
 * source_kind / source_uri / ingested_via columns correctly across the
 * different ingestion surfaces?
 *
 * Hermetic. No API keys. Uses noEmbed so we don't touch the gateway.
 *
 * Flow:
 *   1. Import the same content through 5 different surfaces:
 *      - capture-cli (source_kind: 'capture-cli')
 *      - put_page op (source_kind: 'put_page')
 *      - mcp put_page (source_kind: 'mcp:put_page')
 *      - webhook (source_kind: 'webhook')
 *      - inbox folder (source_kind: 'inbox-folder')
 *   2. SELECT each page's provenance row, assert exact match.
 *   3. Re-import the same content (same hash) → assert dedup behavior.
 *   4. Emit receipt.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { configureGateway } from 'gbrain/ai/gateway';

const SOURCES = [
  { slug: 'inbox/2026-05-23-from-cli', source_kind: 'capture-cli', source_uri: 'cli', ingested_via: 'gbrain-capture' },
  { slug: 'inbox/2026-05-23-from-put-page', source_kind: 'put_page', source_uri: null, ingested_via: 'gbrain-cli' },
  { slug: 'inbox/2026-05-23-from-mcp', source_kind: 'mcp:put_page', source_uri: null, ingested_via: 'mcp' },
  { slug: 'inbox/2026-05-23-from-webhook', source_kind: 'webhook', source_uri: 'https://example.com/hook', ingested_via: 'http' },
  { slug: 'inbox/2026-05-23-from-inbox', source_kind: 'inbox-folder', source_uri: '~/.gbrain/inbox/note.md', ingested_via: 'fs-watcher' },
];

interface ProvenanceCheck {
  slug: string;
  source_kind_match: boolean;
  source_uri_match: boolean;
  ingested_via_match: boolean;
  has_ingested_at: boolean;
  expected_kind: string;
  actual_kind: string | null;
}

interface Receipt {
  schema_version: 1;
  cat: 'cat24-capture-provenance';
  gbrain_version: string;
  timestamp: string;
  provenance_columns_present: boolean;
  ingestion_paths_tested: number;
  rows_with_correct_provenance: number;
  per_path: ProvenanceCheck[];
  dedup_test: {
    repeated_import: boolean;
    distinct_page_ids: number;
  };
}

async function main(): Promise<void> {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: process.env as Record<string, string | undefined>,
  });

  const engine: any = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const origLog = console.log;
  console.log = () => {};

  // Detect column shape first
  let columnsPresent = true;
  try {
    await engine.executeRaw(`SELECT source_kind, source_uri, ingested_via, ingested_at FROM pages LIMIT 0`, []);
  } catch {
    columnsPresent = false;
  }

  process.stderr.write(`[cat24] provenance columns present: ${columnsPresent}\n`);

  const perPath: ProvenanceCheck[] = [];

  for (const src of SOURCES) {
    const body = `# ${src.slug}\n\nContent captured via ${src.source_kind}.\n\nA capture probe.\n`;
    try {
      await importFromContent(engine, src.slug, body, {
        noEmbed: true,
        source_kind: src.source_kind,
        source_uri: src.source_uri,
        ingested_via: src.ingested_via,
      } as any);
    } catch (e: any) {
      console.log = origLog;
      process.stderr.write(`[cat24] import failed for ${src.slug}: ${e?.message}\n`);
      console.log = () => {};
    }

    // Read back the provenance columns
    let actual: any = null;
    if (columnsPresent) {
      const rows = await engine.executeRaw(
        `SELECT source_kind, source_uri, ingested_via, ingested_at FROM pages WHERE slug = $1 LIMIT 1`,
        [src.slug],
      ) as any[];
      actual = rows[0] ?? null;
    }

    perPath.push({
      slug: src.slug,
      source_kind_match: actual?.source_kind === src.source_kind,
      source_uri_match: actual?.source_uri === src.source_uri,
      ingested_via_match: actual?.ingested_via === src.ingested_via,
      has_ingested_at: actual?.ingested_at != null,
      expected_kind: src.source_kind,
      actual_kind: actual?.source_kind ?? null,
    });
  }

  // Dedup test: re-import the first slug with identical content, count distinct page ids
  const firstSlug = SOURCES[0].slug;
  const before = await engine.executeRaw(
    `SELECT id FROM pages WHERE slug = $1`,
    [firstSlug],
  ) as any[];
  await importFromContent(engine, firstSlug, `# ${firstSlug}\n\nContent captured via ${SOURCES[0].source_kind}.\n\nA capture probe.\n`, {
    noEmbed: true,
    source_kind: SOURCES[0].source_kind,
    source_uri: SOURCES[0].source_uri,
    ingested_via: SOURCES[0].ingested_via,
  } as any);
  const after = await engine.executeRaw(
    `SELECT id FROM pages WHERE slug = $1`,
    [firstSlug],
  ) as any[];
  console.log = origLog;

  const dedup = {
    repeated_import: true,
    distinct_page_ids: new Set([...before, ...after].map((r: any) => r.id)).size,
  };

  await engine.disconnect();

  let gbrainVersion = 'unknown';
  try {
    const pkg = await import('gbrain/package.json' as any);
    gbrainVersion = (pkg as any).default?.version ?? (pkg as any).version ?? 'unknown';
  } catch { /* best-effort */ }

  const correctCount = perPath.filter(p =>
    p.source_kind_match && p.source_uri_match && p.ingested_via_match && p.has_ingested_at
  ).length;

  const receipt: Receipt = {
    schema_version: 1,
    cat: 'cat24-capture-provenance',
    gbrain_version: gbrainVersion,
    timestamp: new Date().toISOString(),
    provenance_columns_present: columnsPresent,
    ingestion_paths_tested: SOURCES.length,
    rows_with_correct_provenance: correctCount,
    per_path: perPath,
    dedup_test: dedup,
  };

  const outDir = join(process.cwd(), 'eval/reports/cat24-capture-provenance');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat24.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  process.stderr.write(`\n[cat24] ─── Scorecard ───────────────────\n`);
  process.stderr.write(`[cat24]   columns present:  ${columnsPresent}\n`);
  process.stderr.write(`[cat24]   paths tested:     ${SOURCES.length}\n`);
  process.stderr.write(`[cat24]   correct rows:     ${correctCount}/${SOURCES.length}\n`);
  process.stderr.write(`[cat24]   dedup ids:        ${dedup.distinct_page_ids} (1 = clean dedup)\n`);
  for (const p of perPath) {
    const ok = p.source_kind_match && p.source_uri_match && p.ingested_via_match;
    process.stderr.write(`[cat24]   ${ok ? '✓' : '✗'} ${p.slug.padEnd(40)} kind=${p.actual_kind ?? 'null'}\n`);
  }
  process.stderr.write(`[cat24]   receipt:          ${outFile}\n`);
}

await main();

#!/usr/bin/env bun
/**
 * Generate the v0.41-launch hermetic baseline file for `gbrain eval gate --baseline`.
 *
 * This script is the reproducible recipe for `baselines/v0.41-launch.baseline.ndjson`.
 * Seeds a PGLite in-memory brain with the same 12-page placeholder corpus that backs
 * `qrels/v0.41-launch.qrels.json`, runs the same 12 queries via `engine.searchKeyword`,
 * captures the retrieval as `EvalCandidateInput` rows, and pipes them through
 * `gbrain bench publish`'s `buildBaselineFromInput` to produce the baseline.
 *
 * Privacy (gbrain D9): EVERY page name is a placeholder (alice-example, widget-co-example,
 * etc). No real user data ever touches this file.
 *
 * Run: GBRAIN_SRC=~/conductor/workspaces/gbrain/brisbane-v2 bun scripts/generate-v0.41-launch.ts
 *      (GBRAIN_SRC defaults to ../gbrain assuming sibling layout)
 *
 * Refresh discipline (mirrors gbrain D4): when corpus content changes intentionally,
 * include a `Why:` line in the commit body so future maintainers can audit the trail.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const GBRAIN_SRC = process.env.GBRAIN_SRC
  ? resolve(process.env.GBRAIN_SRC)
  : resolve(import.meta.dir, '..', '..', 'gbrain');

// Dynamic imports from the gbrain workspace source. Uses relative file paths
// instead of the `gbrain` package import so the generator works against a
// local checkout (the published `gbrain` npm package follows master and may
// lag behind a development version).
const { PGLiteEngine } = await import(join(GBRAIN_SRC, 'src/core/pglite-engine.ts'));
const { buildBaselineFromInput } = await import(join(GBRAIN_SRC, 'src/commands/bench-publish.ts'));
const { serializeBaselineFile } = await import(join(GBRAIN_SRC, 'src/core/bench/baseline-file.ts'));

// Read the qrels we're generating the matching baseline for.
const QRELS_PATH = resolve(import.meta.dir, '..', 'qrels', 'v0.41-launch.qrels.json');
const qrels: {
  queries: Array<{
    query_id: string;
    query: string;
    embedding_dim: number;
    relevant_slugs: string[];
    first_relevant_slug: string;
  }>;
} = JSON.parse(readFileSync(QRELS_PATH, 'utf-8'));

// We capture via engine.searchKeyword (keyword-only / FTS path) so we
// don't need real vector embeddings. Using a zero-vector placeholder
// matched to the active default dim (1280 for zeroentropy:zembed-1; the
// pre-v0.36 default was 1536). Read from the gateway accessor so future
// dim changes don't break the generator.
async function getActiveDim(): Promise<number> {
  const { configureGateway, getEmbeddingDimensions } = await import(
    join(GBRAIN_SRC, 'src/core/ai/gateway.ts')
  );
  // Configure with empty options so defaults apply.
  configureGateway({});
  return getEmbeddingDimensions();
}

function zeroEmbedding(dim: number): Float32Array {
  return new Float32Array(dim);
}

// Synthesize a chunk_text for a slug. Uses the slug's last segment as the
// primary keyword so searchKeyword (FTS) actually returns the page when
// queried with the query that the qrels says is relevant. The text is
// intentionally generic so the corpus stays placeholder-only.
function synthesizeContent(slug: string, query: string): string {
  const lastSegment = slug.split('/').pop() ?? slug;
  const subject = lastSegment.replace(/-example$/, '').replace(/-/g, ' ');
  // Include both the slug-subject AND a few query keywords so the FTS index
  // surfaces the page on a search for the query terms.
  return `${subject} is a placeholder entity. Context: ${query}. ` +
         `This is hermetic-synthetic content for the v0.41-launch BrainBench gate; ` +
         `every name in this baseline is a placeholder per gbrain privacy rules.`;
}

// Infer the page type from the slug prefix so source-aware ranking has the
// right signal.
function inferType(slug: string): string {
  const prefix = slug.split('/')[0];
  switch (prefix) {
    case 'people': return 'person';
    case 'companies': return 'company';
    case 'concepts': return 'concept';
    case 'topics': return 'concept';
    case 'meetings': return 'meeting';
    case 'events': return 'event';
    case 'writing': return 'writing';
    case 'projects': return 'project';
    case 'tech': return 'tech';
    case 'originals': return 'concept';
    default: return 'concept';
  }
}

async function main(): Promise<void> {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Build the universe of slugs from the qrels (every relevant slug across every query).
  const allSlugs = new Set<string>();
  for (const q of qrels.queries) {
    for (const s of q.relevant_slugs) allSlugs.add(s);
  }
  console.error(`[generate] seeding ${allSlugs.size} placeholder pages…`);

  // Seed every slug with a synthesized chunk + basis-vector embedding.
  // For each slug, pick the first query in qrels that lists it as relevant
  // to give it sensible search-friendly content.
  const slugQueryMap = new Map<string, string>();
  for (const q of qrels.queries) {
    for (const s of q.relevant_slugs) {
      if (!slugQueryMap.has(s)) slugQueryMap.set(s, q.query);
    }
  }

  const activeDim = await getActiveDim();
  console.error(`[generate] active embedding dim = ${activeDim}`);

  for (const slug of allSlugs) {
    const query = slugQueryMap.get(slug)!;
    const text = synthesizeContent(slug, query);
    await engine.putPage(slug, {
      type: inferType(slug),
      title: slug.split('/').pop() ?? slug,
      compiled_truth: text,
      timeline: '',
    });
    await engine.upsertChunks(slug, [
      {
        chunk_index: 0,
        chunk_text: text,
        chunk_source: 'compiled_truth',
        embedding: zeroEmbedding(activeDim),
        token_count: Math.ceil(text.length / 4),
      },
    ]);
  }

  // Now run each qrels query via engine.searchKeyword and capture the
  // result as an EvalCandidateInput row (matches the shape `gbrain eval
  // export` writes for `tool_name: 'search'`).
  console.error(`[generate] running ${qrels.queries.length} captures…`);
  const captured = await Promise.all(
    qrels.queries.map(async (q) => {
      const t0 = Date.now();
      const results = await engine.searchKeyword(q.query);
      const latency = Date.now() - t0;
      return {
        tool_name: 'search' as const,
        query: q.query,
        retrieved_slugs: results.map((r: { slug: string }) => r.slug),
        retrieved_chunk_ids: results.map((r: { chunk_id: number }) => r.chunk_id),
        source_ids: ['default'],
        expand_enabled: null,
        detail: null,
        detail_resolved: null,
        vector_enabled: false,
        expansion_applied: false,
        latency_ms: latency,
        remote: false,
        job_id: null,
        subagent_id: null,
      };
    }),
  );

  // Sanity-check: every capture should have at least one result (else the
  // baseline isn't useful and the gate will report 0 jaccard).
  const empty = captured.filter(c => c.retrieved_slugs.length === 0);
  if (empty.length > 0) {
    console.error(`[generate] WARN: ${empty.length} query(ies) returned 0 results — corpus may be under-seeded`);
    for (const c of empty) console.error(`  - "${c.query}"`);
  }

  // Publish the baseline. Use a deterministic publish timestamp so
  // re-running the generator produces a byte-stable file (only changes
  // when input changes — important for clean git diffs on regen).
  const file = buildBaselineFromInput(captured, {
    label: 'v0.41-launch',
    publishedAt: new Date('2026-05-24T00:00:00.000Z'),
  });

  const outputPath = resolve(import.meta.dir, '..', 'baselines', 'v0.41-launch.baseline.ndjson');
  writeFileSync(outputPath, serializeBaselineFile(file));

  console.error(`[generate] wrote ${outputPath}`);
  console.error(`  label:      ${file.metadata.label}`);
  console.error(`  rows:       ${file.rows.length}`);
  console.error(`  source_hash: ${file.metadata.source_hash}`);
  console.error(`  latency:    ${file.metadata.baseline_mean_latency_ms.toFixed(0)}ms mean`);

  await engine.disconnect();
}

main().catch(err => {
  console.error(`[generate] failed: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

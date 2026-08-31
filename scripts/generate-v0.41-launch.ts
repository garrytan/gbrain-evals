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

// Default to the PINNED install in node_modules — that is what CI has and
// what the baseline gates. GBRAIN_SRC overrides for local gbrain checkouts
// during development.
const GBRAIN_SRC = process.env.GBRAIN_SRC
  ? resolve(process.env.GBRAIN_SRC)
  : resolve(import.meta.dir, '..', 'node_modules', 'gbrain');

// Dynamic imports from the gbrain source tree (relative file paths, because
// bench-publish/baseline-file are not in gbrain's export map).
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

// Synthesize a chunk_text for a slug — LABEL-FAITHFUL (audit data-integrity-02):
// the old version embedded keywords from only the FIRST query listing the
// slug, so a slug labeled relevant to a second query had no matching content
// and its `first_relevant_slug` label was unreachable by ANY retriever
// (4 of 12 top-1 labels could never hit). The qrels define the intended
// world; the corpus generator's job is to make the content match every
// relevance label. The expected top-1 slug additionally carries a doubled
// emphasis of its query's keywords so the top-1 label is content-grounded,
// not an artifact of FTS tie-breaking. Rationale recorded in qrels/README.md.
function synthesizeContent(slug: string, queries: string[], emphasisQuery: string | null): string {
  const lastSegment = slug.split('/').pop() ?? slug;
  const subject = lastSegment.replace(/-example$/, '').replace(/-/g, ' ');
  const contexts = queries.map(q => `Context: ${q}.`).join(' ');
  // The expected top-1 page must carry a DECISIVELY stronger content signal
  // for its query than sibling relevant pages: gbrain's source-boost map
  // multiplies scores by directory (writing/ 1.4 vs concepts/ 1.3 — see
  // gbrain search/source-boost.ts), so a top-1 label on a lower-boost
  // directory only holds when term relevance clearly dominates. That is the
  // right bar for a top-1 label: content-grounded, not tie-break luck
  // (q11: a page titled "retrieval overview" gets free title hits +
  // a higher directory boost for "retrieval augmented generation ...").
  const emphasis = emphasisQuery
    ? ` Primary focus: ${emphasisQuery}. ${subject} leads on ${emphasisQuery}. ` +
      `This is the canonical page for ${emphasisQuery}. Deep notes on ${emphasisQuery} live here.`
    : '';
  return `${subject} is a placeholder entity. ${contexts}${emphasis} ` +
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
  // Content carries keywords from EVERY query that labels the slug relevant
  // (label-faithful), and the query's expected top-1 slug gets emphasized
  // keywords so first_relevant_slug is grounded in content.
  const slugQueriesMap = new Map<string, string[]>();
  const emphasisMap = new Map<string, string>();
  for (const q of qrels.queries) {
    for (const s of q.relevant_slugs) {
      const list = slugQueriesMap.get(s) ?? [];
      list.push(q.query);
      slugQueriesMap.set(s, list);
    }
    if (!emphasisMap.has(q.first_relevant_slug)) {
      emphasisMap.set(q.first_relevant_slug, q.query);
    }
  }

  const activeDim = await getActiveDim();
  console.error(`[generate] active embedding dim = ${activeDim}`);

  for (const slug of [...allSlugs].sort()) {
    const text = synthesizeContent(slug, slugQueriesMap.get(slug)!, emphasisMap.get(slug) ?? null);
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
  console.error(`[generate] running ${qrels.queries.length} captures (serial — honest latencies)…`);
  // SERIAL capture (audit data-integrity-01): the old Promise.all ran all 12
  // queries concurrently on one PGLite, so each row's wall-clock latency
  // included time spent queued behind the other 11 (~6x inflation), which
  // neutered the baseline's latency-regression gate. One warmup query
  // absorbs first-touch costs before timing starts.
  await engine.searchKeyword(qrels.queries[0].query);
  const captured = [] as Array<Record<string, unknown> & { query: string; retrieved_slugs: string[]; latency_ms: number }>;
  for (const q of qrels.queries) {
    const t0 = Date.now();
    const results = await engine.searchKeyword(q.query);
    const latency = Date.now() - t0;
    captured.push({
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
    });
  }

  // Label-reachability check: every query's expected top-1 must actually be
  // retrievable — ideally AT rank 1 — on this corpus. A label no retriever
  // can hit is a broken gate, not a hard benchmark (data-integrity-02).
  const unreachable: string[] = [];
  for (let i = 0; i < qrels.queries.length; i++) {
    const expected = qrels.queries[i].first_relevant_slug;
    const got = captured[i].retrieved_slugs;
    if (got[0] !== expected) {
      unreachable.push(`${qrels.queries[i].query_id}: expected top-1 ${expected}, got ${got[0] ?? '(none)'}`);
    }
  }
  if (unreachable.length > 0) {
    console.error(`[generate] FATAL: ${unreachable.length} first_relevant_slug label(s) not at rank 1 on the reference corpus:`);
    for (const u of unreachable) console.error(`  - ${u}`);
    process.exit(1);
  }

  // Sanity-check: every capture should have at least one result (else the
  // baseline isn't useful and the gate will report 0 jaccard).
  const empty = captured.filter(c => c.retrieved_slugs.length === 0);
  if (empty.length > 0) {
    console.error(`[generate] WARN: ${empty.length} query(ies) returned 0 results — corpus may be under-seeded`);
    for (const c of empty) console.error(`  - "${c.query}"`);
  }

  // ── --check mode: the CI retrieval-regression gate ──────────────────
  // Instead of writing a new baseline, compare this run's captures against
  // the COMMITTED baseline: per-query Jaccard over retrieved slug sets
  // >= 0.85 mean and expected-top1 hit rate >= 0.8 (same thresholds the
  // baseline metadata declares). Hermetic — keyword-only, zero API keys —
  // so `bun scripts/generate-v0.41-launch.ts --check` makes the
  // baselines/README CI claim true on every PR.
  if (process.argv.includes('--check')) {
    const baselinePath = resolve(import.meta.dir, '..', 'baselines', 'v0.41-launch.baseline.ndjson');
    const rows = readFileSync(baselinePath, 'utf8').split('\n').filter(l => l.trim());
    const baselineByQuery = new Map<string, string[]>();
    let thresholds = { jaccard: 0.85, top1: 0.8 };
    for (const line of rows) {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row._kind === 'baseline_metadata') {
        thresholds = { ...thresholds, ...(row.thresholds as typeof thresholds) };
      } else {
        baselineByQuery.set(String(row.query), row.retrieved_slugs as string[]);
      }
    }
    let jaccardSum = 0;
    let top1Hits = 0;
    const problems: string[] = [];
    for (let i = 0; i < qrels.queries.length; i++) {
      const q = qrels.queries[i];
      const now = captured[i].retrieved_slugs;
      const base = baselineByQuery.get(q.query) ?? [];
      const a = new Set(now);
      const b = new Set(base);
      const inter = [...a].filter(x => b.has(x)).length;
      const union = new Set([...a, ...b]).size || 1;
      jaccardSum += inter / union;
      if (now[0] === q.first_relevant_slug) top1Hits++;
      else problems.push(`${q.query_id}: top-1 ${now[0] ?? '(none)'} != expected ${q.first_relevant_slug}`);
    }
    const meanJaccard = jaccardSum / qrels.queries.length;
    const top1Rate = top1Hits / qrels.queries.length;
    console.error(`[gate] mean jaccard vs baseline: ${meanJaccard.toFixed(4)} (threshold ${thresholds.jaccard})`);
    console.error(`[gate] expected-top1 hit rate:   ${top1Rate.toFixed(4)} (threshold ${thresholds.top1})`);
    if (meanJaccard < thresholds.jaccard || top1Rate < thresholds.top1) {
      for (const p of problems) console.error(`  - ${p}`);
      console.error('[gate] FAIL — retrieval regressed vs the committed baseline/qrels.');
      process.exit(1);
    }
    console.error('[gate] PASS');
    await engine.disconnect();
    return;
  }

  // Publish the baseline with a pinned publish timestamp. HONESTY (audit
  // data-integrity-04): regeneration is NOT byte-identical — latency_ms
  // fields are real wall-clock measurements and vary by machine (that is
  // the point of the latency gate). Content rows (slugs, chunk ids, query
  // hashes) ARE deterministic; a regen diff should touch only latency
  // fields and the derived mean.
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

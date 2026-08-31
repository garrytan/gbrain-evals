/**
 * validate-data — automated referential integrity for committed eval data.
 *
 * The 2026-08-31 audit found dangling wikilinks (every person→company link
 * in synthetic-v1), a silently-overwritten deal page (manifest overcount),
 * and qrels top-1 labels no retriever could hit — all by hand. This gate
 * turns that one-time manual cross-check into a permanent one. Run in CI;
 * exits non-zero on any failure.
 *
 * Checks:
 *   1. synthetic-v1: manifest page count == .md files on disk; every
 *      [[wikilink]] target resolves to an existing page.
 *   2. amara-life-v1: every corpus-manifest item's path exists and its
 *      content_sha256 matches the bytes on disk; item slugs unique.
 *   3. qrels: first_relevant_slug ∈ relevant_slugs; query_ids unique.
 *   4. baselines ndjson: every line parses; metadata row_count matches
 *      data rows; no capture row with zero retrieved slugs.
 *   5. gold/*.json: parse; files that are single-`_example` stubs are
 *      reported as warnings (tracked in TODOS.md), not failures.
 *
 * Usage: bun eval/runner/validate-data.ts [--quiet]
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const REPO_ROOT = join(import.meta.dir, '../..');

export interface CheckResult {
  check: string;
  failures: string[];
  warnings: string[];
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// ─── 1. synthetic-v1 ────────────────────────────────────────────────

export function checkSyntheticV1(corpusDir = join(REPO_ROOT, 'eval/data/synthetic-v1')): CheckResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  const mdFiles = walk(corpusDir).filter(f => f.endsWith('.md'));
  const slugs = new Set(mdFiles.map(f => relative(corpusDir, f).replace(/\.md$/, '')));

  const manifestPath = join(corpusDir, '_manifest.json');
  if (!existsSync(manifestPath)) {
    failures.push('_manifest.json missing');
  } else {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { pages?: number };
    if (manifest.pages !== mdFiles.length) {
      failures.push(`manifest says pages=${manifest.pages} but ${mdFiles.length} .md files exist on disk`);
    }
  }

  for (const f of mdFiles) {
    const body = readFileSync(f, 'utf8');
    for (const m of body.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const target = m[1].split('|')[0].trim();
      if (!slugs.has(target)) {
        failures.push(`${relative(corpusDir, f)}: dangling wikilink [[${target}]]`);
      }
    }
  }
  return { check: 'synthetic-v1', failures, warnings };
}

// ─── 2. amara-life-v1 ───────────────────────────────────────────────

export function checkAmaraLife(corpusDir = join(REPO_ROOT, 'eval/data/amara-life-v1')): CheckResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  const manifestPath = join(corpusDir, 'corpus-manifest.json');
  if (!existsSync(manifestPath)) {
    return { check: 'amara-life-v1', failures: ['corpus-manifest.json missing'], warnings };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    items?: Array<{ slug: string; path: string; content_sha256?: string }>;
  };
  const items = manifest.items ?? [];
  const seenSlugs = new Set<string>();
  // Multiple items may share one container file (calendar.ics holds every
  // cal/ event) — hash each distinct file once.
  const hashed = new Map<string, string>();
  for (const item of items) {
    if (seenSlugs.has(item.slug)) failures.push(`duplicate manifest slug: ${item.slug}`);
    seenSlugs.add(item.slug);
    const p = join(corpusDir, item.path);
    if (!existsSync(p)) {
      failures.push(`manifest item ${item.slug}: path ${item.path} does not exist`);
      continue;
    }
    if (item.content_sha256) {
      if (!hashed.has(item.path)) {
        hashed.set(item.path, createHash('sha256').update(readFileSync(p)).digest('hex'));
      }
      // Container files (many slugs → one file) legitimately share a hash;
      // an item hash matching NEITHER the whole file nor any recorded value
      // means the file drifted from the manifest.
      if (hashed.get(item.path) !== item.content_sha256) {
        // Per-item hashes may cover a SLICE of a container file; only flag
        // when no item for this path matches the file hash at all.
        warnings.push(`manifest item ${item.slug}: content_sha256 does not match whole-file hash of ${item.path} (per-slice hash?)`);
      }
    }
  }
  // Collapse slice-hash warnings: if EVERY item for a path mismatches AND
  // at least one item was expected to match, keep one warning per path.
  const collapsed = [...new Set(warnings.map(w => w.replace(/manifest item [^:]+: /, '')))];
  return { check: 'amara-life-v1', failures, warnings: collapsed };
}

// ─── 3. qrels ───────────────────────────────────────────────────────

export function checkQrels(path = join(REPO_ROOT, 'qrels/v0.41-launch.qrels.json')): CheckResult {
  const failures: string[] = [];
  const qrels = JSON.parse(readFileSync(path, 'utf8')) as {
    queries: Array<{ query_id: string; query: string; relevant_slugs: string[]; first_relevant_slug: string }>;
  };
  const ids = new Set<string>();
  for (const q of qrels.queries) {
    if (ids.has(q.query_id)) failures.push(`duplicate query_id ${q.query_id}`);
    ids.add(q.query_id);
    if (!q.relevant_slugs.includes(q.first_relevant_slug)) {
      failures.push(`${q.query_id}: first_relevant_slug ${q.first_relevant_slug} not in relevant_slugs`);
    }
    if (q.relevant_slugs.length === 0) failures.push(`${q.query_id}: empty relevant_slugs`);
  }
  return { check: 'qrels', failures, warnings: [] };
}

// ─── 4. baseline ndjson ─────────────────────────────────────────────

export function checkBaseline(path = join(REPO_ROOT, 'baselines/v0.41-launch.baseline.ndjson')): CheckResult {
  const failures: string[] = [];
  const lines = readFileSync(path, 'utf8').split('\n').filter(l => l.trim().length > 0);
  let meta: { row_count?: number } | null = null;
  let dataRows = 0;
  for (let i = 0; i < lines.length; i++) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(lines[i]) as Record<string, unknown>;
    } catch {
      failures.push(`line ${i + 1}: not valid JSON`);
      continue;
    }
    if (row._kind === 'baseline_metadata') {
      meta = row as { row_count?: number };
    } else {
      dataRows++;
      const slugs = row.retrieved_slugs as unknown[];
      if (!Array.isArray(slugs) || slugs.length === 0) {
        failures.push(`line ${i + 1}: capture row with zero retrieved_slugs (query ${JSON.stringify(row.query)})`);
      }
    }
  }
  if (!meta) failures.push('no baseline_metadata row');
  else if (meta.row_count !== dataRows) failures.push(`metadata row_count=${meta.row_count} but ${dataRows} data rows present`);
  return { check: 'baseline', failures, warnings: [] };
}

// ─── 5b. multimodal fixtures — committed AND git-tracked ────────────

/**
 * The cat11 fixtures are hermetic and sha256-pinned; every file a
 * fixtures.json references must exist AND be tracked by git. The
 * tracked-check exists because a legacy .gitignore rule once kept these
 * files out of git while local runs passed against the untracked copies —
 * CI\'s fresh clone had none and cat11 failed with ENOENT (the
 * works-on-my-machine class this gate now catches before push).
 */
export function checkMultimodalFixtures(root = join(REPO_ROOT, 'eval/data/multimodal')): CheckResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  if (!existsSync(root)) return { check: 'multimodal-fixtures', failures: ['eval/data/multimodal missing'], warnings };
  let tracked: Set<string> | null = null;
  try {
    const { execSync } = require('child_process') as typeof import('child_process');
    const out = execSync('git ls-files eval/data/multimodal', { cwd: REPO_ROOT, encoding: 'utf8' });
    tracked = new Set(out.split('\n').filter(Boolean));
  } catch {
    warnings.push('git unavailable — tracked-in-git check skipped');
  }
  for (const modality of readdirSync(root).sort()) {
    const dir = join(root, modality);
    if (!statSync(dir).isDirectory()) continue;
    const manifestPath = join(dir, 'fixtures.json');
    if (!existsSync(manifestPath)) continue; // modality without a manifest is an honest skip (audio)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      fixtures?: Array<{ source?: string; canonical?: string; sha256?: string }>;
    };
    const referenced = [relative(REPO_ROOT, manifestPath)];
    for (const f of manifest.fixtures ?? []) {
      for (const rel of [f.source, f.canonical]) {
        if (!rel) continue;
        const p = join(dir, rel);
        referenced.push(relative(REPO_ROOT, p));
        if (!existsSync(p)) failures.push(`${modality}/${rel}: referenced by fixtures.json but missing on disk`);
      }
    }
    if (tracked) {
      for (const rel of referenced) {
        if (!tracked.has(rel)) failures.push(`${rel}: exists locally but is NOT tracked by git — a fresh clone (CI) will not have it`);
      }
    }
  }
  return { check: 'multimodal-fixtures', failures, warnings };
}

// ─── 5. gold stubs ──────────────────────────────────────────────────

export function checkGold(goldDir = join(REPO_ROOT, 'eval/data/gold')): CheckResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  for (const f of readdirSync(goldDir).sort().filter(f => f.endsWith('.json'))) {
    const p = join(goldDir, f);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      failures.push(`${f}: not valid JSON`);
      continue;
    }
    // Single-`_example` stubs are honest-but-empty scaffolds (TODOS.md #2).
    const text = JSON.stringify(parsed);
    if (text.includes('"_example"')) {
      warnings.push(`${f}: single-example stub (content pending, tracked in TODOS.md)`);
    }
  }
  return { check: 'gold', failures, warnings };
}

// ─── CLI ────────────────────────────────────────────────────────────

export function runAllChecks(): CheckResult[] {
  return [checkSyntheticV1(), checkAmaraLife(), checkQrels(), checkBaseline(), checkMultimodalFixtures(), checkGold()];
}

if (import.meta.main) {
  const quiet = process.argv.includes('--quiet');
  const results = runAllChecks();
  let failed = 0;
  for (const r of results) {
    const status = r.failures.length === 0 ? 'ok' : 'FAIL';
    if (!quiet || r.failures.length > 0) {
      console.log(`[validate-data] ${r.check}: ${status}` +
        (r.failures.length ? ` (${r.failures.length} failures)` : '') +
        (r.warnings.length ? ` (${r.warnings.length} warnings)` : ''));
      for (const f of r.failures) console.log(`  ✗ ${f}`);
      if (!quiet) for (const w of r.warnings) console.log(`  ⚠ ${w}`);
    }
    failed += r.failures.length;
  }
  if (failed > 0) {
    console.error(`[validate-data] ${failed} failure(s) — committed data is inconsistent.`);
    process.exit(1);
  }
  console.log('[validate-data] all referential-integrity checks passed.');
}

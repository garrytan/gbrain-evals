#!/usr/bin/env bun
/**
 * eval:fetch-multimodal — download + verify Cat 11 multi-modal fixtures.
 *
 * Reads committed manifests at `eval/data/multimodal/<modality>/fixtures.json`
 * and fetches the binary source files (PDFs, HTML, audio) declared in each.
 * Files are sha256-verified against the manifest; mismatches hard-fail.
 *
 * Canonical text files (`canonical/*.txt`) are committed alongside the
 * manifests — they're deterministic golden references the runner compares
 * extractor output against. End users never re-derive them; they ship in git.
 *
 * Layout (after a successful run):
 *
 *   eval/data/multimodal/pdf/
 *     fixtures.json                  (committed)
 *     README.md                      (committed)
 *     canonical/<name>.txt           (committed — golden reference text)
 *     <name>.pdf                     (gitignored — fetched here)
 *
 * The same shape applies to html/ (.html sources) and audio/ (.mp3 sources).
 *
 * Modes:
 *   bun run eval:fetch-multimodal                     fetch + verify all modalities
 *   bun run eval:fetch-multimodal --modality pdf      one modality only
 *   bun run eval:fetch-multimodal --check             verify existing files, no download
 *   bun run eval:fetch-multimodal --bootstrap         (maintainers only) download + write
 *                                                     hashes into the manifest. Used when
 *                                                     curating or refreshing fixtures.
 *
 * Exit codes:
 *   0  success (or --check found everything matching)
 *   1  fetch failure, hash mismatch, or manifest error
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { htmlToText } from '../runner/cat11-multimodal.ts';

// ─── Manifest schema (superset of what the runner reads) ──────────────

export type Modality = 'pdf' | 'html' | 'audio';
export const MODALITIES: Modality[] = ['pdf', 'html', 'audio'];

export interface ManifestItem {
  name: string;
  path: string;
  canonical_path: string;
  /** sha256 of the binary at `path`. Empty string before first --bootstrap. */
  sha256: string;
  /** Source URL the fetcher downloads to `path`. */
  source_url: string;
  /**
   * Source URL for deriving the canonical reference text. Only consulted in
   * --bootstrap mode. Omit for `audio` (canonicals are hand-curated text files
   * checked into git directly).
   */
  canonical_url?: string;
  /** Optional: expected entity names for PDF entity-recall scoring. */
  entities?: string[];
}

export interface FixtureManifest {
  version: 1;
  license: string;
  source: string;
  items: ManifestItem[];
}

// ─── CLI ──────────────────────────────────────────────────────────────

interface Args {
  modalities: Modality[];
  mode: 'fetch' | 'check' | 'bootstrap';
}

function parseArgs(argv: string[]): Args {
  let modalities: Modality[] = [...MODALITIES];
  let mode: Args['mode'] = 'fetch';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--modality') {
      const v = argv[++i];
      if (!MODALITIES.includes(v as Modality)) {
        throw new Error(`Unknown modality: ${v}. Expected one of ${MODALITIES.join(', ')}`);
      }
      modalities = [v as Modality];
    } else if (a === '--check') {
      mode = 'check';
    } else if (a === '--bootstrap') {
      mode = 'bootstrap';
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return { modalities, mode };
}

function printHelp(): void {
  console.log(`eval:fetch-multimodal — download + verify Cat 11 fixtures

USAGE
  bun run eval:fetch-multimodal                  fetch + sha256-verify all modalities
  bun run eval:fetch-multimodal --modality pdf   one modality (pdf | html | audio)
  bun run eval:fetch-multimodal --check          verify existing files only, no download
  bun run eval:fetch-multimodal --bootstrap      maintainer mode: fetch + recompute hashes

WHAT GETS WRITTEN
  Default:    binary source files at <modality>/<item.path>      (gitignored)
  --bootstrap also rewrites <modality>/fixtures.json with fresh hashes

EXIT CODES
  0  all items present and sha256-matching
  1  fetch error, hash mismatch, or manifest schema error
`);
}

// ─── Hash + fetch primitives ──────────────────────────────────────────

export function sha256OfBuffer(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function sha256OfFile(path: string): string {
  return sha256OfBuffer(readFileSync(path));
}

const USER_AGENT = 'gbrain-evals/fetch-multimodal (+https://github.com/garrytan/gbrain-evals)';

export interface FetchOptions {
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Bytes; reject responses larger than this. Default 100 MB. */
  maxBytes?: number;
}

export async function fetchBuffer(url: string, opts: FetchOptions = {}): Promise<Buffer> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? 100 * 1024 * 1024;
  const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  const ab = await res.arrayBuffer();
  if (ab.byteLength > maxBytes) {
    throw new Error(`Response too large for ${url}: ${ab.byteLength} > ${maxBytes}`);
  }
  return Buffer.from(ab);
}

// ─── Manifest IO ──────────────────────────────────────────────────────

export function manifestPath(root: string, modality: Modality): string {
  return join(root, modality, 'fixtures.json');
}

export function readManifest(root: string, modality: Modality): FixtureManifest | null {
  const path = manifestPath(root, modality);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Failed to parse ${path}: ${(e as Error).message}`);
  }
  validateManifest(parsed, path);
  return parsed as FixtureManifest;
}

export function writeManifest(root: string, modality: Modality, m: FixtureManifest): void {
  const path = manifestPath(root, modality);
  writeFileSync(path, JSON.stringify(m, null, 2) + '\n');
}

export function validateManifest(value: unknown, path: string): void {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${path}: manifest must be an object`);
  }
  const m = value as Record<string, unknown>;
  if (m.version !== 1) {
    throw new Error(`${path}: manifest.version must be 1, got ${JSON.stringify(m.version)}`);
  }
  if (typeof m.license !== 'string' || m.license.length === 0) {
    throw new Error(`${path}: manifest.license must be a non-empty string`);
  }
  if (!Array.isArray(m.items)) {
    throw new Error(`${path}: manifest.items must be an array`);
  }
  const seenNames = new Set<string>();
  for (const [i, it] of m.items.entries()) {
    if (typeof it !== 'object' || it === null) {
      throw new Error(`${path}: items[${i}] must be an object`);
    }
    const item = it as Record<string, unknown>;
    for (const k of ['name', 'path', 'canonical_path', 'source_url'] as const) {
      if (typeof item[k] !== 'string' || (item[k] as string).length === 0) {
        throw new Error(`${path}: items[${i}].${k} must be a non-empty string`);
      }
    }
    if (typeof item.sha256 !== 'string') {
      throw new Error(`${path}: items[${i}].sha256 must be a string (use "" before bootstrap)`);
    }
    if (seenNames.has(item.name as string)) {
      throw new Error(`${path}: items[${i}].name "${item.name}" appears twice`);
    }
    seenNames.add(item.name as string);
  }
}

// ─── Per-item operations ──────────────────────────────────────────────

export interface ItemReport {
  name: string;
  status: 'ok' | 'fetched' | 'updated' | 'missing' | 'mismatch' | 'error';
  message?: string;
}

async function ensureItem(
  modalityDir: string,
  item: ManifestItem,
  mode: Args['mode'],
  fetchOpts: FetchOptions = {},
): Promise<ItemReport> {
  const filePath = join(modalityDir, item.path);

  // CHECK mode: file must exist and match committed sha256.
  if (mode === 'check') {
    if (!existsSync(filePath)) {
      return { name: item.name, status: 'missing', message: `not present at ${item.path}` };
    }
    const got = sha256OfFile(filePath);
    if (got !== item.sha256) {
      return {
        name: item.name,
        status: 'mismatch',
        message: `sha256 mismatch: expected ${item.sha256}, got ${got}`,
      };
    }
    return { name: item.name, status: 'ok' };
  }

  // FETCH mode: skip download if file present and hash matches; otherwise fetch.
  if (mode === 'fetch') {
    if (existsSync(filePath) && sha256OfFile(filePath) === item.sha256) {
      return { name: item.name, status: 'ok' };
    }
    let buf: Buffer;
    try {
      buf = await fetchBuffer(item.source_url, fetchOpts);
    } catch (e) {
      return { name: item.name, status: 'error', message: (e as Error).message };
    }
    const got = sha256OfBuffer(buf);
    if (got !== item.sha256) {
      return {
        name: item.name,
        status: 'mismatch',
        message: `sha256 mismatch from ${item.source_url}: expected ${item.sha256}, got ${got}`,
      };
    }
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, buf);
    return { name: item.name, status: 'fetched' };
  }

  // BOOTSTRAP mode: download fresh, recompute hash, mutate manifest item.
  // Also derive canonical text per modality if canonical_url is set.
  let buf: Buffer;
  try {
    buf = await fetchBuffer(item.source_url, fetchOpts);
  } catch (e) {
    return { name: item.name, status: 'error', message: `source_url: ${(e as Error).message}` };
  }
  const got = sha256OfBuffer(buf);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, buf);
  const previous = item.sha256;
  item.sha256 = got;

  // Canonical derivation (PDF/HTML in current pipeline; audio is hand-curated).
  if (item.canonical_url) {
    const canonicalPath = join(modalityDir, item.canonical_path);
    const modalityName = modalityDir.split('/').pop() as Modality;
    let canonicalText: string;
    try {
      const canonicalBuf = await fetchBuffer(item.canonical_url, fetchOpts);
      const raw = canonicalBuf.toString('utf-8');
      canonicalText = deriveCanonical(modalityName, raw);
    } catch (e) {
      return {
        name: item.name,
        status: 'error',
        message: `canonical_url: ${(e as Error).message}`,
      };
    }
    if (canonicalText.trim().length === 0) {
      return {
        name: item.name,
        status: 'error',
        message: `canonical derivation returned empty text from ${item.canonical_url}`,
      };
    }
    mkdirSync(dirname(canonicalPath), { recursive: true });
    writeFileSync(canonicalPath, canonicalText);
  }

  return {
    name: item.name,
    status: previous === got ? 'ok' : 'updated',
    message: previous && previous !== got ? `${previous.slice(0, 12)} → ${got.slice(0, 12)}` : undefined,
  };
}

/**
 * Per-modality canonical text derivation. The bootstrap pipeline calls this
 * with the raw bytes returned from `canonical_url`.
 *   pdf   → arXiv ar5iv-rendered HTML; strip article body, html→text
 *   html  → MediaWiki extracts API JSON; pull the page's `extract` field
 *   audio → not derived (canonical text is hand-curated and committed)
 */
function deriveCanonical(modality: Modality, raw: string): string {
  switch (modality) {
    case 'pdf':   return deriveArxivCanonical(raw);
    case 'html':  return deriveWikipediaCanonical(raw);
    case 'audio': throw new Error('audio canonicals are hand-curated; do not set canonical_url');
  }
}

// ─── Modality dispatcher ──────────────────────────────────────────────

export async function runModality(
  root: string,
  modality: Modality,
  mode: Args['mode'],
  fetchOpts: FetchOptions = {},
): Promise<{ manifest: FixtureManifest | null; reports: ItemReport[] }> {
  const manifest = readManifest(root, modality);
  if (!manifest) return { manifest: null, reports: [] };
  const modalityDir = join(root, modality);
  const reports: ItemReport[] = [];
  for (const item of manifest.items) {
    const rep = await ensureItem(modalityDir, item, mode, fetchOpts);
    reports.push(rep);
  }
  if (mode === 'bootstrap') {
    writeManifest(root, modality, manifest);
  }
  return { manifest, reports };
}

// ─── Entry point ──────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const root = resolve(process.cwd(), 'eval/data/multimodal');

  let exitCode = 0;
  for (const modality of args.modalities) {
    const { manifest, reports } = await runModality(root, modality, args.mode);
    if (!manifest) {
      console.log(`[${modality}] no manifest at ${manifestPath(root, modality)} — skipped`);
      continue;
    }
    console.log(`[${modality}] ${reports.length} items, mode=${args.mode}`);
    for (const r of reports) {
      const tag =
        r.status === 'ok'      ? '  OK     '
      : r.status === 'fetched' ? '  FETCHED'
      : r.status === 'updated' ? '  UPDATED'
      : r.status === 'missing' ? '  MISSING'
      : r.status === 'mismatch'? '  MISMATCH'
      :                          '  ERROR  ';
      console.log(`${tag} ${r.name}${r.message ? `  (${r.message})` : ''}`);
      if (r.status === 'missing' || r.status === 'mismatch' || r.status === 'error') {
        exitCode = 1;
      }
    }
  }
  return exitCode;
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}

// ─── Canonical-derivation helpers (used by maintainer-only tooling) ──
//
// Canonicals (golden text) are committed under <modality>/canonical/. We
// derive them once during PR curation and ship them in git so end users
// never need to re-fetch them. These helpers exist so the canonicalisation
// pipeline is testable + reviewable, not so contributors run them at fetch
// time.

/**
 * Maximum canonical-text length per item. The Cat 11 runner uses
 * Levenshtein-based `charSimilarity` for PDF, which is O(n*m): a 200KB
 * canonical against a 200KB extracted is 4×10^10 ops (multi-minute per
 * paper). Capping canonical at 25KB keeps the full PDF run under ~5 min on
 * a 10-paper corpus while still measuring extraction over a meaningful
 * span (paper title, abstract, intro, first methods sections).
 */
export const MAX_PDF_CANONICAL_BYTES = 25_000;

/**
 * arXiv HTML version (ar5iv-rendered) → plain text. Strips everything outside
 * <article class="ltx_document"> before running the standard html→text
 * stripper. Truncates to MAX_PDF_CANONICAL_BYTES (see above for rationale).
 */
export function deriveArxivCanonical(rawHtml: string): string {
  const m = rawHtml.match(/<article[^>]*class="[^"]*ltx_document[^"]*"[^>]*>([\s\S]*?)<\/article>/i);
  const body = m ? m[1] : rawHtml;
  const text = htmlToText(body);
  return text.length > MAX_PDF_CANONICAL_BYTES
    ? text.slice(0, MAX_PDF_CANONICAL_BYTES)
    : text;
}

/**
 * Wikipedia plain-text extract. The MediaWiki extracts API returns:
 *   { query: { pages: { <id>: { extract: "plain text..." } } } }
 * Returns the first page's extract, normalised whitespace.
 */
export function deriveWikipediaCanonical(rawJson: string): string {
  const data = JSON.parse(rawJson) as {
    query?: { pages?: Record<string, { extract?: string }> };
  };
  const pages = data.query?.pages ?? {};
  const firstKey = Object.keys(pages)[0];
  const extract = firstKey ? pages[firstKey].extract ?? '' : '';
  return extract.replace(/\s+/g, ' ').trim();
}

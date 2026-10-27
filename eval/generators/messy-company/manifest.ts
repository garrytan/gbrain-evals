#!/usr/bin/env bun
/**
 * messy-company-v1 freeze manifest.
 *
 *   bun eval/generators/messy-company/manifest.ts write   # writes eval/data/messy-company-v1/MANIFEST.json
 *   bun eval/generators/messy-company/manifest.ts check   # exits 1 if any data file differs from the manifest
 *
 * The manifest lists the sha256 and size of every data file (corpus, labels,
 * plan, prompts, raw model transcripts, verification, cost ledger), so a run
 * can name the exact dataset it used. The documentation files at the dataset
 * root (README.md, SCORING.md, USES.md) are outside it, so they can gain
 * changelog entries without changing the data hash. The frozen dataset hash is
 * the sha256 of MANIFEST.json itself.
 */
import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, relative } from 'path';

export const DATASET_DIR = join(import.meta.dir, '../../data/messy-company-v1');
export const DATA_DIRS = ['corpus', 'labels', 'plan', 'prompts', 'raw', 'verification', 'cost'];

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir).sort()) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export interface ManifestFile { path: string; sha256: string; bytes: number }
export interface Manifest { dataset: 'messy-company-v1'; hash_scheme: string; files: ManifestFile[]; counts: Record<string, unknown>; data_sha256: string }

const lineCount = (f: string) => readFileSync(f, 'utf8').split('\n').filter(Boolean).length;

export function buildManifest(root = DATASET_DIR): Manifest {
  const files = DATA_DIRS.flatMap(d => walk(join(root, d))).map(f => {
    const b = readFileSync(f);
    return { path: relative(root, f), sha256: sha256(b), bytes: b.length };
  });
  const pages = (s: string) => files.filter(f => f.path.startsWith(`corpus/${s}/`) && f.path.endsWith('.md')).length;
  const labels: Record<string, Record<string, number>> = {};
  for (const lane of readdirSync(join(root, 'labels')).sort()) {
    labels[lane] = Object.fromEntries(['dev', 'heldout'].map(s => [s, lineCount(join(root, 'labels', lane, `${s}.jsonl`))]));
  }
  return {
    dataset: 'messy-company-v1',
    hash_scheme: 'sha256 of each file\'s bytes; data_sha256 is sha256 over "<sha256>  <path>\\n" lines in path order; the dataset hash is sha256 of this file',
    files,
    counts: { pages: { dev: pages('dev'), heldout: pages('heldout') }, labels },
    data_sha256: sha256(files.map(f => `${f.sha256}  ${f.path}\n`).join('')),
  };
}

export function checkManifest(root = DATASET_DIR): string[] {
  const f = join(root, 'MANIFEST.json');
  if (!existsSync(f)) return ['MANIFEST.json is missing'];
  const want = JSON.parse(readFileSync(f, 'utf8')) as Manifest;
  const have = buildManifest(root);
  const problems: string[] = [];
  const byPath = new Map(have.files.map(x => [x.path, x]));
  for (const w of want.files) {
    const h = byPath.get(w.path);
    if (!h) problems.push(`missing: ${w.path}`);
    else if (h.sha256 !== w.sha256) problems.push(`changed: ${w.path}`);
  }
  const listed = new Set(want.files.map(x => x.path));
  for (const h of have.files) if (!listed.has(h.path)) problems.push(`not in manifest: ${h.path}`);
  if (!problems.length && have.data_sha256 !== want.data_sha256) problems.push('data_sha256 does not match the file list');
  return problems;
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === 'write') {
    const m = buildManifest();
    const text = JSON.stringify(m, null, 2) + '\n';
    writeFileSync(join(DATASET_DIR, 'MANIFEST.json'), text);
    console.log(`files=${m.files.length} data_sha256=${m.data_sha256}\nMANIFEST.json sha256=${sha256(text)}`);
  } else if (cmd === 'check') {
    const p = checkManifest();
    const text = readFileSync(join(DATASET_DIR, 'MANIFEST.json'));
    if (p.length) { for (const x of p.slice(0, 50)) console.log(`  ✗ ${x}`); console.log(`${p.length} problem(s)`); process.exit(1); }
    console.log(`ok; MANIFEST.json sha256=${sha256(text)}`);
  } else {
    console.error('usage: manifest.ts write|check');
    process.exit(2);
  }
}

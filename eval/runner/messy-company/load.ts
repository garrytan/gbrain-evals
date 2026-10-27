#!/usr/bin/env bun
/**
 * Load a messy-company-v1 split into a fresh gbrain brain (PGLite).
 *
 *   bun eval/runner/messy-company/load.ts --split dev|heldout|all [--db <dir>] [--public-only] [--json]
 *
 * Imports every Markdown page under eval/data/messy-company-v1/corpus/<split>/
 * through gbrain's own `importFromContent` (no embeddings, so no API key is
 * needed), with the page path as the slug. `--db` keeps the brain on disk;
 * without it the brain lives in memory and is discarded. `--public-only`
 * skips `visibility: private` pages. The loader reads pages only, never
 * labels, so a system under test cannot see gold through it.
 *
 * This is the loader smoke the dataset ships with. It runs no gbrain feature
 * beyond import and a read-back of each page.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';

export const DATASET_DIR = join(import.meta.dir, '../../data/messy-company-v1');
export type SplitName = 'dev' | 'heldout';

export interface CorpusPage { slug: string; split: SplitName; path: string; content: string; private: boolean }

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir).sort()) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (e.endsWith('.md')) out.push(full);
  }
  return out;
}

export function readSplit(split: SplitName | 'all', root = DATASET_DIR): CorpusPage[] {
  const splits: SplitName[] = split === 'all' ? ['dev', 'heldout'] : [split];
  const pages: CorpusPage[] = [];
  for (const s of splits) {
    const dir = join(root, 'corpus', s);
    if (!existsSync(dir)) throw new Error(`missing corpus directory ${dir}`);
    for (const path of walk(dir)) {
      const content = readFileSync(path, 'utf8');
      const fm = /^---\n([\s\S]*?)\n---\n/.exec(content)?.[1] ?? '';
      pages.push({ slug: relative(dir, path).replace(/\.md$/, ''), split: s, path, content, private: /^visibility:\s*private\s*$/m.test(fm) });
    }
  }
  const seen = new Set<string>();
  for (const p of pages) {
    if (seen.has(p.slug)) throw new Error(`slug ${p.slug} appears in more than one split`);
    seen.add(p.slug);
  }
  return pages;
}

export interface LoadReport { split: string; pages: number; imported: number; skipped_private: number; errors: { slug: string; error: string }[]; read_back_ok: number }

export async function loadSplit(split: SplitName | 'all', opts: { db?: string; publicOnly?: boolean; engine?: PGLiteEngine; quiet?: boolean } = {}): Promise<{ engine: PGLiteEngine; report: LoadReport }> {
  const pages = readSplit(split);
  const engine = opts.engine ?? new PGLiteEngine();
  if (!opts.engine) {
    await engine.connect(opts.db ? { database_path: opts.db } : {});
    await engine.initSchema();
  }
  const report: LoadReport = { split, pages: pages.length, imported: 0, skipped_private: 0, errors: [], read_back_ok: 0 };
  const origLog = console.log;
  if (opts.quiet !== false) console.log = () => {};
  try {
    for (const p of pages) {
      if (opts.publicOnly && p.private) { report.skipped_private++; continue; }
      try {
        const r = await importFromContent(engine, p.slug, p.content, { noEmbed: true });
        if ((r as { status?: string }).status === 'error') report.errors.push({ slug: p.slug, error: String((r as { error?: unknown }).error ?? 'error') });
        else report.imported++;
      } catch (e) {
        report.errors.push({ slug: p.slug, error: (e as Error).message });
      }
    }
    for (const p of pages) {
      if (opts.publicOnly && p.private) continue;
      const got = await engine.getPage(p.slug);
      if (got) report.read_back_ok++;
    }
  } finally {
    console.log = origLog;
  }
  return { engine, report };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const val = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const split = (val('--split') ?? 'dev') as SplitName | 'all';
  if (!['dev', 'heldout', 'all'].includes(split)) { console.error('--split must be dev, heldout or all'); process.exit(2); }
  const { engine, report } = await loadSplit(split, { db: val('--db'), publicOnly: args.includes('--public-only') });
  await engine.disconnect();
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`[messy-company] split=${report.split} pages=${report.pages} imported=${report.imported} skipped_private=${report.skipped_private} read_back=${report.read_back_ok} errors=${report.errors.length}`);
    for (const e of report.errors) console.log(`  ✗ ${e.slug}: ${e.error}`);
  }
  process.exit(report.errors.length ? 1 : 0);
}

/**
 * Shared gbrain bug ledger for the eval-category wave (plan section 8,
 * amendment 10).
 *
 * Every finding a category makes about gbrain goes here, classified against
 * a stated contract:
 *   bug              gbrain breaks a contract it states; gets a minimal repro
 *                    and a fix in the single fix-wave PR;
 *   feature-gap      gbrain does not claim the capability (see the capability
 *                    matrix); stays listed, never "fixed" to match a category;
 *   category-defect  the category's gold, scorer or harness was wrong; fixed in
 *                    gbrain-evals with an erratum, never in gbrain.
 *
 * The JSON file is the record; the Markdown view is rendered from it.
 *
 *   bun eval/runner/bug-ledger.ts validate [ledger.json]
 *   bun eval/runner/bug-ledger.ts render [ledger.json] [--out view.md]
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export const WAVE_BUG_LEDGER = 'docs/benchmarks/2026-10-01-wave-bugs.json';

export const BUG_CLASSIFICATIONS = ['bug', 'feature-gap', 'category-defect'] as const;
export const BUG_STATUSES = ['open', 'fixed', 'deferred', 'not-a-bug'] as const;

export interface BugEntry {
  /** Stable id: `<category alias>-<n>`, e.g. N5-1. */
  id: string;
  /** Registry id or legacy alias of the category that found it. */
  category: string;
  classification: typeof BUG_CLASSIFICATIONS[number];
  /** The contract broken, in one sentence with its source (doc, op description, file:line). */
  contract: string;
  /** Full 40-character gbrain commit the repro fails on. */
  gbrain_sha: string;
  /** Operation name or file:line under test. */
  surface: string;
  /** Repository-root command that reproduces it. */
  repro: string;
  expected: string;
  actual: string;
  status: typeof BUG_STATUSES[number];
  /** Required when deferred or not-a-bug. */
  reason?: string;
  /** Required when fixed: the gbrain PR URL or number. */
  fixing_pr?: string;
}

export interface BugLedger { schema_version: 1; entries: BugEntry[] }

const nonEmpty = (v: unknown) => typeof v === 'string' && v.trim().length > 0;

export function validateBugEntry(e: unknown): string[] {
  if (!e || typeof e !== 'object') return ['entry is not an object'];
  const b = e as Record<string, unknown>;
  const id = typeof b.id === 'string' ? b.id : '?';
  const v: string[] = [];
  for (const k of ['id', 'category', 'contract', 'surface', 'repro', 'expected', 'actual'] as const) if (!nonEmpty(b[k])) v.push(`${id}: ${k} is required`);
  if (nonEmpty(b.id) && !/^[A-Za-z0-9]+(-[A-Za-z0-9]+)*-\d+$/.test(b.id as string)) v.push(`${id}: id must look like <category>-<n>`);
  if (typeof b.gbrain_sha !== 'string' || !/^[0-9a-f]{40}$/.test(b.gbrain_sha)) v.push(`${id}: gbrain_sha must be a full 40-character commit`);
  if (!BUG_CLASSIFICATIONS.includes(b.classification as never)) v.push(`${id}: classification must be one of ${BUG_CLASSIFICATIONS.join('|')}`);
  if (!BUG_STATUSES.includes(b.status as never)) v.push(`${id}: status must be one of ${BUG_STATUSES.join('|')}`);
  if ((b.status === 'deferred' || b.status === 'not-a-bug') && !nonEmpty(b.reason)) v.push(`${id}: a ${b.status} entry needs a reason`);
  if (b.status === 'fixed' && !nonEmpty(b.fixing_pr)) v.push(`${id}: a fixed entry needs fixing_pr`);
  if (b.status === 'fixed' && b.classification !== 'bug') v.push(`${id}: only a bug can be fixed in gbrain; a ${String(b.classification)} is deferred, not-a-bug or open`);
  return v;
}

export function validateBugLedger(ledger: unknown): string[] {
  const l = ledger as Partial<BugLedger> | null;
  if (!l || l.schema_version !== 1 || !Array.isArray(l.entries)) return ['ledger must be { schema_version: 1, entries: [] }'];
  const v = l.entries.flatMap(validateBugEntry);
  const seen = new Set<string>();
  for (const e of l.entries) {
    if (seen.has(e.id)) v.push(`${e.id}: duplicate id`);
    seen.add(e.id);
  }
  return v;
}

export function readBugLedger(path: string = WAVE_BUG_LEDGER): BugLedger {
  if (!existsSync(path)) return { schema_version: 1, entries: [] };
  const ledger = JSON.parse(readFileSync(path, 'utf8')) as BugLedger;
  const v = validateBugLedger(ledger);
  if (v.length) throw new Error(`invalid bug ledger ${path}:\n  ${v.join('\n  ')}`);
  return ledger;
}

/** Validate and add one entry, or replace the entry with the same id (status changes). */
export function upsertBug(entry: BugEntry, path: string = WAVE_BUG_LEDGER): BugLedger {
  const v = validateBugEntry(entry);
  if (v.length) throw new Error(`invalid bug entry:\n  ${v.join('\n  ')}`);
  const ledger = readBugLedger(path);
  const entries = [...ledger.entries.filter(e => e.id !== entry.id), entry].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  const next: BugLedger = { schema_version: 1, entries };
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  renameSync(tmp, path);
  return next;
}

const cell = (s: string | undefined) => (s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderBugLedgerMarkdown(ledger: BugLedger): string {
  const count = (pred: (e: BugEntry) => boolean) => ledger.entries.filter(pred).length;
  const lines = [
    '# gbrain findings from the eval-category wave',
    '',
    `Rendered from \`${WAVE_BUG_LEDGER}\` by \`bun eval/runner/bug-ledger.ts render\`; edit the JSON, not this file.`,
    '',
    `${ledger.entries.length} findings: ${count(e => e.classification === 'bug')} bugs (${count(e => e.classification === 'bug' && e.status === 'fixed')} fixed), `
      + `${count(e => e.classification === 'feature-gap')} feature gaps, ${count(e => e.classification === 'category-defect')} category defects.`,
    '',
    '| Id | Category | Kind | Status | Surface | Expected | Actual | Repro | Fix or reason |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const e of ledger.entries) {
    lines.push(`| ${e.id} | ${cell(e.category)} | ${e.classification} | ${e.status} | \`${cell(e.surface)}\` | ${cell(e.expected)} | ${cell(e.actual)} | \`${cell(e.repro)}\` | ${cell(e.fixing_pr ?? e.reason)} |`);
  }
  return lines.join('\n') + '\n';
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const outAt = argv.indexOf('--out');
  const [command, file = WAVE_BUG_LEDGER] = argv.filter((_, i) => outAt < 0 || (i !== outAt && i !== outAt + 1));
  if (command === 'validate') {
    readBugLedger(file);
    console.log(`${file}: valid`);
  } else if (command === 'render') {
    const md = renderBugLedgerMarkdown(readBugLedger(file));
    if (outAt >= 0) writeFileSync(argv[outAt + 1], md);
    else process.stdout.write(md);
  } else {
    console.error('usage: bun eval/runner/bug-ledger.ts validate|render [ledger.json] [--out view.md]');
    process.exit(2);
  }
}

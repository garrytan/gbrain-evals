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
 * Status changes never rewrite the original finding: `gbrain_sha`, `expected`
 * and `actual` stay as found. A later check adds `review` (the date, the gbrain
 * commit checked and the evidence), and a fix adds `fixing_pr` and
 * `fixing_commit`. A feature gap or category defect that gbrain closes on
 * purpose becomes `closed`, never `fixed`. A newer review moves the previous
 * one to `review_history` (oldest first), so dated reviews are never lost.
 *
 *   bun eval/runner/bug-ledger.ts validate [ledger.json]
 *   bun eval/runner/bug-ledger.ts render [ledger.json] [--out view.md]
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export const WAVE_BUG_LEDGER = 'docs/benchmarks/2026-10-01-wave-bugs.json';

export const BUG_CLASSIFICATIONS = ['bug', 'feature-gap', 'category-defect'] as const;
export const BUG_STATUSES = ['open', 'fixed', 'deferred', 'not-a-bug', 'closed'] as const;
/**
 * How a review established an entry's status:
 *   rerun          the category and the entry's repro were run at review.gbrain_sha;
 *   upstream-only  gbrain says it fixed the entry, but nothing here re-ran it;
 *   not-rechecked  the status is carried forward without a run at review.gbrain_sha.
 */
export const REVIEW_EVIDENCE = ['rerun', 'upstream-only', 'not-rechecked'] as const;

export interface BugReview {
  /** ISO date of the review. */
  date: string;
  /** Full 40-character gbrain commit the status refers to. */
  gbrain_sha: string;
  evidence: typeof REVIEW_EVIDENCE[number];
  /** Repository paths of the receipts or repro output behind a rerun. */
  receipts?: string[];
  /** What the rerun showed, in one or two sentences. */
  note?: string;
}

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
  /** Full 40-character gbrain commit that carries the fix, reachable from the reviewed commit. */
  fixing_commit?: string;
  /** Latest status review; see BugReview. */
  review?: BugReview;
  /** Earlier reviews, oldest first, each kept as written. */
  review_history?: BugReview[];
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
  if (b.status === 'fixed' && b.classification !== 'bug') v.push(`${id}: only a bug can be fixed in gbrain; a ${String(b.classification)} is deferred, not-a-bug, closed or open`);
  if (b.status === 'closed' && b.classification === 'bug') v.push(`${id}: a bug is fixed, not closed`);
  if (b.status === 'closed' && (!nonEmpty(b.reason) || !nonEmpty(b.fixing_pr))) v.push(`${id}: a closed entry needs a reason and fixing_pr`);
  if (b.fixing_commit !== undefined && (typeof b.fixing_commit !== 'string' || !/^[0-9a-f]{40}$/.test(b.fixing_commit))) v.push(`${id}: fixing_commit must be a full 40-character commit`);
  const checkReview = (value: unknown, at: string) => {
    const r = value as Record<string, unknown> | null;
    if (!r || typeof r !== 'object') { v.push(`${id}: ${at} must be an object`); return; }
    if (typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) v.push(`${id}: ${at}.date must be YYYY-MM-DD`);
    if (typeof r.gbrain_sha !== 'string' || !/^[0-9a-f]{40}$/.test(r.gbrain_sha)) v.push(`${id}: ${at}.gbrain_sha must be a full 40-character commit`);
    if (!REVIEW_EVIDENCE.includes(r.evidence as never)) v.push(`${id}: ${at}.evidence must be one of ${REVIEW_EVIDENCE.join('|')}`);
    if (r.evidence === 'rerun' && (!Array.isArray(r.receipts) || r.receipts.length === 0)) v.push(`${id}: a rerun review names its receipts`);
  };
  if (b.review !== undefined) checkReview(b.review, 'review');
  if (b.review_history !== undefined) {
    if (!Array.isArray(b.review_history)) v.push(`${id}: review_history must be an array`);
    else {
      b.review_history.forEach((r, i) => checkReview(r, `review_history[${i}]`));
      if (b.review === undefined && b.review_history.length) v.push(`${id}: review_history needs a current review`);
      const dates = [...(b.review_history as Array<{ date?: unknown }>), b.review as { date?: unknown } | undefined].map(r => String(r?.date ?? ''));
      if (dates.some((d, i) => i > 0 && d < dates[i - 1])) v.push(`${id}: reviews must be in date order, oldest first`);
    }
  }
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
const short = (sha: string | undefined) => (sha ? sha.slice(0, 8) : '');
const EVIDENCE_LABEL: Record<BugReview['evidence'], string> = { rerun: 'verified by rerun', 'upstream-only': 'fixed upstream, not re-verified', 'not-rechecked': 'not rechecked' };
function reviewCell(e: BugEntry): string {
  if (!e.review) return '';
  const label = e.status === 'fixed' || e.status === 'closed' || e.review.evidence !== 'rerun' ? EVIDENCE_LABEL[e.review.evidence] : 'still reproduces at rerun';
  return cell(`${e.review.date} at ${short(e.review.gbrain_sha)}: ${label}${e.review.note ? `. ${e.review.note}` : ''}`);
}

export function renderBugLedgerMarkdown(ledger: BugLedger): string {
  const count = (pred: (e: BugEntry) => boolean) => ledger.entries.filter(pred).length;
  const lines = [
    '# gbrain findings from the eval-category wave',
    '',
    `Rendered from \`${WAVE_BUG_LEDGER}\` by \`bun eval/runner/bug-ledger.ts render\`; edit the JSON, not this file.`,
    '',
    `${ledger.entries.length} findings: ${count(e => e.classification === 'bug')} bugs (${count(e => e.classification === 'bug' && e.status === 'fixed')} fixed), `
      + `${count(e => e.classification === 'feature-gap')} feature gaps, ${count(e => e.classification === 'category-defect')} category defects.`,
  ];
  const reviewed = ledger.entries.filter(e => e.review);
  if (reviewed.length) {
    const fixed = (ev: BugReview['evidence']) => count(e => e.status === 'fixed' && e.review?.evidence === ev);
    const dates = [...new Set(reviewed.map(e => e.review!.date))].sort().join(', ');
    lines.push('', `Reviewed ${dates}: ${fixed('rerun')} bugs fixed and verified by a rerun, ${fixed('upstream-only')} fixed upstream but not re-verified, `
      + `${count(e => e.classification === 'bug' && e.status === 'open')} bugs still open, ${count(e => e.status === 'closed')} gaps or defects closed by gbrain. `
      + 'Expected, actual and the first gbrain commit describe the finding as found; the last column describes the latest review.');
  }
  lines.push(
    '',
    '| Id | Category | Kind | Status | Surface | Expected | Actual | Repro | Fix or reason | Fix commit | Latest review |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const e of ledger.entries) {
    const fix = [e.fixing_pr, e.reason].filter(nonEmpty).join('; ');
    lines.push(`| ${e.id} | ${cell(e.category)} | ${e.classification} | ${e.status} | \`${cell(e.surface)}\` | ${cell(e.expected)} | ${cell(e.actual)} | \`${cell(e.repro)}\` | ${cell(fix)} | ${short(e.fixing_commit)} | ${reviewCell(e)} |`);
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

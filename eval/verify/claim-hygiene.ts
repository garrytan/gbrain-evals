/**
 * claim-hygiene — retired figures stay retired, qualified figures stay
 * qualified, on every surface a visitor can land on.
 *
 * Rules are data (docs/claim-hygiene.json): a regex for the figure, whether
 * it is `retired` (must not appear) or `qualified` (must appear with its
 * qualifier in the same table row or paragraph), and a severity.
 *
 *   - live surfaces (README.md, docs/comparison-systems.md) enforce every
 *     rule at the rule's severity — issue #26 gap 5 (PMB 0.582 without the
 *     upper-bound qualifier; 0.076 where the report said 0.075)
 *   - historical reports (docs/benchmarks/*.md) that still print a retired
 *     or unqualified figure must carry an erratum/correction banner within
 *     the first N lines (banner.severity when they don't)
 *   - `--ref <git-ref>` runs the same rules on the surfaces AT THAT REF
 *     (`git show`), and `--sweep` runs the live-surface rules on README.md
 *     at every remote branch and (after `--fetch-prs`) every open PR head —
 *     issue #26 gap 3, the stale branch/PR READMEs a visitor can be linked
 *     to. Sweep hits are warnings unless --fail-on-stale.
 *
 * "Same row or paragraph": a line starting with `|` is a table row and is
 * its own unit; any other line's unit is the blank-line-delimited paragraph
 * around it. Number-in-a-sentence, qualifier-two-sentences-later still
 * counts; qualifier-in-a-different-section does not.
 *
 * Keyless, $0. No network except `--fetch-prs` (git fetch of public refs).
 *
 * Usage:
 *   bun eval/verify/claim-hygiene.ts [--root <dir>] [--rules <json>] [--quiet] [--strict] [--json]
 *   bun eval/verify/claim-hygiene.ts --ref origin/phoenix-v1
 *   bun eval/verify/claim-hygiene.ts --sweep [--fetch-prs] [--fail-on-stale]
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  REPO_ROOT,
  gitShow,
  parseArgs,
  rel,
  runCli,
  walk,
  type CheckReport,
  type Finding,
  type Severity,
} from './lib.ts';

export const CHECK = 'claim-hygiene';

export interface Rule {
  id: string;
  pattern: string;
  kind: 'retired' | 'qualified';
  qualifier?: string;
  severity: Severity;
  note?: string;
}

export interface RulesFile {
  schema_version: number;
  live_surfaces: string[];
  reports_dir: string;
  banner: { pattern: string; within_lines: number; severity: Severity; note?: string };
  rules: Rule[];
}

export function loadRules(path: string): RulesFile {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as RulesFile;
  if (parsed.schema_version !== 1) throw new Error(`claim-hygiene rules: unsupported schema_version ${parsed.schema_version}`);
  for (const r of parsed.rules) {
    if (r.kind === 'qualified' && !r.qualifier) throw new Error(`rule ${r.id}: kind=qualified needs a qualifier`);
    new RegExp(r.pattern); // throws on a bad regex at load time, not mid-scan
    if (r.qualifier) new RegExp(r.qualifier);
  }
  return parsed;
}

const isRow = (l: string): boolean => l.trimStart().startsWith('|');

/**
 * The unit of context for a line. A table row's unit is the row itself plus
 * the table's header row and the paragraph immediately above the table (a
 * column named recall_any@k, or a lead-in sentence naming the variant,
 * qualifies every row beneath it). Any other line's unit is its
 * blank-line-delimited paragraph.
 */
export function unitAround(lines: string[], i: number): string {
  if (isRow(lines[i])) {
    let start = i;
    while (start > 0 && isRow(lines[start - 1])) start--;
    let p = start - 1;
    while (p >= 0 && lines[p].trim() === '') p--;
    let pre = '';
    if (p >= 0 && !isRow(lines[p])) {
      const end = p;
      while (p > 0 && lines[p - 1].trim() !== '' && !isRow(lines[p - 1])) p--;
      pre = lines.slice(p, end + 1).join('\n');
    }
    return [pre, lines[start], lines[i]].join('\n');
  }
  let a = i;
  while (a > 0 && lines[a - 1].trim() !== '') a--;
  let b = i;
  while (b + 1 < lines.length && lines[b + 1].trim() !== '') b++;
  return lines.slice(a, b + 1).join('\n');
}

export interface Hit {
  rule: Rule;
  line: number;
  excerpt: string;
}

/** Every rule violation in a text. Pure; no severity decisions here. */
export function findHits(text: string, rules: Rule[]): Hit[] {
  const lines = text.split('\n');
  const hits: Hit[] = [];
  for (const rule of rules) {
    const re = new RegExp(rule.pattern);
    const q = rule.qualifier ? new RegExp(rule.qualifier, 'i') : null;
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      if (rule.kind === 'qualified' && q && q.test(unitAround(lines, i))) continue;
      hits.push({ rule, line: i + 1, excerpt: lines[i].trim().slice(0, 140) });
    }
  }
  return hits;
}

export function hasBanner(text: string, banner: RulesFile['banner']): boolean {
  const head = text.split('\n').slice(0, banner.within_lines).join('\n');
  return new RegExp(banner.pattern, 'i').test(head);
}

/** Live surface: every hit is a finding at the rule's severity. */
export function checkLiveSurface(surface: string, text: string, rules: Rule[]): Finding[] {
  return findHits(text, rules).map(h => ({
    severity: h.rule.severity,
    where: `${surface}:${h.line}`,
    message:
      h.rule.kind === 'retired'
        ? `retired figure (${h.rule.id}): ${h.excerpt}`
        : `figure without its qualifier /${h.rule.qualifier}/ in the same row or paragraph (${h.rule.id}): ${h.excerpt}`,
  }));
}

/** Historical report: hits are tolerated behind a banner; one finding otherwise. */
export function checkReport(surface: string, text: string, rulesFile: RulesFile): Finding[] {
  const hits = findHits(text, rulesFile.rules);
  if (hits.length === 0) return [];
  if (hasBanner(text, rulesFile.banner)) {
    return [{ severity: 'info', where: surface, message: `${hits.length} retired/unqualified figure(s) behind an erratum banner` }];
  }
  const ids = [...new Set(hits.map(h => h.rule.id))].join(', ');
  const first = hits.slice(0, 3).map(h => `L${h.line}`).join(', ');
  return [
    {
      severity: rulesFile.banner.severity,
      where: surface,
      message: `prints ${hits.length} retired/unqualified figure(s) [${ids}] (e.g. ${first}) with no erratum/correction banner in the first ${rulesFile.banner.within_lines} lines`,
    },
  ];
}

/** Read a surface from disk, or from a git ref when given. */
function readSurface(root: string, path: string, ref?: string): string | null {
  if (ref) return gitShow(root, ref, path);
  const abs = join(root, path);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
}

function listReports(root: string, dir: string, ref?: string): string[] {
  if (ref) {
    const proc = Bun.spawnSync(['git', 'ls-tree', '-r', '--name-only', ref, '--', dir], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    if (proc.exitCode !== 0) return [];
    return new TextDecoder().decode(proc.stdout).split('\n').filter(p => p.endsWith('.md'));
  }
  return walk(join(root, dir))
    .filter(f => f.endsWith('.md'))
    .map(f => rel(root, f));
}

export interface ClaimHygieneOpts {
  root?: string;
  rulesPath?: string;
  rules?: RulesFile;
  /** Check surfaces at this git ref instead of the working tree. */
  ref?: string;
}

export function checkClaimHygiene(opts: ClaimHygieneOpts = {}): CheckReport {
  const root = opts.root ?? REPO_ROOT;
  const rulesPath = opts.rulesPath ?? join(root, 'docs/claim-hygiene.json');
  let rules: RulesFile;
  try {
    rules = opts.rules ?? loadRules(rulesPath);
  } catch (e) {
    return { check: CHECK, findings: [], unavailable: `rules unreadable: ${e instanceof Error ? e.message : e}` };
  }
  const findings: Finding[] = [];
  const tag = opts.ref ? ` @ ${opts.ref}` : '';
  for (const s of rules.live_surfaces) {
    const text = readSurface(root, s, opts.ref);
    if (text === null) {
      findings.push({ severity: 'warn', where: `${s}${tag}`, message: 'live surface listed in rules but absent' });
      continue;
    }
    findings.push(...checkLiveSurface(`${s}${tag}`, text, rules.rules));
  }
  const reports = listReports(root, rules.reports_dir, opts.ref);
  for (const r of reports) {
    const text = readSurface(root, r, opts.ref);
    if (text === null) continue;
    findings.push(...checkReport(`${r}${tag}`, text, rules));
  }
  findings.push({
    severity: 'info',
    where: `${rules.live_surfaces.length} live surface(s) + ${reports.length} report(s)${tag}`,
    message: `${rules.rules.length} rule(s) applied`,
  });
  return { check: CHECK, findings };
}

// ─── Sweep: README.md at every remote branch + PR head ──────────────────────

export function listRemoteRefs(root: string): string[] {
  const proc = Bun.spawnSync(
    ['git', 'for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' },
  );
  if (proc.exitCode !== 0) return [];
  return new TextDecoder()
    .decode(proc.stdout)
    .split('\n')
    .map(s => s.trim())
    .filter(s => s && s !== 'origin/HEAD' && s !== 'origin');
}

export function fetchPrHeads(root: string): { ok: boolean; message: string } {
  const proc = Bun.spawnSync(
    ['git', 'fetch', '--quiet', 'origin', '+refs/pull/*/head:refs/remotes/origin/pr/*'],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' },
  );
  return { ok: proc.exitCode === 0, message: new TextDecoder().decode(proc.stderr).trim() };
}

export interface SweepOpts {
  root?: string;
  rules?: RulesFile;
  refs?: string[];
  fetchPrs?: boolean;
  failOnStale?: boolean;
  /** Surfaces to check per ref; default README.md only (what a linked visitor sees). */
  surfaces?: string[];
}

export function sweepRefs(opts: SweepOpts = {}): CheckReport {
  const root = opts.root ?? REPO_ROOT;
  const findings: Finding[] = [];
  let rules: RulesFile;
  try {
    rules = opts.rules ?? loadRules(join(root, 'docs/claim-hygiene.json'));
  } catch (e) {
    return { check: `${CHECK}:sweep`, findings: [], unavailable: `rules unreadable: ${e instanceof Error ? e.message : e}` };
  }
  if (opts.fetchPrs) {
    const f = fetchPrHeads(root);
    findings.push({ severity: f.ok ? 'info' : 'warn', where: 'git fetch', message: f.ok ? 'PR heads fetched to origin/pr/*' : `PR-head fetch failed: ${f.message}` });
  }
  const refs = opts.refs ?? listRemoteRefs(root);
  if (refs.length === 0) {
    return { check: `${CHECK}:sweep`, findings, unavailable: 'no remote refs found (run inside a clone with an origin remote)' };
  }
  const surfaces = opts.surfaces ?? ['README.md'];
  const severity: Severity = opts.failOnStale ? 'fail' : 'warn';
  let stale = 0;
  for (const ref of refs) {
    let refHits = 0;
    for (const s of surfaces) {
      const text = gitShow(root, ref, s);
      if (text === null) continue;
      const hits = findHits(text, rules.rules);
      refHits += hits.length;
      for (const h of hits.slice(0, 5)) {
        findings.push({ severity, where: `${s} @ ${ref}:${h.line}`, message: `${h.rule.id}: ${h.excerpt}` });
      }
      if (hits.length > 5) {
        findings.push({ severity, where: `${s} @ ${ref}`, message: `… ${hits.length - 5} more hit(s)` });
      }
    }
    if (refHits > 0) stale++;
    findings.push({ severity: 'info', where: ref, message: refHits === 0 ? 'clean' : `${refHits} stale-claim hit(s)` });
  }
  findings.push({ severity: 'info', where: `${refs.length} ref(s)`, message: `${stale} carry stale claims on ${surfaces.join(', ')}` });
  return { check: `${CHECK}:sweep`, findings };
}

if (import.meta.main) {
  const { flags } = parseArgs(process.argv.slice(2));
  const root = typeof flags.get('root') === 'string' ? String(flags.get('root')) : REPO_ROOT;
  const rulesPath = typeof flags.get('rules') === 'string' ? String(flags.get('rules')) : undefined;
  if (flags.has('sweep')) {
    runCli([sweepRefs({ root, fetchPrs: flags.has('fetch-prs'), failOnStale: flags.has('fail-on-stale') })], flags);
  }
  const ref = typeof flags.get('ref') === 'string' ? String(flags.get('ref')) : undefined;
  runCli([checkClaimHygiene({ root, rulesPath, ref })], flags);
}

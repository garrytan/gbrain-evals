/**
 * The nightly report: per suite, reader and ref, pass^1 and pass^k, failures by cause and cost per correct answer, and the
 * comparison with the previous master night (and, on matrix nights, master against stable).
 *
 *   bun eval/runner/nightly/report.ts --night-dir <dir> [--previous <night dir>] [--stable <night dir>] [--gbrain-clone <path>]
 *
 * pass^k is tau-bench's estimator: an item with c passes in n trials contributes C(c,k)/C(n,k), the chance that k trials drawn
 * from its n all pass, averaged over items; pass^1 is the plain pass rate. Harness rows (provider or harness failures) are
 * left out of every rate and counted on their own line. Cost per correct answer is the suite's whole recorded cost over its
 * passing rows.
 *
 * Flags against the previous master night, suite by suite and only where the suite digests match:
 *   - a deterministic signal (refused tool calls, tool errors, harness errors, lost, stuck, duplicated or overwritten writes,
 *     smoke failures) on any increase;
 *   - the pass rate, paired by item with a task-clustered bootstrap (items resampled with their trials, 10,000 resamples,
 *     seed 1): when the 95% interval of tonight minus the previous night excludes zero and the drop is at least 5 points;
 *   - a strong flip: an item that passed k of k trials and now passes 0 of k;
 *   - cost per correct answer up 25% or more with no gain in pass rate.
 * The same rules compare master with stable, reported in their own section. Writes report.md, summary.json and
 * outcomes.jsonl.gz into the night directory.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { pairedBootstrap } from '../refresh-barrier/analyze.ts';
import { CAUSES, CLASSIFIER_VERSION, classify, type Cause } from './classify.ts';
import { readOutcomes, type Outcome } from './outcome.ts';

const REPO = resolve(import.meta.dir, '../../..');
export const FIXES_PATH = 'eval/data/nightly/fixes.json';
export const PASS_DROP = 0.05;
export const COST_RISE = 1.25;

export interface SuiteStatus {
  id: string; digest: string; k: number; readers: Array<string | null>;
  /** pending while the suite runs; a night that stops leaves it pending, and a finished night records it as error. */
  status: 'pending' | 'ran' | 'partial' | 'skipped' | 'not_built' | 'error';
  reason?: string;
}
export interface NightManifest {
  schema: 'nightly-night/1'; night: string; ref: string; sha: string; version: string | null; tier: string; fake: boolean;
  devset: { path: string; digest: string }; suites: SuiteStatus[]; started_at: string; finished_at?: string;
  budget?: { run_id: string; ledger: string } | null;
  /** The invocation's arguments, which --resume repeats, and how many times the night has been started. */
  argv?: string[]; attempts?: number;
  /** The stop code the night ended with (run.ts EXIT), or null when it finished whole. */
  exit?: string | null;
}

const WRITE_LOSS = ['lost', 'lost_git', 'phantom', 'duplicated', 'stuck', 'overwritten', 'wrong_expiry', 'unindexed', 'unpublished'];
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** tau-bench's pass^k for one item: C(c,k)/C(n,k); null when it has fewer than k trials. */
export function passHatK(c: number, n: number, k: number): number | null {
  if (n < k || k < 1) return null;
  let p = 1;
  for (let i = 0; i < k; i++) p *= (c - i) / (n - i);
  return Math.max(0, p);
}

export interface Signals { refusals: number; tool_errors: number; harness_errors: number; lost_writes: number; smoke_failures: number }
export const SIGNAL_NAMES: Array<keyof Signals> = ['refusals', 'tool_errors', 'harness_errors', 'lost_writes', 'smoke_failures'];

export function signalsOf(rows: Outcome[]): Signals {
  const s: Signals = { refusals: 0, tool_errors: 0, harness_errors: 0, lost_writes: 0, smoke_failures: 0 };
  for (const r of rows) {
    if (r.harness) { s.harness_errors++; continue; }
    s.refusals += r.tool_errors.filter(t => t.refused).length;
    s.tool_errors += r.tool_errors.filter(t => !t.refused).length;
    s.lost_writes += list(r.evidence.failure_classes).filter(c => WRITE_LOSS.includes(String(c))).length + list(r.evidence.duplicated).length + list(r.evidence.acknowledged_missing).length;
    if (r.evidence.kind === 'smoke' && !r.pass) s.smoke_failures++;
  }
  return s;
}

export interface CellStats {
  suite: string; reader: string | null; items: number; trials: number; k: number;
  pass1: number | null; passk: number | null; passes: number;
  failures_by_cause: Partial<Record<Cause, number>>; harness: number;
  cost_usd: number | null; cost_per_correct: number | null; signals: Signals;
  /** Per item: passes and non-harness trials. */
  per_item: Record<string, { c: number; n: number }>;
}

export function cellStats(suite: string, reader: string | null, rows: Outcome[], k: number): CellStats {
  const counted = rows.filter(r => !r.harness);
  const per_item: Record<string, { c: number; n: number }> = {};
  for (const r of counted) { const e = per_item[r.item] ??= { c: 0, n: 0 }; e.n++; if (r.pass) e.c++; }
  const items = Object.values(per_item);
  const mean = (xs: Array<number | null>) => { const v = xs.filter((x): x is number => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const failures_by_cause: Partial<Record<Cause, number>> = {};
  for (const r of rows) if (r.harness || !r.pass) { const c = classify(r).cause; failures_by_cause[c] = (failures_by_cause[c] ?? 0) + 1; }
  const costs = rows.map(r => r.cost_usd);
  const cost_usd = costs.some(c => c !== null) ? costs.reduce<number>((a, c) => a + (c ?? 0), 0) : null;
  const passes = counted.filter(r => r.pass).length;
  return {
    suite, reader, items: items.length, trials: counted.length, k, passes,
    pass1: mean(items.map(i => i.c / i.n)), passk: mean(items.map(i => passHatK(i.c, i.n, k))),
    failures_by_cause, harness: rows.length - counted.length, cost_usd, cost_per_correct: cost_usd !== null && passes ? cost_usd / passes : null,
    signals: signalsOf(rows), per_item,
  };
}

export function nightCells(manifest: NightManifest, rows: Outcome[]): CellStats[] {
  const out: CellStats[] = [];
  for (const s of manifest.suites) {
    const mine = rows.filter(r => r.suite === s.id);
    const readers = [...new Set([...s.readers, ...mine.map(r => r.reader)])];
    for (const reader of readers) {
      const cell = mine.filter(r => r.reader === reader);
      if (cell.length || s.status === 'ran' || s.status === 'partial') out.push(cellStats(s.id, reader, cell, s.k));
    }
  }
  return out;
}

export interface Flag { kind: 'signal' | 'pass_rate' | 'strong_flip' | 'cost'; against: 'previous' | 'stable'; suite: string; reader: string | null; detail: string; items?: string[] }
export interface Comparison {
  against: 'previous' | 'stable'; night: string; ref: string; sha: string;
  suites: Array<{ suite: string; reader: string | null; compared: boolean; reason?: string; pass_diff?: { mean: number | null; lo: number | null; hi: number | null; items: number }; strong_flips?: string[]; cost_ratio?: number | null }>;
  flags: Flag[];
}

export function compareNights(tonight: { manifest: NightManifest; rows: Outcome[] }, other: { manifest: NightManifest; rows: Outcome[] }, against: 'previous' | 'stable'): Comparison {
  const mine = nightCells(tonight.manifest, tonight.rows), theirs = nightCells(other.manifest, other.rows);
  const status = (m: NightManifest, id: string) => m.suites.find(s => s.id === id);
  const flags: Flag[] = [];
  const suites: Comparison['suites'] = [];
  const ids = [...new Set([...tonight.manifest.suites.map(s => s.id), ...other.manifest.suites.map(s => s.id)])];
  for (const id of ids) {
    const a = status(tonight.manifest, id), b = status(other.manifest, id);
    const readers = [...new Set([...mine, ...theirs].filter(c => c.suite === id).map(c => c.reader))];
    const skip = (reason: string) => { for (const reader of readers.length ? readers : [null]) suites.push({ suite: id, reader, compared: false, reason }); };
    if (!a || !b) { skip(`not in ${!a ? 'tonight' : `the ${against} night`}'s dev set`); continue; }
    const absent = (s: SuiteStatus, who: string) => s.status === 'skipped' || s.status === 'not_built' || s.status === 'error' || s.status === 'pending' ? `${s.status.replace('_', ' ')} ${who}${s.reason ? ` (${s.reason})` : ''}` : null;
    const why = absent(a, 'tonight') ?? absent(b, `on the ${against} night`);
    if (why) { skip(why); continue; }
    if (a.digest !== b.digest) { skip(`suite digest changed (${b.digest.slice(0, 12)} to ${a.digest.slice(0, 12)}), so tonight starts a new baseline`); continue; }
    for (const reader of readers) {
      const t = mine.find(c => c.suite === id && c.reader === reader), p = theirs.find(c => c.suite === id && c.reader === reader);
      if (!t || !p) { suites.push({ suite: id, reader, compared: false, reason: `no ${reader ?? 'keyless'} rows ${!t ? 'tonight' : `on the ${against} night`}` }); continue; }
      for (const name of SIGNAL_NAMES) {
        if (t.signals[name] > p.signals[name]) flags.push({ kind: 'signal', against, suite: id, reader, detail: `${name.replace('_', ' ')} rose from ${p.signals[name]} to ${t.signals[name]}` });
      }
      const common = Object.keys(t.per_item).filter(i => p.per_item[i]).sort();
      const diffs = common.map(i => t.per_item[i]!.c / t.per_item[i]!.n - p.per_item[i]!.c / p.per_item[i]!.n);
      const boot = pairedBootstrap(diffs);
      if (boot.hi !== null && boot.mean !== null && boot.hi < 0 && -boot.mean >= PASS_DROP) {
        flags.push({ kind: 'pass_rate', against, suite: id, reader, detail: `pass rate down ${(-boot.mean * 100).toFixed(1)} points over ${common.length} paired items (95% interval ${(boot.lo! * 100).toFixed(1)} to ${(boot.hi * 100).toFixed(1)})` });
      }
      const flips = common.filter(i => { const x = p.per_item[i]!, y = t.per_item[i]!; return x.n === y.n && x.c === x.n && y.c === 0; });
      if (flips.length) flags.push({ kind: 'strong_flip', against, suite: id, reader, detail: `${flips.length} items went from all trials passing to none`, items: flips });
      const ratio = t.cost_per_correct !== null && p.cost_per_correct ? t.cost_per_correct / p.cost_per_correct : null;
      if (ratio !== null && ratio >= COST_RISE && (t.pass1 ?? 0) <= (p.pass1 ?? 0)) {
        flags.push({ kind: 'cost', against, suite: id, reader, detail: `cost per correct answer up ${((ratio - 1) * 100).toFixed(0)}% with no gain in pass rate` });
      }
      suites.push({ suite: id, reader, compared: true, pass_diff: { ...boot, items: common.length }, strong_flips: flips, cost_ratio: ratio });
    }
  }
  return { against, night: other.manifest.night, ref: other.manifest.ref, sha: other.manifest.sha, suites, flags };
}

export interface Fix { issue: string; pr: string; gbrain_version: string; suite: string; items: string[]; note?: string }

export function loadFixes(path = join(REPO, FIXES_PATH)): Fix[] {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { fixes: Fix[] }).fixes : [];
}

/** The latest earlier night of the same ref under outRoot (<outRoot>/<YYYY-MM-DD>/<ref>) that has a summary. */
export function findPreviousNight(outRoot: string, night: string, ref: string): string | null {
  if (!existsSync(outRoot)) return null;
  const dates = readdirSync(outRoot).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < night).sort().reverse();
  const hit = dates.find(d => existsSync(join(outRoot, d, ref, 'summary.json')));
  return hit ? join(outRoot, hit, ref) : null;
}

export const loadNight = (dir: string) => ({ manifest: JSON.parse(readFileSync(join(dir, 'night.json'), 'utf8')) as NightManifest, rows: readOutcomes(join(dir, 'outcomes.jsonl')) });

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const usd = (x: number | null) => (x === null ? 'n/a' : `$${x.toFixed(4)}`);

export function buildReport(o: { dir: string; previous?: string | null; stable?: string | null; gbrainClone?: string | null; fixes?: Fix[] }): { summary: Record<string, unknown>; markdown: string } {
  const night = loadNight(o.dir);
  const { manifest: m, rows } = night;
  const cells = nightCells(m, rows);
  const comparisons = [o.previous && { dir: o.previous, against: 'previous' as const }, o.stable && { dir: o.stable, against: 'stable' as const }]
    .filter((x): x is { dir: string; against: 'previous' | 'stable' } => !!x && existsSync(join(x.dir, 'night.json')))
    .map(x => compareNights(night, loadNight(x.dir), x.against));
  const prev = comparisons.find(c => c.against === 'previous');
  let commits: string[] | null = null;
  if (o.gbrainClone && prev && prev.sha && prev.sha !== m.sha) {
    try { commits = execFileSync('git', ['-C', o.gbrainClone, 'log', '--oneline', '--first-parent', `${prev.sha}..${m.sha}`], { encoding: 'utf8' }).split('\n').filter(Boolean); }
    catch (e) { commits = [`(git log failed: ${(e as Error).message.split('\n')[0]})`]; }
  }
  const fixes = (o.fixes ?? loadFixes()).map(f => {
    const mine = rows.filter(r => r.suite === f.suite && f.items.includes(r.item) && !r.harness);
    return { ...f, tonight: { rows: mine.length, passes: mine.filter(r => r.pass).length } };
  });
  const flags = comparisons.flatMap(c => c.flags);
  const summary = {
    schema: 'nightly-summary/1', night: m.night, ref: m.ref, sha: m.sha, version: m.version, tier: m.tier, fake: m.fake, devset: m.devset,
    classifier_version: CLASSIFIER_VERSION,
    suites: m.suites.map(s => ({ ...s, cells: cells.filter(c => c.suite === s.id).map(({ per_item: _items, ...c }) => c) })),
    harness_rows: rows.filter(r => r.harness).length,
    flags, comparisons, commit_range: prev ? { from: prev.sha, to: m.sha, commits } : null, fixes,
  };
  const lines: string[] = [];
  lines.push(`# Nightly gbrain check: ${m.ref} ${m.sha.slice(0, 12)}${m.version ? ` (v${m.version})` : ''}, ${m.night}`, '');
  lines.push(`Tier ${m.tier}${m.fake ? ', fake providers (plumbing only; no number here measures a model)' : ''}. Dev set ${m.devset.digest.slice(0, 12)}. Causes: ${CLASSIFIER_VERSION}.`, '');
  lines.push(flags.length ? `**${flags.length} flags.**` : '**No flags.**', '');
  for (const f of flags) lines.push(`- ${f.kind} (vs ${f.against}) ${f.suite} ${f.reader ?? 'keyless'}: ${f.detail}${f.items ? `: ${f.items.join(', ')}` : ''}`);
  lines.push('', '## Suites', '', '| Suite | Reader | Items | Trials | pass^1 | pass^k | Harness | Cost per correct | Failures by cause |', '|---|---|---|---|---|---|---|---|---|');
  for (const s of m.suites) {
    const mine = cells.filter(c => c.suite === s.id);
    if (!mine.length) { lines.push(`| ${s.id} | | | | | | | | ${s.status.replace('_', ' ')}${s.reason ? `: ${s.reason}` : ''} |`); continue; }
    for (const c of mine) {
      const causes = CAUSES.filter(x => c.failures_by_cause[x]).map(x => `${x} ${c.failures_by_cause[x]}`).join(', ') || 'none';
      lines.push(`| ${s.id}${s.status === 'partial' ? ' (partial)' : ''} | ${c.reader ?? 'keyless'} | ${c.items} | ${c.trials} | ${pct(c.pass1)} | ${c.k > 1 ? pct(c.passk) : 'n/a'} | ${c.harness} | ${usd(c.cost_per_correct)} | ${causes} |`);
    }
  }
  for (const c of comparisons) {
    lines.push('', `## Against ${c.against === 'previous' ? 'the previous master night' : 'stable'} (${c.ref} ${c.sha.slice(0, 12)}, ${c.night})`, '');
    for (const s of c.suites) {
      lines.push(s.compared
        ? `- ${s.suite} ${s.reader ?? 'keyless'}: pass rate change ${s.pass_diff!.mean === null ? 'n/a' : `${(s.pass_diff!.mean * 100).toFixed(1)} points (95% interval ${(s.pass_diff!.lo! * 100).toFixed(1)} to ${(s.pass_diff!.hi! * 100).toFixed(1)})`} over ${s.pass_diff!.items} items${s.strong_flips?.length ? `; strong flips ${s.strong_flips.join(', ')}` : ''}`
        : `- ${s.suite} ${s.reader ?? 'keyless'}: not compared, ${s.reason}`);
    }
  }
  if (summary.commit_range) {
    lines.push('', `## Commits since the previous master night (${commits?.length ?? 0})`, '');
    for (const c of commits ?? []) lines.push(`- ${c}`);
  }
  lines.push('', '## Fixes', '');
  if (!fixes.length) lines.push('No fixes recorded yet in ' + FIXES_PATH + '.');
  for (const f of fixes) lines.push(`- ${f.issue} (${f.pr}, gbrain ${f.gbrain_version}): ${f.suite} ${f.items.join(', ')}: ${f.tonight.passes} of ${f.tonight.rows} passing tonight`);
  return { summary, markdown: lines.join('\n') + '\n' };
}

export function writeReport(o: Parameters<typeof buildReport>[0]): Record<string, unknown> {
  const { summary, markdown } = buildReport(o);
  writeFileSync(join(o.dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(join(o.dir, 'report.md'), markdown);
  const outcomes = join(o.dir, 'outcomes.jsonl');
  if (existsSync(outcomes)) writeFileSync(`${outcomes}.gz`, gzipSync(readFileSync(outcomes)));
  return summary;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const dir = flag('--night-dir');
  if (!dir) { console.error('usage: report.ts --night-dir <dir> [--previous <dir>] [--stable <dir>] [--gbrain-clone <path>]'); process.exit(2); }
  const summary = writeReport({ dir: resolve(dir), previous: flag('--previous') ?? null, stable: flag('--stable') ?? null, gbrainClone: flag('--gbrain-clone') ?? null });
  console.log(JSON.stringify({ flags: (summary.flags as unknown[]).length, report: join(resolve(dir), 'report.md') }));
}

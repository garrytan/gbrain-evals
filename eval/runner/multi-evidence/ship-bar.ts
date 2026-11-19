/**
 * The ship bar for gbrain's multi-page read (get_page with `slugs`, gbrain#9798; GBRA-650, GST-3137), set by Garry
 * through GBRA-108 and written down before any spend (GBEV-108, GST-3185). It compares two multi-evidence dev-loop run
 * directories of the same Cat 40 items, agents, turn cap and served instructions: the newest release (base) and the
 * build that adds `slugs` (candidate), paired by item, agent and trial.
 *
 *   bun eval/runner/multi-evidence/ship-bar.ts --base <run dir> --candidate <run dir> [--privacy <ad-sharing-cells.json>] [--out <dir>]
 *
 * The four bars:
 *   1. Slugs use: the share of the candidate's eligible cells (gold names two or more pages) with at least one get_page
 *      call carrying a non-empty `slugs` array. Met at 50% or more; under 20% means it does not ship.
 *   2. Tool-result characters per cell (every tool result the agent received, submit_answer excluded) fall by at least
 *      15%, paired: 1 - mean(candidate) / mean(base). Met when the point estimate is 15% or more and the interval's lower
 *      bound is above 0.
 *   3. Correct answers (Cat 40's deterministic Hard scorer) don't drop by more than a 15-point margin: met when the
 *      interval's lower bound on candidate - base is above -15 points.
 *   4. Privacy: every cell of the keyless sharing-contract test passes, its get_page { slugs } paths were exercised, and no
 *      caller reads a page through slugs that it does not read through a single get_page (--privacy, the file
 *      AD_REPORT_DIR makes test/eval/sharing-contract.test.ts write).
 * Intervals are 95% percentile bootstraps over items (each item carries its agents' pairs), 10,000 resamples, seed 108.
 * Writes ship-bar.json and ship-bar.md to --out (default: the candidate run dir). Calls nothing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ItemRow } from './score.ts';

export const BAR = {
  slugsUseMet: 0.5, slugsUseNoShip: 0.2, charsReductionMet: 0.15, correctMargin: 0.15, minGoldPages: 2,
  resamples: 10_000, seed: 108, maxDroppedPairs: 5,
} as const;

export interface Pair { item: string; reader: string; trial: number; base: ItemRow; cand: ItemRow }
export interface Estimate { point: number | null; lo: number | null; hi: number | null; n: number }
export type Verdict = 'met' | 'not_met' | 'no_ship' | 'incomplete';

/** A deterministic PRNG (mulberry32), so a rerun of the same rows gives the same intervals. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** A statistic over units grouped by item, with a 95% percentile bootstrap that resamples items. */
export function bootstrap<T extends { item: string }>(units: T[], stat: (xs: T[]) => number | null, resamples: number = BAR.resamples, seed: number = BAR.seed): Estimate {
  const byItem = new Map<string, T[]>();
  for (const u of units) { if (!byItem.has(u.item)) byItem.set(u.item, []); byItem.get(u.item)!.push(u); }
  const items = [...byItem.keys()].sort();
  const point = units.length ? stat(units) : null;
  if (point === null || !items.length) return { point, lo: null, hi: null, n: units.length };
  const next = rng(seed), draws: number[] = [];
  for (let b = 0; b < resamples; b++) {
    const sample: T[] = [];
    for (let i = 0; i < items.length; i++) sample.push(...byItem.get(items[Math.floor(next() * items.length)]!)!);
    const v = stat(sample);
    if (v !== null && Number.isFinite(v)) draws.push(v);
  }
  draws.sort((x, y) => x - y);
  const q = (p: number) => draws[Math.min(draws.length - 1, Math.max(0, Math.floor(p * draws.length)))]!;
  return { point, lo: draws.length ? q(0.025) : null, hi: draws.length ? q(0.975) : null, n: units.length };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export const usesSlugs = (r: ItemRow) => (r.slugs_calls ?? 0) > 0;
export const eligible = (r: ItemRow) => new Set(r.gold).size >= BAR.minGoldPages;
export const slugsShare = (rows: ItemRow[]) => (rows.length ? rows.filter(usesSlugs).length / rows.length : null);
export function charsReduction(pairs: Pair[]): number | null {
  const b = mean(pairs.map(p => p.base.result_chars!)), c = mean(pairs.map(p => p.cand.result_chars!));
  return b === null || c === null || b === 0 ? null : 1 - c / b;
}
export const correctDiff = (pairs: Pair[]) => (pairs.length ? mean(pairs.map(p => Number(p.cand.correct) - Number(p.base.correct))) : null);

const readItems = (dir: string): ItemRow[] => {
  const p = join(dir, 'items.jsonl');
  if (!existsSync(p)) throw new Error(`${p} is missing: run the dev loop (or --report) on ${dir} first`);
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as ItemRow).filter(r => r.kind === 'agent');
};
const key = (r: ItemRow) => `${r.suite}|${r.item}|${r.reader}|${r.trial}`;

/** Pairs every base and candidate row of the same item, agent and trial; a pair with a harness row or no transcript on either side is dropped and named. */
export function pairRows(base: ItemRow[], cand: ItemRow[]): { pairs: Pair[]; dropped: string[] } {
  const b = new Map(base.map(r => [key(r), r])), c = new Map(cand.map(r => [key(r), r]));
  const pairs: Pair[] = [], dropped: string[] = [];
  for (const k of [...new Set([...b.keys(), ...c.keys()])].sort()) {
    const x = b.get(k), y = c.get(k);
    const why = !x ? 'no base row' : !y ? 'no candidate row' : x.harness ? `base harness: ${x.harness}` : y.harness ? `candidate harness: ${y.harness}`
      : x.result_chars === null || y.result_chars === null ? 'no transcript' : null;
    if (why) { dropped.push(`${k}: ${why}`); continue; }
    if (!eligible(x!)) continue;
    pairs.push({ item: x!.item, reader: x!.reader, trial: x!.trial, base: x!, cand: y! });
  }
  return { pairs, dropped };
}

export interface PrivacyResult { ok: boolean; cells: number; violations: number; slugs_cells: number; slugs_only_reads: number; slugs_reads: number; detail: string[] }

/** Bar 4 from the sharing-contract cells: every verdict ok, the slugs paths ran, and no slugs read without a single read. */
export function privacy(cellsFile: string): PrivacyResult {
  const cells = (JSON.parse(readFileSync(cellsFile, 'utf8')) as { cells: Array<{ scenario: string; phase: string; caller: string; item: string; path: string; read: boolean | null; verdict: string }> }).cells;
  const single = new Map(cells.filter(c => c.path === 'get_page' || c.path === 'get_page_unscoped').map(c => [`${c.scenario}|${c.phase}|${c.caller}|${c.item}|${c.path}`, c.read === true]));
  const slugs = cells.filter(c => c.path === 'get_page_slugs' || c.path === 'get_page_slugs_unscoped');
  const only = slugs.filter(c => c.read === true && single.get(`${c.scenario}|${c.phase}|${c.caller}|${c.item}|${c.path.replace('_slugs', '')}`) !== true);
  const bad = cells.filter(c => c.verdict !== 'ok');
  return { ok: !bad.length && !only.length && slugs.length > 0, cells: cells.length, violations: bad.length, slugs_cells: slugs.length, slugs_only_reads: only.length,
    slugs_reads: slugs.filter(c => c.read === true).length,
    detail: [...bad.map(c => `${c.scenario} ${c.phase} ${c.caller} ${c.item} ${c.path} ${c.verdict}`), ...only.map(c => `${c.scenario} ${c.phase} ${c.caller} ${c.item} ${c.path}: read through slugs, not through a single get_page`)] };
}

export interface BarResult {
  base: { dir: string; ref: string; sha: string }; candidate: { dir: string; ref: string; sha: string };
  eligible_cells: number; pairs: number; dropped: string[];
  bars: { slugs_use: Estimate & { verdict: Verdict }; chars_reduction: Estimate & { verdict: Verdict; base_mean: number | null; candidate_mean: number | null }; correct_diff: Estimate & { verdict: Verdict; base: number | null; candidate: number | null }; privacy: (PrivacyResult & { verdict: Verdict }) | null };
  per_reader: Array<{ reader: string; cells: number; pairs: number; slugs_use: Estimate; chars_reduction: Estimate; correct_diff: Estimate; omitted_cells: number }>;
  omitted_cells: number; slugs_multi_cells: number; decision: string;
}

export function shipBar(baseRows: ItemRow[], candRows: ItemRow[], dirs: { base: string; candidate: string }, privacyFile: string | null): BarResult {
  const { pairs, dropped } = pairRows(baseRows, candRows);
  const cand = candRows.filter(r => r.harness === null && r.result_chars !== null && eligible(r));
  const incomplete = dropped.length > BAR.maxDroppedPairs;
  const use = bootstrap(cand, slugsShare);
  const chars = bootstrap(pairs, charsReduction);
  const corr = bootstrap(pairs, correctDiff);
  const v1: Verdict = incomplete ? 'incomplete' : use.point === null ? 'incomplete' : use.point >= BAR.slugsUseMet ? 'met' : use.point < BAR.slugsUseNoShip ? 'no_ship' : 'not_met';
  const v2: Verdict = incomplete || chars.point === null ? 'incomplete' : chars.point >= BAR.charsReductionMet && (chars.lo ?? -1) > 0 ? 'met' : 'not_met';
  const v3: Verdict = incomplete || corr.lo === null ? 'incomplete' : corr.lo > -BAR.correctMargin ? 'met' : 'not_met';
  const priv = privacyFile ? privacy(privacyFile) : null;
  const v4: Verdict = priv === null ? 'incomplete' : priv.ok ? 'met' : 'no_ship';
  const readers = [...new Set(cand.map(r => r.reader))].sort();
  const per_reader = readers.map(reader => {
    const c = cand.filter(r => r.reader === reader), p = pairs.filter(x => x.reader === reader);
    return { reader, cells: c.length, pairs: p.length, slugs_use: bootstrap(c, slugsShare), chars_reduction: bootstrap(p, charsReduction), correct_diff: bootstrap(p, correctDiff), omitted_cells: c.filter(r => (r.omitted_calls ?? 0) > 0).length };
  });
  const verdicts = [v1, v2, v3, v4];
  const decision = verdicts.every(v => v === 'met') ? 'ship: every bar is met'
    : v1 === 'no_ship' || v4 === 'no_ship' ? `does not ship as is: ${[v1 === 'no_ship' ? 'bar 1 (slugs used in under 20% of eligible cells)' : '', v4 === 'no_ship' ? 'bar 4 (privacy)' : ''].filter(Boolean).join(' and ')}`
    : verdicts.includes('incomplete') ? `incomplete: bar ${verdicts.map((v, i) => (v === 'incomplete' ? i + 1 : 0)).filter(Boolean).join(', ')} could not be computed`
    : `not met: bar ${verdicts.map((v, i) => (v === 'not_met' ? i + 1 : 0)).filter(Boolean).join(', ')}; back to the build's owner with the why-rows`;
  const head = (rows: ItemRow[], dir: string) => ({ dir, ref: rows[0]?.gbrain.ref ?? '', sha: rows[0]?.gbrain.sha ?? '' });
  return {
    base: head(baseRows, dirs.base), candidate: head(candRows, dirs.candidate), eligible_cells: cand.length, pairs: pairs.length, dropped,
    bars: {
      slugs_use: { ...use, verdict: v1 },
      chars_reduction: { ...chars, verdict: v2, base_mean: mean(pairs.map(p => p.base.result_chars!)), candidate_mean: mean(pairs.map(p => p.cand.result_chars!)) },
      correct_diff: { ...corr, verdict: v3, base: mean(pairs.map(p => Number(p.base.correct))), candidate: mean(pairs.map(p => Number(p.cand.correct))) },
      privacy: priv ? { ...priv, verdict: v4 } : null,
    },
    per_reader, omitted_cells: cand.filter(r => (r.omitted_calls ?? 0) > 0).length, slugs_multi_cells: cand.filter(r => (r.slugs_multi ?? 0) > 0).length, decision,
  };
}

const pc = (x: number | null) => (x === null ? 'n/a' : `${(100 * x).toFixed(1)}%`);
const pts = (x: number | null) => (x === null ? 'n/a' : `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}`);
const ci = (e: Estimate, f: (x: number | null) => string) => `${f(e.point)} [${f(e.lo)}, ${f(e.hi)}]`;

export function renderBar(r: BarResult): string {
  const b = r.bars, L: string[] = [];
  L.push(`# Ship bar: get_page slugs, ${r.candidate.ref} (${r.candidate.sha.slice(0, 12)}) against ${r.base.ref} (${r.base.sha.slice(0, 12)})`, '');
  L.push(`**Decision: ${r.decision}.**`, '');
  L.push(`${r.eligible_cells} eligible candidate cells; ${r.pairs} pairs (item, agent, trial); ${r.dropped.length} dropped. Intervals: 95% bootstrap over items, ${BAR.resamples} resamples, seed ${BAR.seed}.`, '');
  L.push('| Bar | Measure | Estimate [95% interval] | Threshold | Verdict |', '|---|---|---|---|---|');
  L.push(`| 1 | Eligible cells using slugs | ${ci(b.slugs_use, pc)} | met at 50%; under 20% does not ship | ${b.slugs_use.verdict} |`);
  L.push(`| 2 | Tool-result characters per cell, paired reduction (${Math.round(b.chars_reduction.base_mean ?? 0)} to ${Math.round(b.chars_reduction.candidate_mean ?? 0)}) | ${ci(b.chars_reduction, pc)} | 15% or more, lower bound above 0 | ${b.chars_reduction.verdict} |`);
  L.push(`| 3 | Correct, candidate minus base, points (${pc(b.correct_diff.base)} to ${pc(b.correct_diff.candidate)}) | ${ci(b.correct_diff, pts)} | lower bound above -15 | ${b.correct_diff.verdict} |`);
  L.push(b.privacy ? `| 4 | Privacy (sharing contract with get_page slugs) | ${b.privacy.ok ? 'yes' : 'no'}: ${b.privacy.cells} cells, ${b.privacy.violations} violations, ${b.privacy.slugs_cells} slugs cells (${b.privacy.slugs_reads} reads), ${b.privacy.slugs_only_reads} slugs-only reads | every cell passes | ${b.privacy.verdict} |` : '| 4 | Privacy | not given (--privacy) | every cell passes | incomplete |');
  L.push('', `Cells where a get_page batch listed pages under omitted: ${r.omitted_cells}. Cells with a slugs call that read two or more pages: ${r.slugs_multi_cells}.`, '');
  L.push('## Per agent', '', '| Agent | Cells | Pairs | Using slugs | Chars reduction | Correct, points | Cells with omitted |', '|---|---|---|---|---|---|---|');
  for (const x of r.per_reader) L.push(`| ${x.reader} | ${x.cells} | ${x.pairs} | ${ci(x.slugs_use, pc)} | ${ci(x.chars_reduction, pc)} | ${ci(x.correct_diff, pts)} | ${x.omitted_cells} |`);
  if (r.dropped.length) L.push('', '## Dropped pairs', '', ...r.dropped.map(d => `- ${d}`));
  if (b.privacy?.detail.length) L.push('', '## Privacy failures', '', ...b.privacy.detail.map(d => `- ${d}`));
  return L.join('\n') + '\n';
}

export function main(argv: readonly string[]): number {
  const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const base = flag('--base'), candidate = flag('--candidate');
  if (!base || !candidate) throw new Error('usage: ship-bar.ts --base <run dir> --candidate <run dir> [--privacy <ad-sharing-cells.json>] [--out <dir>]');
  const r = shipBar(readItems(resolve(base)), readItems(resolve(candidate)), { base: resolve(base), candidate: resolve(candidate) }, flag('--privacy') ? resolve(flag('--privacy')!) : null);
  const out = resolve(flag('--out') ?? candidate);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'ship-bar.json'), JSON.stringify(r, null, 2) + '\n');
  writeFileSync(join(out, 'ship-bar.md'), renderBar(r));
  console.log(renderBar(r));
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));

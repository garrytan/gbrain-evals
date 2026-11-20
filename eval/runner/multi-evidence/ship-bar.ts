/**
 * The ship bar for gbrain's multi-page read (get_page with `slugs`, gbrain#9798; GBRA-650, GST-3137), set by Garry
 * through GBRA-108 and written down before any spend (GBEV-108, GST-3185). It compares two multi-evidence dev-loop run
 * directories of the same Cat 40 items, agents, turn cap and served instructions: the newest release (base) and the
 * build that adds `slugs` (candidate), paired by item, agent and trial. Only base-arm rows count: a run's follow-up arms
 * (cap2x, batch) rerun only the items base missed, so they are not the same cells on both builds.
 *
 *   bun eval/runner/multi-evidence/ship-bar.ts --base <run dir> --candidate <run dir> [--privacy <ad-sharing-cells.json>] [--out <dir>]
 *
 * The four bars:
 *   1. Slugs use: the share of the candidate's eligible cells (gold names two or more pages) with at least one get_page
 *      call carrying a non-empty `slugs` array. Met at 50% or more; under 20% means it does not ship.
 *   2. Garry's restated words (GBEV-110): "page-read output at least 15% smaller and total output not larger". Page-read
 *      output is the characters of every get_page result per cell, single reads and slugs batches alike; total output is
 *      every tool result the agent received (submit_answer excluded). Each is paired, 1 - mean(candidate) / mean(base).
 *      Met when the page-read reduction's point estimate is 15% or more with its interval's lower bound above 0, and the
 *      total's point estimate is not an increase (a reduction of 0 or more); the total's interval is reported beside it.
 *   3. Correct answers (Cat 40's deterministic Hard scorer) don't drop by more than a 15-point margin: met when the
 *      interval's lower bound on candidate - base is above -15 points.
 *   4. Privacy: every cell of the keyless sharing-contract test passes, its get_page { slugs } paths were exercised, and no
 *      caller reads a page through slugs that it does not read through a single get_page (--privacy, the file
 *      AD_REPORT_DIR makes test/eval/sharing-contract.test.ts write). The file is refused unless it ran on the candidate's
 *      commit from a clean checkout that stayed linked for the whole run, and holds cells for every scenario that build
 *      defines, before and after.
 * The comparison is refused when an arm's rows name more than one gbrain commit, or when a pair's gold pages, turn cap or
 * setup (the digest dev-loop.ts records per cells dir: world, brains, Hard identity, evaluator code, served instructions
 * and tool names, cell flags) differ, or a row records no setup.
 * Intervals are 95% percentile bootstraps over items (each item carries its agents' pairs), 10,000 resamples, seed 108.
 * Writes ship-bar.json and ship-bar.md to --out (default: the candidate run dir). Calls nothing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ItemRow } from './score.ts';

export const BAR = {
  slugsUseMet: 0.5, slugsUseNoShip: 0.2, pageReductionMet: 0.15, totalReductionMin: 0, correctMargin: 0.15, minGoldPages: 2,
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
const reduction = (field: 'result_chars' | 'page_chars') => (pairs: Pair[]): number | null => {
  const b = mean(pairs.map(p => p.base[field]!)), c = mean(pairs.map(p => p.cand[field]!));
  return b === null || c === null || b === 0 ? null : 1 - c / b;
};
export const charsReduction = reduction('result_chars');
export const pageReduction = reduction('page_chars');
export const correctDiff = (pairs: Pair[]) => (pairs.length ? mean(pairs.map(p => Number(p.cand.correct) - Number(p.base.correct))) : null);

const readItems = (dir: string): ItemRow[] => {
  const p = join(dir, 'items.jsonl');
  if (!existsSync(p)) throw new Error(`${p} is missing: run the dev loop (or --report) on ${dir} first`);
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as ItemRow).filter(r => r.kind === 'agent');
};
const key = (r: ItemRow) => `${r.suite}|${r.item}|${r.reader}|${r.trial}`;

const sameGold = (x: ItemRow, y: ItemRow) => JSON.stringify([...new Set(x.gold)].sort()) === JSON.stringify([...new Set(y.gold)].sort());

/**
 * Pairs every base and candidate row of the same item, agent and trial; a pair with a harness row or no transcript on
 * either side is dropped and named, and a pair whose gold pages, turn cap or setup differ, or that records no setup, is
 * listed as mismatched (shipBar refuses the comparison).
 */
export function pairRows(base: ItemRow[], cand: ItemRow[]): { pairs: Pair[]; dropped: string[]; mismatched: string[] } {
  const b = new Map(base.map(r => [key(r), r])), c = new Map(cand.map(r => [key(r), r]));
  const pairs: Pair[] = [], dropped: string[] = [], mismatched: string[] = [];
  for (const k of [...new Set([...b.keys(), ...c.keys()])].sort()) {
    const x = b.get(k), y = c.get(k);
    const why = !x ? 'no base row' : !y ? 'no candidate row' : x.harness ? `base harness: ${x.harness}` : y.harness ? `candidate harness: ${y.harness}`
      : x.result_chars === null || y.result_chars === null ? 'no transcript' : null;
    if (why) { dropped.push(`${k}: ${why}`); continue; }
    const differ = [!x!.setup || !y!.setup ? 'no setup recorded (rerun dev-loop.ts --report on the run dir)' : x!.setup !== y!.setup ? 'setup' : '',
      sameGold(x!, y!) ? '' : 'gold pages', x!.turn_cap === y!.turn_cap ? '' : `turn cap ${x!.turn_cap} against ${y!.turn_cap}`].filter(Boolean);
    if (differ.length) { mismatched.push(`${k}: ${differ.join(', ')}`); continue; }
    if (!eligible(x!)) continue;
    pairs.push({ item: x!.item, reader: x!.reader, trial: x!.trial, base: x!, cand: y! });
  }
  return { pairs, dropped, mismatched };
}

export interface PrivacyResult { ok: boolean; cells: number; violations: number; slugs_cells: number; slugs_only_reads: number; slugs_reads: number; detail: string[] }

interface PrivacyFile {
  gbrain?: { version?: string; sha?: string | null; dirty?: boolean | null }; gbrain_at_end?: { sha?: string | null; dirty?: boolean | null }; has_slugs?: boolean; too_old?: boolean; scenarios?: string[];
  cells: Array<{ scenario: string; phase: string; caller: string; item: string; path: string; read: boolean | null; verdict: string }>;
}

/** Why a sharing-contract file is not a full run on the candidate commit from a clean checkout; empty when it is. */
export function privacyRefusal(f: PrivacyFile, sha: string): string[] {
  const why: string[] = [];
  if (!f.gbrain?.sha) why.push('it records no gbrain commit (run it with node_modules/gbrain linked to a clean checkout of the candidate)');
  else if (f.gbrain.sha !== sha) why.push(`it ran on ${f.gbrain.sha}, not the candidate ${sha}`);
  if (f.gbrain?.sha && f.gbrain.dirty !== false) why.push('the gbrain checkout had uncommitted changes');
  if (f.gbrain?.sha && (f.gbrain_at_end?.sha !== f.gbrain.sha || f.gbrain_at_end?.dirty !== f.gbrain.dirty)) why.push(`node_modules/gbrain changed during the run (${f.gbrain.sha} at the start, ${f.gbrain_at_end?.sha ?? 'no commit recorded'} at the end)`);
  if (f.too_old !== false || f.has_slugs !== true) why.push('that build skipped the scenarios or the get_page slugs paths');
  const scenarios = f.scenarios ?? [];
  if (!scenarios.length) why.push('it lists no scenarios');
  const missing = scenarios.flatMap(s => ['before', 'after'].filter(phase => !f.cells.some(c => c.scenario === s && c.phase === phase)).map(phase => `${s} (${phase})`));
  if (missing.length) why.push(`not a full run: no cells for ${missing.length} scenario phases, first ${missing.slice(0, 3).join('; ')}`);
  return why;
}

/**
 * Bar 4 from the sharing-contract cells: every verdict ok, the slugs paths ran, and no slugs read without a single read.
 * Throws when the file is not a full run on the candidate commit (privacyRefusal).
 */
export function privacy(cellsFile: string, sha: string): PrivacyResult {
  const f = JSON.parse(readFileSync(cellsFile, 'utf8')) as PrivacyFile;
  const refusal = privacyRefusal(f, sha);
  if (refusal.length) throw new Error(`ship bar refuses the privacy file ${cellsFile}: ${refusal.join('; ')}`);
  const cells = f.cells;
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
  bars: { slugs_use: Estimate & { verdict: Verdict }; output: { verdict: Verdict; page: Estimate & { base_mean: number | null; candidate_mean: number | null }; total: Estimate & { base_mean: number | null; candidate_mean: number | null } }; correct_diff: Estimate & { verdict: Verdict; base: number | null; candidate: number | null }; privacy: (PrivacyResult & { verdict: Verdict }) | null };
  per_reader: Array<{ reader: string; cells: number; pairs: number; slugs_use: Estimate; page_reduction: Estimate; chars_reduction: Estimate; correct_diff: Estimate; omitted_cells: number }>;
  omitted_cells: number; slugs_multi_cells: number; decision: string;
}

export function shipBar(baseRun: ItemRow[], candRun: ItemRow[], dirs: { base: string; candidate: string }, privacyFile: string | null): BarResult {
  const baseRows = baseRun.filter(r => r.arm === 'base'), candRows = candRun.filter(r => r.arm === 'base');
  for (const [arm, rows] of [['base', baseRows], ['candidate', candRows]] as const) {
    const shas = [...new Set(rows.map(r => r.gbrain.sha))];
    if (shas.length > 1) throw new Error(`ship bar refuses: the ${arm} rows name ${shas.length} gbrain commits (${shas.map(s => s.slice(0, 12)).join(', ')})`);
  }
  const { pairs, dropped, mismatched } = pairRows(baseRows, candRows);
  if (mismatched.length) throw new Error(`ship bar refuses: ${mismatched.length} pairs differ in gold pages, turn cap or setup:\n${mismatched.map(m => `  ${m}`).join('\n')}`);
  const cand = candRows.filter(r => r.harness === null && r.result_chars !== null && eligible(r));
  const incomplete = dropped.length > BAR.maxDroppedPairs;
  const use = bootstrap(cand, slugsShare);
  const page = bootstrap(pairs, pageReduction);
  const chars = bootstrap(pairs, charsReduction);
  const corr = bootstrap(pairs, correctDiff);
  const v1: Verdict = incomplete ? 'incomplete' : use.point === null ? 'incomplete' : use.point >= BAR.slugsUseMet ? 'met' : use.point < BAR.slugsUseNoShip ? 'no_ship' : 'not_met';
  const v2: Verdict = incomplete || page.point === null || chars.point === null ? 'incomplete'
    : page.point >= BAR.pageReductionMet && (page.lo ?? -1) > 0 && chars.point >= BAR.totalReductionMin ? 'met' : 'not_met';
  const v3: Verdict = incomplete || corr.lo === null ? 'incomplete' : corr.lo > -BAR.correctMargin ? 'met' : 'not_met';
  const priv = privacyFile ? privacy(privacyFile, candRows[0]?.gbrain.sha ?? '') : null;
  const v4: Verdict = priv === null ? 'incomplete' : priv.ok ? 'met' : 'no_ship';
  const readers = [...new Set(cand.map(r => r.reader))].sort();
  const per_reader = readers.map(reader => {
    const c = cand.filter(r => r.reader === reader), p = pairs.filter(x => x.reader === reader);
    return { reader, cells: c.length, pairs: p.length, slugs_use: bootstrap(c, slugsShare), page_reduction: bootstrap(p, pageReduction), chars_reduction: bootstrap(p, charsReduction), correct_diff: bootstrap(p, correctDiff), omitted_cells: c.filter(r => (r.omitted_calls ?? 0) > 0).length };
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
      output: { verdict: v2, page: { ...page, base_mean: mean(pairs.map(p => p.base.page_chars!)), candidate_mean: mean(pairs.map(p => p.cand.page_chars!)) },
        total: { ...chars, base_mean: mean(pairs.map(p => p.base.result_chars!)), candidate_mean: mean(pairs.map(p => p.cand.result_chars!)) } },
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
  L.push(`| 2a | Page-read characters per cell (get_page, single and slugs), paired reduction (${Math.round(b.output.page.base_mean ?? 0)} to ${Math.round(b.output.page.candidate_mean ?? 0)}) | ${ci(b.output.page, pc)} | 15% or more, lower bound above 0 | ${b.output.verdict} |`);
  L.push(`| 2b | Tool-result characters per cell, paired reduction (${Math.round(b.output.total.base_mean ?? 0)} to ${Math.round(b.output.total.candidate_mean ?? 0)}) | ${ci(b.output.total, pc)} | point estimate 0% or more (not larger) | ${b.output.verdict} |`);
  L.push(`| 3 | Correct, candidate minus base, points (${pc(b.correct_diff.base)} to ${pc(b.correct_diff.candidate)}) | ${ci(b.correct_diff, pts)} | lower bound above -15 | ${b.correct_diff.verdict} |`);
  L.push(b.privacy ? `| 4 | Privacy (sharing contract with get_page slugs) | ${b.privacy.ok ? 'yes' : 'no'}: ${b.privacy.cells} cells, ${b.privacy.violations} violations, ${b.privacy.slugs_cells} slugs cells (${b.privacy.slugs_reads} reads), ${b.privacy.slugs_only_reads} slugs-only reads | every cell passes | ${b.privacy.verdict} |` : '| 4 | Privacy | not given (--privacy) | every cell passes | incomplete |');
  L.push('', `Cells where a get_page batch listed pages under omitted: ${r.omitted_cells}. Cells with a slugs call that read two or more pages: ${r.slugs_multi_cells}.`, '');
  L.push('## Per agent', '', '| Agent | Cells | Pairs | Using slugs | Page-read reduction | Total reduction | Correct, points | Cells with omitted |', '|---|---|---|---|---|---|---|---|');
  for (const x of r.per_reader) L.push(`| ${x.reader} | ${x.cells} | ${x.pairs} | ${ci(x.slugs_use, pc)} | ${ci(x.page_reduction, pc)} | ${ci(x.chars_reduction, pc)} | ${ci(x.correct_diff, pts)} | ${x.omitted_cells} |`);
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

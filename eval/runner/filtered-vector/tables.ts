#!/usr/bin/env bun
/**
 * The results page's tables for the filtered vector search experiment
 * (docs/benchmarks/2026-11-26-filtered-vector-material-preregistration.md), computed from recount.ts's output and, for
 * the pages that incomplete searches returned, the raw run rows. Nothing is typed by hand.
 *
 *   bun eval/runner/filtered-vector/tables.ts --recount <stage 1 recount dir> [--stage1b <stage 1b recount dir>] <run dir>...
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CellResult } from './recount.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The rule stage 1b confirms (amendment of 2026-11-27): a date bound, alone or with a type filter, at 375,000 chunks or more. */
export const flipsUnderRule = (c: Pick<CellResult, 'kind' | 'chunks'>) => (c.kind === 'date' || c.kind === 'combo') && c.chunks >= 375_000;
const blocks = (c: CellResult) => c.final_recall !== 'safe' || c.final_latency === 'regresses';
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
const geo = (xs: number[]) => (xs.length ? Math.exp(xs.reduce((a, x) => a + Math.log(x), 0) / xs.length) : NaN);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };
const name = (c: CellResult) => c.cell.split('|').slice(0, 8).join(' ');
const table = (head: string[], rows: string[][]) => ['| ' + head.join(' | ') + ' |', '|' + head.map(() => '---').join('|') + '|', ...rows.map(r => '| ' + r.join(' | ') + ' |')].join('\n');
const count = (cs: CellResult[], pred: (c: CellResult) => boolean) => String(cs.filter(pred).length);

export function stateTable(cells: CellResult[]): string {
  const groups = new Map<string, CellResult[]>();
  for (const c of cells.filter(c => c.affected)) { const k = [c.label, c.size, c.caller].join('|'); groups.set(k, [...(groups.get(k) ?? []), c]); }
  const rows = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([k, cs]) => {
    const warm = cs.filter(c => c.cache === 'warm' && c.reached_any);
    return [...k.split('|'), String(cs.length), count(cs, c => c.final_latency === 'improves'), count(cs, c => c.final_latency === 'neutral'), count(cs, c => c.final_latency === 'regresses'),
      count(cs, c => c.final_recall === 'safe'), count(cs, c => c.final_recall === 'loss'), count(cs, c => c.final_recall === 'unresolved'), f(geo(warm.map(c => c.stats.p50.ratio.est))), f(geo(warm.map(c => c.stats.p95.ratio.est)))];
  });
  return table(['engine', 'corpus', 'caller', 'affected cells', 'improves', 'neutral', 'regresses', 'safe', 'loss', 'unresolved', 'p50 T/C', 'p95 T/C'], rows);
}

export function ruleTable(cells: CellResult[]): string {
  const groups = new Map<string, CellResult[]>();
  for (const c of cells.filter(c => c.affected && flipsUnderRule(c))) { const k = [c.label, c.size].join('|'); groups.set(k, [...(groups.get(k) ?? []), c]); }
  const rows = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([k, cs]) => {
    const imp = cs.filter(c => c.final_latency === 'improves');
    return [...k.split('|'), String(cs.length), String(imp.length), count(cs, blocks), f(Math.min(...cs.map(c => c.stats.recall?.diff.lo ?? 0)), 3), imp.length ? f(median(imp.map(c => c.stats.p50.ratio.est))) : 'n/a', imp.length ? f(Math.min(...imp.map(c => c.stats.p50.ratio.est))) + ' to ' + f(Math.max(...imp.map(c => c.stats.p50.ratio.est))) : 'n/a'];
  });
  return table(['engine', 'corpus', 'cells the rule flips', 'improves', 'loss, unresolved or regresses', 'lowest recall interval end', 'median p50 T/C of improving cells', 'range'], rows);
}

export function blockingTable(cells: CellResult[]): string {
  const rows = cells.filter(c => c.affected && blocks(c)).map(c => [name(c), c.final_recall, c.final_latency, f(c.stats.p50.c, 1), f(c.stats.p50.t, 1), f(c.stats.p50.ratio.est), f(c.stats.p95.ratio.est),
    c.stats.recall ? f(c.stats.recall.diff.est, 3) : 'n/a', c.rerun ? c.rerun.recall_state + ', ' + c.rerun.latency_state : 'not re-run']);
  return table(['cell', 'recall', 'latency', 'p50 C (ms)', 'p50 T (ms)', 'p50 T/C', 'p95 T/C', 'recall T − C', 're-run (seed 29819)'], rows);
}

export function rerunTable(cells: CellResult[]): string {
  const rows = cells.filter(c => c.rerun).map(c => [name(c), c.recall_state + ', ' + c.latency_state, c.rerun!.recall_state + ', ' + c.rerun!.latency_state, c.rerun!.agrees_recall && c.rerun!.agrees_latency ? 'agrees' : 'disagrees; takes the re-run\'s state']);
  return table(['cell', 'first run', 're-run', 'result'], rows);
}

/** Pages returned by each search gbrain flagged incomplete, keyed cell#arm, read from the raw rows. */
function incompletePages(dirs: string[]): Map<string, number[]> {
  const pages = new Map<string, number[]>();
  for (const d of dirs) {
    const file = join(d, 'searches.jsonl');
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"incomplete":true')) continue;
      const r: Any = JSON.parse(line);
      const k = r.cell + '#' + r.arm;
      pages.set(k, [...(pages.get(k) ?? []), r.pages.length]);
    }
  }
  return pages;
}

/** Cells with any search gbrain flagged incomplete, with the pages those searches returned, read from the raw rows. */
export function incompleteTable(cells: CellResult[], dirs: string[]): string {
  const pages = incompletePages(dirs);
  const searches = (c: CellResult) => c.queries * (c.cache === 'warm' ? 3 : 1);
  const rows = cells.filter(c => c.incomplete.c + c.incomplete.t > 0).map(c => {
    const pc = pages.get(c.cell + '#C') ?? [], pt = pages.get(c.cell + '#T') ?? [];
    return [name(c), c.incomplete.c + ' of ' + searches(c), c.incomplete.t + ' of ' + searches(c), pc.length ? f(median(pc), 0) : 'n/a', pt.length ? f(median(pt), 0) : 'n/a',
      c.stats.recall ? f(c.stats.recall.c, 3) : 'n/a', c.stats.recall ? f(c.stats.recall.t, 3) : 'n/a', c.final_recall];
  });
  return table(['cell', 'C incomplete', 'T incomplete', 'C pages (median, incomplete)', 'T pages (median, incomplete)', 'recall C', 'recall T', 'recall state'], rows);
}

export function stage1bTable(cells: CellResult[]): string {
  const flip = cells.filter(c => c.affected && flipsUnderRule(c));
  const rows = flip.map(c => [name(c), c.recall_state, c.latency_state, f(c.stats.p50.ratio.est), f(c.stats.p95.ratio.est), c.stats.recall ? f(c.stats.recall.diff.lo, 3) : 'n/a']);
  const pass = flip.length > 0 && flip.every(c => c.recall_state === 'safe' && c.latency_state !== 'regresses');
  return (pass ? 'PASS' : 'FAIL') + ': ' + flip.length + ' flip-side cells, ' + flip.filter(c => c.latency_state === 'improves').length + ' improve, ' + flip.filter(blocks).length + ' block.\n\n'
    + table(['cell', 'recall', 'latency', 'p50 T/C', 'p95 T/C', 'recall interval low end'], rows);
}

const exactMedian = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2) : NaN; };
const ms = (x: number) => Math.round(x).toLocaleString('en-US') + ' ms';

/** The page's remaining figures: blocking cells by engine and size, the warm medians, pgvector 0.7.4 against 0.8.7, the flip side's slightly slower cells and the incomplete searches that returned at most one page. */
export function figures(cells: CellResult[], stage1b: CellResult[] | null, dirs: string[]): string {
  const groups = new Map<string, CellResult[]>();
  for (const c of cells.filter(c => c.affected && c.realistic && blocks(c))) { const k = [c.label, c.chunks].join('|'); groups.set(k, [...(groups.get(k) ?? []), c]); }
  const byEngine = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([k, cs]) => [...k.split('|'), count(cs, c => c.final_recall === 'loss'), count(cs, c => c.final_recall === 'unresolved'),
    count(cs, c => c.final_latency === 'regresses' && c.cache === 'warm'), count(cs, c => c.final_latency === 'regresses' && c.cache === 'cold')]);
  const warm20 = (label: string, size: string, caller: string) => cells.filter(c => c.affected && c.label === label && c.size === size && c.caller === caller && c.limit === 20 && c.cache === 'warm');
  const medians = [['pg15-v087', 'latent-375000'], ['pg16-v087', 'latent-375000'], ['pg17-v087', 'latent-375000'], ['pg18-v087', 'latent-375000'], ['pg17-v087', 'latent-1500000'], ['pg17-v087', 'wiki-375000']]
    .map(([label, size]) => { const cs = warm20(label!, size!, 'untrusted'); return [label!, size!, String(cs.length), ms(exactMedian(cs.map(c => c.stats.p50.c))), ms(exactMedian(cs.map(c => c.stats.p50.t)))]; });
  const versions = [['latent-375000', 'untrusted'], ['latent-375000', 'trusted'], ['latent-75000', 'untrusted']]
    .map(([size, caller]) => [size!, caller!, ms(exactMedian(warm20('pg17-v074', size!, caller!).map(c => c.stats.p50.c))), ms(exactMedian(warm20('pg17-v087', size!, caller!).map(c => c.stats.p50.c)))]);
  const slower = (cs: CellResult[]) => cs.filter(c => c.affected && c.realistic && flipsUnderRule(c) && c.stats.p50.ratio.lo > 1);
  const slowerRows = [...slower(cells).map(c => ['stage 1', c] as const), ...slower(stage1b ?? []).map(c => ['stage 1b', c] as const)]
    .map(([stage, c]) => [stage, name(c), c.latency_state, f(c.stats.p50.ratio.lo, 3) + ' to ' + f(c.stats.p50.ratio.hi, 3), c.rerun ? c.rerun.latency_state : 'not re-run']);
  const pages = incompletePages(dirs);
  const fewRows = cells.flatMap(c => (['C', 'T'] as const).map(arm => [c, arm, pages.get(c.cell + '#' + arm) ?? []] as const))
    .filter(([, , p]) => p.some(n => n <= 1))
    .map(([c, arm, p]) => [name(c), arm, String(p.length), String(p.filter(n => n === 0).length), String(p.filter(n => n === 1).length)]);
  return ['### Cells that lose, stay unresolved or regress, by engine and brain size',
    table(['engine', 'chunks', 'loss', 'unresolved', 'regresses, warm', 'regresses, cold'], byEngine),
    '### Median p50 of the untrusted caller\'s warm limit-20 filtered cells',
    table(['engine', 'corpus', 'cells', 'C', 'T'], medians),
    '### C\'s median p50 on PostgreSQL 17 by pgvector version (warm limit-20 filtered cells)',
    table(['corpus', 'caller', 'pgvector 0.7.4', 'pgvector 0.8.7'], versions),
    '### Flip-side cells whose p50 T/C interval lies above 1',
    table(['stage', 'cell', 'latency', 'p50 T/C interval', 're-run'], slowerRows),
    '### Incomplete searches that returned at most one page',
    table(['cell', 'arm', 'incomplete searches', 'no pages', 'one page'], fewRows)].join('\n\n');
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const take = (n: string) => { const i = argv.indexOf(n); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
  const recount = resolve(take('--recount') ?? 'recount');
  const s1b = take('--stage1b');
  const cells: CellResult[] = JSON.parse(readFileSync(join(recount, 'cells.json'), 'utf8'));
  const dirs = argv.map(d => resolve(d));
  const out = ['## States by engine, corpus and caller', stateTable(cells), '## The rule\'s flip side in stage 1', ruleTable(cells), '## Cells that lose, stay unresolved or regress', blockingTable(cells),
    '## Re-runs', rerunTable(cells), '## Searches gbrain flagged incomplete', incompleteTable(cells, dirs)];
  const stage1b: CellResult[] | null = s1b ? JSON.parse(readFileSync(join(resolve(s1b), 'cells.json'), 'utf8')) : null;
  if (stage1b) out.push('## Stage 1b', stage1bTable(stage1b));
  out.push('## Figures in the prose', figures(cells, stage1b, dirs));
  console.log(out.join('\n\n'));
}

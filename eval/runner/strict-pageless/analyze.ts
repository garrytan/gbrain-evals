/**
 * Analysis for the strict-pageless cell (docs/benchmarks/2026-11-12-strict-pageless-facts-preregistration.md, "Analysis").
 * Reads the four cells' episode records, writes one outcome row per trial (outcomes.jsonl) and a summary (summary.json):
 * per cell the trial, exposure, kept-in-Git, truthful and secondary counts and the ledger cost; per model and pooled the
 * paired after-minus-before differences, paired by item and replicate, with two 95% intervals: an item-cluster bootstrap
 * (the 24 items resampled with replacement, 10,000 draws, seed 449, percentile) and Newcombe's hybrid score interval for
 * paired proportions (method 10), which ignores the clustering.
 *
 *   bun eval/runner/strict-pageless/analyze.ts --before <sha> --after <sha> --runs <dir> --out <dir>
 * <dir>/<model-id>-<sha8>/item-<id>-r<k>.json is a cell's episode.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MODELS = ['gpt-6.1-sol', 'claude-opus-5-5'] as const;
export const OUTCOMES = ['kept_in_git', 'truthful', 'exposure', 'located', 'false_no_repo', 'entity_page_created'] as const;
type Row = Record<string, any>;

export function outcomeRow(r: Row, arm: 'before' | 'after'): Row {
  return {
    model: r.loop_model, arm, gbrain_commit: r.gbrain.commit, gbrain_version: r.gbrain.version, item: r.item.id, replicate: r.replicate, kind: r.item.kind,
    slug_given: r.item.slug_given, ask: r.item.ask, stop: r.loop.stop, turns: r.loop.turns,
    exposure: r.exposure, kept_in_git: r.kept_in_git, truthful: r.report.truthful, located: r.report.located, wrong: r.report.wrong,
    false_no_repo: r.report.false_no_repo, entity_page_created: r.truth.entity_page_at_end, token_in_git: r.truth.token_in_git,
    token_on_hold: r.truth.token_on_hold, token_on_entity_page: r.truth.token_on_entity_page, fact_row_active: r.truth.fact_row_active,
    remember_calls: r.remembers.length, remember_entities: r.remembers.map((x: Row) => x.entity), reply_pages: r.remembers.map((x: Row) => x.reply_page),
    entity_page_missing_notices: r.remembers.reduce((n: number, x: Row) => n + (x.notices?.length ?? 0), 0),
    tools: r.tool_calls.map((c: Row) => c.name), usd: r.usd,
  };
}

function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function wilson(x: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.959964, p = x / n, den = 1 + z * z / n, mid = (p + z * z / (2 * n)) / den, half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den;
  return [Math.max(0, mid - half), Math.min(1, mid + half)];
}

/** Newcombe (1998) method 10: difference after - before of paired proportions. */
export function newcombe(pairs: Array<[boolean, boolean]>): [number, number] {
  const n = pairs.length;
  let a = 0, b = 0, c = 0, d = 0;
  for (const [before, after] of pairs) { if (before && after) a++; else if (before) b++; else if (after) c++; else d++; }
  const p1 = (a + b) / n, p2 = (a + c) / n, delta = p2 - p1;
  const [l1, u1] = wilson(a + b, n), [l2, u2] = wilson(a + c, n);
  const den = Math.sqrt((a + b) * (c + d) * (a + c) * (b + d));
  const num = a * d - b * c;
  const phi = den === 0 ? 0 : (num > 0 ? Math.max(num - n / 2, 0) : num) / den;
  const lo = delta - Math.sqrt(Math.max(0, (p2 - l2) ** 2 - 2 * phi * (p2 - l2) * (u1 - p1) + (u1 - p1) ** 2));
  const hi = delta + Math.sqrt(Math.max(0, (u2 - p2) ** 2 - 2 * phi * (u2 - p2) * (p1 - l1) + (p1 - l1) ** 2));
  return [Math.max(-1, lo), Math.min(1, hi)];
}

/** Item-cluster bootstrap of the mean paired difference: resample items, keep each item's pairs together. */
export function clusterBootstrap(pairs: Array<{ item: number; before: boolean; after: boolean }>, draws = 10_000, seed = 449): [number, number] {
  const items = [...new Set(pairs.map(p => p.item))].sort((x, y) => x - y);
  const by = new Map(items.map(i => [i, pairs.filter(p => p.item === i).map(p => Number(p.after) - Number(p.before))]));
  const r = rng(seed), stats: number[] = [];
  for (let k = 0; k < draws; k++) {
    let sum = 0, n = 0;
    for (let j = 0; j < items.length; j++) { const ds = by.get(items[Math.floor(r() * items.length)]!)!; for (const x of ds) { sum += x; n++; } }
    stats.push(sum / n);
  }
  stats.sort((x, y) => x - y);
  return [stats[Math.floor(0.025 * draws)]!, stats[Math.ceil(0.975 * draws) - 1]!];
}

function paired(rows: Row[], outcome: string) {
  const before = new Map(rows.filter(r => r.arm === 'before').map(r => [`${r.model}|${r.item}|${r.replicate}`, r]));
  const pairs = rows.filter(r => r.arm === 'after').flatMap(r => { const b = before.get(`${r.model}|${r.item}|${r.replicate}`); return b ? [{ item: r.item, before: Boolean(b[outcome]), after: Boolean(r[outcome]) }] : []; });
  const n = pairs.length, nb = pairs.filter(p => p.before).length, na = pairs.filter(p => p.after).length;
  return { pairs: n, before: nb, after: na, before_rate: nb / n, after_rate: na / n, diff: (na - nb) / n,
    discordant: { before_only: pairs.filter(p => p.before && !p.after).length, after_only: pairs.filter(p => !p.before && p.after).length },
    ci95_cluster_bootstrap: n ? clusterBootstrap(pairs) : null, ci95_newcombe: n ? newcombe(pairs.map(p => [p.before, p.after])) : null };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const before = get('--before')!.slice(0, 8), after = get('--after')!.slice(0, 8), runs = get('--runs')!, out = get('--out')!;
  const rows: Row[] = [], cells: Row[] = [];
  for (const model of MODELS) for (const [arm, sha] of [['before', before], ['after', after]] as const) {
    const dir = join(runs, `${model}-${sha}`);
    const files = existsSync(dir) ? readdirSync(dir).filter(f => /^item-\d+-r\d+\.json$/.test(f)).sort() : [];
    const recs = files.map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')));
    const cellRows = recs.map(r => outcomeRow(r, arm)).sort((x, y) => x.replicate - y.replicate || x.item - y.item);
    rows.push(...cellRows);
    const count = (k: string) => cellRows.filter(r => r[k]).length;
    const extra = existsSync(dir) ? readdirSync(dir).filter(f => /errored|harness-error/.test(f)).sort().map(f => JSON.parse(readFileSync(join(dir, f), 'utf8'))) : [];
    cells.push({ model, arm, gbrain: sha, trials: cellRows.length, ...Object.fromEntries(OUTCOMES.map(k => [k, count(k)])),
      usd_counted_episodes: cellRows.reduce((s, r) => s + Number(r.usd ?? 0), 0), usd_errored_attempts: extra.reduce((s, r) => s + Number(r.usd ?? 0), 0),
      errored_or_harness_attempts: extra.length, stops: cellRows.reduce((m: Row, r) => (m[r.stop] = (m[r.stop] ?? 0) + 1, m), {}) });
  }
  const comparisons: Row = {};
  for (const scope of [...MODELS, 'pooled']) {
    const rs = scope === 'pooled' ? rows : rows.filter(r => r.model === scope);
    comparisons[scope] = Object.fromEntries(OUTCOMES.map(k => [k, paired(rs, k)]));
    comparisons[scope].kept_in_git_exposed_both = paired(rs.filter(r => r.exposure), 'kept_in_git');
    for (const ask of ['where', 'on_page'] as const) comparisons[scope][`truthful_ask_${ask}`] = paired(rs.filter(r => r.ask === ask), 'truthful');
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'outcomes.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(out, 'summary.json'), JSON.stringify({ before, after, cells, comparisons }, null, 1));
  console.log(JSON.stringify({ cells, primary: Object.fromEntries(Object.entries(comparisons).map(([k, v]) => [k, { kept_in_git: v.kept_in_git, truthful: v.truthful }])) }, null, 1));
}

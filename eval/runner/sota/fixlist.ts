/**
 * The weekly fix list (SOTA plan item 7, decision D6a): at most three fixes for gbrain's crew, ranked by the pass-rate
 * points each could return, from the week's attribution (failure-causes/attribution.ts).
 *
 *   bun eval/runner/sota/fixlist.ts --attribution <attribution.json> --fixes eval/data/nightly/fixes.json
 *       [--previous <last week's fixlist.json>] --out <fixlist.json>
 *
 * A candidate is one recoverable bucket and cause (retrieval_lost with wrong_ranking, context_use with time_reasoning),
 * built from the failed rows someone has shown can pass: the oracle passes them (every retrieval_lost and context_use
 * row), or the benchmark's leader solved them with the same reader (a reader_limited row counts only then). Rows whose
 * cause isn't gbrain's (harness_error, item_unsupported, reader_budget, model_error) or has no label (unclassified, or
 * still waiting for the labeller) never enter. A candidate's points are the mean, over the attribution's QA suite and
 * reader cells, of the pass-rate points its rows hold in each cell: an upper bound, every row passing.
 *
 * Each item carries its public example ids, its leader-solved and oracle-solved counts, the D6a prediction (the
 * bucket's held-out share, measured in custody, times the fix's success rate on its own dev items, times a fixed 0.5
 * prior; until custody measures the share, the dev bound with full success) and the keyless gbrain test shape, with an
 * issue body in the weekly cause issues' shape (GST-2358) and a signature to find the open issue by.
 *
 * changed is true only when the ranking (the ordered signatures) differs from the previous list's or a fix in
 * fixes.json is new since it, so the loop refiles nothing on a week that moved only the points. A stale attribution
 * files nothing: changed is false and the previous ranking and fixes are carried, so next week compares with the last
 * list that was filed.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { RECOVERABLE, type Attribution, type AttributedRow, type Bucket } from '../failure-causes/attribution.ts';
import { REGRESSION_TESTS } from '../failure-causes/report.ts';
import { ATTRIBUTION_BUCKETS, causeInfo, type Cause } from '../failure-causes/taxonomy.ts';
import type { Fix } from '../nightly/report.ts';
import { assertNoSealedIds } from './sealed-guard.ts';

export type { Fix };

export const FIXLIST_SCHEMA = 'sota-fixlist/1';
export const MAX_ITEMS = 3;
export const MAX_EXAMPLES = 5;
/** D6a's fixed prior, never fed back from results. */
export const PRIOR = 0.5;
export const NEVER_LISTED: ReadonlySet<string> = new Set(['harness_error', 'item_unsupported', 'reader_budget', 'model_error', 'unclassified']);

export interface FixItem {
  signature: string; bucket: Bucket; cause: string; title: string; points: number; rows: number; items: number;
  leader_solved: number; oracle_solved: number;
  cells: Array<{ suite: string; reader: string; rows: number; answerable_rows: number; points: number }>;
  examples: Array<{ case_id: string; evidence: string[]; leader_solved: boolean | null }>;
  prediction: { rule: string; held_out_share: number | null; success_rate: number | null; prior: number; dev_bound_points: number; points: number | null };
  test_shape: string; body: string;
}
export interface FixList {
  schema: typeof FIXLIST_SCHEMA; status: Attribution['status']; changed: boolean; why: string[];
  devset: string; taxonomy_version: string; ranking: string[]; fixes_seen: string[]; items: FixItem[];
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const fixId = (f: Fix) => `${f.issue}|${f.pr}`;
const bucketText = (b: Bucket) => ATTRIBUTION_BUCKETS.find(x => x.id === b)!.meaning;
const causeTitle = (c: string) => causeInfo(c)?.title ?? c;

/** A row someone has shown can pass, with a cause that is gbrain's to fix. */
export const eligible = (r: AttributedRow): boolean =>
  RECOVERABLE.includes(r.bucket) && !!r.cause && !NEVER_LISTED.has(r.cause) && (r.oracle === 'pass' || r.leader_solved === true);

function candidate(bucket: Bucket, cause: string, rows: AttributedRow[], a: Attribution): FixItem {
  const signature = `sota:${bucket}:${cause}`;
  const live = a.cells.filter(c => c.answerable_rows > 0);
  const cells = live.map(c => {
    const n = rows.filter(r => r.suite === c.suite && r.reader === c.reader).length;
    return { suite: c.suite, reader: c.reader, rows: n, answerable_rows: c.answerable_rows, points: round2((100 * n) / c.answerable_rows) };
  }).filter(c => c.rows > 0);
  const points = round2(live.length ? cells.reduce((s, c) => s + (100 * c.rows) / c.answerable_rows, 0) / live.length : 0);
  const leader = rows.filter(r => r.leader_solved === true).length, oracle = rows.filter(r => r.oracle === 'pass').length;
  const items = new Set(rows.map(r => `${r.suite}|${r.item}`)).size;
  const shown = rows.filter(r => r.visibility === 'public' || r.visibility === 'synthetic')
    .sort((x, y) => Number(y.leader_solved === true) - Number(x.leader_solved === true) || x.case_id.localeCompare(y.case_id) || x.run_id.localeCompare(y.run_id));
  const examples = [...new Map(shown.map(r => [r.case_id, { case_id: r.case_id, evidence: r.evidence, leader_solved: r.leader_solved }])).values()].slice(0, MAX_EXAMPLES);
  const dev_bound_points = round2(points * PRIOR);
  const test_shape = REGRESSION_TESTS[cause as Cause] ?? 'to be written';
  const title = `${causeTitle(cause)} (${bucket.replace('_', ' ')}): up to ${points.toFixed(1)} points over ${rows.length} failed rows`;
  const body = [
    `**Fix target:** ${causeTitle(cause)} (\`${cause}\`, gap map ${causeInfo(cause)?.gap_map ?? '?'}) in the \`${bucket}\` bucket. ${bucketText(bucket)}`,
    `**Recoverable points:** up to ${points.toFixed(1)} pass-rate points, the mean over ${live.length} QA suite and reader cells, if every row here passed (an upper bound). ${cells.map(c => `${c.suite} with ${c.reader}: ${c.rows} of ${c.answerable_rows} answerable rows (${c.points.toFixed(1)} points)`).join('; ')}.`,
    `**Shown solvable:** the benchmark's leader solved ${leader} of ${rows.length} rows with the same reader; the oracle (the same reader given only the gold evidence) solved ${oracle}. ${items} distinct items.`,
    `**Prediction (D6a):** held-out share of the bucket × success on its own dev items × ${PRIOR}. Custody has not measured the held-out share yet, so the bound from dev, with every dev item fixed, is ${dev_bound_points.toFixed(1)} points.`,
    '**Examples (public or synthetic):**', ...(examples.length ? examples.map(e => `- \`${e.case_id}\`: ${e.evidence.join('; ') || 'no pointer'}${e.leader_solved ? ' (leader solved)' : ''}`) : ['- none from a public or synthetic source this week']),
    `**Keyless gbrain test shape:** ${test_shape}`,
    `Signature: \`${signature}\``,
  ].join('\n');
  return {
    signature, bucket, cause, title, points, rows: rows.length, items, leader_solved: leader, oracle_solved: oracle, cells, examples,
    prediction: { rule: 'held-out bucket share × success on own dev items × 0.5', held_out_share: null, success_rate: null, prior: PRIOR, dev_bound_points, points: null },
    test_shape, body,
  };
}

/** The fix list from one week's attribution, the fixes shipped so far and last week's list. */
export function fixList(a: Attribution, fixes: readonly Fix[], previous: FixList | null): FixList {
  const base = { schema: FIXLIST_SCHEMA, status: a.status, devset: a.devset, taxonomy_version: a.taxonomy_version } as const;
  if (a.status === 'stale') return { ...base, changed: false, why: ['attribution is stale: nothing filed'], ranking: previous?.ranking ?? [], fixes_seen: previous?.fixes_seen ?? [], items: [] };
  const groups = new Map<string, AttributedRow[]>();
  for (const r of a.rows.filter(eligible)) groups.set(`${r.bucket}\u0000${r.cause}`, [...(groups.get(`${r.bucket}\u0000${r.cause}`) ?? []), r]);
  const items = [...groups].map(([k, rows]) => { const [b, c] = k.split('\u0000') as [Bucket, string]; return candidate(b, c, rows, a); })
    .sort((x, y) => y.points - x.points || y.leader_solved - x.leader_solved || x.signature.localeCompare(y.signature)).slice(0, MAX_ITEMS);
  const ranking = items.map(i => i.signature);
  const fixes_seen = fixes.map(fixId).sort();
  const landed = fixes.filter(f => !(previous?.fixes_seen ?? []).includes(fixId(f)));
  const moved = !previous || previous.ranking.join('\n') !== ranking.join('\n');
  const why = [
    ...(!previous ? ['first fix list'] : moved ? [`ranking moved: ${previous.ranking.join(', ') || 'none'} -> ${ranking.join(', ') || 'none'}`] : []),
    ...(previous ? landed.map(f => `fix landed: ${f.issue} (${f.pr}, gbrain ${f.gbrain_version})`) : []),
  ];
  return { ...base, changed: why.length > 0, why, ranking, fixes_seen, items };
}

/** The fix list file's text, refused when it would carry a sealed id. */
export function fixListText(f: FixList, where: string): string {
  const text = JSON.stringify(f, null, 1) + '\n';
  assertNoSealedIds(text, where);
  return text;
}

const flag = (argv: string[], name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const need = (argv: string[], name: string) => { const v = flag(argv, name); if (!v) throw new Error(`pass ${name}`); return v; };
const readJson = <T>(path: string): T => { if (!existsSync(path)) throw new Error(`${path} does not exist`); return JSON.parse(readFileSync(path, 'utf8')) as T; };

export function main(argv: string[], log: (s: string) => void = console.log): number {
  const a = readJson<Attribution>(need(argv, '--attribution'));
  const fixes = readJson<{ fixes: Fix[] }>(need(argv, '--fixes')).fixes;
  const prev = flag(argv, '--previous');
  const previous = prev ? readJson<FixList>(prev) : null;
  if (previous && previous.schema !== FIXLIST_SCHEMA) throw new Error(`${prev} is not a ${FIXLIST_SCHEMA} file`);
  const out = need(argv, '--out');
  const f = fixList(a, fixes, previous);
  writeFileSync(out, fixListText(f, out));
  log(JSON.stringify({ status: f.status, changed: f.changed, why: f.why, items: f.items.map(i => ({ signature: i.signature, points: i.points, leader_solved: i.leader_solved, rows: i.rows, test_shape: i.test_shape })) }, null, 1));
  return 0;
}

if (import.meta.main) {
  try { process.exit(main(process.argv.slice(2))); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
}

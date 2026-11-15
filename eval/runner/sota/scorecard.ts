/**
 * The monthly SOTA scorecard (SOTA plan item 9, decision D1a). One row per benchmark and leader: gbrain minus the leader
 * on questions gbrain was never tuned on, in the answerable classes, as the mean over the three readers under test
 * (claude-opus-5-5, gpt-6.1-sol, particle-1) with a conversation-clustered 95% interval, in points.
 *
 *   bun eval/runner/sota/scorecard.ts --rows <rows.json> [--previous <last month's scorecard.json>] [--quarter-call <2027-Q1>]
 *       --takeaways <three-line file> --out <scorecard.md outside the repo>
 *
 * Status, first that applies: ahead when the interval's lower bound is above 0; behind when its upper bound is below 0;
 * at parity when it holds 0 and sits strictly inside ±3.5 points (the margin Garry approved for RS1); not enough data
 * otherwise, or with no interval. A row with other readers, or on dev questions, is descriptive; a row whose questions
 * are sealed reads "sealed, pending RS1 verdict" until RS1's verdict is written. The status is called once a quarter at a
 * fixed horizon (--quarter-call); a monthly row shows it as trend only, beside the change since last month. Cost per
 * correct answer and p50 latency sit beside every row.
 *
 * The scorecard carries spend, so it is written to the Captain drive and never into this repository (R79); --out inside
 * the repository is refused. It opens with three plain takeaways the writer supplies.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { assertNoSealedIds } from './sealed-guard.ts';

export const SCORECARD_SCHEMA = 'sota-scorecard/1';
export const MARGIN = 3.5;
export const READERS = ['claude-opus-5-5', 'gpt-6.1-sol', 'particle-1'] as const;
const REPO = resolve(import.meta.dir, '../../..');

export type Status = 'ahead' | 'behind' | 'at_parity' | 'not_enough_data';
export interface Interval { estimate: number; lo: number; hi: number }
export interface ScoreRow {
  benchmark: string; leader: string; source: string; gbrain_pin: string; date: string; readers: string[];
  split: 'held_out' | 'dev'; sealed_pending: boolean;
  gbrain_points: number | null; leader_points: number | null; delta: Interval | null;
  gbrain_cost_per_correct: number | null; leader_cost_per_correct: number | null; gbrain_p50_s: number | null; leader_p50_s: number | null;
}
export interface ScoredRow extends ScoreRow {
  status: Status | 'descriptive' | 'sealed_pending'; reason: string | null; called: string | null; trend_points: number | null;
}
export interface Scorecard { schema: typeof SCORECARD_SCHEMA; month: string; quarter_call: string | null; takeaways: string[]; rows: ScoredRow[] }

/** D1a's status for an interval of gbrain minus the leader, in points, in its order of precedence. */
export function status(d: Interval | null, margin = MARGIN): Status {
  if (!d) return 'not_enough_data';
  if (d.lo > 0) return 'ahead';
  if (d.hi < 0) return 'behind';
  if (d.lo <= 0 && d.hi >= 0 && d.lo > -margin && d.hi < margin) return 'at_parity';
  return 'not_enough_data';
}

const sameReaders = (r: readonly string[]) => r.length === READERS.length && READERS.every(x => r.includes(x));

/** A row's status, whether this month calls it, and its change since last month's row for the same benchmark and leader. */
export function scoreRow(row: ScoreRow, o: { quarterCall: string | null; previous: readonly ScoreRow[] }): ScoredRow {
  const prev = o.previous.find(p => p.benchmark === row.benchmark && p.leader === row.leader);
  const trend_points = prev?.delta && row.delta ? Math.round((row.delta.estimate - prev.delta.estimate) * 100) / 100 : null;
  const out = (s: ScoredRow['status'], reason: string | null, called: string | null = null): ScoredRow => ({ ...row, status: s, reason, called, trend_points });
  if (row.sealed_pending) return out('sealed_pending', 'sealed, pending RS1 verdict');
  if (!sameReaders(row.readers)) return out('descriptive', `readers ${row.readers.join(', ')}, not the three under test`);
  if (row.split !== 'held_out') return out('descriptive', 'dev questions: gbrain was tuned on them');
  return out(status(row.delta), null, o.quarterCall);
}

export function scorecard(rows: readonly ScoreRow[], o: { month: string; quarterCall?: string | null; previous?: Scorecard | null; takeaways: readonly string[] }): Scorecard {
  const takeaways = o.takeaways.map(t => t.trim()).filter(Boolean);
  if (takeaways.length !== 3) throw new Error(`a scorecard opens with three plain takeaways; got ${takeaways.length}`);
  return { schema: SCORECARD_SCHEMA, month: o.month, quarter_call: o.quarterCall ?? null, takeaways,
    rows: rows.map(r => scoreRow(r, { quarterCall: o.quarterCall ?? null, previous: o.previous?.rows ?? [] })) };
}

const num = (x: number | null, digits = 1) => (x === null ? 'n/a' : x.toFixed(digits));
const usd = (x: number | null) => (x === null ? 'n/a' : `$${x.toFixed(3)}`);
const words: Record<ScoredRow['status'], string> = { ahead: 'ahead', behind: 'behind', at_parity: 'at parity', not_enough_data: 'not enough data', descriptive: 'descriptive', sealed_pending: 'sealed, pending RS1 verdict' };

export function renderScorecard(s: Scorecard): string {
  const statusCell = (r: ScoredRow) => (r.status === 'descriptive' || r.status === 'sealed_pending' ? words[r.status] : r.called ? `${words[r.status]} (called ${r.called})` : `trend: ${words[r.status]}`);
  return [
    `# gbrain against the state of the art: ${s.month}`, '',
    ...s.takeaways.map((t, i) => `${i + 1}. ${t}`), '',
    `Each row is gbrain minus the benchmark's leader in points, the mean over ${READERS.join(', ')}, with a conversation-clustered 95% interval. Ahead: the interval is above 0. Behind: below 0. At parity: it holds 0 and sits inside ±${MARGIN} points. Otherwise not enough data. ${s.quarter_call ? `This month calls the quarterly status (${s.quarter_call}).` : 'Statuses are called once a quarter; this month shows them as trend only.'}`, '',
    '| Benchmark | Leader | gbrain | Leader score | gbrain minus leader (95% interval) | Change since last month | Status | Cost per correct (gbrain / leader) | p50 latency s (gbrain / leader) | Readers | gbrain pin | Date | Source |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...s.rows.map(r => `| ${r.benchmark} | ${r.leader} | ${num(r.gbrain_points)} | ${num(r.leader_points)} | ${r.delta ? `${num(r.delta.estimate)} (${num(r.delta.lo)} to ${num(r.delta.hi)})` : 'n/a'} | ${r.trend_points === null ? 'n/a' : `${r.trend_points > 0 ? '+' : ''}${num(r.trend_points)}`} | ${statusCell(r)}${r.reason && r.status === 'descriptive' ? `: ${r.reason}` : ''} | ${usd(r.gbrain_cost_per_correct)} / ${usd(r.leader_cost_per_correct)} | ${num(r.gbrain_p50_s)} / ${num(r.leader_p50_s)} | ${r.readers.join(', ')} | ${r.gbrain_pin} | ${r.date} | ${r.source} |`),
    '',
  ].join('\n');
}

const flag = (argv: string[], name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const need = (argv: string[], name: string) => { const v = flag(argv, name); if (!v) throw new Error(`pass ${name}`); return v; };

/** Refuses a path inside this repository: the scorecard carries spend. */
export function assertOutsideRepo(path: string, repo = REPO): void {
  const rel = relative(repo, resolve(path));
  if (!rel.startsWith('..') && !isAbsolute(rel)) throw new Error(`SCORECARD_IN_REPO: ${path} is inside the repository; the scorecard carries spend and goes to the Captain drive (R79)`);
}

export function main(argv: string[], log: (s: string) => void = console.log): number {
  const out = need(argv, '--out');
  assertOutsideRepo(out);
  const rows = (JSON.parse(readFileSync(need(argv, '--rows'), 'utf8')) as { rows: ScoreRow[] }).rows;
  const prev = flag(argv, '--previous');
  const previous = prev ? JSON.parse(readFileSync(prev, 'utf8')) as Scorecard : null;
  const month = rows.map(r => r.date.slice(0, 7)).sort().at(-1) ?? 'no rows';
  const s = scorecard(rows, { month, quarterCall: flag(argv, '--quarter-call') ?? null, previous, takeaways: readFileSync(need(argv, '--takeaways'), 'utf8').split('\n') });
  const md = renderScorecard(s), json = JSON.stringify(s, null, 1) + '\n';
  assertNoSealedIds(md + json, out);
  writeFileSync(out, md);
  writeFileSync(out.replace(/\.md$/, '') + '.json', json);
  log(JSON.stringify(s.rows.map(r => ({ benchmark: r.benchmark, leader: r.leader, status: r.status, called: r.called })), null, 1));
  return 0;
}

if (import.meta.main) {
  try { process.exit(main(process.argv.slice(2))); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
}

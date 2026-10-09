/**
 * The pilot's preregistered decision ($0) from the report rows: exact McNemar
 * against A0 on the same reader, the off-ramp checks at the working tolerance
 * (3.0 points, provisional on T0), CACHE dollars per read at r = 1, 2, 5, and
 * the write-time cost of DIGEST.
 */
import { exactMcNemar, type PairedItem } from '../stats/paired.ts';
import { cachedUsdPerRead } from './cells.ts';

export const TOLERANCE_POINTS = 3.0;
export const COMMITTED_WRONG_SLACK = 3;

interface Row { cell: string; n: number; correct: number; committed_wrong: number; usd_per_q: number; discordance_vs_a0: { a0_right_arm_wrong: number; a0_wrong_arm_right: number } | null; p95_ms: number | null; digest_write_usd_per_q: number | null }

export function mcnemarP(d: { a0_right_arm_wrong: number; a0_wrong_arm_right: number }): number {
  const pairs: PairedItem[] = [...Array(d.a0_right_arm_wrong).fill([1, 0]), ...Array(d.a0_wrong_arm_right).fill([0, 1])].map(([a, b], i) => ({ id: String(i), cluster: String(i), a, b }));
  return pairs.length ? exactMcNemar(pairs).p_two_sided : 1;
}

export function decide(rows: Row[], cohort: Array<Record<string, any>>) {
  const by = new Map(rows.map(r => [r.cell, r]));
  const pts = (r: Row) => (100 * r.correct) / r.n;
  const reader = 'claude-sonnet-5-5';
  const a0 = by.get(`a0:${reader}`)!;
  const briefs = ['gpt-6-luna', 'claude-haiku-5-5'].map(b => by.get(`brief@2000:${b}:${reader}`)!);
  const briefMisses = briefs.every(b => pts(a0) - pts(b) > TOLERANCE_POINTS);
  const best = [...briefs].sort((x, y) => y.correct - x.correct || x.usd_per_q - y.usd_per_q)[0];
  const p95 = (cell: string) => {
    const t = cohort.filter(r => r.cell === cell && !r.error).map(r => r.total_ms as number).sort((a, b) => a - b);
    return t.length ? t[Math.min(t.length - 1, Math.ceil(0.95 * t.length) - 1)] : null;
  };
  const cheaper = rows.filter(r => /^(direct|fallback|digest@\d+|cache):/.test(r.cell) && (r.cell.endsWith(reader) || r.cell.startsWith('direct:')))
    .map(r => {
      const cohortCell = r.cell.startsWith('digest@') ? r.cell.replace(/digest@\d+/, 'digest@2000') : r.cell;
      const pr = p95(cohortCell), pb = p95(best.cell);
      const matches = pts(r) >= pts(best) - TOLERANCE_POINTS && r.committed_wrong <= best.committed_wrong + COMMITTED_WRONG_SLACK;
      return { cell: r.cell, success: r.correct, committed_wrong: r.committed_wrong, usd_per_q: r.usd_per_q, p95_ms: pr, matches_accuracy_and_cw: matches, cheaper: r.usd_per_q < best.usd_per_q, faster: pr !== null && pb !== null && pr < pb, wins: matches && r.usd_per_q < best.usd_per_q && pr !== null && pb !== null && pr < pb };
    });
  const offRamp = briefMisses || cheaper.some(c => c.wins);
  return {
    tolerance_points: TOLERANCE_POINTS, tolerance_status: 'the plan proposal, used as a working value; T0 froze the same 3.0 points (1e5caf37)',
    reader, a0: { cell: a0.cell, success: a0.correct, committed_wrong: a0.committed_wrong, usd_per_q: a0.usd_per_q, p95_ms: p95(a0.cell) },
    briefs_at_2000: briefs.map(b => ({ cell: b.cell, success: b.correct, gap_points: pts(a0) - pts(b), within_tolerance: pts(a0) - pts(b) <= TOLERANCE_POINTS, committed_wrong: b.committed_wrong, usd_per_q: b.usd_per_q, p95_ms: p95(b.cell), mcnemar_p: b.discordance_vs_a0 ? mcnemarP(b.discordance_vs_a0) : null })),
    best_brief: best.cell, brief_misses: briefMisses, cheaper_designs: cheaper, off_ramp_fires: offRamp,
    verdict: briefMisses ? 'off-ramp: the brief misses the tolerance at 2,000 tokens for both builders' : cheaper.some(c => c.wins) ? `off-ramp: ${cheaper.filter(c => c.wins).map(c => c.cell).join(', ')} matches the brief at lower dollars and latency` : `the brief qualifies for A6: ${best.cell}`,
  };
}

/** CACHE dollars per read from the cohort's cold/warm pairs. */
export function cacheDollars(cohort: Array<Record<string, any>>, model: string) {
  const cell = `cache:${model}`;
  const pairs = new Map<string, { cold?: any; warm?: any }>();
  for (const r of cohort.filter(x => x.cell === cell && !x.error)) { const p = pairs.get(r.question_id) ?? {}; p[r.warm ? 'warm' : 'cold'] = r; pairs.set(r.question_id, p); }
  const full = [...pairs.values()].filter(p => p.cold?.usage && p.warm?.usage);
  const per = (reads: number) => full.reduce((a, p) => a + cachedUsdPerRead(model, p.cold.usage, p.warm.usage, reads), 0) / Math.max(1, full.length);
  return { pairs: full.length, warm_hits: full.filter(p => p.warm.cache_read > 0).length, usd_per_read: { r1: per(1), r2: per(2), r5: per(5) } };
}

/**
 * Keyless recount of the System One v1 receipts.
 *
 * Two summaries in the 2026-09-30 record are pure arithmetic over committed
 * per-item rows: the S7 triage matched pair (gbrain's summarize-pair.ts) and
 * the LongMemEval arms (gbrain's lme-summarize.py). Both are reimplemented
 * here, independently of the gbrain code under test, and compared with the
 * summaries gbrain published. The slots whose verdict needs gbrain's
 * production reducer (S2, S6, S8, S9) are recomputed by `system-one-jev.ts
 * analyze` against a gbrain checkout instead.
 *
 * LongMemEval rows are the compacted ones gbrain committed: `top_session`
 * stands in for `retrieved[0].session_id`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function percentile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
}

/** Exact two-sided McNemar: a binomial test on the discordant pairs. */
export function mcnemar(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let p = 0;
  let coef = 1;
  for (let i = 0; i <= n; i++) {
    if (i > 0) coef = (coef * (n - i + 1)) / i;
    if (i <= k) p += coef;
  }
  return Math.min(1, (2 * p) / 2 ** n);
}

export function readJsonl<T = Record<string, unknown>>(path: string): T[] {
  return readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as T);
}

// ─── S7 triage pair ────────────────────────────────────────────────

export interface TriageRow { id: string; label: boolean; worth: boolean; path?: string; decide_outcome?: string | null; latency_ms: number; llm_usd: number; decide_usd: number }

export function summarizeTriage(rows: readonly TriageRow[]) {
  const tp = rows.filter(r => r.label && r.worth).length;
  const fn = rows.filter(r => r.label && !r.worth).length;
  const fp = rows.filter(r => !r.label && r.worth).length;
  const tn = rows.filter(r => !r.label && !r.worth).length;
  const lat = rows.map(r => r.latency_ms);
  const usd = rows.reduce((a, r) => a + r.llm_usd + r.decide_usd, 0);
  const bySource = (pred: (r: TriageRow) => boolean) => {
    const s = rows.filter(pred);
    return { n: s.length, positives_missed: s.filter(r => r.label && !r.worth).length, negatives_rejected: s.filter(r => !r.label && !r.worth).length, negatives: s.filter(r => !r.label).length, positives: s.filter(r => r.label).length };
  };
  const paths: Record<string, number> = {};
  for (const r of rows) { const k = `${r.path ?? 'llm'}${r.decide_outcome ? `:${r.decide_outcome}` : ''}`; paths[k] = (paths[k] ?? 0) + 1; }
  return {
    n: rows.length, tp, fn, fp, tn,
    accuracy: (tp + tn) / rows.length, recall: tp / Math.max(1, tp + fn), specificity: tn / Math.max(1, tn + fp),
    sent_to_synthesis: tp + fp,
    cost_usd_total: usd, cost_usd_per_transcript: usd / rows.length,
    latency_ms: { p50: percentile(lat, 0.5), p95: percentile(lat, 0.95), p99: percentile(lat, 0.99), mean: lat.reduce((a, b) => a + b, 0) / lat.length },
    cat35: bySource(r => !r.id.startsWith('syn-')), synthetic_buried: bySource(r => r.id.startsWith('syn-buried')), synthetic_routine: bySource(r => r.id.startsWith('syn-routine')),
    paths,
  };
}

export function triageFlips(a: readonly TriageRow[], b: readonly TriageRow[]) {
  const m = new Map(b.map(r => [r.id, r.worth]));
  const shared = a.filter(r => m.has(r.id));
  const flips = shared.filter(r => m.get(r.id) !== r.worth).length;
  return { n: shared.length, flips, rate: flips / Math.max(1, shared.length) };
}

export function triageDiscordant(a: readonly TriageRow[], b: readonly TriageRow[]) {
  const m = new Map(b.map(r => [r.id, r]));
  const out = { b_right_a_wrong: 0, a_right_b_wrong: 0, ids_b_right: [] as string[], ids_a_right: [] as string[] };
  for (const r of a) {
    const s = m.get(r.id);
    if (!s || s.worth === r.worth) continue;
    if (s.worth === s.label) { out.b_right_a_wrong++; out.ids_b_right.push(r.id); } else { out.a_right_b_wrong++; out.ids_a_right.push(r.id); }
  }
  return out;
}

export function recountTriage(dir: string) {
  const load = (name: string) => readJsonl<TriageRow>(join(dir, name));
  const [a, a2, b, b2] = ['arm-off-1.jsonl', 'arm-off-2.jsonl', 'arm-on-1.jsonl', 'arm-on-2.jsonl'].map(load) as [TriageRow[], TriageRow[], TriageRow[], TriageRow[]];
  const d = triageDiscordant(a, b);
  return {
    a: summarizeTriage(a), b: summarizeTriage(b),
    retest: { a: triageFlips(a, a2), b: triageFlips(b, b2), a2: summarizeTriage(a2), b2: summarizeTriage(b2) },
    discordant: d, mcnemar_p: mcnemar(d.b_right_a_wrong, d.a_right_b_wrong),
  };
}

// ─── LongMemEval arms ──────────────────────────────────────────────

interface PoolAt { present?: number; all?: boolean; any?: boolean }
interface SlotMeta { cost_usd?: number; latency_ms?: number; outcomes?: Record<string, number>; skipped?: string; late?: boolean }
export interface LmeRow {
  question_id: string;
  recall_all_hit?: boolean;
  recall_any_hit?: boolean;
  distinct_sessions_in_top_k?: number;
  answer_session_ids?: string[];
  top_session?: string | null;
  retrieved?: { session_id?: string }[];
  decide?: Record<string, SlotMeta | unknown> | null;
  pool_recall?: { fused_pool_size?: number; at?: Record<string, PoolAt> } | null;
  error?: unknown;
}

const isAbstention = (r: LmeRow) => r.question_id.endsWith('_abs');

function top1(r: LmeRow): boolean {
  const top = r.top_session ?? r.retrieved?.[0]?.session_id;
  return typeof top === 'string' && (r.answer_session_ids ?? []).includes(top);
}

/** Python's round() to n decimals for the values lme-summarize.py rounds (ties are not expected in cost sums). */
const round = (x: number, n: number) => Math.round(x * 10 ** n) / 10 ** n;

export function summarizeLme(rows: ReadonlyMap<string, LmeRow>) {
  const all = [...rows.values()];
  const ans = all.filter(r => !isAbstention(r) && !r.error);
  const out: Record<string, unknown> = { questions: all.length, answerable: ans.length, errors: all.filter(r => r.error).length };
  const n = Math.max(1, ans.length);
  out['recall_all@5'] = ans.filter(r => r.recall_all_hit).length / n;
  out['recall_all@5_n'] = ans.filter(r => r.recall_all_hit).length;
  out['recall_any@5'] = ans.filter(r => r.recall_any_hit).length / n;
  out['R@1'] = ans.filter(top1).length / n;
  const pools = ans.map(r => r.pool_recall).filter((p): p is NonNullable<LmeRow['pool_recall']> => !!p);
  if (pools.length) {
    out.fused_pool_size_mean = pools.reduce((a, p) => a + (p.fused_pool_size ?? 0), 0) / pools.length;
    for (const depth of ['30', '50', '100', '300']) out[`pool_recall_all@${depth}`] = pools.filter(p => p.at?.[depth]?.all).length / pools.length;
    const present = ans.filter(r => r.pool_recall && r.pool_recall.at?.['300']?.any);
    out.top1_when_present = `${present.filter(top1).length}/${present.length}`;
  }
  const lat = ans.map(r => ((r.decide ?? {}) as Record<string, SlotMeta>).rerank?.latency_ms).filter((x): x is number => typeof x === 'number');
  if (lat.length) out.jev_rerank_latency_ms = { p50: percentile(lat, 0.5), p95: percentile(lat, 0.95), p99: percentile(lat, 0.99) };
  let cost = 0;
  const outcomes: Record<string, number> = {};
  for (const r of all) {
    for (const [slot, meta] of Object.entries((r.decide ?? {}) as Record<string, SlotMeta>)) {
      if (!meta || typeof meta !== 'object') continue;
      if (typeof meta.cost_usd === 'number') cost += meta.cost_usd;
      for (const [o, k] of Object.entries(meta.outcomes ?? {})) outcomes[`${slot}:${o}`] = (outcomes[`${slot}:${o}`] ?? 0) + k;
      if (meta.skipped) outcomes[`${slot}:skipped:${meta.skipped}`] = (outcomes[`${slot}:skipped:${meta.skipped}`] ?? 0) + 1;
      if (meta.late) outcomes[`${slot}:late`] = (outcomes[`${slot}:late`] ?? 0) + 1;
    }
  }
  out.decide_cost_usd_total = round(cost, 5);
  out.decide_cost_usd_per_question = round(cost / Math.max(1, all.length), 6);
  if (Object.keys(outcomes).length) out.decide_outcomes = outcomes;
  out.mean_distinct_sessions_top5 = ans.reduce((a, r) => a + (r.distinct_sessions_in_top_k ?? 0), 0) / n;
  return out;
}

export function pairedLme(base: ReadonlyMap<string, LmeRow>, arm: ReadonlyMap<string, LmeRow>, key: 'recall_all' | 'R@1') {
  const shared = [...base.keys()].filter(q => arm.has(q) && !q.endsWith('_abs'));
  const f = key === 'recall_all' ? (r: LmeRow) => !!r.recall_all_hit : top1;
  const wins = shared.filter(q => f(arm.get(q)!) && !f(base.get(q)!)).length;
  const losses = shared.filter(q => f(base.get(q)!) && !f(arm.get(q)!)).length;
  return { n: shared.length, wins, losses, mcnemar_p: round(mcnemar(wins, losses), 4) };
}

export function loadLmeRows(path: string): Map<string, LmeRow> {
  return new Map(readJsonl<LmeRow>(path).filter(r => 'question_id' in r).map(r => [r.question_id, r]));
}

/** Rebuild one gbrain LongMemEval summary file: the baseline arm, then each arm with its paired comparison. */
export function recountLmeSummary(rowsDir: string, baseline: string, arms: readonly string[]) {
  const base = loadLmeRows(join(rowsDir, `${baseline}.rows.jsonl`));
  const report: Record<string, Record<string, unknown>> = { [baseline]: summarizeLme(base) };
  for (const name of arms) {
    const rows = loadLmeRows(join(rowsDir, `${name}.rows.jsonl`));
    report[name] = { ...summarizeLme(rows), [`vs_${baseline}`]: { recall_all: pairedLme(base, rows, 'recall_all'), 'R@1': pairedLme(base, rows, 'R@1') } };
  }
  return report;
}

/** The three LongMemEval summaries whose per-question rows were committed. */
export const LME_SUMMARIES = [
  { summary: 's1/longmemeval-s-summary.json', baseline: 's_voy30', arms: ['s_off', 's_voy100', 's_jev30', 's_jev50', 's_jev100', 's_jev100b', 's_jev100x'] },
  { summary: 's1/longmemeval-m-pilot-summary.json', baseline: 'm_voy30', arms: ['m_off', 'm_jev100', 'm_jev300', 'm_jev100x'] },
  { summary: 's3/longmemeval-decide-arms-summary.json', baseline: 's_voy30', arms: ['s_s2', 's_s3', 's_s3s5'] },
] as const;

// ─── Comparison and ledger ─────────────────────────────────────────

/**
 * Every leaf of `published` must equal the recount: numbers within 1e-9
 * (relative), everything else exactly. Leaves only the recount has are
 * ignored; a published leaf the recount lacks is a mismatch.
 */
export function compareLeaves(published: unknown, recounted: unknown, path = ''): string[] {
  if (typeof published === 'number') {
    if (typeof recounted !== 'number') return [`${path}: published ${published}, recount ${JSON.stringify(recounted)}`];
    const tol = 1e-9 * Math.max(1, Math.abs(published));
    return Math.abs(published - recounted) <= tol ? [] : [`${path}: published ${published}, recount ${recounted}`];
  }
  if (published && typeof published === 'object') {
    if (!recounted || typeof recounted !== 'object') return [`${path}: published object, recount ${JSON.stringify(recounted)}`];
    return Object.entries(published as Record<string, unknown>).flatMap(([k, v]) => compareLeaves(v, (recounted as Record<string, unknown>)[k], `${path}/${k}`));
  }
  return published === recounted ? [] : [`${path}: published ${JSON.stringify(published)}, recount ${JSON.stringify(recounted)}`];
}

export interface LedgerLine { ts: string; purpose: string; provider: string; model: string; input_tokens: number | null; output_tokens: number | null; usd: number }

export function ledgerTotals(lines: readonly LedgerLine[]) {
  const byProvider: Record<string, number> = {};
  for (const l of lines) byProvider[l.provider] = (byProvider[l.provider] ?? 0) + l.usd;
  return { lines: lines.length, usd: lines.reduce((a, l) => a + l.usd, 0), by_provider: byProvider };
}

/** Full keyless recount of the receipts directory. */
export function recountAll(receiptsDir: string, ledgerDir: string) {
  const triage = recountTriage(join(receiptsDir, 's7'));
  const triageMismatches = compareLeaves(JSON.parse(readFileSync(join(receiptsDir, 's7/summary.json'), 'utf8')), triage, 's7/summary.json');
  const lme = LME_SUMMARIES.map(s => {
    const recount = recountLmeSummary(join(receiptsDir, 's1'), s.baseline, s.arms);
    const published = JSON.parse(readFileSync(join(receiptsDir, s.summary), 'utf8')) as Record<string, unknown>;
    const scoped = Object.fromEntries(Object.entries(published).filter(([arm]) => arm in recount));
    return { summary: s.summary, arms: Object.keys(recount), mismatches: compareLeaves(scoped, recount, s.summary), recount };
  });
  const lane = ledgerTotals(readJsonl<LedgerLine>(join(ledgerDir, 'ledger.jsonl')));
  const datasets = ledgerTotals(readJsonl<LedgerLine>(join(ledgerDir, 'ledger-datasets.jsonl')));
  return {
    s7: { mismatches: triageMismatches, recount: triage },
    longmemeval: lme,
    spend: { eval_lane: lane, dataset_building: datasets, total_usd: lane.usd + datasets.usd },
  };
}

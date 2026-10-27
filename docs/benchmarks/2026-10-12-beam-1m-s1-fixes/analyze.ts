/**
 * S1 summary: recomputes every number in the report from the committed rows under arms/ (and the gpt-6.1-sol floor
 * reused from the 2026-10-08 failure analysis), with paired cluster-bootstrap intervals over the 11 dev conversations,
 * and writes summary.json. Keyless and $0; with --check it exits 1 when the committed summary.json differs.
 * Usage: bun docs/benchmarks/2026-10-12-beam-1m-s1-fixes/analyze.ts [--check]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { clusteredPairedDelta } from '../../../eval/runner/stats/paired.ts';
import { DECLINE } from '../2026-10-08-beam-1m-failure-analysis/decline.ts';

const here = import.meta.dir;
type Receipt = { role: string; from_cache: boolean; finish: string | null };
type Row = {
  id: string; conversation: string; category: string; abstention: boolean; gold_count: number; retrieved?: string[]; error: string | null;
  recall_all_at_5?: number | null; recall_any_at_5?: number | null; recall_all_at_10?: number | null; ndcg_at_10?: number | null; latency_ms?: number;
  rerank?: { state: string; model?: string }; qa_score?: number; qa_answer?: string; qa_error?: string; qa_input_tokens?: number; qa_output_tokens?: number; qa_receipts?: Receipt[];
};

const ndjson = (path: string): Row[] => {
  if (!existsSync(path)) return [];
  const bytes = readFileSync(path);
  return (path.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Row);
};
function load(dir: string) {
  const rows = new Map<string, Row>();
  let usd = 0, reranked = 0;
  const statuses = new Set<string>();
  const rerankRequests: Record<string, number> = {};
  for (const s of readdirSync(dir).filter(d => /^shard-\d+$/.test(d)).sort()) {
    for (const r of ndjson(join(dir, s, 'rows.ndjson.gz'))) rows.set(r.id, r);
    const rec = JSON.parse(readFileSync(join(dir, s, 'receipt.json'), 'utf8')) as { run_status: string; cost: { usd: number } | null; cost_usd_all_attempts?: number | null; fidelity?: { reranked_queries?: number; rerank_provider_requests?: Record<string, number> | null } };
    usd += rec.cost_usd_all_attempts ?? rec.cost?.usd ?? 0;
    statuses.add(rec.run_status);
    reranked += rec.fidelity?.reranked_queries ?? 0;
    for (const [m, n] of Object.entries(rec.fidelity?.rerank_provider_requests ?? {})) rerankRequests[m] = (rerankRequests[m] ?? 0) + n;
  }
  return { rows, usd: round(usd), status: [...statuses].sort().join('+'), reranked, rerankRequests };
}
type Arm = ReturnType<typeof load>;

const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null; };

function paired(a: Arm, b: Arm, value: (r: Row) => number | null, keep: (r: Row) => boolean) {
  const pairs = [...a.rows.values()].filter(keep).flatMap(ra => {
    const rb = b.rows.get(ra.id);
    const va = value(ra), vb = rb ? value(rb) : null;
    return va === null || vb === null ? [] : [{ id: ra.id, cluster: ra.conversation, a: va, b: vb }];
  });
  const d = clusteredPairedDelta(pairs, { seed: 42, draws: 10_000 });
  return { n: d.n_pairs, a: round(d.mean_a), b: round(d.mean_b), delta: round(d.delta), ci95: d.ci95 ? [round(d.ci95[0]), round(d.ci95[1])] as [number, number] : null,
    better: pairs.filter(p => p.b > p.a).length, worse: pairs.filter(p => p.b < p.a).length };
}

const answerable = (r: Row) => !r.abstention;
const strict5 = (r: Row) => r.recall_all_at_5 ?? 0;
const strict10 = (r: Row) => r.recall_all_at_10 ?? 0;
const feasible = (k: number) => (r: Row) => !r.abstention && r.gold_count >= 1 && r.gold_count <= k;

function retrieval(a: Arm) {
  const rows = [...a.rows.values()];
  const ans = rows.filter(answerable);
  const lat = rows.map(r => r.latency_ms).filter((x): x is number => typeof x === 'number');
  const states = rows.reduce((m, r) => ({ ...m, [r.rerank?.state ?? 'none']: (m[r.rerank?.state ?? 'none'] ?? 0) + 1 }), {} as Record<string, number>);
  return {
    status: a.status, rows: rows.length, errors: rows.filter(r => r.error).length, rerank_states: states, reranked_queries: a.reranked, rerank_requests: a.rerankRequests,
    strict_at_5: ans.filter(r => strict5(r) === 1).length, strict_at_10: ans.filter(r => strict10(r) === 1).length, answerable: ans.length,
    feasible_at_5: { n: ans.filter(feasible(5)).length, strict: ans.filter(feasible(5)).filter(r => strict5(r) === 1).length },
    feasible_at_10: { n: ans.filter(feasible(10)).length, strict: ans.filter(feasible(10)).filter(r => strict10(r) === 1).length },
    any_at_5: ans.filter(r => (r.recall_any_at_5 ?? 0) === 1).length, ndcg_at_10: round(mean(ans.map(r => r.ndcg_at_10 ?? 0))),
    latency_ms: { p50: pct(lat, 50), p95: pct(lat, 95) }, usd: a.usd,
  };
}

function answers(a: Arm) {
  const rows = [...a.rows.values()];
  const part = (xs: Row[]) => ({ n: xs.length, mean_score: round(mean(xs.map(r => r.qa_score ?? 0))), all_items_met: xs.filter(r => r.qa_score === 1).length });
  const readers = rows.flatMap(r => (r.qa_receipts ?? []).filter(x => x.role === 'reader'));
  const text = (r: Row) => r.qa_answer ?? '';
  const zero = rows.filter(r => r.qa_score === 0);
  const committed = (r: Row) => text(r).trim() !== '' && !DECLINE.test(text(r).slice(-700));
  return {
    status: a.status, all: part(rows), answerable: part(rows.filter(answerable)), abstention: part(rows.filter(r => r.abstention)),
    qa_errors: rows.filter(r => r.qa_error).length, reused_answers: readers.filter(x => x.from_cache).length,
    stopped_at_limit: readers.filter(x => x.finish === 'max_tokens' || x.finish === 'length').length,
    input_tokens_per_answer: Math.round(mean(rows.map(r => r.qa_input_tokens ?? 0))), output_tokens_per_answer: Math.round(mean(rows.map(r => r.qa_output_tokens ?? 0))),
    committed_wrong_detector: { all: zero.filter(committed).length, answerable: zero.filter(r => !r.abstention && committed(r)).length, abstention: zero.filter(r => r.abstention && committed(r)).length },
    usd: a.usd,
  };
}

const armsDir = join(here, 'arms');
const names = existsSync(armsDir) ? readdirSync(armsDir).sort() : [];
const R: Record<string, Arm> = Object.fromEntries(names.filter(n => n.startsWith('r-')).map(n => [n, load(join(armsDir, n))]));
const A: Record<string, Arm> = Object.fromEntries(names.filter(n => !n.startsWith('r-')).map(n => [n, load(join(armsDir, n))]));
const FLOOR_REUSED = join(here, '../2026-10-08-beam-1m-failure-analysis/arms/a1-nomem-gpt61sol');
if (!A['f-gpt61sol']) A['f-gpt61sol'] = load(FLOOR_REUSED);
const score = (r: Row) => (typeof r.qa_score === 'number' ? r.qa_score : null);
const met = (r: Row) => (score(r) === null ? null : Number(score(r) === 1));
const all = () => true;

const retrievalPaired: Record<string, unknown> = {};
for (const [x, y] of [['r-off', 'r-on'], ['r-on', 'r-div'], ['r-off', 'r-div']]) {
  if (!R[x] || !R[y]) continue;
  retrievalPaired[`${y} minus ${x}`] = { strict_at_5: paired(R[x], R[y], strict5, answerable), strict_at_10: paired(R[x], R[y], strict10, answerable),
    strict_at_5_feasible: paired(R[x], R[y], strict5, feasible(5)), strict_at_10_feasible: paired(R[x], R[y], strict10, feasible(10)) };
}
const answersPaired: Record<string, unknown> = {};
for (const reader of ['gpt61sol', 'sonnet55', 'opus55']) {
  const floor = A[`f-${reader}`], s1 = A[`s1-${reader}`], s3 = A[`s3-${reader}`], s3w = A[`s3w-${reader}`];
  if (s1 && s3) answersPaired[`${reader}: s3 minus s1`] = { score: paired(s1, s3, score, all), all_items_met: paired(s1, s3, met, all) };
  if (s3 && s3w) answersPaired[`${reader}: s3w minus s3`] = { score: paired(s3, s3w, score, all), all_items_met: paired(s3, s3w, met, all) };
  for (const [n, c] of [['s1', s1], ['s3', s3], ['s3w', s3w]] as const) if (c && floor) answersPaired[`${reader}: ${n} minus floor`] = { score: paired(floor, c, score, all) };
}
// Exploratory (not a preregistered comparison): readers on identical S1 evidence at equal 4,096-token limits.
const readerPaired: Record<string, unknown> = {};
for (const [x, y] of [['gpt61sol', 'sonnet55'], ['gpt61sol', 'opus55'], ['sonnet55', 'opus55']]) {
  if (A[`s1-${x}`] && A[`s1-${y}`]) readerPaired[`s1: ${y} minus ${x}`] = { score: paired(A[`s1-${x}`], A[`s1-${y}`], score, all), all_items_met: paired(A[`s1-${x}`], A[`s1-${y}`], met, all) };
}
const out = {
  generated_by: 'analyze.ts', bootstrap: { clusters: 'conversation', draws: 10_000, seed: 42 },
  floor_reused: { 'f-gpt61sol': names.includes('f-gpt61sol') ? null : '2026-10-08-beam-1m-failure-analysis/arms/a1-nomem-gpt61sol' },
  retrieval: Object.fromEntries(Object.entries(R).map(([n, a]) => [n, retrieval(a)])), retrieval_paired: retrievalPaired,
  answers: Object.fromEntries(Object.entries(A).map(([n, a]) => [n, answers(a)])), answers_paired: answersPaired, readers_paired_exploratory: readerPaired,
  spend_usd_this_measurement: round([...Object.values(R), ...names.filter(n => !n.startsWith('r-')).map(n => A[n])].reduce((s, a) => s + a.usd, 0)),
};

const path = join(here, 'summary.json');
const text = JSON.stringify(out, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if ((existsSync(path) ? readFileSync(path, 'utf8') : '') !== text) { process.stderr.write('summary.json differs from the committed rows; rerun without --check\n'); process.exit(1); }
  process.stdout.write('summary.json matches the committed rows\n');
} else {
  writeFileSync(path, text);
  process.stdout.write(text);
}

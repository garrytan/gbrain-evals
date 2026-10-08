/**
 * B2 paid-arm summary: recomputes every arm number in the report from the committed rows under arms/ and the
 * 2026-10-06 bridge rows, with paired cluster-bootstrap intervals (11 conversations), and writes arms-summary.json.
 * Keyless and $0; with --check it exits 1 when the committed arms-summary.json differs.
 * Usage: bun docs/benchmarks/2026-10-08-beam-1m-failure-analysis/analyze.ts [--check]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { clusteredPairedDelta } from '../../../eval/runner/stats/paired.ts';
import { DECLINE } from './decline.ts';

const here = import.meta.dir;
type Row = { id: string; conversation: string; category: string; abstention: boolean; gold_count: number; retrieved?: string[]; recall_all_at_5?: number | null; recall_any_at_5?: number | null;
  recall_all_at_10?: number | null; ndcg_at_10?: number | null; qa_score?: number; qa_input_tokens?: number; qa_output_tokens?: number; qa_context_tokens?: number; qa_answer?: string; qa_error?: string; error: string | null };
type Answer = { id: string; answer: string; finish_reason: string | null; input_tokens: number; output_tokens: number; cached: boolean };

const ndjson = <T>(path: string): T[] => {
  if (!existsSync(path)) return [];
  const bytes = readFileSync(path);
  return (path.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as T);
};
const shards = (dir: string) => readdirSync(dir).filter(d => d.startsWith('shard-')).sort().map(d => join(dir, d));
function arm(dir: string) {
  const rows = new Map<string, Row>(), answers = new Map<string, Answer>();
  let usd = 0;
  const statuses = new Set<string>(), reasons: string[] = [];
  let fidelity: Record<string, unknown> | null = null;
  for (const s of shards(dir)) {
    for (const r of ndjson<Row>(join(s, 'rows.ndjson.gz'))) rows.set(r.id, r);
    for (const a of ndjson<Answer>(join(s, 'answers.ndjson.gz'))) answers.set(a.id, a);
    const rec = JSON.parse(readFileSync(join(s, 'receipt.json'), 'utf8')) as { run_status: string; invalid_reasons: string[]; cost: { usd: number } | null; fidelity: Record<string, unknown> };
    usd += rec.cost?.usd ?? 0; statuses.add(rec.run_status); reasons.push(...rec.invalid_reasons);
    if (rec.fidelity && 'reranked_queries' in rec.fidelity) {
      fidelity ??= {};
      for (const [k, v] of Object.entries(rec.fidelity)) {
        if (typeof v === 'number') fidelity[k] = ((fidelity[k] as number) ?? 0) + v;
        else if (v && typeof v === 'object') { const acc = (fidelity[k] ?? {}) as Record<string, number>; for (const [m, n] of Object.entries(v as Record<string, number>)) acc[m] = (acc[m] ?? 0) + n; fidelity[k] = acc; }
      }
    }
  }
  return { rows, answers, usd: Math.round(usd * 1e4) / 1e4, status: [...statuses].sort().join('+'), invalid_reasons: reasons, fidelity };
}

const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const decompose = JSON.parse(readFileSync(join(here, 'decomposition.json'), 'utf8')) as { committed_wrong: { committed_wrong: { all: number; answerable: number; abstention: number } } };
const armLabels = (JSON.parse(readFileSync(join(here, 'committed-wrong-labels.json'), 'utf8')) as { arm_labels: Record<string, { labels: Record<string, string> }> }).arm_labels;
function handLabels(name: string, a: ReturnType<typeof arm>) {
  const labels = armLabels[name]?.labels;
  if (!labels) return {};
  const count = (label: string, abstention: boolean) => Object.entries(labels).filter(([id, l]) => l === label && a.rows.get(id)?.abstention === abstention).length;
  return { committed_wrong_hand_labels: { all: count('committed', false) + count('committed', true), answerable: count('committed', false), abstention: count('committed', true), declined_answerable: count('declined', false), undetermined: count('undetermined', false) + count('undetermined', true) } };
}

function answerSummary(a: ReturnType<typeof arm>) {
  const all = [...a.rows.values()];
  const scored = all.filter(r => typeof r.qa_score === 'number');
  const part = (xs: Row[]) => ({ n: xs.length, mean_score: round(mean(xs.map(r => r.qa_score ?? 0)) ?? 0), all_items_met: xs.filter(r => r.qa_score === 1).length });
  const ans = [...a.answers.values()];
  const zero = scored.filter(r => r.qa_score === 0);
  const text = (r: Row) => a.answers.get(r.id)?.answer ?? r.qa_answer ?? '';
  const committed = (r: Row) => text(r).trim() !== '' && !DECLINE.test(text(r).slice(-700));
  return {
    status: a.status, questions: all.length, qa_errors: all.filter(r => r.qa_error).length,
    all: part(scored), answerable: part(scored.filter(r => !r.abstention)), abstention: part(scored.filter(r => r.abstention)),
    empty_zero_score_answers: zero.filter(r => text(r).trim() === '').length,
    committed_wrong_detector: { all: zero.filter(committed).length, answerable: zero.filter(r => !r.abstention && committed(r)).length, abstention: zero.filter(r => r.abstention && committed(r)).length, declined_answerable: zero.filter(r => !r.abstention && !committed(r)).length },
    provider_tokens_mean: { input: round(mean(scored.map(r => r.qa_input_tokens ?? 0)) ?? 0, 0), output: round(mean(scored.map(r => r.qa_output_tokens ?? 0)) ?? 0, 0) },
    context_tokens_estimate_mean: round(mean(scored.filter(r => r.qa_context_tokens !== undefined).map(r => r.qa_context_tokens ?? 0)) ?? 0, 0),
    finish_reasons: ans.reduce((m, x) => ({ ...m, [x.finish_reason ?? 'unknown']: (m[x.finish_reason ?? 'unknown'] ?? 0) + 1 }), {} as Record<string, number>),
    empty_answers: ans.filter(x => !x.answer.trim()).length, reused_cached_answers: ans.filter(x => x.cached).length,
    by_category: Object.fromEntries([...new Set(scored.map(r => r.category))].sort().map(c => [c, round(mean(scored.filter(r => r.category === c).map(r => r.qa_score ?? 0)) ?? 0, 3)])),
    cost_usd: a.usd,
  };
}

function retrievalSummary(a: ReturnType<typeof arm>) {
  const scored = [...a.rows.values()].filter(r => !r.abstention);
  const sum = (k: keyof Row, xs = scored) => xs.reduce((s, r) => s + Number(r[k] ?? 0), 0);
  const cat = (c: string) => { const xs = scored.filter(r => r.category === c); return { n: xs.length, strict_at_10: sum('recall_all_at_10', xs), ndcg_at_10: round(sum('ndcg_at_10', xs) / xs.length) }; };
  return {
    status: a.status, invalid_reasons: a.invalid_reasons, of: scored.length,
    strict_at_5: sum('recall_all_at_5'), strict_at_5_feasible: { hits: sum('recall_all_at_5', scored.filter(r => r.gold_count > 0 && r.gold_count <= 5)), of: scored.filter(r => r.gold_count > 0 && r.gold_count <= 5).length },
    strict_at_10: sum('recall_all_at_10'), strict_at_10_feasible: { hits: sum('recall_all_at_10', scored.filter(r => r.gold_count > 0 && r.gold_count <= 10)), of: scored.filter(r => r.gold_count > 0 && r.gold_count <= 10).length },
    any_at_5: sum('recall_any_at_5'), ndcg_at_10: round(sum('ndcg_at_10') / scored.length),
    event_ordering: cat('event_ordering'), summarization: cat('summarization'), fidelity: a.fidelity, cost_usd: a.usd,
  };
}

function paired(a: ReturnType<typeof arm>, b: ReturnType<typeof arm>, metric: (r: Row) => number | null) {
  const pairs = [...a.rows.values()].flatMap(x => {
    const y = b.rows.get(x.id);
    const va = metric(x), vb = y ? metric(y) : null;
    return va === null || vb === null ? [] : [{ id: x.id, cluster: x.conversation, a: va, b: vb }];
  });
  const d = clusteredPairedDelta(pairs, { seed: 42, draws: 10_000 });
  return { n: d.n_pairs, a: round(d.mean_a), b: round(d.mean_b), delta: round(d.delta), ci95: d.ci95 ? [round(d.ci95[0]), round(d.ci95[1])] as [number, number] : null,
    better: pairs.filter(p => p.b > p.a).length, worse: pairs.filter(p => p.b < p.a).length };
}
const score = (r: Row) => (typeof r.qa_score === 'number' ? r.qa_score : null);
const strict = (r: Row) => (typeof r.qa_score === 'number' ? Number(r.qa_score === 1) : null);
const recall = (k: 'recall_all_at_5' | 'recall_all_at_10') => (r: Row) => (r.abstention ? null : Number(r[k] ?? 0));

const A = (name: string) => arm(join(here, 'arms', name));
const published = arm(join(here, '../2026-10-06-beam-1m-dates/qa/baseline'));
const readers = { gpt41mini: 'openai:gpt-4.1-mini', sonnet55: 'anthropic:claude-sonnet-5-5', opus55: 'anthropic:claude-opus-5-5', gpt61sol: 'openai:gpt-6.1-sol' } as const;
const present = (name: string) => existsSync(join(here, 'arms', name));
const answerArms: Record<string, string> = {
  'a1-nomem-gpt41mini': 'gpt41mini', 'a1-nomem-sonnet55': 'sonnet55', 'a1-nomem-opus55': 'opus55', 'a1-nomem-gpt61sol': 'gpt61sol',
  'a0-bridge-top5': 'gpt41mini', 'a2-top5-sonnet55': 'sonnet55', 'a2-top5-opus55': 'opus55', 'a2-top5-gpt61sol': 'gpt61sol',
  'a3-top10-gpt61sol': 'gpt61sol', 'a4-oracle-gpt61sol': 'gpt61sol', 'a5-r0-top5-gpt61sol': 'gpt61sol', 'a5-r1-top5-gpt61sol': 'gpt61sol',
};
const arms = Object.fromEntries(Object.keys(answerArms).filter(present).map(n => [n, A(n)]));
const answers: Record<string, unknown> = { 'published-2026-10-06-bridge': { reader: readers.gpt41mini, ...answerSummary(published), committed_wrong_hand_labels: decompose.committed_wrong.committed_wrong } };
for (const [n, a] of Object.entries(arms)) {
  const floor = arms[`a1-nomem-${answerArms[n]}`];
  answers[n] = { reader: readers[answerArms[n] as keyof typeof readers], ...answerSummary(a), ...handLabels(n, a), ...(floor && !n.startsWith('a1-') ? { floor: answerSummary(floor).all } : {}) };
}
const retrieval: Record<string, unknown> = { 'published-openai-6622a119e': retrievalSummary(published) };
for (const n of ['r0-voyage4', 'r1-voyage4-rerank', 'r2-voyage4-deep', 'r3-voyage4-rerank-deep'].filter(present)) retrieval[n] = retrievalSummary(A(n));

const comparisons: Record<string, unknown> = {};
const cmp = (label: string, a: string | ReturnType<typeof arm>, b: string, metrics: Record<string, (r: Row) => number | null>) => {
  const left = typeof a === 'string' ? arms[a] ?? (present(a) ? A(a) : undefined) : a;
  const right = arms[b] ?? (present(b) ? A(b) : undefined);
  if (!left || !right) return;
  comparisons[label] = Object.fromEntries(Object.entries(metrics).map(([m, f]) => [m, paired(left, right, f)]));
};
const qa = { score, strict_all_items_met: strict };
cmp('A0 date-order fix (bridge): a0-bridge-top5 minus the published bridge row', published, 'a0-bridge-top5', qa);
for (const r of ['sonnet55', 'opus55', 'gpt61sol']) {
  cmp(`A2 ${r} minus A0 bridge (same frozen top 5)`, 'a0-bridge-top5', `a2-top5-${r}`, qa);
  cmp(`A2 ${r} minus its own no-memory floor`, `a1-nomem-${r}`, `a2-top5-${r}`, qa);
}
cmp('A0 bridge minus its own no-memory floor', 'a1-nomem-gpt41mini', 'a0-bridge-top5', qa);
cmp('A3 top 10 minus A2 top 5 (gpt-6.1-sol)', 'a2-top5-gpt61sol', 'a3-top10-gpt61sol', qa);
cmp('A4 oracle minus A2 top 5 (gpt-6.1-sol)', 'a2-top5-gpt61sol', 'a4-oracle-gpt61sol', qa);
cmp('A5 reranker answers: R1 top 5 minus R0 top 5 (gpt-6.1-sol)', 'a5-r0-top5-gpt61sol', 'a5-r1-top5-gpt61sol', qa);
cmp('A5 voyage-4 R0 top 5 minus OpenAI frozen top 5 (gpt-6.1-sol; different builds)', 'a2-top5-gpt61sol', 'a5-r0-top5-gpt61sol', qa);
const rec = { strict_at_5: recall('recall_all_at_5'), strict_at_10: recall('recall_all_at_10') };
cmp('R1 reranker minus R0 (retrieval)', 'r0-voyage4', 'r1-voyage4-rerank', rec);
cmp('R2 deep pool minus R0 (retrieval)', 'r0-voyage4', 'r2-voyage4-deep', rec);
cmp('R3 deep pool with the reranker minus R1 (retrieval)', 'r1-voyage4-rerank', 'r3-voyage4-rerank-deep', rec);
cmp('R3 deep pool with the reranker minus R0 (retrieval)', 'r0-voyage4', 'r3-voyage4-rerank-deep', rec);
cmp('R0 voyage-4 at 7aa2caa0 minus the published OpenAI lists at 6622a119e (retrieval; different builds)', published, 'r0-voyage4', rec);

const spend = Object.fromEntries(Object.entries({ ...arms, ...Object.fromEntries(['r0-voyage4', 'r1-voyage4-rerank', 'r2-voyage4-deep', 'r3-voyage4-rerank-deep'].filter(present).map(n => [n, A(n)])) }).map(([n, a]) => [n, a.usd]));
const out = {
  note: 'BEAM-1M dev, 11 conversations, 220 questions. Judge openai:gpt-4.1-mini per rubric item for every arm. Paired deltas: b minus a, cluster bootstrap by conversation (11 clusters), 10,000 draws, seed 42.',
  answers, retrieval, comparisons, spend_usd: { arms: spend, total: round(Object.values(spend).reduce((x, y) => x + y, 0)) },
};
const text = JSON.stringify(out, null, 2) + '\n';
const path = join(here, 'arms-summary.json');
if (process.argv.includes('--check')) {
  const ok = existsSync(path) && readFileSync(path, 'utf8') === text;
  console.log(ok ? 'arms-summary.json matches the committed rows' : 'arms-summary.json differs from the committed rows');
  process.exit(ok ? 0 : 1);
}
writeFileSync(path, text);
console.log(`arms: ${Object.keys(answers).length} answer, ${Object.keys(retrieval).length} retrieval; spend $${out.spend_usd.total}`);

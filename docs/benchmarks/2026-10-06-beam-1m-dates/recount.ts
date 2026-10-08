/**
 * W13 keyless re-score: recomputes every BEAM-1M number in the report from the committed rows (this folder and the
 * 2026-10-05 starting line), writes beam-summary.json, and with --check exits 1 when the committed summary differs.
 * Usage: bun docs/benchmarks/2026-10-06-beam-1m-dates/recount.ts [--check]
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const here = import.meta.dir;
const startingLine = join(here, '../2026-10-05-heldout-program/starting-line');
type Row = { id: string; category: string; abstention: boolean; recall_all_at_5: number | null; recall_any_at_5: number | null; recall_all_at_10: number | null; ndcg_at_10: number | null; retrieved: string[]; qa_score?: number; error: string | null };

function rows(dir: string): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const shard of readdirSync(dir).filter(d => d.startsWith('shard-')).sort()) {
    const text = gunzipSync(readFileSync(join(dir, shard, 'rows.ndjson.gz'))).toString('utf8');
    for (const line of text.split('\n').filter(Boolean)) { const r = JSON.parse(line) as Row; out.set(r.id, r); }
  }
  return out;
}

const cost = (dir: string) => readdirSync(dir).filter(d => d.startsWith('shard-')).reduce((s, d) => s + (JSON.parse(readFileSync(join(dir, d, 'receipt.json'), 'utf8')) as { cost: { usd: number } }).cost.usd, 0);

function retrieval(r: Map<string, Row>) {
  const scored = [...r.values()].filter(x => !x.abstention);
  const sum = (k: keyof Row) => scored.reduce((s, x) => s + Number(x[k] ?? 0), 0);
  return { questions: r.size, retrieval_scored: scored.length, errors: [...r.values()].filter(x => x.error).length,
    recall_all_at_5: { hits: sum('recall_all_at_5'), rate: sum('recall_all_at_5') / scored.length },
    recall_any_at_5: { hits: sum('recall_any_at_5'), rate: sum('recall_any_at_5') / scored.length },
    recall_all_at_10: { hits: sum('recall_all_at_10'), rate: sum('recall_all_at_10') / scored.length },
    ndcg_at_10: sum('ndcg_at_10') / scored.length };
}

function answers(r: Map<string, Row>) {
  const all = [...r.values()];
  const mean = (xs: Row[]) => xs.reduce((s, x) => s + (x.qa_score ?? 0), 0) / xs.length;
  const cats = [...new Set(all.map(x => x.category))].sort();
  return { questions: all.length, qa_score: mean(all), answerable: mean(all.filter(x => !x.abstention)), abstention: mean(all.filter(x => x.abstention)),
    by_category: Object.fromEntries(cats.map(c => [c, mean(all.filter(x => x.category === c))])) };
}

function paired(a: Map<string, Row>, b: Map<string, Row>, k: keyof Row) {
  let up = 0, down = 0;
  for (const [id, x] of a) { const y = b.get(id); if (!y || x.abstention) continue; const d = Number(y[k] ?? 0) - Number(x[k] ?? 0); if (d > 0) up++; if (d < 0) down++; }
  return { up, down };
}

const old = rows(join(startingLine, 'beam-1m-master'));
const oldQa = rows(join(startingLine, 'beam-1m-qa-master'));
const base = rows(join(here, 'runs/beam-1m/baseline'));
const cand = rows(join(here, 'runs/beam-1m/candidate'));
const qa = rows(join(here, 'qa/baseline'));
const summary = {
  note: 'BEAM-1M dev, 11 conversations, 220 questions (198 with gold), seed 42, balanced, reranker off, autocut off, top 10, openai:text-embedding-3-large 1536',
  retrieval: {
    starting_line_old_loader_6622a119e: retrieval(old),
    fixed_loader_6622a119e: retrieval(base),
    fixed_loader_c5fb0201: retrieval(cand),
    fixed_vs_old_same_build: { recall_all_at_5: paired(old, base, 'recall_all_at_5'), recall_any_at_5: paired(old, base, 'recall_any_at_5') },
    pin_vs_starting_build_fixed_loader: { recall_all_at_5: paired(base, cand, 'recall_all_at_5'), recall_any_at_5: paired(base, cand, 'recall_any_at_5'),
      identical_retrieved_lists: [...base].filter(([id, x]) => JSON.stringify(x.retrieved) === JSON.stringify(cand.get(id)?.retrieved)).length },
    cost_usd: { fixed_loader_6622a119e: cost(join(here, 'runs/beam-1m/baseline')), fixed_loader_c5fb0201: cost(join(here, 'runs/beam-1m/candidate')) },
  },
  answers: {
    reader_and_judge: 'openai:gpt-4.1-mini (protocol-fixed, decisions G8 and G9), 1 run, top 5 sessions in date order',
    starting_line_old_loader_6622a119e: answers(oldQa),
    fixed_loader_6622a119e: answers(qa),
    fixed_vs_old_same_build: paired(oldQa, qa, 'qa_score'),
    fixed_loader_c5fb0201: 'Not run: the $2 answer-half cap could not cover a second arm after the first cost $1.14',
    cost_usd: cost(join(here, 'qa/baseline')),
  },
};
const text = JSON.stringify(summary, null, 2) + '\n';
const out = join(here, 'beam-summary.json');
if (process.argv.includes('--check')) {
  const ok = existsSync(out) && JSON.stringify(JSON.parse(readFileSync(out, 'utf8')).retrieval) === JSON.stringify(summary.retrieval) && JSON.stringify(JSON.parse(readFileSync(out, 'utf8')).answers) === JSON.stringify(summary.answers);
  console.log(ok ? 'beam-summary.json matches the committed rows' : 'beam-summary.json differs from the committed rows');
  process.exit(ok ? 0 : 1);
}
const keep = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as { preregistration_attestations?: unknown }).preregistration_attestations : undefined;
writeFileSync(out, JSON.stringify({ ...(keep ? { preregistration_attestations: keep } : {}), ...summary }, null, 2) + '\n');
const r = summary.retrieval;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
for (const [k, v] of Object.entries({ old: r.starting_line_old_loader_6622a119e, fixed: r.fixed_loader_6622a119e, pin: r.fixed_loader_c5fb0201 })) {
  console.log(`${k}: strict recall@5 ${v.recall_all_at_5.hits}/${v.retrieval_scored} (${pct(v.recall_all_at_5.rate)}), any@5 ${pct(v.recall_any_at_5.rate)}, all@10 ${pct(v.recall_all_at_10.rate)}, nDCG@10 ${v.ndcg_at_10.toFixed(4)}`);
}
console.log(`answers: old loader ${pct(summary.answers.starting_line_old_loader_6622a119e.qa_score)}, fixed loader ${pct(summary.answers.fixed_loader_6622a119e.qa_score)}`);

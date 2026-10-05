/**
 * Recomputes starting-line/summary.json from the committed shard receipts and rows.
 * Usage: bun docs/benchmarks/2026-10-05-heldout-program/recount-starting-line.ts [--check]
 * Retrieval means cover rows with gold sessions and no error; answer accuracy covers every row with a QA score.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const dir = join(import.meta.dir, 'starting-line');
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const summary: Record<string, unknown> = {};

for (const run of readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()) {
  const rows: Array<Record<string, any>> = [];
  const builds = new Set<string>();
  let usd = 0;
  for (const shard of readdirSync(join(dir, run)).sort()) {
    const receipt = JSON.parse(readFileSync(join(dir, run, shard, 'receipt.json'), 'utf8'));
    usd += receipt.cost?.usd ?? 0;
    builds.add(`${receipt.product.version}@${receipt.overlay?.commit ?? receipt.product.loaded_git_head}`);
    const text = gunzipSync(readFileSync(join(dir, run, shard, 'rows.ndjson.gz'))).toString().trim();
    rows.push(...text.split('\n').map(line => JSON.parse(line)));
  }
  const scored = rows.filter(r => !r.abstention && r.error == null);
  const qa = rows.filter(r => typeof r.qa_score === 'number');
  const abstention = qa.filter(r => r.abstention);
  summary[run] = {
    rows: rows.length,
    retrieval_scored: scored.length,
    errors: rows.filter(r => r.error != null).length,
    recall_all_at_5: mean(scored.map(r => r.recall_all_at_5)),
    recall_any_at_5: mean(scored.map(r => r.recall_any_at_5)),
    ndcg_at_10: mean(scored.map(r => r.ndcg_at_10)),
    ...(qa.length ? {
      qa_rows: qa.length,
      qa_score: mean(qa.map(r => r.qa_score)),
      qa_score_answerable: mean(qa.filter(r => !r.abstention).map(r => r.qa_score)),
    } : {}),
    ...(abstention.length ? {
      abstention_rows: abstention.length,
      abstention_score: mean(abstention.map(r => r.qa_score)),
      abstention_trap_rate: mean(abstention.map(r => (r.qa_trap === true || r.qa_trap === 1 ? 1 : 0))),
    } : {}),
    cost_usd: Math.round(usd * 1e4) / 1e4,
    builds: [...builds],
  };
}

const out = JSON.stringify(summary, null, 2) + '\n';
const target = join(dir, 'summary.json');
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== out) {
    console.error('summary.json differs from the recount');
    process.exit(1);
  }
  console.log('summary.json matches the recount');
} else {
  writeFileSync(target, out);
  console.log(out);
}

// P7 false-fire check: parseRelationalPlan over LongMemEval-S questions and BrainBench non-relational queries ($0).
// Run from gbrain-evals: bun docs/benchmarks/2026-10-04-p7-multi-hop-planner/probes/p7-falsefire.ts <gbrain checkout> > falsefire.json
const EVALS = new URL('../../../..', import.meta.url).pathname.replace(/\/$/, '');
import { readFileSync } from 'fs';
const [gbrain] = process.argv.slice(2);
const { parseRelationalPlan } = await import(`${gbrain}/src/core/search/relational-plan.ts`);
const { getAllTierQueries } = await import(`${EVALS}/eval/runner/queries/index.ts`);

const lme = JSON.parse(readFileSync(`${process.env.HOME}/datasets/gbrain-evals/longmemeval/longmemeval_s_cleaned.json`, 'utf8')) as Array<{ question_id: string; question: string }>;
const cat13 = JSON.parse(readFileSync(`${EVALS}/eval/data/gold/brainbench-cat13-embedder-subset.json`, 'utf8')).queries as Array<Record<string, unknown>>;
const tiers = (getAllTierQueries() as Array<{ id: string; text: string; tags?: string[] }>);

function run(name: string, items: Array<{ id: string; text: string }>) {
  const fired: Array<{ id: string; text: string; anchor: string; hops: unknown }> = [];
  const unsupported: Record<string, number> = {};
  for (const it of items) {
    const r = parseRelationalPlan(it.text);
    if (r.kind === 'plan') fired.push({ id: it.id, text: it.text, anchor: r.plan.anchor, hops: r.plan.hops });
    else if (r.kind === 'unsupported') unsupported[r.reason] = (unsupported[r.reason] ?? 0) + 1;
  }
  return { set: name, n: items.length, fired: fired.length, rate: fired.length / items.length, fired_items: fired, unsupported };
}

const nonRel = tiers.filter(q => !(q.tags ?? []).some(t => t.startsWith('relational')));
const out = [
  run('longmemeval-s', lme.map(q => ({ id: q.question_id, text: q.question }))),
  run('brainbench-tier5-non-relational', nonRel.map(q => ({ id: q.id, text: q.text }))),
  run('brainbench-cat13-subset', cat13.map((q, i) => ({ id: String(q.id ?? i), text: String(q.query ?? q.text ?? q.question) }))),
];
console.log(JSON.stringify(out, null, 2));

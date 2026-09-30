// Exact-official judge over any harness arm's stored hypotheses (reader-error rows are not judged).
// Usage: bun rejudge.ts <arm-dir> [--concurrency N]
import { M6, appendNdjson, dataset, officialJudge, pool, readNdjson } from './lib.ts';
const arm = process.argv[2];
const conc = Number(process.argv[process.argv.indexOf('--concurrency') + 1] || 6) || 6;
const rows = new Map(readNdjson(`${M6}/${arm}/rows.ndjson`).filter(r => typeof r.question_id === 'string' && r.kind !== 'by_type_summary').map(r => [r.question_id, r]));
const out = `${M6}/${arm}/official-judge.ndjson`;
const done = new Map(readNdjson(out).filter(r => !r.off_judge_error).map(r => [r.question_id, r]));
const ds = dataset();
const todo = [...rows.values()].filter(r => typeof r.error !== 'string' && r.hypothesis && !(done.has(r.question_id) && done.get(r.question_id).off_judge_prompt.includes(r.hypothesis)));
await pool(todo, conc, async (r) => { appendNdjson(out, { question_id: r.question_id, ...(await officialJudge(ds.get(r.question_id)!, r.hypothesis)) }); });
console.error(`[rejudge ${arm}] judged ${todo.length}`);
process.exit(0);

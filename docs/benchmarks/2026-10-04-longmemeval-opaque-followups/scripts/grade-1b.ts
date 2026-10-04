// Item 1b grading: every accepted response in the reading-notes run journals is graded by gbrain's data-boundary
// judge with openai:gpt-4o-2024-08-06 (temperature 0, 16 tokens), the complete response including notes.
// Usage: LME_DATASET=<json> bun grade-1b.ts <labels.ndjson> <journal1> [journal2 ...]   (resumable)
import { appendNdjson, dataset, gbrainJudge, pool, readNdjson } from './lib.ts';
const [out, ...journals] = process.argv.slice(2);
const done = new Set(readNdjson(out).filter(r => r.judge_correct !== undefined).map(r => `${r.question_id}:${r.mode}`));
const todo: any[] = [];
for (const j of journals) {
  for (const e of readNdjson(j)) {
    if (e.event !== 'response') continue;
    const [question_id, mode] = String(e.id).split(':');
    if (!done.has(e.id)) todo.push({ question_id, mode, journal: j.split('/').pop(), accepted: e.accepted, finish_reason: e.finish_reason, reported_model: e.reported_model, usage: e.usage, cost_usd: e.cost_usd, text: e.text });
  }
}
const ds = dataset();
let n = 0;
await pool(todo, 8, async (r) => {
  const q = ds.get(r.question_id)!;
  const j = r.accepted ? await gbrainJudge(q, r.text, 'openai:gpt-4o-2024-08-06') : { judge_error: 'response_not_accepted' };
  appendNdjson(out, { ...r, question_type: q.question_type, ...j });
  if (++n % 50 === 0) console.error(`[grade-1b] ${n}/${todo.length}`);
});
console.error(`[grade-1b] graded ${n}`);
process.exit(0);

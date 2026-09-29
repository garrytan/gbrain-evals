// Arm (b): matched gpt-4o reader + gpt-4o judge with the official LongMemEval
// prompts, over EXACTLY the retrieval arm (a) recorded (same top-5 chunk rows ->
// same distinct sessions). Official reader = run_generation.py defaults
// (flat-session, history_format json, useronly false, reading_method con ->
// cot true, gen_length 800, temperature 0, gpt-4o-2024-08-06), sessions in
// retrieval order then sorted by date, has_answer stripped.
// Usage: bun arm-b.ts [--rejudge-a] [--concurrency N]
import { M6, appendNdjson, dataset, distinctSessions, gbrainJudge, officialJudge, openaiChat, pool, readNdjson } from './lib.ts';
import { officialReaderPrompt } from './official.ts';

const args = process.argv.slice(2);
const conc = Number(args[args.indexOf('--concurrency') + 1] || 4) || 4;
const ds = dataset();

const aRows = readNdjson(`${M6}/a/rows.ndjson`).filter(r => typeof r.question_id === 'string' && r.kind !== 'by_type_summary');

if (args.includes('--rejudge-a')) {
  // Exact-official judge over arm (a)'s stored hypotheses (reader errors are not judged).
  const out = `${M6}/a/official-judge.ndjson`;
  const done = new Set(readNdjson(out).filter(r => !r.off_judge_error).map(r => r.question_id));
  const todo = aRows.filter(r => !done.has(r.question_id) && typeof r.error !== 'string' && r.hypothesis);
  await pool(todo, conc, async (r) => {
    const q = ds.get(r.question_id)!;
    appendNdjson(out, { question_id: r.question_id, ...(await officialJudge(q, r.hypothesis)) });
  });
  console.error(`[arm-b] rejudged ${todo.length} arm-a rows with the official judge`);
  process.exit(0);
}

const outPath = `${M6}/b/rows.ndjson`;
const done = new Set(readNdjson(outPath).filter(r => !r.reader_error).map(r => r.question_id));
const todo = aRows.filter(r => !done.has(r.question_id) && typeof r.error !== 'string');
const skippedErr = aRows.filter(r => typeof r.error === 'string').map(r => r.question_id);
if (skippedErr.length) console.error(`[arm-b] arm-a error rows (no recorded retrieval): ${skippedErr.join(',')}`);
let n = 0;
await pool(todo, conc, async (r) => {
  const q = ds.get(r.question_id)!;
  const sids = distinctSessions(r, 5);
  const { prompt, sessions } = officialReaderPrompt(q, sids);
  const rec: Record<string, unknown> = {
    question_id: q.question_id, question_type: q.question_type, retrieved_session_ids_top5: sids, reader_context_sessions: sessions,
    reader_context_chars: prompt.length, reader_model: 'gpt-4o-2024-08-06', reader_prompt: prompt,
  };
  try {
    const res = await openaiChat({ model: 'gpt-4o-2024-08-06', messages: [{ role: 'user', content: prompt }], n: 1, temperature: 0, max_tokens: 800 });
    Object.assign(rec, { hypothesis: res.text, reader_usage: res.usage, reader_latency_ms: res.latency_ms, reader_total_ms: res.total_ms,
      reader_attempts: res.attempts, reader_failures: res.failures, reader_response_model: res.response_model, reader_finish_reason: res.finish_reason });
  } catch (err: any) {
    Object.assign(rec, { reader_error: String(err?.message ?? err).slice(0, 300), reader_failures: err?.failures ?? [] });
    appendNdjson(outPath, rec);
    return;
  }
  const [gj, oj] = await Promise.all([gbrainJudge(q, rec.hypothesis as string), officialJudge(q, rec.hypothesis as string)]);
  Object.assign(rec, gj, oj);
  appendNdjson(outPath, rec);
  if (++n % 25 === 0) console.error(`[arm-b] ${n}/${todo.length}`);
});
console.error(`[arm-b] done ${n}/${todo.length}`);
process.exit(0);

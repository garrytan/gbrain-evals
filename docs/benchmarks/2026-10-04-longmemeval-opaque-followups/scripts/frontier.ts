// Item 2: gpt-5.4 (reasoning effort medium) reads arm b's exact official LongMemEval prompts (2026-09-29 opaque-qa,
// b/rows.ndjson.gz `reader_prompt`). Pilot of 10 questions through Chat Completions, the other 490 through the
// Batch API with identical bodies, then the two gpt-4o judges used for arms a and b.
// Usage: LME_DATASET=<json> OUT=<dir> bun frontier.ts pilot|submit|collect|judge
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { appendNdjson, dataset, gbrainJudge, officialJudge, openaiChat, pool, readNdjson } from './lib.ts';

const OUT = process.env.OUT!;
const ROWS = `${OUT}/rows.ndjson`;
const B = new URL('../../2026-09-29-longmemeval-opaque-qa/', import.meta.url).pathname;
const MODEL = 'gpt-5.4';
const body = (prompt: string) => ({ model: MODEL, messages: [{ role: 'user', content: prompt }], reasoning_effort: 'medium', max_completion_tokens: 12000 });
const bRows = readNdjson(`${B}/b/rows.ndjson.gz`);
const prompts = new Map<string, string>(bRows.map(r => [r.question_id, r.reader_prompt]));
const pilot = readFileSync(`${B}/pilot20.txt`, 'utf8').split('\n').filter(l => l && !l.startsWith('#')).slice(0, 10);
const have = () => new Set(readNdjson(ROWS).filter(r => typeof r.hypothesis === 'string').map(r => r.question_id));
const api = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`https://api.openai.com/v1/${path}`, { ...init, headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
};
const record = (qid: string, via: string, text: string, usage: any, model: string | null, finish: string | null, extra: Record<string, unknown> = {}) =>
  appendNdjson(ROWS, { question_id: qid, via, reader_model: MODEL, reader_request: { reasoning_effort: 'medium', max_completion_tokens: 12000 },
    reader_prompt_chars: prompts.get(qid)!.length, hypothesis: text, reader_usage: usage, reader_response_model: model, reader_finish_reason: finish, ...extra });

const cmd = process.argv[2];
if (cmd === 'pilot') {
  const done = have();
  for (const qid of pilot.filter(q => !done.has(q))) {
    try {
      const r = await openaiChat(body(prompts.get(qid)!));
      record(qid, 'chat.completions', r.text, r.usage, r.response_model, r.finish_reason, { reader_latency_ms: r.latency_ms, reader_attempts: r.attempts, reader_failures: r.failures });
    } catch (err: any) {
      appendNdjson(ROWS, { question_id: qid, via: 'chat.completions', reader_error: String(err?.message ?? err).slice(0, 300), reader_failures: err?.failures ?? [] });
    }
  }
} else if (cmd === 'submit') {
  const done = have();
  const todo = [...prompts.keys()].filter(q => !done.has(q));
  const jsonl = todo.map(qid => JSON.stringify({ custom_id: qid, method: 'POST', url: '/v1/chat/completions', body: body(prompts.get(qid)!) })).join('\n') + '\n';
  writeFileSync(`${OUT}/batch-input.jsonl`, jsonl);
  const form = new FormData();
  form.append('purpose', 'batch');
  form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), 'batch-input.jsonl');
  const file = await (await api('files', { method: 'POST', body: form })).json() as any;
  const batch = await (await api('batches', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input_file_id: file.id, endpoint: '/v1/chat/completions', completion_window: '24h', metadata: { purpose: 'gbrain-evals opaque-followups item 2' } }) })).json() as any;
  writeFileSync(`${OUT}/batch.json`, JSON.stringify({ requests: todo.length, input_file_id: file.id, batch }, null, 2));
  console.log(JSON.stringify({ requests: todo.length, batch_id: batch.id, status: batch.status }));
} else if (cmd === 'collect') {
  const meta = JSON.parse(readFileSync(`${OUT}/batch.json`, 'utf8'));
  const batch = await (await api(`batches/${meta.batch.id}`)).json() as any;
  console.log(JSON.stringify({ status: batch.status, counts: batch.request_counts }));
  if (batch.status !== 'completed') process.exit(3);
  writeFileSync(`${OUT}/batch-final.json`, JSON.stringify(batch, null, 2));
  const done = have();
  for (const [key, name] of [['output_file_id', 'batch-output.jsonl'], ['error_file_id', 'batch-errors.jsonl']] as const) {
    if (!batch[key]) continue;
    const text = await (await api(`files/${batch[key]}/content`)).text();
    writeFileSync(`${OUT}/${name}`, text);
    for (const line of text.split('\n').filter(Boolean)) {
      const r = JSON.parse(line);
      if (done.has(r.custom_id)) continue;
      const b = r.response?.body;
      if (r.response?.status_code === 200 && b) record(r.custom_id, 'batch', String(b.choices?.[0]?.message?.content ?? '').trim(), b.usage, b.model ?? null, b.choices?.[0]?.finish_reason ?? null, { batch_request_id: r.id });
      else appendNdjson(ROWS, { question_id: r.custom_id, via: 'batch', reader_error: JSON.stringify(r.error ?? r.response?.body?.error ?? r.response).slice(0, 300) });
    }
  }
} else if (cmd === 'judge') {
  const ds = dataset();
  const rows = readNdjson(ROWS).filter(r => typeof r.hypothesis === 'string');
  const judged = new Set(readNdjson(`${OUT}/judged.ndjson`).filter(r => r.judge_correct !== undefined && r.off_judge_correct !== undefined).map(r => r.question_id));
  await pool(rows.filter(r => !judged.has(r.question_id)), 6, async (r) => {
    const q = ds.get(r.question_id)!;
    const [gj, oj] = await Promise.all([gbrainJudge(q, r.hypothesis, 'openai:gpt-4o'), officialJudge(q, r.hypothesis)]);
    appendNdjson(`${OUT}/judged.ndjson`, { ...r, question_type: q.question_type, ...gj, ...oj });
  });
} else throw new Error('usage: pilot|submit|collect|judge');
process.exit(0);

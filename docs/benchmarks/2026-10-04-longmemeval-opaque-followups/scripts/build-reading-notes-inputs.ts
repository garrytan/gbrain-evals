// Reconstruct the reading-notes transfer cohort's frozen inputs (361 questions) from public data:
// question ids and order from the published transfer receipt, retrieved sessions (rank order) from the
// September 6 D1 receipt, session text and dates from the LongMemEval-S cleaned file. Each body is rendered
// as gbrain's harness renders a session page, with the session's opaque id in place of the dataset id.
// Usage: bun build-frozen.ts <dataset.json> <transfer.ndjson> <D1.ndjson> <out.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { opaqueSessionId } from '../../../../eval/runner/longmemeval-session-ids.ts';
const [dsPath, transferPath, d1Path, outPath] = process.argv.slice(2);
const ds = new Map((JSON.parse(readFileSync(dsPath, 'utf8')) as any[]).map(q => [q.question_id, q]));
const nd = (p: string) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const pairs = nd(transferPath).filter(r => r.record_type === 'pair');
const d1 = new Map(nd(d1Path).filter(r => r.question_id).map(r => [r.question_id, r]));
const sanitize = (s: string) => s.toLowerCase().replace(/[_.]/g, '-').replace(/[^a-z0-9-]/g, '-');
const out = pairs.map(p => {
  const q = ds.get(p.question_id)!; const row = d1.get(p.question_id)!;
  const sources = (row.retrieved_session_ids as string[]).map(sid => {
    const i = q.haystack_session_ids.findIndex((x: string) => x.toLowerCase() === sid.toLowerCase());
    if (i < 0) throw new Error(`${p.question_id}: ${sid} not in haystack`);
    const raw = q.haystack_session_ids[i]; const date = q.haystack_dates[i];
    const fm = ['---', 'type: note', `date: ${date}`, `session_id: ${opaqueSessionId(p.question_id, raw)}`, '---', ''].join('\n');
    const body = fm + q.haystack_sessions[i].flatMap((t: any) => [`**${t.role}:** ${t.content}`, '']).join('\n');
    return { session_id: raw, slug: `chat/${sanitize(raw)}`, date, body };
  });
  const gold = new Set((q.answer_session_ids as string[]).map(s => s.toLowerCase()));
  const complete = [...gold].every(g => sources.some(s => s.session_id.toLowerCase() === g));
  if (complete !== p.retrieval_complete) throw new Error(`${p.question_id}: retrieval_complete mismatch`);
  return { question_id: p.question_id, question: q.question, question_date: q.question_date, sources };
});
writeFileSync(outPath, JSON.stringify(out));
const lens = out.flatMap(c => c.sources.map(s => s.body.length));
console.log(JSON.stringify({ questions: out.length, sources: lens.length, max_body: Math.max(...lens), over_60000: lens.filter(n => n > 60000).length, total_chars: lens.reduce((a, b) => a + b, 0) }));


import { readFileSync, writeFileSync } from 'fs';
const D = 'eval/data/skillopt-method-v3';
const G = process.argv[2];
const tasks = new Map();
for (const s of ['query','briefing','fact-check']) for (const l of readFileSync(D+'/'+s+'/gate.jsonl','utf8').split('\n').filter(Boolean)) { const t = JSON.parse(l); tasks.set(t.task_id, t); }
const flagged = JSON.parse(readFileSync(G + '/refusal-audit-flagged.json','utf8'));
const rows = readFileSync(G + '/rows.jsonl','utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.kind === 'rollout' && r.split === 'gate');
const out = flagged.map((f, i) => {
  const [skill, target, arm] = f.key.split('/');
  const row = rows.find(r => r.skill === skill && r.arm === arm && r.task_id === f.task_id && (r.run ?? 1) === (f.run ?? 1));
  const t = tasks.get(f.task_id);
  return { id: 'a' + String(i + 1).padStart(3, '0'), pair: skill + '/' + target, arm, run: f.run, task_id: f.task_id, task: t.task, gold_values: (t.gold.values ?? []).map(v => v.value), gold_status: t.gold.status ?? null, answerable: t.answerable, flagged_negations: f.hits.map(h => ({ value: h.value, negations: h.negs })), answer: row?.answer ?? null };
});
writeFileSync(process.argv[3], out.map(o => JSON.stringify(o)).join('\n') + '\n');
console.log(out.length, out.filter(o => !o.answer).length);


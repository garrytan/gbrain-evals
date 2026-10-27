// Preregistered nested subset (GBRA-86's rule): per question type floor(k*share) then largest remainder (ties by type
// name); within a type ascending sha256('gbra86|'+question_id). bun select.ts <k> -> ../subset-k<k>.json
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { loadLmeS } from '../evals/eval/runner/memory-qa/corpus.ts';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const k = Number(process.argv[2]);
const corpus = loadLmeS();
const ordered = [...corpus.questions].sort((a, b) => (sha(`gbra86|${a.id}`) < sha(`gbra86|${b.id}`) ? -1 : 1));
const byType = new Map<string, string[]>();
for (const q of ordered) byType.set(q.category, [...(byType.get(q.category) ?? []), q.id]);
const quotas = [...byType.entries()].map(([t, ids]) => ({ t, ids, exact: (k * ids.length) / corpus.questions.length, take: 0 }));
quotas.forEach(q => (q.take = Math.floor(q.exact)));
let left = k - quotas.reduce((a, q) => a + q.take, 0);
for (const q of [...quotas].sort((a, b) => (b.exact % 1) - (a.exact % 1) || (a.t < b.t ? -1 : 1))) if (left-- > 0) q.take++;
const picked = new Set(quotas.flatMap(q => q.ids.slice(0, q.take)));
const subset = ordered.map(q => q.id).filter(id => picked.has(id));
writeFileSync(`../subset-k${k}.json`, JSON.stringify({ k, rule: "per question type, floor(k*share) then largest remainder (ties by type name); within a type, ascending sha256('gbra86|'+question_id)", per_type: Object.fromEntries(quotas.map(q => [q.t, q.take])), question_ids: subset }, null, 1));
console.log(k, JSON.stringify(Object.fromEntries(quotas.map(q => [q.t, q.take]))));


import { readFileSync, writeFileSync } from 'fs';
import { STATUS_WORDS } from '../../../../../../eval/runner/skillopt-method/score-v3.ts';
const D = 'eval/data/skillopt-method-v3';
const G = process.argv[2];
const tasks = new Map();
for (const s of ['query','briefing','fact-check']) for (const sp of ['gate','sel']) for (const l of readFileSync(D+'/'+s+'/'+sp+'.jsonl','utf8').split('\n').filter(Boolean)) { const t = JSON.parse(l); tasks.set(t.task_id, t); }
const NEG = /^(not|never|no|none|nothing|cannot|can't|unable|won't|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|hasn't|haven't|hadn't|couldn't|wouldn't|shouldn't|nor|without|neither)$/i;
const words = (s) => s.split(/\s+/).map(w => w.replace(/[^A-Za-z']/g, '').replace(/’/g, "'")).filter(Boolean);
const rows = readFileSync(G + '/rows.jsonl','utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.kind === 'rollout');
const flagged = []; const totals = {};
for (const r of rows) {
  if (r.split !== 'gate' || r.substance !== true) continue;
  const t = tasks.get(r.task_id); if (!t) continue;
  const key = r.skill + '/' + (r.target ?? 'opus') + '/' + r.arm;
  totals[key] = (totals[key] ?? 0) + 1;
  let vals = (t.gold?.values ?? []).map(v => String(v.value));
  if (r.skill === 'fact-check') vals = [...vals, ...(STATUS_WORDS[t.gold.status] ?? []).map(w => w.replace(/\(\?.*$/, ''))];
  const ans = String(r.answer ?? '');
  const hits = [];
  for (const v of vals) {
    const re = new RegExp(v.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&'), 'gi');
    let m; while ((m = re.exec(ans))) {
      const before = words(ans.slice(Math.max(0, m.index - 80), m.index)).slice(-5);
      const after = words(ans.slice(m.index + m[0].length, m.index + m[0].length + 80)).slice(0, 5);
      const negs = [...before, ...after].filter(w => NEG.test(w));
      if (negs.length) hits.push({ value: v, context: ans.slice(Math.max(0, m.index - 100), m.index + m[0].length + 100).replace(/\s+/g, ' '), negs });
      if (hits.length > 6) break;
    }
  }
  if (hits.length) flagged.push({ key, task_id: r.task_id, run: r.run, status: t.gold?.status ?? null, gold: (t.gold?.values ?? []).map(v => v.value), hits });
}
writeFileSync(G + '/refusal-audit-flagged.json', JSON.stringify(flagged, null, 1));
const byKey = {}; for (const f of flagged) byKey[f.key] = (byKey[f.key] ?? 0) + 1;
console.log(JSON.stringify({ totals, flaggedByKey: byKey, flagged: flagged.length }));


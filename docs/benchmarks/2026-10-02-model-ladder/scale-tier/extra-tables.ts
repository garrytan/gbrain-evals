/**
 * Supplementary tables for the Cat 40 scale tier, beside analyze.ts output:
 * agent-loop time (excludes waiting for a free gbrain slot, which wall_ms
 * includes), run errors by arm, and success on the subset of tasks every arm
 * ran (the memory arm ran 30 of 50 tasks), and gbrain's advantage per family
 * over each model's best complete baseline (fs or pg; memory is incomplete),
 * pooled over models, with a 2,000-resample task bootstrap as in analyze.ts.
 *
 * Usage: bun docs/benchmarks/2026-10-02-model-ladder/scale-tier/extra-tables.ts <results.jsonl>
 */
import { readFileSync } from 'node:fs';
import type { CellRecord } from '../../../../eval/runner/cat40-model-ladder.ts';

const recs = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as CellRecord);
const models = [...new Set(recs.map(r => r.model))];
const arms = ['oracle', 'fs', 'fs-acl', 'memory', 'pg', 'gbrain'].filter(a => recs.some(r => r.arm === a));
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const L: string[] = [];

L.push('### Agent-loop time per task (seconds; model plus tool time, both sessions for F)', '', `| Model | ${arms.map(a => `${a} p50 / p95`).join(' | ')} |`, `|---|${arms.map(() => '---').join('|')}|`);
for (const m of models) L.push(`| ${m} | ${arms.map(a => { const xs = recs.filter(r => r.model === m && r.arm === a).map(r => (r.run.ms + (r.session1?.ms ?? 0)) / 1000); return xs.length ? `${pct(xs, 0.5).toFixed(0)} / ${pct(xs, 0.95).toFixed(0)}` : 'n/a'; }).join(' | ')} |`);

L.push('', '### How runs ended', '', '| Arm | cells | submitted | turn cap | no tool call | provider error | context window exceeded |', '|---|---|---|---|---|---|---|');
for (const a of arms) {
  const rs = recs.filter(r => r.arm === a);
  const c = (s: string) => rs.filter(r => r.run.stop === s).length;
  L.push(`| ${a} | ${rs.length} | ${c('submitted')} | ${c('turn_cap')} | ${c('no_tool_call')} | ${c('error')} | ${rs.filter(r => /context|too long|maximum.*tokens|exceeds/i.test(r.run.error ?? '')).length} |`);
}

const tasksBy = (a: string) => new Set(recs.filter(r => r.arm === a).map(r => r.task));
const common = [...tasksBy('memory')].filter(t => arms.filter(a => a !== 'fs-acl').every(a => tasksBy(a).has(t))).sort();
L.push('', `### Success on the ${common.length} tasks every arm ran`, '', `Tasks: ${common.join(', ')}.`, '', `| Model | ${arms.filter(a => a !== 'fs-acl').join(' | ')} |`, `|---|${arms.filter(a => a !== 'fs-acl').map(() => '---').join('|')}|`);
for (const m of models) L.push(`| ${m} | ${arms.filter(a => a !== 'fs-acl').map(a => { const rs = recs.filter(r => r.model === m && r.arm === a && common.includes(r.task)); return rs.length ? `${Math.round(100 * rs.filter(r => r.score.success).length / rs.length)}% (${rs.filter(r => r.score.success).length}/${rs.length})` : 'n/a'; }).join(' | ')} |`);

const mulberry = (seed: number) => () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ok = new Map(recs.map(r => [`${r.model}|${r.arm}|${r.task}`, r.score.success ? 1 : 0]));
const allTasks = [...new Set(recs.filter(r => r.arm === 'gbrain').map(r => r.task))].sort();
const rate = (m: string, a: string, ts: string[]) => ts.reduce((s, t) => s + (ok.get(`${m}|${a}|${t}`) ?? 0), 0) / ts.length;
const best = Object.fromEntries(models.map(m => [m, ['fs', 'pg'].sort((x, y) => rate(m, y, allTasks) - rate(m, x, allTasks))[0]]));
const adv = (ts: string[]) => models.reduce((s, m) => s + rate(m, 'gbrain', ts) - rate(m, best[m], ts), 0) / models.length;
L.push('', '### gbrain minus best complete baseline, by family (pooled over models; 95% task bootstrap)', '', `Best baseline per model, chosen on all 50 tasks: ${models.map(m => `${m} ${best[m]}`).join(', ')}.`, '', '| Family | advantage | 95% CI |', '|---|---|---|');
for (const f of [...new Set(allTasks.map(t => t[0])), 'all']) {
  const ts = f === 'all' ? allTasks : allTasks.filter(t => t[0] === f);
  const rnd = mulberry(20261002);
  const boots = Array.from({ length: 2000 }, () => adv(ts.map(() => ts[Math.floor(rnd() * ts.length)]))).sort((a, b) => a - b);
  const pts = (x: number) => `${x >= 0 ? '+' : ''}${Math.round(x * 100)}`;
  L.push(`| ${f} | ${pts(adv(ts))} pts | [${pts(boots[50])}, ${pts(boots[1949])}] |`);
}

L.push('', '### Spend by arm (model, judge and gbrain-internal calls)', '', '| Arm | cells | total $ | $ per cell |', '|---|---|---|---|');
for (const a of arms) { const rs = recs.filter(r => r.arm === a); const usd = rs.reduce((s, r) => s + r.total_usd + ((r as unknown as { judge_usd?: number }).judge_usd ?? 0), 0); L.push(`| ${a} | ${rs.length} | ${usd.toFixed(2)} | ${(usd / rs.length).toFixed(3)} |`); }
console.log(L.join('\n'));

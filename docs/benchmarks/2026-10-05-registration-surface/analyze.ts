/**
 * Registration-surface cell (T1): success, tool errors, request_tools widenings, tokens and cost per surface,
 * and the preregistered paired difference against starter with a 2,000-resample task bootstrap.
 * Run from the repository root: bun docs/benchmarks/2026-10-05-registration-surface/analyze.ts
 */
import { readFileSync } from 'node:fs';
const S = ['starter', 'full', 'verbs'];
const rows: Record<string, any[]> = {};
for (const s of S) rows[s] = readFileSync(`docs/benchmarks/2026-10-05-registration-surface/${s}/results.jsonl`, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const tr: Record<string, Map<string, any[]>> = {};
for (const s of S) { tr[s] = new Map(); for (const l of new TextDecoder().decode(Bun.gunzipSync(readFileSync(`docs/benchmarks/2026-10-05-registration-surface/${s}/transcripts.jsonl.gz`))).trim().split('\n')) { const t = JSON.parse(l); tr[s].set(t.key, t.tools); } }
const models = [...new Set(rows.starter.map(r => r.model))];
const out: any = { by_surface: {}, by_model: {}, paired: {} };
for (const s of S) {
  const r = rows[s];
  const errs = r.reduce((n, x) => n + x.run.tool_calls.filter((c: any) => c.error).length, 0);
  const calls = r.reduce((n, x) => n + x.run.tool_calls.length, 0);
  let widen = 0, rt = 0;
  for (const x of r) for (const c of tr[s].get(x.key) ?? []) { const name = c.name ?? c.tool; if (name === 'request_tools') { rt++; const a = c.args ?? c.arguments ?? c.input ?? {}; if (a.surface) widen++; } }
  const tok = r.reduce((n, x) => n + x.run.usage.input + x.run.usage.cache_read + x.run.usage.cache_write + x.run.usage.output, 0);
  out.by_surface[s] = { success: r.filter(x => x.score.success).length, n: r.length, tool_calls: calls, tool_errors: errs, request_tools_calls: rt, widenings: widen, tokens: tok, usd: +r.reduce((n, x) => n + x.total_usd, 0).toFixed(2), leaks: r.filter(x => x.score.leak || x.score.output_leak).length };
  for (const m of models) { out.by_model[m] ??= {}; const mr = r.filter(x => x.model === m); out.by_model[m][s] = `${mr.filter(x => x.score.success).length}/${mr.length}`; }
}
const key = (x: any) => `${x.model}|${x.task}`;
const tasks = [...new Set(rows.starter.map(r => r.task))];
for (const alt of ['full', 'verbs']) {
  const a = new Map(rows[alt].map(x => [key(x), x.score.success ? 1 : 0]));
  const b = new Map(rows.starter.map(x => [key(x), x.score.success ? 1 : 0]));
  const perTask = tasks.map(t => models.map(m => (a.get(`${m}|${t}`) ?? 0) - (b.get(`${m}|${t}`) ?? 0)));
  const mean = (arr: number[][]) => arr.flat().reduce((s, v) => s + v, 0) / arr.flat().length;
  let seed = 20261005; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const boots: number[] = [];
  for (let i = 0; i < 2000; i++) boots.push(mean(tasks.map(() => perTask[Math.floor(rnd() * tasks.length)])));
  boots.sort((x, y) => x - y);
  out.paired[`${alt}-starter`] = { diff_points: +(100 * mean(perTask)).toFixed(1), ci95: [+(100 * boots[49]).toFixed(1), +(100 * boots[1949]).toFixed(1)] };
}
console.log(JSON.stringify(out, null, 2));

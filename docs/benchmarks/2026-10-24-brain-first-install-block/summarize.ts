#!/usr/bin/env bun
// Summarize per-trial JSONL into per-model, per-arm tables.
// bun summarize.ts results/*.jsonl > summary.md   (also writes summary.json beside the first input)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const files = process.argv.slice(2);
import { grade } from './grade.ts';
const TASKS = new Map((JSON.parse(readFileSync(join(dirname(new URL(import.meta.url).pathname), 'tasks.json'), 'utf8')).tasks as any[]).map((t) => [t.id, t]));
// Regrade from the stored answer and calendar events so a grader fix applies to every row.
const rows = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
  .map((r) => ({ ...r, ...grade(TASKS.get(r.task), r.answer, r.new_events ?? []) }));
const ARMS = ['none', 'default', 'told'];
const key = (r: any) => r.harness + ' / ' + r.model;
const groups = [...new Set(rows.map(key))];
const pct = (k: number, n: number) => n ? k + '/' + n + ' (' + Math.round((100 * k) / n) + '%)' : '–';
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
function wilson(k: number, n: number) {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.round(100 * (c - m) / d), Math.round(100 * (c + m) / d)];
}
const out: string[] = []; const json: any = {};
for (const g of groups) {
  out.push('### ' + g + '\n');
  out.push('| Arm | Trials | Reach (any gbrain tool) | 95% CI | Brain first | Task pass | Brain-only pass | Workspace pass | Displacement: details kept | Scope leaks | gbrain calls (search/query) | gbrain errors | Harness errors | Mean turns | Mean tokens in / out | Spend | Spend per trial |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  json[g] = {};
  for (const arm of ARMS) {
    const rs = rows.filter((r) => key(r) === g && r.arm === arm);
    if (!rs.length) continue;
    const n = rs.length, reach = rs.filter((r) => r.reached).length;
    const brainTasks = rs.filter((r) => r.kind === 'brain' || r.kind === 'paraphrase');
    const ws = rs.filter((r) => r.kind === 'workspace');
    const disp = rs.filter((r) => r.kind === 'displacement');
    const scope = rs.filter((r) => r.kind === 'scope');
    const tin = sum(rs.map((r) => (r.usage?.input ?? 0) + (r.usage?.cache_read ?? 0) * (r.harness === 'codex' ? 0 : 1) + (r.usage?.cache_write ?? 0) * (r.harness === 'codex' ? 0 : 1)));
    const tout = sum(rs.map((r) => r.usage?.output ?? 0));
    const spend = sum(rs.map((r) => r.cost_usd ?? 0));
    const ci = wilson(reach, n);
    const o = {
      trials: n, reach, reach_ci95: ci, brain_first: rs.filter((r) => r.brain_first).length, pass: rs.filter((r) => r.pass).length,
      brain_pass: brainTasks.filter((r) => r.pass).length, brain_n: brainTasks.length, workspace_pass: ws.filter((r) => r.pass).length, workspace_n: ws.length,
      displacement_kept: disp.filter((r) => r.details_kept).length, displacement_pass: disp.filter((r) => r.pass).length, displacement_n: disp.length,
      scope_mentions_to_owner: scope.filter((r) => r.leak_anywhere && !r.leak).length,
      scope_leaks: scope.filter((r) => r.leak && !r.source_ids_calls).length, scope_leaks_after_source_ids: scope.filter((r) => r.leak && r.source_ids_calls).length, scope_n: scope.length,
      source_ids_calls: sum(rs.map((r) => r.source_ids_calls ?? 0)),
      gbrain_calls: sum(rs.map((r) => r.gbrain_calls)), gbrain_search_calls: sum(rs.map((r) => r.gbrain_search_calls)), gbrain_errors: sum(rs.map((r) => r.gbrain_errors)),
      harness_errors: rs.filter((r) => r.harness_error || r.timed_out).length, mean_turns: +(sum(rs.map((r) => r.turns)) / n).toFixed(1),
      mean_tokens_in: Math.round(tin / n), mean_tokens_out: Math.round(tout / n), spend_usd: +spend.toFixed(4), spend_per_trial_usd: +(spend / n).toFixed(4),
    };
    json[g][arm] = o;
    out.push('| ' + [arm, n, pct(reach, n), ci[0] + '–' + ci[1] + '%', pct(o.brain_first, n), pct(o.pass, n), pct(o.brain_pass, o.brain_n), pct(o.workspace_pass, o.workspace_n),
      pct(o.displacement_kept, o.displacement_n), o.scope_leaks + '/' + o.scope_n, o.gbrain_calls + ' (' + o.gbrain_search_calls + ')', o.gbrain_errors, o.harness_errors, o.mean_turns,
      o.mean_tokens_in.toLocaleString('en-US') + ' / ' + o.mean_tokens_out.toLocaleString('en-US'), '$' + spend.toFixed(2), '$' + (spend / n).toFixed(4)].join(' | ') + ' |');
  }
  out.push('');
  // per-task reach and pass by arm
  out.push('<details><summary>Per task: reach / pass by arm</summary>\n');
  out.push('| Task | Kind | ' + ARMS.map((a) => a + ' reach | ' + a + ' pass').join(' | ') + ' |');
  out.push('|---|---|' + ARMS.map(() => '---|---').join('|') + '|');
  for (const t of [...new Set(rows.filter((r) => key(r) === g).map((r) => r.task))].sort()) {
    const cells = ARMS.map((a) => { const rs = rows.filter((r) => key(r) === g && r.arm === a && r.task === t); return rs.filter((r) => r.reached).length + '/' + rs.length + ' | ' + rs.filter((r) => r.pass).length + '/' + rs.length; });
    out.push('| ' + t + ' | ' + rows.find((r) => r.task === t).kind + ' | ' + cells.join(' | ') + ' |');
  }
  out.push('\n</details>\n');
}
const total = sum(rows.map((r) => r.cost_usd ?? 0));
out.push('Total trials: ' + rows.length + '. Total model spend: $' + total.toFixed(2) + '.');
console.log(out.join('\n'));
writeFileSync(join(dirname(files[0]!), 'summary.json'), JSON.stringify({ total_trials: rows.length, total_spend_usd: +total.toFixed(4), groups: json }, null, 2) + '\n');

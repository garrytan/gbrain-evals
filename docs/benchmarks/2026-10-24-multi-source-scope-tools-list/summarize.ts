#!/usr/bin/env bun
// Summarizes results/scope.jsonl and results/starter.jsonl into results/summary.json and summary.md.
// 95% intervals: Wilson for proportions; paired bootstrap over tasks (2,000 resamples, fixed seed) for
// PR - base deltas.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wilson } from '../../../eval/runner/cat40/analyze.ts';
import { crossPagesOf, gradeScope, gradeStarter } from './grade.ts';
import { SCOPE_TASKS, STARTER_TASKS, allowedSources, type Member } from './tasks.ts';

const R = join(import.meta.dir, 'results');
// Every record is re-graded from its raw tool calls and answer with the current grade.ts and tasks.ts; the
// record's own `grade` field is the grade at run time (see the report for the two expect lists widened after the run).
const regrade = (r: any) => {
  if (r.suite === 'scope') r.grade = gradeScope(SCOPE_TASKS.find(t => t.id === r.task_id)!, r.arm, r.tool_calls, r.answer);
  else r.grade = gradeStarter(STARTER_TASKS.find(t => t.id === r.task_id)!, r.tool_calls, r.answer);
  return r;
};
const load = (f: string) => existsSync(join(R, f)) ? readFileSync(join(R, f), 'utf8').split('\n').filter(Boolean).map(l => regrade(JSON.parse(l))) : [];
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol', 'gpt-6-astra'];
const pct = (k: number, n: number) => n ? (100 * k / n).toFixed(1) + '%' : '-';
const ci = (k: number, n: number) => { if (!n) return '-'; const [lo, hi] = wilson(k, n); return '[' + (100 * lo).toFixed(1) + ', ' + (100 * hi).toFixed(1) + ']'; };
const prop = (k: number, n: number) => k + '/' + n + ' (' + pct(k, n) + ' ' + ci(k, n) + ')';
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const tokensIn = (r: any) => r.usage.input + r.usage.cache_read + r.usage.cache_write;
let seed = 156;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

const md: string[] = [];
const json: Record<string, unknown> = {};

// ---------- scope ----------
const scope = load('scope.jsonl').filter(r => r.stop !== 'error');
const scopeErrors = load('scope.jsonl').filter(r => r.stop === 'error').length;
if (scope.length) {
  const rows: any[] = [];
  md.push('## Scope arms (gbrain serve --http, starter surface, read-only bearer tokens)', '',
    'S0: one token granted every source, no scope instruction. S1: same token, system prompt names the requester\'s sources and asks for source_ids. S2: a per-member token granted only shared + the member\'s source.', '',
    '| Model | Arm | n | Trials with any cross-source page in a tool result | Cross-source pages (sum, distinct per trial) | Cross-source pages from scoped search/query calls | Answer leaks (other member\'s canary or private fact) | Answer leaks on adversarial prompts | Task correct | search/query calls carrying an in-grant source_ids | permission_denied results |',
    '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const model of MODELS) for (const arm of ['S0', 'S1', 'S2']) {
    const rs = scope.filter(r => r.model === model && r.arm === arm);
    if (!rs.length) continue;
    let scopedCross = 0;
    for (const r of rs) {
      const allowed = new Set(allowedSources(r.member as Member));
      for (const c of r.tool_calls) if ((c.name === 'search' || c.name === 'query') && Array.isArray(c.args.source_ids) && c.args.source_ids.length) scopedCross += crossPagesOf(c.result, allowed).size;
    }
    const adv = rs.filter(r => r.kind === 'adversarial');
    const row = {
      model, arm, n: rs.length,
      trials_with_cross: rs.filter(r => r.grade.cross_source_page_count > 0).length,
      cross_pages_sum: rs.reduce((a, r) => a + r.grade.cross_source_page_count, 0),
      cross_pages_from_scoped_calls: scopedCross,
      answer_leaks: rs.filter(r => r.grade.answer_leak).length,
      adversarial_n: adv.length, adversarial_leaks: adv.filter(r => r.grade.answer_leak).length,
      correct: rs.filter(r => r.grade.answer_ok).length,
      search_query_calls: rs.reduce((a, r) => a + r.grade.search_query_calls, 0),
      search_query_calls_scoped: rs.reduce((a, r) => a + r.grade.search_query_calls_scoped, 0),
      permission_denied: rs.reduce((a, r) => a + r.grade.permission_denied_calls, 0),
      cross_by_tool: rs.reduce((acc: Record<string, number>, r) => { for (const [k, v] of Object.entries(r.grade.cross_by_tool as Record<string, number>)) acc[k] = (acc[k] ?? 0) + v; return acc; }, {}),
      usd: rs.reduce((a, r) => a + r.usd, 0),
    };
    rows.push(row);
    md.push('| ' + [model, arm, row.n, prop(row.trials_with_cross, row.n), row.cross_pages_sum, row.cross_pages_from_scoped_calls, prop(row.answer_leaks, row.n), prop(row.adversarial_leaks, row.adversarial_n), prop(row.correct, row.n),
      row.search_query_calls_scoped + '/' + row.search_query_calls, row.permission_denied].join(' | ') + ' |');
  }
  md.push('');
  const pooled: any[] = [];
  md.push('Pooled over models:', '', '| Arm | n | Trials with any cross-source page | Answer leaks | Adversarial answer leaks | Task correct |', '|---|---|---|---|---|---|');
  for (const arm of ['S0', 'S1', 'S2']) {
    const rs = rows.filter(r => r.arm === arm);
    const n = rs.reduce((a, r) => a + r.n, 0), cross = rs.reduce((a, r) => a + r.trials_with_cross, 0), leak = rs.reduce((a, r) => a + r.answer_leaks, 0);
    const advN = rs.reduce((a, r) => a + r.adversarial_n, 0), advL = rs.reduce((a, r) => a + r.adversarial_leaks, 0), ok = rs.reduce((a, r) => a + r.correct, 0);
    pooled.push({ arm, n, trials_with_cross: cross, answer_leaks: leak, adversarial_n: advN, adversarial_leaks: advL, correct: ok });
    md.push('| ' + [arm, n, prop(cross, n), prop(leak, n), prop(advL, advN), prop(ok, n)].join(' | ') + ' |');
  }
  md.push('');
  const byKind: any[] = [];
  md.push('By task kind (pooled over models): trials with any cross-source page / answer leaks / correct', '', '| Arm | shared-topic | own private | adversarial |', '|---|---|---|---|');
  for (const arm of ['S0', 'S1', 'S2']) {
    const cell = (kind: string) => { const rs = scope.filter(r => r.arm === arm && r.kind === kind); const c = rs.filter(r => r.grade.cross_source_page_count > 0).length, l = rs.filter(r => r.grade.answer_leak).length, o = rs.filter(r => r.grade.answer_ok).length; byKind.push({ arm, kind, n: rs.length, cross: c, leak: l, correct: o }); return c + ' / ' + l + ' / ' + o + ' of ' + rs.length; };
    md.push('| ' + [arm, cell('shared'), cell('own'), cell('adversarial')].join(' | ') + ' |');
  }
  md.push('');
  json.scope = { rows, pooled, by_kind: byKind, errors_excluded: scopeErrors };
}

// ---------- starter ----------
const starter = load('starter.jsonl').filter(r => r.stop !== 'error');
const starterErrors = load('starter.jsonl').filter(r => r.stop === 'error').length;
if (starter.length) {
  const rows: any[] = [];
  md.push('## Starter tools/list (gbrain serve over stdio, starter surface): base ccce3b49 vs PR #7481 ff862f80', '',
    '| Model | Arm | tools/list bytes | n | Reach (called a gbrain tool) | Correct | Mean input tokens / trial | Mean output tokens / trial | Mean gbrain calls | Mean model turns | USD / trial |',
    '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const model of MODELS) for (const arm of ['base', 'pr']) {
    const rs = starter.filter(r => r.model === model && r.arm === arm);
    if (!rs.length) continue;
    const row = { model, arm, tools_list_bytes: rs[0].tools_list_bytes, n: rs.length, reach: rs.filter(r => r.grade.reached).length, correct: rs.filter(r => r.grade.answer_ok).length,
      input_tokens: mean(rs.map(tokensIn)), output_tokens: mean(rs.map(r => r.usage.output)), gbrain_calls: mean(rs.map(r => r.grade.gbrain_calls)), turns: mean(rs.map(r => r.turns)), usd: mean(rs.map(r => r.usd)) };
    rows.push(row);
    md.push('| ' + [model, arm, row.tools_list_bytes, row.n, prop(row.reach, row.n), prop(row.correct, row.n), Math.round(row.input_tokens), Math.round(row.output_tokens), row.gbrain_calls.toFixed(2), row.turns.toFixed(2), '$' + row.usd.toFixed(4)].join(' | ') + ' |');
  }
  md.push('');
  const deltas: any[] = [];
  md.push('PR minus base, per model (95% paired bootstrap over tasks):', '', '| Model | Reach delta (pp) | Correct delta (pp) | Input tokens / trial delta | Input tokens delta % |', '|---|---|---|---|---|');
  for (const model of MODELS) {
    const ms = starter.filter(r => r.model === model);
    const tasks = [...new Set(ms.map(r => r.task_id))];
    if (!ms.some(r => r.arm === 'base') || !ms.some(r => r.arm === 'pr')) continue;
    const per = Object.fromEntries(tasks.map(t => [t, { base: ms.filter(r => r.task_id === t && r.arm === 'base'), pr: ms.filter(r => r.task_id === t && r.arm === 'pr') }]));
    const stat = (ts: string[], f: (r: any) => number) => {
      const b = ts.flatMap(t => per[t].base.map(f)), p = ts.flatMap(t => per[t].pr.map(f));
      return { d: mean(p) - mean(b), rel: mean(b) ? (mean(p) - mean(b)) / mean(b) : 0 };
    };
    const metrics = { reach: (r: any) => r.grade.reached ? 1 : 0, correct: (r: any) => r.grade.answer_ok ? 1 : 0, tokens: tokensIn };
    const point = Object.fromEntries(Object.entries(metrics).map(([k, f]) => [k, stat(tasks, f)]));
    const boots: Record<string, number[]> = { reach: [], correct: [], tokens: [], tokens_rel: [] };
    for (let i = 0; i < 2000; i++) {
      const sample = tasks.map(() => tasks[Math.floor(rnd() * tasks.length)]);
      boots.reach.push(stat(sample, metrics.reach).d); boots.correct.push(stat(sample, metrics.correct).d);
      const tk = stat(sample, metrics.tokens); boots.tokens.push(tk.d); boots.tokens_rel.push(tk.rel);
    }
    const q = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return [s[Math.floor(0.025 * s.length)], s[Math.floor(0.975 * s.length)]]; };
    const d = { model, tasks: tasks.length, reach_pp: 100 * point.reach.d, reach_ci: q(boots.reach).map(x => 100 * x), correct_pp: 100 * point.correct.d, correct_ci: q(boots.correct).map(x => 100 * x),
      input_tokens: point.tokens.d, input_tokens_ci: q(boots.tokens), input_tokens_pct: 100 * point.tokens.rel, input_tokens_pct_ci: q(boots.tokens_rel).map(x => 100 * x) };
    deltas.push(d);
    const f1 = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(1);
    md.push('| ' + [model, f1(d.reach_pp) + ' [' + f1(d.reach_ci[0]) + ', ' + f1(d.reach_ci[1]) + ']', f1(d.correct_pp) + ' [' + f1(d.correct_ci[0]) + ', ' + f1(d.correct_ci[1]) + ']',
      (d.input_tokens >= 0 ? '+' : '') + Math.round(d.input_tokens) + ' [' + Math.round(d.input_tokens_ci[0]) + ', ' + Math.round(d.input_tokens_ci[1]) + ']', f1(d.input_tokens_pct) + '% [' + f1(d.input_tokens_pct_ci[0]) + ', ' + f1(d.input_tokens_pct_ci[1]) + ']'].join(' | ') + ' |');
  }
  md.push('');
  const hidden: any[] = [];
  md.push('Hidden-parameter tasks (the PR leaves the parameter out of the starter list; it is still accepted):', '', '| Task | Model | Arm | n | Correct | Passed the parameter | Called request_tools | Mean gbrain calls |', '|---|---|---|---|---|---|---|---|');
  for (const task of ['H01', 'H02']) for (const model of MODELS) for (const arm of ['base', 'pr']) {
    const rs = starter.filter(r => r.task_id === task && r.model === model && r.arm === arm);
    if (!rs.length) continue;
    const h = { task, model, arm, n: rs.length, correct: rs.filter(r => r.grade.answer_ok).length, used_param: rs.filter(r => r.grade.used_hidden_param).length, request_tools: rs.filter(r => r.grade.request_tools_calls > 0).length, gbrain_calls: mean(rs.map(r => r.grade.gbrain_calls)) };
    hidden.push(h);
    md.push('| ' + [task, model, arm, h.n, h.correct + '/' + h.n, h.used_param + '/' + h.n, h.request_tools + '/' + h.n, h.gbrain_calls.toFixed(2)].join(' | ') + ' |');
  }
  md.push('');
  json.starter = { rows, deltas, hidden, errors_excluded: starterErrors };
}

const all = [...load('scope.jsonl'), ...load('starter.jsonl')];
json.cost = { usd: all.reduce((a, r) => a + r.usd, 0), trials: all.length, by_model: Object.fromEntries(MODELS.map(m => [m, all.filter(r => r.model === m).reduce((a, r) => a + r.usd, 0)])) };
md.push('Model spend in counted trials (priced from provider usage): $' + (json.cost as any).usd.toFixed(2) + ' over ' + all.length + ' trials.');
writeFileSync(join(R, 'summary.json'), JSON.stringify(json, null, 2) + '\n');
writeFileSync(join(import.meta.dir, 'summary.md'), '# Summary tables\n\nGenerated by summarize.ts from results/*.jsonl.\n\n' + md.join('\n') + '\n');
console.log(md.join('\n'));

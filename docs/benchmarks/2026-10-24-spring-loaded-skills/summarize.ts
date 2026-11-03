#!/usr/bin/env bun
// Summarizes counted trial rows and standing-token probe rows into summary.json and Markdown.
// bun summarize.ts --probe results/probe-*.jsonl -- results/claude-code.jsonl results/codex.jsonl > summary.md
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const HERE = dirname(new URL(import.meta.url).pathname);
const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const probeFiles = argv[0] === '--probe' ? argv.slice(1, sep < 0 ? argv.length : sep) : [];
const files = sep < 0 ? (argv[0] === '--probe' ? [] : argv) : argv.slice(sep + 1);
const read = (f: string) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const rows = files.flatMap(read);
const probes = probeFiles.flatMap(read);
const HARNESS_ORDER = ['claude-code', 'codex'];
const MODEL_ORDER = ['claude-sonnet-5-5', 'gpt-6.1-sol', 'claude-opus-5-5'];
const ARMS = ['off', 'native', 'spring'];
// A cell is harness | model | permission configuration (real, or the secondary mcp-allow).
const keyOf = (r: any) => r.harness + '|' + r.model + '|' + (r.perm_mode ?? 'real');
const PERM_ORDER = ['real', 'mcp-allow', 'bypass'];
const cells = [...new Set(rows.map(keyOf))].sort((a, b) => {
  const [ha, ma, pa] = a.split('|'); const [hb, mb, pb] = b.split('|');
  return PERM_ORDER.indexOf(pa!) - PERM_ORDER.indexOf(pb!) || MODEL_ORDER.indexOf(ma!) - MODEL_ORDER.indexOf(mb!) || HARNESS_ORDER.indexOf(ha!) - HARNESS_ORDER.indexOf(hb!);
});
const label = (c: string) => { const [h, m, p] = c.split('|'); return (h === 'claude-code' ? 'Claude Code' : 'Codex') + ', ' + m + (p === 'real' ? '' : ' [' + p + ']'); };
const frac = (k: number, n: number) => n ? k + '/' + n + ' (' + Math.round((100 * k) / n) + '%)' : '-';
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

function stats(rs: any[]) {
  const sk = rs.filter((r) => r.kind === 'skill'); const ctl = rs.filter((r) => r.kind === 'control');
  return {
    trials: rs.length, skill_trials: sk.length, control_trials: ctl.length,
    right_skill_used: sk.filter((r) => r.right_skill_used).length,
    expected_loaded_anytime: sk.filter((r) => r.expected_loaded_anytime).length,
    wrong_skill_only: sk.filter((r) => r.wrong_skill_only).length,
    pass: sk.filter((r) => r.pass).length,
    control_pass: ctl.filter((r) => r.pass).length,
    over_fetch: ctl.filter((r) => r.over_fetch).length,
    trials_with_denial: rs.filter((r) => (r.permission_denials ?? 0) > 0).length,
    denials: rs.reduce((a, r) => a + (r.permission_denials ?? 0), 0),
    denied_skill_loads: rs.reduce((a, r) => a + (r.denied_skill_loads ?? 0), 0),
    bundled_skill_cli_trials: rs.filter((r) => (r.skill_loads ?? []).some((l: any) => l.via === 'cli-bundled-skill')).length,
    harness_errors: rs.filter((r) => r.harness_error || r.timed_out).length,
    cost_per_trial: mean(rs.map((r) => r.cost_usd)),
    input_tokens_per_trial: mean(rs.map((r) => r.usage.input_total)),
    output_tokens_per_trial: mean(rs.map((r) => r.usage.output)),
    total_cost: rs.reduce((a, r) => a + r.cost_usd, 0),
  };
}

// Standing tokens: input tokens of one "Reply with the single word OK" turn, main model only.
const standing: Record<string, Record<string, number | null>> = {};
for (const p of probes) {
  const k = p.harness + '|' + p.model; standing[k] ??= {};
  (standing[k] as any)['_' + p.arm] ??= [];
  (standing[k] as any)['_' + p.arm].push(p.usage.main_input_total ?? p.usage.input_total);
}
for (const k of Object.keys(standing)) for (const a of ['bare', ...ARMS]) { const xs = (standing[k] as any)['_' + a] ?? []; standing[k]![a] = median(xs); (standing[k] as any)[a + '_samples'] = xs; delete (standing[k] as any)['_' + a]; }

const out: any = { generated: new Date().toISOString(), cells: {}, per_task: {}, decision: {}, standing_tokens: standing };
for (const c of cells) {
  out.cells[c] = {};
  for (const arm of ARMS) out.cells[c][arm] = stats(rows.filter((r) => keyOf(r) === c && r.arm === arm));
}
const taskIds = [...new Set(rows.map((r) => r.task))].sort();
for (const c of cells) { out.per_task[c] = {}; for (const t of taskIds) { out.per_task[c][t] = {}; for (const arm of ARMS) { const rs = rows.filter((r) => keyOf(r) === c && r.arm === arm && r.task === t); out.per_task[c][t][arm] = { n: rs.length, right: rs.filter((r) => r.right_skill_used).length, pass: rs.filter((r) => r.pass).length, loaded: rs.map((r) => r.skills_loaded) }; } } }

// Preregistered decision rule, per harness, pooled over that harness's models.
for (const h of HARNESS_ORDER) for (const pm of PERM_ORDER) {
  const hr = rows.filter((r) => r.harness === h && (r.perm_mode ?? 'real') === pm && r.kind === 'skill');
  if (!hr.length) continue;
  const n = (arm: string, f: (r: any) => boolean) => hr.filter((r) => r.arm === arm && f(r)).length;
  const R = Object.fromEntries(ARMS.map((a) => [a, n(a, (r) => r.right_skill_used)]));
  const P = Object.fromEntries(ARMS.map((a) => [a, n(a, (r) => r.pass)]));
  const N = Object.fromEntries(ARMS.map((a) => [a, n(a, () => true)]));
  const models = [...new Set(hr.map((r) => r.model))];
  const st = models.map((m) => ({ model: m, ...(standing[h + '|' + m] ?? {}) })) as any[];
  const tokensBelowNative = st.length > 0 && st.every((s) => s.spring != null && s.native != null && s.spring < s.native);
  const right_ok = R.spring >= R.off && R.spring >= R.native - 1;
  const pass_ok = P.spring >= P.off && P.spring >= P.native - 1;
  out.decision[h + '|' + pm] = {
    trials: N, right_skill_used: R, pass: P, right_ok, pass_ok, standing_tokens_below_native: tokensBelowNative,
    spring_added_standing_tokens_over_off: Object.fromEntries(st.map((s) => [s.model, s.spring != null && s.off != null ? s.spring - s.off : null])),
    propose_spring_default: right_ok && pass_ok && tokensBelowNative,
  };
}
writeFileSync(join(HERE, 'summary.json'), JSON.stringify(out, null, 2) + '\n');

const L: string[] = [];
L.push('# Spring-loaded skills A/B: summary', '', 'Generated by summarize.ts from ' + rows.length + ' counted trials and ' + probes.length + ' standing-token probes.', '');
L.push('## Skill-requiring tasks (12) and controls (3)', '');
L.push('| Harness and model | Arm | Skill trials | Right skill used | Expected skill loaded at all | Only a wrong skill | Pass | Control over-fetch | Control pass | Trials with a denial | Input tokens per trial | Spend per trial |');
L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const c of cells) for (const arm of ARMS) {
  const s = out.cells[c][arm]; if (!s.trials) continue;
  L.push('| ' + (arm === 'off' ? label(c) : '') + ' | ' + arm + ' | ' + s.skill_trials + ' | ' + frac(s.right_skill_used, s.skill_trials) + ' | ' + frac(s.expected_loaded_anytime, s.skill_trials) + ' | ' + s.wrong_skill_only + ' | ' + frac(s.pass, s.skill_trials) + ' | ' + frac(s.over_fetch, s.control_trials) + ' | ' + frac(s.control_pass, s.control_trials) + ' | ' + frac(s.trials_with_denial, s.trials) + ' | ' + Math.round(s.input_tokens_per_trial).toLocaleString('en-US') + ' | $' + s.cost_per_trial.toFixed(4) + ' |');
}
L.push('', '## Standing input tokens per turn ("Reply with the single word OK")', '');
L.push('| Harness and model | bare | off | native | spring | off vs bare | native vs off | spring vs off |', '|---|---|---|---|---|---|---|---|');
const sgn = (x: number | null) => x == null ? '-' : (x >= 0 ? '+' : '') + x.toLocaleString('en-US');
for (const k of Object.keys(standing).sort((a, b) => MODEL_ORDER.indexOf(a.split('|')[1]!) - MODEL_ORDER.indexOf(b.split('|')[1]!))) {
  const s = standing[k]!; const d = (a: string, b: string) => s[a] != null && s[b] != null ? (s[a] as number) - (s[b] as number) : null;
  L.push('| ' + k.replace('|', ', ') + ' | ' + ['bare', 'off', 'native', 'spring'].map((a) => s[a]?.toLocaleString('en-US') ?? '-').join(' | ') + ' | ' + sgn(d('off', 'bare')) + ' | ' + sgn(d('native', 'off')) + ' | ' + sgn(d('spring', 'off')) + ' |');
}
L.push('', '## Decision rule (per harness and permission configuration, pooled over models)', '');
for (const [h, d] of Object.entries<any>(out.decision)) L.push('- **' + h.replace('|', ', ') + '**: right skill used off ' + d.right_skill_used.off + ', native ' + d.right_skill_used.native + ', spring ' + d.right_skill_used.spring + ' (of ' + d.trials.spring + '); pass off ' + d.pass.off + ', native ' + d.pass.native + ', spring ' + d.pass.spring + '; spring standing tokens below native: ' + d.standing_tokens_below_native + '. Propose spring as default: **' + (d.propose_spring_default ? 'yes' : 'no') + '**.');
L.push('', '## Per task (right skill used / pass)', '');
for (const c of cells) {
  L.push('### ' + label(c), '', '| Task | Expected skill | off | native | spring |', '|---|---|---|---|---|');
  for (const t of taskIds) { const pt = out.per_task[c][t]; const exp = rows.find((r) => r.task === t)?.expected_skill ?? '(control)'; L.push('| ' + t + ' | ' + exp + ' | ' + ARMS.map((a) => pt[a].n ? pt[a].right + '/' + pt[a].n + ' · ' + pt[a].pass + '/' + pt[a].n : '-').join(' | ') + ' |'); }
  L.push('');
}
console.log(L.join('\n'));

#!/usr/bin/env bun
/**
 * Cat 41 setup TTHW re-measure: per-cell timings and the verdict against the frozen targets of
 * docs/benchmarks/2026-10-12-cat41-setup-remeasure-preregistration.md, from a pass's scores.jsonl (scorer v7) and
 * its run directories (crash retries are the `-a<N>` attempts beyond the first). Interventions are scripted replies
 * plus closing questions nobody answered plus crash retries plus developer interventions (none recorded here; the
 * report lists any).
 *
 *   bun eval/runner/cat41/tthw-verdict.ts <pass dir> > verdict.json
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Score {
  scenario: string; repeat: number; status: string; success: boolean; success_why: string; consent_violations: number;
  wall_ms: number; session_wall_ms: number[]; cost_usd: number | null; mcp_calls: number; gbrain_cli_calls: number;
  install?: { download_ms: number | null; user_round_trips: number; agent_ms: number; fabricated_user_facts: number | null; input_requests: number; unanswered_input_requests: number };
}

const dir = process.argv[2];
if (!dir) throw new Error('usage: verdict.ts <pass dir>');
const scores: Score[] = readFileSync(join(dir, 'scores.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const runsDir = join(dir, 'runs');
const attempts = existsSync(runsDir) ? readdirSync(runsDir).sort() : [];

const s1 = (ms: number) => Math.round(ms / 100) / 10;
const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length ? (a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) : null; };
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

function cell(id: string) {
  const rs = scores.filter(s => s.scenario === id).sort((a, b) => a.repeat - b.repeat);
  const ok = rs.filter(s => s.status === 'scored' && s.success);
  const retries = attempts.filter(d => d.startsWith(`${id}--`) && !/-a0$/.test(d)).length;
  const replies = rs.reduce((a, s) => a + (s.install?.user_round_trips ?? 0), 0);
  const unanswered = rs.reduce((a, s) => a + (s.install?.unanswered_input_requests ?? 0), 0);
  return {
    scenario: id, runs: rs.length, successes: ok.length,
    consent_violations: rs.reduce((a, s) => a + s.consent_violations, 0),
    wall_s: { mean: mean(rs.map(s => s.wall_ms)) === null ? null : s1(mean(rs.map(s => s.wall_ms))!), median_all: median(rs.map(s => s.wall_ms)) === null ? null : s1(median(rs.map(s => s.wall_ms))!), median_successful: median(ok.map(s => s.wall_ms)) === null ? null : s1(median(ok.map(s => s.wall_ms))!), min: rs.length ? s1(Math.min(...rs.map(s => s.wall_ms))) : null, max: rs.length ? s1(Math.max(...rs.map(s => s.wall_ms))) : null },
    download_s_mean: mean(rs.map(s => s.install?.download_ms ?? 0)) === null ? null : s1(mean(rs.map(s => s.install?.download_ms ?? 0))!),
    agent_s_mean: mean(rs.map(s => s.install?.agent_ms ?? 0)) === null ? null : s1(mean(rs.map(s => s.install?.agent_ms ?? 0))!),
    user_replies: replies, unanswered_input_requests: unanswered, crash_retries: retries, developer_interventions: 0, interventions: replies + unanswered + retries,
    cost_usd: Number(rs.reduce((a, s) => a + (s.cost_usd ?? 0), 0).toFixed(4)),
    per_run: rs.map(s => ({
      repeat: s.repeat, status: s.status, success: s.success, why: s.success_why, wall_s: s1(s.wall_ms), sessions_s: s.session_wall_ms.map(s1),
      download_s: s.install?.download_ms == null ? null : s1(s.install.download_ms), agent_s: s.install ? s1(s.install.agent_ms) : null,
      user_replies: s.install?.user_round_trips ?? null, input_requests: s.install?.input_requests ?? null, unanswered_input_requests: s.install?.unanswered_input_requests ?? null, consent_violations: s.consent_violations, fabricated_user_facts: s.install?.fabricated_user_facts ?? null,
      mcp_calls: s.mcp_calls, gbrain_cli_calls: s.gbrain_cli_calls, cost_usd: s.cost_usd,
    })),
  };
}

const A = cell('setup_to_wired_recall');
const B = cell('manual_import_to_recall');
const C = cell('setup_import_to_recall');
const D = cell(scores.some(s => s.scenario === 'fresh_install_to_first_push_pref') ? 'fresh_install_to_first_push_pref' : 'fresh_install_to_first_push');
const E = cell('setup_consent_negative');
const F = scores.some(s => s.scenario === 'fresh_install_to_wired_recall') ? cell('fresh_install_to_wired_recall') : null;

const wired = { target: '3/3 successes and mean wall <= 60.0 s', pass: A.runs === 3 && A.successes === 3 && A.wall_s.mean !== null && A.wall_s.mean <= 60 };
const pushRuns = D.per_run.map(r => r.status === 'scored' && r.success && r.wall_s <= 120 && (r.user_replies ?? 99) <= 1 && r.consent_violations === 0);
const firstPush = { target: 'each of 3 runs: success, wall <= 120.0 s, <= 1 user reply, 0 consent violations', runs_meeting: pushRuns.filter(Boolean).length, pass: D.runs === 3 && pushRuns.every(Boolean) };
const bMed = B.successes >= 2 ? B.wall_s.median_successful : null;
const cMed = C.wall_s.median_successful;
const faster = {
  rule: 'C median <= 0.75 x B median (successful runs), C 3/3, B >= 2/3, C interventions <= B interventions (scripted replies + unanswered input requests + crash retries + developer interventions)',
  b_median_s: bMed, c_median_s: cMed, ratio: bMed && cMed ? Number((cMed / bMed).toFixed(3)) : null,
  reduction_pct: bMed && cMed ? Number(((1 - cMed / bMed) * 100).toFixed(1)) : null,
  interventions: { manual: B.interventions, setup: C.interventions },
  claim: C.runs === 3 && C.successes === 3 && bMed !== null && cMed !== null && cMed <= 0.75 * bMed && C.interventions <= B.interventions,
};
const consent = { target: '0 consent violations in each of 3 runs', pass: E.runs === 3 && E.per_run.every(r => r.status === 'scored' && r.consent_violations === 0) };

console.log(JSON.stringify({ cells: { A, B, C, D, E, ...(F ? { F } : {}) }, verdict: { wired_recall: wired, first_push: firstPush, faster_setup: faster, consent_negative: consent } }, null, 2));

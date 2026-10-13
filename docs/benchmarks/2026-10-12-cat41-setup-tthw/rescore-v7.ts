#!/usr/bin/env bun
/**
 * Re-score the published Cat 41 setup TTHW pass (scored with cat41-score-v6) with the current scorer (v7), to show
 * what the classifier change alone does to the same transcripts. No session is rerun: wall times, replies the
 * scripted user actually sent and the runs themselves are unchanged. The published report and scores stay as they
 * are; this file sits beside them.
 *
 *   bun docs/benchmarks/2026-10-12-cat41-setup-tthw/rescore-v7.ts > docs/benchmarks/2026-10-12-cat41-setup-tthw/rescore-v7.json
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scoreDir } from '../../../eval/runner/cat41-agent-operator.ts';
import { SCORER_VERSION, type RunScore } from '../../../eval/runner/cat41/classify.ts';

const HERE = import.meta.dir;
const REPO = resolve(HERE, '../../..');
const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

function rescore(pass: string): { published: RunScore[]; current: RunScore[] } {
  const dir = join(REPO, pass);
  const tmp = mkdtempSync(join(tmpdir(), 'cat41-rescore-'));
  try {
    execFileSync('tar', ['-xzf', join(dir, 'runs.tar.gz'), '-C', tmp]);
    const published = readFileSync(join(dir, 'scores.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as RunScore);
    return { published, current: scoreDir(tmp).scores };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const { published, current } = rescore('docs/benchmarks/2026-10-12-cat41-setup-tthw/setup-tthw-a618302');
const key = (s: RunScore) => `${s.scenario}|${s.repeat}`;
const v6 = new Map(published.map(s => [key(s), s]));
const runs = current.map(s => {
  const p = v6.get(key(s))!;
  return {
    scenario: s.scenario, repeat: s.repeat, wall_s: Math.round(s.wall_ms / 100) / 10,
    v6: { success: p.success, why: p.success_why, consent_violations: p.consent_violations, user_replies: p.install?.user_round_trips ?? null },
    v7: { success: s.success, why: s.success_why, consent_violations: s.consent_violations, user_replies: s.install?.user_round_trips ?? null, input_requests: s.install?.input_requests ?? null, unanswered_input_requests: s.install?.unanswered_input_requests ?? null },
    changed: p.success !== s.success || p.consent_violations !== s.consent_violations,
  };
});

/** The faster-setup leg with v7 interventions: scripted replies plus closing questions nobody answered. */
const arm = (id: string) => {
  const rs = current.filter(s => s.scenario === id);
  return {
    median_wall_s: Math.round(median(rs.map(s => s.wall_ms)) / 100) / 10,
    replies: rs.reduce((a, s) => a + (s.install?.user_round_trips ?? 0), 0),
    unanswered_input_requests: rs.reduce((a, s) => a + (s.install?.unanswered_input_requests ?? 0), 0),
  };
};
const manual = arm('manual_import_to_recall');
const setup = arm('setup_import_to_recall');

/** The comparator passes: v7 must leave their success and consent results as published. */
const comparators = ['docs/benchmarks/2026-10-09-cat41-rebaseline/rebaseline-dda603a', 'docs/benchmarks/2026-10-09-cat41-rebaseline/control-b3f4e8b'].map(pass => {
  const r = rescore(pass);
  const pub = new Map(r.published.map(s => [`${s.harness}|${s.repeat}`, s]));
  const diffs = r.current.filter(s => { const p = pub.get(`${s.harness}|${s.repeat}`)!; return p.success !== s.success || p.consent_violations !== s.consent_violations; });
  return { pass, runs: r.current.length, success_or_consent_changed: diffs.length, input_requests_unanswered: r.current.reduce((a, s) => a + (s.install?.unanswered_input_requests ?? 0), 0) };
});

console.log(JSON.stringify({
  scorer: SCORER_VERSION, published_scorer: 'cat41-score-v6',
  note: 'Same transcripts, new classifier. Wall times and the replies the scripted user sent are what the v6-era scripted user did; only the counting changed.',
  runs,
  faster_setup_interventions_v7: {
    manual: { ...manual, interventions: manual.replies + manual.unanswered_input_requests },
    setup: { ...setup, interventions: setup.replies + setup.unanswered_input_requests },
  },
  comparators,
}, null, 2));

/**
 * Pairs plain hybrid (eval/runner/precisionmembench-system.ts --system plain-hybrid) with the committed gbrain
 * PrecisionMemBench report case by case, on the upstream metric contract gbrain's 0.586 used: the vendored scorer's
 * per-case retrievalPrecision and retrievalRecall, each mean over the cases where it is defined.
 *
 *   bun docs/benchmarks/2026-11-17-readme-baselines/retrieval/pair-pmb.ts --gbrain <report.json> --baseline <run dir> --output <pair.json>
 *
 * Per metric: the cases defined on both sides, delta = gbrain minus baseline, clusteredPairedDelta with each case
 * its own cluster (seed 20261006, 10,000 draws, as precisionmembench-s3.ts), the exact sign test, and Holm across
 * the two metrics. Secondary: the 43 search-only cases, and every case but isolation-user-scoping (the one case
 * whose input differs between the two harnesses: the old gbrain harness searched by scope for every user, the
 * system runner by user and scope).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { clusteredPairedDelta, holmAdjusted } from '../../../../eval/runner/stats/paired.ts';
import { familyOf, type PmbRow } from '../../../../eval/runner/precisionmembench-system.ts';
import { signTest } from '../../../../eval/runner/retrieval-baselines.ts';

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(n); if (i < 0 || !argv[i + 1]) throw new Error(n + ' is required'); return argv[i + 1]!; };
const gbrain = JSON.parse(readFileSync(flag('--gbrain'), 'utf8')) as { provider: string; retrieval: { meanPrecision: number; meanRecall: number }; cases: Array<{ caseId: string; category: string; retrievalPrecision: number | null; retrievalRecall: number | null }> };
const dir = flag('--baseline');
const receipt = JSON.parse(readFileSync(dir + '/receipt.json', 'utf8'));
const rows = readFileSync(dir + '/rows.ndjson', 'utf8').trim().split('\n').map(l => JSON.parse(l) as PmbRow);
const base = new Map(rows.map(r => [r.case_id, r]));
if (gbrain.cases.length !== 77 || base.size !== 77 || gbrain.cases.some(c => !base.has(c.caseId))) throw new Error('case sets differ');

const metrics = { precision: 'retrievalPrecision', recall: 'retrievalRecall' } as const;
function compare(metric: keyof typeof metrics, keep: (c: (typeof gbrain.cases)[number]) => boolean) {
  const pairs = gbrain.cases.filter(keep).flatMap(c => {
    const g = c[metrics[metric]], b = base.get(c.caseId)![metric];
    return g === null || b === null ? [] : [{ id: c.caseId, cluster: c.caseId, a: b, b: g }];
  });
  const d = clusteredPairedDelta(pairs, { seed: 20261006, draws: 10_000 });
  const better = pairs.filter(p => p.b > p.a).length, worse = pairs.filter(p => p.b < p.a).length;
  return { n_pairs: d.n_pairs, baseline_mean: d.mean_a, gbrain_mean: d.mean_b, delta_gbrain_minus_baseline: d.delta, ci95: d.ci95,
    p_sign_flip: d.p_two_sided, p_method: d.p_method, cases_gbrain_better: better, cases_baseline_better: worse, cases_same: pairs.length - better - worse,
    p_sign_test: signTest(better, worse) };
}
const all = { precision: compare('precision', () => true), recall: compare('recall', () => true) };
const holm = holmAdjusted([all.precision.p_sign_flip, all.recall.p_sign_flip]);
const classify = (c: ReturnType<typeof compare>, p: number) => p < 0.05 ? (c.delta_gbrain_minus_baseline > 0 ? 'win' : 'loss') : 'no measurable difference';
const out = {
  gbrain_report: flag('--gbrain'), gbrain_provider: gbrain.provider, gbrain_upstream: gbrain.retrieval,
  baseline_run: dir, baseline_policy: receipt.policy, baseline_upstream: receipt.summary.upstream, baseline_outcomes: receipt.outcomes,
  contract: 'vendored upstream scorer: mean per-case precision over cases where it is defined, mean recall over cases where it is defined',
  all_cases: { precision: { ...all.precision, p_holm: holm[0], classification: classify(all.precision, holm[0]!) }, recall: { ...all.recall, p_holm: holm[1], classification: classify(all.recall, holm[1]!) } },
  search_only: { precision: compare('precision', c => familyOf(c.category) === 'search-only'), recall: compare('recall', c => familyOf(c.category) === 'search-only') },
  without_isolation_case: { precision: compare('precision', c => c.caseId !== 'isolation-user-scoping'), recall: compare('recall', c => c.caseId !== 'isolation-user-scoping') },
  per_case: gbrain.cases.map(c => ({ case_id: c.caseId, category: c.category, gbrain_precision: c.retrievalPrecision, baseline_precision: base.get(c.caseId)!.precision, gbrain_recall: c.retrievalRecall, baseline_recall: base.get(c.caseId)!.recall })),
};
writeFileSync(flag('--output'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ all_cases: out.all_cases, search_only: out.search_only, without_isolation_case: out.without_isolation_case, baseline_upstream: { meanPrecision: out.baseline_upstream.meanPrecision, meanRecall: out.baseline_upstream.meanRecall } }, null, 1));

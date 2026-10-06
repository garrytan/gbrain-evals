/**
 * Q2 allowlisted aggregate export (runbook last step). Reads every receipt the campaign ledger recorded, copies only
 * the allowlisted aggregate paths (sealed-confirmation-lib.ts exportAggregates refuses any leaf that is not a number,
 * boolean, null or short identifier), and writes one JSON that may leave custody: for Capy Drive's verdict file and
 * the gbrain-evals verdict index. Nothing else leaves custody.
 *
 *   bun eval/runner/q2/export.ts --campaign <root> --step export --run aggregate --out <file>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveGbrainUnderTest } from '../gbrain-under-test.ts';
import { p5Receipt } from '../p5-brain.ts';
import { flagValue } from '../p5-agent.ts';
import { writeReceipt } from '../receipt.ts';
import { exportAggregates } from '../sealed-confirmation-lib.ts';
import { campaignGuard, latestRuns, loadCampaignManifest, readLedger, spentUsd } from './campaign.ts';

/** Aggregate paths that may leave custody, for every Q2 receipt. */
export const Q2_EXPORT_ALLOWLIST: readonly string[] = [
  'category', 'run_status', 'verdict',
  'gates.*.gate', 'gates.*.outcome', 'gates.*.observed', 'gates.*.denominators.*',
  'accounting.planned', 'accounting.attempted', 'accounting.scored', 'accounting.errors', 'cost.usd',
  'data.summary.g1.pages', 'data.summary.g1.list_lines', 'data.summary.g1.minted', 'data.summary.g1.wrong', 'data.summary.g1.correct', 'data.summary.g1.unlabeled',
  'data.summary.g1.wilson_upper_per_100k', 'data.summary.g1.affected_page_rate', 'data.summary.g1.stress_template_or_label_lines', 'data.summary.g1.zero_tolerance_by_class.*', 'data.summary.g1.by_stratum.*.*',
  'data.summary.g3.relation.*', 'data.summary.g3.fact.*', 'data.summary.g3.decoys.*.*', 'data.summary.g3.near_miss_accepted.*', 'data.summary.g3.candidates_by_class.*',
  'data.summary.g4.baseline_correct', 'data.summary.g4.kept', 'data.summary.g4.lost', 'data.summary.g4.share', 'data.summary.g4.per_set.*.*',
  'data.summary.g2.n', 'data.summary.g2.correct', 'data.summary.g2.wilson_lower', 'data.summary.g2.wilson_upper', 'data.summary.g2.per_model.*.*', 'data.summary.g2.by_brain_cluster.*', 'data.summary.g2.fact_precision_reported.*',
  'data.summary.k_mint_precision_reported.*',
  'data.summary.order', 'data.summary.units.*.unit', 'data.summary.units.*.selected', 'data.summary.units.*.p_holm', 'data.summary.units.*.standardized_effect', 'data.summary.units.*.primary.oriented_delta', 'data.summary.units.*.primary.ci95',
  'data.summary.units_that_ship', 'data.summary.units_reverted', 'data.summary.longest_passing_prefix', 'data.summary.stopped_at',
  'data.summary.estimates.*.point', 'data.summary.estimates.*.ci95', 'data.summary.estimates.*.n_answers',
  'data.summary.accuracy', 'data.summary.judged', 'data.summary.answers', 'data.summary.unanswerable_false_answer_rate', 'data.summary.usd_per_question', 'data.summary.usd_per_correct',
  'data.summary.per_model.*.accuracy', 'data.summary.per_model.*.usd_per_question', 'data.summary.per_model.*.usd_per_correct', 'data.summary.audit.*',
  'data.summary.adoption_recall', 'data.summary.meant_as_relation_lines', 'data.summary.minted', 'data.summary.misses_by_reason.*', 'data.summary.per_model.*.adoption_recall',
  'resolved_config.judge_prompt_sha256', 'resolved_config.rubric_sha256', 'resolved_config.seed', 'resolved_config.draws',
];

async function main(argv: string[]): Promise<void> {
  const campaign = campaignGuard(argv);
  if (!campaign) throw new Error('export runs inside the campaign: --campaign <root> --step export --run aggregate --out <file>');
  const out = flagValue(argv, '--out');
  if (!out) throw new Error('pass --out <file> for the aggregate that leaves custody');
  const m = loadCampaignManifest();
  const entries = readLedger(campaign.root);
  const steps: Record<string, unknown> = {};
  for (const [k, e] of latestRuns(entries)) {
    if (!e.receipt.endsWith('.json')) continue;
    const receipt = JSON.parse(readFileSync(join(campaign.root, e.receipt), 'utf8'));
    steps[k.replace('/', '.')] = { ...exportAggregates(receipt, Q2_EXPORT_ALLOWLIST).aggregate, receipt_sha256: e.receipt_sha256, spend_usd: e.spend_usd };
  }
  const aggregate = { decision_id: m.decision_id, exported_at: new Date().toISOString(), spend_usd: spentUsd(entries), approved_usd: m.approved_usd, alert_usd: m.alert_usd, steps };
  writeFileSync(resolve(out), JSON.stringify(aggregate, null, 2) + '\n');
  const receipt = p5Receipt({ category: 'q2-export', gut: resolveGbrainUnderTest(null), startedAt: new Date().toISOString(), rows: [], harnessError: null, summary: { steps: Object.keys(steps).length }, basis: 'no model call', resolvedConfig: { allowlist_entries: Q2_EXPORT_ALLOWLIST.length } });
  writeReceipt(join(campaign.output, 'receipt.json'), receipt);
  campaign.finish(join(campaign.output, 'receipt.json'), 0);
  process.stderr.write(`aggregate: ${resolve(out)} (${Object.keys(steps).length} receipts)\n`);
}

if (import.meta.main) main(process.argv.slice(2)).catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(3); });

/**
 * Q2 G5, carry-over of P5 H1 and H2 (preregistration G5):
 *   G5.world_v1_any_type_match  world-v1 anyTypeMatch, candidate vs baseline (line-grammar-typing receipts, grammar on):
 *                               noninferior at 0.01 (two-sided 95% lower bound of the paired difference > −0.01)
 *   G5.invariance               240/240 world-v1 pages extract identically with the grammar on and off (candidate)
 *   G5.variant_typed_recall     relation-line variants on the custodian's fresh seeds (relation-line-variants
 *                               receipt, candidate): typed recall >= 0.98
 *   G5.variant_decoys_added     decoy types the grammar added = 0, exact
 *
 *   bun eval/runner/q2/g5.ts --world-baseline <receipt> --world-candidate <receipt> --variants <receipt> --output <dir>
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveGbrainUnderTest } from '../gbrain-under-test.ts';
import { p5Receipt } from '../p5-brain.ts';
import { flagValue } from '../p5-agent.ts';
import { writeReceipt, type GateOutcome } from '../receipt.ts';
import { campaignGuard } from './campaign.ts';
import { compareMetric, noninferior, INVARIANT_EXPECTED, NI_MARGIN } from './c-gates.ts';

type Row = Record<string, unknown>;

export function g5Gates(worldBase: readonly Row[], worldCand: readonly Row[], variants: readonly Row[]): GateOutcome[] {
  const c = compareMetric(worldCand, worldBase, { metric: 'anyTypeMatch', direction: 'higher', filter: r => r.kind === 'edge', label: 'world-v1 anyTypeMatch' }, 'id');
  const ni = noninferior(c);
  const inv = worldCand.filter(r => r.kind === 'invariance');
  const same = inv.filter(r => r.extract_identical === 1).length;
  const rel = variants.filter(r => r.kind === 'relation' && typeof r.typed_recall === 'number');
  const recall = rel.length ? rel.reduce((a, r) => a + (r.typed_recall as number), 0) / rel.length : null;
  const decoy = variants.filter(r => r.kind === 'decoy');
  const added = decoy.reduce((a, r) => a + (typeof r.decoy_added_by_grammar === 'number' ? r.decoy_added_by_grammar : 0), 0);
  const d = (n: number, errors = 0) => ({ planned: n, attempted: n, scored: n - errors, errors });
  return [
    { gate: 'G5.world_v1_any_type_match', outcome: ni ? 'pass' : 'fail', threshold: `world-v1 anyTypeMatch noninferior at ${NI_MARGIN}`, observed: c.oriented_lower, denominators: d(c.n_pairs + c.excluded_errors, c.excluded_errors), ...(ni ? {} : { failed_threshold: `lower bound ${c.oriented_lower?.toFixed(4)} <= -${NI_MARGIN}` }) },
    { gate: 'G5.invariance', outcome: same === INVARIANT_EXPECTED && inv.length === INVARIANT_EXPECTED ? 'pass' : inv.length < INVARIANT_EXPECTED ? 'insufficient' : 'fail', threshold: `${INVARIANT_EXPECTED}/${INVARIANT_EXPECTED} pages identical with the grammar on and off`, observed: same, denominators: d(inv.length),
      ...(same === INVARIANT_EXPECTED && inv.length === INVARIANT_EXPECTED ? {} : { failed_threshold: `${same}/${inv.length}` }) },
    { gate: 'G5.variant_typed_recall', outcome: recall === null ? 'insufficient' : recall >= 0.98 ? 'pass' : 'fail', threshold: 'relation-line variants typed recall >= 0.98', observed: recall, denominators: d(rel.length), ...(recall !== null && recall >= 0.98 ? {} : { failed_threshold: recall === null ? 'no relation rows' : `typed recall ${recall.toFixed(4)} < 0.98` }) },
    { gate: 'G5.variant_decoys_added', outcome: decoy.length ? (added === 0 ? 'pass' : 'fail') : 'insufficient', threshold: 'decoy types added by the grammar = 0, exact', observed: added, denominators: d(decoy.length), ...(decoy.length && added === 0 ? {} : { failed_threshold: decoy.length ? `${added} decoy type(s) added` : 'no decoy rows' }) },
  ];
}

async function main(argv: string[]): Promise<void> {
  const campaign = campaignGuard(argv);
  const output = campaign?.output ?? flagValue(argv, '--output');
  const read = (flag: string) => { const f = flagValue(argv, flag); if (!f) throw new Error(`pass ${flag} <receipt>`); const r = JSON.parse(readFileSync(f, 'utf8')) as { run_status: string; data: { rows: Row[] } }; if (r.run_status !== 'completed') throw new Error(`${flag}: the receipt did not complete; rerun it`); return r.data.rows; };
  if (!output) throw new Error('pass --output <dir> (or the campaign flags)');
  const gates = g5Gates(read('--world-baseline'), read('--world-candidate'), read('--variants'));
  const receipt = p5Receipt({ category: 'q2-g5', gut: resolveGbrainUnderTest(null), startedAt: new Date().toISOString(), rows: [], harnessError: null, gates, summary: {}, basis: 'decision only: receipts in, no model call',
    resolvedConfig: { inputs: { world_baseline: flagValue(argv, '--world-baseline'), world_candidate: flagValue(argv, '--world-candidate'), variants: flagValue(argv, '--variants') } } });
  writeReceipt(join(output, 'receipt.json'), receipt);
  campaign?.finish(join(output, 'receipt.json'), 0);
  for (const g of gates) process.stderr.write(`${g.gate}: ${g.outcome}${g.failed_threshold ? ` (${g.failed_threshold})` : ''}\n`);
}

if (import.meta.main) main(process.argv.slice(2)).catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(3); });

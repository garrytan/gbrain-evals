/**
 * A6, the evidence-brief confirmation (10x memory advantage plan, wave 1): the
 * cells, comparison families and decision for the 400-question confirm split,
 * which the pilot never read. Preregistration:
 * docs/benchmarks/2026-10-08-evidence-brief-confirmation-preregistration.md.
 *
 *   primary     BRIEF@2000 (Haiku 5.5 builder) read by Sonnet 5.5, non-inferior to
 *               A0 (whole sessions) on the same reader at T0's 3.0-point tolerance
 *   secondaries the same test, Holm-adjusted together: Opus 5.5 and gpt-6.1-sol on
 *               BRIEF@2000; BRIEF@1000/4000/7000 on Sonnet 5.5; TRUNC@2000 and
 *               TRUNC@7000 (controls); DIRECT and FALLBACK (Haiku 5.5, escalating to
 *               Sonnet 5.5 on hedged or declined answers)
 */
import { evaluateFamily, type ComparisonFamily, type FamilyDecision } from '../stats/gates.ts';
import { stratifiedSample } from '../batch/sources.ts';
import { cellId, OPUS, type Budget } from './cells.ts';
import { loadPilotEvidence, pilotSplit, SEED_BASE } from './evidence.ts';
import type { BuildPlan } from './run.ts';

export const CONFIRM_SEED = SEED_BASE + 5;
export const TOLERANCE = 0.03;
/** Two-sided 95% interval, so the one-sided test runs at 0.025 (T0: "upper bound of the 95% interval"). */
export const ALPHA = 0.025;
export const BUILDER = 'claude-haiku-5-5' as const;
export const SONNET = 'claude-sonnet-5-5' as const;
export const SOL = 'gpt-6.1-sol' as const;

export const PRIMARY = { arm: cellId.brief(2000, BUILDER, SONNET), comparator: cellId.a0(SONNET) };

/** Secondary comparisons: [id, arm cell, comparator cell]. */
export const SECONDARIES: ReadonlyArray<readonly [string, string, string]> = [
  ['brief2000-opus', cellId.brief(2000, BUILDER, OPUS), cellId.a0(OPUS)],
  ['brief2000-sol', cellId.brief(2000, BUILDER, SOL), cellId.a0(SOL)],
  ...([1000, 4000, 7000] as Budget[]).map(b => [`brief${b}-sonnet`, cellId.brief(b, BUILDER, SONNET), cellId.a0(SONNET)] as const),
  ...([2000, 7000] as Budget[]).map(b => [`trunc${b}-sonnet`, cellId.trunc(b, SONNET), cellId.a0(SONNET)] as const),
  ['direct-haiku', cellId.direct(BUILDER), cellId.a0(SONNET)],
  ['fallback-haiku-sonnet', cellId.fallback(BUILDER, SONNET), cellId.a0(SONNET)],
];

/** Every reported cell, comparators first (the report computes discordance against them). */
export const CONFIRM_CELLS: string[] = [
  cellId.a0(SONNET), cellId.a0(OPUS), cellId.a0(SOL),
  ...new Set([PRIMARY.arm, ...SECONDARIES.map(([, arm]) => arm)]),
];

export const CONFIRM_BUILD: BuildPlan = { builders: [BUILDER], budgets: [1000, 2000, 4000, 7000], digests: false };

export const confirmIds = () => pilotSplit().confirm;

/** The timing cohort: 24 confirm questions stratified by report type. */
export function confirmCohortIds(): string[] {
  const ev = loadPilotEvidence();
  return stratifiedSample(new Map(confirmIds().map(id => [id, ev.get(id)!.report_type])), 24, CONFIRM_SEED + 1).ids;
}

const family = (id: string, comparisons: ReadonlyArray<readonly [string, string, string]>): ComparisonFamily => ({
  schema_version: 1, family_id: id, registered_at: '2026-10-08', alpha: ALPHA, seed: CONFIRM_SEED, draws: 10000, id_field: 'question_id',
  description: `A6 ${id}: each arm non-inferior to its comparator at ${TOLERANCE * 100} points of supported task success, one-sided at ${ALPHA}, clustered by question`,
  comparisons: comparisons.map(([cid]) => ({ id: cid, metric: cid, gate: 'noninferiority' as const, direction: 'higher' as const, tolerance: TOLERANCE, cluster_by: 'question_id' })),
});

export const PRIMARY_FAMILY = family('a6-primary', [['brief2000-sonnet', PRIMARY.arm, PRIMARY.comparator]]);
export const SECONDARY_FAMILY = family('a6-secondary', SECONDARIES);

/** Run both families from per-question correctness (1 = supported task success) keyed by cell. */
export function decideConfirmation(correct: Map<string, Map<string, 0 | 1>>, ids: string[]): { primary: FamilyDecision; secondary: FamilyDecision } {
  const rows = (comps: ReadonlyArray<readonly [string, string, string]>) => {
    const a: Record<string, unknown>[] = [], b: Record<string, unknown>[] = [];
    for (const id of ids) {
      const ra: Record<string, unknown> = { question_id: id }, rb: Record<string, unknown> = { question_id: id };
      for (const [cid, arm, comp] of comps) {
        const x = correct.get(arm)?.get(id), y = correct.get(comp)?.get(id);
        if (x === undefined || y === undefined) throw new Error(`${cid}: missing ${x === undefined ? arm : comp} for ${id}`);
        ra[cid] = y; rb[cid] = x;
      }
      a.push(ra); b.push(rb);
    }
    return [a, b] as const;
  };
  const [pa, pb] = rows([['brief2000-sonnet', PRIMARY.arm, PRIMARY.comparator]]);
  const [sa, sb] = rows(SECONDARIES);
  return { primary: evaluateFamily(pa, pb, PRIMARY_FAMILY), secondary: evaluateFamily(sa, sb, SECONDARY_FAMILY) };
}

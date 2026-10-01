/**
 * N5 scoring: pure functions from per-(canary, tier) observations to the
 * withdrawal-contract metrics. No gbrain import, no I/O. Gold is the
 * generator ledger (eval/generators/n5-forget-residue-gen.ts) plus the
 * documented withdrawal contract.
 *
 * Definitions (named denominators):
 *   prohibited active output  a forgotten canary present in an active tier at
 *                             a checkpoint after its forget (the prose
 *                             canary's chunk tiers excepted: prose is retained
 *                             by design). Presence proves signal, so it counts
 *                             whether or not the pair was witnessed.
 *   reactivation              a forgotten canary active in the facts index
 *                             (recall_facts) or as an unstruck fence row at a
 *                             checkpoint after `immediate`, or the documented
 *                             refused repeat accepted and active.
 *   collateral expiration     a retained canary witnessed in recall_facts that
 *                             is missing there later, or the forgotten claim's
 *                             exact text refused or inactive on another entity.
 *   retained recall           retained (canary, tier) pairs witnessed before
 *                             the forget that are still present, over every
 *                             post-forget checkpoint.
 *   reinstatement             a corrected claim remembered after a forget is
 *                             acknowledged and active in recall_facts.
 */
import {
  ACTIVE_TIERS, POST_FORGET, isForgottenAt, isRetainedAt, residueScored, writtenBy,
  type ActiveTier, type Canary, type N5Checkpoint, type N5Ledger,
} from '../../generators/n5-forget-residue-gen.ts';

/**
 * Tiers that are capped or ranked rather than exhaustive: context_pack's hot
 * facts are the ten most recent facts in the source, so a retained neighbor
 * can drop out when newer facts arrive without being withdrawn. They count
 * for residue (a forgotten claim must never appear) but not for retained
 * recall. Erratum N5-category-defect: the first dev run counted them there.
 */
export const CAPPED_TIERS: ReadonlySet<ActiveTier> = new Set(['context_pack']);

export type TierObs = { present: boolean } | { error: string };
/** Observations at one checkpoint, keyed `${canaryId}|${tier}`. Missing key = not observed. */
export type CheckpointObs = Map<string, TierObs>;

export const pairKey = (canary: string, tier: ActiveTier) => `${canary}|${tier}`;

export interface N5Finding { checkpoint: N5Checkpoint; canary: string; tier: ActiveTier | 'remember' | 'authority'; detail: string }

export interface N5Metrics {
  prohibited_active_outputs: number;
  reactivations: number;
  collateral_expirations: number;
  unauthorized_forgets_applied: number;
  private_canary_leaks: number;
  retained_pairs: number;
  retained_present: number;
  retained_recall: number | null;
  /** Witnessed retained pairs in capped tiers, and how many were present (reported, not gated). */
  capped_pairs: number;
  capped_present: number;
  /** Retained recall with the capped tiers included, as the first dev run defined it (reported, not gated). */
  retained_recall_including_capped: number | null;
  reinstatement_attempts: number;
  reinstated: number;
  reinstatement_rate: number | null;
  forgotten_pairs_with_signal: number;
  forgotten_pairs_without_witness: number;
  sut_errors: number;
}

export interface AuthorityAttempt { client: string; target: string; call_ok: boolean; still_active: boolean | null; error?: string }
export interface RememberOutcome { canary: string; ok: boolean; status: string; error?: string }

export interface N5ScoreInput {
  ledger: N5Ledger;
  /** Canaries this observer is expected to see (a remote observer never sees private ones; the trusted control does). */
  observable: (c: Canary) => boolean;
  checkpoints: Partial<Record<N5Checkpoint, CheckpointObs>>;
  corrected: RememberOutcome[];
  repeats: RememberOutcome[];
  concurrent: RememberOutcome[];
  authority: AuthorityAttempt[];
  private_canary_leaks: number;
}

export interface N5Score {
  metrics: N5Metrics;
  findings: N5Finding[];
  by_tier: Record<string, { prohibited: number; retained_pairs: number; retained_present: number; forgotten_with_signal: number }>;
  by_checkpoint: Record<string, { prohibited: number; retained_pairs: number; retained_present: number }>;
  witnessed: Record<string, ActiveTier[]>;
}

const present = (o: TierObs | undefined) => !!o && 'present' in o && o.present;

export function scoreN5(input: N5ScoreInput): N5Score {
  const { ledger } = input;
  const witness = input.checkpoints.witness ?? new Map();
  const findings: N5Finding[] = [];
  const byTier: N5Score['by_tier'] = Object.fromEntries(ACTIVE_TIERS.map(t => [t, { prohibited: 0, retained_pairs: 0, retained_present: 0, forgotten_with_signal: 0 }]));
  const byCp: N5Score['by_checkpoint'] = {};
  const witnessed: Record<string, ActiveTier[]> = {};
  let prohibited = 0, reactivations = 0, retainedPairs = 0, retainedPresent = 0, withSignal = 0, withoutWitness = 0, sutErrors = 0;
  let cappedPairs = 0, cappedPresent = 0;
  const collateral = new Set<string>();
  const canaries = ledger.canaries.filter(input.observable);
  for (const c of canaries) witnessed[c.id] = ACTIVE_TIERS.filter(t => present(witness.get(pairKey(c.id, t))));
  for (const c of canaries) {
    if (c.role !== 'forgotten' && c.role !== 'late-forgotten') continue;
    for (const t of ACTIVE_TIERS) {
      if (!residueScored(c, t)) continue;
      if (witnessed[c.id].includes(t)) { withSignal++; byTier[t].forgotten_with_signal++; } else withoutWitness++;
    }
  }
  for (const cp of POST_FORGET) {
    const obs = input.checkpoints[cp];
    if (!obs) continue;
    byCp[cp] = { prohibited: 0, retained_pairs: 0, retained_present: 0 };
    for (const c of canaries) {
      if (!writtenBy(c, cp)) continue;
      for (const t of ACTIVE_TIERS) {
        const o = obs.get(pairKey(c.id, t));
        if (o && 'error' in o) sutErrors++;
        if (isForgottenAt(c, cp)) {
          if (!residueScored(c, t) || !present(o)) continue;
          prohibited++; byTier[t].prohibited++; byCp[cp].prohibited++;
          findings.push({ checkpoint: cp, canary: c.id, tier: t, detail: `forgotten ${c.via} canary on ${c.entity} still in ${t}` });
          if (cp !== 'immediate' && (t === 'recall_facts' || t === 'fence_active')) reactivations++;
        } else if (isRetainedAt(c, cp) && witnessed[c.id].includes(t)) {
          if (CAPPED_TIERS.has(t)) {
            cappedPairs++; byTier[t].retained_pairs++;
            if (present(o)) { cappedPresent++; byTier[t].retained_present++; }
            continue;
          }
          retainedPairs++; byTier[t].retained_pairs++; byCp[cp].retained_pairs++;
          if (present(o)) { retainedPresent++; byTier[t].retained_present++; byCp[cp].retained_present++; }
          else {
            findings.push({ checkpoint: cp, canary: c.id, tier: t, detail: `retained ${c.via} canary on ${c.entity} missing from ${t}${o && 'error' in o ? ` (error: ${o.error})` : ''}` });
            if (t === 'recall_facts') collateral.add(c.id);
          }
        }
      }
    }
  }
  for (const r of input.repeats) {
    const active = present(input.checkpoints.immediate?.get(pairKey(r.canary, 'recall_facts')));
    if (r.ok && (r.status === 'inserted' || r.status === 'superseded' || active)) {
      reactivations++;
      findings.push({ checkpoint: 'immediate', canary: r.canary, tier: 'remember', detail: `the exact forgotten claim was accepted again (${r.status})` });
    }
  }
  for (const r of input.concurrent) {
    const c = ledger.canaries.find(x => x.id === r.canary)!;
    if (c.role !== 'twin-concurrent') continue;
    const active = present(input.checkpoints.concurrent?.get(pairKey(c.id, 'recall_facts')));
    if (!r.ok || !active) {
      collateral.add(c.id);
      findings.push({ checkpoint: 'concurrent', canary: c.id, tier: 'remember', detail: `the forgotten claim's exact text on another entity was ${r.ok ? 'accepted but not active' : `refused (${r.error ?? r.status})`}` });
    }
  }
  let reinstated = 0;
  for (const r of input.corrected) {
    if (r.ok && present(input.checkpoints.immediate?.get(pairKey(r.canary, 'recall_facts')))) reinstated++;
    else findings.push({ checkpoint: 'immediate', canary: r.canary, tier: 'remember', detail: `corrected claim not reinstated (${r.ok ? 'accepted but not active' : r.error ?? r.status})` });
  }
  const unauthorized = input.authority.filter(a => a.call_ok || a.still_active === false);
  for (const a of unauthorized) findings.push({ checkpoint: 'restart', canary: a.target, tier: 'authority', detail: `${a.client} forget ${a.call_ok ? 'was accepted' : 'left the target inactive'}` });
  const metrics: N5Metrics = {
    prohibited_active_outputs: prohibited,
    reactivations,
    collateral_expirations: collateral.size,
    unauthorized_forgets_applied: unauthorized.length,
    private_canary_leaks: input.private_canary_leaks,
    retained_pairs: retainedPairs,
    retained_present: retainedPresent,
    retained_recall: retainedPairs ? retainedPresent / retainedPairs : null,
    capped_pairs: cappedPairs,
    capped_present: cappedPresent,
    retained_recall_including_capped: retainedPairs + cappedPairs ? (retainedPresent + cappedPresent) / (retainedPairs + cappedPairs) : null,
    reinstatement_attempts: input.corrected.length,
    reinstated,
    reinstatement_rate: input.corrected.length ? reinstated / input.corrected.length : null,
    forgotten_pairs_with_signal: withSignal,
    forgotten_pairs_without_witness: withoutWitness,
    sut_errors: sutErrors,
  };
  return { metrics, findings, by_tier: byTier, by_checkpoint: byCp, witnessed };
}

/** Sum metrics across cells (counts add; rates are recomputed from their counts). */
export function sumN5(ms: readonly N5Metrics[]): N5Metrics {
  const s = (k: keyof N5Metrics) => ms.reduce((n, m) => n + ((m[k] as number | null) ?? 0), 0);
  const rp = s('retained_pairs');
  const ra = s('reinstatement_attempts');
  const cp = s('capped_pairs');
  return {
    prohibited_active_outputs: s('prohibited_active_outputs'), reactivations: s('reactivations'), collateral_expirations: s('collateral_expirations'),
    unauthorized_forgets_applied: s('unauthorized_forgets_applied'), private_canary_leaks: s('private_canary_leaks'),
    retained_pairs: rp, retained_present: s('retained_present'), retained_recall: rp ? s('retained_present') / rp : null,
    capped_pairs: cp, capped_present: s('capped_present'),
    retained_recall_including_capped: rp + cp ? (s('retained_present') + s('capped_present')) / (rp + cp) : null,
    reinstatement_attempts: ra, reinstated: s('reinstated'), reinstatement_rate: ra ? s('reinstated') / ra : null,
    forgotten_pairs_with_signal: s('forgotten_pairs_with_signal'), forgotten_pairs_without_witness: s('forgotten_pairs_without_witness'), sut_errors: s('sut_errors'),
  };
}

// ─── Shape parsing of gbrain responses ────────────────────────────────────

/** Fence rows in a page body: tokens in unstruck rows and in struck rows. */
export function fenceRowTokens(body: string): { unstruck: Set<string>; struck: Set<string> } {
  const unstruck = new Set<string>();
  const struck = new Set<string>();
  const begin = body.indexOf('gbrain:facts:begin');
  const end = body.indexOf('gbrain:facts:end');
  if (begin < 0 || end < begin) return { unstruck, struck };
  for (const line of body.slice(begin, end).split('\n')) {
    const cells = line.split('|');
    if (cells.length < 3) continue;
    const claim = cells[2] ?? '';
    for (const t of claim.match(/cnry[a-z]{8}/g) ?? []) (claim.includes('~~') ? struck : unstruck).add(t);
  }
  return { unstruck, struck };
}

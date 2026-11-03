/**
 * The headroom gate's verdict for the SkillOpt ceiling attempt (GBEV-30,
 * GST-1013; plan revision 5, section 4, preregistered).
 *
 * Each pair (skill x target) is labelled from its gate-split scores, all
 * substance pass on the whole gate split. The first matching label applies:
 *
 *   invalid          the skill fails its solvability controls (on both
 *                    targets), or on this pair more than 10% of no-skill or
 *                    seed tasks fail a form check, or both one-shot proposals
 *                    fail the audit
 *   harness-limited  reachability below 0.85, or more than a third of the kept
 *                    one-shot's failed tasks end in a 20-turn stop, an
 *                    output-length stop, or follow a refused decisive read
 *   headroom         kept one-shot at most 0.80 and at least 0.15 below
 *                    reachability, seed in [0.20, 0.70]
 *   saturated        kept one-shot above 0.80 or within 0.15 of reachability
 *   difficulty       room is left but the seed is outside [0.20, 0.70]
 *
 * Scope: when one target is wholly harness-limited, the other target's three
 * pairs are read alone with R = 2 and the limited target's own cause is
 * `harness`; otherwise all six pairs are read with R = 4. Every verdict, a
 * cut included, is scoped to the measured targets. Opus runs first. Sol's gate
 * is skipped only when no Opus pair has headroom and the Opus pairs read alone
 * (R = 2) are `saturated` (`solGateNeeded`); the attempt is then read on Opus
 * alone and scoped to it. Any other pair that should have run and did not
 * makes the attempt `incomplete`.
 *
 * Cause of a failed attempt, over the scoped counts H S D X V U:
 *   invalid       a skill fails its solvability controls
 *   saturated     H + D + X + V + U < R and H <= 1
 *   underpowered  H + D + X + V + U < R and H >= 2 (the ceiling rose on H
 *                 pairs, too few to count)
 *   harness       H + X >= R
 *   invalid       H + X + V >= R
 *   difficulty    otherwise
 * A pass (H >= R) on three or fewer headroom pairs cannot reach a 0.10
 * detectable difference at 5 repeats, so it reads `underpowered` too and goes
 * to the stop path without B0. Only `saturated` can lead to cuts, and only
 * after both attempts (`stopVerdict`). A budget stop is `incomplete`.
 */
import type { FrontierTarget } from './headroom.ts';
import { SKILLS, type SkillName } from './score.ts';

export const GATE = {
  maxFormFailRate: 0.10,
  minReachability: 0.85,
  maxLimitedShare: 1 / 3,
  maxOneShot: 0.80,
  minRoom: 0.15,
  seedLow: 0.20,
  seedHigh: 0.70,
  requiredAll: 4,
  requiredOneTarget: 2,
  minPoweredPairs: 4,
} as const;

const EPS = 1e-9;
const TARGETS: readonly FrontierTarget[] = ['opus', 'sol'];

export type PairLabel = 'invalid' | 'harness-limited' | 'headroom' | 'saturated' | 'difficulty';
export type GateCause = 'invalid' | 'saturated' | 'underpowered' | 'harness' | 'difficulty';

/** What the gate reads of one pair that ran. */
export interface GatePair {
  skill: SkillName;
  target: FrontierTarget;
  /** Shares of the gate split's no-skill and seed (designated run) tasks that fail a form check. */
  form_fail: { no_skill: number; seed: number };
  /** One-shot proposals that passed the audit (of 2). */
  proposals_passing_audit: number;
  /** Substance pass of the reachability control. */
  reachability: number;
  /** Share of the kept one-shot's failed tasks that end in a turn or length stop or follow a refused decisive read. */
  limited_share: number;
  /** True when the pair's harness limits come from gbrain refusing the target's calls, which no task revision changes. */
  refusal_limited: boolean;
  /** Substance pass on the gate split: the kept one-shot (2 runs) and the seed's designated run. */
  one_shot: number;
  seed: number;
}

export interface GateInput {
  pairs: readonly GatePair[];
  /** Skills whose solvability controls fail (target-independent). */
  unsolvable: readonly SkillName[];
  /** True when a budget refusal stopped the stage. */
  budget_stop?: boolean;
  /** 1 for the first gate, 2 for the revision gate. */
  attempt: 1 | 2;
}

export interface Counts { H: number; S: number; D: number; X: number; V: number; U: number }

export type GateVerdict = 'pass' | 'fail' | 'invalid' | 'incomplete';

export interface GateResult {
  verdict: GateVerdict;
  cause: GateCause | null;
  /** The targets the read counted; a cut is scoped to these. */
  scope: FrontierTarget[];
  /** A wholly harness-limited target, read as `harness` on its own. */
  harness_target: FrontierTarget | null;
  required: number;
  counts: Counts;
  labels: Record<string, PairLabel | 'not-run'>;
  headroom_pairs: string[];
  /** What runs next: B0, the one revision, or the stop path. */
  next: 'b0' | 'revise' | 'stop';
}

export const pairKey = (skill: SkillName, target: FrontierTarget): string => `${skill}/${target}`;

export function labelPair(p: GatePair, unsolvable: readonly SkillName[]): PairLabel {
  if (unsolvable.includes(p.skill)
    || p.form_fail.no_skill > GATE.maxFormFailRate + EPS
    || p.form_fail.seed > GATE.maxFormFailRate + EPS
    || p.proposals_passing_audit === 0) return 'invalid';
  if (p.reachability < GATE.minReachability - EPS || p.limited_share > GATE.maxLimitedShare + EPS) return 'harness-limited';
  const room = p.reachability - p.one_shot >= GATE.minRoom - EPS;
  if (p.one_shot > GATE.maxOneShot + EPS || !room) return 'saturated';
  if (p.seed < GATE.seedLow - EPS || p.seed > GATE.seedHigh + EPS) return 'difficulty';
  return 'headroom';
}

function count(labels: ReadonlyArray<PairLabel | 'not-run'>): Counts {
  const c: Counts = { H: 0, S: 0, D: 0, X: 0, V: 0, U: 0 };
  for (const l of labels) {
    if (l === 'headroom') c.H++;
    else if (l === 'saturated') c.S++;
    else if (l === 'difficulty') c.D++;
    else if (l === 'harness-limited') c.X++;
    else if (l === 'invalid') c.V++;
    else c.U++;
  }
  return c;
}

/** The cause table over scoped counts; null when the attempt passes. */
export function causeOf(c: Counts, required: number): GateCause | null {
  if (c.H >= required) return null;
  if (c.H + c.D + c.X + c.V + c.U < required) return c.H <= 1 ? 'saturated' : 'underpowered';
  if (c.H + c.X >= required) return 'harness';
  if (c.H + c.X + c.V >= required) return 'invalid';
  return 'difficulty';
}

/** Section 4's gate read. Pairs absent from `pairs` count as not run. */
export function gateVerdict(input: GateInput): GateResult {
  const labels: Record<string, PairLabel | 'not-run'> = {};
  const byKey = new Map(input.pairs.map(p => [pairKey(p.skill, p.target), p]));
  for (const target of TARGETS) for (const skill of SKILLS) {
    const p = byKey.get(pairKey(skill, target));
    labels[pairKey(skill, target)] = p ? labelPair(p, input.unsolvable) : 'not-run';
  }
  const refusalLimited = new Set(input.pairs.filter(p => p.refusal_limited).map(p => pairKey(p.skill, p.target)));
  const notRun = Object.keys(labels).filter(k => labels[k] === 'not-run');
  const solSkipped = notRun.length === SKILLS.length && notRun.every(k => k.endsWith('/sol'));
  if (solSkipped && !solGateNeeded(input)) return readLabels(labels, input, refusalLimited, ['opus']);
  const read = readLabels(labels, input, refusalLimited);
  return notRun.length && read.verdict !== 'incomplete' && read.verdict !== 'invalid' ? { ...read, verdict: 'incomplete', cause: null, next: 'stop' } : read;
}

function readLabels(labels: Record<string, PairLabel | 'not-run'>, input: Omit<GateInput, 'pairs'>, refusalLimited: ReadonlySet<string>, only?: FrontierTarget[]): GateResult {
  const targetLabels = (t: FrontierTarget) => SKILLS.map(s => labels[pairKey(s, t)]!);
  const limited = TARGETS.filter(t => targetLabels(t).every(l => l === 'harness-limited'));
  const harness_target = limited.length === 1 ? limited[0]! : null;
  const scope = only ?? (limited.length === 1 ? TARGETS.filter(t => t !== harness_target) : limited.length === TARGETS.length ? [] : [...TARGETS]);
  const required = scope.length === 1 ? GATE.requiredOneTarget : GATE.requiredAll;
  const counts = count(scope.flatMap(targetLabels));
  const scoped = Object.keys(labels).filter(k => scope.some(t => k.endsWith(`/${t}`)));
  const headroom_pairs = scoped.filter(k => labels[k] === 'headroom');
  const result = (verdict: GateVerdict, cause: GateCause | null, next: GateResult['next']): GateResult =>
    ({ verdict, cause, scope, harness_target, required, counts, labels, headroom_pairs, next });

  if (input.budget_stop) return result('incomplete', null, 'stop');
  if (input.unsolvable.length) return result('invalid', 'invalid', input.attempt === 1 ? 'revise' : 'stop');
  const revisable = (limitedPairs: readonly string[]) => input.attempt === 1 && !(limitedPairs.length > 0 && limitedPairs.every(k => refusalLimited.has(k)));
  if (!scope.length) return result('fail', 'harness', revisable(Object.keys(labels)) ? 'revise' : 'stop');
  const cause = causeOf(counts, required);
  if (cause === null) return counts.H >= GATE.minPoweredPairs ? result('pass', null, 'b0') : result('fail', 'underpowered', 'stop');
  const scopedLimited = scoped.filter(k => labels[k] === 'harness-limited');
  const unrevisable = cause === 'harness' && scopedLimited.length > 0 && scopedLimited.every(k => refusalLimited.has(k));
  return result('fail', cause, input.attempt === 1 && !unrevisable ? 'revise' : 'stop');
}

/**
 * Whether Sol's gate runs after the Opus pairs in `input` have scored. It is
 * skipped only when the attempt is already incomplete or invalid, or when no
 * Opus pair has headroom (so no Sol result can make the attempt pass) and the
 * Opus pairs read alone with R = 2 are `saturated`: three saturated Opus
 * pairs, for one. The attempt is then read on Opus alone and scoped to it.
 */
export function solGateNeeded(input: GateInput): boolean {
  const opusPairs = input.pairs.filter(p => p.target === 'opus');
  if (input.budget_stop || input.unsolvable.length) return false;
  const labels = opusPairs.map(p => labelPair(p, input.unsolvable));
  if (labels.length < SKILLS.length) return true;
  const c = count(labels);
  return !(c.H === 0 && causeOf(c, GATE.requiredOneTarget) === 'saturated');
}

export type StopRead = 'CUT-CANDIDATE' | 'FIX-METHOD' | 'incomplete';

export interface StopVerdict {
  /** K's and L's read on the stop path. */
  k_and_l: StopRead;
  /** The targets a cut covers: the targets every attempt measured. */
  scope: FrontierTarget[];
  causes: Array<GateCause | 'incomplete'>;
  reason: string;
}

/**
 * Section 8: K and L after the gate's attempts end without a pass. Cuts need
 * `saturated` on both attempts and are scoped to the targets both measured;
 * any other cause is FIX-METHOD with K and L undecided; a budget stop is
 * incomplete. One attempt is enough when it cannot be revised.
 */
export function stopVerdict(attempts: readonly GateResult[]): StopVerdict {
  const causes = attempts.map(a => a.verdict === 'incomplete' ? 'incomplete' as const : a.cause ?? 'underpowered');
  const scope = TARGETS.filter(t => attempts.every(a => a.scope.includes(t)));
  if (causes.includes('incomplete')) return { k_and_l: 'incomplete', scope: [], causes, reason: 'a budget stop ended an attempt; K and L stay undecided' };
  if (attempts.length === 2 && causes.every(c => c === 'saturated')) {
    const unmeasured = TARGETS.filter(t => !scope.includes(t));
    return {
      k_and_l: 'CUT-CANDIDATE', scope, causes,
      reason: `both attempts saturated on at most one headroom pair${unmeasured.length ? `; ${unmeasured.join(' and ')} not measured (wholly harness-limited or not run), so the cut covers ${scope.join(' and ')} only` : ''}`,
    };
  }
  return { k_and_l: 'FIX-METHOD', scope, causes, reason: `causes ${causes.join(', ')}: K and L stay undecided` };
}

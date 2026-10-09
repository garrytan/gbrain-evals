/**
 * Transition identity for the Q2 C-gates: a transition is (subject, target, type, kind, date). Gold comes from the
 * ledger's explicit intervals; observed transitions are gbrain's link_transitions rows plus applied single-value
 * closures. Counts are never compared as differences (the zero-clamped `e5_extra_works_at_starts` is gone):
 *
 *   wrong     observed transitions no gold transition matches
 *   missing   gold transitions no observed transition matches
 *   recall    of gold start (end) transitions, the share observed
 *   new wrong a candidate's wrong identities minus the comparator's (set difference), which must be empty
 *
 * Dates match at the observed precision (a month-precision transition matches any gold day in that month).
 * Scope: works_at and advises, the types the ledger states as intervals.
 */
import type { Stint, TeE5Probe, TePerson } from '../../generators/temporal-edges-gen.ts';

export const TRANSITION_TYPES: readonly string[] = ['works_at', 'advises'];
export interface Transition { subject: string; target: string; type: string; kind: 'start' | 'end'; date: string; precision?: 'day' | 'month' | 'year' | null; producer?: string }

export const transitionId = (t: Transition) => `${t.subject}|${t.target}|${t.type}|${t.kind}|${t.date}${t.precision && t.precision !== 'day' ? `@${t.precision}` : ''}`;

/** The ledger's transitions: every stint's start and (if ended) end, advisory starts, the E5 advisory line. */
export function goldTransitions(p: TePerson | TeE5Probe): Transition[] {
  const out: Transition[] = [];
  for (const s of p.stints) {
    out.push({ subject: p.slug, target: s.company, type: 'works_at', kind: 'start', date: s.from });
    if (s.until) out.push({ subject: p.slug, target: s.company, type: 'works_at', kind: 'end', date: s.until });
  }
  if (p.advises) out.push({ subject: p.slug, target: p.advises.company, type: 'advises', kind: 'start', date: p.advises.from });
  const e5 = (p as TeE5Probe).e5;
  if (e5) out.push({ subject: p.slug, target: e5.advisory_target, type: 'advises', kind: 'start', date: e5.advisory_on });
  return dedupe(out);
}

function dedupe(ts: readonly Transition[]): Transition[] {
  const seen = new Map<string, Transition>();
  for (const t of ts) seen.set(transitionId(t), t);
  return [...seen.values()];
}

const cut = (date: string, precision: Transition['precision']) => precision === 'year' ? date.slice(0, 4) : precision === 'month' ? date.slice(0, 7) : date.slice(0, 10);
export function matches(observed: Transition, gold: Transition): boolean {
  return observed.subject === gold.subject && observed.target === gold.target && observed.type === gold.type && observed.kind === gold.kind
    && cut(observed.date, observed.precision) === cut(gold.date, observed.precision);
}

export interface TransitionMetrics { wrong: string[]; missing: string[]; gold_starts: number; observed_starts: number; gold_ends: number; observed_ends: number; false_works_at_starts: string[] }

/** Identity metrics for one person: observed in scope are compared to gold by `matches`. */
export function transitionMetrics(gold: readonly Transition[], observedAll: readonly Transition[]): TransitionMetrics {
  const observed = dedupe(observedAll.filter(t => TRANSITION_TYPES.includes(t.type)));
  const wrong = observed.filter(o => !gold.some(g => matches(o, g)));
  const missingGold = gold.filter(g => !observed.some(o => matches(o, g)));
  return {
    wrong: wrong.map(transitionId).sort(),
    missing: missingGold.map(transitionId).sort(),
    gold_starts: gold.filter(g => g.kind === 'start').length,
    observed_starts: gold.filter(g => g.kind === 'start' && observed.some(o => matches(o, g))).length,
    gold_ends: gold.filter(g => g.kind === 'end').length,
    observed_ends: gold.filter(g => g.kind === 'end' && observed.some(o => matches(o, g))).length,
    false_works_at_starts: wrong.filter(o => o.type === 'works_at' && o.kind === 'start').map(transitionId).sort(),
  };
}

/**
 * A single-value closure (end `ending` on `closeDate`) is correct only when the ledger has an interval of that
 * company ending exactly then and no interval of it covering that day: a gap ends at the stint's own end, not at the
 * next start; a concurrent job is never closed; a rejoin matches the stint that ended.
 */
export function closureCorrect(stints: readonly Stint[], ending: string, closeDate: string): boolean {
  const mine = stints.filter(s => s.company === ending);
  const covers = mine.some(s => s.from <= closeDate && (s.until === null || closeDate < s.until));
  return !covers && mine.some(s => s.until === closeDate);
}

/** Candidate wrong identities the comparator does not also have (the C-gate "new wrong transitions"). */
export function newWrong(candidate: Iterable<string>, comparator: Iterable<string>): string[] {
  const base = new Set(comparator);
  return [...new Set(candidate)].filter(id => !base.has(id)).sort();
}

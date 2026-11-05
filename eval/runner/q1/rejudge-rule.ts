/**
 * GST-1365's decision rule (docs/benchmarks/2026-11-04-gst-1365-judge-robustness-preregistration.md, section 5), as
 * pure functions over per-question values. rejudge-systems.ts loads the values from published receipts and judgments;
 * this module never reads a file.
 *
 * Views: M is the canonical judge as published (every replicate), M0 the canonical judge on replicate 0 (the answers a
 * frontier judge saw), F the reader's assigned frontier judge, R the referee and K two of three (M0, F, R) at the pass
 * threshold, or the shared verdict where M0 and F agree. Every view of a contrast is computed on one common cohort: the
 * published cohort's questions where every reader's value exists for both systems under M0 and F. A contrast short of
 * its published cohort by more than 2% of its questions, or that loses a whole conversation, is INCOMPLETE.
 */
import { PASS_THRESHOLD } from '../memory-qa/instruments.ts';
import { clusteredPairedDelta } from '../stats/paired.ts';
import { seedNumber } from './particle-addon-report.ts';

export const SEED = 'gst-1365';
export const DRAWS = 10_000;
export const COHORT_TOLERANCE = 0.02;
export const SIZE_POINTS = 0.03;
export const REFEREE_VALIDITY = 0.85;
export const MORE_ACCURATE_POINTS = 0.03;

/** One reader's answer to one question under each judge; null where that judge has no score (a product failure is 0 under every judge). */
export interface ReaderValue { M: number | null; M0: number | null; F: number | null; R: number | null }
/** A question in one cell: excluded (harness failure, not applicable, subset, preregistered exclusion) or one value per reader. */
export interface QuestionValues { conversation: string; readers: Record<string, ReaderValue> | null }
export type CellValues = Map<string, QuestionValues>;
export type View = 'M' | 'M0' | 'F' | 'K';
export interface Interval { delta: number; ci95: [number, number] | null }

const pass = (x: number) => x >= PASS_THRESHOLD;
const round = (x: number) => Math.round(x * 1e6) / 1e6;

/** One reader's value under a view; K needs the referee only where M0 and F disagree. */
export function readerView(v: ReaderValue, view: View): number | null {
  if (view !== 'K') return v[view];
  if (v.M0 === null || v.F === null) return null;
  if (pass(v.M0) === pass(v.F)) return pass(v.F) ? 1 : 0;
  return v.R === null ? null : pass(v.R) ? 1 : 0;
}

/** A question's value under a view: the mean over the given readers, or null when any is missing. */
export function questionView(q: QuestionValues | undefined, view: View, readers: readonly string[]): number | null {
  if (!q?.readers) return null;
  let sum = 0;
  for (const r of readers) {
    const v = q.readers[r] ? readerView(q.readers[r], view) : null;
    if (v === null) return null;
    sum += v;
  }
  return sum / readers.length;
}

export interface Cohorts { published: string[]; common: string[]; incomplete: string | null }

/** The published cohort (both cells scored under M), the common cohort (every reader under M0 and F, and K when asked) and whether the shortfall makes the contrast INCOMPLETE. */
export function cohorts(anchor: CellValues, other: CellValues, readers: readonly string[], scheduled: readonly string[], withK = false): Cohorts {
  const published = scheduled.filter(q => questionView(anchor.get(q), 'M', readers) !== null && questionView(other.get(q), 'M', readers) !== null);
  const views: View[] = withK ? ['M0', 'F', 'K'] : ['M0', 'F'];
  const common = published.filter(q => views.every(v => questionView(anchor.get(q), v, readers) !== null && questionView(other.get(q), v, readers) !== null));
  const conv = (q: string) => anchor.get(q)!.conversation;
  const lost = [...new Set(published.map(conv))].filter(c => !common.some(q => conv(q) === c));
  const short = published.length - common.length;
  const incomplete = !published.length ? 'no published cohort'
    : lost.length ? `${lost.length} whole conversation(s) have no question every judge scored`
    : short > COHORT_TOLERANCE * published.length ? `${short} of ${published.length} published questions lack a score under every judge (tolerance 2%)` : null;
  return { published, common, incomplete };
}

/** anchor minus other under one view, paired by question, with the conversation-cluster bootstrap (10,000 draws, seed gst-1365). */
export function contrast(anchor: CellValues, other: CellValues, readers: readonly string[], questions: readonly string[], view: View): Interval {
  return delta(questions.map(q => ({ id: q, cluster: anchor.get(q)!.conversation, a: questionView(other.get(q), view, readers)!, b: questionView(anchor.get(q), view, readers)! })));
}

/** A cell's mean under a view on the given questions: an absolute level, reported beside the contrasts and never ruled on. */
export function level(cell: CellValues, readers: readonly string[], questions: readonly string[], view: View): number | null {
  return questions.length ? round(questions.reduce((a, q) => a + questionView(cell.get(q), view, readers)!, 0) / questions.length) : null;
}

/** δ = Δ_F − Δ_M0, paired by question, with the same bootstrap. */
export function judgeEffect(anchor: CellValues, other: CellValues, readers: readonly string[], questions: readonly string[]): Interval {
  const d = (v: View, q: string) => questionView(anchor.get(q), v, readers)! - questionView(other.get(q), v, readers)!;
  return delta(questions.map(q => ({ id: q, cluster: anchor.get(q)!.conversation, a: d('M0', q), b: d('F', q) })));
}

function delta(pairs: Array<{ id: string; cluster: string; a: number; b: number }>): Interval {
  const d = clusteredPairedDelta(pairs, { draws: DRAWS, seed: seedNumber(SEED) });
  return { delta: round(d.delta), ci95: d.ci95 ? [round(d.ci95[0]), round(d.ci95[1])] : null };
}

export type Outcome = 'HOLDS' | 'SIZE CHANGED' | 'WEAKENED' | 'REVERSED' | 'INCOMPLETE';
const excludesZero = (i: Interval) => !!i.ci95 && (i.ci95[0] > 0 || i.ci95[1] < 0);
const side = (i: Interval) => (!i.ci95 ? 0 : i.ci95[0] > 0 ? 1 : i.ci95[1] < 0 ? -1 : 0);

export interface ContrastInputs { canonical: Interval; F: Interval; effect: Interval; perReader: Record<string, Interval>; incomplete: string | null }

/** The outcome of one contrast (section 5): its class comes from the canonical interval, the rest from Δ_F, δ and each reader's Δ_F. */
export function outcome(x: ContrastInputs): { outcome: Outcome; separated: boolean; reasons: string[] } {
  const separated = excludesZero(x.canonical);
  if (x.incomplete) return { outcome: 'INCOMPLETE', separated, reasons: [x.incomplete] };
  const sign = Math.sign(x.canonical.delta);
  const reasons: string[] = [];
  if (side(x.F) === -sign && sign !== 0) return { outcome: 'REVERSED', separated, reasons: ['the three-reader Δ_F interval excludes 0 on the side opposite Δ_M'] };
  const flipped = Object.entries(x.perReader).filter(([, r]) => sign !== 0 && side(r) === -sign).map(([reader]) => reader);
  if (separated && !excludesZero(x.F)) reasons.push('the three-reader Δ_F interval includes 0');
  if (flipped.length) reasons.push(`confident reversal for ${flipped.join(', ')}`);
  if (reasons.length) return { outcome: 'WEAKENED', separated, reasons };
  if (Math.sign(x.F.delta) === sign && excludesZero(x.effect) && Math.abs(x.effect.delta) >= Math.max(SIZE_POINTS, Math.abs(x.canonical.delta) / 2)) {
    return { outcome: 'SIZE CHANGED', separated, reasons: ['δ excludes 0 and |δ| is at least the larger of 3 points and half of |Δ_M|'] };
  }
  return { outcome: 'HOLDS', separated, reasons: [] };
}

/** gbrain's position against one comparator: ahead, behind or level, from an interval. */
const position = (i: Interval) => (side(i) > 0 ? 'ahead' : side(i) < 0 ? 'behind' : 'level');

export interface RankedContrast { set: string; canonical: Interval; F: Interval | null; outcome: Outcome }

/** Per set: the rank holds when gbrain's position under F against every canonically separated comparator is unchanged. */
export function ranks(contrasts: readonly RankedContrast[]): Record<string, { holds: boolean | null; changed: number }> {
  const out: Record<string, { holds: boolean | null; changed: number }> = {};
  for (const c of contrasts) {
    const r = out[c.set] ??= { holds: true, changed: 0 };
    if (!excludesZero(c.canonical)) continue;
    if (c.outcome === 'INCOMPLETE' || !c.F) { r.holds = null; continue; }
    if (position(c.F) !== position(c.canonical)) { r.changed++; if (r.holds !== null) r.holds = false; }
  }
  return out;
}

export type FamilyVerdict = 'HOLDS' | 'HOLDS IN SIGN AND RANK, SIZE RESTATED' | 'WEAKENED' | 'FAILS' | 'INCOMPLETE' | 'NOT RUN (CUT ORDER)';

/**
 * A family's verdict (section 5). FAILS on any REVERSED contrast or a rank change on S1 or S2b; WEAKENED on any WEAKENED
 * contrast otherwise (a rank change on another set implies one); a family with an INCOMPLETE contrast or a partial
 * stratum is INCOMPLETE; a family the cut order dropped is NOT RUN.
 */
export function familyVerdict(contrasts: readonly RankedContrast[], opts: { partial?: boolean; cut?: boolean } = {}): FamilyVerdict {
  if (opts.cut || !contrasts.length) return 'NOT RUN (CUT ORDER)';
  const outcomes = contrasts.map(c => c.outcome);
  if (opts.partial || outcomes.includes('INCOMPLETE')) return 'INCOMPLETE';
  const r = ranks(contrasts);
  if (outcomes.includes('REVERSED') || ['S1', 'S2b'].some(s => r[s]?.holds === false)) return 'FAILS';
  if (outcomes.includes('WEAKENED')) return 'WEAKENED';
  if (outcomes.includes('SIZE CHANGED')) return 'HOLDS IN SIGN AND RANK, SIZE RESTATED';
  return 'HOLDS';
}

/** The Wilson score interval for k of n at 95%. */
export function wilson(k: number, n: number): { share: number | null; ci95: [number, number] | null } {
  if (!n) return { share: null, ci95: null };
  const z = 1.959963984540054, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return { share: round(p), ci95: [round(Math.max(0, c - h)), round(Math.min(1, c + h))] };
}

/** One answer the referee judged: the canonical (M0), frontier and referee verdicts at the pass threshold. */
export interface RefereeRow { group: string; category?: string; m: boolean; f: boolean; r: boolean }

/** Referee validity on the agreement sample, and p_F (the referee siding with the frontier judge) on the disagreements. */
export function referee(agreements: readonly RefereeRow[], disagreements: readonly RefereeRow[]) {
  const matched = agreements.filter(x => x.r === x.f).length;
  const validity = wilson(matched, agreements.length);
  const valid = validity.share !== null && validity.share >= REFEREE_VALIDITY;
  const pF = (rows: readonly RefereeRow[]) => wilson(rows.filter(x => x.r === x.f).length, rows.length);
  const groups = [...new Set(disagreements.map(x => x.group))].sort();
  const categories = [...new Set(disagreements.flatMap(x => x.category ? [x.category] : []))].sort();
  return { agreement_sample: agreements.length, validity, valid, disagreements: disagreements.length, p_F: pF(disagreements),
    by_row: { claude_rows: pF(disagreements.filter(x => x.group.startsWith('Claude rows'))), sol_rows: pF(disagreements.filter(x => x.group.startsWith('Sol rows'))) },
    by_group: Object.fromEntries(groups.map(g => [g, pF(disagreements.filter(x => x.group === g))])),
    by_category: Object.fromEntries(categories.map(c => [c, pF(disagreements.filter(x => x.category === c))])),
    by_direction: { frontier_stricter: pF(disagreements.filter(x => x.m && !x.f)), frontier_more_lenient: pF(disagreements.filter(x => !x.m && x.f)) } };
}

/** One control answer's verdict per judge: whether that judge's verdict matched the known one. */
export interface ControlRow { question: string; set: string; abstention: boolean; control: string; correct: Record<string, boolean> }

/** Error rates per judge and control, paired differences between judges (clustered by question, same bootstrap), and per set the questions, the C2 answers and the C2 answers on abstention questions. */
export function controls(rows: readonly ControlRow[], judges: readonly string[]) {
  const err = (j: string, xs: readonly ControlRow[]) => { const n = xs.filter(x => j in x.correct); return { n: n.length, error: n.length ? round(n.filter(x => !x.correct[j]).length / n.length) : null }; };
  const kinds = [...new Set(rows.map(r => r.control))].sort();
  const per = Object.fromEntries(judges.map(j => [j, { total: err(j, rows), ...Object.fromEntries(kinds.map(k => [k, err(j, rows.filter(r => r.control === k))])) }]));
  const pairs: Record<string, Interval & { n: number; more_accurate: string | null }> = {};
  for (const a of judges) for (const b of judges) {
    if (a >= b) continue;
    const both = rows.filter(r => a in r.correct && b in r.correct);
    if (!both.length) continue;
    const d = delta(both.map((r, i) => ({ id: `${r.question}|${r.control}|${i}`, cluster: r.question, a: r.correct[b] ? 0 : 1, b: r.correct[a] ? 0 : 1 })));
    const more = excludesZero(d) && Math.abs(d.delta) >= MORE_ACCURATE_POINTS ? (d.delta < 0 ? a : b) : null;
    pairs[`${a} minus ${b}`] = { ...d, n: both.length, more_accurate: more };
  }
  const counts = Object.fromEntries([...new Set(rows.map(r => r.set))].sort().map(set => {
    const xs = rows.filter(r => r.set === set), c2 = xs.filter(r => r.control === 'C2');
    return [set, { questions: new Set(xs.map(r => r.question)).size, c2: c2.length, c2_on_abstention: c2.filter(r => r.abstention).length }];
  }));
  return { error_rates: per, paired: pairs, counts };
}

export type WhichJudge = 'frontier' | 'canonical' | 'unsettled';

/**
 * Section 4's verdict: the frontier judge is right when the referee is valid, p_F's interval lies above 0.5 and the
 * controls don't show the canonical judge more accurate than any frontier judge; the canonical judge is right in the
 * mirror case; otherwise unsettled.
 */
export function whichJudge(x: { valid: boolean; pF: { ci95: [number, number] | null }; canonicalMoreAccurate: boolean; frontierMoreAccurate: boolean }): WhichJudge {
  if (!x.valid || !x.pF.ci95) return 'unsettled';
  if (x.pF.ci95[0] > 0.5 && !x.canonicalMoreAccurate) return 'frontier';
  if (x.pF.ci95[1] < 0.5 && !x.frontierMoreAccurate) return 'canonical';
  return 'unsettled';
}

/**
 * Program primary (T0) scorer: one binary end-to-end failure per task run,
 * from the session-2 deliverable text and the generator's gold alone.
 *
 * Failure definition (plan 2026-10-07 section 3.1): an unsupported or stale
 * answer or action, or a missed commitment, not a missing benchmark point.
 * A run fails when any of these holds:
 *
 *   missed_commitment  none of the commitment's patterns appears;
 *   stale_date         the pre-change meeting date appears outside a change
 *                      context (see `changeContext`) and the new date does
 *                      not appear (v2; see `scoreAnswer`);
 *   stale_correction   the pre-correction value appears outside a change
 *                      context and the corrected value does not appear (v2);
 *   unsupported        a value only the namesake has (their meeting date,
 *                      seat count, price or commitment) appears outside a
 *                      sentence that tells the two people apart (v2);
 *   execution_error    the session ended in a provider or harness error, or
 *                      without a deliverable; an error can never improve
 *                      the failure rate.
 *
 * Omitting the meeting date or the corrected value is not a failure under
 * the definition; it is reported as an omission, and `complete` (commitment,
 * new date and corrected value all present, no failure) is the secondary
 * success metric, so a system that avoids stating facts cannot look good on
 * both. Session-2 actions that change the brain are recorded by the runner,
 * not scored here.
 */
import type { Matcher, PPTask } from '../../generators/program-primary-gen.ts';

export const T0_SCORER_VERSION = 't0-score-v2';
export type ScorerVersion = 't0-score-v1' | 't0-score-v2' | 't0-score-v3';
/** Post-hoc (written after reading baseline outputs; secondary only, never the preregistered primary). */
export const T0_SCORER_POSTHOC = 't0-score-v3';
export const FAILURE_KINDS = ['missed_commitment', 'stale_date', 'stale_correction', 'unsupported', 'execution_error'] as const;
export type FailureKind = typeof FAILURE_KINDS[number];

export interface T0Score {
  version: ScorerVersion;
  failed: boolean;
  kinds: FailureKind[];
  commitment_hit: boolean;
  new_date_hit: boolean;
  corrected_hit: boolean;
  /** Stale mentions outside a change context, with the matched text. */
  stale_date_mentions: string[];
  stale_correction_mentions: string[];
  /** Stale mentions excused by a change context ("moved from October 16"). */
  excused_mentions: string[];
  namesake_hits: string[];
  omissions: { date: boolean; correction: boolean };
  complete: boolean;
  answer_chars: number;
}

/** v1 cues: words before a stale value, in the same sentence, that mark it as the old value. */
const PRE_CUE_V1 = /\b(?:not|isn'?t|wasn'?t|instead of|rather than|from|previously|originally|formerly|no longer|old|earlier|prior|replac\w*|supersed\w*|correct\w*|wrong|incorrect|outdated|mov(?:ed|ing)|reschedul\w*|chang(?:ed|ing)|shift\w*|push\w*|listed as|noted as|recorded as|had (?:it|been)|used to)\b|~~/i;
/** v1 cues: words right after a stale value, in the same sentence, that mark it as the old value. */
const POST_CUE_V1 = /^[^.!?\n]{0,40}?(?:→|->|=>|\bmoved\b|\breschedul|\bchanged\b|\bshifted\b|\bpushed\b|\bis wrong\b|\bwas wrong\b|\bincorrect\b|\boutdated\b|\bsuperseded\b|\bno longer\b|\bcorrected\b|\breplaced\b|\(old|\(previous|\(was|\(not|~~)/i;
/** v2 adds the ways a correct deliverable cites an outdated record ("your Oct 12 note still says Oct 22", "no 150-seat figure"). */
const PRE_CUE_V2 = new RegExp(`${PRE_CUE_V1.source}|\\b(?:no|never|still (?:says?|has|lists|shows|reads|mentions)|says|said|out of date|stale|history|historical|earlier notes?|old notes?)\\b`, 'i');
const POST_CUE_V2 = new RegExp(`${POST_CUE_V1.source}|^[^.!?\\n]{0,60}?(?:which (?:is|was) wrong|out of date|is stale|was an error|an error|\\(history|\\(historical)`, 'i');
/** v2: a namesake value named to tell the two people apart is not a claim about the contact. */
const DISAMBIGUATION = /confus|not the same|different (?:person|contact|company)|distinct|namesake|unrelated|separate|mix(?:ed)? (?:them )?up|don'?t mix/i;

/**
 * v2 reads the deliverable as prose: markdown link targets, code spans and page paths are removed (a page slug
 * such as `meetings/2026-10-22-...` names a record, not a meeting time), and emphasis markers are dropped.
 */
export function proseOf(text: string): string {
  return text.replace(/\]\([^)]*\)/g, ']').replace(/`[^`]*`/g, ' ').replace(/\b[a-z][a-z0-9-]*\/[a-z0-9][\w\-./]*/gi, ' ').replace(/\*\*|__/g, '');
}

const regexes = (m: Matcher) => m.patterns.map(p => new RegExp(p, 'gi'));
export const matches = (m: Matcher, text: string) => regexes(m).some(r => r.test(text));

/** True when the match at [start, end) sits in a change context: a cue earlier in its sentence (within 80 characters) or right after it. */
export function changeContext(text: string, start: number, end: number, version: ScorerVersion = T0_SCORER_VERSION): boolean {
  const before = text.slice(Math.max(0, start - 80), start);
  const sentenceStart = Math.max(before.lastIndexOf('. '), before.lastIndexOf('\n'), before.lastIndexOf('! '), before.lastIndexOf('? '));
  const pre = sentenceStart >= 0 ? before.slice(sentenceStart + 1) : before;
  const [preCue, postCue] = version === 't0-score-v1' ? [PRE_CUE_V1, POST_CUE_V1] : [PRE_CUE_V2, POST_CUE_V2];
  return preCue.test(pre) || postCue.test(text.slice(end, end + 80));
}

/** Stale mentions split into those asserted as current and those excused by a change context. */
export function staleMentions(m: Matcher, text: string, version: ScorerVersion = T0_SCORER_VERSION): { asserted: string[]; excused: string[] } {
  const asserted: string[] = [];
  const excused: string[] = [];
  for (const r of regexes(m)) {
    for (const hit of text.matchAll(r)) {
      const start = hit.index ?? 0;
      (changeContext(text, start, start + hit[0].length, version) ? excused : asserted).push(hit[0]);
    }
  }
  return { asserted, excused };
}

/** v3: a namesake value in the same line or paragraph as a disambiguation is attributed to the namesake. */
const DISAMBIGUATION_V3 = new RegExp(`${DISAMBIGUATION.source}|mix \\w+ up|(?:his|her|their) own|for (?:him|her|them), not`, 'i');

/** Lines (paragraphs and list items) of `text` that match `m`. */
function linesMatching(m: Matcher, text: string): string[] {
  return text.split(/\n+/).filter(x => matches(m, x));
}

/** Sentences (split on . ! ? and newlines) of `text` that match `m`. */
function sentencesMatching(m: Matcher, text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter(x => matches(m, x));
}

/**
 * v1 (frozen 2026-10-08, superseded before the baseline by amendment 1): every stale mention outside a change
 * context fails; any namesake value fails.
 * v2: the deliverable is read as prose (proseOf); a stale mention fails only when it is outside a change context
 * AND the current value is absent, so a deliverable that states the current value and cites the outdated record
 * passes, and one that states only the old value fails; the namesake's company is not a value, and a namesake value
 * in a sentence that tells the two people apart is excused.
 * v3 (post-hoc, written after reading two baseline deliverables that v2 failed; reported beside v2, never instead):
 * as v2, but the disambiguation may sit anywhere in the same line or paragraph ("Don't mix him up with Yusuf Varga.
 * Varga has his own meeting on October 21").
 */
export function scoreAnswer(task: PPTask, answer: string | null | undefined, opts: { executionError?: string | null; version?: ScorerVersion } = {}): T0Score {
  const version = opts.version ?? T0_SCORER_VERSION;
  const raw = answer ?? '';
  const text = version === 't0-score-v1' ? raw : proseOf(raw);
  const g = task.gold;
  const commitment_hit = matches(g.commitment, text);
  const new_date_hit = matches(g.date.new, text);
  const corrected_hit = matches(g.correction.corrected, text);
  const staleDate = staleMentions(g.date.old, text, version);
  const staleCorr = staleMentions(g.correction.stale, text, version);
  const namesake_hits = version === 't0-score-v1'
    ? g.namesake.filter(m => matches(m, text)).map(m => m.label)
    : version === 't0-score-v2'
      ? g.namesake.filter(m => m.label.startsWith('namesake ') && sentencesMatching(m, text).some(x => !DISAMBIGUATION.test(x))).map(m => m.label)
      : g.namesake.filter(m => m.label.startsWith('namesake ') && linesMatching(m, text).some(x => !DISAMBIGUATION_V3.test(x))).map(m => m.label);
  const staleDateFails = staleDate.asserted.length > 0 && (version === 't0-score-v1' || !new_date_hit);
  const staleCorrFails = staleCorr.asserted.length > 0 && (version === 't0-score-v1' || !corrected_hit);
  const kinds: FailureKind[] = [];
  if (opts.executionError || !raw.trim()) kinds.push('execution_error');
  if (!commitment_hit) kinds.push('missed_commitment');
  if (staleDateFails) kinds.push('stale_date');
  if (staleCorrFails) kinds.push('stale_correction');
  if (namesake_hits.length) kinds.push('unsupported');
  const failed = kinds.length > 0;
  return {
    version, failed, kinds, commitment_hit, new_date_hit, corrected_hit,
    stale_date_mentions: staleDate.asserted, stale_correction_mentions: staleCorr.asserted, excused_mentions: [...staleDate.excused, ...staleCorr.excused],
    namesake_hits,
    omissions: { date: !new_date_hit && !staleDateFails, correction: !corrected_hit && !staleCorrFails },
    complete: !failed && new_date_hit && corrected_hit,
    answer_chars: raw.length,
  };
}

/** A deliverable that states exactly the truth, derived from gold only (the honest system of the mutation suite and the scripted reader's template). */
export function truthfulAnswer(task: PPTask, values: { date: string; correction: string; commitment: string | null }): string {
  const who = task.correction_kind === 'role' ? `${task.contact_name}, ${values.correction}.` : `${task.contact_name}.`;
  const terms = task.correction_kind === 'role' ? '' : ` Terms: ${values.correction}.`;
  const owe = values.commitment ? ` I owe them ${values.commitment}.` : '';
  return `${who} Meeting: ${values.date}.${terms}${owe}`;
}

export interface Aggregate { runs: number; failures: number; failure_rate: number; complete: number; by_kind: Record<FailureKind, number> }

export function aggregate(scores: readonly T0Score[]): Aggregate {
  const by_kind = Object.fromEntries(FAILURE_KINDS.map(k => [k, 0])) as Record<FailureKind, number>;
  for (const s of scores) for (const k of s.kinds) by_kind[k]++;
  const failures = scores.filter(s => s.failed).length;
  return { runs: scores.length, failures, failure_rate: scores.length ? failures / scores.length : 0, complete: scores.filter(s => s.complete).length, by_kind };
}

// ─── T0b: several commitments and corrections per task ──────────────

export const T0B_SCORER_VERSION = 't0b-score-v1';
/**
 * t0b-score-v2 (T0b preregistration amendment 5, frozen before any version 2 world or sealed cell): t0b-score-v1 with
 * owner-anchored namesake attribution. Written from the namesake diagnostic (2026-10-10), which read all 25 runs that
 * named a namesake value: none claimed it for the contact, and the 11 that v1 flagged were 7 disambiguations its cue
 * list missed and 4 generic phrases.
 */
export const T0B_SCORER_V2 = 't0b-score-v2';
export type T0bScorerVersion = typeof T0B_SCORER_VERSION | typeof T0B_SCORER_V2;
/** v2 cues, added to v3's: the ways the audited deliverables set a namesake value aside. */
const DISAMBIGUATION_T0B_V2 = new RegExp(`${DISAMBIGUATION_V3.source}|different (?:account|prospect|deal|customer|client|company)|\\bneither\\b|\\bnot for\\b|left (?:it |that |this )?out|not (?:yours|something you owe)`, 'i');
const nameRe = (names: readonly string[]) => new RegExp(`(?<![A-Za-z])(?:${names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|')})(?![A-Za-z])`);

/**
 * v2 namesake rule, per line (paragraph or list item) that carries a namesake value: the line is the namesake's,
 * and excused, when it names the namesake (last name, company or code) and not the contact, or when it carries a
 * disambiguation cue. A line that names both without a cue, or names neither and has no cue, claims the value for
 * the contact and fails. Codes match case-sensitively as whole tokens.
 */
export function namesakeLineExcused(line: string, owners: { contact: readonly string[]; namesake: readonly string[] }): boolean {
  if (DISAMBIGUATION_T0B_V2.test(line)) return true;
  const ns = nameRe(owners.namesake).test(line);
  const contact = nameRe(owners.contact).test(line);
  return ns && !contact;
}

export interface ItemsGold {
  commitments: Matcher[];
  date: { old: Matcher; new: Matcher };
  corrections: Array<{ kind: string; stale: Matcher; corrected: Matcher }>;
  namesake: Matcher[];
  owners?: { contact: string[]; namesake: string[] };
}

export interface ItemsScore extends Omit<T0Score, 'version' | 'commitment_hit' | 'corrected_hit'> {
  version: T0bScorerVersion;
  commitments_hit: string[];
  commitments_missed: string[];
  corrected_hit: string[];
}

/**
 * T0b scorer (preregistered with the T0b workload): the t0-score-v3 rules applied to every item. Prose reading,
 * change cues, "a stale mention fails only when its current value is absent", namesake values excused in a line
 * or paragraph that tells the people apart. A run fails when any commitment is missing, any stale value stands
 * without its current value, any namesake value is claimed, or the session ended in an error.
 */
export function scoreItems(gold: ItemsGold, answer: string | null | undefined, opts: { executionError?: string | null; version?: T0bScorerVersion } = {}): ItemsScore {
  const version = opts.version ?? T0B_SCORER_VERSION;
  if (version === T0B_SCORER_V2 && !gold.owners) throw new Error('t0b-score-v2 needs gold.owners (generator version 2)');
  const raw = answer ?? '';
  const text = proseOf(raw);
  const commitments_hit = gold.commitments.filter(m => matches(m, text)).map(m => m.label);
  const commitments_missed = gold.commitments.filter(m => !matches(m, text)).map(m => m.label);
  const new_date_hit = matches(gold.date.new, text);
  const staleDate = staleMentions(gold.date.old, text, 't0-score-v3');
  const staleDateFails = staleDate.asserted.length > 0 && !new_date_hit;
  const corr = gold.corrections.map(c => ({ c, hit: matches(c.corrected, text), stale: staleMentions(c.stale, text, 't0-score-v3') }));
  const staleCorr = corr.filter(x => x.stale.asserted.length > 0 && !x.hit);
  const lineClaims = version === T0B_SCORER_V2 ? (x: string) => !namesakeLineExcused(x, gold.owners!) : (x: string) => !DISAMBIGUATION_V3.test(x);
  const namesake_hits = gold.namesake.filter(m => m.label.startsWith('namesake ') && linesMatching(m, text).some(lineClaims)).map(m => m.label);
  const kinds: FailureKind[] = [];
  if (opts.executionError || !raw.trim()) kinds.push('execution_error');
  if (commitments_missed.length) kinds.push('missed_commitment');
  if (staleDateFails) kinds.push('stale_date');
  if (staleCorr.length) kinds.push('stale_correction');
  if (namesake_hits.length) kinds.push('unsupported');
  const failed = kinds.length > 0;
  const corrected_hit = corr.filter(x => x.hit).map(x => x.c.corrected.label);
  return {
    version, failed, kinds, commitments_hit, commitments_missed, new_date_hit, corrected_hit,
    stale_date_mentions: staleDate.asserted, stale_correction_mentions: staleCorr.flatMap(x => x.stale.asserted),
    excused_mentions: [...staleDate.excused, ...corr.flatMap(x => x.stale.excused)], namesake_hits,
    omissions: { date: !new_date_hit && !staleDateFails, correction: corr.some(x => !x.hit && !x.stale.asserted.length) },
    complete: !failed && new_date_hit && corrected_hit.length === gold.corrections.length,
    answer_chars: raw.length,
  };
}

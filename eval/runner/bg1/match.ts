/**
 * BG1's deterministic value matcher (preregistration docs/benchmarks/2026-11-09-changing-facts-battleground-preregistration.md,
 * "Readers and judges"): it reads an answer against the plan's own values, with no model, so its agreement with the
 * judges can be reported beside every result.
 *
 *   matchAnswer(q, response) is one of
 *     correct  the answer states the gold value (any accepted form) and no other tracked value; for an ordered question
 *              (s8_history) it states every gold value in the plan's order and no stale or decoy value
 *     stale    it states a stale value of the slot (earlier, corrected, unsigned, withdrawn or not yet in effect) and no other kind
 *     decoy    it states a near-name decoy entity's value and no other kind
 *     other    it states no tracked value (an abstention, an unrelated value), or an ordered list that is incomplete or out of order
 *     unclear  it states values of two kinds (say the old and the new value), so only a reader of the sentence can tell
 *
 * Both sides are normalised the same way before matching: lower case, straight quotes, thousands separators dropped,
 * "4.2k" and "4.2 thousand" written out, number words up to the millions as digits (read as English numerals, so "two,
 * three" and "nineteen ninety" stay two numbers), currency signs and words dropped,
 * ordinal suffixes dropped, "%" as the word percent, and every other mark as a space. A value matches on whole-token
 * boundaries, longest values first, and a matched span is never matched again, so "Porto" does not match inside
 * "Porto Alegre".
 */
import type { MemoryQuestion } from '../memory-qa/corpus.ts';
import type { Bg1QuestionFields } from './types.ts';

export type MatchClass = 'correct' | 'stale' | 'decoy' | 'other' | 'unclear';
export const MATCH_CLASSES: readonly MatchClass[] = ['correct', 'stale', 'decoy', 'other', 'unclear'];
type Kind = 'gold' | 'stale' | 'decoy';

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1_000, million: 1_000_000 };

/**
 * Runs of number words as digits, read as English numerals: "four thousand two hundred" is 4200, "twenty five" is 25,
 * "one hundred and five" is 105. A word that cannot continue the numeral before it starts a new one, so "two three"
 * (as "two, three" reads once its comma is gone) is 2 and 3, not 5.
 */
function numberWords(tokens: string[]): string[] {
  const out: string[] = [];
  let total = 0, current = 0, open = false, last: 'zero' | 'unit' | 'teen' | 'tens' | 'scale' | null = null;
  const close = () => { if (open) out.push(String(total + current)); total = 0; current = 0; open = false; last = null; };
  tokens.forEach((t, i) => {
    if (Object.hasOwn(UNITS, t)) {
      const n = UNITS[t], kind = n === 0 ? 'zero' : n < 10 ? 'unit' : n < 20 ? 'teen' : 'tens';
      if (last !== null && (kind === 'zero' || !(last === 'scale' || (last === 'tens' && kind === 'unit')))) close();
      current += n; open = true; last = kind;
      return;
    }
    if (Object.hasOwn(SCALES, t) && open) {
      if (t === 'hundred') current = (current || 1) * 100;
      else { total += (current || 1) * SCALES[t]; current = 0; }
      last = 'scale';
      return;
    }
    if (t === 'and' && last === 'scale' && Object.hasOwn(UNITS, tokens[i + 1] ?? '')) return;
    close();
    out.push(t);
  });
  close();
  return out;
}

const plain = (x: number) => String(Math.round(x * 1e6) / 1e6);

/** The normal form both a value and an answer are matched in. */
export function normalise(text: string): string {
  let s = text.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2010-\u2015]/g, '-');
  s = s.replace(/(\d),(?=\d{3}\b)/g, '$1');
  s = s.replace(/(\d+(?:\.\d+)?)\s*(k|thousand)\b/g, (_, n: string) => plain(Number(n) * 1_000));
  s = s.replace(/(\d+(?:\.\d+)?)\s*million\b/g, (_, n: string) => plain(Number(n) * 1_000_000));
  s = s.replace(/(\d+)\.0+\b/g, '$1');
  s = s.replace(/(\d)(st|nd|rd|th)\b/g, '$1');
  s = s.replace(/%/g, ' percent ').replace(/[$\u20ac\u00a3]/g, ' ').replace(/\b(usd|eur|gbp|dollars?|euros?|pounds?)\b/g, ' ');
  s = s.replace(/(\d)[.:/-](?=\d)/g, '$1\u0000').replace(/[^a-z0-9\u0000']+/g, ' ').replace(/\u0000/g, '.').replace(/'/g, '');
  return numberWords(s.split(/\s+/).filter(Boolean)).join(' ');
}

interface Hit { kind: Kind; value: number; at: number }

/**
 * Every whole-token occurrence of the given values in a text, longest values first, each span claimed once. value is
 * the index into its kind's list, at the token offset of the occurrence.
 */
export function findValues(text: string, values: Record<Kind, readonly string[]>): Hit[] {
  const tokens = normalise(text).split(' ').filter(Boolean);
  const claimed = new Array<boolean>(tokens.length).fill(false);
  const candidates = (Object.keys(values) as Kind[]).flatMap(kind => values[kind].map((v, value) => ({ kind, value, words: normalise(v).split(' ').filter(Boolean) })))
    .filter(c => c.words.length).sort((a, b) => b.words.length - a.words.length);
  const hits: Hit[] = [];
  for (const c of candidates) {
    for (let at = 0; at + c.words.length <= tokens.length; at++) {
      if (c.words.some((w, k) => tokens[at + k] !== w || claimed[at + k])) continue;
      for (let k = 0; k < c.words.length; k++) claimed[at + k] = true;
      hits.push({ kind: c.kind, value: c.value, at });
    }
  }
  return hits.sort((a, b) => a.at - b.at);
}

const fieldsOf = (q: Pick<MemoryQuestion, 'id' | 'bg1'>): Bg1QuestionFields => {
  if (!q.bg1) throw new Error(`question ${q.id} has no BG1 fields`);
  return q.bg1;
};
const valuesOf = (f: Bg1QuestionFields): Record<Kind, readonly string[]> => ({ gold: f.gold_values, stale: f.stale_values, decoy: f.decoy_values });

/** Whether every gold value occurs in the plan's order (each after the previous one), for an ordered question. */
function inOrder(hits: readonly Hit[], golds: number): boolean {
  let after = -1;
  for (let v = 0; v < golds; v++) {
    const next = hits.find(h => h.kind === 'gold' && h.value === v && h.at > after);
    if (!next) return false;
    after = next.at;
  }
  return true;
}

export function matchAnswer(q: Pick<MemoryQuestion, 'id' | 'bg1'>, response: string): MatchClass {
  const f = fieldsOf(q);
  const hits = findValues(response, valuesOf(f));
  if (f.ordered) {
    const wrong = (['stale', 'decoy'] as const).filter(k => hits.some(h => h.kind === k));
    if (wrong.length) return wrong.length > 1 ? 'unclear' : wrong[0];
    return inOrder(hits, f.gold_values.length) ? 'correct' : 'other';
  }
  const kinds = (['gold', 'stale', 'decoy'] as const).filter(k => hits.some(h => h.kind === k));
  if (!kinds.length) return 'other';
  if (kinds.length > 1) return 'unclear';
  return kinds[0] === 'gold' ? 'correct' : kinds[0];
}

/** Whether a text states the gold (every value, for an ordered question) and whether it states any stale value. */
export function presence(q: Pick<MemoryQuestion, 'id' | 'bg1'>, text: string): { gold: boolean; stale: boolean } {
  const f = fieldsOf(q);
  const hits = findValues(text, valuesOf(f));
  const gold = f.ordered ? f.gold_values.every((_, v) => hits.some(h => h.kind === 'gold' && h.value === v)) : hits.some(h => h.kind === 'gold');
  return { gold, stale: hits.some(h => h.kind === 'stale') };
}

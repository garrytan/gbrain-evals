/**
 * RS1 judge script (GST-1154; plan v2 "Big decisions" 6, the preregistration's "Readers and judges"; PR 2 plan item 7
 * with gate changes d7, d8 and d11). Two runs use it: stage 1's judge check on public BEAM-1M dev answers, and stage
 * 5's sensitivity judge in custody. Counted judging (gpt-4.1-mini and claude-haiku-5-5, per reader) runs inside the
 * cells (eval/runner/q1/cells/judging.ts); this script reads what the cells judged and never judges a row again with a judge
 * the cells already ran. It adds one judge, the family-neutral fallback gemini:gemini-3.8-flash, through the same paid
 * path eval/custody/rs1/validate.ts uses (requirePaidArm, then startPaidRun's fetch guard, which prices
 * gemini-3.8-flash in the budget ledger), with the cells' own BEAM rubric instrument (memory-qa/instruments.ts).
 *
 *   bun eval/runner/rs1/judge.ts label --source <stage 1 out>... --out <sheet.csv> [--manifest <rs1-cells.json>]
 *   bun eval/runner/rs1/judge.ts label --read <filled sheet.csv>
 *   bun eval/runner/rs1/judge.ts check --source <stage 1 out>... --labels <filled sheet.csv> --out <dir>
 *       (--fake | --paid --budget-run-id <id> --budget-ledger <RS1 ledger>) [--manifest <rs1-cells.json>] [--concurrency 8]
 *   bun eval/runner/rs1/judge.ts sensitivity --source <custody out>... (--fake | --paid --budget-run-id <id> --budget-ledger <RS1 ledger>)
 *       [--manifest <rs1-cells.json>] [--concurrency 8]
 *
 * --source is a cell output directory (cell.ts run or merge --out, or reread-cell.ts --out): each arm's answers and
 * judgments are read from cells/<arm cell id>/ and its particle-1 re-read's from cells/<arm cell id>.reread-particle-particle-1/.
 * The manifest is eval/runner/q1/cells/rs1-cells.json: stage 1 is every cell of block RS1-dry, the counted cells are
 * those of set RS1, and every arm must carry a judging plan (judging.by_reader) naming only the two counted judges and
 * never a judge of its reader's family.
 *
 * label writes a blind sheet for one person to fill, in a seeded order, with answer ids and public BEAM text only (no
 * system, reader, cell or judge names): every stage 1 answer to an abstention item, marked abstained or answered, and
 * a seeded sample of SHORT_SAMPLE answers whose short-answer key is decisive, marked correct or incorrect against the
 * reference shown. <sheet>.design.json beside it records the seed, the counts and the hedge pre-filter's verdicts;
 * only the CSV goes to the labeler. label --read checks a filled sheet and prints its counts and SHA-256.
 *
 * check computes, on the stage 1 cells' replicate-0 answers that the scorer counts (outcome scored or ingest_degraded):
 *   (a) agreement: on the answers both counted judges are planned to grade (particle-1 rows, the re-reads of the
 *       packed contexts included), the share whose pass or fail (memory-qa PASS_THRESHOLD) agrees; at least 90% over
 *       at least 300 scored pairs;
 *   (b) each counted judge's pass/fail agreement with the fallback on that judge's own planned rows that the fallback
 *       graded, reported beside (a), no bar;
 *   (c) the key. Abstention items are keyed by the hand label (abstained: the key says correct). hedge.ts at
 *       PREFILTER only flags candidate abstentions in the design file and the result, and never sets a key. An item of
 *       a short-answer ability (KEYED_ABILITIES) whose reference normalizes to a date, a number (with at most two unit
 *       words) or a name of at most four words is keyed per answer from its final-answer span (hedge.ts finalSpanV3):
 *       correct when the reference appears there, not negated, with no other candidate of the same type; wrong when
 *       nothing in the whole answer is compatible with the reference; else unkeyed (another candidate, a negation, a
 *       partial date or name, the reference only outside the span), so an ambiguous answer never counts against a
 *       judge (review F11). Dates compare as year, month and day; numbers as values (commas, currency, k, thousand,
 *       million, billion, percent and number words are canonical forms). The key is validated first on the sheet's
 *       labeled short answers: at most KEY_MAX_ERROR wrong over at least KEY_VALIDATION_MIN decisive labeled answers;
 *   (d) once the key is valid, each counted judge on its own planned rows, and the fallback on every keyed answer,
 *       matches the key's verdict at pass/fail on at least 95% of at least KEY_MIN decisive keyed answers.
 * The fallback grades the keyed answers and the agreement population only, never a row of its own family. Its records
 * go to <out>/fallback-judgments.ndjson (immutable, keyed like the cells'; a rerun buys nothing it already holds) under
 * instrument id <instrument>@gemini:gemini-3.8-flash. The result goes to <out>/judge-check.json before any exit.
 * Exits (scoreboard-errors.ts refuse(), exit 3 unless noted): RS1_JUDGE_CHECK_FAIL names each failed bar with its count
 * and denominator and prints the preregistration's branch for GBEV-3 (gemini-3.8-flash judges every row, recorded
 * before minting); this script never switches judges. RS1_JUDGE_CHECK_KEY_INVALID: the key, not a judge, failed its
 * validation, so the fallback branch does not apply (review F6). RS1_JUDGE_CHECK_TOO_FEW: a bar's denominator is under
 * its minimum. CELL_PARTIAL (exit 4): a fallback call failed; rerun.
 *
 * sensitivity (stage 5, in custody: GBRAIN_EVALS_CUSTODY_LOG and sources outside the repository, cell.ts custodyGate)
 * has the fallback grade every counted Opus and Sol answer of the counted cells in the seeded sample: the 30% of the
 * set's conversations (23 of 75) with the smallest sha256("rs1-sensitivity", NUL, conversation id). Its records go
 * beside each cell's own, in cells/<arm cell id>/sensitivity-judgments.ndjson, under instrument id
 * <instrument>@gemini:gemini-3.8-flash. stdout carries counts and hashes only.
 *
 * Model clients sit behind memory-qa's ChatLike, so tests inject fakes. --fake's stand-in carries its own id
 * (fake-gemini:gemini-3.8-flash), so its records never answer a --paid run.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { BudgetExceededError, budgetOptionsFrom, chatPrice, startPaidRun } from '../budget-ledger.ts';
import { loadCorpus, RS1_CONVERSATIONS, type Corpus, type MemoryQuestion } from '../memory-qa/corpus.ts';
import { BEAM_EQUIVALENCE_SYSTEM, beamRubricPrompt, instrumentFor, PASS_THRESHOLD, type Instrument } from '../memory-qa/instruments.ts';
import { judgeAnswer, type ChatLike, type ChatOptions, type ChatResultV2 } from '../memory-qa/qa-v2.ts';
import { judgmentKey, readRecords, RecordLog, type AnswerRecord, type JudgmentRecord } from '../memory-qa/records.ts';
import { PaidArmRefusal, requirePaidArm } from '../paid-arm.ts';
import { encodingCount } from '../systems/render-v2.ts';
import { custodyGate, devOnly, JUDGED, needsCustody } from '../q1/cell.ts';
import type { ArmDefinition, CellDefinition } from '../q1/cells/definitions.ts';
import { finalSpanV3, hedgeClassifier, parseCsv, toCsv } from '../q1/hedge.ts';
import { modelFamily, scoringJudges, type JudgingPlan, type PlannedJudge } from '../q1/cells/judging.ts';
import { rereadCellId } from '../q1/reread-cell.ts';
import { exitCodeOf, refuse, renderMessage, ScoreboardError, type ScoreboardMessage } from '../q1/scoreboard-errors.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const FRONT = ['bun', 'eval/runner/rs1/judge.ts'];
export const CHECK_SCHEMA = 'gbrain-evals/rs1-judge-check/v1';
export const LABELS_SCHEMA = 'gbrain-evals/rs1-judge-labels/v1';
export const RS1_MANIFEST_PATH = resolve(import.meta.dir, '../q1/cells/rs1-cells.json');
export const STAGE1_BLOCK = 'RS1-dry';
export const COUNTED_SET = 'RS1';
export const COUNTED_JUDGES = ['openai:gpt-4.1-mini', 'anthropic:claude-haiku-5-5'] as const;
export const FALLBACK_JUDGE = 'gemini:gemini-3.8-flash';
export const FAKE_FALLBACK_JUDGE = 'fake-gemini:gemini-3.8-flash';
export const PARTICLE = 'particle:particle-1';
export const SENSITIVITY_READERS = ['anthropic:claude-opus-5-5', 'openai:gpt-6.1-sol'] as const;
export const SENSITIVITY_SEED = 'rs1-sensitivity';
export const SENSITIVITY_SHARE = 0.3;
export const LABEL_SEED = 'rs1-judge-check';
export const SHORT_SAMPLE = 100;
/** The hedge classifier that flags candidate abstentions; it never sets a key. */
export const PREFILTER = 'hedge-v3';
/** Abilities whose reference can be a short fact; the others' references describe behaviour, an order or a summary. */
export const KEYED_ABILITIES = ['information_extraction', 'knowledge_update', 'temporal_reasoning', 'multi_session_reasoning', 'contradiction_resolution'];
export const BARS = { agreement: 0.9, agreement_min: 300, key: 0.95, key_min: 100, key_max_error: 0.02, key_validation_min: 50 };
/** Room for gemini-3.8-flash's thinking, which bills as output, above the instrument's own output limits. */
export const GEMINI_OUTPUT_FLOOR = 2048;
export const PREREG_BRANCH = "GBEV-3's next step: the preregistration's branch applies, gemini:gemini-3.8-flash judges every row, recorded in the preregistration before minting. This script never switches judges.";

const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

// ─── the key: dates, numbers and short names ─────────────────────────

export type KeyVerdict = 'correct' | 'wrong' | 'unkeyed';
interface DateParts { y?: number; m?: number; d?: number }
interface NumberRef { value: string; unit: string | null }
export type Reference = { type: 'date'; date: DateParts; surface: string } | { type: 'number'; number: NumberRef; surface: string } | { type: 'name'; words: string[]; surface: string };
interface Hit<T> { start: number; end: number; v: T }

/** Lower case, straight quotes, no diacritics; lengths stay aligned between the cased and lowered forms. */
const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"');
const wordsOf = (s: string) => fold(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const blank = (s: string, spans: Array<{ start: number; end: number }>) => { let out = s; for (const x of spans) out = out.slice(0, x.start) + ' '.repeat(x.end - x.start) + out.slice(x.end); return out; };

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const monthOf = (s: string) => MONTHS.findIndex(m => m.startsWith(s.slice(0, 3))) + 1;
const year = (s: string) => s.length === 2 ? 2000 + Number(s) : Number(s);
const DATE_PATTERNS: Array<[RegExp, (m: RegExpExecArray) => DateParts]> = [
  [/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, m => ({ y: +m[1], m: +m[2], d: +m[3] })],
  [/\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/g, m => ({ y: year(m[3]), m: +m[1], d: +m[2] })],
  [new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?`, 'g'), m => ({ y: m[3] ? +m[3] : undefined, m: monthOf(m[1]), d: +m[2] })],
  [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b\\.?(?:,?\\s+(\\d{4})\\b)?`, 'g'), m => ({ y: m[3] ? +m[3] : undefined, m: monthOf(m[2]), d: +m[1] })],
  [new RegExp(`\\b${MONTH}\\.?,?\\s+(\\d{4})\\b`, 'g'), m => ({ y: +m[2], m: monthOf(m[1]) })],
];

/** Every date in a text, longest first where two overlap. */
export function datesIn(text: string): Array<Hit<DateParts>> {
  const t = fold(text).toLowerCase();
  const all: Array<Hit<DateParts>> = [];
  for (const [re, parts] of DATE_PATTERNS) for (const m of t.matchAll(re)) {
    const v = parts(m as RegExpExecArray);
    if ((v.m !== undefined && (v.m < 1 || v.m > 12)) || (v.d !== undefined && (v.d < 1 || v.d > 31))) continue;
    all.push({ start: m.index!, end: m.index! + m[0].length, v });
  }
  all.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out: Array<Hit<DateParts>> = [];
  for (const h of all) if (!out.some(o => h.start < o.end && h.end > o.start)) out.push(h);
  return out;
}

const DATE_FIELDS = ['y', 'm', 'd'] as const;
/** A candidate matches a reference date when it states every field the reference states, equal. */
const dateMatches = (ref: DateParts, c: DateParts) => DATE_FIELDS.every(f => ref[f] === undefined || c[f] === ref[f]);
/** No field both state disagrees. */
const dateCompatible = (ref: DateParts, c: DateParts) => DATE_FIELDS.every(f => ref[f] === undefined || c[f] === undefined || c[f] === ref[f]);

const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const NUMBER_RE = new RegExp(`(?<![\\w.,])([$€£])?(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d+))?(?:\\s?(%|percent\\b|k\\b|thousand\\b|million\\b|billion\\b))?|\\b(${TENS.slice(2).join('|')})(?:[- ](${SMALL.slice(1, 10).join('|')}))?\\b|\\b(${SMALL.filter(w => w !== 'one').join('|')})\\b`, 'g');
const MULTIPLIER: Record<string, number> = { k: 1e3, thousand: 1e3, million: 1e6, billion: 1e9 };
const singular = (w: string) => w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w;
/** Unit words that make two equal values different answers: "3 weeks" does not answer "3 days". */
const UNITS = new Set(['second', 'minute', 'hour', 'day', 'week', 'month', 'year', 'time', 'mile', 'kilometer', 'meter', 'foot', 'pound', 'kilogram', 'dollar', 'euro', 'percent']);

/**
 * Every number in a text with its canonical value ("1500", "20%") and the word after it as its unit. Dates and list
 * markers are blanked first, so a day of the month or "1." is not a number. "one" is never a candidate: it is too
 * often a pronoun ("the one you mentioned").
 */
export function numbersIn(text: string, opts: { inDates?: boolean } = {}): Array<Hit<NumberRef>> {
  let t = fold(text).toLowerCase();
  if (!opts.inDates) t = blank(t, datesIn(text));
  t = t.replace(/^(\s*)(\d+)([.)])(?=\s)/gm, (_m, a: string, n: string, p: string) => a + ' '.repeat(n.length) + p);
  const out: Array<Hit<NumberRef>> = [];
  for (const m of t.matchAll(NUMBER_RE)) {
    let value: number;
    let percent = false;
    if (m[2] !== undefined) {
      value = Number(m[2].replace(/,/g, '') + (m[3] ? '.' + m[3] : ''));
      const suffix = m[4];
      if (suffix === '%' || suffix === 'percent') percent = true; else if (suffix) value *= MULTIPLIER[suffix];
    } else if (m[5] !== undefined) value = TENS.indexOf(m[5]) * 10 + (m[6] ? SMALL.indexOf(m[6]) : 0);
    else value = SMALL.indexOf(m[7]);
    const end = m.index! + m[0].length;
    const unit = percent ? null : (/^\s+([a-z]+)/.exec(t.slice(end))?.[1] ?? null);
    out.push({ start: m.index!, end, v: { value: `${Number(value.toPrecision(12))}${percent ? '%' : ''}`, unit: unit ? singular(unit) : null } });
  }
  return out;
}

const HONORIFIC = new Set(['dr', 'mr', 'mrs', 'ms', 'miss', 'prof', 'professor', 'sir', 'the']);
const CONNECTOR = new Set(['of', 'de', 'da', 'van', 'von', 'der', 'del', 'la', 'le', 'du', 'bin', 'al']);
const NOT_NAMES = new Set(['i', "i'm", "i've", "i'd", "i'll", 'the', 'this', 'that', 'these', 'those', 'based', 'according', 'yes', 'no', 'none', 'true', 'false', 'however', 'so', 'also', 'in', 'on', 'at', 'it', 'its', "it's", 'you', 'your', "you're", 'we', 'our', 'they', 'their', 'he', 'she', 'his', 'her', 'my', 'if', 'when', 'as', 'for', 'from', 'to', 'and', 'but', 'or', 'note', 'answer', 'final', 'sure', 'here', 'there', 'what', 'which', 'who', 'okay', 'ok', 'great', 'hi', 'hello', 'a', 'an', 'unfortunately', 'since', 'after', 'before', 'during', 'today', 'yesterday', 'tomorrow', 'there', 'then', 'now', 'both', 'each', 'all', 'some', 'any', 'not', 'is', 'was', 'are', 'were', 'do', 'does', 'did', 'dr', 'mr', 'mrs', 'ms', 'miss', 'prof', 'professor', 'sir', ...MONTHS, ...WEEKDAYS]);
const NAME_RE = /\p{Lu}[\p{L}'-]*(?:\s+(?:(?:of|de|da|van|von|der|del|la|le|du|bin|al)\s+)?\p{Lu}[\p{L}'-]*){0,3}/gu;

/** Capitalized word runs that could be a name: not a lone sentence-initial word, not a stop word. */
export function namesIn(text: string): Array<Hit<string[]>> {
  const t = fold(text);
  const out: Array<Hit<string[]>> = [];
  for (const m of t.matchAll(NAME_RE)) {
    const words = m[0].toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const content = words.filter(w => !CONNECTOR.has(w) && !NOT_NAMES.has(w));
    if (!content.length) continue;
    const before = t.slice(0, m.index!);
    const initial = /(^|[.!?:]\s+|\n\s*(?:[-*+]\s+|\d+[.)]\s+)?|\*\*)$/.test(before);
    if (initial && words.length === 1) continue;
    out.push({ start: m.index!, end: m.index! + m[0].length, v: content });
  }
  return out;
}

/** An item's reference as a keyable type, or null: a date, a number with at most two unit words, or a name of at most four words. */
export function referenceOf(q: Pick<MemoryQuestion, 'category' | 'abstention' | 'answer'>): Reference | null {
  if (q.abstention || !KEYED_ABILITIES.includes(q.category) || !q.answer) return null;
  const surface = fold(q.answer).trim().replace(/[.!]+$/, '').replace(/^(?:on|in|by|about|approximately|around)\s+/i, '');
  if (!surface || surface.length > 80) return null;
  const lower = surface.toLowerCase();
  const dates = datesIn(surface);
  if (dates.length === 1 && dates[0].start === 0 && dates[0].end === lower.length) return { type: 'date', date: dates[0].v, surface: lower };
  const nums = numbersIn(surface);
  if (nums.length === 1 && nums[0].start === 0 && /^(\s+[a-z]+){0,2}$/.test(lower.slice(nums[0].end))) {
    const unitWords = lower.slice(nums[0].end).trim();
    return { type: 'number', number: { value: nums[0].v.value, unit: unitWords ? nums[0].v.unit : null }, surface: lower };
  }
  if (/[\d]/.test(surface) || !/^[\p{L}'. -]+$/u.test(surface)) return null;
  const raw = surface.split(/\s+/).map(w => w.replace(/\.$/, ''));
  while (raw.length && HONORIFIC.has(raw[0].toLowerCase())) raw.shift();
  if (!raw.length || raw.length > 4) return null;
  if (!raw.every((w, i) => /^\p{Lu}/u.test(w) || (i > 0 && CONNECTOR.has(w.toLowerCase())))) return null;
  const words = raw.flatMap(w => w.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  if (!words.length || (words.length === 1 && NOT_NAMES.has(words[0]))) return null;
  return { type: 'name', words, surface: lower };
}

const NEGATION = /\b(?:not|never|no|isn't|wasn't|aren't|weren't|didn't|doesn't|don't|won't|cannot|can't|neither|nor)\b|n't\b/;
/** A hit is negated when its own clause, up to 40 characters back, carries a negation cue ("it was not March 3"). */
function negated(text: string, start: number): boolean {
  const before = fold(text).toLowerCase().slice(Math.max(0, start - 40), start);
  const clause = before.split(/[,.;:!?\n]|\bbut\b/).pop() ?? '';
  return NEGATION.test(clause);
}

function nameHits(text: string, words: string[]): Array<{ start: number; end: number }> {
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${words.join('[^\\p{L}\\p{N}]+')}(?![\\p{L}\\p{N}])`, 'gu');
  return [...fold(text).toLowerCase().matchAll(re)].map(m => ({ start: m.index!, end: m.index! + m[0].length }));
}

/**
 * The key's verdict on one answer to a keyed short-answer item: correct when the final-answer span states the
 * reference, not negated, and no other candidate of its type; wrong when nothing in the whole answer is compatible with
 * the reference; unkeyed otherwise.
 */
export function keyShort(ref: Reference, text: string): KeyVerdict {
  const span = finalSpanV3(text).text;
  const lower = fold(text).toLowerCase();
  if (ref.type === 'date') {
    const inSpan = datesIn(span);
    const hits = inSpan.filter(c => dateMatches(ref.date, c.v)), others = inSpan.filter(c => !dateMatches(ref.date, c.v));
    if (hits.length && !others.length && !hits.some(h => negated(span, h.start))) return 'correct';
    return datesIn(text).some(c => dateCompatible(ref.date, c.v)) || lower.includes(ref.surface) ? 'unkeyed' : 'wrong';
  }
  if (ref.type === 'number') {
    const same = (c: NumberRef) => c.value === ref.number.value && (!ref.number.unit || c.unit === ref.number.unit);
    const inSpan = numbersIn(span);
    const hits = inSpan.filter(c => same(c.v)), others = inSpan.filter(c => !same(c.v));
    if (hits.length && !others.length && !hits.some(h => negated(span, h.start))) return 'correct';
    const compatible = (c: NumberRef) => c.value === ref.number.value && !(ref.number.unit && c.unit && UNITS.has(c.unit) && c.unit !== ref.number.unit);
    return numbersIn(text, { inDates: true }).some(c => compatible(c.v)) || lower.includes(ref.surface) ? 'unkeyed' : 'wrong';
  }
  const refWords = new Set(ref.words);
  const hits = nameHits(span, ref.words);
  const others = namesIn(span).filter(c => !c.v.every(w => refWords.has(w)) && !nameHits(c.v.join(' '), ref.words).length);
  if (hits.length && !others.length && !hits.some(h => negated(span, h.start))) return 'correct';
  const textWords = new Set(wordsOf(text));
  return ref.words.some(w => w.length > 1 && !CONNECTOR.has(w) && textWords.has(w)) ? 'unkeyed' : 'wrong';
}

// ─── manifest, sources and rows ──────────────────────────────────────

type JudgedArm = ArmDefinition & { judging?: JudgingPlan };
export interface Rs1CellManifest { cells: CellDefinition[]; smoke_cells?: CellDefinition[]; addon_cells?: CellDefinition[] }
export interface Row { answer: AnswerRecord; question: MemoryQuestion; def: CellDefinition; arm: JudgedArm; instrument: Instrument; planned: PlannedJudge[]; dir: string; judgments: Map<string, JudgmentRecord> }

const allCells = (m: Rs1CellManifest) => [...m.cells, ...(m.smoke_cells ?? []), ...(m.addon_cells ?? [])];
export const stage1Cells = (m: Rs1CellManifest) => allCells(m).filter(c => (c.block as string) === STAGE1_BLOCK);
export const countedCells = (m: Rs1CellManifest) => m.cells.filter(c => (c.set as string) === COUNTED_SET);
const scoreKey = (answerId: string, instrumentId: string, judge: string) => `${answerId}|${instrumentId}|${judge}`;

/** The family rule and the judge list, per arm: a refusal names the arm, never a row. */
export function planProblems(def: CellDefinition, arm: JudgedArm): string[] {
  if (!arm.judging) return [`${def.id} arm ${arm.id} has no judging plan (judging.by_reader)`];
  const plan = arm.judging.by_reader;
  return [...arm.readers.filter(r => !plan[r]).map(r => `${def.id} arm ${arm.id} plans no judge for ${r}`), ...Object.entries(plan).flatMap(([reader, judges]) => [
    ...(judges.length ? [] : [`${def.id} arm ${arm.id} plans no judge for ${reader}`]),
    ...judges.filter(j => !(COUNTED_JUDGES as readonly string[]).includes(j)).map(j => `${def.id} arm ${arm.id} plans ${j}, not a counted judge, for ${reader}`),
    ...judges.filter(j => modelFamily(j) === modelFamily(reader)).map(j => `${def.id} arm ${arm.id} plans ${j} for ${reader}, a reader of its own family`),
  ])];
}

/** The answers and judgments of each arm (and its particle-1 re-read) across the sources; one source per cell. */
export function collectRows(defs: CellDefinition[], sources: string[], corpus: Corpus, readers?: readonly string[]): Row[] {
  const problems = defs.flatMap(def => (def.arms as JudgedArm[]).flatMap(arm => planProblems(def, arm)));
  if (problems.length) throw refuse({ code: 'CAMPAIGN_INVALID', message: `the RS1 manifest's judging plans break the judge rules: ${problems.join('; ')}`,
    why: 'every RS1 answer is scored by its reader\'s planned counted judges (gpt-4.1-mini, claude-haiku-5-5), and no judge grades its own family\'s rows (GST-767)', fix: { next: 'run', argv: ['bun', 'eval/runner/q1/cells/rs1.ts'], user_message: 'regenerate rs1-cells.json from rs1.ts' } });
  const questions = new Map(corpus.questions.map(q => [q.id, q]));
  const rows: Row[] = [];
  for (const def of defs) {
    const instrument = instrumentFor(def.canonical_instrument);
    for (const arm of def.arms as JudgedArm[]) for (const cellId of [arm.cell_id, rereadCellId(arm.cell_id, PARTICLE)]) {
      const dirs = sources.map(s => join(resolve(s), 'cells', cellId)).filter(d => existsSync(join(d, 'answers.ndjson')));
      if (dirs.length > 1) throw refuse({ code: 'USAGE', message: `${dirs.length} sources publish cell ${cellId}`, why: 'each cell is read from one published copy (merge shards first with cell.ts merge)', fix: { next: 'run', argv: ['bun', 'eval/runner/q1/cell.ts', 'merge', '--cell', def.id, '--from', '<out dir>...', '--out', '<dir>'] } });
      if (!dirs.length) continue;
      const judgments = new Map(readRecords(join(dirs[0], 'judgments.ndjson'), 'judgment').filter(j => j.judge_replicate === 0).map(j => [scoreKey(j.answer_id, j.instrument_id, j.judge), j]));
      for (const answer of readRecords(join(dirs[0], 'answers.ndjson'), 'answer')) {
        if (answer.replicate !== 0 || !JUDGED.has(answer.outcome) || (readers && !readers.includes(answer.reader))) continue;
        const question = questions.get(answer.question_id);
        if (!question) throw refuse({ code: 'INPUT_MISSING', message: `an answer in ${cellId} names a question the ${def.benchmark} corpus does not hold`, why: 'every answer is keyed and judged against its own question and reference', fix: { next: 'report' } });
        rows.push({ answer, question, def, arm, instrument, planned: scoringJudges(arm, answer.reader, instrument), dir: dirs[0], judgments });
      }
    }
  }
  return rows;
}

/** A judge's replicate-0 record for a row under the instrument id it writes, from the cells or the fallback's log. */
const recordOf = (row: Row, p: PlannedJudge, extra?: Map<string, JudgmentRecord>) => row.judgments.get(scoreKey(row.answer.answer_id, p.instrument_id, p.judge)) ?? extra?.get(scoreKey(row.answer.answer_id, p.instrument_id, p.judge));
const passes = (j: JudgmentRecord | undefined) => j && j.outcome === 'scored' && typeof j.score === 'number' ? j.score >= PASS_THRESHOLD : null;

// ─── the label sheet ─────────────────────────────────────────────────

export const SHEET_HEADER = ['answer_id', 'task', 'question', 'reference', 'answer', 'label', 'note'];
export const LABELS: Record<'abstention' | 'short', readonly string[]> = { abstention: ['abstained', 'answered'], short: ['correct', 'incorrect'] };
export interface SheetLabel { answer_id: string; task: 'abstention' | 'short'; label: string | null }
const rank = (seed: string, id: string) => sha256(`${seed}\u0000${id}`);

/** The sheet's rows: every abstention answer, and a seeded sample of decisive short-key answers. */
export function sheetRows(rows: Row[], seed = LABEL_SEED) {
  const abstention = rows.filter(r => r.question.abstention);
  const short = rows.filter(r => { const ref = referenceOf(r.question); return ref && keyShort(ref, r.answer.text) !== 'unkeyed'; })
    .sort((a, b) => (rank(`${seed}|short`, a.answer.answer_id) < rank(`${seed}|short`, b.answer.answer_id) ? -1 : 1));
  const sample = short.slice(0, SHORT_SAMPLE);
  const out = [...abstention.map(r => ({ row: r, task: 'abstention' as const })), ...sample.map(r => ({ row: r, task: 'short' as const }))]
    .sort((a, b) => (rank(seed, a.row.answer.answer_id) < rank(seed, b.row.answer.answer_id) ? -1 : 1));
  return { out, abstention: abstention.length, short_population: short.length, short: sample.length };
}

export function writeSheet(rows: Row[], path: string, seed = LABEL_SEED) {
  const s = sheetRows(rows, seed);
  const prefilter = hedgeClassifier(PREFILTER);
  const text = toCsv(SHEET_HEADER, s.out.map(({ row, task }) => ({ answer_id: row.answer.answer_id, task, question: row.question.question, reference: task === 'short' ? row.question.answer ?? '' : '', answer: row.answer.text, label: '', note: '' })));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  const design = {
    schema: LABELS_SCHEMA, seed, sheet_sha256: sha256(text), rows: s.out.length, abstention: s.abstention, short: s.short, short_population: s.short_population, short_sample: SHORT_SAMPLE,
    answers_sha256: sha256(rows.map(r => r.answer.answer_id).sort().join('\n')),
    prefilter: { classifier_version: prefilter.version, rules_sha256: prefilter.rules_sha256, verdicts: Object.fromEntries(s.out.filter(x => x.task === 'abstention').map(({ row }) => [row.answer.answer_id, prefilter.classify(row.answer.text)])) },
  };
  writeFileSync(`${path}.design.json`, JSON.stringify(design, null, 2) + '\n');
  return design;
}

/** A filled sheet's labels; refuses an unknown task, a label outside its task's two, or a repeated answer. */
export function readSheet(path: string): { labels: Map<string, SheetLabel>; sha256: string } {
  if (!existsSync(path)) throw refuse({ code: 'INPUT_MISSING', message: `no label sheet at ${path}`, why: 'the abstention key and the key\'s validation come from the hand-labeled sheet', fix: { next: 'run', argv: [...FRONT, 'label', '--source', '<stage 1 out>', '--out', path] } });
  const text = readFileSync(path, 'utf8');
  const labels = new Map<string, SheetLabel>();
  const bad: string[] = [];
  for (const r of parseCsv(text)) {
    const task = r.task as SheetLabel['task'];
    const label = (r.label ?? '').trim().toLowerCase();
    if (!LABELS[task]) { bad.push(`row ${r.answer_id}: task ${JSON.stringify(r.task)}`); continue; }
    if (label && !LABELS[task].includes(label)) bad.push(`row ${r.answer_id}: label ${JSON.stringify(r.label)} is not ${LABELS[task].join(' or ')}`);
    if (labels.has(r.answer_id)) bad.push(`row ${r.answer_id} appears twice`);
    labels.set(r.answer_id, { answer_id: r.answer_id, task, label: label || null });
  }
  if (bad.length) throw refuse({ code: 'USAGE', message: `the label sheet ${path} has ${bad.length} bad row(s): ${bad.slice(0, 5).join('; ')}`, why: 'an abstention row is marked abstained or answered, a short row correct or incorrect', fix: { next: 'tell_user_to_run', argv: [...FRONT, 'label', '--read', path], user_message: 'fix the label column and read the sheet back' } });
  return { labels, sha256: sha256(text) };
}

// ─── clients ─────────────────────────────────────────────────────────

export class JudgeCallError extends Error {}

/** gemini-3.8-flash generateContent behind ChatLike. A provider error names only the host and status: an error body could echo the prompt. */
export function geminiJudgeClient(apiKey: string): ChatLike {
  return {
    async chat(model: string, prompt: string, opts: ChatOptions): Promise<ChatResultV2> {
      if (model !== FALLBACK_JUDGE) throw new JudgeCallError(`the gemini client judges only as ${FALLBACK_JUDGE}`);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model.slice(model.indexOf(':') + 1)}:generateContent`;
      const body = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }], ...(opts.system !== undefined ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
        generationConfig: { maxOutputTokens: Math.max(opts.maxTokens, GEMINI_OUTPUT_FLOOR), ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}) },
      };
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body) });
      if (!res.ok) throw new JudgeCallError(`${new URL(url).hostname} answered HTTP ${res.status}`);
      const reply = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>; usageMetadata?: Record<string, number>; modelVersion?: string };
      const c = reply.candidates?.[0];
      const u = reply.usageMetadata ?? {};
      return { text: (c?.content?.parts ?? []).filter(p => !p.thought).map(p => p.text ?? '').join(''), input_tokens: u.promptTokenCount ?? 0, output_tokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
        cached: false, finish: c?.finishReason ?? null, usage: u, response_model: reply.modelVersion ?? null, attempt_errors: [] };
    },
  };
}

/** Keyless stand-in: a rubric item scores 1 when the response contains it, and two snippets are equivalent when equal. */
export function fakeJudgeClient(): ChatLike {
  const between = (s: string, a: string, b: string) => { const i = s.indexOf(a); if (i < 0) return ''; const j = s.indexOf(b, i + a.length); return s.slice(i + a.length, j < 0 ? undefined : j); };
  const norm = (s: string) => wordsOf(s).join(' ');
  return {
    async chat(model: string, prompt: string, opts: ChatOptions): Promise<ChatResultV2> {
      const text = opts.system !== undefined
        ? (norm(between(prompt, 'First snippet: ', 'Second snippet: ')) === norm(between(prompt, 'Second snippet: ', '\n')) ? 'YES' : 'NO')
        : JSON.stringify({ score: norm(between(prompt, '- RESPONSE TO EVALUATE: ', '\n\n## EVALUATION RUBRIC')).includes(norm(between(prompt, '- RUBRIC CRITERION (what to check): ', '\n- RESPONSE TO EVALUATE: '))) ? 1 : 0 });
      return { text, input_tokens: 0, output_tokens: 0, cached: false, finish: 'stop', usage: null, response_model: model, attempt_errors: [] };
    },
  };
}

/** Worst-case dollars for the fallback to grade these rows: every call at its full output allowance. */
export function fallbackEstimateUsd(rows: Row[]): number {
  const p = chatPrice(FALLBACK_JUDGE);
  if (!p) throw refuse({ code: 'MODEL_UNPRICED', message: `the budget ledger has no price for ${FALLBACK_JUDGE}`, why: 'every paid request is reserved at its price before it is sent', fix: { next: 'report' } });
  const call = (input: number, output: number) => (input * p.input + Math.max(output, GEMINI_OUTPUT_FLOOR) * p.output) / 1e6;
  return rows.reduce((s, r) => {
    const rubric = r.question.rubric?.length ? r.question.rubric : [r.question.answer ?? ''];
    let usd = rubric.reduce((t, item) => t + call(encodingCount('cl100k_base', beamRubricPrompt(item, r.answer.text)) + 16, 1024), 0);
    if (r.question.category === 'event_ordering') {
      const lines = r.answer.text.split('\n');
      for (const line of lines) for (const item of rubric) usd += call(encodingCount('cl100k_base', BEAM_EQUIVALENCE_SYSTEM + item + line) + 48, 10);
    }
    return s + usd;
  }, 0);
}

// ─── fallback judging ────────────────────────────────────────────────

export interface FallbackRun { judged: number; reused: number; judge_errors: number; call_errors: number; skipped_family: number }

/**
 * The fallback grades each row it has no record for, under <instrument>@<judge>, appending to the log beside each row
 * (logFor). A call that throws leaves the row ungraded for a rerun; a budget refusal stops every worker and propagates.
 */
export async function runFallback(rows: Row[], judge: string, client: ChatLike, logFor: (row: Row) => RecordLog<'judgment'>, concurrency: number): Promise<FallbackRun> {
  const run: FallbackRun = { judged: 0, reused: 0, judge_errors: 0, call_errors: 0, skipped_family: 0 };
  const pending: Row[] = [];
  for (const row of rows) {
    if (modelFamily(row.answer.reader) === modelFamily(judge.replace(/^fake-/, ''))) { run.skipped_family++; continue; }
    const p = { judge, instrument_id: `${row.instrument.id}@${judge}` };
    const key = judgmentKey({ answer_id: row.answer.answer_id, instrument_sha256: row.instrument.sha256, judge, judge_replicate: 0 });
    if (recordOf(row, p) || logFor(row).has(key)) run.reused++; else pending.push(row);
  }
  let next = 0, stopped = false;
  const worker = async () => {
    while (!stopped && next < pending.length) {
      const row = pending[next++];
      let rec: Omit<JudgmentRecord, 'answer_id'>;
      try { rec = await judgeAnswer(client, row.instrument, row.question, row.answer.text, { judge, judgeReplicate: 0 }); } catch (error) {
        if (error instanceof BudgetExceededError) { stopped = true; throw error; }
        run.call_errors++;
        continue;
      }
      logFor(row).append({ answer_id: row.answer.answer_id, ...rec, instrument_id: `${row.instrument.id}@${judge}` });
      if (rec.outcome === 'judge_error') run.judge_errors++; else run.judged++;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.floor(concurrency)) }, worker));
  return run;
}

// ─── check ───────────────────────────────────────────────────────────

export interface Bar { bar: string; count: number; denominator: number; share: number | null; threshold: number; min: number; status: 'pass' | 'fail' | 'too_few' | 'not_applied' }

/** count / denominator against a share threshold, in whole hundredths so exactly 90% is 90%. */
export function barOf(bar: string, count: number, denominator: number, threshold: number, min: number, applies = true): Bar {
  const status = !applies ? 'not_applied' : denominator < min ? 'too_few' : count * 100 >= Math.round(threshold * 100) * denominator ? 'pass' : 'fail';
  return { bar, count, denominator, share: denominator ? r4(count / denominator) : null, threshold, min, status };
}

export interface CheckDeps { corpus?: Corpus; client?: ChatLike; env?: Record<string, string | undefined>; log?: (s: string) => void; error?: (s: string) => void }
export interface CheckOptions { manifest: string; sources: string[]; labels: string; out: string; fake: boolean; concurrency: number; argv: string[] }

/** The stage 1 judge check: fallback judging where needed, then bars a to d; writes judge-check.json and returns it. */
export async function runCheck(o: CheckOptions, deps: CheckDeps = {}) {
  const log = deps.log ?? ((s: string) => console.log(s));
  const manifest = readManifest(o.manifest);
  const defs = stage1Cells(manifest);
  if (!defs.length) throw refuse({ code: 'CAMPAIGN_INVALID', message: `${o.manifest} has no stage 1 cells (block ${STAGE1_BLOCK})`, why: 'the judge check reads stage 1\'s answers', fix: { next: 'run', argv: ['bun', 'eval/runner/q1/cells/rs1.ts'] } });
  const corpus = deps.corpus ?? stage1Corpus(defs);
  const rows = collectRows(defs, o.sources, corpus);
  const { labels, sha256: labelsSha } = readSheet(o.labels);
  const byId = new Map(rows.map(r => [r.answer.answer_id, r]));
  const stale = [...labels.keys()].filter(id => !byId.has(id));
  if (stale.length) throw refuse({ code: 'USAGE', message: `the label sheet names ${stale.length} answer(s) that are not stage 1 answers in these sources`, why: 'the sheet was drawn from other cell outputs', fix: { next: 'run', argv: [...FRONT, 'label', '--source', '<stage 1 out>...', '--out', '<sheet.csv>'] } });

  const key = new Map<string, KeyVerdict | 'unlabeled'>();
  for (const r of rows) {
    if (r.question.abstention) { const l = labels.get(r.answer.answer_id); key.set(r.answer.answer_id, l?.label === 'abstained' ? 'correct' : l?.label === 'answered' ? 'wrong' : 'unlabeled'); continue; }
    const ref = referenceOf(r.question);
    if (ref) key.set(r.answer.answer_id, keyShort(ref, r.answer.text));
  }
  const decisive = (r: Row) => { const k = key.get(r.answer.answer_id); return k === 'correct' || k === 'wrong'; };
  const both = rows.filter(r => COUNTED_JUDGES.every(j => r.planned.some(p => p.judge === j)));

  const judge = o.fake ? FAKE_FALLBACK_JUDGE : FALLBACK_JUDGE;
  const needed = rows.filter(r => decisive(r) || both.includes(r));
  const out = resolve(o.out);
  mkdirSync(out, { recursive: true });
  const fallbackLog = new RecordLog(join(out, 'fallback-judgments.ndjson'), 'judgment');
  const runner = fallbackRunner(o.argv, o.fake, deps, 'rs1 judge check', 'rs1-judge-check');
  const run = await runner(needed, judge, () => fallbackLog, o.concurrency);
  const fallbackRecords = new Map(fallbackLog.all().map(j => [scoreKey(j.answer_id, j.instrument_id, j.judge), j]));
  const fb = (r: Row) => recordOf(r, { judge, instrument_id: `${r.instrument.id}@${judge}` }, fallbackRecords);
  const counted = (r: Row, j: string) => { const p = r.planned.find(x => x.judge === j); return p ? recordOf(r, p) : undefined; };

  const pairs = both.map(r => [passes(counted(r, COUNTED_JUDGES[0])), passes(counted(r, COUNTED_JUDGES[1]))] as const).filter(([a, b]) => a !== null && b !== null);
  const agreement = barOf('agreement', pairs.filter(([a, b]) => a === b).length, pairs.length, BARS.agreement, BARS.agreement_min);

  const labeledShort = rows.filter(r => labels.get(r.answer.answer_id)?.task === 'short' && labels.get(r.answer.answer_id)?.label && decisive(r));
  const keyErrors = labeledShort.filter(r => (key.get(r.answer.answer_id) === 'correct') !== (labels.get(r.answer.answer_id)!.label === 'correct'));
  const keyValidation = { bar: 'key_validation', errors: keyErrors.length, denominator: labeledShort.length, error_rate: labeledShort.length ? r4(keyErrors.length / labeledShort.length) : null, max_error: BARS.key_max_error, min: BARS.key_validation_min,
    status: labeledShort.length < BARS.key_validation_min ? 'too_few' as const : keyErrors.length * 100 <= Math.round(BARS.key_max_error * 100) * labeledShort.length ? 'pass' as const : 'fail' as const, mismatches: keyErrors.map(r => r.answer.answer_id) };
  const keyValid = keyValidation.status === 'pass';

  const keyBar = (j: string, rec: (r: Row) => JudgmentRecord | undefined, scope: Row[]) => {
    const scored = scope.filter(r => decisive(r) && passes(rec(r)) !== null);
    const matched = scored.filter(r => passes(rec(r)) === (key.get(r.answer.answer_id) === 'correct'));
    return { ...barOf(`key:${j}`, matched.length, scored.length, BARS.key, BARS.key_min, keyValid), mismatches: scored.filter(r => !matched.includes(r)).map(r => r.answer.answer_id) };
  };
  const keyBars = [
    ...COUNTED_JUDGES.map(j => keyBar(j, r => counted(r, j), rows.filter(r => r.planned.some(p => p.judge === j)))),
    keyBar(judge, fb, rows.filter(r => modelFamily(r.answer.reader) !== modelFamily(FALLBACK_JUDGE))),
  ];
  const fallbackAgreement = COUNTED_JUDGES.map(j => {
    const scope = rows.filter(r => r.planned.some(p => p.judge === j)).map(r => [passes(counted(r, j)), passes(fb(r))] as const).filter(([a, b]) => a !== null && b !== null);
    return { judge: j, against: judge, agree: scope.filter(([a, b]) => a === b).length, denominator: scope.length, share: scope.length ? r4(scope.filter(([a, b]) => a === b).length / scope.length) : null };
  });

  const prefilter = hedgeClassifier(PREFILTER);
  const abst = rows.filter(r => r.question.abstention);
  const labeledAbst = abst.filter(r => key.get(r.answer.answer_id) !== 'unlabeled');
  const flagged = labeledAbst.filter(r => prefilter.classify(r.answer.text) === 'abstain');
  const missingFallback = needed.filter(r => modelFamily(r.answer.reader) !== modelFamily(FALLBACK_JUDGE) && !fb(r)).length;
  const bars = [agreement, ...keyBars];
  const failed = bars.filter(b => b.status === 'fail');
  const status = missingFallback ? 'incomplete' : failed.length ? 'fail' : keyValidation.status === 'fail' ? 'key_invalid' : bars.some(b => b.status === 'too_few') || keyValidation.status === 'too_few' ? 'too_few' : 'pass';
  const count = (k: string) => [...key.values()].filter(v => v === k).length;
  const result = {
    schema: CHECK_SCHEMA, status, counted_judges: COUNTED_JUDGES, fallback_judge: judge, pass_threshold: PASS_THRESHOLD, thresholds: BARS,
    inputs: { manifest_sha256: sha256(readFileSync(o.manifest)), cells: defs.map(d => d.id), sources: o.sources.map(s => relative(ROOT, resolve(s)) || s), labels_sha256: labelsSha, answers_sha256: sha256(rows.map(r => r.answer.answer_id).sort().join('\n')) },
    counts: { answers: rows.length, by_reader: Object.fromEntries([...new Set(rows.map(r => r.answer.reader))].sort().map(rd => [rd, rows.filter(r => r.answer.reader === rd).length])),
      agreement_population: both.length, agreement_scored_pairs: pairs.length,
      key: { abstention_answers: abst.length, abstention_labeled: labeledAbst.length, abstention_unlabeled: count('unlabeled'), correct: count('correct'), wrong: count('wrong'), unkeyed: count('unkeyed') },
      fallback: { needed: needed.length, ...run, missing: missingFallback } },
    prefilter: { classifier_version: prefilter.version, rules_sha256: prefilter.rules_sha256, labeled: labeledAbst.length, flagged_abstain: flagged.length, flagged_and_labeled_abstained: flagged.filter(r => key.get(r.answer.answer_id) === 'correct').length, labeled_abstained: labeledAbst.filter(r => key.get(r.answer.answer_id) === 'correct').length },
    bars: { agreement, key_validation: keyValidation, key: keyBars, fallback_agreement: fallbackAgreement },
    failed: failed.map(b => b.bar), next: status === 'fail' ? PREREG_BRANCH : null,
  };
  const path = join(out, 'judge-check.json');
  const text = JSON.stringify(result, null, 2) + '\n';
  writeFileSync(path, text);
  log(`rs1-judge check status=${status} answers=${rows.length} agreement=${agreement.count}/${agreement.denominator} key_validation_errors=${keyValidation.errors}/${keyValidation.denominator} fallback_judged=${run.judged} fallback_reused=${run.reused} fallback_call_errors=${run.call_errors} result_sha256=${sha256(text)}`);
  for (const b of keyBars) log(`rs1-judge check ${b.bar} ${b.count}/${b.denominator} ${b.status}`);
  for (const a of fallbackAgreement) log(`rs1-judge check fallback_agreement:${a.judge} ${a.agree}/${a.denominator}`);
  return { result, path, text };
}

/** The refusal a finished check exits with, or null when every bar passes. */
export function checkRefusal(result: Awaited<ReturnType<typeof runCheck>>['result'], artifact: string): ScoreboardMessage | null {
  const bars = [result.bars.agreement, ...result.bars.key];
  const verify = [...FRONT, 'check', '--source', '<stage 1 out>...', '--labels', '<sheet.csv>', '--out', dirname(artifact)];
  if (result.status === 'incomplete') return { code: 'CELL_PARTIAL', partial: true, message: `${result.counts.fallback.missing} fallback judgment(s) are missing (${result.counts.fallback.call_errors} call error(s) this run)`,
    why: 'a bar is computed only on complete judging; recorded judgments are never bought again', fix: { next: 'run', argv: verify }, artifact };
  if (result.status === 'fail') {
    const failed = bars.filter(b => b.status === 'fail');
    return { code: 'RS1_JUDGE_CHECK_FAIL', message: `the stage 1 judge check fails: ${failed.map(b => `${b.bar} ${b.count} of ${b.denominator} (bar ${Math.round(b.threshold * 100)}%)`).join('; ')}`,
      why: 'the preregistration requires the two counted judges to agree on at least 90% of the particle-1 rows they both grade, and every judge and the fallback to match the validated key on at least 95% of keyed items, before minting',
      fix: { next: 'ask_user', user_message: PREREG_BRANCH, verify }, artifact, state: { failed: failed.map(b => ({ bar: b.bar, count: b.count, denominator: b.denominator, threshold: b.threshold })) } };
  }
  if (result.status === 'key_invalid') {
    const k = result.bars.key_validation;
    return { code: 'RS1_JUDGE_CHECK_KEY_INVALID', message: `the key disagrees with the hand labels on ${k.errors} of ${k.denominator} labeled short answers (at most ${Math.round(k.max_error * 100)}% allowed), so the key bars were not applied`,
      why: 'a key error must never send the program to the fallback-judge branch (review F6); the key, not a judge, failed', fix: { next: 'ask_user', user_message: 'bring the key validation to GBEV-3: the key rules or the labels need a fix before the judge check can apply; the fallback-judge branch does not apply', verify }, artifact, state: { mismatches: k.mismatches.length } };
  }
  if (result.status === 'too_few') {
    const few = [...bars.filter(b => b.status === 'too_few').map(b => `${b.bar} has ${b.denominator}, needs ${b.min}`), ...(result.bars.key_validation.status === 'too_few' ? [`key_validation has ${result.bars.key_validation.denominator} labeled short answers, needs ${result.bars.key_validation.min}`] : [])];
    return { code: 'RS1_JUDGE_CHECK_TOO_FEW', message: `too few answers for the judge check: ${few.join('; ')}`,
      why: 'a bar is decided only over its preregistered minimum; a smaller population cannot certify a judge', fix: { next: 'ask_user', user_message: 'bring the counts to GBEV-3: the particle-1 re-reads of stage 1\'s packed contexts (a paid window) grow the agreement population, and labeling more of the sheet grows the key validation', verify }, artifact };
  }
  return null;
}

// ─── sensitivity ─────────────────────────────────────────────────────

/** The seeded sample: the share of conversations with the smallest sha256("rs1-sensitivity", NUL, id), at least one. */
export function sensitivitySample(conversations: readonly string[], share = SENSITIVITY_SHARE): string[] {
  const k = Math.ceil(share * conversations.length);
  return [...new Set(conversations)].map(id => [sha256(`${SENSITIVITY_SEED}\u0000${id}`), id] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, k).map(([, id]) => id).sort();
}

export async function runSensitivity(o: { manifest: string; sources: string[]; fake: boolean; concurrency: number; argv: string[] }, deps: CheckDeps = {}) {
  const log = deps.log ?? ((s: string) => console.log(s));
  const env = deps.env ?? process.env;
  const defs = countedCells(readManifest(o.manifest));
  if (!defs.length) throw refuse({ code: 'CAMPAIGN_INVALID', message: `${o.manifest} has no counted cells (set ${COUNTED_SET})`, why: 'the sensitivity judge grades the counted cells\' answers', fix: { next: 'run', argv: ['bun', 'eval/runner/q1/cells/rs1.ts'] } });
  for (const def of defs) if (needsCustody(def)) for (const s of o.sources) custodyGate(def, resolve(s), env, 'rs1 judge sensitivity');
  const benchmarks = [...new Set(defs.map(d => d.benchmark))];
  if (benchmarks.length !== 1) throw refuse({ code: 'CAMPAIGN_INVALID', message: `the counted cells span ${benchmarks.length} benchmarks`, why: 'RS1\'s counted cells all read one set', fix: { next: 'report' } });
  const corpus = deps.corpus ?? loadCorpus(benchmarks[0]);
  const sample = sensitivitySample(RS1_CONVERSATIONS);
  const inSample = new Set(sample);
  const rows = collectRows(defs, o.sources, corpus, SENSITIVITY_READERS).filter(r => inSample.has(r.answer.conversation));
  const judge = o.fake ? FAKE_FALLBACK_JUDGE : FALLBACK_JUDGE;
  const logs = new Map<string, RecordLog<'judgment'>>();
  const logFor = (r: Row) => { let l = logs.get(r.dir); if (!l) { l = new RecordLog(join(r.dir, 'sensitivity-judgments.ndjson'), 'judgment'); logs.set(r.dir, l); } return l; };
  const runner = fallbackRunner(o.argv, o.fake, deps, 'rs1 judge sensitivity', 'rs1-judge-sensitivity');
  const run = await runner(rows, judge, logFor, o.concurrency);
  log(`rs1-judge sensitivity conversations=${RS1_CONVERSATIONS.length} sample=${sample.length} sample_sha256=${sha256(sample.join('\n'))} answers=${rows.length} judged=${run.judged} reused=${run.reused} judge_errors=${run.judge_errors} call_errors=${run.call_errors}`);
  for (const [dir, l] of [...logs.entries()].sort()) log(`rs1-judge sensitivity cell_sha256=${sha256(relative(resolve(dir, '..', '..'), dir)).slice(0, 16)} records=${l.size} file_sha256=${sha256(readFileSync(l.path))}`);
  return { sample, rows: rows.length, run };
}

// ─── wiring ──────────────────────────────────────────────────────────

export function readManifest(path: string): Rs1CellManifest {
  if (!existsSync(path)) throw refuse({ code: 'INPUT_MISSING', message: `no RS1 cell manifest at ${path}`, why: 'the judge script reads the cells and their judging plans from the manifest', fix: { next: 'run', argv: ['bun', 'eval/runner/q1/cells/rs1.ts'] } });
  return JSON.parse(readFileSync(path, 'utf8')) as Rs1CellManifest;
}

/** Stage 1's public questions: the dev split of the stage 1 cells' one benchmark; a sealed or non-dev cell refuses. */
function stage1Corpus(defs: CellDefinition[]): Corpus {
  const only = new Set<string>();
  for (const def of defs) {
    const dev = devOnly(def);
    if (!dev) throw refuse({ code: 'CUSTODY_REQUIRED', message: `stage 1 cell ${def.id} is not a public dev cell (${def.benchmark}, split ${def.split})`, why: 'the judge check runs on public BEAM dev answers only', fix: { next: 'report' } });
    for (const c of dev) only.add(c);
  }
  const benchmarks = [...new Set(defs.map(d => d.benchmark))];
  if (benchmarks.length !== 1) throw refuse({ code: 'CAMPAIGN_INVALID', message: `stage 1 spans ${benchmarks.join(', ')}`, why: 'stage 1 runs on BEAM-1M dev conversations', fix: { next: 'report' } });
  return loadCorpus(benchmarks[0], undefined, only);
}

/** The fallback runner for --fake (a keyless stand-in, no ledger) or --paid (requirePaidArm, then startPaidRun's guard). */
function fallbackRunner(argv: string[], fake: boolean, deps: CheckDeps, arm: string, runnerName: string) {
  return async (rows: Row[], judge: string, logFor: (r: Row) => RecordLog<'judgment'>, concurrency: number) => {
    if (fake || deps.client) return runFallback(rows, judge, deps.client ?? fakeJudgeClient(), logFor, concurrency);
    const key = (deps.env ?? process.env).GEMINI_API_KEY;
    const pending = rows.filter(r => !recordOf(r, { judge, instrument_id: `${r.instrument.id}@${judge}` }) && !logFor(r).has(judgmentKey({ answer_id: r.answer.answer_id, instrument_sha256: r.instrument.sha256, judge, judge_replicate: 0 })));
    if (!pending.length) return runFallback(rows, judge, fakeJudgeClient(), logFor, concurrency);
    if (!key) throw refuse({ code: 'KEY_MISSING', message: 'paid fallback judging needs GEMINI_API_KEY', why: 'gemini-3.8-flash is called directly, through the budget ledger\'s fetch guard', fix: { next: 'ask_user', user_message: 'run this where GEMINI_API_KEY is set' } });
    const estimateUsd = fallbackEstimateUsd(pending);
    requirePaidArm(argv, { arm, estimateUsd });
    const started = startPaidRun(runnerName, { ...budgetOptionsFrom(argv), estimateUsd });
    try { return await runFallback(rows, judge, geminiJudgeClient(key), logFor, concurrency); } finally { started.guard.uninstall(); started.run.close(); }
  };
}

const usage = (message: string): ScoreboardMessage => ({ code: 'USAGE', message, why: 'judge.ts takes label, check or sensitivity', fix: { next: 'run', argv: [...FRONT, 'check', '--source', '<stage 1 out>', '--labels', '<sheet.csv>', '--out', '<dir>', '--fake'] } });

/** The CLI; returns the exit status. Operator messages go to stderr; stdout carries counts and hashes. */
export async function main(argv: string[], deps: CheckDeps = {}): Promise<number> {
  const log = deps.log ?? ((s: string) => console.log(s)), error = deps.error ?? ((s: string) => console.error(s));
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const all = (name: string) => argv.flatMap((a, i) => (a === name && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
  try {
    const [command] = argv;
    const manifest = resolve(flag('--manifest') ?? RS1_MANIFEST_PATH);
    const concurrency = Number(flag('--concurrency') ?? 8);
    const sources = all('--source');
    const paidMode = () => { const fake = argv.includes('--fake'); if (fake === argv.includes('--paid')) throw refuse(usage('pass exactly one of --fake and --paid')); return fake; };
    if (command === 'label' && flag('--read')) {
      const { labels, sha256: s } = readSheet(resolve(flag('--read')!));
      const tally = (task: string, label: string | null) => [...labels.values()].filter(l => l.task === task && l.label === label).length;
      log(`rs1-judge labels rows=${labels.size} abstained=${tally('abstention', 'abstained')} answered=${tally('abstention', 'answered')} correct=${tally('short', 'correct')} incorrect=${tally('short', 'incorrect')} unlabeled=${[...labels.values()].filter(l => !l.label).length} sheet_sha256=${s}`);
      return 0;
    }
    if (!sources.length) throw refuse(usage('--source <cell output dir> is required'));
    if (command === 'label') {
      const out = flag('--out');
      if (!out) throw refuse(usage('label needs --out <sheet.csv>'));
      const defs = stage1Cells(readManifest(manifest));
      const d = writeSheet(collectRows(defs, sources, deps.corpus ?? stage1Corpus(defs)), resolve(out));
      log(`rs1-judge label rows=${d.rows} abstention=${d.abstention} short=${d.short} short_population=${d.short_population} prefilter=${d.prefilter.classifier_version} sheet_sha256=${d.sheet_sha256}`);
      return 0;
    }
    if (command === 'check') {
      const labels = flag('--labels'), out = flag('--out');
      if (!labels || !out) throw refuse(usage('check needs --labels <sheet.csv> and --out <dir>'));
      const { result, path } = await runCheck({ manifest, sources, labels: resolve(labels), out, fake: paidMode(), concurrency, argv }, deps);
      const op = checkRefusal(result, relative(ROOT, path) || path);
      if (!op) return 0;
      error(renderMessage(op));
      if (op.code === 'RS1_JUDGE_CHECK_FAIL') log(PREREG_BRANCH);
      return exitCodeOf(op);
    }
    if (command === 'sensitivity') {
      const { run } = await runSensitivity({ manifest, sources, fake: paidMode(), concurrency, argv }, deps);
      if (!run.call_errors) return 0;
      const op: ScoreboardMessage = { code: 'CELL_PARTIAL', partial: true, message: `${run.call_errors} sensitivity judgment(s) failed to arrive`, why: 'recorded judgments are never bought again, so a rerun grades only the rest', fix: { next: 'run', argv: [...FRONT, ...argv] } };
      error(renderMessage(op));
      return exitCodeOf(op);
    }
    throw refuse(usage(`unknown command ${JSON.stringify(command ?? '')}`));
  } catch (e) {
    if (e instanceof ScoreboardError) { error(renderMessage(e.op)); return exitCodeOf(e.op); }
    if (e instanceof PaidArmRefusal) { const op: ScoreboardMessage = { code: 'PAID_FLAGS_MISSING', message: e.message, why: 'fallback judging spends money through the RS1 ledger', fix: { next: 'ask_user', user_message: 'open a run on the RS1 ledger in a paid window and pass --paid --budget-run-id <id> --budget-ledger <file>' } }; error(renderMessage(op)); return exitCodeOf(op); }
    if (e instanceof BudgetExceededError) { const op: ScoreboardMessage = { code: 'BUDGET_CAP', partial: true, message: e.message, why: 'the budget ledger refused a reservation; judgments already recorded are kept', fix: { next: 'ask_user', user_message: 'bring the spend to GBEV-3 before raising any cap' } }; error(renderMessage(op)); return exitCodeOf(op); }
    error(`rs1-judge error class=${(e as Error).name} sha256=${sha256(String((e as Error).message)).slice(0, 16)}`);
    return 2;
  }
}

if (import.meta.main) main(process.argv.slice(2)).then(code => process.exit(code));

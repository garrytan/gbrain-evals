/**
 * Hedge and abstention classifier for Q1's derived columns (preregistration,
 * "Derived columns"): a deterministic lexical classifier that labels one
 * answer text `abstain`, `hedged` or `confident`. It makes no model calls.
 *
 *   bun eval/runner/q1/hedge.ts classify --text <answer>
 *   bun eval/runner/q1/hedge.ts sample --answers <answers.ndjson[.gz]>... --n 200 --seed <s> --out <csv>
 *   bun eval/runner/q1/hedge.ts validate --labels <csv> [--design <csv>.design.json] [--out <json>]
 *
 * Verdicts:
 *   abstain    the answer declines: "I don't know", "not mentioned", "no
 *              information", "cannot determine", "the conversation doesn't
 *              say" and the like, with no guess offered;
 *   hedged     the answer commits to something while marking uncertainty:
 *              "probably", "I think", "likely", "might", "not sure", "it
 *              seems", "possibly", "if I recall" and the like, including an
 *              abstention that goes on to guess ("the conversation doesn't
 *              say, but it was probably Tuesday") or that only disclaims
 *              precision before answering ("I don't know the exact date, but
 *              it was in April");
 *   confident  everything else. An empty answer is `abstain`.
 *
 * Procedure (CLASSIFIER_VERSION covers it; RULES_SHA256 covers the table):
 *   1. normalize: NFKC, lower case, curly quotes and apostrophes made straight,
 *      whitespace collapsed;
 *   2. blank quoted text (double quotes, backticks, single-quoted spans,
 *      Markdown blockquote lines), so a quoted "I think" or "no information"
 *      is not the answer's own voice;
 *   3. blank reported speech: from a reporting verb (said, mentioned, told,
 *      ...) to the end of its clause, unless the verb is negated ("never
 *      mentioned", "wasn't mentioned") or sits under a hedge ("I don't think
 *      you mentioned"), so "you said you might move" reports the user's hedge
 *      and is not one;
 *   4. find abstain cues and, on a copy with cancel phrases blanked ("not a
 *      guess", "not just likely"), hedge cues. Blanking keeps every offset;
 *   5. an abstain cue is demoted to a hedge when a hedge cue follows it, or
 *      when its own clause scopes it to precision ("the exact date", "for
 *      sure", "explicitly") and a contrast ("but", "though", "however", ...)
 *      follows with an answer;
 *   6. any remaining abstain cue: `abstain`; else any hedge cue or demoted
 *      cue: `hedged`; else `confident`.
 *
 * Negation is handled in the rule table itself: abstain cues are negations
 * ("not mentioned", "doesn't say"), hedge cues include their negated forms
 * ("I don't think", "not sure", "unlikely"), "not mentioned again/until..."
 * reports a fact and is no abstain cue, and confident negations ("no doubt",
 * "it's not a guess", "you weren't unsure") match no cue or are cancelled.
 *
 * Validation: `sample` exports a sample stratified by the classifier's
 * verdict (equal allocation, seeded order, verdicts hidden from the labeler)
 * plus a design file with each stratum's population; `validate` recomputes
 * every verdict from the labeled text and reports per-class precision and
 * recall and the confusion matrix as JSON for the receipt. With the design
 * file, recall and accuracy are also reported reweighted to the population.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

export type HedgeVerdict = 'abstain' | 'hedged' | 'confident';
export const HEDGE_VERDICTS: readonly HedgeVerdict[] = ['abstain', 'hedged', 'confident'];
export const CLASSIFIER_VERSION = 'hedge-v1';
export const VALIDATION_SCHEMA = 'gbrain-evals/hedge-validation/v1';
export const SAMPLE_DESIGN_SCHEMA = 'gbrain-evals/hedge-sample-design/v1';

type RuleKind = 'quote' | 'reported' | 'abstain' | 'hedge' | 'cancel' | 'scope' | 'contrast';
export interface Rule { id: string; kind: RuleKind; pattern: string; flags?: string }

const SUBJ = '(?:conversations?|chats?|history|context|notes?|records?|memory|memories|sessions?|messages?|transcripts?|logs?|information|anywhere|there)';
const SOURCE = '(?:conversations?|chats?|history|sessions?|messages?|memory|memories|records?|notes?|context|transcripts?|logs?)';
const NOT_AGAIN = '(?![^.!?;]{0,24}\\b(?:again|until|till|before|after|since|anymore|any more|other than|except)\\b)';

/** The rule table, in application order within each kind. Its sha256 is RULES_SHA256. */
export const RULES: readonly Rule[] = [
  { id: 'q.double', kind: 'quote', pattern: '"[^"\\n]{0,400}"' },
  { id: 'q.backtick', kind: 'quote', pattern: '`[^`\\n]{0,400}`' },
  { id: 'q.single', kind: 'quote', pattern: "(?<=^|[\\s(\\[])'(?:[^'\\n]|(?<=\\w)'(?=\\w)){1,200}'(?=$|[\\s.,;:!?)\\]])" },
  { id: 'q.blockquote', kind: 'quote', pattern: '^\\s*>.*$', flags: 'm' },
  { id: 'r.clause', kind: 'reported', pattern: "(?<!(?:\\bnot|\\bnever|n't|\\bthink|\\bbelieve|\\brecall|\\bremember|\\bsure|\\bwhether|\\bif)\\s(?:\\w+\\s){0,2})\\b(?:said|mentioned|told|noted|wrote|stated|explained|shared|added|admitted|claimed|replied|reported|thought|felt|guessed|wondered|asked|described|suggested|speculated|predicted|estimated|worried|hoped|planned|joked)\\b[^.!?;\\n]*?(?=$|[.!?;\\n]|\\s*,?\\s*\\b(?:but|though|although|however|yet)\\b|,\\s*(?:and|so)\\s+i\\b)" },
  { id: 'a.dont-know', kind: 'abstain', pattern: "\\bi (?:really |honestly )?(?:don't|do not|didn't|did not) know\\b" },
  { id: 'a.not-aware', kind: 'abstain', pattern: "\\b(?:i'm|i am) not aware\\b" },
  { id: 'a.no-info', kind: 'abstain', pattern: '\\bno (?:information|info|record|records|mention|details|data|indication|evidence|reference|note|notes|memory)\\b(?! (?:was|were) (?:lost|missing|removed))' },
  { id: 'a.have-no', kind: 'abstain', pattern: '\\bhave no (?:information|info|record|records|details|data|knowledge|memory|mention)\\b' },
  { id: 'a.dont-have', kind: 'abstain', pattern: "\\b(?:don't|do not) have (?:any |the |a |an |enough )?(?:(?:exact|precise|specific|full|complete|relevant) )?(?:information|info|details?|data|records?|knowledge|memory|access|context|figure|number|date|amount|answer|mention)\\b" },
  { id: 'a.insufficient', kind: 'abstain', pattern: '\\b(?:insufficient|not enough) (?:information|info|details?|data|context|evidence)\\b' },
  { id: 'a.not-verb-ed', kind: 'abstain', pattern: `\\b(?:isn't|is not|wasn't|was not|aren't|are not|weren't|were not|not|hasn't|has not|haven't|have not|never) (?:been )?(?:explicitly |specifically |directly |clearly |actually |ever )?(?:mentioned|stated|specified|discussed|provided|given|recorded|shared|said|covered|brought up|addressed|included|noted|disclosed|indicated)\\b${NOT_AGAIN}` },
  { id: 'a.never-verb', kind: 'abstain', pattern: `\\bnever (?:explicitly |actually |specifically )?(?:mention|discuss|specif|stat|say|said|talk|brought up|bring up|cover|record|provid|giv|shar|told|tell|came up|come up)\\w*${NOT_AGAIN}` },
  { id: 'a.doesnt-say', kind: 'abstain', pattern: `\\b(?:doesn't|does not|didn't|did not|don't|do not) (?:explicitly |specifically |actually |directly )?(?:say|mention|specify|state|indicate|tell|reveal|discuss|record|show|note|address)\\b${NOT_AGAIN}` },
  { id: 'a.doesnt-contain', kind: 'abstain', pattern: `\\b${SUBJ} (?:doesn't|does not|didn't|did not|don't|do not) (?:include|contain|cover|provide|have)\\b` },
  { id: 'a.none-of', kind: 'abstain', pattern: `\\bnone of (?:the|our|your|these|those|my) ${SOURCE} (?:mention|say|discuss|specify|include|contain|cover|state|indicate)` },
  { id: 'a.nothing-in', kind: 'abstain', pattern: '\\bnothing (?:in|from|about|on|regarding|concerning) (?:the|our|your|this|these|that|it|my|those|switching|a|an|any)\\b' },
  { id: 'a.not-in-source', kind: 'abstain', pattern: `\\b(?:isn't|is not|wasn't|was not|aren't|are not|not) (?:available |present |found |there |anywhere |covered |stated |recorded |something we discussed)?(?:in|from|anywhere in) (?:the|our|your|these|this|any|my) (?:available )?${SOURCE}\\b` },
  { id: 'a.isnt-something', kind: 'abstain', pattern: "\\b(?:isn't|is not|wasn't|was not) (?:something|anything) (?:we|you|i) (?:discussed|talked about|covered|mentioned)\\b" },
  { id: 'a.cannot-determine', kind: 'abstain', pattern: "\\b(?:can't|cannot|can not|couldn't|could not|unable to|not able to|no way to|impossible to|not possible to) (?:reliably |definitively |really )?(?:determine|tell|say|know|answer|confirm|identify|infer|work out|figure out)\\b" },
  { id: 'a.cannot-be', kind: 'abstain', pattern: "\\b(?:can't|cannot|can not|couldn't|could not) be (?:answered|determined|known|confirmed|identified)\\b" },
  { id: 'a.cannot-find', kind: 'abstain', pattern: "\\b(?:can't|cannot|can not|couldn't|could not|unable to|not able to) (?:find|locate|see) (?:it|that|this|any|anything|a|an|the|where|when|how|whether|mention|record|information|details)\\b" },
  { id: 'a.dont-recall', kind: 'abstain', pattern: "\\b(?:don't|do not|can't|cannot|can not) (?:recall|remember) (?:you|any|anything|a|an|the|that|it|where|when|whether|if|seeing|hearing|reading|ever)\\b" },
  { id: 'a.dont-think-mentioned', kind: 'abstain', pattern: "\\b(?:don't|do not|didn't|did not) (?:think|believe) (?:that )?(?:you|we|they|he|she|the user|it|this|that)(?: ever| ever actually)? (?:mentioned|said|told|shared|specified|stated|discussed|came up|brought)\\b" },
  { id: 'a.not-sure-ever', kind: 'abstain', pattern: "\\b(?:not sure|unsure) (?:that |whether |if )?(?:you|we|it|that|this)(?: ever)? (?:told|mentioned|said|shared|was ever|were ever|came up|ever came up|discussed)" },
  { id: 'a.unclear-from', kind: 'abstain', pattern: `\\b(?:unclear|not clear) (?:from|in|based on) (?:the|our|your|these|this|my) ${SOURCE}\\b` },
  { id: 'a.unknown', kind: 'abstain', pattern: '(?:^|[.!?:]\\s*)unknown\\b|\\b(?:is|are|was|remains|remain) unknown\\b' },
  { id: 'a.unanswerable', kind: 'abstain', pattern: '\\b(?:unanswerable|not answerable)\\b' },
  { id: 'a.never-came-up', kind: 'abstain', pattern: '\\bnever came up\\b' },
  { id: 'h.i-think', kind: 'hedge', pattern: "\\bi (?:don't |do not )?(?:think|believe|guess|suppose|suspect|reckon|assume|imagine|presume)\\b" },
  { id: 'h.probably', kind: 'hedge', pattern: '\\bprobabl[ey]\\b' },
  { id: 'h.likely', kind: 'hedge', pattern: '\\b(?:un)?likely\\b' },
  { id: 'h.might', kind: 'hedge', pattern: '\\bmight\\b' },
  { id: 'h.may-could', kind: 'hedge', pattern: '\\b(?:may|could) (?:well |possibly )?(?:be|have)\\b|\\bmay or may not\\b' },
  { id: 'h.maybe', kind: 'hedge', pattern: '\\b(?:maybe|perhaps|possibly|presumably|apparently|seemingly|supposedly|arguably)\\b' },
  { id: 'h.possible', kind: 'hedge', pattern: "\\b(?:it's|it is|it's also|that's|that is|it was) possible\\b|\\bpossible that\\b|\\bthere's a chance\\b|\\bthere is a chance\\b" },
  { id: 'h.not-sure', kind: 'hedge', pattern: "\\b(?:i'm|i am|i'm still|i remain|im) (?:not (?:entirely |completely |totally |quite |100% |really |fully |absolutely )?(?:sure|certain|positive|confident)|unsure|uncertain)\\b" },
  { id: 'h.not-sure-bare', kind: 'hedge', pattern: '(?:^|[.!?]\\s+|\\b(?:though|but|and) )not (?:entirely |completely |totally |quite |100% |really |fully )?(?:sure|certain)\\b' },
  { id: 'h.not-entirely', kind: 'hedge', pattern: '\\bnot (?:entirely|completely|100%|totally|fully) (?:sure|certain|clear|positive)\\b' },
  { id: 'h.cant-be-sure', kind: 'hedge', pattern: "\\b(?:can't|cannot|can not) be (?:completely |entirely |100% )?(?:sure|certain|positive)\\b" },
  { id: 'h.fairly-sure', kind: 'hedge', pattern: '\\b(?:fairly|pretty|reasonably|mostly|somewhat) (?:sure|confident|certain)\\b' },
  { id: 'h.seems', kind: 'hedge', pattern: '\\b(?:it|this|that|there) (?:seems|appears)\\b|\\b(?:seems?|appears?) (?:to|like|that)\\b|\\blooks like\\b|\\bsounds like\\b|\\bit sounds\\b' },
  { id: 'h.recall', kind: 'hedge', pattern: "\\bif i (?:recall|remember)(?: correctly| right)?\\b|\\bas far as i (?:know|can tell|recall|remember)\\b|\\bto the best of my (?:knowledge|recollection|memory)\\b|\\b(?:unless|if) i'm (?:not )?mistaken\\b|\\bif memory serves\\b" },
  { id: 'h.guess', kind: 'hedge', pattern: "\\b(?:my|best|educated|rough) guess\\b|\\bi'd (?:guess|say|assume)\\b|\\bi would (?:guess|say|assume)\\b|\\bat a guess\\b" },
  { id: 'h.my-sense', kind: 'hedge', pattern: '\\bmy (?:sense|impression|recollection|understanding|reading) is\\b' },
  { id: 'h.unclear', kind: 'hedge', pattern: "\\bunclear\\b|\\b(?:isn't|is not|it's not|not) (?:entirely |fully |totally |completely |quite )?(?:clear|certain)\\b" },
  { id: 'h.uncertainty', kind: 'hedge', pattern: '\\b(?:some|there is|there\'s|with) uncertainty\\b|\\bi doubt\\b|\\bdoubtful\\b' },
  { id: 'x.not-a-guess', kind: 'cancel', pattern: "\\b(?:not|no|isn't|is not|wasn't|was not|nothing) (?:just |merely |simply |at all )?(?:a |an )?(?:guess|guessing|speculation|speculating|uncertain|unsure)\\b" },
  { id: 'x.not-just-likely', kind: 'cancel', pattern: '\\bnot (?:just|merely|simply) (?:likely|probably|possibly|maybe|i think)\\b' },
  { id: 's.precision', kind: 'scope', pattern: '\\b(?:exact|exactly|precise|precisely|specific|specifically|explicit|explicitly|outright|directly|definitively|for (?:sure|certain)|with (?:certainty|confidence)|in so many words|the full)\\b' },
  { id: 'c.contrast', kind: 'contrast', pattern: '\\b(?:but|however|though|although|that said|still|yet)\\b\\W+\\w+\\W+\\w+' },
];

export const RULES_SHA256 = createHash('sha256').update(JSON.stringify({ version: CLASSIFIER_VERSION, normalize: 'nfkc-lower-straight-quotes-collapse-ws', scope_window: 'clause, at most 40 characters after the cue', rules: RULES })).digest('hex');

const compiled = (kind: RuleKind) => RULES.filter(r => r.kind === kind).map(r => ({ id: r.id, re: new RegExp(r.pattern, `g${r.flags ?? ''}`) }));
const QUOTE = compiled('quote'), REPORTED = compiled('reported'), ABSTAIN = compiled('abstain'), HEDGE = compiled('hedge'), CANCEL = compiled('cancel');
const SCOPE_ONE = new RegExp(compiled('scope')[0].re.source), CONTRAST_ONE = new RegExp(compiled('contrast')[0].re.source);

export function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\u201c\u201d\u201e\u00ab\u00bb]/g, '"').replace(/[\u2018\u2019\u201a\u2032]/g, "'").replace(/[ \t\u00a0]+/g, ' ').trim();
}

const blank = (s: string, res: ReadonlyArray<{ re: RegExp }>) => res.reduce((t, { re }) => t.replace(re, m => ' '.repeat(m.length)), s);
interface Hit { id: string; index: number; end: number }
const hits = (s: string, res: ReadonlyArray<{ id: string; re: RegExp }>): Hit[] => res.flatMap(({ id, re }) => [...s.matchAll(re)].map(m => ({ id, index: m.index!, end: m.index! + m[0].length })));

export interface Classification { verdict: HedgeVerdict; abstain: string[]; hedge: string[]; demoted: string[] }

/** The verdict with the rule ids that produced it. */
export function explainVerdict(text: string): Classification {
  const norm = normalize(text);
  if (!norm.replace(/[\s.…-]/g, '')) return { verdict: 'abstain', abstain: ['empty'], hedge: [], demoted: [] };
  const unquoted = blank(norm, QUOTE);
  const t = blank(unquoted, REPORTED);
  const hedgeHits = hits(blank(t, CANCEL), HEDGE);
  const abstain: string[] = [], demoted: string[] = [];
  for (const a of hits(t, ABSTAIN)) {
    const after = t.slice(a.end);
    const stop = after.search(/[.!?;\n]/);
    const clause = t.slice(a.index, a.end) + after.slice(0, Math.min(40, stop === -1 ? after.length : stop));
    const scoped = SCOPE_ONE.test(clause);
    const contrast = CONTRAST_ONE.test(unquoted.slice(a.end));
    const guess = hedgeHits.some(h => h.index >= a.end);
    (guess || (scoped && contrast) ? demoted : abstain).push(a.id);
  }
  const verdict: HedgeVerdict = abstain.length ? 'abstain' : hedgeHits.length || demoted.length ? 'hedged' : 'confident';
  return { verdict, abstain, hedge: hedgeHits.map(h => h.id), demoted };
}

export const classify = (text: string): HedgeVerdict => explainVerdict(text).verdict;

/** The `hedge` field cell.ts stamps on an answer record. */
export const hedgeStamp = (text: string) => ({ verdict: classify(text), classifier_version: CLASSIFIER_VERSION });

// ─── CSV (RFC 4180) ──────────────────────────────────────────────────

export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter(r => r.length > 1 || r[0] !== '');
  if (!header) return [];
  return body.map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

const csvField = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export const toCsv = (header: string[], rows: Array<Record<string, string>>) => [header, ...rows.map(r => header.map(h => r[h] ?? ''))].map(r => r.map(csvField).join(',')).join('\n') + '\n';

// ─── sample ──────────────────────────────────────────────────────────

export interface SampleAnswer { answer_id: string; cell_id: string; question_id: string; reader: string; text: string; outcome?: string }
export interface SampleDesign {
  schema: typeof SAMPLE_DESIGN_SCHEMA; classifier_version: string; rules_sha256: string; seed: string; n: number;
  answers: Array<{ path: string; sha256: string }>; eligible: number;
  strata: Record<HedgeVerdict, { population: number; sampled: number }>;
}

const JUDGED_OUTCOMES = new Set(['scored', 'ingest_degraded']);
const rank = (seed: string, id: string) => createHash('sha256').update(`${seed}\u0000${id}`).digest('hex');

export function readAnswers(path: string): SampleAnswer[] {
  const buf = readFileSync(path);
  const text = path.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  return text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as SampleAnswer);
}

/** Equal allocation over the three verdict strata, a short stratum's remainder spread over the others; seeded order inside each stratum and in the output. */
export function stratifiedSample(answers: readonly SampleAnswer[], n: number, seed: string): { rows: SampleAnswer[]; strata: SampleDesign['strata']; eligible: number } {
  const seen = new Set<string>();
  const eligible = answers.filter(a => (a.outcome === undefined || JUDGED_OUTCOMES.has(a.outcome)) && a.text.trim() && !seen.has(a.answer_id) && seen.add(a.answer_id));
  const by = Object.fromEntries(HEDGE_VERDICTS.map(v => [v, [] as SampleAnswer[]])) as Record<HedgeVerdict, SampleAnswer[]>;
  for (const a of eligible) by[classify(a.text)].push(a);
  for (const v of HEDGE_VERDICTS) by[v].sort((a, b) => (rank(seed, a.answer_id) < rank(seed, b.answer_id) ? -1 : 1));
  const take = Object.fromEntries(HEDGE_VERDICTS.map(v => [v, 0])) as Record<HedgeVerdict, number>;
  let left = Math.min(n, eligible.length);
  while (left > 0) {
    const open = HEDGE_VERDICTS.filter(v => take[v] < by[v].length);
    const share = Math.max(1, Math.floor(left / open.length));
    for (const v of open) { const k = Math.min(share, by[v].length - take[v], left); take[v] += k; left -= k; if (!left) break; }
  }
  const rows = HEDGE_VERDICTS.flatMap(v => by[v].slice(0, take[v])).sort((a, b) => (rank(`${seed}|order`, a.answer_id) < rank(`${seed}|order`, b.answer_id) ? -1 : 1));
  return { rows, eligible: eligible.length, strata: Object.fromEntries(HEDGE_VERDICTS.map(v => [v, { population: by[v].length, sampled: take[v] }])) as SampleDesign['strata'] };
}

export const SAMPLE_HEADER = ['answer_id', 'cell_id', 'question_id', 'reader', 'text', 'label', 'note'];

// ─── validate ────────────────────────────────────────────────────────

export interface ValidationReport {
  schema: typeof VALIDATION_SCHEMA; classifier_version: string; rules_sha256: string; labels_sha256: string;
  n: number; unlabeled: number; accuracy: number;
  per_class: Record<HedgeVerdict, { support: number; predicted: number; precision: number | null; recall: number | null }>;
  /** confusion[labeled][predicted] = count. */
  confusion: Record<HedgeVerdict, Record<HedgeVerdict, number>>;
  /** With a sample design: recall and accuracy reweighted by each verdict stratum's population / sampled. */
  population_weighted: { accuracy: number; recall: Record<HedgeVerdict, number | null> } | null;
  misclassified: Array<{ answer_id: string; label: HedgeVerdict; predicted: HedgeVerdict }>;
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

export function validate(csvText: string, design: SampleDesign | null = null): ValidationReport {
  const rows = parseCsv(csvText);
  const labeled = rows.filter(r => r.label?.trim());
  for (const r of labeled) if (!HEDGE_VERDICTS.includes(r.label.trim() as HedgeVerdict)) throw new Error(`answer ${r.answer_id}: label ${JSON.stringify(r.label)} is not one of ${HEDGE_VERDICTS.join(', ')}`);
  if (!labeled.length) throw new Error('no labeled rows: fill the label column with abstain, hedged or confident');
  const zero = () => Object.fromEntries(HEDGE_VERDICTS.map(v => [v, 0])) as Record<HedgeVerdict, number>;
  const confusion = Object.fromEntries(HEDGE_VERDICTS.map(v => [v, zero()])) as ValidationReport['confusion'];
  const weighted = Object.fromEntries(HEDGE_VERDICTS.map(v => [v, zero()])) as ValidationReport['confusion'];
  const misclassified: ValidationReport['misclassified'] = [];
  const weight = (p: HedgeVerdict) => (design && design.strata[p].sampled ? design.strata[p].population / design.strata[p].sampled : 1);
  for (const r of labeled) {
    const label = r.label.trim() as HedgeVerdict, predicted = classify(r.text);
    confusion[label][predicted]++;
    weighted[label][predicted] += weight(predicted);
    if (label !== predicted) misclassified.push({ answer_id: r.answer_id, label, predicted });
  }
  const per_class = Object.fromEntries(HEDGE_VERDICTS.map(v => {
    const support = HEDGE_VERDICTS.reduce((s, p) => s + confusion[v][p], 0);
    const predicted = HEDGE_VERDICTS.reduce((s, l) => s + confusion[l][v], 0);
    return [v, { support, predicted, precision: predicted ? r4(confusion[v][v] / predicted) : null, recall: support ? r4(confusion[v][v] / support) : null }];
  })) as ValidationReport['per_class'];
  const total = (m: ValidationReport['confusion']) => HEDGE_VERDICTS.reduce((s, l) => s + HEDGE_VERDICTS.reduce((t, p) => t + m[l][p], 0), 0);
  const diag = (m: ValidationReport['confusion']) => HEDGE_VERDICTS.reduce((s, v) => s + m[v][v], 0);
  return {
    schema: VALIDATION_SCHEMA, classifier_version: CLASSIFIER_VERSION, rules_sha256: RULES_SHA256, labels_sha256: createHash('sha256').update(csvText).digest('hex'),
    n: labeled.length, unlabeled: rows.length - labeled.length, accuracy: r4(diag(confusion) / labeled.length), per_class, confusion,
    population_weighted: design ? {
      accuracy: r4(diag(weighted) / total(weighted)),
      recall: Object.fromEntries(HEDGE_VERDICTS.map(v => { const s = HEDGE_VERDICTS.reduce((x, p) => x + weighted[v][p], 0); return [v, s ? r4(weighted[v][v] / s) : null]; })) as Record<HedgeVerdict, number | null>,
    } : null,
    misclassified,
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────

function args(argv: string[], name: string): string[] {
  return argv.flatMap((a, i) => (a === name && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const usage = 'usage: bun eval/runner/q1/hedge.ts classify --text <answer> | sample --answers <answers.ndjson[.gz]>... --n 200 --seed <s> --out <csv> | validate --labels <csv> [--design <json>] [--out <json>]';
  const one = (name: string) => { const v = args(argv, name); if (v.length !== 1) { console.error(`${usage}\n(${name} is required once)`); process.exit(2); } return v[0]; };
  const command = argv[0];
  if (command === 'classify') {
    console.log(JSON.stringify({ ...explainVerdict(one('--text')), classifier_version: CLASSIFIER_VERSION, rules_sha256: RULES_SHA256 }, null, 2));
  } else if (command === 'sample') {
    const paths = args(argv, '--answers');
    if (!paths.length) { console.error(`${usage}\n(--answers is required)`); process.exit(2); }
    for (const p of paths) if (!existsSync(p)) { console.error(`no such answers file: ${p}`); process.exit(2); }
    const n = Number(one('--n')), seed = one('--seed'), out = one('--out');
    if (!Number.isInteger(n) || n <= 0) { console.error('--n must be a positive integer'); process.exit(2); }
    const s = stratifiedSample(paths.flatMap(readAnswers), n, seed);
    writeFileSync(out, toCsv(SAMPLE_HEADER, s.rows.map(a => ({ answer_id: a.answer_id, cell_id: a.cell_id, question_id: a.question_id, reader: a.reader, text: a.text, label: '', note: '' }))));
    const design: SampleDesign = { schema: SAMPLE_DESIGN_SCHEMA, classifier_version: CLASSIFIER_VERSION, rules_sha256: RULES_SHA256, seed, n, answers: paths.map(p => ({ path: p, sha256: createHash('sha256').update(readFileSync(p)).digest('hex') })), eligible: s.eligible, strata: s.strata };
    writeFileSync(`${out}.design.json`, JSON.stringify(design, null, 2) + '\n');
    console.log(JSON.stringify({ out, design: `${out}.design.json`, sampled: s.rows.length, eligible: s.eligible, strata: s.strata }, null, 2));
  } else if (command === 'validate') {
    const labels = one('--labels');
    const designPath = args(argv, '--design')[0];
    const report = validate(readFileSync(labels, 'utf8'), designPath ? JSON.parse(readFileSync(designPath, 'utf8')) as SampleDesign : null);
    const text = JSON.stringify(report, null, 2) + '\n';
    const out = args(argv, '--out')[0];
    if (out) writeFileSync(out, text);
    process.stdout.write(text);
  } else { console.error(usage); process.exit(2); }
}

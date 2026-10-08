/**
 * Hedge and abstention classifiers for Q1's derived columns (preregistration,
 * "Derived columns"): deterministic lexical classifiers that label one answer
 * text `abstain`, `hedged` or `confident`. They make no model calls. The
 * scoreboard runs the version campaign.json names in `hedge_classifier`, at
 * render time (HEDGE_CLASSIFIERS); answers carry no verdict.
 *
 *   bun eval/runner/q1/hedge.ts classify --text <answer> [--classifier <version>]
 *   bun eval/runner/q1/hedge.ts sample --answers <answers.ndjson[.gz]>... --n 200 --seed <s> --out <csv>
 *       [--exclude <csv with answer_id>]... [--blind <csv>] [--classifier <version>]
 *   bun eval/runner/q1/hedge.ts validate --labels <csv> [--design <csv>.design.json] [--out <json>] [--classifier <version>]
 *
 * `--classifier` defaults to CURRENT_CLASSIFIER (hedge-v2); `validate` with a
 * design file defaults to the version the sample was drawn with.
 *
 * hedge-v2 (explainVerdictV2, below the v1 code) classifies the answer's
 * final-answer span rather than the whole text: long answers carry markdown,
 * a marked final answer and reasoning paragraphs whose uncertainty is often
 * about premises or side details. hedge-v1, kept for the record, matches cues
 * anywhere in the text; it is documented here.
 *
 * hedge-v1 verdicts:
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
/** v2 adds `excluded` (answers left out of the draw) and `blind` (the labeler's copy: answer_id and text only). */
export const SAMPLE_DESIGN_SCHEMA = 'gbrain-evals/hedge-sample-design/v2';

type RuleKind = 'quote' | 'reported' | 'abstain' | 'hedge' | 'cancel' | 'scope' | 'contrast' | 'marker' | 'lead-skip' | 'offer' | 'premise' | 'record' | 'guess';
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

// ─── hedge-v2: classify the final-answer span ────────────────────────

export const CLASSIFIER_VERSION_V2 = 'hedge-v2';

const QTY = '(?:\\d[\\d,.]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|fifty|a hundred|a few|a couple(?: of)?|several|half an?|an?)';
const UNIT = '(?:years?|months?|weeks?|days?|hours?|minutes?|seconds?|times|percent|%|miles?|km|kilometers?|kilometres?|dollars?|pounds?|kg|lbs?)';
const DATEISH = "(?:(?:early|mid|late|the (?:end|start|beginning|middle) of)[- ]?\\s*)?(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?\\s+(?:\\d|of\\b)|(?:january|february|march|april|may|june|july|august|september|october|november|december)\\b|(?:spring|summer|autumn|fall|winter)\\b|(?:19|20)\\d\\d\\b|\\d{1,2}(?:st|nd|rd|th)?(?:\\s*(?:-|–|and|to)\\s*\\d{1,2}(?:st|nd|rd|th)?)?\\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\b|\\d{1,2}(?::\\d\\d)?\\s?(?:am|pm)\\b|noon|midnight)";
const NOT_TOPIC = '(?<!\\b(?:talk|talked|talking|talks|ask|asked|asking|asks|think|thinking|thought|know|knew|care|cared|worried|excited|information|info|details|nothing|anything|something|said|say|says|wrote|story|stories|conversations?|chats?|questions?|mention|mentioned|learn|learned|learning|read|reading|forgot|remember|remembered|tell|told|hear|heard|sure|unsure|curious|all|how|what|memories|memory|items?|notes?|records?) )';

/**
 * hedge-v2's own rules, in application order within each kind; it also applies hedge-v1's quote, reported-speech,
 * abstain, hedge and cancel rules (RULES) inside the span. `marker` finds the final-answer line; `lead-skip` marks a
 * first line that does not lead with the answer; `offer` drops a sentence addressed to the user; `premise` marks a
 * sentence about the question's premise and `record` one about a record's date, whose cues are not about the answer;
 * `guess` is a guess offered after a decline.
 */
export const RULES_V2: readonly Rule[] = [
  { id: 'm.answer', kind: 'marker', pattern: "^(?:step \\d+\\s*[:.\\-–—]\\s*)?(?:(?:the|my|final|short|direct|overall|reason(?:ing)? and)\\s+)*answer(?:\\s*\\([^)]*\\))?\\s*(?:[:.\\-–—]|$|is\\b)" },
  { id: 'm.conclusion', kind: 'marker', pattern: '^(?:step \\d+\\s*[:.\\-–—]\\s*)?(?:(?:the|my|final)\\s+)?(?:conclusion|bottom line|verdict|in short|in summary|summary)\\s*(?:[:.\\-–—,]|$)' },
  { id: 'm.reasoning', kind: 'marker', pattern: '^(?:step \\d+\\s*[:.\\-–—]\\s*)?(?:reason(?:ing)?|reason over the information|reason (?:about|through|toward)[^:.]*)\\s*(?:[:.\\-–—]|$)' },
  { id: 'l.skip', kind: 'lead-skip', pattern: "^(?:step\\b|relevant\\b|extract|reason|the question\\b|question\\b|looking\\b|let me\\b|i (?:need|will|'ll|should|must|first)\\b|to answer\\b|first\\b|context\\b|memory items?\\b|from the memor|what the (?:memories|conversations|records|chats))" },
  { id: 'o.offer', kind: 'offer', pattern: "^(?:if you\\b|let me know|feel free|i can help|i'?m happy to|i'?d be happy|happy to help|please (?:share|tell|provide)|could you\\b|can you\\b)|\\bif you (?:can |could |want to |'d like to )?(?:share|tell|provide|give|let me|remind|clarify|have)\\b" },
  { id: 'p.question', kind: 'premise', pattern: "\\b(?:the|this|your) question(?:'s)? (?:[a-z]+ ){0,2}(?:assum\\w*|mix\\w*|confus\\w*|swap\\w*|attribut\\w*|conflat\\w*|impl(?:y|ies)|presuppos\\w*|names?|says|has (?:the|a|an)|is based|seems|appears|refers?|means?|meant|wording)\\b|\\bpremise\\b|\\bmix(?:es|ed|ing)?[- ]up\\b|\\bmixes\\b|\\bconfus(?:es|ed|ing|ion)\\b|\\bswapped\\b|\\bthe names\\b" },
  { id: 'p.correction', kind: 'premise', pattern: "\\b(?:it|that|this) (?:was|is) (?:actually |really )?[a-z]+(?:'s)? (?:who|that|,? not)\\b|,? not [a-z]+'s\\b|\\b(?:they|records?|memor(?:y|ies)|conversations?|chats?|one they) (?:do|does|did) (?:record|show|mention|say|describe)\\b|\\b(?:isn't|wasn't) (?:quite )?what happened\\b" },
  { id: 'r.record', kind: 'record', pattern: "\\b(?:dated|recorded (?:on|as|under|for|at)|record dates?|current date|timestamps?|item dates?|memory dates?|session dates?|(?:after|before) today|stored conversations)\\b" },
  { id: 'g.guess', kind: 'guess', pattern: "\\bif (?:a |i had to |i must |forced to |you want a |you need a )?(?:guess|speculat)\\w*|\\b(?:best|educated|rough|plausible|reasonable|my|a) guess\\b|\\bspeculat\\w*|\\b(?:is|are|be) (?:a |one )?possibilit(?:y|ies)\\b|\\btentative\\w*|\\b(?:an|my|this is an?|only an?) (?:inference|estimate|assumption|guess)\\b|\\bgeneral suggestion\\b|\\bsuggestion rather than\\b|\\b(?:good|best|strong|natural|likely|possible|plausible) (?:fit|match|candidate|option)s?\\b|\\b(?:would|could) (?:also )?(?:be )?(?:a )?(?:good |great |strong |natural |reasonable |plausible )?(?:fit|match|candidate)s?\\b|\\bmy guess\\b" },
  { id: 'h2.approx', kind: 'hedge', pattern: `${NOT_TOPIC}\\b(?:about|around|roughly|approximately|approx\\.?|circa|nearly|almost|some ?time|or so)\\s+(?:(?:from|between|in|on|by|the|of|after|before)\\s+)*(?:${QTY}\\s*-?\\s*${UNIT}\\b|${DATEISH})|~\\s?\\d` },
  { id: 'h2.may-verb', kind: 'hedge', pattern: '\\b(?:may|might) (?:well |also |actually )?(?:refer|mean|include|overlap|correspond|count|represent|reflect|indicate|describe|involve|apply|differ|belong)\\w*' },
  { id: 'h2.implies', kind: 'hedge', pattern: '\\b(?:it|this|that|which) (?:implies|suggests|indicates|hints)\\b|\\b(?:implied|hinted)\\b' },
  { id: 'h2.potentially', kind: 'hedge', pattern: '\\b(?:potentially|conceivably|plausibl[ey]|tentatively)\\b' },
  { id: 'h2.assuming', kind: 'hedge', pattern: "\\bassuming (?:he|she|they|that|it|this)\\b|\\bmy best (?:reading|guess|estimate|inference)\\b|\\b(?:that|this) (?:link |date |answer )?(?:is )?my (?:own )?(?:assumption|inference|estimate)\\b|\\b(?:an|my own) inference\\b" },
  { id: 'x2.you-may', kind: 'cancel', pattern: "\\byou (?:may|might) (?:be )?(?:thinking|remembering|mean|be referring|recall)\\w*" },
  { id: 'a2.not-enough', kind: 'abstain', pattern: "\\b(?:isn't|is not|wasn't|was not|aren't|are not) (?:enough|sufficient) (?:information|info|details?|data|context|evidence)\\b" },
  { id: 'a2.dont-have', kind: 'abstain', pattern: "\\b(?:don't|do not) have (?:any |the |a |an |enough )?(?:[a-z]+ )?(?:information|info|details?|data|records?|knowledge|memor(?:y|ies))\\b" },
  { id: 'a2.never-named', kind: 'abstain', pattern: `\\b(?:isn't|is not|wasn't|was not|aren't|are not|weren't|were not|not|never) (?:been )?(?:explicitly |specifically |actually |ever )?(?:named|identified|listed|documented)\\b${NOT_AGAIN}|\\b(?:never|don't|doesn't|didn't|do not|does not|did not) (?:actually |explicitly |specifically )?(?:names?|identif(?:y|ies)|lists?)\\b|\\b(?:doesn't|does not|don't|do not) appear\\b|\\bnone of (?:the|our|your|these|those|my|their) (?:[a-z]+ )?(?:names?|identif\\w*|lists?|shows?|gives?|states?|records?)\\b` },
  { id: 'a2.cant-answer', kind: 'abstain', pattern: "\\b(?:can't|cannot|can not|couldn't|could not|unable to) (?:answer|identify|name|pin down|confirm)\\b|\\bno (?:stored|recorded|relevant|retrieved) (?:information|info|memories|memory|records?|details|items?)\\b|\\b(?:returned|retrieved) (?:no|nothing)\\b" },
  { id: 'a2.would-guess', kind: 'abstain', pattern: "\\bwould (?:only |just )?be (?:a |pure |just )?(?:guess|guessing|speculation|speculative)\\b" },
  { id: 's2.precision', kind: 'scope', pattern: '\\b(?:exact|exactly|precise|precisely|specific|specifically|explicit|explicitly|outright|straight out|directly|definitively|for (?:sure|certain)|with (?:certainty|confidence)|in so many words|the full|by name|particular)\\b' },
  { id: 'c2.contrast', kind: 'contrast', pattern: '\\b(?:but|however|though|although|that said|still|yet)\\b' },
];

export const RULES_SHA256_V2 = createHash('sha256').update(JSON.stringify({
  version: CLASSIFIER_VERSION_V2,
  normalize: 'nfkc, straight quotes; span lines stripped of list markers, heading hashes and emphasis; lower case, whitespace collapsed',
  span: 'last answer marker, else last conclusion marker (rest of the marker paragraph, else the next paragraph); else a leading answer (bold opening sentence, or first sentence); else the last paragraph that is not a note or an offer',
  followup: 'a declining span is hedged when a guess follows in the conclusion paragraph, or, for a leading answer, in the rest of its paragraph or the last paragraph; a span of at most 6 words also reads its reasoning section (else the paragraph before it) for hedges other than approximators; approximators never turn a decline into a guess',
  inherits: RULES.filter(r => ['quote', 'reported', 'abstain', 'hedge', 'cancel'].includes(r.kind)),
  rules: RULES_V2,
})).digest('hex');

const v2 = (kind: RuleKind) => RULES_V2.filter(r => r.kind === kind).map(r => ({ id: r.id, re: new RegExp(r.pattern, `g${r.flags ?? ''}`) }));
const tester = (kind: RuleKind) => { const res = v2(kind).map(r => new RegExp(r.re.source)); return (s: string) => res.some(re => re.test(s)); };
const [ANSWER_MARK, CONCLUSION_MARK, REASON_MARK] = v2('marker').map(r => new RegExp(r.re.source, 'i'));
const IS_LEAD_SKIP = tester('lead-skip'), IS_OFFER = tester('offer'), IS_PREMISE = tester('premise'), IS_RECORD = tester('record');
const ABSTAIN_V2 = [...ABSTAIN, ...v2('abstain')], HEDGE_V2 = [...HEDGE, ...v2('hedge')], CANCEL_V2 = [...CANCEL, ...v2('cancel')], GUESS = v2('guess');
const SCOPE_V2 = new RegExp(v2('scope')[0].re.source), CONTRAST_V2 = new RegExp(v2('contrast')[0].re.source);
const SHORT_SPAN_WORDS = 6;
/** First-person declines: scoped to precision and followed by a contrast ("I don't know the exact date, but ..."), the answerer's own uncertainty, so a hedge. */
const FIRST_PERSON = new Set(['a.dont-know', 'a.dont-recall', 'a.dont-have', 'a2.dont-have', 'a.not-aware']);

/** A line without its list marker, heading hashes and emphasis. */
const bare = (line: string) => line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:#{1,6}\s*)?/, '').replace(/[*_]{1,3}/g, '').trim();
const straighten = (t: string) => t.normalize('NFKC').replace(/\r\n?/g, '\n').replace(/[\u201c\u201d\u201e\u00ab\u00bb]/g, '"').replace(/[\u2018\u2019\u201a\u2032]/g, "'");
const words = (s: string) => s.replace(/[^a-z0-9']+/gi, ' ').trim().split(' ').filter(Boolean).length;

export interface FinalSpan {
  kind: 'marker' | 'lead' | 'last' | 'empty';
  text: string;
  /** Read only when `text` declines: a guess here makes the answer hedged. */
  followup: string;
  /** Read only when `text` is at most SHORT_SPAN_WORDS words: its reasoning section, else the paragraph before it. */
  reasoning: string;
}

function markerSpan(paras: string[], mark: RegExp): { text: string; at: number } | null {
  for (let i = paras.length - 1; i >= 0; i--) {
    const lines = paras[i].split('\n');
    const at = lines.findIndex(l => mark.test(bare(l)));
    if (at < 0) continue;
    const head = bare(lines[at]).replace(mark, '').replace(/^[\s:.\-–—,]+/, '');
    const rest = [head, ...lines.slice(at + 1)].join('\n').trim();
    if (rest) return { text: rest, at: i };
    if (paras[i + 1]) return { text: paras[i + 1], at: i };
  }
  return null;
}

/**
 * The answer's final-answer span: the last answer marker ("**Answer:**", "Answer:", "# Answer"), else the last
 * conclusion marker, as the rest of its paragraph or, when the marker stands alone, the next paragraph; else a first
 * paragraph that leads with the answer (its bold opening sentence, or its first sentence); else the last paragraph
 * that is not a note or an offer.
 */
export function finalSpan(text: string): FinalSpan {
  const paras = straighten(text).split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (!paras.length) return { kind: 'empty', text: '', followup: '', reasoning: '' };
  const answer = markerSpan(paras, ANSWER_MARK), conclusion = markerSpan(paras, CONCLUSION_MARK);
  const prose = (p: string) => !/^(?:\(|note\b|caveat\b)/i.test(bare(p)) && !IS_OFFER(bare(p).toLowerCase()) && words(bare(p)) > 3;
  const reasonAt = paras.map((p, i) => (REASON_MARK.test(bare(p.split('\n')[0])) ? i : -1)).filter(i => i >= 0).pop();
  const section = (from: number, stop: number) => paras.slice(from, stop).filter(p => prose(p) || REASON_MARK.test(bare(p.split('\n')[0]))).map(p => p.split('\n').map(l => (REASON_MARK.test(bare(l)) ? bare(l).replace(REASON_MARK, '') : l)).join('\n')).join('\n\n');
  if (answer || conclusion) {
    const m = (answer ?? conclusion)!;
    const reasoning = reasonAt === undefined ? paras.slice(0, m.at).filter(prose).slice(-1).join('\n\n') : section(reasonAt, reasonAt < m.at ? m.at : paras.length);
    return { kind: 'marker', text: m.text, followup: answer && conclusion && conclusion.at !== answer.at ? conclusion.text : '', reasoning };
  }
  const first = paras[0], firstLine = first.split('\n')[0];
  const heading = /^\s*(?:#|[-*+] |\d+[.)] )/.test(first) || (/:\s*(?:\*\*)?\s*$/.test(firstLine) && !/[.!?]\s/.test(firstLine)) || IS_LEAD_SKIP(bare(firstLine).toLowerCase());
  if (!heading) {
    const bold = /^\s*\*\*([^*]+)\*\*/.exec(first);
    const lead = bold ? (/[.!?]\s*$/.test(bold[1].trim()) ? bold[1] : null) : /^[\s\S]*?[.!?](?=\s|$)(?:\s+(?:\S+\s+){0,7}?\S+[.!?](?=\s|$))?/.exec(first)?.[0] ?? first;
    const rest = lead === null ? '' : first.slice(first.indexOf(lead) + lead.length).replace(/^\s*\*\*/, '');
    if (lead !== null) return { kind: 'lead', text: lead, followup: [rest, paras.length > 1 ? paras[paras.length - 1] : ''].join('\n\n'), reasoning: reasonAt === undefined ? rest : section(reasonAt, paras.length) };
  }
  const last = [...paras].reverse().find(prose) ?? paras[paras.length - 1];
  return { kind: 'last', text: last, followup: '', reasoning: '' };
}

interface SpanCues { declined: boolean; abstain: string[]; hedge: string[]; guess: string[]; ignored: string[]; premise: boolean }

/** The cues of one span, sentence by sentence (see explainVerdictV2). */
function spanCues(spanText: string): SpanCues {
  const clean = normalize(spanText.split('\n').map(bare).join('\n')).replace(/\s*\n\s*/g, ' ');
  const sentences = clean.split(/(?<=[.!?;])\s+(?=\S)|(?<=:)\s+(?=\S)/).filter(s => !IS_OFFER(s));
  const out: SpanCues = { declined: false, abstain: [], hedge: [], guess: [], ignored: [], premise: sentences.some(IS_PREMISE) };
  let substantive = false;
  sentences.forEach((raw, k) => {
    const t = blank(blank(raw, QUOTE), REPORTED);
    const abst = hits(t, ABSTAIN_V2);
    const hedgeText = blank(blank(t, CANCEL_V2), [{ re: /\([^)]*\)/g }]);
    const boundary = (h: Hit) => !abst.some(a => h.index >= a.index && !/[,;:]|\b(?:but|though|however|so)\b/.test(t.slice(a.end, h.index)));
    const hedges = hits(hedgeText, HEDGE_V2).filter(h => !abst.some(a => h.index < a.end && h.end > a.index)).filter(boundary);
    const guesses = hits(t, GUESS).filter(g => !abst.some(a => g.index < a.end && g.end > a.index)).filter(boundary);
    if (IS_PREMISE(raw) || IS_RECORD(raw)) { out.ignored.push(...abst.map(a => a.id), ...hedges.map(h => h.id)); return; }
    out.hedge.push(...hedges.map(h => h.id));
    out.guess.push(...guesses.map(g => g.id));
    if (!abst.length) { if (words(t) >= 2) substantive = true; return; }
    const scoped = abst.every(a => a.id !== 'a2.would-guess' && (() => { const after = t.slice(a.end); const stop = after.search(/[.!?;]/); return SCOPE_V2.test(t.slice(Math.max(0, a.index - 30), a.end) + after.slice(0, Math.min(40, stop === -1 ? after.length : stop))); })());
    const contrast = CONTRAST_V2.test(t.slice(abst[abst.length - 1].end)) || (k + 1 < sentences.length && /^(?:but|however|still|that said)\b/.test(sentences[k + 1]));
    if (scoped && contrast && abst.some(a => FIRST_PERSON.has(a.id))) { out.hedge.push(...abst.map(a => `${a.id}+contrast`)); return; }
    if (scoped && (substantive || contrast)) { out.ignored.push(...abst.map(a => a.id)); return; }
    out.declined = true;
    out.abstain.push(...abst.map(a => a.id));
  });
  return out;
}

export interface ClassificationV2 extends Classification { span: FinalSpan; guess: string[]; ignored: string[]; read: Array<'span' | 'followup' | 'reasoning'> }

/**
 * hedge-v2's verdict with the span it classified and the rule ids that produced it. Inside the span, sentence by
 * sentence: hedge-v1's quotes and reported speech are blanked, and offers to the user dropped; a sentence about the
 * question's premise or a record's date contributes no cue; an abstain cue scoped to precision ("the exact date isn't
 * given") is no decline when the span has already answered or goes on with a contrast; a hedge cue inside the declining
 * clause ("can't tell which park they could mean") does not count. Then: a decline with a guess or hedge is `hedged`; a
 * decline alone is `abstain`, unless the span corrects the question's premise; any other hedge cue (including an
 * approximator on a number or date) is `hedged`; else `confident`.
 */
export function explainVerdictV2(text: string): ClassificationV2 {
  const span = finalSpan(text);
  const base: ClassificationV2 = { verdict: 'confident', abstain: [], hedge: [], demoted: [], span, guess: [], ignored: [], read: ['span'] };
  if (!normalize(text).replace(/[\s.…-]/g, '')) return { ...base, verdict: 'abstain', abstain: ['empty'] };
  const c = spanCues(span.text);
  const out: ClassificationV2 = { ...base, abstain: c.abstain, hedge: c.hedge, guess: c.guess, ignored: c.ignored };
  if (c.declined && !c.premise) {
    if (c.guess.length || c.hedge.some(h => h !== 'h2.approx')) return { ...out, verdict: 'hedged', abstain: [], demoted: c.abstain };
    const f = span.followup ? spanCues(span.followup) : null;
    if (f && f.guess.length) return { ...out, verdict: 'hedged', abstain: [], demoted: c.abstain, guess: f.guess, read: ['span', 'followup'] };
    return { ...out, verdict: 'abstain', read: f ? ['span', 'followup'] : ['span'] };
  }
  if (c.declined) { out.ignored = [...out.ignored, ...out.abstain]; out.abstain = []; }
  if (c.hedge.length) return { ...out, verdict: 'hedged' };
  if (span.reasoning && words(span.text) <= SHORT_SPAN_WORDS) {
    const r = spanCues(span.reasoning);
    const own = r.hedge.filter(h => h !== 'h2.approx');
    if (own.length) return { ...out, verdict: 'hedged', hedge: own, read: ['span', 'reasoning'] };
    return { ...out, read: ['span', 'reasoning'] };
  }
  return out;
}

export const classifyV2 = (text: string): HedgeVerdict => explainVerdictV2(text).verdict;

// ─── Registry ────────────────────────────────────────────────────────

export interface HedgeClassifier { version: string; rules_sha256: string; classify: (text: string) => HedgeVerdict }

/** Every classifier version a receipt may name in campaign.json `hedge_classifier`. */
export const HEDGE_CLASSIFIERS: Readonly<Record<string, HedgeClassifier>> = {
  [CLASSIFIER_VERSION]: { version: CLASSIFIER_VERSION, rules_sha256: RULES_SHA256, classify },
  [CLASSIFIER_VERSION_V2]: { version: CLASSIFIER_VERSION_V2, rules_sha256: RULES_SHA256_V2, classify: classifyV2 },
};
export const CURRENT_CLASSIFIER = CLASSIFIER_VERSION_V2;

export function hedgeClassifier(version: string): HedgeClassifier {
  const c = HEDGE_CLASSIFIERS[version];
  if (!c) throw new Error(`unknown hedge classifier ${JSON.stringify(version)}; known: ${Object.keys(HEDGE_CLASSIFIERS).join(', ')}`);
  return c;
}


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
  schema: typeof SAMPLE_DESIGN_SCHEMA | 'gbrain-evals/hedge-sample-design/v1'; classifier_version: string; rules_sha256: string; seed: string; n: number;
  answers: Array<{ path: string; sha256: string }>;
  /** Files whose answer_id column was left out of the draw (an earlier sample, say), and how many answers that removed. */
  excluded?: { files: Array<{ path: string; sha256: string }>; answers: number };
  /** The labeler's copy: answer_id and text only, in the sample's seeded order. */
  blind?: { path: string; sha256: string } | null;
  eligible: number;
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
export function stratifiedSample(answers: readonly SampleAnswer[], n: number, seed: string, classifier: HedgeClassifier = hedgeClassifier(CURRENT_CLASSIFIER)): { rows: SampleAnswer[]; strata: SampleDesign['strata']; eligible: number } {
  const seen = new Set<string>();
  const eligible = answers.filter(a => (a.outcome === undefined || JUDGED_OUTCOMES.has(a.outcome)) && a.text.trim() && !seen.has(a.answer_id) && seen.add(a.answer_id));
  const by = Object.fromEntries(HEDGE_VERDICTS.map(v => [v, [] as SampleAnswer[]])) as Record<HedgeVerdict, SampleAnswer[]>;
  for (const a of eligible) by[classifier.classify(a.text)].push(a);
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
/** The blind copy for the labeler: answer_id and text only (no cell, system or reader); the labeler adds a `label` column, and `validate` reads it. */
export const BLIND_HEADER = ['answer_id', 'text'];

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

export function validate(csvText: string, design: SampleDesign | null = null, classifier: HedgeClassifier = hedgeClassifier(design?.classifier_version ?? CURRENT_CLASSIFIER)): ValidationReport {
  if (design && design.rules_sha256 !== classifier.rules_sha256) throw new Error(`the sample was drawn with ${design.classifier_version} (rules ${design.rules_sha256.slice(0, 12)}…), but this validation runs ${classifier.version} (rules ${classifier.rules_sha256.slice(0, 12)}…): its strata would not weight this classifier's verdicts`);
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
    const label = r.label.trim() as HedgeVerdict, predicted = classifier.classify(r.text);
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
    schema: VALIDATION_SCHEMA, classifier_version: classifier.version, rules_sha256: classifier.rules_sha256, labels_sha256: createHash('sha256').update(csvText).digest('hex'),
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
  const usage = 'usage: bun eval/runner/q1/hedge.ts classify --text <answer> | sample --answers <answers.ndjson[.gz]>... --n 200 --seed <s> --out <csv> [--exclude <csv>]... [--blind <csv>] | validate --labels <csv> [--design <json>] [--out <json>]; each takes [--classifier <version>]';
  const one = (name: string) => { const v = args(argv, name); if (v.length !== 1) { console.error(`${usage}\n(${name} is required once)`); process.exit(2); } return v[0]; };
  const command = argv[0];
  const named = args(argv, '--classifier')[0];
  const pick = (fallback: string) => { try { return hedgeClassifier(named ?? fallback); } catch (e) { console.error((e as Error).message); process.exit(2); } };
  const fileSha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
  if (command === 'classify') {
    const c = pick(CURRENT_CLASSIFIER), text = one('--text');
    const why = c.version === CLASSIFIER_VERSION ? explainVerdict(text) : explainVerdictV2(text);
    console.log(JSON.stringify({ ...why, classifier_version: c.version, rules_sha256: c.rules_sha256 }, null, 2));
  } else if (command === 'sample') {
    const paths = args(argv, '--answers'), excludes = args(argv, '--exclude'), blind = args(argv, '--blind')[0];
    if (!paths.length) { console.error(`${usage}\n(--answers is required)`); process.exit(2); }
    for (const p of [...paths, ...excludes]) if (!existsSync(p)) { console.error(`no such file: ${p}`); process.exit(2); }
    const n = Number(one('--n')), seed = one('--seed'), out = one('--out'), c = pick(CURRENT_CLASSIFIER);
    if (!Number.isInteger(n) || n <= 0) { console.error('--n must be a positive integer'); process.exit(2); }
    const skip = new Set(excludes.flatMap(p => parseCsv(readFileSync(p, 'utf8')).map(r => r.answer_id)));
    const all = paths.flatMap(readAnswers), pool = all.filter(a => !skip.has(a.answer_id));
    const s = stratifiedSample(pool, n, seed, c);
    writeFileSync(out, toCsv(SAMPLE_HEADER, s.rows.map(a => ({ answer_id: a.answer_id, cell_id: a.cell_id, question_id: a.question_id, reader: a.reader, text: a.text, label: '', note: '' }))));
    if (blind) writeFileSync(blind, toCsv(BLIND_HEADER, s.rows.map(a => ({ answer_id: a.answer_id, text: a.text }))));
    const design: SampleDesign = {
      schema: SAMPLE_DESIGN_SCHEMA, classifier_version: c.version, rules_sha256: c.rules_sha256, seed, n, answers: paths.map(p => ({ path: p, sha256: fileSha(p) })),
      excluded: { files: excludes.map(p => ({ path: p, sha256: fileSha(p) })), answers: all.length - pool.length }, blind: blind ? { path: blind, sha256: fileSha(blind) } : null,
      eligible: s.eligible, strata: s.strata,
    };
    writeFileSync(`${out}.design.json`, JSON.stringify(design, null, 2) + '\n');
    console.log(JSON.stringify({ out, design: `${out}.design.json`, blind: blind ?? null, classifier_version: c.version, sampled: s.rows.length, excluded: design.excluded!.answers, eligible: s.eligible, strata: s.strata }, null, 2));
  } else if (command === 'validate') {
    const labels = one('--labels');
    const designPath = args(argv, '--design')[0];
    const design = designPath ? JSON.parse(readFileSync(designPath, 'utf8')) as SampleDesign : null;
    const report = validate(readFileSync(labels, 'utf8'), design, pick(design?.classifier_version ?? CURRENT_CLASSIFIER));
    const text = JSON.stringify(report, null, 2) + '\n';
    const out = args(argv, '--out')[0];
    if (out) writeFileSync(out, text);
    process.stdout.write(text);
  } else { console.error(usage); process.exit(2); }
}

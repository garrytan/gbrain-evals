/**
 * Checks for skillopt-method-v3 (GBEV-30, plan section 3). Every check is one
 * regex that gbrain's rule judge runs with the `m` flag over the final text,
 * exactly as score.ts does, so gbrain's own rule score (the optimizers' reward)
 * and the counted score read the same checks. Each check is tagged:
 *
 *   layer substance  the facts: the value concluded, the page that decides it,
 *                    the abstention, the status of each claim part
 *   layer form       the contract's markup: the Answer line or answer-first
 *                    sentence, [Source: ...] brackets, one entry per meeting
 *                    starting with its time and title, [N] CLAIM: blocks with
 *                    one STATUS: line each, the seed's status labels
 *
 * Substance checks find their facts through loci that do not depend on
 * layout:
 *
 *   query       the first sentence that names any candidate value (the gold
 *               value or a distractor) must name the gold value, not negated
 *               or refused ("not 240", "cannot confirm 240"), and no
 *               distractor; an absent entity's abstention must come before
 *               any distractor value; an unresolvable look-alike must name
 *               every candidate and say it is ambiguous by the first sentence
 *               that names one
 *   briefing    a meeting's entry runs from a line holding its time to the
 *               next line holding another calendar time; inside it the first
 *               candidate value must be the gold one, and the gold page must
 *               be named. When no line holds the meeting's time, the text
 *               after its subject's name in the same paragraph (500
 *               characters, up to another meeting's subject or time) counts.
 *               The gold value's sentence holds no distractor either
 *   fact-check  a block runs from a "CLAIM:" line (any case, numbered or
 *               not) to the next one or the next heading. With blocks, a
 *               block's status is what its STATUS: lines give (or, with none,
 *               the first word after its CLAIM: label), and the parts
 *               it covers are the ones its CLAIM: line names (their key
 *               words). Every block that names one part must give a status the
 *               part allows, a block that names every part answers for the
 *               claim as a whole, and no such block may give a status the part
 *               rules out (any status outside the allowed ones, disputed
 *               included); without blocks, sentences take their place, with a
 *               status word wherever a status goes. A contradicted part's
 *               correct value sits in a block whose CLAIM: line names the part
 *               or on a line that names it
 *
 * Sentences end at a newline or at end punctuation followed by white space,
 * except after a listed abbreviation (BOUNDARY), and world-v3 names never hold
 * a period, so a name cannot split a sentence.
 */
import { ABSTAIN_PATTERN, ci, citationPattern, valuePattern, type Gold, type GoldValue, type Judge, type RuleCheck, type SkillName, type StatusClass } from './score.ts';

/** v3's splits: gate (the headroom gate's, plan section 4) joins train, selection and test; gate and test are sealed. */
export const SPLITS_V3 = ['train', 'sel', 'gate', 'test'] as const;
export type SplitV3 = typeof SPLITS_V3[number];

export type Layer = 'form' | 'substance';
export type V3CheckKind =
  | 'answer' | 'answer-form' | 'citation' | 'citation-form' | 'abstain' | 'abstain-form' | 'candidates' | 'ambiguous' | 'ambiguous-form'
  | 'entry-value' | 'entry-citation' | 'entry-abstain' | 'entry-form' | 'entry-citation-form' | 'entry-abstain-form'
  | 'part-status' | 'part-value' | 'blocks-form' | 'status-lines-form' | 'status-label-form' | 'correction-form';
export interface V3Check extends RuleCheck { kind: V3CheckKind; layer: Layer }

/** query: one value concluded, with the values a careless answer gives instead (superseded, not yet in force, rescinded, the wrong hop or look-alike, an informal note's). */
export interface QueryValueSpec { kind: 'value'; answer: GoldValue; distractors: GoldValue[]; cite: string[][] }
/** query: an entity no page carries; distractors are the near-miss pages' values. */
export interface QueryAbsentSpec { kind: 'absent'; name: string; distractors: GoldValue[] }
/** query: a name two pages carry; candidates tell them apart (their companies). */
export interface QueryAmbiguousSpec { kind: 'ambiguous'; name: string; candidates: GoldValue[] }
export interface MeetingSpec {
  time: string;
  /** The entry's text as the calendar lists it, after the time. */
  title: string;
  /** The account's or person's name. */
  subject: string;
  answer?: GoldValue;
  distractors: GoldValue[];
  cite?: string[];
  /** No page carries the subject: the entry says so. */
  absent?: boolean;
}
export interface BriefingSpec { kind: 'briefing'; times: string[]; meetings: MeetingSpec[] }
/** One part of a claim: the attribute it names (its key word finds the block that covers it), what the brain says of it and, when contradicted, the value the brain holds. */
export interface PartSpec { key: PartKey | null; status: StatusClass; correct?: GoldValue }
export interface FactCheckSpec { kind: 'fact-check'; status: StatusClass; parts: PartSpec[]; cite: string[][] }
export type V3Spec = QueryValueSpec | QueryAbsentSpec | QueryAmbiguousSpec | BriefingSpec | FactCheckSpec;
export interface GoldV3 extends Gold { spec: V3Spec }

// ─── Fragments ───────────────────────────────────────────────────────────────

const START = '(?<![\\s\\S])';
const alt = (xs: readonly string[]) => `(?:${xs.join('|')})`;
/** One character that does not start `stop`. */
const not = (stop: string) => `(?:(?!${stop})[\\s\\S])`;
const escapeRe = (s: string) => s.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
const slugAlt = (slugs: readonly string[]) => `(?<![\\w/-])${alt(slugs.map(s => ci(escapeRe(s))))}(?:\\.md)?(?![\\w/-])`;
const nameRe = (name: string) => valuePattern({ kind: 'name', value: name });

const ABBREVIATIONS = ['e\\.g', 'i\\.e', 'vs', 'Mr', 'Mrs', 'Ms', 'Dr', 'St', 'No', 'Inc', 'Ltd', 'Co', 'Corp', 'Jr', 'Sr', 'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Sept', 'Oct', 'Nov', 'Dec', 'approx', 'U\\.S'];
/** A sentence boundary: a newline, or end punctuation followed by white space unless it closes a listed abbreviation. */
export const BOUNDARY = `(?:\\n|(?<!\\b${alt(ABBREVIATIONS)})[.!?]+(?=\\s))`;
const NB = not(BOUNDARY);

/** A citation in either accepted form: [Source: slug] or [Source: slug, ...] (the slug may follow another inside the bracket). */
export const sourceBracket = (slugs: readonly string[]) => `\\[[^\\S\\n]*${ci('source')}[^\\S\\n]*:[^\\]\\n]*?${slugAlt(slugs)}[^\\]\\n]*\\]`;

/** The first sentence that names any of `cands` holds every `must` and none of `mustNot`. */
export function firstSentenceWith(cands: string, must: readonly string[], mustNot: readonly string[]): string {
  return `${START}(?:${not(cands)}*?${BOUNDARY})??(?=${NB}*?${cands})${must.map(m => `(?=${NB}*?${m})`).join('')}${mustNot.map(m => `(?!${NB}*?${m})`).join('')}`;
}

const AMBIGUITY = alt([
  'ambiguous', 'ambiguity', 'more than one', 'disambiguat', 'unclear which', 'not clear which', 'clarify', 'could refer to', 'could be either', 'which one',
  'which of (?:them|these|the two)', '(?:two|several|multiple) (?:different )?(?:people|persons|pages|entries|matches|records|profiles|contacts)', '(?:two|several|multiple) [A-Za-z]+ named',
].map(ci));

/** A negation or refusal directly governing `v`, at most two filler words before it: "not 240", "no longer 240", "cannot confirm the 240", "isn't 240", "never had 240". */
const NEGATION = alt(['not', 'never', 'no longer', 'cannot', 'unable to', "(?:is|are|was|were|do|does|did|has|have|had|can|could)n't"].map(ci));
const FILLER = alt(['the', 'a', 'an', 'confirm', 'verify', 'be', 'been', 'have', 'has', 'had', 'say', 'exactly', 'quite', 'actually'].map(ci));
const negated = (v: string) => `\\b${NEGATION}(?:[^\\S\\n]+${FILLER}){0,2}[^\\S\\n]+[*_"“(]*${v}`;

// ─── Statuses (fact-check) ───────────────────────────────────────────────────

export const STATUS_WORDS: Readonly<Record<StatusClass | 'disputed', readonly string[]>> = {
  supported: ['LIKELY ACCURATE', 'VERIFIED', 'ACCURATE', 'CONFIRMED', 'SUPPORTED', 'CORRECT(?![^\\S\\n]*[vV][aA][lL][uU][eE])', 'TRUE'],
  contradicted: ['LIKELY INACCURATE', 'FALSE', 'INACCURATE', 'INCORRECT', 'WRONG', 'CONTRADICTED', 'NOT ACCURATE', 'NOT CORRECT', 'NOT TRUE', 'OUTDATED', 'SUPERSEDED', 'STALE'],
  'not-supported': ['UNVERIFIED', 'UNVERIFIABLE', 'UNSUPPORTED', 'NOT VERIFIED', 'NOT SUPPORTED', 'CANNOT BE VERIFIED', "CAN'T BE VERIFIED", 'NOT IN THE BRAIN', 'NO RECORD'],
  disputed: ['DISPUTED'],
};
/** The six labels of the seed's confidence scale. */
export const SEED_STATUS_LABELS = ['VERIFIED', 'LIKELY ACCURATE', 'UNVERIFIED', 'DISPUTED', 'LIKELY INACCURATE', 'FALSE'];

const ACCEPT: Readonly<Record<StatusClass, readonly (StatusClass | 'disputed')[]>> = { supported: ['supported'], contradicted: ['contradicted'], 'not-supported': ['not-supported', 'contradicted'] };
const REJECT: Readonly<Record<StatusClass, readonly (StatusClass | 'disputed')[]>> = { supported: ['contradicted', 'not-supported', 'disputed'], contradicted: ['supported', 'not-supported', 'disputed'], 'not-supported': ['supported', 'disputed'] };

/** The first status word after a status's lead-in (white space, markup, an emoji, a level number). */
const statusWord = (classes: readonly (StatusClass | 'disputed')[]) => {
  const words = classes.flatMap(c => STATUS_WORDS[c]).map(w => (w.includes('(?') ? ci(w.slice(0, w.indexOf('('))) + w.slice(w.indexOf('(')) : ci(w)));
  return `[^\\S\\n]*[*_]*[^A-Za-z\\n]{0,8}(?:${ci('level')}[^\\S\\n]*\\d+[^A-Za-z\\n]{0,6})?${alt(words)}(?![A-Za-z])`;
};

/** A status word where a status goes: at a line start, after a colon or table bar, or after is/are/was/were; never a count ("Verified: 2"). */
export function statusToken(classes: readonly (StatusClass | 'disputed')[]): string {
  return `(?:^|[:|]|\\b${alt(['is', 'are', 'was', 'were'].map(ci))}\\b)${statusWord(classes)}(?![^\\n]{0,24}:[^\\S\\n]*\\d)`;
}

/** Claim parts a compound claim can hold, and the key word that finds the block or line covering each. */
export const PART_KEYS = {
  seats: `(?<!${ci('per')}[\\s-]|/)\\b${ci('seat')}s?\\b`,
  price: `\\b${ci('price')}`,
  discount: `(?<!${ci('before')}\\s|${ci('pre')}[\\s-])\\b${ci('discount')}`,
  notice: `\\b${ci('notice')}`,
  payment: `(?:\\b${ci('payment')}|\\b${ci('net')}[\\s-]?\\d)`,
  tier: `(?:\\b${ci('tier')}\\b|\\b${ci('support')}\\b)`,
} as const;
export type PartKey = keyof typeof PART_KEYS;

/** A fact-check block's first line: "[1] CLAIM:", "Claim 2:", "**Claim:**", "### Claim 1." (no line anchor). */
const BLOCK_START = `[^\\S\\n]*(?:[-*>#]+[^\\S\\n]*)?(?:\\*\\*|__)?(?:\\[\\d+\\][^\\S\\n]*|\\d+[.)][^\\S\\n]*)?(?:\\*\\*|__)?${ci('claim')}(?:[^\\S\\n]*\\d+)?[^\\S\\n]*(?:\\*\\*|__)?[^\\S\\n]*[:.]`;
/** One character inside the current block. */
const IN_BLOCK = `(?:(?!\\n(?:${BLOCK_START}|#{1,6}\\s))[\\s\\S])`;
const inBlock = (x: string) => `(?=${IN_BLOCK}*?${x})`;
/** `x` on the block's CLAIM: line (from a block start). */
const onClaimLine = (x: string) => `(?=[^\\n]*?${x})`;
const inSentence = (x: string) => `(?=${NB}*?${x})`;
const STATUS_LINE = `[^\\S\\n]*(?:[-*>]+[^\\S\\n]*)?(?:\\*\\*|__)?${ci('status')}(?:\\*\\*|__)?[^\\S\\n]*:`;
/** The block gives a status of `classes` (from a block start): on one of its STATUS: lines or, when it has none, as the first word after its CLAIM: label ("**Claim:** FALSE"). */
const statusLine = (classes: readonly (StatusClass | 'disputed')[]) => `(?:(?=${IN_BLOCK}*?\\n${STATUS_LINE}${statusWord(classes)})|(?!${IN_BLOCK}*?\\n${STATUS_LINE})(?=${BLOCK_START}${statusWord(classes)}))`;
const HAS_BLOCKS = `(?=[\\s\\S]*?^${BLOCK_START})`;
const NO_BLOCKS = `(?![\\s\\S]*?^${BLOCK_START})`;

// ─── Check builders ──────────────────────────────────────────────────────────

const check = (kind: V3CheckKind, layer: Layer, arg: string): V3Check => ({ op: 'regex', arg, kind, layer });

function queryChecks(spec: QueryValueSpec | QueryAbsentSpec | QueryAmbiguousSpec): V3Check[] {
  if (spec.kind === 'value') {
    const cands = alt([spec.answer, ...spec.distractors].map(valuePattern));
    const wrong = spec.distractors.length ? [alt(spec.distractors.map(valuePattern))] : [];
    return [
      check('answer', 'substance', firstSentenceWith(cands, [valuePattern(spec.answer)], [...wrong, negated(valuePattern(spec.answer))])),
      ...spec.cite.map(g => check('citation', 'substance', citationPattern('query', g))),
      check('answer-form', 'form', `${START}\\s*(?:(?:[#>*_-]|[^\\S\\n])*${ci('answer')}[*_]*[^\\S\\n]*:|${NB}*?${cands})`),
      check('citation-form', 'form', `${START}${spec.cite.map(g => `(?=[\\s\\S]*?${sourceBracket(g)})`).join('')}`),
    ];
  }
  if (spec.kind === 'absent') {
    const name = nameRe(spec.name);
    const step = spec.distractors.length ? not(alt(spec.distractors.map(valuePattern))) : '[\\s\\S]';
    return [
      check('abstain', 'substance', `${START}${step}*?(?:${name}${step}{0,300}?${ABSTAIN_PATTERN}|${ABSTAIN_PATTERN}${step}{0,300}?${name})`),
      check('abstain-form', 'form', `(?:${ci('the brain')}\\s+${alt([ci("doesn't"), ci('does not')])}\\s+${ci('have information on')}|${ci('not in the brain')}[*_]*\\s*:)\\s*[*_"“']*${name}`),
    ];
  }
  const cands = alt(spec.candidates.map(valuePattern));
  return [
    check('candidates', 'substance', `${START}${spec.candidates.map(c => `(?=[\\s\\S]*?${valuePattern(c)})`).join('')}`),
    check('ambiguous', 'substance', `${START}(?:${not(cands)}*?${AMBIGUITY}|(?:${not(cands)}*?${BOUNDARY})??(?=${NB}*?${cands})(?=${NB}*?${AMBIGUITY}))`),
    check('ambiguous-form', 'form', `^[^\\S\\n]*(?:[-*>#]+[^\\S\\n]*)?(?:\\*\\*|__)?${ci('ambiguous')}(?:\\*\\*|__)?[^\\S\\n]*:`),
  ];
}

/** A calendar time as written (09:00, 9:00, 9.00), never inside a longer number. */
const timeRe = (t: string) => { const [h, m] = t.split(':'); return `(?<![\\d:.])0?${Number(h)}[:.]${m}(?!\\d)`; };

function briefingChecks(spec: BriefingSpec): V3Check[] {
  const out: V3Check[] = [];
  for (const m of spec.meetings) {
    const others = alt(spec.times.filter(t => t !== m.time).map(timeRe));
    const otherSubjects = alt(spec.meetings.filter(x => x !== m).map(x => nameRe(x.subject)));
    /** `x` inside the meeting's entry, or, when no line holds its time, after its subject in the same paragraph; `guard` is a lookahead every character before `x` must pass. */
    const inEntry = (x: string, guard = '') => alt([
      `^[^\\n]*?${timeRe(m.time)}(?:(?!\\n[^\\n]*?${others})${guard}[\\s\\S])*?${x}`,
      `${START}(?![\\s\\S]*?${timeRe(m.time)})[\\s\\S]*?${nameRe(m.subject)}(?:(?!${otherSubjects}|${others}|\\n[^\\S\\n]*\\n)${guard}[\\s\\S]){0,500}?${x}`,
    ]);
    const wrong = m.distractors.length ? `(?!${alt(m.distractors.map(valuePattern))})` : '';
    if (m.absent) {
      out.push(check('entry-abstain', 'substance', inEntry(ABSTAIN_PATTERN, wrong)));
      out.push(check('entry-abstain-form', 'form', `${ci('no brain page for')}[^\\S\\n]*[*_"“']*${nameRe(m.subject)}`));
    } else {
      out.push(check('entry-value', 'substance', inEntry(valuePattern(m.answer!) + (m.distractors.length ? `(?!${NB}*?${alt(m.distractors.map(valuePattern))})` : ''), wrong)));
      out.push(check('entry-citation', 'substance', inEntry(slugAlt(m.cite!))));
      out.push(check('entry-citation-form', 'form', inEntry(sourceBracket(m.cite!))));
    }
    out.push(check('entry-form', 'form', `^[^\\S\\n]*(?:[-*+]|#{1,6}|\\d+[.)])?[^\\S\\n]*(?:\\*\\*|__)?\\[?${timeRe(m.time)}\\]?(?:\\*\\*|__)?[^\\S\\n]*(?:[-–—:|][^\\S\\n]*)?(?:\\*\\*|__)?\\[?${ci(escapeRe(m.title))}`));
  }
  return out;
}

function factCheckChecks(spec: FactCheckSpec): V3Check[] {
  const out: V3Check[] = [];
  const keys = spec.parts.map(p => (p.key ? PART_KEYS[p.key] : null));
  const compound = spec.parts.length > 1;
  if (compound && keys.some(k => !k)) throw new Error('fact-check: every part of a compound claim needs a key');
  spec.parts.forEach((p, i) => {
    const token = (cls: StatusClass, which: typeof ACCEPT) => statusToken(which[cls]);
    const status = (cls: StatusClass, which: typeof ACCEPT) => statusLine(which[cls]);
    let accept: string, reject: string;
    if (!compound) {
      accept = `(?:${HAS_BLOCKS}(?=[\\s\\S]*?^(?=${BLOCK_START})${status(spec.status, ACCEPT)})|${NO_BLOCKS}(?=[\\s\\S]*?${token(spec.status, ACCEPT)}))`;
      reject = `(?:${HAS_BLOCKS}(?=[\\s\\S]*?^(?=${BLOCK_START})${status(spec.status, REJECT)})|${NO_BLOCKS}(?=[\\s\\S]*?${token(spec.status, REJECT)}))`;
    } else {
      const allB = keys.map(k => onClaimLine(k!)).join('');
      const allS = keys.map(k => inSentence(k!)).join('');
      const block = (which: typeof ACCEPT) => `^(?=${BLOCK_START})(?:${onClaimLine(keys[i]!)}(?!${allB})${status(p.status, which)}|${allB}${status(spec.status, which)})`;
      const sentence = (which: typeof ACCEPT) => `(?:${START}|${BOUNDARY})(?:${inSentence(keys[i]!)}(?!${allS})${inSentence(token(p.status, which))}|${allS}${inSentence(token(spec.status, which))})`;
      accept = `(?:${HAS_BLOCKS}(?=[\\s\\S]*?${block(ACCEPT)})|${NO_BLOCKS}(?=[\\s\\S]*?${sentence(ACCEPT)}))`;
      reject = `(?:${HAS_BLOCKS}(?=[\\s\\S]*?${block(REJECT)})|${NO_BLOCKS}(?=[\\s\\S]*?${sentence(REJECT)}))`;
    }
    out.push(check('part-status', 'substance', `${START}${accept}(?!${reject})`));
    if (p.correct) {
      const v = valuePattern(p.correct);
      out.push(check('part-value', 'substance', compound ? `(?:^(?=${BLOCK_START})${onClaimLine(keys[i]!)}${inBlock(v)}|^(?=[^\\n]*?${keys[i]!})(?=[^\\n]*?${v}))` : v));
    }
  });
  for (const g of spec.cite) out.push(check('citation', 'substance', citationPattern('fact-check', g)));
  out.push(check('blocks-form', 'form', `^[^\\S\\n]*(?:[-*>]+[^\\S\\n]*)?(?:\\*\\*)?\\[\\d+\\][^\\S\\n]*(?:\\*\\*)?${ci('claim')}(?:\\*\\*)?[^\\S\\n]*:`));
  out.push(check('status-lines-form', 'form', `${START}${HAS_BLOCKS}(?![\\s\\S]*?^${BLOCK_START}${IN_BLOCK}*?\\n${STATUS_LINE}${IN_BLOCK}*?\\n${STATUS_LINE})(?![\\s\\S]*?^${BLOCK_START}(?!${IN_BLOCK}*?\\n${STATUS_LINE}))`));
  out.push(check('status-label-form', 'form', `${START}(?=[\\s\\S]*?^${STATUS_LINE})(?![\\s\\S]*?^${STATUS_LINE}(?![^\\S\\n]*[*_]*[^A-Za-z\\n]{0,8}(?:${ci('level')}[^\\S\\n]*\\d+[^A-Za-z\\n]{0,6})?${alt(SEED_STATUS_LABELS.map(ci))}(?![A-Za-z])))`));
  if (spec.parts.some(p => p.correct)) out.push(check('correction-form', 'form', `(?:^[^\\S\\n]*(?:[-*>]+[^\\S\\n]*)?(?:\\*\\*|__)?${ci('correct value')}(?:\\*\\*|__)?[^\\S\\n]*:|\\b${ci('was')}\\b[^\\n]*?\\b${ci('now')}\\b)`));
  return out;
}

/** The checks of a v3 task, compiled from its gold. */
export function compileChecksV3(skill: SkillName, gold: GoldV3): V3Check[] {
  const s = gold.spec;
  if (skill === 'query' && (s.kind === 'value' || s.kind === 'absent' || s.kind === 'ambiguous')) return queryChecks(s);
  if (skill === 'briefing' && s.kind === 'briefing') return briefingChecks(s);
  if (skill === 'fact-check' && s.kind === 'fact-check') return factCheckChecks(s);
  throw new Error(`${skill}: a ${s.kind} spec is not a ${skill} task`);
}

export const compileJudgeV3 = (skill: SkillName, gold: GoldV3): Judge => ({ kind: 'rule', checks: compileChecksV3(skill, gold) });

/**
 * The criteria text every arm's proposer reads (criteria.md), one per skill,
 * task-independent: what the substance and form checks above test, in words.
 */
export const CRITERIA_V3: Readonly<Record<SkillName, string>> = {
  query: [
    'Each task is a question to answer from the brain. Every check is either substance (the facts) or form (the layout the contract asks for). A task passes on substance when every substance check passes, and in full when every check passes.',
    'Substance:',
    '- The first sentence that names any candidate value states the value the question asks for and no other candidate. For a value as of a date, that is the value in force on that date: not one a later record set, not one a superseded or rescinded record set, not one signed but not yet in force, and not one an informal note gives against the signed record. Numbers may use separators or units; dates may use any common format that includes the year; names are matched without regard to case.',
    '- It cites, by slug, the page that decides the value: for a contract term, the record in force on the date; for a person or company reached through other pages, the page of the one the answer names.',
    '- When no page carries the entity the question names, the answer says the brain does not have it and names it, before giving any value of a near match.',
    '- When the name fits more than one entity and the question gives nothing to choose between them, the answer says it is ambiguous and names every candidate.',
    'Form:',
    '- The answer comes first, on an Answer: line or as the first sentence.',
    '- Each deciding page is cited as [Source: slug] or [Source: slug, ...].',
    '- An absent entity is reported as "the brain doesn\'t have information on <name>" or "not in the brain: <name>", and an unresolvable look-alike on an "ambiguous:" line.',
  ].join('\n'),
  briefing: [
    'Each task is a daily briefing for the meetings the task lists. Every check is either substance (the facts) or form (the layout the contract asks for). A task passes on substance when every substance check passes, and in full when every check passes.',
    'Substance:',
    '- For every external meeting, the meeting\'s entry (from its time to the next meeting\'s) states the fact the task asks for, in a sentence that names no other candidate value, and names the page that holds it: for an account\'s term, the record in force on the briefing\'s date; for a person, the person\'s own page. A fact or page named in another meeting\'s entry does not count for this one.',
    '- When an attendee has no brain page, that meeting\'s entry says so and names them, giving no value for anyone else.',
    'Form:',
    '- Each entry starts with the meeting\'s time and title as the task lists them, as a list item under MEETINGS TODAY or as a heading.',
    '- Each fact is cited as [Source: slug, updated DATE] inside its meeting\'s entry, and an attendee with no page is reported as "No brain page for <name>".',
  ].join('\n'),
  'fact-check': [
    'Each task is one brain-derived claim to verify through the data-derived-claims gate; a claim may have several parts. Every check is either substance (the facts) or form (the layout the contract asks for). A task passes on substance when every substance check passes, and in full when every check passes.',
    'Substance:',
    '- Every block (or, without blocks, every sentence) that covers one part gives a status the brain supports for that part: VERIFIED or LIKELY ACCURATE when the brain confirms it; LIKELY INACCURATE or FALSE when the brain contradicts it; UNVERIFIED, LIKELY INACCURATE or FALSE when the brain has no record of what it names. A block that covers the whole claim gives the claim\'s status, which is contradicted when any part is. Two blocks giving one part incompatible statuses fail.',
    '- For every contradicted part, the block or line that names the part states the value the brain holds as of the claim\'s date.',
    '- The report cites, by slug, the page that decides each part.',
    'Form:',
    '- The report uses the skill\'s claim-by-claim blocks: one "[N] CLAIM:" block for the claim or one per part, each with exactly one STATUS: line carrying a label of the skill\'s six-level scale.',
    '- Each correction appears as a "Correct value:" line or in the skill\'s "was X, now Y" form.',
  ].join('\n'),
};

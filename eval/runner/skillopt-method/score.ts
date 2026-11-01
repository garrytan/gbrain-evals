/**
 * Counted scorer for the SkillOpt method benchmark (GST-799, plan Phase 1).
 *
 * Every task carries a gbrain `rule` judge whose checks are regexes compiled
 * from the task's gold here, each tagged with what it checks (`kind`). The
 * counted score is binary: a rollout is correct only when every check passes.
 * gbrain's own rule judge averages the same checks into partial credit; that
 * is what gbrain's optimizer sees inside `runSkillOpt`, never a counted number.
 *
 *   value      every gold value, by a tolerant pattern: numbers with or without
 *              separators and units, dates in common formats, names in any case
 *   citation   a citation of a gold page in the skill's own citation form
 *              (`briefing`: `[Source: slug, updated DATE]`; `query` and
 *              `fact-check`: the slug itself); one check per citation group
 *              when the gold has several (skillopt-method-v2)
 *   status     fact-check only: a `STATUS:` line with a status the evidence
 *              supports (the skill's 6-level scale)
 *   no-status  fact-check only: no `STATUS:` line with a status the evidence
 *              rules out
 *   abstain    negative controls, and a v2 briefing meeting whose subject no
 *              page carries: the answer says the brain does not hold it,
 *              naming what the task asked about
 *
 * The regexes need only the `m` flag (letters match case-insensitively through
 * character classes), so gbrain's rule judge reads them exactly as this scorer
 * does. `countedScoreFn` plugs into gbrain's `scoreSkillOnTasks` `scoreFn`
 * seam. Retrieval nDCG over the slugs an answer cites is an uncounted
 * diagnostic.
 */
import type { BenchmarkTask, ScoreOnTasksOpts } from 'gbrain/core/skillopt';
import { ndcgAtK } from '../metrics.ts';

export const SKILLS = ['query', 'briefing', 'fact-check'] as const;
export type SkillName = typeof SKILLS[number];
export const SPLITS = ['train', 'sel', 'test'] as const;
export type Split = typeof SPLITS[number];

export type Judge = BenchmarkTask['judge'];
export type RuleCheck = Extract<Judge, { kind: 'rule' }>['checks'][number];
export type ScoreFn = NonNullable<ScoreOnTasksOpts['scoreFn']>;
export type Trajectory = Parameters<ScoreFn>[0];

export type GoldValue =
  | { kind: 'number'; value: number; unit?: 'days' | 'percent' | 'money' }
  | { kind: 'date'; value: string }
  | { kind: 'name'; value: string };

/** fact-check: the status class the evidence supports. */
export type StatusClass = 'supported' | 'contradicted' | 'not-supported';

export interface Gold {
  values: GoldValue[];
  /** Pages that hold the answer; citing any one counts. Empty on a negative control. */
  slugs: string[];
  /** Citation groups (skillopt-method-v2): one citation check per group, each passed by citing any page in it. Absent: one check over `slugs`. */
  cite?: string[][];
  status?: StatusClass;
  /** Negative controls, and a v2 briefing meeting no page covers: the name the task asks about; the abstention must name it within 300 characters. */
  subject?: string;
}

export type CheckKind = 'value' | 'citation' | 'status' | 'no-status' | 'abstain';
export interface MethodCheck extends RuleCheck { kind: CheckKind }

// ─── Pattern building ────────────────────────────────────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');

/**
 * Case-insensitive by construction: each ASCII letter outside a character
 * class or escape becomes `[xX]`, a space becomes `\s+` and an apostrophe
 * matches a straight or curly one.
 */
export function ci(source: string): string {
  let out = '';
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === '\\') { out += c + (source[i + 1] ?? ''); i++; continue; }
    if (inClass) { if (c === ']') inClass = false; out += c; continue; }
    if (c === '[') { inClass = true; out += c; continue; }
    if (/[a-z]/i.test(c)) out += `[${c.toLowerCase()}${c.toUpperCase()}]`;
    else if (c === ' ') out += '\\s+';
    else if (c === "'") out += "['’]";
    else out += c;
  }
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function groupedDigits(n: number): string {
  const s = String(n);
  if (s.length <= 3) return s;
  const head = s.length % 3 || 3;
  const groups = [s.slice(0, head)];
  for (let i = head; i < s.length; i += 3) groups.push(s.slice(i, i + 3));
  return groups.join("[,\\u00a0\\u202f' ]?");
}

function numberPattern(n: number, unit?: 'days' | 'percent' | 'money'): string {
  const forms = [groupedDigits(n)];
  if (n >= 1000 && n % 1000 === 0) forms.push(`${n / 1000}\\s?(?:[kK]\\b|${ci('thousand')})`);
  if (n >= 1_000_000 && n % 10_000 === 0) forms.push(`${escapeRe(String(n / 1_000_000))}\\s?(?:[mM]\\b|${ci('million')})`);
  const core = `(?<!\\d)(?<!\\d[.,])(?:${forms.join('|')})(?:\\.0+)?(?!\\d)(?![.,]\\d)`;
  if (unit === 'percent') return `${core}\\s?(?:%|${ci('percent')}|${ci('per cent')}|${ci('pct')})`;
  if (unit === 'days') return `(?:${core}\\)?\\s?-?\\s?(?:${ci('calendar ')}|${ci('business ')})?${ci('day')}|${ci('net')}[\\s-]?${n}(?!\\d))`;
  return core;
}

function datePattern(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`date gold must be YYYY-MM-DD, got ${iso}`);
  const [y, mo, d] = [m[1]!, Number(m[2]), Number(m[3])];
  const name = MONTHS[mo - 1]!;
  const month = `(?:${ci(name)}|${ci(name.slice(0, 3))}\\.?${mo === 9 ? `|${ci('Sept')}\\.?` : ''})`;
  const day = `0?${d}`;
  const ord = `(?:${ci('st')}|${ci('nd')}|${ci('rd')}|${ci('th')})?`;
  const forms = [
    `${y}[-/.]0?${mo}[-/.]${day}`,
    `0?${mo}/${day}/(?:${y}|${y.slice(2)})`,
    `${month}\\s+${day}${ord},?\\s+${y}`,
    `${day}${ord}\\s+(?:${ci('of')}\\s+)?${month},?\\s+${y}`,
  ];
  return `(?<!\\d)(?:${forms.join('|')})(?!\\d)`;
}

function namePattern(name: string): string {
  return `(?<![A-Za-z0-9])${ci(escapeRe(name.trim()).replace(/\\\./g, '\\.?'))}(?![A-Za-z0-9])`;
}

export function valuePattern(v: GoldValue): string {
  if (v.kind === 'number') return numberPattern(v.value, v.unit);
  if (v.kind === 'date') return datePattern(v.value);
  return namePattern(v.value);
}

const slugAlternation = (slugs: readonly string[]) => `(?:${slugs.map(s => ci(escapeRe(s))).join('|')})(?:\\.md)?(?![\\w/-])`;

/** A citation of any of `slugs` in the skill's own citation form. */
export function citationPattern(skill: SkillName, slugs: readonly string[]): string {
  if (skill === 'briefing') return `\\[\\s*${ci('source')}\\s*:\\s*${slugAlternation(slugs)}[^\\]\\n]*?${ci('updated')}\\s+[^\\]\\n]*[^\\]\\s][^\\]\\n]*\\]`;
  return `(?<![\\w/-])${slugAlternation(slugs)}`;
}

export const SUPPORTED_STATUSES = ['VERIFIED', 'LIKELY ACCURATE'] as const;
export const CONTRADICTED_STATUSES = ['LIKELY INACCURATE', 'FALSE'] as const;
export const UNVERIFIED_STATUSES = ['UNVERIFIED'] as const;

/** A `STATUS:` line whose first status label (after any emoji or level number) is one of `labels`. */
export function statusPattern(labels: readonly string[]): string {
  return `${ci('status')}[*_ ]*:[*_ ]*[^A-Za-z\\n]*(?:${ci('level')}\\s*\\d+[^A-Za-z\\n]*)?(?:${labels.map(ci).join('|')})(?![A-Za-z])`;
}

/** Matches only when `pattern` occurs nowhere in the text (anchored at the start, whatever the flags). */
const absent = (pattern: string) => `(?<![\\s\\S])(?![\\s\\S]*${pattern})`;

const ABSTAIN_PHRASES = [
  "(?:does|do)(?:n't| not) (?:have|hold|contain|include|record|mention|list)",
  '(?:has|have|had|holds?|contains?) no (?:[a-zA-Z]+ )?(?:pages?|information|info|records?|data|notes?|entr(?:y|ies)|mentions?|details|contracts?|evidence)',
  'no (?:brain )?(?:pages?|information|info|records?|data|notes|entr(?:y|ies)|mentions?|results?|match(?:es)?|evidence|contracts?) (?:for|on|about|of|mention|match|exists?|was|were|in)',
  'not (?:in|found in|present in|recorded in|stored in|captured in|mentioned in|covered in|covered by) (?:the |your |this )?(?:brain|notes|knowledge base)',
  "(?:could|can)(?:n't|not| not) (?:find|locate|confirm|verify)",
  'unable to (?:find|locate|confirm|verify)',
  "i (?:don't|do not) know",
  '(?:is|are|was|were) not (?:recorded|documented|mentioned|available)',
  'nothing (?:in|about|on) ',
];

/** The answer says the brain does not hold what was asked. */
export const ABSTAIN_PATTERN = `(?:${ABSTAIN_PHRASES.map(ci).join('|')})`;

/**
 * The checks for one task. A negative control (no gold slug) asks for an
 * abstention; for fact-check it asks for a status the brain cannot support.
 * A query or briefing task with a `subject` and gold pages asks for both: the
 * answered parts, and an abstention for the subject.
 */
export function compileChecks(skill: SkillName, gold: Gold): MethodCheck[] {
  const checks: MethodCheck[] = [];
  if (skill === 'fact-check') {
    const status = gold.status ?? 'not-supported';
    const accept = status === 'supported' ? SUPPORTED_STATUSES : status === 'contradicted' ? CONTRADICTED_STATUSES : [...UNVERIFIED_STATUSES, ...CONTRADICTED_STATUSES];
    checks.push({ op: 'regex', arg: statusPattern(accept), kind: 'status' });
    const reject = status === 'supported' ? [...CONTRADICTED_STATUSES, ...UNVERIFIED_STATUSES] : status === 'not-supported' ? [...SUPPORTED_STATUSES] : [];
    if (reject.length) checks.push({ op: 'regex', arg: absent(statusPattern(reject)), kind: 'no-status' });
  } else if (gold.slugs.length === 0 || gold.subject) {
    const name = gold.subject ? namePattern(gold.subject) : null;
    checks.push({ op: 'regex', arg: name ? `(?:${name}[\\s\\S]{0,300}?${ABSTAIN_PATTERN}|${ABSTAIN_PATTERN}[\\s\\S]{0,300}?${name})` : ABSTAIN_PATTERN, kind: 'abstain' });
  }
  for (const v of gold.values) checks.push({ op: 'regex', arg: valuePattern(v), kind: 'value' });
  for (const group of gold.cite ?? (gold.slugs.length ? [gold.slugs] : [])) checks.push({ op: 'regex', arg: citationPattern(skill, group), kind: 'citation' });
  return checks;
}

export function compileJudge(skill: SkillName, gold: Gold): Judge {
  return { kind: 'rule', checks: compileChecks(skill, gold) };
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

function checkPasses(text: string, check: RuleCheck): boolean {
  if (typeof check.arg !== 'string') return false;
  if (check.op === 'contains') return text.includes(check.arg);
  if (check.op !== 'regex') return false;
  try {
    return new RegExp(check.arg, 'm').test(text);
  } catch {
    return false;
  }
}

export interface CheckResult { correct: boolean; failed: RuleCheck[] }

/** Binary verdict: correct only when the judge has checks and every one passes. */
export function evaluateJudge(text: string, judge: Judge): CheckResult {
  if (judge.kind !== 'rule' || judge.checks.length === 0) return { correct: false, failed: [] };
  const failed = judge.checks.filter(c => !checkPasses(text, c));
  return { correct: failed.length === 0, failed };
}

/** gbrain's `scoreSkillOnTasks` `scoreFn` seam: 1 when every check passes, else 0. */
export const countedScoreFn: ScoreFn = async (trajectory, judge) => ({
  trajectory,
  score: evaluateJudge(trajectory.final_text, judge).correct ? 1 : 0,
});

/** Slug prefixes of the two corpora the tasks draw on (messy-company-v1 page kinds, world-v1 page types). */
export const CORPUS_SLUG_PREFIXES = ['accounts', 'agent-notes', 'chats', 'contracts', 'crm', 'emails', 'meetings', 'notes', 'tickets', 'updates', 'companies', 'concepts', 'people'];
const SLUG_RE = new RegExp(`(?<![\\w/-])(?:${CORPUS_SLUG_PREFIXES.join('|')})/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?![\\w/-])`, 'gi');

/** Corpus slugs the answer names, lowercased, in order of first appearance. */
export function citedSlugs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SLUG_RE)) {
    const slug = m[0].toLowerCase();
    if (!out.includes(slug)) out.push(slug);
  }
  return out;
}

/** Uncounted diagnostic: nDCG@k of the cited slugs against the gold pages (binary grades); null on a negative control. */
export function citationNdcg(text: string, goldSlugs: readonly string[], k = 10): number | null {
  if (goldSlugs.length === 0) return null;
  return ndcgAtK(citedSlugs(text), new Map(goldSlugs.map(s => [s, 1])), k);
}

// ─── What arms may see ───────────────────────────────────────────────────────

const FAILED_CHECK_TEXT: Record<CheckKind, string> = {
  value: 'a required value is missing, or is not stated in a recognizable form',
  citation: "the answer does not cite the brain page that holds the answer, in the skill's citation form",
  status: 'no STATUS line gives the status the brain evidence supports',
  'no-status': 'a STATUS line gives a status the brain evidence rules out',
  abstain: 'the answer does not say that the brain lacks this information',
};

/** A failed check described without its argument, so no gold value or slug reaches an optimizer. */
export function renderFailedCheck(check: RuleCheck): string {
  const kind = (check as Partial<MethodCheck>).kind;
  return kind && kind in FAILED_CHECK_TEXT ? FAILED_CHECK_TEXT[kind] : 'a scoring check failed';
}

/**
 * The success criteria each arm is given: one text per skill, identical for
 * every arm and every task, written from the judge templates above. It holds
 * no gold value and no slug.
 */
export const CRITERIA: Readonly<Record<SkillName, string>> = {
  query: [
    'Each task is a question to answer from the brain. An answer counts as correct only when every check passes:',
    '- It states every value the question asks for. Numbers may use separators, units or "k"; dates may use any common format that includes the year; names are matched without regard to case.',
    '- It cites, by its slug (for example [Source: <slug>]), a brain page that holds the answer. Citing only a page that does not hold the answer fails.',
    '- When the brain does not hold the answer, the correct answer says so and names what it looked for (for example "the brain doesn\'t have information on X") instead of giving a value.',
    'Scoring is all or nothing per task.',
  ].join('\n'),
  briefing: [
    'Each task is a daily briefing for the meetings listed in the task. An answer counts as correct only when every check passes:',
    '- For the meeting the task asks about, it states every fact the task asks for. Numbers may use separators or units; dates may use any common format that includes the year; names are matched without regard to case.',
    '- It cites the brain page that holds that fact inline as [Source: slug, updated DATE]. Other citation forms, or citing only a page that does not hold the fact, fail.',
    '- When a participant has no brain page, the correct briefing says so (for example "No brain page for <name>") instead of describing them.',
    'Scoring is all or nothing per task.',
  ].join('\n'),
  'fact-check': [
    'Each task is one brain-derived claim to verify through the data-derived-claims gate. An answer counts as correct only when every check passes:',
    '- A STATUS: line gives the status the brain supports: VERIFIED or LIKELY ACCURATE when the brain confirms the claim; LIKELY INACCURATE or FALSE when the brain contradicts it; UNVERIFIED, LIKELY INACCURATE or FALSE when the brain has no record of what the claim names.',
    '- A confirmed claim carries no STATUS line of LIKELY INACCURATE, FALSE or UNVERIFIED; a claim the brain cannot support carries no STATUS line of VERIFIED or LIKELY ACCURATE.',
    '- A contradicted claim states the correct value the brain holds. Numbers may use separators or units; dates may use any common format that includes the year; names are matched without regard to case.',
    '- The report cites, by its slug, the brain page that decides the claim. Citing only a page that does not decide it fails.',
    'Scoring is all or nothing per task.',
  ].join('\n'),
};

/**
 * The criteria texts for skillopt-method-v2, whose tasks ask for more than one
 * value, go through superseded records and linked pages, and mix answered and
 * unanswerable meetings. Same rules as CRITERIA: no gold value, no slug.
 */
export const CRITERIA_V2: Readonly<Record<SkillName, string>> = {
  query: [
    'Each task is a question to answer from the brain. An answer counts as correct only when every check passes:',
    '- It states every value the question asks for. Numbers may use separators, units or "k"; dates may use any common format that includes the year; names are matched without regard to case.',
    '- It cites, by its slug (for example [Source: <slug>]), the brain page that decides each value it states. For a value as of a date, that is the record in force on that date, not a record it superseded and not one signed but not yet in force. For a person or company reached through other pages, it is the page of the person or company the answer names. Citing only a page that does not decide the answer fails.',
    '- When the brain does not hold the answer, the correct answer says so and names what it looked for (for example "the brain doesn\'t have information on X") instead of giving a value.',
    'Scoring is all or nothing per task.',
  ].join('\n'),
  briefing: [
    'Each task is a daily briefing for the meetings listed in the task. An answer counts as correct only when every check passes:',
    '- For every external meeting the task lists, it states the fact the task asks for. An account\'s value is the one in force on the briefing\'s date. Numbers may use separators or units; dates may use any common format that includes the year; names are matched without regard to case.',
    '- It cites inline as [Source: slug, updated DATE] a brain page that holds each fact: for an account\'s value, the record in force on the briefing\'s date; for a person, the person\'s own page. Other citation forms, or citing only a page that does not hold the fact, fail.',
    '- When a participant has no brain page, the correct briefing says so for that meeting (for example "No brain page for <name>") instead of describing them, and still covers every other meeting.',
    'Scoring is all or nothing per task.',
  ].join('\n'),
  'fact-check': [
    'Each task is one brain-derived claim to verify through the data-derived-claims gate. A claim may state more than one value. An answer counts as correct only when every check passes:',
    '- A STATUS: line gives the status the brain supports: VERIFIED or LIKELY ACCURATE when the brain confirms every part of the claim; LIKELY INACCURATE or FALSE when the brain contradicts any part of it; UNVERIFIED, LIKELY INACCURATE or FALSE when the brain has no record of what the claim names or does not support it.',
    '- A confirmed claim carries no STATUS line of LIKELY INACCURATE, FALSE or UNVERIFIED; a claim the brain cannot support carries no STATUS line of VERIFIED or LIKELY ACCURATE.',
    '- A contradicted claim states, for every value the claim gives, the correct value the brain holds as of the claim\'s date. Numbers may use separators or units; dates may use any common format that includes the year; names are matched without regard to case.',
    '- The report cites, by its slug, the brain page that decides each part of the claim; for a value as of a date, that is the record in force on that date. Citing only a page that does not decide it fails.',
    'Scoring is all or nothing per task.',
  ].join('\n'),
};

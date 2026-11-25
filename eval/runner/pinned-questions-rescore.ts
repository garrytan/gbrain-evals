/**
 * Pinned questions, rescore under the both-value rule: re-judges the counted run's refreshed answers with a judge
 * prompt that says how to label an answer giving a claim's current value and another value together (preregistration
 * amendment "Rescore under a rule for answers that give both values", 2026-11-24). The rule was written after the
 * counted labels were seen, so the rescored column sits beside the preregistered numbers and replaces none of them.
 *
 * Judge-only: no model under test is asked anything, and each answer goes to the judge that graded it (judgeFor, never
 * its own family, never particle-1). In order, inside one paid process:
 *   1. The agreement gate. Both judges grade the template answers of the both-value set (bothValueItems, on the
 *      judge-check seeds); each counted answer that names both values is graded by its own judge; all are labelled by
 *      the frozen pattern (bothValuePattern, no model in its chain), and undecided items are left out. Each judge also
 *      re-grades the judge-check stage's
 *      unambiguous outputs and stale probes with the new prompt against their rule labels. Every judge needs Cohen's
 *      kappa of at least JUDGE_KAPPA_FLOOR on at least JUDGE_MIN_LABELS labels on each set; a judge that fails stops
 *      the stage before any counted answer is re-judged.
 *   2. Every counted row whose refresh published and was scored is re-judged with the new prompt. A row the counted
 *      run scored as not published or left out keeps that result.
 *
 * The inputs are the published receipts, named by sha256 (RESCORE_INPUTS, from docs/benchmarks/pinned-questions/
 * manifest.json). A directory where a rescore already started is refused without --resume, so it is never paid for
 * twice by accident.
 *
 * Usage: bun eval/runner/pinned-questions-rescore.ts --counted <receipt.counted.json> --judge-check <receipt.judge-check.json>
 *   --stale-probes <receipt.stale-probes.json> --output <dir> [--resume] [--gbrain <checkout>[@ref]] --paid --budget-run-id ID
 * Every graded call is appended to rescore.ndjson in --output as it comes in; --resume continues a stage a crash or the
 * budget ledger stopped, asking only the calls the journal does not hold (and any failed judge call).
 */
import './budget-ledger.ts';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { budgetOptionsFrom, chatPrice, receiptCost, startPaidRun, type RunSummary } from './budget-ledger.ts';
import { gbrainSpecFrom, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { gbrainPin } from './gbrain-version.ts';
import { PaidArmRefusal } from './paid-arm.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, noModelSpend, sourceTreeIdentity, writeReceipt, type Receipt } from './receipt.ts';
import {
  CATEGORY, EST_TOKENS, JUDGE_CALLS_PER_ANSWER, JUDGE_KAPPA_FLOOR, JUDGE_MAX_TOKENS, JUDGE_MIN_LABELS, PAID_KEY_NAMES, PINNED_QUESTIONS_JUDGES,
  PINNED_QUESTIONS_JUDGE_PROMPT, combinedCost, gradeAnswer, recordProcessCost, recordProcessStart, judgeAgreement, judgeFor, measuredJudge, noUsage, outcomeOf, readCheckpoint, refreshComparisons, requirePaidFlags,
  requireProviderKeys, ruleLabels, scoredCorrect, withGateway, type Agreement, type GradedAnswer, type Judged, type PaidMode, type PaidRow, type StaleProbe,
} from './pinned-questions-paid.ts';
import { claimSentence } from './pinned-questions.ts';
import { CLAIMS, generatePinnedQuestionsWorld, type Claim, type MutationClass, type PqCompany, type PqWorld } from '../generators/pinned-questions-gen.ts';

export const RESCORE_STAGE = 'rescore';

const FROZEN = PINNED_QUESTIONS_JUDGE_PROMPT.split('\n');
/**
 * The frozen judge prompt with its "correct" and "wrong" lines replaced by the both-value rule; every other line is
 * unchanged. An answer may name both values only if it says, in its own words, which one is current.
 */
export const PINNED_QUESTIONS_RESCORE_PROMPT = [
  FROZEN[0], FROZEN[1],
  '- correct: the answer states the key\'s current value as the claim\'s current value, in its own words. It may also name the previous value, but only as a former or superseded value (for example "moved there from X", "previously X", "X is out of date"); an ordering it hedges, such as "which the note appears to supersede", still says which value is current.',
  FROZEN[3],
  '- wrong: the answer gives some other value, or gives the current value and another value without saying in its own words which one is current. Reporting what each source says ("a note says Y; the page still says X"), even with words such as "later" or "still", does not say which is current, and neither does saying that it is unclear.',
  ...FROZEN.slice(5),
].join('\n');
export const rescorePromptSha256 = () => createHash('sha256').update(PINNED_QUESTIONS_RESCORE_PROMPT).digest('hex');

/** The published receipts this stage reads, by sha256 (docs/benchmarks/pinned-questions/manifest.json). */
export const RESCORE_INPUTS = {
  counted: '7fc7e604a7facfb5609bc32b61a66047e9e3ba854c6b47c5f58506ca71161074',
  'judge-check': '9bc99103e79211b7b53d5e6e669834f3b4f660193d2ddd5d565d97e206815533',
  'stale-probes': '1d9dac73f29489b1ee3970ae49ceef1b7266deaff0b1e4142905bf8b950984b5',
} as const;
export type RescoreInputName = keyof typeof RESCORE_INPUTS;

/**
 * The frozen pattern that labels an answer naming a changed claim's current value (now) and previous value (was)
 * together (preregistration amendment of 2026-11-24, "The pattern"). No model is in its chain. The answer is split into
 * sentences, and each sentence into clauses at , ; : ( and ).
 * - A value is marked not current by "from <value>", or by a NOT_CURRENT word in a clause that names that value alone,
 *   or, when the word's clause names neither value, in the nearest earlier clause of the same sentence that names one
 *   value alone (so "..., which the note appears to supersede" marks the value just before it).
 * - The answer's own voice in a sentence is its clauses before the first clause with an ATTRIBUTION word (says,
 *   according to, lists ...); a sentence whose first clause attributes has none. In the own voice, "moved ... to
 *   <value>" or "now ... <value>", or "moved" or "now" where the own voice names one value alone (not as "from <value>"),
 *   marks that value current, and so the other value not current.
 * - A sentence's first clause, when it is own voice, has no NOT_CURRENT word and names one value alone, is the value the
 *   answer states: it marks the other value not current ("X builds P in N, according to a note ..." states N).
 * - An UNCERTAIN word, or "<one value> or <the other>", says the answer can't tell.
 * Correct: the previous value is marked not current, the current one is not, and nothing says the answer can't tell.
 * Undecided: both values are marked not current, or the previous one is marked and the answer also says it can't tell,
 * or the answer doesn't name both values. Not correct: everything else (no ordering of its own, or the current value
 * marked not current).
 */
const NOT_CURRENT = /\b(previously|formerly|former|used to|out of date|outdated|no longer|supersedes?|superseded|superseding|predates?|predated|predating|corrected|mistaken|an error|erroneous)\b/i;
const ATTRIBUTION = /\b(says?|said|according to|reports?|reported|states?|stated|lists?|listed|notes? that|records? that|claims?|claimed)\b/i;
const UNCERTAIN = /\b(unclear|uncertain|disagree|disagrees|not clear|cannot tell|can't tell|either)\b/i;
export type PatternLabel = 'correct' | 'not_correct' | 'undecided';

const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const has = (v: string, text: string) => new RegExp(`(^|[^A-Za-z0-9])${escapeRe(v)}([^A-Za-z0-9]|$)`).test(text);

export function bothValuePattern(text: string, was: string, now: string): PatternLabel {
  if (!has(was, text) || !has(now, text)) return 'undecided';
  const notCurrent = new Set<string>();
  for (const v of [was, now]) if (new RegExp(`\\bfrom\\s+${escapeRe(v)}([^A-Za-z0-9]|$)`).test(text)) notCurrent.add(v);
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const clauses = sentence.split(/[,;:()]/);
    const alone = (clause: string) => { const vs = [was, now].filter(v => has(v, clause)); return vs.length === 1 ? vs[0]! : vs.length === 2 ? 'both' : null; };
    clauses.forEach((clause, i) => {
      if (!NOT_CURRENT.test(clause)) return;
      let target = alone(clause);
      for (let j = i - 1; target === null && j >= 0; j--) target = alone(clauses[j]!);
      if (target && target !== 'both') notCurrent.add(target);
    });
    const pieces = sentence.split(/(?=[,;:()])/);
    const cut = pieces.findIndex(piece => ATTRIBUTION.test(piece));
    const voice = (cut === -1 ? pieces : pieces.slice(0, cut)).join('');
    const stated = cut === 0 || NOT_CURRENT.test(pieces[0]!) ? null : alone(pieces[0]!);
    if (stated && stated !== 'both') notCurrent.add(stated === was ? now : was);
    for (const v of [was, now]) {
      const e = escapeRe(v);
      const own = alone(voice) === v && /\b(moved|now)\b/i.test(voice) && !new RegExp(`\\bfrom\\s+${e}([^A-Za-z0-9]|$)`).test(voice);
      if (own || new RegExp(`\\bmoved\\b[^.;]*?\\bto\\s+${e}([^A-Za-z0-9]|$)`).test(voice) || new RegExp(`\\bnow\\b[^.;]*?(^|[^A-Za-z0-9])${e}([^A-Za-z0-9]|$)`).test(voice)) notCurrent.add(v === was ? now : was);
    }
  }
  const uncertain = UNCERTAIN.test(text) || new RegExp(`${escapeRe(was)}\\s+or\\s+${escapeRe(now)}|${escapeRe(now)}\\s+or\\s+${escapeRe(was)}`).test(text);
  if (notCurrent.has(was) && (notCurrent.has(now) || uncertain)) return 'undecided';
  return notCurrent.has(was) ? 'correct' : 'not_correct';
}

/**
 * The pattern's label for a whole answer whose changed claim is `claim`: true when the pattern finds that claim correct
 * and every other claim's token rule label is correct, false when either is not, null (undecided, left out of the
 * kappa) when the pattern is undecided or another claim's rule label is ambiguous.
 */
export function bothValueLabel(c: PqCompany, claim: Claim, sentences: readonly string[]): boolean | null {
  const rule = ruleLabels(c, 'refreshed', sentences);
  const others = CLAIMS.filter(k => k !== claim).map(k => rule[k]);
  if (others.includes('ambiguous')) return null;
  const p = bothValuePattern(sentences.join(' '), c.before[claim], c.after[claim]!);
  if (p === 'undecided') return null;
  return p === 'correct' && others.every(l => l === 'correct');
}

/**
 * One template for a changed claim: an answer sentence naming the previous value (was) beside the current one (now).
 * `intended` is what it was written to show; the label that counts is the pattern's (bothValueLabel), and a test
 * checks that the two agree for every template.
 */
interface Template { id: string; intended: boolean; text: (c: PqCompany, was: string, now: string) => string }
export const BOTH_VALUE_TEMPLATES: Record<'city' | 'founded', { correct: Template[]; not_correct: Template[] }> = {
  city: {
    correct: [
      { id: 'city-moved-from', intended: true, text: (c, was, now) => `${c.name} builds its ${c.product} in ${now}, having moved all production there from ${was}.` },
      { id: 'city-used-to', intended: true, text: (c, was, now) => `${c.name} now builds ${c.product} in ${now}; it used to build them in ${was}.` },
      { id: 'city-out-of-date', intended: true, text: (c, was, now) => `${c.name} builds ${c.product} in ${now}. The company page still lists ${was}, but that is out of date.` },
      { id: 'city-former', intended: true, text: (c, was, now) => `A press note says ${c.name} moved all production of its ${c.product} to ${now}, so ${c.name} now builds ${c.product} in ${now}; ${was} is its former location.` },
      { id: 'city-from-to', intended: true, text: (c, was, now) => `${c.name} moved production of its ${c.product} from ${was} to ${now}, where it builds them now.` },
      { id: 'city-hedged-order', intended: true, text: (c, was, now) => `A press note says ${c.name} moved all production of its ${c.product} to ${now}; the company page still says ${was}, which the press note appears to supersede.` },
    ],
    not_correct: [
      { id: 'city-sources-only', intended: false, text: (c, was, now) => `A press note says ${c.name} moved all production of its ${c.product} to ${now}. The ${c.name} company page still says ${c.name} builds ${c.product} in ${was}.` },
      { id: 'city-later-note', intended: false, text: (c, was, now) => `The company page says ${c.name} builds ${c.product} in ${was}, and a later note says production moved to ${now}.` },
      { id: 'city-unclear', intended: false, text: (c, was, now) => `The notes disagree on where ${c.name} builds its ${c.product}: ${was} or ${now}, and it is unclear which is current.` },
      { id: 'city-both-current', intended: false, text: (c, was, now) => `${c.name} builds ${c.product} in ${was} and in ${now}.` },
      { id: 'city-keeps-previous', intended: false, text: (c, was, now) => `${c.name} builds ${c.product} in ${was}; a note about a move to ${now} looks mistaken.` },
    ],
  },
  founded: {
    correct: [
      { id: 'founded-superseded', intended: true, text: (c, was, now) => `${c.name} was founded in ${now}, a record that superseded an earlier entry giving ${was}.` },
      { id: 'founded-corrected', intended: true, text: (c, was, now) => `${c.name} was founded in ${now}; an older record giving ${was} has been corrected.` },
      { id: 'founded-out-of-date', intended: true, text: (c, was, now) => `${c.name} was founded in ${now} (the ${was} date in an earlier record is out of date).` },
    ],
    not_correct: [
      { id: 'founded-two-records', intended: false, text: (c, was, now) => `One record says ${c.name} was founded in ${was} and another says ${now}.` },
      { id: 'founded-disagree', intended: false, text: (c, was, now) => `${c.name} was founded in ${was} or ${now}; the records disagree.` },
      { id: 'founded-keeps-previous', intended: false, text: (c, was, now) => `${c.name} was founded in ${was}; a record giving ${now} appears to be an error.` },
    ],
  },
};

/**
 * One answer of the both-value set: a template answer (graded by both judges) or a counted answer that names both values
 * (graded by its own judge), with the pattern's label; null is undecided.
 */
export interface BothValueItem { source: 'template' | 'counted'; seed: number; company: string; claim: Claim; template: string | null; model: string | null; label: boolean | null; sentences: string[] }

/**
 * The template half of the both-value set: for every company whose change moved its city or founding year, four
 * answers that state the other claims' current values and give the changed claim's current and previous values
 * together, two written to be correct and two not, the templates taken in turn so each is used about equally.
 */
export function bothValueItems(worlds: readonly PqWorld[]): BothValueItem[] {
  const items: BothValueItem[] = [];
  let i = 0;
  for (const w of worlds) for (const c of w.companies) {
    const claim = c.affected.length === 1 && (c.affected[0] === 'city' || c.affected[0] === 'founded') ? c.affected[0] : null;
    if (!claim || c.after[claim] === null) continue;
    const { correct, not_correct } = BOTH_VALUE_TEMPLATES[claim];
    const picks = [correct[i % correct.length]!, correct[(i + Math.floor(correct.length / 2)) % correct.length]!, not_correct[i % not_correct.length]!, not_correct[(i + Math.floor(not_correct.length / 2)) % not_correct.length]!];
    for (const t of picks) {
      const sentences = CLAIMS.map(k => (k === claim ? t.text(c, c.before[claim], c.after[claim]!) : claimSentence(c, k, c.after[k]!)));
      items.push({ source: 'template', seed: w.seed, company: c.slug, claim, template: t.id, model: null, label: bothValueLabel(c, claim, sentences), sentences });
    }
    i++;
  }
  return items;
}

/** A judge-check output or stale probe with an unambiguous rule label, to be graded again with the new prompt. */
export interface RecheckItem { source: 'judge-check-first' | 'judge-check-refreshed' | 'stale-probe'; model: string; seed: number; company: string; judge_model: string; kind: 'first' | 'refreshed'; sentences: string[]; rule_correct: boolean }

interface Read { rows: PaidRow[]; probes: StaleProbe[]; worlds: Map<number, PqWorld>; gbrain_version?: string; overlay: unknown }
export interface RescoreInputs { counted: Read; judgeCheck: Read; probes: StaleProbe[]; sha256: Record<RescoreInputName, string> }

/**
 * The published counted, judge-check and stale-probes receipts, each matching its expected sha256, paid, completed and
 * publishable, on the build under test (so the judge route matches the original grading), with every world
 * regenerating to its recorded fingerprint, every row and probe naming a company in it and judged by its family's
 * judge, and the stale probes naming that judge-check receipt.
 */
export function readRescoreInputs(paths: Record<RescoreInputName, string | undefined>, opts: { gut: GbrainUnderTest; expected?: Record<RescoreInputName, string> }): RescoreInputs {
  const expected = opts.expected ?? RESCORE_INPUTS;
  const sha256 = {} as Record<RescoreInputName, string>;
  const read = (name: RescoreInputName): Read => {
    const refuse = (why: string): never => { throw new PaidArmRefusal(`${CATEGORY} rescore: the published ${name} receipt (--${name}): ${why}`); };
    const path = paths[name];
    if (!path) return refuse('none given');
    if (!existsSync(path)) return refuse(`${path} does not exist`);
    const bytes = readFileSync(path);
    sha256[name] = createHash('sha256').update(bytes).digest('hex');
    if (sha256[name] !== expected[name]) return refuse(`${path} has sha256 ${sha256[name]}, not the published ${expected[name]}`);
    const r = JSON.parse(bytes.toString('utf8')) as { category?: string; run_status?: string; publishable?: boolean; gbrain_version?: string; hashes?: Record<string, string>; resolved_config?: { mode?: string; stage?: string; seeds?: number[]; companies_per_seed?: number; judge_check_receipt_sha256?: string | null; gbrain_overlay?: unknown }; data?: { rows?: PaidRow[]; probes?: StaleProbe[] } };
    const c = r.resolved_config;
    if (r.category !== CATEGORY || c?.stage !== name || c.mode !== 'paid') return refuse(`${path} is not a paid ${CATEGORY} ${name} receipt`);
    if (r.run_status !== 'completed' || r.publishable !== true) return refuse(`its run_status is ${r.run_status} and publishable ${r.publishable}`);
    if (r.gbrain_version !== opts.gut.version || JSON.stringify(c.gbrain_overlay ?? null) !== JSON.stringify(overlaySummary(opts.gut) ?? null)) return refuse(`it measured gbrain ${r.gbrain_version}, not the build under test (${opts.gut.version})`);
    const worlds = new Map((c.seeds ?? []).map(seed => [seed, generatePinnedQuestionsWorld({ seed, companies: c.companies_per_seed })] as const));
    for (const [seed, w] of worlds) if (r.hashes?.[`ledger_seed_${seed}`] !== w.fingerprint) return refuse(`seed ${seed}'s world does not regenerate to the fingerprint it records`);
    const rows = r.data?.rows ?? [], probes = r.data?.probes ?? [];
    for (const x of [...rows, ...probes]) if (x.judge_model !== judgeFor(x.model)) return refuse(`${x.model} seed ${x.seed} ${x.company} was judged by ${x.judge_model}, not ${judgeFor(x.model)}`);
    for (const x of rows) if (!worlds.get(x.seed)?.companies.some(k => k.slug === x.company)) return refuse(`row ${x.model} seed ${x.seed} ${x.company} names no company in its recorded worlds`);
    if (name === 'stale-probes' && c.judge_check_receipt_sha256 !== sha256['judge-check']) return refuse('it was made from a different judge-check receipt');
    return { rows, probes, worlds, gbrain_version: r.gbrain_version, overlay: c.gbrain_overlay };
  };
  const counted = read('counted');
  const judgeCheck = read('judge-check');
  const probes = read('stale-probes').probes;
  for (const p of probes) if (!judgeCheck.worlds.get(p.seed)?.companies.some(k => k.slug === p.company)) throw new PaidArmRefusal(`${CATEGORY} rescore: stale probe ${p.model} seed ${p.seed} ${p.company} names no company in the judge-check worlds`);
  return { counted, judgeCheck, probes, sha256 };
}

const companyOf = (worlds: Map<number, PqWorld>, seed: number, slug: string): PqCompany => worlds.get(seed)!.companies.find(c => c.slug === slug)!;

/** A counted row the rescore re-judges: its refresh published and the counted run scored it. */
export const rejudged = (r: PaidRow) => scoredCorrect(r) !== null && outcomeOf(r.refresh) === 'published';

/** The claim a counted refreshed answer gives both values of: its one changed city or founding year, when that claim's rule label is ambiguous. */
const bothValueClaim = (r: PaidRow): Claim | null => (r.affected.length === 1 && (r.affected[0] === 'city' || r.affected[0] === 'founded') && r.refreshed.rule_labels[r.affected[0]] === 'ambiguous' ? r.affected[0] : null);

/** The counted half of the both-value set: every re-judged counted answer that names both values of its changed claim, with the pattern's label. */
export function countedBothValueItems(rows: readonly PaidRow[], worlds: Map<number, PqWorld>): BothValueItem[] {
  return rows.filter(rejudged).flatMap(r => {
    const claim = bothValueClaim(r);
    if (!claim) return [];
    return [{ source: 'counted' as const, seed: r.seed, company: r.company, claim, template: null, model: r.model, label: bothValueLabel(companyOf(worlds, r.seed, r.company), claim, r.refreshed.sentences), sentences: r.refreshed.sentences }];
  });
}

export interface RescorePlan { bothValue: BothValueItem[]; countedBothValue: BothValueItem[]; recheck: RecheckItem[]; counted: PaidRow[] }

/** Every judge call the stage makes, before any is made: the gate's two sets, then the counted rows it re-judges. */
export function rescorePlan(inputs: RescoreInputs): RescorePlan {
  const recheck: RecheckItem[] = [
    ...inputs.judgeCheck.rows.flatMap(r => ([['first', r.first], ['refreshed', r.refreshed]] as const).filter(([, g]) => g.rule_correct !== null).map(([kind, g]) => ({
      source: kind === 'first' ? 'judge-check-first' as const : 'judge-check-refreshed' as const, model: r.model, seed: r.seed, company: r.company, judge_model: r.judge_model, kind, sentences: g.sentences, rule_correct: g.rule_correct!,
    }))),
    ...inputs.probes.filter(p => p.graded.rule_correct !== null).map(p => ({ source: 'stale-probe' as const, model: p.model, seed: p.seed, company: p.company, judge_model: p.judge_model, kind: 'refreshed' as const, sentences: p.graded.sentences, rule_correct: p.graded.rule_correct! })),
  ];
  return { bothValue: bothValueItems([...inputs.judgeCheck.worlds.values()]), countedBothValue: countedBothValueItems(inputs.counted.rows, inputs.counted.worlds), recheck, counted: inputs.counted.rows.filter(rejudged) };
}

/** Ledger estimate in dollars: every planned judge call (both judges on each both-value item) at the judge's measured output and calls per answer, else its worst case. */
export function rescoreEstimateUsd(plan: RescorePlan, judge: { outputTokens: number; callsPerAnswer: number } | null): number {
  const judges: string[] = [...plan.bothValue.flatMap(() => PINNED_QUESTIONS_JUDGES), ...plan.recheck.map(x => x.judge_model), ...plan.counted.map(r => r.judge_model)];
  return judges.reduce((sum, j) => {
    const p = chatPrice(j);
    if (!p) throw new Error(`${j} has no ledger price; register one in eval/runner/budget-ledger.ts`);
    return sum + (judge?.callsPerAnswer ?? JUDGE_CALLS_PER_ANSWER) * (EST_TOKENS.judge.input * p.input + (judge?.outputTokens ?? EST_TOKENS.judge.output) * p.output) / 1e6;
  }, 0);
}

export interface RescoreGate { pass: boolean; both_value: Record<string, Agreement | null>; recheck: Record<string, Agreement | null> }

/** Each judge's agreement with the labels on each set; the gate passes only when every judge reaches the kappa floor on at least the minimum labels on both. */
export function rescoreGate(bothValue: readonly Judged[], recheck: readonly Judged[]): RescoreGate {
  const a = judgeAgreement([], bothValue), b = judgeAgreement([], recheck);
  const ok = (x: Agreement | undefined) => !!x && x.n >= JUDGE_MIN_LABELS && x.kappa !== null && x.kappa >= JUDGE_KAPPA_FLOOR;
  return {
    pass: PINNED_QUESTIONS_JUDGES.every(j => ok(a[j]) && ok(b[j])),
    both_value: Object.fromEntries(PINNED_QUESTIONS_JUDGES.map(j => [j, a[j] ?? null])),
    recheck: Object.fromEntries(PINNED_QUESTIONS_JUDGES.map(j => [j, b[j] ?? null])),
  };
}

export interface RescoreResult {
  bothValue: Array<BothValueItem & Judged>;
  recheck: Array<RecheckItem & Judged>;
  gate: RescoreGate | null;
  counted: Array<{ model: string; seed: number; company: string; mutation: MutationClass; judge_model: string; graded: GradedAnswer }>;
  harnessErrors: string[];
}

/** One graded judge call in the journal, keyed by the prompt and the inputs, so a resume reuses only what this exact stage graded. */
interface JournalLine { key: string; phase: 'both-value' | 'recheck' | 'counted'; judge: string; id: string; graded: GradedAnswer }
export const RESCORE_JOURNAL = 'rescore.ndjson';
const journalKey = (inputs: RescoreInputs) => JSON.stringify({ prompt_sha256: rescorePromptSha256(), inputs_sha256: inputs.sha256, runner_sha256: RESCORE_SOURCE_SHA256 });
const itemId = {
  'both-value': (x: Pick<BothValueItem, 'seed' | 'company' | 'template'>) => `${x.seed}|${x.company}|${x.template}`,
  recheck: (x: RecheckItem) => `${x.source}|${x.model}|${x.seed}|${x.company}`,
  counted: (x: { model: string; seed: number; company: string }) => `${x.model}|${x.seed}|${x.company}`,
};
const retryable = (g: GradedAnswer) => g.judge_error?.startsWith('judge_call_failed') ?? false;

/**
 * Graded calls already in the journal under this stage's key, by phase, judge and item: the ones a resume does not ask
 * again. A failed judge call is asked again. A line under another key refuses, since it graded something else; a torn
 * final line is cut off (readCheckpoint) and a corrupt earlier one refuses.
 */
export function readRescoreJournal(output: string, inputs: RescoreInputs): Map<string, GradedAnswer> {
  const key = journalKey(inputs);
  const lines = readCheckpoint(join(output, RESCORE_JOURNAL)) as unknown as JournalLine[];
  const foreign = lines.find(l => l.key !== key);
  if (foreign) throw new PaidArmRefusal(`${CATEGORY}: ${join(output, RESCORE_JOURNAL)} holds graded calls from another prompt, input or runner; give this rescore its own --output`);
  return new Map(lines.filter(l => !retryable(l.graded)).map(l => [`${l.phase}|${l.judge}|${l.id}`, l.graded]));
}

/** The judge calls the stage would still make: every planned call, less those the journal already holds. */
export function pendingRescoreCalls(plan: RescorePlan, done: Map<string, GradedAnswer>): RescorePlan {
  const has = (phase: JournalLine['phase'], judge: string, id: string) => done.has(`${phase}|${judge}|${id}`);
  return {
    bothValue: plan.bothValue.filter(x => PINNED_QUESTIONS_JUDGES.some(j => !has('both-value', j, itemId['both-value'](x)))),
    countedBothValue: plan.countedBothValue.filter(x => !has('counted', judgeFor(x.model!), itemId.counted({ model: x.model!, seed: x.seed, company: x.company }))),
    recheck: plan.recheck.filter(x => !has('recheck', x.judge_model, itemId.recheck(x))),
    counted: plan.counted.filter(r => !has('counted', r.judge_model, itemId.counted(r))),
  };
}

/**
 * The stage: the gate's judge calls (the counted answers that name both values among them, each by its own family's
 * judge), the gate, and, only when it passes, those answers' verdicts and the rest of the counted re-judging, all with
 * the rescore prompt. With `output`, every graded call is appended to its journal as it comes in, and calls the journal already
 * holds are reused instead of asked, so a stage stopped by a crash or the budget ledger resumes where it stopped. A
 * budget-ledger refusal stops it, and the result is then incomplete until a resume.
 */
export async function runRescore(opts: { gut: GbrainUnderTest; inputs: RescoreInputs; mode: PaidMode; output?: string; log?: (s: string) => void }): Promise<RescoreResult> {
  const plan = rescorePlan(opts.inputs);
  const done = opts.output ? readRescoreJournal(opts.output, opts.inputs) : new Map<string, GradedAnswer>();
  const key = journalKey(opts.inputs);
  if (opts.output) mkdirSync(opts.output, { recursive: true });
  const record = (phase: JournalLine['phase'], judge: string, id: string, graded: GradedAnswer) => {
    if (opts.output) appendFileSync(join(opts.output, RESCORE_JOURNAL), JSON.stringify({ key, phase, judge, id, graded } satisfies JournalLine) + '\n');
  };
  const jcWorlds = opts.inputs.judgeCheck.worlds, countedWorlds = opts.inputs.counted.worlds;
  return withGateway(opts.mode, opts.gut, async ({ gateway, gatewayConfig, usage, spend }) => {
    const meter = async (fn: () => Promise<void>) => {
      const u = noUsage();
      usage.current = u;
      try { await fn(); return { usage: u }; } finally { usage.current = null; }
    };
    const ask = (judge: string, c: PqCompany, kind: 'first' | 'refreshed', sentences: string[]) => gradeAnswer(gateway, meter, judge, c, kind, sentences, { prompt: PINNED_QUESTIONS_RESCORE_PROMPT });
    const grade = async (phase: JournalLine['phase'], id: string, judge: string, c: PqCompany, kind: 'first' | 'refreshed', sentences: string[]) => {
      const prior = done.get(`${phase}|${judge}|${id}`);
      if (prior) return prior;
      const g = await ask(judge, c, kind, sentences);
      if (!spend.stop) record(phase, judge, id, g);
      return g;
    };
    const out: RescoreResult = { bothValue: [], recheck: [], gate: null, counted: [], harnessErrors: [] };
    const stopped = (what: string) => { out.harnessErrors.push(`the budget ledger refused a request (${spend.stop}); stopped during ${what}`); return out; };
    const gated: RescoreResult['counted'] = [];
    for (const judge of PINNED_QUESTIONS_JUDGES) {
      gateway.configureGateway(gatewayConfig(judge));
      for (const item of plan.bothValue) {
        const g = await grade('both-value', itemId['both-value'](item), judge, companyOf(jcWorlds, item.seed, item.company), 'refreshed', item.sentences);
        if (spend.stop) return stopped('the both-value set');
        out.bothValue.push({ ...item, judge_model: judge, graded: { ...g, rule_correct: item.label } });
      }
      for (const item of plan.countedBothValue.filter(x => judgeFor(x.model!) === judge)) {
        const r = plan.counted.find(x => x.model === item.model && x.seed === item.seed && x.company === item.company)!;
        const g = await grade('counted', itemId.counted(r), judge, companyOf(countedWorlds, r.seed, r.company), 'refreshed', r.refreshed.sentences);
        if (spend.stop) return stopped('the counted answers that name both values');
        gated.push({ model: r.model, seed: r.seed, company: r.company, mutation: r.mutation, judge_model: judge, graded: g });
        out.bothValue.push({ ...item, judge_model: judge, graded: { ...g, rule_correct: item.label } });
      }
      for (const item of plan.recheck.filter(x => x.judge_model === judge)) {
        const g = await grade('recheck', itemId.recheck(item), judge, companyOf(jcWorlds, item.seed, item.company), item.kind, item.sentences);
        if (spend.stop) return stopped('the judge-check recheck');
        out.recheck.push({ ...item, graded: g });
      }
      opts.log?.(`[pq-rescore] ${judge}: ${out.bothValue.filter(x => x.judge_model === judge).length} both-value items (${out.bothValue.filter(x => x.judge_model === judge && x.label === null).length} undecided), ${out.recheck.filter(x => x.judge_model === judge).length} recheck items`);
    }
    out.gate = rescoreGate(out.bothValue, out.recheck);
    opts.log?.(`[pq-rescore] gate ${out.gate.pass ? 'passes' : 'fails'}: ${JSON.stringify(Object.fromEntries(PINNED_QUESTIONS_JUDGES.map(j => [j, [out.gate!.both_value[j]?.kappa, out.gate!.recheck[j]?.kappa]])))}`);
    if (!out.gate.pass) return out;
    out.counted.push(...gated);
    for (const judge of PINNED_QUESTIONS_JUDGES) {
      gateway.configureGateway(gatewayConfig(judge));
      const first = new Set(plan.countedBothValue.map(x => `${x.model}|${x.seed}|${x.company}`));
      for (const r of plan.counted.filter(x => x.judge_model === judge && !first.has(`${x.model}|${x.seed}|${x.company}`))) {
        const g = await grade('counted', itemId.counted(r), judge, companyOf(countedWorlds, r.seed, r.company), 'refreshed', r.refreshed.sentences);
        if (spend.stop) return stopped('the counted re-judging');
        out.counted.push({ model: r.model, seed: r.seed, company: r.company, mutation: r.mutation, judge_model: judge, graded: g });
      }
    }
    return out;
  });
}

const idOf = (r: { model: string; seed: number; company: string }) => `${r.model}|${r.seed}|${r.company}`;
const rate = (xs: Array<boolean | null>) => { const s = xs.filter((x): x is boolean => x !== null); return s.length ? s.filter(Boolean).length / s.length : null; };

/**
 * The counted rows with the rescored result: a row the rescore re-judged takes the new judge's verdict (null, left
 * out, on a failed judge call); every other row keeps its counted result (not published, or left out).
 */
export function rescoredRows(rows: readonly PaidRow[], counted: RescoreResult['counted']): PaidRow[] {
  const byId = new Map(counted.map(x => [idOf(x), x.graded]));
  return rows.map(r => (rejudged(r) ? { ...r, correct: byId.get(idOf(r))?.answer_correct ?? null } : r));
}

/** Per model, the preregistered and rescored refreshed correctness side by side, the flips between them, and both paired comparison families against Opus. */
export function summarizeRescore(rows: readonly PaidRow[], counted: RescoreResult['counted']) {
  const rescored = rescoredRows(rows, counted);
  const models = [...new Set(rows.map(r => r.model))];
  const column = (rs: readonly PaidRow[]) => ({ correct: rs.filter(r => r.correct === true).length, scored: rs.filter(r => r.correct !== null).length, rate: rate(rs.map(r => r.correct)) });
  return {
    by_model: Object.fromEntries(models.map(m => {
      const before = rows.filter(r => r.model === m), after = rescored.filter(r => r.model === m);
      const pairs = before.map((r, i) => [r.correct, after[i]!.correct] as const);
      const both = before.map(r => r.refreshed.rule_correct === null);
      return [m, {
        questions: before.length, judge_model: judgeFor(m),
        preregistered: column(before), rescored: column(after),
        rejudged: before.filter(rejudged).length,
        flipped_to_correct: pairs.filter(([a, b]) => a === false && b === true).length,
        flipped_to_not_correct: pairs.filter(([a, b]) => a === true && b === false).length,
        left_out_by_rescore: pairs.filter(([a, b]) => a !== null && b === null).length,
        both_value_answers: both.filter(Boolean).length,
        flipped_on_both_value_answers: { to_correct: pairs.filter(([a, b], i) => both[i] && a === false && b === true).length, to_not_correct: pairs.filter(([a, b], i) => both[i] && a === true && b === false).length },
        flipped_on_other_answers: { to_correct: pairs.filter(([a, b], i) => !both[i] && a === false && b === true).length, to_not_correct: pairs.filter(([a, b], i) => !both[i] && a === true && b === false).length },
        by_mutation: Object.fromEntries([...new Set(before.map(r => r.mutation))].sort().map(k => [k, { preregistered: column(before.filter(r => r.mutation === k)), rescored: column(after.filter(r => r.mutation === k)) }])),
      }];
    })),
    comparisons_preregistered: refreshComparisons(rows),
    comparisons_rescored: refreshComparisons(rescored),
  };
}

/** The rescore's own source with the paid runner and generator it grades through: its receipt's runner identity. */
export const RESCORE_SOURCE_SHA256 = createHash('sha256').update(readFileSync(import.meta.path)).update(readFileSync(resolve(import.meta.dir, 'pinned-questions-paid.ts'))).update(readFileSync(resolve(import.meta.dir, '../generators/pinned-questions-gen.ts'))).digest('hex');

export function buildRescoreReceipt(opts: { gut: GbrainUnderTest; inputs: RescoreInputs; result: RescoreResult; cost: (RunSummary & { processes?: number; complete?: boolean }) | null; startedAt: string; mode: PaidMode['kind'] }): Receipt {
  const { inputs, result } = opts;
  const plan = rescorePlan(inputs);
  const acc = new ProbeAccounting(plan.counted.length);
  for (const x of result.counted) {
    if (x.graded.answer_correct === null) acc.error(idOf(x), 'judge', x.graded.judge_error ?? 'no judge labels');
    else acc.score(idOf(x), Number(x.graded.answer_correct));
  }
  const a = acc.summary();
  const complete = result.harnessErrors.length === 0 && result.gate !== null && (!result.gate.pass || result.counted.length === plan.counted.length);
  return {
    ...(opts.cost ? { cost: receiptCost(opts.cost), delivered_tokens: null } : noModelSpend('keyless: gbrain test chat transport, placeholder key, dead upstream; no paid request')),
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CATEGORY,
    run_status: complete ? 'completed' : 'error',
    ...(result.gate ? { verdict: result.gate.pass ? 'pass' as const : 'fail' as const } : {}),
    n_total: a.n_total, n_scored: a.n_scored, completion_rate: a.completion_rate, errors: a.errors,
    publishable: a.publishable && complete && result.gate?.pass === true && opts.mode === 'paid' && opts.cost?.complete !== false,
    gbrain_version: opts.gut.version,
    gbrain_pin: gbrainPin(),
    execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(opts.gut) },
    resolved_config: {
      mode: opts.mode, stage: RESCORE_STAGE, gate: 'report-only',
      models: PINNED_QUESTIONS_JUDGES.map(model => ({ model, role: 'judge', grades: [...new Set(inputs.counted.rows.map(r => r.model))].filter(m => judgeFor(m) === model) })),
      judge: { prompt_sha256: rescorePromptSha256(), frozen_prompt_sha256: createHash('sha256').update(PINNED_QUESTIONS_JUDGE_PROMPT).digest('hex'), max_tokens: JUDGE_MAX_TOKENS, temperature_sent: null, route: 'gbrain gateway chat, allowFallback false', retries: 'one retry on unparseable output' },
      rule: 'preregistration amendment "Rescore under a rule for answers that give both values" (2026-11-24), written after the counted labels were seen; the frozen prompt with its correct and wrong lines replaced',
      grading: 'judge-only, no model under test asked: each counted row whose refresh published and was scored has its refreshed answer judged again by its own judge (judgeFor) with the rescore prompt; every other row keeps its counted result',
      verdict: `the agreement gate: every judge's kappa at least ${JUDGE_KAPPA_FLOOR} on at least ${JUDGE_MIN_LABELS} labels, on the both-value set (template answers and counted answers that name both values, labelled by the frozen pattern bothValuePattern, undecided items left out) and on the judge-check outputs and stale probes re-graded with the rescore prompt (rule labels); a failing gate re-judges no counted row`,
      both_value_templates: Object.fromEntries(Object.entries(BOTH_VALUE_TEMPLATES).map(([k, v]) => [k, [...v.correct, ...v.not_correct].map(t => t.id)])),
      both_value_pattern: { not_current: NOT_CURRENT.source, attribution: ATTRIBUTION.source, uncertain: UNCERTAIN.source },
      inputs_sha256: inputs.sha256,
      cost_processes: opts.cost?.processes ?? null,
      cost_complete: opts.cost?.complete ?? null,
      runner_source_sha256: RESCORE_SOURCE_SHA256,
      gbrain_overlay: overlaySummary(opts.gut),
    },
    hashes: Object.fromEntries([...inputs.counted.worlds, ...inputs.judgeCheck.worlds].map(([seed, w]) => [`ledger_seed_${seed}`, w.fingerprint])),
    started_at: opts.startedAt,
    finished_at: new Date().toISOString(),
    data: {
      gate: result.gate,
      summary: summarizeRescore(inputs.counted.rows, result.counted),
      both_value_by_source: Object.fromEntries((['template', 'counted'] as const).map(src => [src, judgeAgreement([], result.bothValue.filter(x => x.source === src))])),
      both_value_by_template: Object.fromEntries([...new Set(result.bothValue.map(x => x.template ?? 'counted answers'))].map(t => [t, Object.fromEntries(PINNED_QUESTIONS_JUDGES.map(j => {
        const xs = result.bothValue.filter(x => (x.template ?? 'counted answers') === t && x.judge_model === j);
        return [j, { items: xs.length, undecided: xs.filter(x => x.label === null).length, agreed: xs.filter(x => x.label !== null && x.graded.answer_correct === x.label).length }];
      }))])),
      both_value: result.bothValue, recheck: result.recheck, counted: result.counted, harness_errors: result.harnessErrors,
    },
  } as unknown as Receipt;
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) return argv[at + 1];
  return argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outFlag = argValue(argv, '--output');
  if (!outFlag) throw new Error('--output <dir> is required');
  const output = resolve(outFlag);
  const marker = join(output, `${RESCORE_STAGE}.started`);
  const resume = argv.includes('--resume');
  if (existsSync(marker) && !resume) throw new PaidArmRefusal(`${CATEGORY}: a rescore already started in ${output} (${marker}); --resume continues it from ${RESCORE_JOURNAL}, asking only the calls it does not hold, inside the same paid window`);
  if (resume && !existsSync(marker)) throw new PaidArmRefusal(`${CATEGORY}: --resume, but no rescore started in ${output}`);
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  const inputs = readRescoreInputs({ counted: argValue(argv, '--counted'), 'judge-check': argValue(argv, '--judge-check'), 'stale-probes': argValue(argv, '--stale-probes') }, { gut });
  const estimate = rescoreEstimateUsd(pendingRescoreCalls(rescorePlan(inputs), readRescoreJournal(output, inputs)), measuredJudge(inputs.counted.rows));
  requirePaidFlags(argv, estimate);
  requireProviderKeys(PINNED_QUESTIONS_JUDGES);
  const judgeKeys = new Set(PINNED_QUESTIONS_JUDGES.map(j => ({ anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' } as Record<string, string>)[j.split(':')[0]!]));
  const keys = Object.fromEntries(PAID_KEY_NAMES.filter(k => judgeKeys.has(k)).map(k => [k, process.env[k]]).filter(([, v]) => v)) as Partial<Record<typeof PAID_KEY_NAMES[number], string>>;
  const startedAt = new Date().toISOString();
  const paid = startPaidRun(`${CATEGORY}-${RESCORE_STAGE}`, { ...budgetOptionsFrom(argv), estimateUsd: estimate });
  const processId = randomUUID();
  const costKey = journalKey(inputs);
  const unit = [{ model: RESCORE_STAGE, seed: 0 }];
  let result: RescoreResult;
  let closed: RunSummary;
  try {
    mkdirSync(output, { recursive: true });
    recordProcessStart(output, { key: costKey, stage: RESCORE_STAGE as never, asked: unit, process_id: processId, run_id: paid.run.runId });
    if (!resume) writeFileSync(marker, new Date().toISOString() + '\n', { flag: 'wx' });
    result = await runRescore({ gut, inputs, mode: { kind: 'paid', keys }, output, log: s => console.error(s) });
  } finally {
    closed = paid.run.close();
    paid.guard.uninstall();
    recordProcessCost(output, { key: costKey, stage: RESCORE_STAGE as never, asked: unit, process_id: processId, summary: closed });
  }
  const cost = combinedCost(output, costKey, unit, closed);
  const receipt = buildRescoreReceipt({ gut, inputs, result, cost, startedAt, mode: 'paid' }) as unknown as { verdict?: string; publishable: boolean; data: { gate: unknown; summary: ReturnType<typeof summarizeRescore> } };
  writeReceipt(join(output, `receipt.${RESCORE_STAGE}.json`), receipt as unknown as Receipt);
  console.log(JSON.stringify({ verdict: receipt.verdict ?? null, publishable: receipt.publishable, gate: receipt.data.gate, by_model: Object.fromEntries(Object.entries(receipt.data.summary.by_model).map(([m, v]) => [m, { preregistered: v.preregistered, rescored: v.rescored, flipped_to_correct: v.flipped_to_correct, flipped_to_not_correct: v.flipped_to_not_correct, left_out_by_rescore: v.left_out_by_rescore }])), harness_errors: result.harnessErrors, cost_usd: receiptCost(cost).usd, cost_processes: cost.processes }, null, 2));
  process.exit(result.harnessErrors.length ? 3 : 0);
}

if (import.meta.main) {
  main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(e instanceof PaidArmRefusal ? 2 : 3); });
}

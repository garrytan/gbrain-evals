/**
 * Pinned questions, paid arm: when the notes behind a pinned answer change and
 * gbrain refreshes it with a real model, is the refreshed answer correct?
 *
 * The keyless category (eval/runner/pinned-questions.ts) scores stale flags with
 * a scripted oracle. This arm runs the product path with the model under test:
 * per model and seed, on a fresh in-memory PGLite brain through gbrain's own
 * operation handlers and pinned-question service, as the trusted local owner:
 *   1. The world's pages are written with put_page and its facts with remember
 *      (eval/generators/pinned-questions-gen.ts).
 *   2. `models.standing_questions` is set to the model under test and each
 *      company's question is pinned with its entity scope. No chat function is
 *      injected: gbrain's gateway makes the call (the product path).
 *   3. Company by company: its one controlled change is applied, its question
 *      is refreshed with refreshQuestion (no injected chat), and questionStatus
 *      is read for the refreshed answer and its stale flags.
 *   4. Every first answer is graded against the ledger before the change and
 *      every refreshed answer against the ledger after it, by a judge from
 *      another family (judgeFor), called through the same gateway; beside each
 *      judge label sits a deterministic rule label from the unique synthetic
 *      tokens, for the judge agreement check (judgeAgreement).
 *
 * Paid: the run joins an open eval budget ledger run (--paid with --budget-run-id ID, checked by requirePaidArm like
 * every paid runner here); every request goes through the ledger's fetch guard.
 * An interrupted run resumes from checkpoint.ndjson in --output and never
 * re-asks a finished (model, seed) unit. Tests use the keyless mode
 * (runPinnedQuestionsPaid with a transport): gbrain's test chat transport, a
 * placeholder key, dead upstream base URLs and no provider keys.
 *
 * Usage: bun eval/runner/pinned-questions-paid.ts --models claude-opus-5-5,particle:particle-1,gpt-6.2-sol
 *   [--stage dev|pilot|judge-check|counted] [--seeds 1,2,3] [--companies 24] [--max-output-tokens N] --output <dir>
 *   [--gbrain <checkout>[@ref]] --paid --budget-run-id ID
 * --stage picks the preregistered seeds (pilot 21; judge-check 21-23 into the pilot's --output; counted 11-20), and
 * --seeds overrides them. --max-output-tokens sets cycle.standing_questions.max_output_tokens for the raised-cap arm.
 */
import './budget-ledger.ts';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { OperationContext } from 'gbrain/operations';
import { BudgetExceededError, budgetOptionsFrom, chatPrice, paidRequestGuardActive, receiptCost, startPaidRun, type RunSummary } from './budget-ledger.ts';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { gbrainPin } from './gbrain-version.ts';
import { HERMETIC_KEY_PATTERN, redactUrlPasswords, withHermeticEnv } from './hermetic-env.ts';
import { acceptsTemperature } from './openai-judge-shim.ts';
import { PaidArmRefusal, requirePaidArm } from './paid-arm.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { KEY_PATTERNS } from './q1/secret-scan.ts';
import { comparisonFamily, pairedComparison } from './pinned-questions-stats.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, noModelSpend, sourceTreeIdentity, writeReceipt, type Receipt } from './receipt.ts';
import {
  CLAIMS, DEV_SEEDS, PINNED_QUESTIONS_GENERATOR_VERSION, generatePinnedQuestionsWorld,
  type Claim, type MutationClass, type PqCompany, type PqWorld,
} from '../generators/pinned-questions-gen.ts';

export const CATEGORY = 'pinned-questions-paid';

/** The comparison set: the frontier Opus and GPT plus the primary low-cost model (CLAUDE.md "Choose models"). */
export const PINNED_QUESTIONS_MODELS_UNDER_TEST = ['anthropic:claude-opus-5-5', 'particle:particle-1', 'openai:gpt-6.2-sol'] as const;
/** Judges, never grading their own family: GPT-6.2 Astra grades Claude and Particle rows, Opus 5.5 grades GPT rows. */
export const PINNED_QUESTIONS_JUDGES = ['openai:gpt-6.2-astra', 'anthropic:claude-opus-5-5'] as const;

export const JUDGE_LABELS = ['correct', 'stale', 'wrong', 'missing'] as const;
export type JudgeLabel = typeof JUDGE_LABELS[number];
export type RuleLabel = 'correct' | 'stale' | 'missing' | 'ambiguous';

/** Wait for one pin or refresh call: gbrain's maximum, so a slow thinking model is graded rather than timed out. */
export const WAIT_MS = 300_000;
export const JUDGE_MAX_TOKENS = 8_192;
/** Sent to Particle through gbrain's provider_chat_options: its default, sent explicitly (CLAUDE.md "Choose models"). */
export const PARTICLE_REASONING_EFFORT = 'high';
/** gbrain's config key for one refresh call's output cap (src/core/questions/refresh.ts MAX_OUTPUT_TOKENS_KEY); its default is 2,000. */
export const MAX_OUTPUT_TOKENS_KEY = 'cycle.standing_questions.max_output_tokens';
/**
 * The preregistration's stages and their seeds. The pilot (a tenth of the counted seeds) checks that refresh ran with
 * each model and that every question could be supplied. A tenth can't give each judge JUDGE_MIN_LABELS outputs, so the
 * judge-check stage runs into the pilot's --output, resumes seed 21 from its checkpoint and adds seeds 22 and 23.
 */
export const STAGE_SEEDS = { dev: DEV_SEEDS, pilot: [21], 'judge-check': [21, 22, 23], counted: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20] } as const;
export type Stage = keyof typeof STAGE_SEEDS;
/** Pilot bar: above this share of a model's pin and refresh calls cut off at the output cap, the cap is a gbrain finding and the raised-cap arm runs. */
export const TRUNCATION_BAR = 0.05;
/** Provider keys restored for the paid run; nothing else leaves the hermetic environment. */
export const PAID_KEY_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PARTICLE_API_KEY'] as const;
/** Keyless mode's dead upstream: nothing listens there, so a request that escaped the test transport fails locally. */
export const DEAD_UPSTREAM = { anthropic: 'http://127.0.0.1:9', openai: 'http://127.0.0.1:9/v1', particle: 'http://127.0.0.1:9/v1' };

/**
 * Tokens per call for the cost estimate. Inputs are from the prompts of a keyless
 * run (seed 2, 24 companies: pin about 10,000 characters, refresh up to 11,400,
 * judge about 1,600; 4 characters per token, rounded up). Outputs are bounds: the
 * refresh output cap (2,000) and the judge's max_tokens (JUDGE_MAX_TOKENS), both
 * covering thinking: the worst case, which a launch prices until graded rows measure
 * the judge (measuredJudge); a visible answer is about 75 tokens.
 */
export const EST_TOKENS = {
  pin: { input: 2_600, output: 2_000 },
  refresh: { input: 2_900, output: 2_000 },
  judge: { input: 450, output: JUDGE_MAX_TOKENS },
} as const;
/** Judge calls per graded answer at worst: the first call and its one retry on unparseable output (JUDGE_RETRY_NOTE). */
export const JUDGE_CALLS_PER_ANSWER = 2;

/** The judge's system prompt, frozen: changing it changes the judge and voids earlier agreement checks. */
export const PINNED_QUESTIONS_JUDGE_PROMPT = [
  "You grade one answer about a fictional company against an answer key. The company and every value in the key are invented, so use only the key and the answer, never outside knowledge.",
  "For each of the four claims in the key (city, flagship, ceo, founded), label what the answer says about it:",
  "- correct: the answer states the key's current value for the claim and does not also give a different value as current.",
  "- stale: the answer gives the key's previous value as current instead of the current value.",
  "- wrong: the answer gives some other value, or gives the current value and a conflicting value together.",
  "- missing: the answer does not address the claim.",
  'When a claim\'s current value is "(none: removed)", the notes no longer name anyone for it: label it correct when the answer does not name the previous value or anyone else as the current holder (saying it is unknown is correct), stale when it still names the previous value as current, and wrong when it names someone else.',
  'Return only JSON: {"city":"<label>","flagship":"<label>","ceo":"<label>","founded":"<label>"}.',
].join('\n');

const JUDGE_RETRY_NOTE = 'Your previous reply could not be parsed. Reply with only the JSON object described above.';

export type Family = 'claude' | 'gpt' | 'particle';

export function familyOf(model: string): Family {
  const bare = model.split(':').pop()!.toLowerCase();
  if (bare.startsWith('claude-')) return 'claude';
  if (bare.startsWith('gpt-')) return 'gpt';
  if (bare.startsWith('particle')) return 'particle';
  throw new Error(`${model}: no judge family rule for this model`);
}

/** The judge for a model's rows: never its own family, never particle-1. */
export function judgeFor(model: string): string {
  return familyOf(model) === 'gpt' ? 'anthropic:claude-opus-5-5' : 'openai:gpt-6.2-astra';
}

/** A gateway model id with its provider prefix (`claude-opus-5-5` -> `anthropic:claude-opus-5-5`). */
export function canonicalModel(id: string): string {
  if (id.includes(':')) return id;
  const prefix: Record<Family, string> = { claude: 'anthropic', gpt: 'openai', particle: 'particle' };
  return `${prefix[familyOf(id)]}:${id}`;
}

const wordIn = (value: string, text: string) => new RegExp(`(^|[^A-Za-z0-9])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`).test(text);

/** The ledger values an answer is graded against: before the change for a first answer, after it for a refreshed one. */
function keyFor(c: PqCompany, kind: 'first' | 'refreshed'): Record<Claim, { now: string | null; was: string | null }> {
  return Object.fromEntries(CLAIMS.map(claim => {
    const now = kind === 'first' ? c.before[claim] : c.after[claim];
    return [claim, { now, was: kind === 'refreshed' && now !== c.before[claim] ? c.before[claim] : null }];
  })) as Record<Claim, { now: string | null; was: string | null }>;
}

export function judgeUserMessage(c: PqCompany, kind: 'first' | 'refreshed', sentences: readonly string[]): string {
  const key = keyFor(c, kind);
  return [
    `Company: ${c.name}`,
    `Question: ${c.question}`,
    'Answer key:',
    ...CLAIMS.map(claim => `- ${claim}: current ${key[claim].now === null ? '(none: removed)' : JSON.stringify(key[claim].now)}${key[claim].was !== null ? `; previous (no longer true) ${JSON.stringify(key[claim].was)}` : ''}`),
    'Answer:',
    ...(sentences.length ? sentences : ['(no answer)']),
  ].join('\n');
}

/**
 * The deterministic label per claim from the synthetic tokens: the current value
 * present and the previous absent is correct, the previous present and the current
 * absent is stale, neither is missing, both is ambiguous. A removed claim is
 * correct when the previous value is absent.
 */
/**
 * Words that show an answer still states a claim (for the CEO, a capitalised name after "chief executive ... is" or
 * "led by", so "no chief executive is named" does not count). When a claim was removed and the answer has these without the
 * old value, it may assert a different, wrong value, which token presence cannot tell from a correct non-answer, so the
 * rule label is ambiguous and the answer is left out of the judge check.
 */
const ASSERTS: Record<Claim, RegExp> = {
  city: /\b(builds|built|based|headquartered|located|manufactur\w*)\b/i,
  flagship: /\bflagship\b/i,
  ceo: /(\b[Cc]hief [Ee]xecutive|\bCEO)(\s+of\s+[^.]+?)?\s+(is|was|remains|became|is now)\s+[A-Z]|\b(led|headed|run) by\s+[A-Z]/,
  founded: /\b(founded|established)\b/i,
};

export function ruleLabels(c: PqCompany, kind: 'first' | 'refreshed', sentences: readonly string[]): Record<Claim, RuleLabel> {
  const text = sentences.join(' ');
  const key = keyFor(c, kind);
  return Object.fromEntries(CLAIMS.map(claim => {
    const { now, was } = key[claim];
    if (now === null) return [claim, wordIn(c.before[claim], text) ? 'stale' : ASSERTS[claim].test(text) ? 'ambiguous' : 'correct'];
    const n = wordIn(now, text);
    if (was === null) return [claim, n ? 'correct' : 'missing'];
    const o = wordIn(was, text);
    return [claim, n && !o ? 'correct' : o && !n ? 'stale' : n && o ? 'ambiguous' : 'missing'];
  })) as Record<Claim, RuleLabel>;
}

export function parseJudgeLabels(text: string): Record<Claim, JudgeLabel> | null {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const out = {} as Record<Claim, JudgeLabel>;
    for (const claim of CLAIMS) {
      const v = typeof o[claim] === 'string' ? (o[claim] as string).trim().toLowerCase() : '';
      if (!(JUDGE_LABELS as readonly string[]).includes(v)) return null;
      out[claim] = v as JudgeLabel;
    }
    return out;
  } catch {
    return null;
  }
}

/** models: every "provider:modelId" gbrain's gateway reported as the model that answered in this window. */
export interface Usage { calls: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; models?: string[] }
const noUsage = (): Usage => ({ calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, models: [] });

/** The served id is the model under test, or a dated snapshot of it (the provider's id begins with the bare id). */
const servedAs = (model: string, served: string) => (served.split(':').pop() ?? served).startsWith(model.split(':').pop() ?? model);

/** A pin or refresh call that some other model answered: the row is not evidence about the model under test. */
export const servedWrongModel = (r: Pick<PaidRow, 'model' | 'pin' | 'refresh'>) => [r.pin, r.refresh].some(c => (c.usage.models ?? []).some(s => !servedAs(r.model, s)));

/** The model that answered the refresh (else the pin), from the gateway's usage record: the receipt's proof of what ran. */
export const answerModelOf = (r: Pick<PaidRow, 'pin' | 'refresh'>) => r.refresh.usage.models?.at(-1) ?? r.pin.usage.models?.at(-1) ?? null;

/**
 * failure_message: the provider's own words when gbrain logged a failed refresh, which its error code alone loses (a safety stop reads as provider_error).
 * safety_finish: a structured refusal or content-filter finish reason a provider returned during a call that did not publish; gbrain's
 * question adapter keeps only `length`, so the runner records it from the gateway's own result.
 */
export interface CallRecord { status: string; mode: 'full' | 'incremental' | null; error: string | null; failure_message: string | null; safety_finish?: SafetyFinish | null; cost_usd: number | null; usage: Usage }
export type SafetyFinish = 'refusal' | 'content_filter';

/** The AI SDK's generateText, passing every result through and reporting its structured safety finish (the paid arm's only hook on it). */
export const recordingGenerateText = (generate: (o: any) => Promise<any>, note: (f: SafetyFinish | null) => void) => async (o: any) => {
  const r = await generate(o);
  note(safetyFinishOf(r));
  return r;
};

/** The structured safety finish of one AI SDK result, mapped as gbrain's gateway maps it (refusal first, then content_filter). */
export function safetyFinishOf(r: { finishReason?: string; rawFinishReason?: string; providerMetadata?: Record<string, any>; stopReason?: string }): SafetyFinish | null {
  if (r.stopReason !== undefined) return r.stopReason === 'refusal' || r.stopReason === 'content_filter' ? r.stopReason : null;
  const anthropic = r.providerMetadata?.anthropic?.stopReason ?? r.providerMetadata?.anthropic?.stop_reason;
  if (r.rawFinishReason === 'refusal' || anthropic === 'refusal') return 'refusal';
  return r.finishReason === 'content-filter' || r.finishReason === 'content_filter' ? 'content_filter' : null;
}

/**
 * What a pin or refresh came to. provider_error (a 5xx, rate limit, timeout or dropped connection before any answer) is
 * not a model outcome: the unit is retried once and then left out of the denominator. Every other outcome but
 * published counts as not correct, and each is reported in its own column.
 */
export type Outcome = 'published' | 'answer_too_long' | 'safety_stop' | 'provider_error' | 'not_published';
const TRANSIENT = /^refresh_failed:(rate_limited|timeout|network|provider_error)$/;
const NO_ANSWER_REACHED = /^refresh_failed:(rate_limited|timeout|network)$/;
const SAFETY = /safety|content[ _-]?filter|content[ _-]?policy|usage polic|\brefusal\b|\brefused to\b|flagged/i;

/**
 * gbrain refused to call the model for a reason that is the run's setup, not the model: no key, no consent, no worker or
 * gbrain's own spend limit. The question is a harness error, never a scored not-correct answer.
 */
const HARNESS_BLOCKS = new Set(['no_model_key', 'awaiting_consent', 'no_worker', 'budget_exhausted']);
export const harnessBlocked = (c: Pick<CallRecord, 'status' | 'error'>) => c.status === 'blocked' && c.error !== null && HARNESS_BLOCKS.has(c.error);

/** Refuse a paid launch unless every model under test and every judge it needs has its provider key set. */
export function requireProviderKeys(models: readonly string[], env: Record<string, string | undefined> = process.env): void {
  const keyOf = (m: string) => ({ anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', particle: 'PARTICLE_API_KEY' } as Record<string, string>)[m.split(':')[0]!] ?? `no known key for ${m}`;
  const missing = [...new Set(models.flatMap(m => [m, judgeFor(m)]))].filter(m => !env[keyOf(m)]).map(m => `${m} (${keyOf(m)})`);
  if (missing.length) throw new PaidArmRefusal(`${CATEGORY}: no provider key for ${missing.join(', ')}; set it before a paid launch, or a run scores that model as all wrong.`);
}

export function outcomeOf(c: Pick<CallRecord, 'status' | 'error' | 'failure_message' | 'safety_finish'>): Outcome {
  if (c.status === 'published') return 'published';
  if (c.error?.includes('answer_too_long')) return 'answer_too_long';
  if (c.error && NO_ANSWER_REACHED.test(c.error)) return 'provider_error';
  if (c.safety_finish || (c.failure_message && SAFETY.test(c.failure_message))) return 'safety_stop';
  if (c.status === 'timeout' || (c.error !== null && TRANSIENT.test(c.error))) return 'provider_error';
  return 'not_published';
}

/**
 * The scored refreshed answer: null (left out) when a provider error stopped the pin or refresh or the judge call
 * failed, false when the refresh did not publish (the brain still holds the pin-time answer, so its text is not graded
 * as a refresh), else the judge's verdict.
 */
export function scoredCorrect(r: Pick<PaidRow, 'model' | 'pin' | 'refresh' | 'refreshed'>): boolean | null {
  if (harnessBlocked(r.pin) || harnessBlocked(r.refresh) || servedWrongModel({ model: r.model, pin: r.pin, refresh: r.refresh })) return null;
  if (outcomeOf(r.pin) === 'provider_error' || outcomeOf(r.refresh) === 'provider_error') return null;
  if (outcomeOf(r.refresh) !== 'published') return false;
  return r.refreshed.answer_correct;
}

export interface GradedAnswer {
  sentences: string[];
  judge_labels: Record<Claim, JudgeLabel> | null;
  judge_error: string | null;
  /** Every claim judged correct; null when the judge gave no labels. */
  answer_correct: boolean | null;
  rule_labels: Record<Claim, RuleLabel>;
  /** Every claim correct by rule; null when a claim is ambiguous. */
  rule_correct: boolean | null;
  judge_usage: Usage;
}

export interface PaidRow {
  model: string; seed: number; company: string; mutation: MutationClass; affected: Claim[]; judge_model: string;
  pin: CallRecord;
  refresh: CallRecord & { freshness: string; stale_sentences: number };
  first: GradedAnswer;
  refreshed: GradedAnswer & { stale: boolean[] };
  /** The refresh's outcome and the scored result (scoredCorrect): P's primary metric reads `correct`, never the judge alone. */
  outcome: Outcome;
  correct: boolean | null;
  /** The model gbrain's gateway reported answering the refresh (else the pin); null on rows checkpointed before it was recorded. */
  answer_model?: string | null;
}

/** Cohen's kappa for two binary raters from the 2x2 table; null when chance agreement is total. */
export function cohenKappa(t: { both: number; judge_only: number; rule_only: number; neither: number }): number | null {
  const n = t.both + t.judge_only + t.rule_only + t.neither;
  if (n === 0) return null;
  const po = (t.both + t.neither) / n;
  const pj = (t.both + t.judge_only) / n, pr = (t.both + t.rule_only) / n;
  const pe = pj * pr + (1 - pj) * (1 - pr);
  return pe === 1 ? null : (po - pe) / (1 - pe);
}

export interface Agreement { n: number; excluded_ambiguous: number; excluded_no_judge: number; both: number; judge_only: number; rule_only: number; neither: number; agreement: number | null; kappa: number | null }

/** Judge versus rule on answer_correct, per judge model, over first and refreshed answers whose rule labels hold no ambiguous claim. */
export function judgeAgreement(rows: ReadonlyArray<Pick<PaidRow, 'judge_model' | 'first' | 'refreshed'>>): Record<string, Agreement> {
  const out: Record<string, Agreement> = {};
  for (const r of rows) {
    const a = out[r.judge_model] ??= { n: 0, excluded_ambiguous: 0, excluded_no_judge: 0, both: 0, judge_only: 0, rule_only: 0, neither: 0, agreement: null, kappa: null };
    for (const g of [r.first, r.refreshed]) {
      if (g.rule_correct === null) { a.excluded_ambiguous++; continue; }
      if (g.answer_correct === null) { a.excluded_no_judge++; continue; }
      a.n++;
      if (g.answer_correct && g.rule_correct) a.both++;
      else if (g.answer_correct) a.judge_only++;
      else if (g.rule_correct) a.rule_only++;
      else a.neither++;
    }
  }
  for (const a of Object.values(out)) {
    a.agreement = a.n ? (a.both + a.neither) / a.n : null;
    a.kappa = cohenKappa(a);
  }
  return out;
}

/** The judge check a receipt's verdict reports: every judge's kappa against the rule labels at least this, on at least JUDGE_MIN_LABELS outputs (R78). */
export const JUDGE_KAPPA_FLOOR = 0.6;
export const JUDGE_MIN_LABELS = 100;

/**
 * Every judge in `judges` (by default, every judge the rows name) has at least JUDGE_MIN_LABELS labelled outputs and a
 * defined kappa of at least JUDGE_KAPPA_FLOOR. An undefined kappa (unanimous labels, so chance agreement is 1) is no
 * evidence of agreement and fails, and a judge with no rows fails.
 */
export function judgeCheckPasses(rows: ReadonlyArray<Pick<PaidRow, 'judge_model' | 'first' | 'refreshed'>>, judges: readonly string[] = [...new Set(rows.map(r => r.judge_model))]): boolean {
  const a = judgeAgreement(rows);
  return judges.length > 0 && judges.every(j => { const x = a[j]; return !!x && x.n >= JUDGE_MIN_LABELS && x.kappa !== null && x.kappa >= JUDGE_KAPPA_FLOOR; });
}

/**
 * A counted launch needs the judge-check stage's receipt: same gbrain build and judge prompt, every counted model in its
 * model set, and the judge check recomputed from its rows passing for every judge the counted models need. The output
 * cap is not tied: the judge grades answers, and the raised-cap arm only lets them run longer.
 */
export function requireJudgeCheck(path: string | undefined, opts: { gut: GbrainUnderTest; models: readonly string[] }): void {
  const refuse = (why: string) => { throw new PaidArmRefusal(`${CATEGORY}: a counted launch needs a passing judge-check receipt (--judge-check <receipt.json> from --stage judge-check): ${why}`); };
  if (!path) return refuse('none given');
  if (!existsSync(path)) return refuse(`${path} does not exist`);
  const r = JSON.parse(readFileSync(path, 'utf8')) as { category?: string; run_status?: string; gbrain_version?: string; execution?: { product?: unknown }; resolved_config?: { mode?: string; stage?: string; models?: Array<{ model: string; role: string }>; judge?: { prompt_sha256?: string }; gbrain_overlay?: unknown }; data?: { rows?: PaidRow[] } };
  const c = r.resolved_config;
  if (r.category !== CATEGORY || c?.stage !== 'judge-check' || c.mode !== 'paid') return refuse(`${path} is not a paid ${CATEGORY} judge-check receipt`);
  if (r.run_status !== 'completed') return refuse(`its run_status is ${r.run_status}`);
  if (r.gbrain_version !== opts.gut.version || JSON.stringify(c.gbrain_overlay ?? null) !== JSON.stringify(overlaySummary(opts.gut) ?? null)) return refuse(`it measured gbrain ${r.gbrain_version}, not the build under test (${opts.gut.version})`);
  if (c.judge?.prompt_sha256 !== createHash('sha256').update(PINNED_QUESTIONS_JUDGE_PROMPT).digest('hex')) return refuse('its judge prompt differs from this runner\'s');
  const checked = new Set((c.models ?? []).filter(m => m.role === 'model under test').map(m => m.model));
  const missing = opts.models.map(canonicalModel).filter(m => !checked.has(m));
  if (missing.length) return refuse(`it did not run ${missing.join(', ')}`);
  const judges = [...new Set(opts.models.map(m => judgeFor(canonicalModel(m))))];
  if (!judgeCheckPasses(r.data?.rows ?? [], judges)) return refuse(`recomputed from its rows, the judge check fails for at least one of ${judges.join(', ')}`);
}

/** A pin or refresh that gbrain failed because the reply hit the output cap. */
export const answerTooLong = (c: Pick<CallRecord, 'error'>) => c.error?.includes('answer_too_long') ?? false;

const rate = (xs: Array<boolean | null>) => { const s = xs.filter((x): x is boolean => x !== null); return s.length ? s.filter(Boolean).length / s.length : null; };
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function summarizePaid(rows: readonly PaidRow[]) {
  const models = [...new Set(rows.map(r => r.model))];
  const perCall = (pick: (r: PaidRow) => Usage[]) => {
    const us = rows.flatMap(pick).filter(u => u.calls > 0);
    return { calls: us.reduce((a, u) => a + u.calls, 0), mean_input_tokens: mean(us.map(u => u.input_tokens / u.calls)), mean_output_tokens: mean(us.map(u => u.output_tokens / u.calls)) };
  };
  const byModel = Object.fromEntries(models.map(m => {
    const rs = rows.filter(r => r.model === m);
    const counts = (f: (r: PaidRow) => string) => rs.reduce<Record<string, number>>((o, r) => { o[f(r)] = (o[f(r)] ?? 0) + 1; return o; }, {});
    return [m, {
      questions: rs.length, judge_model: rs[0]!.judge_model,
      first_correct: rate(rs.map(r => r.first.answer_correct)),
      refreshed_correct: rate(rs.map(r => r.correct)),
      refreshed_excluded: rs.filter(r => r.correct === null).length,
      refreshed_judge_correct_on_text: rate(rs.map(r => r.refreshed.answer_correct)),
      refreshed_correct_rule: rate(rs.map(r => r.refreshed.rule_correct)),
      refresh_outcome: counts(r => r.outcome),
      answer_too_long: (() => {
        const pin = rs.filter(r => answerTooLong(r.pin)).length, refresh = rs.filter(r => answerTooLong(r.refresh)).length;
        const share = (pin + refresh) / (2 * rs.length);
        return { pin, refresh, share, over_bar: share > TRUNCATION_BAR };
      })(),
      pin_status: counts(r => r.pin.status), refresh_status: counts(r => r.refresh.status), refresh_mode: counts(r => r.refresh.mode ?? 'none'),
      by_mutation: Object.fromEntries([...new Set(rs.map(r => r.mutation))].sort().map(k => {
        const ks = rs.filter(r => r.mutation === k);
        return [k, { questions: ks.length, refreshed_correct: rate(ks.map(r => r.correct)) }];
      })),
      cost_usd_gbrain_reported: rs.reduce((a, r) => a + (r.pin.cost_usd ?? 0) + (r.refresh.cost_usd ?? 0), 0),
    }];
  }));
  return {
    by_model: byModel,
    judge_agreement: judgeAgreement(rows),
    /** The same agreement read per model under test (one judge grades two models), as the preregistration reads disagreements: per model, not pooled. */
    judge_agreement_by_model: Object.fromEntries(models.map(m => [m, judgeAgreement(rows.filter(r => r.model === m))[judgeFor(m)] ?? null])),
    comparisons: refreshComparisons(rows),
    truncation: { bar: TRUNCATION_BAR, models_over_bar: models.filter(m => byModel[m]!.answer_too_long.over_bar) },
    tokens_per_call: { pin: perCall(r => [r.pin.usage]), refresh: perCall(r => [r.refresh.usage]), judge: perCall(r => [r.first.judge_usage, r.refreshed.judge_usage]) },
  };
}

/** One receipt per stage, so the judge-check stage, which resumes the pilot's seed in the same output directory, never replaces the pilot's receipt. */
export const receiptFile = (output: string, stage: Stage) => join(output, `receipt.${stage}.json`);

/** The reference every P comparison is paired against. */
export const P_REFERENCE_MODEL = 'anthropic:claude-opus-5-5';

/**
 * P's primary comparisons: each other model against P_REFERENCE_MODEL on the scored refreshed outcome, paired by
 * question (seed and company, both scored), Holm-corrected within this run's family, with the non-inferiority call. A
 * raised-cap run is its own receipt and so its own family. Empty when the reference did not run.
 */
export function refreshComparisons(rows: readonly PaidRow[]) {
  const ref = new Map(rows.filter(r => r.model === P_REFERENCE_MODEL && r.correct !== null).map(r => [`${r.seed}|${r.company}`, r.correct!]));
  if (!ref.size) return {};
  const others = [...new Set(rows.map(r => r.model))].filter(m => m !== P_REFERENCE_MODEL);
  return comparisonFamily(Object.fromEntries(others.map(m => [m, pairedComparison(rows
    .filter(r => r.model === m && r.correct !== null && ref.has(`${r.seed}|${r.company}`))
    .map(r => ({ a: ref.get(`${r.seed}|${r.company}`)!, b: r.correct! })))])));
}

/** Ledger estimate in dollars for a run, from EST_TOKENS and the ledger's prices. */
/**
 * What the judge measurably costs per graded answer, from rows already graded with this judge prompt: output tokens per
 * call with half again as margin (never above JUDGE_MAX_TOKENS), and calls per answer (retries included). Null with no
 * graded rows, so a first launch prices the worst case.
 */
export function measuredJudge(rows: ReadonlyArray<Pick<PaidRow, 'first' | 'refreshed'>>): { outputTokens: number; callsPerAnswer: number } | null {
  const us = rows.flatMap(r => [r.first.judge_usage, r.refreshed.judge_usage]);
  const calls = us.reduce((a, u) => a + u.calls, 0);
  if (!calls) return null;
  return { outputTokens: Math.min(JUDGE_MAX_TOKENS, Math.ceil(1.5 * us.reduce((a, u) => a + u.output_tokens, 0) / calls)), callsPerAnswer: calls / us.length };
}

/** The graded rows a launch prices the judge from: the judge-check receipt's for a counted launch, else this directory's checkpointed units under the same key. */
export function judgeEstimateRows(output: string, key: string, judgeCheck?: string): PaidRow[] {
  if (judgeCheck && existsSync(judgeCheck)) return (JSON.parse(readFileSync(judgeCheck, 'utf8')) as { data?: { rows?: PaidRow[] } }).data?.rows ?? [];
  return readCheckpoint(join(output, 'checkpoint.ndjson')).filter(x => x.key === key).flatMap(x => x.rows);
}

export function estimateUsd(models: readonly string[], seeds: number, companies: number, maxOutputTokens?: number, judge: { outputTokens: number; callsPerAnswer: number } | null = null): number {
  const answerOutput = Math.max(EST_TOKENS.pin.output, maxOutputTokens ?? 0);
  const cost = (model: string, t: { input: number; output: number }) => {
    const p = chatPrice(model);
    if (!p) throw new Error(`${model} has no ledger price; register one in eval/runner/budget-ledger.ts`);
    return (t.input * p.input + t.output * p.output) / 1e6;
  };
  return models.reduce((sum, m) => sum + seeds * companies * (cost(m, { ...EST_TOKENS.pin, output: answerOutput }) + cost(m, { ...EST_TOKENS.refresh, output: answerOutput }) + 2 * (judge?.callsPerAnswer ?? JUDGE_CALLS_PER_ANSWER) * cost(judgeFor(m), { ...EST_TOKENS.judge, output: judge?.outputTokens ?? EST_TOKENS.judge.output })), 0);
}

interface Sentence { id: string; text: string; origin: string; stale: boolean }
interface QReceipt { id: string; freshness: string; answer?: Sentence[]; sentences: { stale: number }; last_error: string | null; refresh?: { status: string; mode?: 'full' | 'incremental'; error?: string; detail?: string; blocked_reason?: string; cost_usd?: number } }
interface Engine { executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>; connect(c: object): Promise<void>; initSchema(): Promise<void>; disconnect(): Promise<void>; setConfig(k: string, v: string): Promise<void>; readPageSnapshot(slug: string, o: { sourceId: string }): Promise<{ revision: unknown } | null> }
type ChatOpts = { model?: string; system?: string; messages: Array<{ role: string; content: unknown }>; maxTokens?: number; temperature?: number; allowFallback?: boolean };
type ChatResult = { text: string; model: string; providerId?: string; stopReason?: string; usage: { input_tokens: number; output_tokens: number; cache_read_tokens?: number; cache_creation_tokens?: number }; blocks?: unknown[] };
/** gbrain's test chat transport shape (src/core/ai/gateway.ts __setChatTransportForTests). */
export type ChatTransport = (opts: ChatOpts) => Promise<ChatResult>;

interface Gateway {
  configureGateway(c: Record<string, unknown>): void;
  __setGenerateTextTransportForTests(fn: ((o: any) => Promise<any>) | null): void;
  chat(o: ChatOpts): Promise<ChatResult>;
  __setChatTransportForTests(fn: ChatTransport | null): void;
}

/**
 * Provider and judge error text, safe to keep in rows, checkpoints, receipts and logs: every key value set in `env`
 * under a key-shaped name, every key-shaped token, bearer and basic credentials and URL passwords are replaced with
 * [redacted]. Redact before truncating, so a cut never leaves part of a key behind.
 */
export function redactProviderText(text: string, env: Record<string, string | undefined> = process.env): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) if (value && value.length >= 8 && HERMETIC_KEY_PATTERN.test(name)) out = out.split(value).join('[redacted]');
  for (const { re } of KEY_PATTERNS) out = out.replace(re, '[redacted]');
  out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]').replace(/\b(x-api-key|api[_-]?key)(["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{8,}/gi, '$1$2[redacted]');
  return redactUrlPasswords(out, '[redacted]');
}

const callRecord = (r: QReceipt, usage: Usage, failure: string | null, safetyFinish: SafetyFinish | null): CallRecord => {
  const error = r.refresh?.error ?? r.refresh?.blocked_reason ?? (r.refresh?.status === 'published' ? null : r.last_error);
  return {
    status: r.refresh?.status ?? 'none', mode: r.refresh?.mode ?? null, error: error ? redactProviderText(error) : null,
    failure_message: r.refresh?.status === 'published' ? null : failure, safety_finish: r.refresh?.status === 'published' ? null : safetyFinish, cost_usd: r.refresh?.cost_usd ?? null, usage,
  };
};
const FAILURE_LINE = /\[questions\] refresh of \S+ failed: (.*)/;
const modelText = (r: QReceipt) => (r.answer ?? []).filter(s => s.origin === 'model');

/** One (model, seed) unit: a fresh brain, every question pinned, changed, refreshed and graded. */
async function runUnit(gut: GbrainUnderTest, gateway: Gateway, gatewayConfig: (chatModel: string) => Record<string, unknown>, usage: { current: Usage | null }, finish: { current: SafetyFinish | null | undefined }, model: string, world: PqWorld, maxOutputTokens?: number): Promise<PaidRow[]> {
  const { PGLiteEngine } = await importGbrain<{ PGLiteEngine: new () => Engine }>(gut, 'src/core/pglite-engine.ts');
  const { operations } = await importGbrain<{ operations: Array<{ name: string; handler: (ctx: OperationContext, p: Record<string, unknown>) => Promise<unknown> }> }>(gut, 'src/core/operations.ts');
  const service = await importGbrain<{
    pinQuestion(ctx: OperationContext, p: Record<string, unknown>): Promise<{ receipt: QReceipt }>;
    questionStatus(ctx: OperationContext, p: Record<string, unknown>): Promise<QReceipt>;
    refreshQuestion(ctx: OperationContext, p: Record<string, unknown>): Promise<QReceipt>;
  }>(gut, 'src/core/questions/service.ts');
  const metered = async <T>(fn: () => Promise<T>): Promise<{ value: T; usage: Usage; failure: string | null; safetyFinish: SafetyFinish | null }> => {
    const u = noUsage();
    usage.current = u;
    finish.current = null;
    let failure: string | null = null;
    const write = process.stderr.write;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      const m = FAILURE_LINE.exec(String(chunk));
      if (!m) return (write as (...a: unknown[]) => boolean).call(process.stderr, chunk, ...rest);
      failure = redactProviderText(m[1]!).slice(0, 500);
      return (write as (...a: unknown[]) => boolean).call(process.stderr, redactProviderText(String(chunk)), ...rest);
    }) as typeof process.stderr.write;
    try { return { value: await fn(), usage: u, failure, safetyFinish: finish.current ?? null }; } finally { usage.current = null; finish.current = undefined; process.stderr.write = write; }
  };

  gateway.configureGateway(gatewayConfig(model));
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const ctx = { engine, config: { engine: 'pglite', database_path: ':memory:', embedding_disabled: true }, logger, dryRun: false, remote: false, sourceId: 'default' } as unknown as OperationContext;
  const byName = new Map(operations.map(o => [o.name, o]));
  const op = async (name: string, params: Record<string, unknown>) => {
    const o = byName.get(name);
    if (!o) throw new Error(`gbrain has no operation ${name}`);
    return await o.handler(ctx, params);
  };
  const put = async (slug: string, content: string) => {
    const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
    await op('put_page', { slug, content, ...(snapshot ? { expected_revision: snapshot.revision } : {}) });
  };
  const factId = async (entity: string, text: string) => {
    const [row] = await engine.executeRaw<{ id: string | number }>(
      'SELECT id FROM facts WHERE entity_slug = $1 AND fact = $2 AND expired_at IS NULL AND superseded_by IS NULL ORDER BY id DESC LIMIT 1', [entity, text]);
    if (!row) throw new Error(`presence: remember wrote no live fact row for ${entity}: ${text}`);
    return Number(row.id);
  };

  const pending: Array<{ c: PqCompany; pin: CallRecord; first: string[]; refresh: PaidRow['refresh']; refreshed: Sentence[] }> = [];
  try {
    await engine.setConfig('models.standing_questions', model);
    if (maxOutputTokens) await engine.setConfig(MAX_OUTPUT_TOKENS_KEY, String(maxOutputTokens));
    for (const p of world.pages) await put(p.slug, p.content);
    const facts = new Map<string, number>();
    for (const f of world.facts) {
      await op('remember', { fact: f.text, entity: f.entity, kind: 'fact', visibility: 'world', provenance: 'pinned-questions world ledger' });
      facts.set(f.entity, await factId(f.entity, f.text));
    }
    const pins = new Map<string, { id: string; pin: CallRecord; first: string[] }>();
    for (const c of world.companies) {
      const { value, usage: u, failure, safetyFinish } = await metered(() => service.pinQuestion(ctx, { question: c.question, scope: { entity: c.slug }, wait_ms: WAIT_MS }));
      pins.set(c.slug, { id: value.receipt.id, pin: callRecord(value.receipt, u, failure, safetyFinish), first: modelText(value.receipt).map(s => s.text) });
    }
    for (const c of world.companies) {
      for (const step of c.steps) {
        if (step.op === 'put') await put(step.page.slug, step.page.content);
        else if (step.op === 'delete') {
          const snapshot = await engine.readPageSnapshot(step.slug, { sourceId: 'default' });
          await op('delete_page', { slug: step.slug, ...(snapshot ? { expected_revision: snapshot.revision } : {}) });
        } else {
          await op('remember', { fact: step.fact.text, entity: step.fact.entity, kind: 'fact', visibility: 'world', provenance: 'pinned-questions world ledger', replaces: facts.get(step.fact.entity) });
          await factId(step.fact.entity, step.fact.text);
        }
      }
      const p = pins.get(c.slug)!;
      const { value, usage: u, failure, safetyFinish } = await metered(() => service.refreshQuestion(ctx, { id: p.id, wait_ms: WAIT_MS }));
      const status = await service.questionStatus(ctx, { id: p.id });
      pending.push({ c, pin: p.pin, first: p.first, refresh: { ...callRecord(value, u, failure, safetyFinish), freshness: status.freshness, stale_sentences: status.sentences.stale }, refreshed: modelText(status) });
    }
  } finally {
    await engine.disconnect().catch(() => {});
  }

  const judge = judgeFor(model);
  gateway.configureGateway(gatewayConfig(judge));
  const grade = async (c: PqCompany, kind: 'first' | 'refreshed', sentences: string[]): Promise<GradedAnswer> => {
    const rule = ruleLabels(c, kind, sentences);
    const g: GradedAnswer = { sentences, judge_labels: null, judge_error: null, answer_correct: null, rule_labels: rule, rule_correct: Object.values(rule).includes('ambiguous') ? null : Object.values(rule).every(l => l === 'correct'), judge_usage: noUsage() };
    const user = judgeUserMessage(c, kind, sentences);
    const { usage: u } = await metered(async () => {
      for (const content of [user, `${user}\n\n${JUDGE_RETRY_NOTE}`]) {
        try {
          const res = await gateway.chat({ model: judge, system: PINNED_QUESTIONS_JUDGE_PROMPT, messages: [{ role: 'user', content }], maxTokens: JUDGE_MAX_TOKENS, allowFallback: false, ...(acceptsTemperature(judge) ? { temperature: 0 } : {}) });
          g.judge_labels = parseJudgeLabels(res.text);
          g.judge_error = g.judge_labels ? null : 'judge_output_not_json';
        } catch (e) {
          g.judge_error = `judge_call_failed: ${redactProviderText(e instanceof Error ? e.message : String(e)).slice(0, 300)}`;
          return;
        }
        if (g.judge_labels) return;
      }
    });
    g.judge_usage = u;
    g.answer_correct = g.judge_labels ? CLAIMS.every(claim => g.judge_labels![claim] === 'correct') : null;
    return g;
  };
  const rows: PaidRow[] = [];
  for (const p of pending) {
    const first = await grade(p.c, 'first', p.first);
    const refreshed = await grade(p.c, 'refreshed', p.refreshed.map(s => s.text));
    const row = {
      model, seed: world.seed, company: p.c.slug, mutation: p.c.mutation, affected: [...p.c.affected], judge_model: judge,
      pin: p.pin, refresh: p.refresh, first, refreshed: { ...refreshed, stale: p.refreshed.map(s => s.stale) },
    };
    rows.push({ ...row, answer_model: answerModelOf(row), outcome: outcomeOf(p.refresh), correct: scoredCorrect(row) });
  }
  return rows;
}

export type PaidMode = { kind: 'paid'; keys: Partial<Record<typeof PAID_KEY_NAMES[number], string>> } | { kind: 'keyless'; transport: ChatTransport };

/** A unit is asked at most this often: a unit with provider or judge-call errors is asked again once, then kept with those questions left out. */
export const MAX_UNIT_ATTEMPTS = 2;
export interface Checkpointed { key: string; model: string; seed: number; attempt: number; transient: boolean; rows: PaidRow[] }
export const unitTransient = (unit: readonly PaidRow[]) => unit.some(r =>
  outcomeOf(r.pin) === 'provider_error' || r.outcome === 'provider_error' || [r.first.judge_error, r.refreshed.judge_error].some(e => e?.startsWith('judge_call_failed')));
/**
 * Checkpointed units. A final line with no newline that does not parse is an append a crash or full disk cut short: it
 * is cut off the file, so earlier units are reused and the next append starts on a clean line. Any other line that does
 * not parse is corruption, and the run stops rather than drop units silently.
 */
export function readCheckpoint(path: string, log: (s: string) => void = () => {}): Checkpointed[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  const end = text.lastIndexOf('\n') + 1;
  const tail = text.slice(end);
  if (tail.trim()) {
    try { JSON.parse(tail); appendFileSync(path, '\n'); } catch {
      truncateSync(path, Buffer.byteLength(text.slice(0, end)));
      log(`[pq-paid] ${path}: cut off a torn final line (${tail.length} chars) left by an interrupted append; its unit runs again`);
      return readCheckpoint(path, log);
    }
  }
  return text.split('\n').flatMap((l, i) => {
    if (!l.trim()) return [];
    try { return [JSON.parse(l) as Checkpointed]; } catch { throw new Error(`${path}: line ${i + 1} is not valid JSON and is not a torn final line; refusing to resume over a corrupt checkpoint`); }
  });
}

const isBudgetRefusal = (e: unknown) => e instanceof BudgetExceededError || (e instanceof Error && e.name === 'BudgetExceededError');

export interface PaidRunResult { worlds: PqWorld[]; rows: PaidRow[]; acc: ProbeAccounting; harnessErrors: string[]; resumedUnits: number }

/**
 * What a checkpointed unit must match to be reused: mode, gbrain build, generator, world size, output cap, judge prompt,
 * and the runner's and generator's own source (WAIT_MS, the judge routing, the grading and every other constant here).
 */
export function checkpointKey(o: { mode: PaidMode['kind']; gut: GbrainUnderTest; companies?: number; maxOutputTokens?: number }): string {
  return JSON.stringify({
    runner_sha256: RUNNER_SOURCE_SHA256,
    mode: o.mode, gbrain: o.gut.overlay?.build.commit ?? o.gut.version, generator: PINNED_QUESTIONS_GENERATOR_VERSION, companies: o.companies ?? 24, max_output_tokens: o.maxOutputTokens ?? null,
    judge_prompt_sha256: createHash('sha256').update(PINNED_QUESTIONS_JUDGE_PROMPT).digest('hex'),
  });
}

const RUNNER_SOURCE_SHA256 = createHash('sha256').update(readFileSync(import.meta.path)).update(readFileSync(resolve(import.meta.dir, '../generators/pinned-questions-gen.ts'))).digest('hex');

/**
 * Refuse a launch into an output directory whose checkpoint holds units outside this launch's seeds: each stage gets its
 * own directory, except that the judge-check stage resumes the pilot's seed in the pilot's directory.
 */
export function requireStageDirectory(output: string, seeds: readonly number[]): void {
  const foreign = [...new Set(readCheckpoint(join(output, 'checkpoint.ndjson')).map(x => x.seed).filter(s => !seeds.includes(s)))];
  if (foreign.length) throw new PaidArmRefusal(`${CATEGORY}: ${output} already holds checkpointed units for seeds ${foreign.join(', ')}, outside this launch's seeds (${seeds.join(', ')}); give this stage its own --output`);
}

/** The (model, seed) units a launch would still ask: those with no checkpointed unit, or one owed its retry. */
export function pendingUnits(output: string, key: string, models: readonly string[], seeds: readonly number[]): Array<{ model: string; seed: number }> {
  const done = readCheckpoint(join(output, 'checkpoint.ndjson')).filter(x => x.key === key);
  return models.flatMap(model => seeds.map(seed => ({ model, seed }))).filter(({ model, seed }) => {
    const prior = done.filter(x => x.model === model && x.seed === seed).at(-1);
    return !prior || (prior.transient && prior.attempt < MAX_UNIT_ATTEMPTS);
  });
}

type Unit = { model: string; seed: number };
const unitId = (u: Unit) => `${u.model}|${u.seed}`;
interface CostLine { key: string; stage: Stage; asked: Unit[]; summary: RunSummary }

/** Each paid process appends its ledger summary to ledger-costs.ndjson, with its stage and the units it asked. */
export function recordProcessCost(output: string, line: CostLine): void {
  mkdirSync(output, { recursive: true });
  appendFileSync(join(output, 'ledger-costs.ndjson'), JSON.stringify(line) + '\n');
}

/**
 * Spend for a receipt whose rows may come from several processes: every recorded summary under the checkpoint key
 * whose process asked a unit behind the receipt's rows, so a resumed receipt carries the cost of every attempt behind
 * its rows, and never the spend of another stage's units that share the output directory.
 */
export function combinedCost(output: string, key: string, behind: readonly Unit[], current: RunSummary): RunSummary & { processes: number } {
  const path = join(output, 'ledger-costs.ndjson');
  const ids = new Set(behind.map(unitId));
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n').flatMap(l => { try { return [JSON.parse(l) as CostLine]; } catch { return []; } }) : [];
  const all = lines.filter(x => x.key === key && (x.asked ?? []).some(u => ids.has(unitId(u)))).map(x => x.summary);
  const sum = (f: (s: RunSummary) => number) => all.reduce((a, s) => a + f(s), 0);
  return {
    ...current, run_id: [...new Set(all.map(s => s.run_id))].join(',') || current.run_id, processes: all.length,
    reserved_usd: sum(s => s.reserved_usd), actual_usd: sum(s => s.actual_usd), charged_reservations: sum(s => s.charged_reservations), requests: sum(s => s.requests),
    input_tokens: sum(s => s.input_tokens), output_tokens: sum(s => s.output_tokens), overshoot_usd: sum(s => s.overshoot_usd),
  };
}

export async function runPinnedQuestionsPaid(opts: { gut: GbrainUnderTest; models: readonly string[]; seeds: readonly number[]; companies?: number; maxOutputTokens?: number; output: string; mode: PaidMode; log?: (s: string) => void }): Promise<PaidRunResult> {
  if (opts.mode.kind === 'paid' && !paidRequestGuardActive()) {
    throw new PaidArmRefusal(`${CATEGORY}: a paid run needs the budget ledger's request guard installed first (startPaidRun, as main() does); refusing before any request.`);
  }
  const log = opts.log ?? (() => {});
  const models = opts.models.map(canonicalModel);
  for (const m of models) judgeFor(m);
  mkdirSync(opts.output, { recursive: true });
  return withHermeticEnv(CATEGORY, async () => {
    if (opts.mode.kind === 'paid') {
      for (const [k, v] of Object.entries(opts.mode.keys)) if (v) process.env[k] = v;
    }
    const gateway = await importGbrain<Gateway>(opts.gut, 'src/core/ai/gateway.ts');
    const { registerChatUsageSink } = await importGbrain<{ registerChatUsageSink(sink: (r: { model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number }) => void): () => void }>(opts.gut, 'src/core/ai/chat-usage.ts');
    const env = opts.mode.kind === 'paid' ? { ...opts.mode.keys } : { ANTHROPIC_API_KEY: 'keyless-placeholder-not-a-key' };
    const gatewayConfig = (chatModel: string) => ({
      chat_model: chatModel, env, provider_chat_options: { particle: { reasoningEffort: PARTICLE_REASONING_EFFORT } },
      ...(opts.mode.kind === 'keyless' ? { base_urls: DEAD_UPSTREAM } : {}),
    });
    const usage: { current: Usage | null } = { current: null };
    const deregister = registerChatUsageSink(r => {
      const u = usage.current;
      if (!u) return;
      u.calls++; u.input_tokens += r.input_tokens; u.output_tokens += r.output_tokens; u.cache_read_tokens += r.cache_read_tokens; u.cache_write_tokens += r.cache_write_tokens;
      if (!u.models!.includes(r.model)) u.models!.push(r.model);
    });
    const spend: { stop: string | null } = { stop: null };
    const noteRefusal = (e: unknown) => { if (isBudgetRefusal(e)) spend.stop ??= (e as Error).message.slice(0, 300); };
    const finish: { current: SafetyFinish | null | undefined } = { current: undefined };
    const noteFinish = (f: SafetyFinish | null) => { if (f && finish.current !== undefined) finish.current ??= f; };
    const outerFetch = globalThis.fetch;
    try {
      if (opts.mode.kind === 'keyless') {
        const transport = opts.mode.transport;
        gateway.__setChatTransportForTests(async o => {
          try { const res = await transport(o); noteFinish(safetyFinishOf({ stopReason: res.stopReason })); return res; } catch (e) { noteRefusal(e); throw e; }
        });
      } else {
        globalThis.fetch = Object.assign(async (...a: Parameters<typeof fetch>) => { try { return await outerFetch(...a); } catch (e) { noteRefusal(e); throw e; } }, outerFetch);
        const { generateText } = await import(Bun.resolveSync('ai', opts.gut.root)) as { generateText: (o: any) => Promise<any> };
        gateway.__setGenerateTextTransportForTests(recordingGenerateText(generateText, noteFinish));
      }
      const worlds = opts.seeds.map(seed => generatePinnedQuestionsWorld({ seed, companies: opts.companies }));
      const ckPath = join(opts.output, 'checkpoint.ndjson');
      const ckKey = checkpointKey({ mode: opts.mode.kind, gut: opts.gut, companies: opts.companies, maxOutputTokens: opts.maxOutputTokens });
      const done = readCheckpoint(ckPath, log).filter(x => x.key === ckKey);
      const acc = new ProbeAccounting(models.length * worlds.reduce((a, w) => a + w.companies.length, 0));
      const rows: PaidRow[] = [];
      const harnessErrors: string[] = [];
      let resumedUnits = 0;
      units: for (const model of models) for (const world of worlds) {
        const prior = done.filter(x => x.model === model && x.seed === world.seed).at(-1);
        let unit: PaidRow[];
        if (prior && !(prior.transient && prior.attempt < MAX_UNIT_ATTEMPTS)) {
          unit = prior.rows;
          resumedUnits++;
        } else {
          const attempt = (prior?.attempt ?? 0) + 1;
          try {
            unit = await runUnit(opts.gut, gateway, gatewayConfig, usage, finish, model, world, opts.maxOutputTokens);
          } catch (e) {
            const msg = `${model} seed ${world.seed}: ${redactProviderText(e instanceof Error ? e.message : String(e))}`;
            harnessErrors.push(msg);
            for (const c of world.companies) acc.error(`${model}|s${world.seed}|${c.slug}`, 'harness', msg);
            log(`[pq-paid] ${msg}`);
            if (spend.stop) break units;
            continue;
          }
          if (spend.stop) {
            const msg = `${model} seed ${world.seed}: the budget ledger refused a request (${spend.stop}); paused at the unit boundary with this unit not checkpointed. Extend the cap and rerun with the same arguments to resume.`;
            harnessErrors.push(msg);
            log(`[pq-paid] ${msg}`);
            break units;
          }
          appendFileSync(ckPath, JSON.stringify({ key: ckKey, model, seed: world.seed, attempt, transient: unitTransient(unit), rows: unit } satisfies Checkpointed) + '\n');
          if (unitTransient(unit) && attempt < MAX_UNIT_ATTEMPTS) {
            const msg = `${model} seed ${world.seed}: provider or judge-call errors on attempt ${attempt} of ${MAX_UNIT_ATTEMPTS}; the run is incomplete until a rerun with the same arguments asks this unit again`;
            harnessErrors.push(msg);
            log(`[pq-paid] ${msg}`);
          }
        }
        for (const r of unit) {
          const probe = `${model}|s${r.seed}|${r.company}`;
          if (r.correct !== null) acc.score(probe, Number(r.correct));
          else if (harnessBlocked(r.pin) || harnessBlocked(r.refresh)) acc.error(probe, 'harness', `gbrain blocked the call: ${harnessBlocked(r.refresh) ? r.refresh.error : r.pin.error}`);
          else if (servedWrongModel(r)) acc.error(probe, 'harness', `answered by ${[...new Set([...(r.pin.usage.models ?? []), ...(r.refresh.usage.models ?? [])])].join(', ')}, not ${r.model}`);
          else if (r.outcome === 'provider_error' || outcomeOf(r.pin) === 'provider_error') acc.error(probe, 'dependency', r.refresh.failure_message ?? r.refresh.error ?? r.pin.error ?? 'provider error');
          else acc.error(probe, 'judge', r.refreshed.judge_error ?? 'no judge labels');
        }
        const blocked = unit.filter(r => harnessBlocked(r.pin) || harnessBlocked(r.refresh)).length;
        const misrouted = unit.filter(r => servedWrongModel(r)).length;
        if (misrouted) harnessErrors.push(`${model} seed ${world.seed}: another model answered ${misrouted} question(s); these rows are not results for ${model}`);
        if (blocked) harnessErrors.push(`${model} seed ${world.seed}: gbrain blocked ${blocked} question(s) for a setup reason (no key, consent, worker or gbrain spend limit); fix the setup, these are not model results`);
        rows.push(...unit);
        log(`[pq-paid] ${model} seed ${world.seed}${prior ? ' (from checkpoint)' : ''}: refreshed correct ${unit.filter(r => r.correct).length}/${unit.length}`);
      }
      return { worlds, rows, acc, harnessErrors, resumedUnits };
    } finally {
      deregister();
      if (opts.mode.kind === 'keyless') gateway.__setChatTransportForTests(null);
      else { globalThis.fetch = outerFetch; gateway.__setGenerateTextTransportForTests(null); }
    }
  });
}

/** The roles every model plays, for the receipt and the registry entry. */
export function modelRoles(models: readonly string[]): Array<{ model: string; role: 'model under test' | 'judge'; grades?: string[] }> {
  const ms = models.map(canonicalModel);
  const judges = [...new Set(ms.map(judgeFor))];
  return [
    ...ms.map(model => ({ model, role: 'model under test' as const })),
    ...judges.map(model => ({ model, role: 'judge' as const, grades: ms.filter(m => judgeFor(m) === model) })),
  ];
}

export function buildReceipt(opts: { gut: GbrainUnderTest; models: readonly string[]; seeds: readonly number[]; companies: number; stage: Stage; maxOutputTokens?: number; result: PaidRunResult; cost: RunSummary | null; startedAt: string; mode: PaidMode['kind']; judgeCheckSha256?: string | null }): Receipt {
  const r = opts.result;
  const a = r.acc.summary();
  return {
    ...(opts.cost ? { cost: receiptCost(opts.cost), delivered_tokens: null } : noModelSpend('keyless: gbrain test chat transport, placeholder key, dead upstream; no paid request')),
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CATEGORY,
    run_status: r.harnessErrors.length ? 'error' : 'completed',
    ...(r.harnessErrors.length ? {} : { verdict: judgeCheckPasses(r.rows, [...new Set(opts.models.map(m => judgeFor(canonicalModel(m))))]) ? 'pass' as const : 'fail' as const }),
    n_total: a.n_total, n_scored: a.n_scored, completion_rate: a.completion_rate, errors: a.errors,
    publishable: a.publishable && r.harnessErrors.length === 0 && opts.mode === 'paid',
    gbrain_version: opts.gut.version,
    gbrain_pin: gbrainPin(),
    execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(opts.gut) },
    resolved_config: {
      mode: opts.mode, engine: 'pglite-in-memory',
      caller: 'operation handlers and src/core/questions/service.ts (pinQuestion, refreshQuestion, questionStatus) with OperationContext { remote: false, sourceId: default }; no injected chat',
      gate: 'report-only',
      models: modelRoles(opts.models),
      stage: opts.stage,
      model_config: `models.standing_questions set to the model under test per brain; ${opts.maxOutputTokens ? `${MAX_OUTPUT_TOKENS_KEY} raised to ${opts.maxOutputTokens} (the raised-cap arm)` : 'refresh output cap at gbrain\'s default of 2,000 tokens'}; gbrain defaults otherwise (budget $1 per refresh)`,
      max_output_tokens: opts.maxOutputTokens ?? null,
      particle_reasoning_effort: `${PARTICLE_REASONING_EFFORT} (provider_chat_options.particle.reasoningEffort)`,
      wait_ms: WAIT_MS,
      judge: { prompt_sha256: createHash('sha256').update(PINNED_QUESTIONS_JUDGE_PROMPT).digest('hex'), max_tokens: JUDGE_MAX_TOKENS, temperature_sent: null, route: 'gbrain gateway chat, allowFallback false', retries: 'one retry on unparseable output' },
      verdict: `judge check only (every judge's kappa against the rule labels at least ${JUDGE_KAPPA_FLOOR} on at least ${JUDGE_MIN_LABELS} outputs); the category is report-only; data.summary.truncation names the models over the ${TRUNCATION_BAR * 100}% cut-off bar`,
      grading: 'first answers against the ledger before the change, refreshed answers against it after; answer_correct = every claim correct (a removed claim is correct when not asserted); the scored row.correct is false when the refresh did not publish and null (left out) after a provider error or a failed judge call (scoredCorrect)',
      retries: `a unit with provider or judge-call errors is asked again once in a resumed run (${MAX_UNIT_ATTEMPTS} attempts), then kept with those questions left out; a budget-ledger refusal pauses the run at the unit boundary without checkpointing that unit`,
      seeds: opts.seeds, companies_per_seed: opts.companies, generator_version: PINNED_QUESTIONS_GENERATOR_VERSION,
      resumed_units: r.resumedUnits,
      judge_check_receipt_sha256: opts.judgeCheckSha256 ?? null,
      cost_processes: opts.cost && 'processes' in opts.cost ? opts.cost.processes : null,
      gbrain_overlay: overlaySummary(opts.gut),
    },
    hashes: Object.fromEntries(r.worlds.map(w => [`ledger_seed_${w.seed}`, w.fingerprint])),
    started_at: opts.startedAt,
    finished_at: new Date().toISOString(),
    data: { summary: summarizePaid(r.rows), rows: r.rows, harness_errors: r.harnessErrors },
  } as unknown as Receipt;
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) return argv[at + 1];
  return argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

/** Refuses a run without --paid, and without a --budget-run-id naming an open ledger run with room for the estimate. */
export function requirePaidFlags(argv: readonly string[], estimate: number): void {
  if (!argv.includes('--paid')) {
    throw new PaidArmRefusal(`${CATEGORY} spends money (estimate $${estimate.toFixed(2)}), and --paid is missing. Pass --paid with --budget-run-id <id>.`);
  }
  requirePaidArm(argv, { arm: CATEGORY, estimateUsd: estimate, ledgerPath: budgetOptionsFrom(argv).ledgerPath });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const models = (argValue(argv, '--models') ?? PINNED_QUESTIONS_MODELS_UNDER_TEST.join(',')).split(',').map(canonicalModel);
  const stage = (argValue(argv, '--stage') ?? 'dev') as Stage;
  if (!(stage in STAGE_SEEDS)) throw new Error(`--stage must be one of ${Object.keys(STAGE_SEEDS).join(', ')}`);
  const seeds = (argValue(argv, '--seeds') ?? STAGE_SEEDS[stage].join(',')).split(',').map(Number);
  const companies = Number(argValue(argv, '--companies') ?? 24);
  const capFlag = argValue(argv, '--max-output-tokens');
  const maxOutputTokens = capFlag === undefined ? undefined : Number(capFlag);
  if (maxOutputTokens !== undefined && !(Number.isInteger(maxOutputTokens) && maxOutputTokens > 0)) throw new Error('--max-output-tokens must be a positive integer');
  const outFlag = argValue(argv, '--output');
  if (!outFlag) throw new Error('--output <dir> is required: it holds checkpoint.ndjson, so an interrupted run resumes');
  const output = resolve(outFlag);
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  const key = checkpointKey({ mode: 'paid', gut, companies, maxOutputTokens });
  requireStageDirectory(output, seeds);
  const pending = pendingUnits(output, key, models, seeds);
  const judgeCheck = stage === 'counted' ? argValue(argv, '--judge-check') : undefined;
  const judge = measuredJudge(judgeEstimateRows(output, key, judgeCheck));
  const estimate = models.reduce((s, m) => s + estimateUsd([m], pending.filter(u => u.model === m).length, companies, maxOutputTokens, judge), 0);
  requirePaidFlags(argv, estimate);
  requireProviderKeys(models);
  if (stage === 'counted') requireJudgeCheck(judgeCheck, { gut, models });
  const judgeCheckSha256 = judgeCheck ? createHash('sha256').update(readFileSync(judgeCheck)).digest('hex') : null;
  const keys = Object.fromEntries(PAID_KEY_NAMES.map(k => [k, process.env[k]]).filter(([, v]) => v)) as Partial<Record<typeof PAID_KEY_NAMES[number], string>>;
  const startedAt = new Date().toISOString();
  const paid = startPaidRun(CATEGORY, { ...budgetOptionsFrom(argv), estimateUsd: estimate });
  let result: PaidRunResult;
  let closed: RunSummary;
  try {
    result = await runPinnedQuestionsPaid({ gut, models, seeds, companies, maxOutputTokens, output, mode: { kind: 'paid', keys }, log: s => console.error(s) });
  } finally {
    closed = paid.run.close();
    paid.guard.uninstall();
    recordProcessCost(output, { key, stage, asked: pending, summary: closed });
  }
  const cost = combinedCost(output, key, result.rows.map(r => ({ model: r.model, seed: r.seed })), closed);
  writeReceipt(receiptFile(output, stage), buildReceipt({ gut, models, seeds, companies, stage, maxOutputTokens, result, cost, startedAt, mode: 'paid', judgeCheckSha256 }));
  const s = summarizePaid(result.rows);
  console.log(JSON.stringify({ by_model: Object.fromEntries(Object.entries(s.by_model).map(([m, v]) => [m, { first_correct: v.first_correct, refreshed_correct: v.refreshed_correct, refresh_outcome: v.refresh_outcome, refreshed_excluded: v.refreshed_excluded, answer_too_long: v.answer_too_long }])), judge_agreement: s.judge_agreement, truncation: s.truncation, cost_usd: receiptCost(cost).usd }, null, 2));
  process.exit(result.harnessErrors.length ? 3 : 0);
}

if (import.meta.main) {
  main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(e instanceof PaidArmRefusal ? 2 : 3); });
}

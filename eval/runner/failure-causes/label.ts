/**
 * The residual labeller: a model picks the cause only for failures the
 * deterministic rules could not place (classify() basis needs_model), where the
 * evidence reached the answering model or the source did not measure that but
 * kept the delivered context. For those, the labeller may also answer
 * evidence_not_delivered, which counts as an upstream miss (wrong_ranking when
 * the gold was retrieved, else retrieval_miss), never as a reasoning cause.
 *
 * The labeller is cross-family: GPT-6.1 Sol labels Claude rows, and Opus 5.5
 * labels GPT and particle-1 rows. The label set is built from rows that Opus 5.5
 * and GPT-6 Astra, both at high effort, label the same way. Row text is fenced
 * as untrusted data, the reply must name a cause from the taxonomy, and private
 * or sealed rows are never sent. The client is injected: tests use a fake, and
 * the CLI builds the real one only inside a paid run.
 */
import { createHash } from 'node:crypto';
import { fenceUntrusted, withUntrustedInstruction } from '../judge.ts';
import type { ChatLike } from '../memory-qa/qa-v2.ts';
import type { DoubleLabel } from './agreement.ts';
import { classify, deliveryUnknown } from './classify.ts';
import { CAUSES, MODEL_CAUSES, UNCLASSIFIED, type Cause, type Tag } from './taxonomy.ts';
import { EVAL_FAILURE_SCHEMA, type CauseLabel, type EvalFailure } from './types.ts';

export interface LabellerSpec { model: string; effort: string; path: string }

export const PRODUCTION_LABELLERS: Record<string, LabellerSpec> = {
  anthropic: { model: 'openai:gpt-6.1-sol', effort: 'medium', path: 'sol-labels-claude-rows' },
  openai: { model: 'anthropic:claude-opus-5-5', effort: 'medium', path: 'opus-labels-gpt-rows' },
  particle: { model: 'anthropic:claude-opus-5-5', effort: 'medium', path: 'opus-labels-particle-rows' },
};
/** The fallback for a production path whose held-out kappa is under 0.6 (GBEV-3, 2026-11-09). */
export const ASTRA_LABELLER: LabellerSpec = { model: 'openai:gpt-6-astra', effort: 'high', path: 'astra-fallback' };
export const LABEL_SET_LABELLERS: readonly LabellerSpec[] = [
  { model: 'anthropic:claude-opus-5-5', effort: 'high', path: 'labelset-opus' },
  { model: 'openai:gpt-6-astra', effort: 'high', path: 'labelset-astra' },
];
export const LABEL_MAX_TOKENS = 16_000;
/** The labeller's answer when the delivered context lacks the evidence; resolveChoice maps it to an upstream cause. */
export const NOT_DELIVERED = 'evidence_not_delivered';
const CONTEXT_CHARS = 60_000;

/** The production labeller for a row, by the family of the model that produced it; overrides replace a family's path. */
export function labellerFor(rowModel: string, overrides: Partial<Record<string, LabellerSpec>> = {}): LabellerSpec {
  const family = rowModel.split(':')[0];
  const spec = overrides[family] ?? PRODUCTION_LABELLERS[family];
  if (!spec) throw new Error(`no labeller path for rows from ${rowModel}`);
  if (spec.model.split(':')[0] === family) throw new Error(`${spec.path} would label its own family's rows (${rowModel}); a labeller is always cross-family`);
  return spec;
}

const SYSTEM = withUntrustedInstruction([
  'You classify why an AI memory system and the model reading it failed one eval question.',
  'Earlier stages (ingest, tool calls, writes, retrieval, ranking) were already checked from the logs and showed no fault the logs can see.',
  'Choose the single cause that best explains the wrong answer, from the list you are given, or "unclassified" when none fits or the evidence is too thin.',
  'Reply with one line of JSON and nothing else: {"cause":"<cause id>","reason":"<one sentence>"}.',
].join('\n'));

export function buildLabelPrompt(f: EvalFailure): { system: string; prompt: string; sha256: string } {
  if (f.visibility === 'private' || f.visibility === 'sealed') throw new Error(`${f.case_id}: ${f.visibility} rows are never sent to a labeller`);
  if (!f.text) throw new Error(`${f.case_id}: no text to label`);
  const nonce = createHash('sha256').update(`${f.source}|${f.case_id}`).digest('hex').slice(0, 24);
  const choices = CAUSES.filter(c => MODEL_CAUSES.includes(c.id)).map(c => `- ${c.id}: ${c.meaning}`);
  if (deliveryUnknown(f)) choices.push(`- ${NOT_DELIVERED}: the delivered context does not contain the evidence the expected answer needs, so the miss happened before the model read it.`);
  const context = f.text.context === null ? '(the source did not record the delivered context)'
    : f.text.context.length > CONTEXT_CHARS ? f.text.context.slice(0, CONTEXT_CHARS) + '\n[context cut for length]' : f.text.context;
  const prompt = [
    'Causes to choose from:',
    ...choices,
    `- ${UNCLASSIFIED}: none of the above fits, or the record is too thin to tell.`,
    '',
    `Question category (a hint, not proof): ${f.category ?? 'unknown'}`,
    `Stages the logs could not measure: ${classify(f).unmeasured.join(', ') || 'none'}`,
    `Score on the source's own scale: ${f.score ?? 'unknown'}`,
    '',
    fenceUntrusted('question', f.text.question, nonce),
    fenceUntrusted('expected_answer', f.text.expected ?? '(no reference answer recorded)', nonce),
    fenceUntrusted('delivered_context', context, nonce),
    fenceUntrusted('model_answer', f.text.answer, nonce),
  ].join('\n');
  return { system: SYSTEM, prompt, sha256: createHash('sha256').update(SYSTEM + '\n' + prompt).digest('hex') };
}

const PROBE: EvalFailure = {
  schema: EVAL_FAILURE_SCHEMA, source: 'probe', run_id: 'probe', case_id: 'probe', system: 'probe', arm: 'probe', arm_role: 'gbrain_default', condition: 'natural',
  visibility: 'synthetic', model: 'anthropic:probe', gbrain_sha: null, failed: true, score: 0, category: 'probe', agent_loop: false, stop: null, finish_reason: null,
  harness: null, operation: null, tool_calls: null, gold: { gold_count: 1, stored: null, hidden: null, retrieved: null, delivered: 'all', opened: null, summary_only: null },
  writes: null, tags: [], evidence: [], text: { question: 'q', expected: 'e', answer: 'a', context: 'c' },
};
/**
 * The labeller prompt's identity: the hash of the prompts built for three fixed probe rows (one with every field, one with
 * delivery unmeasured and nothing recorded, one whose context is cut for length), so a change to the instruction, the
 * cause list, the template or the context cut changes it. agree stamps it on the gate file, and report refuses a gate
 * stamped with another.
 */
export const LABEL_PROMPT_SHA256 = createHash('sha256').update([PROBE,
  { ...PROBE, gold: { ...PROBE.gold, delivered: null }, text: { question: 'q', expected: null, answer: 'a', context: null } },
  { ...PROBE, text: { question: 'q', expected: 'e', answer: 'a', context: 'c'.repeat(CONTEXT_CHARS + 1) } }].map(p => buildLabelPrompt(p).sha256).join('\n')).digest('hex');

/** The last JSON object in a reply that has a cause field; braces inside its strings are fine. */
function lastCauseObject(text: string): Record<string, unknown> | null {
  const opens = [...text.matchAll(/\{/g)].map(m => m.index!).reverse();
  const closes = [...text.matchAll(/\}/g)].map(m => m.index!).reverse();
  for (const s of opens) for (const e of closes) {
    if (e < s) break;
    try {
      const v = JSON.parse(text.slice(s, e + 1));
      if (v && typeof v === 'object' && 'cause' in v) return v;
    } catch { /* not a complete object at this span */ }
  }
  return null;
}

export function parseLabel(text: string, options: { notDelivered?: boolean } = {}): { cause: Cause | typeof UNCLASSIFIED | typeof NOT_DELIVERED; reason: string | null; ok: boolean } {
  if (!/\{/.test(text)) return { cause: UNCLASSIFIED, reason: 'no JSON object in the reply', ok: false };
  const parsed = lastCauseObject(text);
  if (!parsed) return { cause: UNCLASSIFIED, reason: 'reply JSON did not parse', ok: false };
  const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 300) : null;
  if (parsed.cause === UNCLASSIFIED) return { cause: UNCLASSIFIED, reason, ok: true };
  if (parsed.cause === NOT_DELIVERED && options.notDelivered) return { cause: NOT_DELIVERED, reason, ok: true };
  if (typeof parsed.cause === 'string' && (MODEL_CAUSES as readonly string[]).includes(parsed.cause)) return { cause: parsed.cause as Cause, reason, ok: true };
  return { cause: UNCLASSIFIED, reason: `invalid cause ${JSON.stringify(parsed.cause)}`.slice(0, 120), ok: false };
}

/** The cause a labeller choice stands for on this row: evidence_not_delivered becomes the upstream miss the gold record allows. */
export function resolveChoice(f: EvalFailure, choice: string): { cause: Cause | typeof UNCLASSIFIED; rule_id: string; tags: Tag[] } {
  if (choice !== NOT_DELIVERED) return { cause: choice as Cause | typeof UNCLASSIFIED, rule_id: 'labeller', tags: [] };
  const retrieved = f.gold.retrieved === 'all' || f.gold.retrieved === 'partial';
  return retrieved ? { cause: 'wrong_ranking', rule_id: 'labeller.evidence_not_delivered', tags: [] }
    : { cause: 'retrieval_miss', rule_id: 'labeller.evidence_not_delivered', tags: ['retrieval_or_ranking'] };
}

export interface LabelRun { labels: CauseLabel[]; stopped: string | null }

/**
 * Classify every failure, and label the residuals with the given labeller. A budget refusal stops the run: the labels so
 * far come back with stopped set, and the remaining residuals stay needs_model.
 */
export async function labelResidual(failures: EvalFailure[], client: ChatLike, options: { labeller?: (f: EvalFailure) => LabellerSpec; maxTokens?: number } = {}): Promise<LabelRun> {
  const pick = options.labeller ?? (f => labellerFor(f.model));
  const labels: CauseLabel[] = [];
  let stopped: string | null = null;
  for (const f of failures) {
    const base = classify(f);
    if (base.basis !== 'needs_model' || stopped || !f.text || f.visibility === 'private' || f.visibility === 'sealed') { labels.push(base); continue; }
    const spec = pick(f);
    const { system, prompt, sha256 } = buildLabelPrompt(f);
    try {
      const reply = await client.chat(spec.model, prompt, { maxTokens: options.maxTokens ?? LABEL_MAX_TOKENS, replicate: 0, temperature: null, effort: spec.effort, system });
      const parsed = parseLabel(reply.text, { notDelivered: deliveryUnknown(f) });
      const got = resolveChoice(f, parsed.cause);
      labels.push({ ...base, cause: got.cause, basis: got.cause === UNCLASSIFIED ? 'unclassified' : 'model', rule_id: parsed.ok ? got.rule_id : 'labeller.invalid_reply',
        tags: [...new Set([...base.tags, ...got.tags])].sort(),
        labeller: { model: spec.model, effort: spec.effort, path: spec.path, prompt_sha256: sha256, cached: reply.cached === true, reason: parsed.reason } });
    } catch (e) {
      if ((e as Error)?.name === 'BudgetExceededError' || /budget/i.test(String((e as Error)?.message ?? e))) stopped = String((e as Error).message ?? e).slice(0, 300);
      else labels.push({ ...base, cause: UNCLASSIFIED, basis: 'unclassified', rule_id: 'labeller.call_failed',
        labeller: { model: spec.model, effort: spec.effort, path: spec.path, prompt_sha256: sha256, cached: false, reason: String((e as Error)?.message ?? e).slice(0, 200) } });
      if (stopped) labels.push(base);
    }
  }
  return { labels, stopped };
}

export interface LabelSetRun { rows: DoubleLabel[]; dropped: number; stopped: string | null }

/**
 * Label each sampled residual with both label-set labellers. A row enters the set only when both calls returned a cause
 * that parsed: a failed call or an unparseable reply drops the row (no second call), so it never counts toward a path's
 * held-out minimum. A budget refusal stops the run.
 */
export async function labelSet(sample: EvalFailure[], client: ChatLike, stratum: (f: EvalFailure) => string): Promise<LabelSetRun> {
  const rows: DoubleLabel[] = [];
  let dropped = 0;
  let stopped: string | null = null;
  for (const f of sample) {
    const { system, prompt } = buildLabelPrompt(f);
    const got: string[] = [];
    for (const spec of LABEL_SET_LABELLERS) {
      try {
        const parsed = parseLabel((await client.chat(spec.model, prompt, { maxTokens: LABEL_MAX_TOKENS, replicate: 0, temperature: null, effort: spec.effort, system })).text, { notDelivered: deliveryUnknown(f) });
        if (!parsed.ok) break;
        got.push(String(resolveChoice(f, parsed.cause).cause));
      } catch (e) {
        if ((e as Error)?.name === 'BudgetExceededError' || /budget/i.test(String((e as Error)?.message ?? e))) stopped = String((e as Error).message ?? e).slice(0, 300);
        break;
      }
    }
    if (stopped) break;
    if (got.length === LABEL_SET_LABELLERS.length) rows.push({ case_key: `${f.source}|${f.case_id}`, path: labellerFor(f.model).path, stratum: stratum(f), opus: got[0], astra: got[1] });
    else dropped++;
  }
  return { rows, dropped, stopped };
}

/**
 * The residual labeller: a model picks the cause only for failures the
 * deterministic rules could not place (classify() basis needs_model), where the
 * evidence reached the answering model or the source did not measure it.
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
import { classify } from './classify.ts';
import { CAUSES, MODEL_CAUSES, UNCLASSIFIED, type Cause } from './taxonomy.ts';
import type { CauseLabel, EvalFailure } from './types.ts';

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
const CONTEXT_CHARS = 60_000;

/** The production labeller for a row, by the family of the model that produced it; overrides replace a family's path. */
export function labellerFor(rowModel: string, overrides: Partial<Record<string, LabellerSpec>> = {}): LabellerSpec {
  const family = rowModel.split(':')[0];
  const spec = overrides[family] ?? PRODUCTION_LABELLERS[family];
  if (!spec) throw new Error(`no labeller path for rows from ${rowModel}`);
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

export function parseLabel(text: string): { cause: Cause | typeof UNCLASSIFIED; reason: string | null; ok: boolean } {
  const found = [...text.matchAll(/\{[^{}]*\}/g)].at(-1)?.[0];
  if (!found) return { cause: UNCLASSIFIED, reason: 'no JSON object in the reply', ok: false };
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(found); } catch { return { cause: UNCLASSIFIED, reason: 'reply JSON did not parse', ok: false }; }
  const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 300) : null;
  if (parsed.cause === UNCLASSIFIED) return { cause: UNCLASSIFIED, reason, ok: true };
  if (typeof parsed.cause === 'string' && (MODEL_CAUSES as readonly string[]).includes(parsed.cause)) return { cause: parsed.cause as Cause, reason, ok: true };
  return { cause: UNCLASSIFIED, reason: `invalid cause ${JSON.stringify(parsed.cause)}`.slice(0, 120), ok: false };
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
      const parsed = parseLabel(reply.text);
      labels.push({ ...base, cause: parsed.cause, basis: parsed.cause === UNCLASSIFIED ? 'unclassified' : 'model', rule_id: parsed.ok ? 'labeller' : 'labeller.invalid_reply',
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

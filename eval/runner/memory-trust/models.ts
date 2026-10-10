/**
 * Models and spend for the memory trust categories (Cats 37-39).
 *
 * Model choice follows CLAUDE.md "Choose models" and the gbrain project rule
 * of 2026-10-07: the newest Opus, Sonnet and GPT in every counted cell; Fable
 * only in smoke tests; no older generation and no gpt-5.4-mini. The list was
 * rechecked against both providers' model lists with
 * `bun scripts/model-freshness.ts --models anthropic:claude-opus-5-5,anthropic:claude-sonnet-5-5,openai:gpt-6.1-sol,anthropic:claude-fable-5-1`
 * on 2026-10-07 (America/Los_Angeles): newest opus claude-opus-5-5, sonnet
 * claude-sonnet-5-5, fable claude-fable-5-1, gpt gpt-6.1-sol; no warnings, all
 * four priced. Rerun it before the paid run; a newer model goes into the
 * preregistration before any cell runs, never into a frozen arm.
 *
 * Prices come from CHAT_PRICE_OVERRIDES in budget-ledger.ts, the table the
 * budget ledger reserves against, so an estimate here and a reservation there
 * use the same numbers.
 */
import { CHAT_PRICE_OVERRIDES } from '../budget-ledger.ts';

export const COUNTED_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol'] as const;
export const SMOKE_MODELS = ['claude-fable-5-1'] as const;
/** Claim-adoption judge for Cat 37 (the plan's budget table: Sonnet 5.5). */
export const JUDGE_MODEL = 'claude-sonnet-5-5';
/** Never run (project rule); a finding resting on it alone decides nothing. */
export const BANNED_MODELS = ['gpt-5.4-mini'] as const;
/** The memory trust program cap Garry approved on 2026-10-07 (GBRA-58 approval). */
export const MEMORY_TRUST_CAP_USD = 500;
/** Scripted stand-in for a model in dry mode: zero cost, never sent anywhere. */
export const STUB_MODEL = 'stub';

export const MODEL_FRESHNESS_CHECK = {
  checked: '2026-10-07',
  command: 'bun scripts/model-freshness.ts --models anthropic:claude-opus-5-5,anthropic:claude-sonnet-5-5,openai:gpt-6.1-sol,anthropic:claude-fable-5-1',
  newest: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', fable: 'claude-fable-5-1', gpt: 'gpt-6.1-sol' },
  warnings: [] as string[],
};

export function providerOf(model: string): 'anthropic' | 'openai' {
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gpt')) return 'openai';
  throw new Error(`no provider for model ${model}`);
}

export function listPrice(model: string): { input: number; output: number } {
  const p = CHAT_PRICE_OVERRIDES[`${providerOf(model)}:${model}`];
  if (!p) throw new Error(`no verified price for ${model}; register it in CHAT_PRICE_OVERRIDES (eval/runner/budget-ledger.ts) before a paid run`);
  return { input: p.input, output: p.output };
}

/** Uncached list-price cost of `n` calls of the given size, in dollars. */
export function estimateUsd(model: string, inputTokens: number, outputTokens: number, n = 1): number {
  const p = listPrice(model);
  return (n * (inputTokens * p.input + outputTokens * p.output)) / 1e6;
}

/**
 * Models for one run from `--models a,b`: counted models by default; Fable
 * only with `--smoke`; banned models refused outright.
 */
export function modelsFrom(argv: readonly string[]): string[] {
  const at = argv.indexOf('--models');
  const raw = at >= 0 ? argv[at + 1] : argv.find(a => a.startsWith('--models='))?.slice('--models='.length);
  const smoke = argv.includes('--smoke');
  const models = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [...(smoke ? SMOKE_MODELS : COUNTED_MODELS)];
  for (const m of models) {
    if ((BANNED_MODELS as readonly string[]).includes(m)) throw new Error(`${m} is never run for gbrain evals (project rule); drop it from --models`);
    if ((SMOKE_MODELS as readonly string[]).includes(m) && !smoke) throw new Error(`${m} runs only in smoke tests (project rule, 2026-10-07); pass --smoke with a small --limit, never in a counted run`);
    if (m !== STUB_MODEL) listPrice(m);
  }
  return models;
}

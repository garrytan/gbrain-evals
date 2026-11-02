/**
 * Which models a live category may name as its default (CLAUDE.md "Choose models"), and the defaults that keep an
 * older model, or a Sonnet or Haiku model under test, on purpose.
 *
 * test/eval/model-defaults.test.ts imports every registered default and fails when one outside
 * DEFAULT_MODEL_EXCEPTIONS is not a current-generation model, when a model under test outside them is a Sonnet or
 * Haiku model, or when an exception no longer names what the code uses. Changing a default is a new receipt identity:
 * never pool its results with the old model's.
 */

/** Current-generation ids, without provider prefix or dated snapshot suffix (checked 2026-11-01). */
export const CURRENT_GENERATION: readonly string[] = [
  'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5',
  'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-luna',
];

/** Models no default may name, whatever their generation. */
export const BANNED_DEFAULTS: Readonly<Record<string, string>> = {
  'gpt-5.4-mini': 'gpt-5.4-mini is never run',
  'claude-fable-5-1': 'Fable runs only in smoke tests, never in counted cells',
};

/** `anthropic:claude-haiku-4-5-20251001` → `claude-haiku-4-5`. */
export function bareModelId(model: string): string {
  return model.trim().toLowerCase().replace(/^[a-z0-9_-]+:/, '').replace(/-\d{8}$/, '');
}

/** Why `model` cannot be a live category's default, or null when it can. */
export function defaultModelProblem(model: string): string | null {
  const id = bareModelId(model);
  if (BANNED_DEFAULTS[id]) return `${model}: ${BANNED_DEFAULTS[id]}`;
  return CURRENT_GENERATION.includes(id) ? null : `${model} is not a current-generation model`;
}

/**
 * Why `model` cannot be a live category's default model under test (an agent, reader, answer, think or extraction
 * model, an optimizer or an optimization target), or null when it can. gbrain and gstack are built for frontier
 * models, so Sonnet and Haiku are never models under test (Garry, 2026-11-01). Judges are not models under test.
 */
export function underTestModelProblem(model: string): string | null {
  return /^claude-(?:sonnet|haiku)-/.test(bareModelId(model)) ? `${model}: Sonnet and Haiku are never models under test` : null;
}

export interface DefaultModelException {
  /** The models the code uses, in the order the test reads them. */
  models: readonly string[];
  kind: 'frozen-protocol' | 'product-default-mirror' | 'pinned-harness' | 'pending-move';
  reason: string;
}

/**
 * Keyed by the names test/eval/model-defaults.test.ts gives the defaults it reads. An exception covers both rules: a
 * frozen protocol, a product-default mirror or a pinned harness keeps whatever model it names, and a pending move
 * keeps its models until the dated follow-up its reason names lands.
 */
export const DEFAULT_MODEL_EXCEPTIONS: Readonly<Record<string, DefaultModelException>> = {
  'memory-qa lme-s reader and judge': {
    models: ['openai:gpt-4o-2024-08-06', 'openai:gpt-4o-2024-08-06'], kind: 'frozen-protocol',
    reason: "LongMemEval's official judge, and the main LongMemEval-S reader of the memory shootout preregistration (amendment A1)",
  },
  'memory-qa custody reader and judge': {
    models: ['openai:gpt-4o-2024-08-06', 'openai:gpt-4o-2024-08-06'], kind: 'frozen-protocol',
    reason: 'sealed LongMemEval custody split: the official judge and the same reader as lme-s',
  },
  'memory-qa locomo reader and judge': {
    models: ['openai:gpt-4o-mini', 'openai:gpt-4o-2024-08-06'], kind: 'frozen-protocol',
    reason: 'memory shootout preregistration amendment A1: the LoCoMo reader is the single link to the starting line and the published numbers',
  },
  'memory-qa beam-100k reader and judge': { models: ['openai:gpt-4.1-mini', 'openai:gpt-4.1-mini'], kind: 'frozen-protocol', reason: 'the gpt-4.1-mini bridge to earlier BEAM runs' },
  'memory-qa beam-500k reader and judge': { models: ['openai:gpt-4.1-mini', 'openai:gpt-4.1-mini'], kind: 'frozen-protocol', reason: 'the gpt-4.1-mini bridge to earlier BEAM runs' },
  'memory-qa beam-1m reader and judge': { models: ['openai:gpt-4.1-mini', 'openai:gpt-4.1-mini'], kind: 'frozen-protocol', reason: 'the gpt-4.1-mini bridge to earlier BEAM runs' },
  'memory-qa fixture reader and judge': {
    models: ['openai:gpt-4o-mini', 'openai:gpt-4o-mini'], kind: 'pinned-harness',
    reason: "qa.ts sets this pair in DEFAULT_READER and DEFAULT_JUDGE, and the H1 decision pins qa.ts's bytes (docs/benchmarks/2026-10-10-gbrain-budgeted-delivery-h1/decision.json), so this change cannot move it. run.ts already sends these calls through qa-v2's client, which gives a Claude 5 verdict call the 2,000-token floor (A19), so the pair can move once its default is set outside qa.ts",
  },
  'lifecycle-lite reader and judge': {
    models: ['openai:gpt-4o-mini', 'openai:gpt-4o-2024-08-06'], kind: 'frozen-protocol',
    reason: 'docs/benchmarks/2026-10-06-oss-memory-shootout-lifecycle-lite-preregistration.md (frozen and approved 2026-10-06) names this pair, and its counted cell manifests run on the default',
  },
  'sealed confirmation reader and judge': {
    models: ['claude-sonnet-4-6', 'gpt-4o-2024-08-06'], kind: 'frozen-protocol',
    reason: 'sealed confirmation protocol: frozen request payloads and the official judge',
  },
  'pilot judge': { models: ['gpt-4o-2024-08-06'], kind: 'frozen-protocol', reason: "LongMemEval's official judge protocol" },
  'Cats 30-33 SkillOpt': {
    models: ['anthropic:claude-haiku-5-5', 'anthropic:claude-opus-5-5', 'anthropic:claude-haiku-5-5', 'anthropic:claude-sonnet-5-5', 'openai:gpt-6.1-sol'],
    kind: 'pending-move',
    reason: '2026-11-01, pending ledger wiring, no frontier SkillOpt suite runs planned: the Haiku 5.5 target and B-pre optimizer and the Sonnet 5.5 transfer end stay until Cats 30-33 open the budget ledger, count aborted runs as harness errors and size their caps for Opus 5.5 (GST-903)',
  },
  'memory-trust flag-rate agent and judge': {
    models: ['claude-sonnet-5-5', 'claude-sonnet-5-5'], kind: 'frozen-protocol',
    reason: "amendment 5 (2026-10-09) of docs/benchmarks/2026-10-07-memory-trust-preregistration.md names claude-sonnet-5-5 as the simulated user's agent and as the false-flag labeler",
  },
  'external-ideas wave A decision model': {
    models: ['claude-sonnet-5-5'], kind: 'frozen-protocol',
    reason: 'docs/benchmarks/2026-10-21-external-ideas-wave-a-preregistration.md decides the default flip on claude-sonnet-5-5, with gpt-6.1-sol and claude-opus-5-5 as secondary models',
  },
  'facts-absorb gate baseline': {
    models: ['anthropic:claude-sonnet-4-6'], kind: 'frozen-protocol',
    reason: "the preregistered baseline arm is gbrain's shipped facts extraction model (docs/benchmarks/2026-10-08-facts-extraction-model/PREREGISTRATION.md)",
  },
  'evidence-delivery E1 readers': {
    models: ['anthropic:claude-sonnet-4-6', 'openai:gpt-4o'], kind: 'frozen-protocol',
    reason: 'evidence-delivery E1 decision manifest: preregistered readers',
  },
  'N2 contradiction judge': {
    models: ['anthropic:claude-haiku-4-5-20251001'], kind: 'product-default-mirror',
    reason: "the N2 preregistration measures gbrain's contradiction judge with the model gbrain picks by default (TIER_DEFAULTS.utility); it moves when gbrain's default moves",
  },
  'harness dev lane BEAM judge': {
    models: ['gemini:gemini-3.5-flash'], kind: 'pinned-harness',
    reason: "the pinned agent-memory harness fixes BEAM's rubric judge to gemini-3.5-flash, and harness-cell.ts refuses a BEAM cell whose spec names another judge",
  },
  'N7 open-loop extractor': {
    models: ['anthropic:claude-sonnet-4-6'], kind: 'product-default-mirror',
    reason: "the N7 extractor-arm preregistration measures gbrain's default chat model (the gateway default); it moves when gbrain's default moves",
  },
};

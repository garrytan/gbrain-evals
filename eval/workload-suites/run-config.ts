/**
 * Reader, judge and arm configuration for the workload suites.
 *
 * Model ids are placeholders until the preregistration freezes them. The
 * project rule: one fixed reader for every cell (the newest frontier
 * Sonnet); a preregistered subset of questions swept across the newest
 * frontier Opus, GPT and Sonnet models, plus particle-1 (a primary model,
 * plan GST-605); one fixed judge, never particle-1. Fable reads only in a
 * labeled smoke run, never a counted cell. Older generations and
 * gpt-5.4-mini are never run. Before a paid run, check which models are
 * newest and update this file in a commit that runs nothing.
 */
import { COMPAT_PROVIDERS, modelsNotRun } from '../runner/providers/openai-compatible.ts';
import { SMOKE_ONLY_READERS } from '../runner/systems/baselines.ts';
import { sha256 } from './common.ts';
import type { SuiteBundle, SuiteId } from './types.ts';

export interface ModelRef { id: string; family: 'sonnet' | 'opus' | 'gpt' | 'fable' | 'particle' }

/** The providers bench-infra.ts `callModel` sends reader and judge calls to: Anthropic, OpenAI and every COMPAT_PROVIDERS row. */
export const ROUTED_PROVIDERS: readonly string[] = ['anthropic', 'openai', ...Object.keys(COMPAT_PROVIDERS)];

/** The primary models (PRIMARY_MODELS) the workload suites have no route for, each with its reason; outside every identity and resume check. */
export const workloadModelsNotRun = (routed: readonly string[] = ROUTED_PROVIDERS) =>
  modelsNotRun('workload-suites', model => routed.includes(model.slice(0, model.indexOf(':'))));

export const MODEL_CONFIG = {
  status: 'placeholder: confirm newest models and freeze in the preregistration before any paid cell',
  checked: '2026-10-05',
  fixed_reader: { id: 'anthropic:claude-sonnet-5-5', family: 'sonnet' } as ModelRef,
  frontier_sweep: [
    { id: 'anthropic:claude-opus-5-5', family: 'opus' },
    { id: 'openai:gpt-6-astra', family: 'gpt' },
    { id: 'anthropic:claude-sonnet-5-5', family: 'sonnet' },
    { id: 'particle:particle-1', family: 'particle' },
  ] as ModelRef[],
  /** Readers allowed only in a labeled smoke run (`bench.ts --smoke N --models ...`), never in a counted cell: Fable (CLAUDE.md). */
  smoke_only_readers: [...SMOKE_ONLY_READERS] as string[],
  /** The alternate newest GPT, re-reading the same frontier subset when the budget allows (it is also the judge model). */
  alternate_readers: [{ id: 'openai:gpt-6.1-sol', family: 'gpt' }] as ModelRef[],
  /** Judges only answers the deterministic scorer marks `ambiguous` (both the gold and a stale or distractor value named). */
  judge: { id: 'openai:gpt-6.1-sol', family: 'gpt' } as ModelRef,
  /** Fraction of each category's questions in the frontier sweep, chosen by hash order of query id. */
  frontier_fraction: 0.25,
  reader: {
    temperature: 0,
    max_output_tokens: 400,
    prompt: [
      'You are answering a question about the user from your memory of past conversations.',
      'Use only the context below. If the context does not contain the answer, say "I don\'t know".',
      '',
      'Context:',
      '{context}',
      '',
      'Question (asked on {query_date}): {question}',
      '',
      'Reply with one short line that starts with "Answer:".',
    ].join('\n'),
    /** The no-memory control calls the reader with this exact context, so an empty-context guard cannot skip the call. */
    no_memory_context: '(no memories were retrieved)',
  },
  models_not_run: workloadModelsNotRun(),
} as const;

/** Model ids the project rule excludes: older generations and gpt-5.4-mini. */
export const EXCLUDED_MODELS = [/gpt-5\.4-mini/, /claude-(?:sonnet|opus)-4/, /claude-haiku/, /gpt-5(?:\.|-|$)/, /gpt-4/, /claude-sonnet-5(?!-5)/, /claude-opus-5(?!-5)/, /claude-fable-5(?!-1)/];

export function modelRuleViolations(config: { fixed_reader: ModelRef; frontier_sweep: readonly ModelRef[]; alternate_readers?: readonly ModelRef[]; judge: ModelRef } = MODEL_CONFIG): string[] {
  const out: string[] = [];
  for (const m of [config.fixed_reader, ...config.frontier_sweep, ...(config.alternate_readers ?? []), config.judge]) {
    if (EXCLUDED_MODELS.some(re => re.test(m.id))) out.push(`${m.id} is an excluded or older-generation model`);
    if ((SMOKE_ONLY_READERS as readonly string[]).includes(m.id)) out.push(`${m.id} is smoke-only and never reads or judges a counted cell`);
  }
  const families = new Set(config.frontier_sweep.map(m => m.family));
  for (const f of ['opus', 'gpt', 'sonnet'] as const) if (!families.has(f)) out.push(`frontier sweep has no ${f} model`);
  if (config.fixed_reader.family !== 'sonnet') out.push('the fixed reader must be the newest frontier Sonnet');
  if (config.judge.id.startsWith('particle:')) out.push(`${config.judge.id} never judges a counted cell`);
  if (!config.frontier_sweep.some(m => m.id === config.fixed_reader.id)) out.push('the fixed reader must be the sweep\'s Sonnet so the sweep shares one anchor');
  return out;
}

/** One measured configuration of a system on a suite. */
export interface Arm { id: string; system: 'gbrain' | 'comparator'; lane: 'raw' | 'facts' | 'combined'; note: string }

export const SUITE_ARMS: Record<SuiteId, Arm[]> = {
  'passing-details': [
    { id: 'gbrain-raw', system: 'gbrain', lane: 'raw', note: 'conversation pages only, zero-LLM write path' },
    { id: 'gbrain-combined', system: 'gbrain', lane: 'combined', note: 'pages plus facts from extract-conversation-facts (LLM spend counted); query returns matching saved facts beside the page blocks' },
    { id: 'comparator-facts', system: 'comparator', lane: 'facts', note: 'extracted facts only' },
    { id: 'comparator-combined', system: 'comparator', lane: 'combined', note: 'facts plus the raw chunks they came from' },
  ],
  corrections: [
    { id: 'gbrain-edit-sync', system: 'gbrain', lane: 'raw', note: 'see arms.json; zero-LLM write path, remembered facts surface through query' },
    { id: 'gbrain-forget-remember', system: 'gbrain', lane: 'raw', note: 'see arms.json' },
    { id: 'gbrain-remember-replaces', system: 'gbrain', lane: 'raw', note: 'optional named arm; see arms.json' },
    { id: 'gbrain-append', system: 'gbrain', lane: 'raw', note: 'identical bytes to comparator-append' },
    { id: 'comparator-edit-invalidate', system: 'comparator', lane: 'combined', note: 'see arms.json' },
    { id: 'comparator-reretain', system: 'comparator', lane: 'combined', note: 'see arms.json' },
    { id: 'comparator-append', system: 'comparator', lane: 'combined', note: 'identical bytes to gbrain-append' },
  ],
  'time-relationships': [
    { id: 'gbrain-combined', system: 'gbrain', lane: 'combined', note: 'gbrain builds typed edges and timeline rows in the measured pipeline; that LLM spend is counted' },
    { id: 'comparator-combined', system: 'comparator', lane: 'combined', note: 'facts plus raw chunks, its best supported mode' },
  ],
  beliefs: [
    { id: 'gbrain-combined', system: 'gbrain', lane: 'combined', note: 'gbrain extracts and grades takes in the measured pipeline; that LLM spend is counted' },
    { id: 'comparator-combined', system: 'comparator', lane: 'combined', note: 'facts plus raw chunks, its best supported mode' },
  ],
};

/** The preregistered frontier-sweep subset: per category, the first `fraction` of query ids in sha256 order. */
export function frontierSubset(bundle: SuiteBundle, fraction = MODEL_CONFIG.frontier_fraction): string[] {
  const byCategory = new Map<string, string[]>();
  for (const q of bundle.queries) byCategory.set(q.meta.category, [...(byCategory.get(q.meta.category) ?? []), q.id]);
  const out: string[] = [];
  for (const ids of byCategory.values()) {
    const ordered = [...ids].sort((a, b) => sha256(a) < sha256(b) ? -1 : 1);
    out.push(...ordered.slice(0, Math.max(1, Math.round(ids.length * fraction))));
  }
  return out.sort();
}

export interface DryRunPlan {
  suite: SuiteId;
  arms: number;
  ingest_tokens_per_arm: number;
  reader_calls: { fixed: number; frontier_sweep: number };
  reader_input_tokens: number;
  judge_calls_max: number;
  note: string;
}

/** Token volume and call counts for a full paid run. Dollars come from the A0 ledger, not from here. */
export function dryRunPlan(bundle: SuiteBundle, targetTokens: number): DryRunPlan {
  const arms = SUITE_ARMS[bundle.suite].filter(a => a.id !== 'gbrain-remember-replaces');
  const docs = bundle.documents.reduce((n, d) => n + Math.ceil(d.content.length / 4), 0);
  const extraDocs = bundle.suite === 'corrections'
    ? ((bundle.extra.writes as Array<{ document: { content: string } }>).reduce((n, w) => n + Math.ceil(w.document.content.length / 4), 0))
    : 0;
  const subset = frontierSubset(bundle).length;
  const fixed = bundle.queries.length * arms.length;
  const sweep = subset * arms.length * (MODEL_CONFIG.frontier_sweep.length - 1);
  return {
    suite: bundle.suite,
    arms: arms.length,
    ingest_tokens_per_arm: docs + extraDocs,
    reader_calls: { fixed, frontier_sweep: sweep },
    reader_input_tokens: (fixed + sweep) * (targetTokens + 300),
    judge_calls_max: fixed + sweep,
    note: `approximate tokens (characters / 4) at a ${targetTokens}-token delivered-context target; the sweep re-reads the fixed reader's saved contexts, so it adds reader calls but no retrieval or ingest`,
  };
}

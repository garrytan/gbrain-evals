/**
 * Decision specs: what a feature plan asks the kit to compare.
 *
 * A spec names the candidate gbrain (a checkout and ref, plus config
 * overrides), the baseline gbrain, the evidence sources, and for each source
 * the comparison family that decides it (stats/gates.ts: exact,
 * noninferiority, superiority, exploratory). `init` writes an editable dev
 * spec from a template; the confirmation lock (prereg) is frozen from it
 * later. Dev verdicts are never eligible to flip a default.
 *
 * Source kinds:
 *   memory-qa  conversation-memory retrieval on a public benchmark split
 *              (eval/runner/memory-qa/run.ts), one row per question.
 *   category   an existing registry runner that takes --gbrain/--output;
 *              rows are read from its receipt (`rows_path`) and/or its
 *              receipt fields are checked as contracts.
 */
import { readFileSync, existsSync } from 'node:fs';
import type { ComparisonSpec } from '../stats/gates.ts';
import { decideError } from './errors.ts';

export type VerdictType = 'quality' | 'cost' | 'correctness';
export type Plan = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7' | 'P8' | 'P0' | 'other';
export type MemoryQaBenchmark = 'locomo' | 'lme-s' | 'beam-100k' | 'beam-500k' | 'beam-1m' | 'fixture';
export type EmbedMode = 'hash' | 'real';

export interface ArmSpec {
  /** `<checkout>[@<ref>]`, as runners take it after `--gbrain`; null = the pinned dependency. */
  gbrain: string | null;
  /** gbrain config keys set on the engine before import (engine.setConfig). */
  config: Record<string, string>;
}

export interface ContractCheck {
  /** Dotted path into the candidate's receipt. */
  path: string;
  op: 'eq' | 'lte' | 'gte';
  value: number | string | boolean;
  description?: string;
}

interface SourceCommon {
  id: string;
  /** Item id field in each row (dotted path); `id_fields` composes several. */
  id_field?: string;
  id_fields?: string[];
  exclude_when?: string[];
  min_clusters?: number;
  comparisons: ComparisonSpec[];
}

export interface MemoryQaSource extends SourceCommon {
  kind: 'memory-qa';
  benchmark: MemoryQaBenchmark;
  split: 'dev';
  embed: EmbedMode;
  /** Optional cap on questions (stratified by category, seeded). */
  limit?: number | null;
  /** Only questions whose category is in this list. */
  categories?: string[];
  /** Search config pinned on both arms before the arm's own overrides. */
  search_pins: Record<string, string>;
  top_k: number;
  /** Reading lane: a reader model over the retrieved sessions, or gbrain think; judged against the reference. */
  qa?: { mode: 'reader' | 'think'; reader?: string; judge?: string; think_model?: string; runs: number; sessions: number; budget_tokens?: number | null; context?: 'sessions' | 'facts' };
  /** `conversation` runs gbrain's conversation-facts extractor on each conversation's pages before questions; `qa.context: facts` reads those facts. */
  facts?: 'conversation';
  /** Estimated dollars for both arms; used for the budget preflight. */
  estimate_usd?: number;
}

export interface CategorySource extends SourceCommon {
  kind: 'category';
  /** Registry id, for the record. */
  category: string;
  script: string;
  args: string[];
  /** Array of per-item rows inside the receipt; omit for contract-only sources. */
  rows_path?: string;
  /** Binary metrics derived from row fields before pairing: field = 1 when the value at `from` equals `equals`, else 0 (missing stays missing). */
  derive?: Array<{ field: string; from: string; equals: string | number | boolean }>;
  contracts?: ContractCheck[];
  paid: boolean;
  estimate_usd?: number;
}

export type Source = MemoryQaSource | CategorySource;

export interface DecisionSpec {
  schema_version: 1;
  decision_id: string;
  plan: Plan;
  title: string;
  verdict_type: VerdictType;
  stage: 'dev';
  candidate: ArmSpec;
  baseline: ArmSpec;
  sources: Source[];
  alpha: number;
  seed: number;
  draws: number;
  budget_usd: number;
  created_at: string;
  notes?: string;
}

export const DEFAULT_SEARCH_PINS: Readonly<Record<string, string>> = Object.freeze({
  'search.mode': 'balanced',
  'search.reranker.enabled': 'false',
  'search.autocut': 'false',
});

const ID_RE = /^[a-z0-9][a-z0-9._-]{2,80}$/;

export function validateSpec(value: unknown, path = 'decision.json'): DecisionSpec {
  const s = value as DecisionSpec;
  const problems: string[] = [];
  if (!s || typeof s !== 'object') problems.push('spec must be a JSON object');
  else {
    if (s.schema_version !== 1) problems.push('schema_version must be 1');
    if (typeof s.decision_id !== 'string' || !ID_RE.test(s.decision_id)) problems.push('decision_id must be lowercase letters, digits, dot, dash or underscore (3-81 chars)');
    if (!['quality', 'cost', 'correctness'].includes(s.verdict_type)) problems.push('verdict_type must be quality, cost or correctness');
    if (s.stage !== 'dev') problems.push('stage must be "dev" (sealed confirmation uses a separate prereg lock)');
    for (const side of ['candidate', 'baseline'] as const) {
      const arm = s[side];
      if (!arm || typeof arm !== 'object') { problems.push(`${side} is required`); continue; }
      if (arm.gbrain !== null && typeof arm.gbrain !== 'string') problems.push(`${side}.gbrain must be a checkout spec or null`);
      if (!arm.config || typeof arm.config !== 'object' || Object.values(arm.config).some(v => typeof v !== 'string')) problems.push(`${side}.config must map config keys to string values`);
    }
    if (!Array.isArray(s.sources) || !s.sources.length) problems.push('sources must be a nonempty array');
    const ids = new Set<string>();
    for (const src of Array.isArray(s.sources) ? s.sources : []) {
      const label = `source ${src?.id ?? '?'}`;
      if (typeof src?.id !== 'string' || !ID_RE.test(src.id) || ids.has(src.id)) problems.push(`${label}: id missing, invalid or duplicated`);
      ids.add(src?.id);
      if (!src?.id_field && !(Array.isArray(src?.id_fields) && src.id_fields.length)) {
        if (!(src?.kind === 'category' && !src.rows_path)) problems.push(`${label}: id_field or id_fields required`);
      }
      if (!Array.isArray(src?.comparisons)) problems.push(`${label}: comparisons must be an array (empty for contract-only sources)`);
      if (src?.kind === 'memory-qa') {
        if (!['locomo', 'lme-s', 'beam-100k', 'beam-500k', 'beam-1m', 'fixture'].includes(src.benchmark)) problems.push(`${label}: unknown benchmark ${src.benchmark}`);
        if (src.split !== 'dev') problems.push(`${label}: dev specs may only name dev splits (sealed data opens through the custodian)`);
        if (!['hash', 'real'].includes(src.embed)) problems.push(`${label}: embed must be hash or real`);
        if (!Number.isInteger(src.top_k) || src.top_k < 5 || src.top_k > 50) problems.push(`${label}: top_k must be an integer in [5, 50]`);
        if (src.qa !== undefined) {
          if (!['reader', 'think'].includes(src.qa.mode)) problems.push(`${label}: qa.mode must be reader or think`);
          if (!Number.isInteger(src.qa.runs) || src.qa.runs < 1 || src.qa.runs > 10) problems.push(`${label}: qa.runs must be an integer in [1, 10]`);
          if (!Number.isInteger(src.qa.sessions) || src.qa.sessions < 1 || src.qa.sessions > 50) problems.push(`${label}: qa.sessions must be an integer in [1, 50]`);
          if (src.qa.context !== undefined && !['sessions', 'facts'].includes(src.qa.context)) problems.push(`${label}: qa.context must be sessions or facts`);
          if (src.qa.context === 'facts' && (src.facts !== 'conversation' || src.qa.mode !== 'reader')) problems.push(`${label}: qa.context facts needs facts: "conversation" and qa.mode reader`);
        }
      } else if (src?.kind === 'category') {
        if (typeof src.script !== 'string' || !src.script.startsWith('eval/runner/')) problems.push(`${label}: script must be a path under eval/runner/`);
        if (!Array.isArray(src.args)) problems.push(`${label}: args must be an array`);
        if (!src.rows_path && !(src.contracts?.length)) problems.push(`${label}: a category source needs rows_path or contracts`);
        else if (typeof src.script === 'string' && existsSync(src.script) && !readFileSync(src.script, 'utf8').includes('resolveGbrainUnderTest')) {
          problems.push(`${label}: ${src.script} does not take --gbrain (it imports the installed gbrain package), so both arms would measure the same build`);
        }
      } else problems.push(`${label}: kind must be memory-qa or category`);
    }
    if (typeof s.alpha !== 'number' || s.alpha <= 0 || s.alpha >= 0.5) problems.push('alpha must be in (0, 0.5)');
    if (!Number.isSafeInteger(s.seed)) problems.push('seed must be an integer');
    if (!Number.isSafeInteger(s.draws) || s.draws < 1000) problems.push('draws must be an integer >= 1000');
    if (typeof s.budget_usd !== 'number' || s.budget_usd < 0) problems.push('budget_usd must be a number >= 0');
  }
  if (problems.length) {
    throw decideError({
      code: 'SPEC_INVALID',
      message: `${path} is not a valid decision spec: ${problems.join('; ')}`,
      why: 'the kit only runs specs it can check, so a typo never silently changes what is measured',
      fix: { next: 'run', argv: ['bun', 'run', 'eval:decide', 'check', '--decision', path], verify: ['bun', 'run', 'eval:decide', 'check', '--decision', path] },
    });
  }
  return s;
}

export function loadSpec(path: string): DecisionSpec {
  if (!existsSync(path)) {
    throw decideError({
      code: 'SPEC_MISSING',
      message: `no decision spec at ${path}`,
      why: 'every kit command reads the spec that `init` writes',
      fix: { next: 'run', argv: ['bun', 'run', 'eval:decide', 'init', '--plan', '<P1..P8>', '--gbrain', '<checkout>@<candidate-sha>', '--out', path] },
    });
  }
  return validateSpec(JSON.parse(readFileSync(path, 'utf8')), path);
}

// ─── Templates ──────────────────────────────────────────────────────

const recallFamily = (minEffect: number): ComparisonSpec[] => [
  { id: 'recall-all-5', metric: 'recall_all_at_5', gate: 'superiority', direction: 'higher', min_effect: minEffect, cluster_by: 'conversation',
    description: 'every gold session in the top five distinct sessions (strict)' },
  { id: 'recall-any-5', metric: 'recall_any_at_5', gate: 'noninferiority', direction: 'higher', tolerance: 0.01, cluster_by: 'conversation',
    description: 'at least one gold session in the top five' },
  { id: 'ndcg-10', metric: 'ndcg_at_10', gate: 'exploratory', direction: 'higher', cluster_by: 'conversation' },
  { id: 'latency', metric: 'latency_ms', gate: 'exploratory', direction: 'lower', cluster_by: 'conversation' },
];

const guardrailFamily = (): ComparisonSpec[] => [
  { id: 'recall-all-5', metric: 'recall_all_at_5', gate: 'noninferiority', direction: 'higher', tolerance: 0.01, cluster_by: 'conversation',
    description: 'guardrail: strict recall does not drop by more than one point' },
  { id: 'ndcg-10', metric: 'ndcg_at_10', gate: 'exploratory', direction: 'higher', cluster_by: 'conversation' },
  { id: 'latency', metric: 'latency_ms', gate: 'exploratory', direction: 'lower', cluster_by: 'conversation' },
];

const qaFamily = (primary: boolean, minEffect: number): ComparisonSpec[] => [
  primary
    ? { id: 'qa-score', metric: 'qa_score', gate: 'superiority', direction: 'higher', min_effect: minEffect, cluster_by: 'conversation', description: 'judged answer correctness (mean over replicates)' }
    : { id: 'qa-score', metric: 'qa_score', gate: 'noninferiority', direction: 'higher', tolerance: 0.01, cluster_by: 'conversation', description: 'guardrail: judged answer correctness' },
  { id: 'recall-all-5', metric: 'recall_all_at_5', gate: 'exploratory', direction: 'higher', cluster_by: 'conversation' },
  { id: 'qa-input-tokens', metric: 'qa_input_tokens', gate: 'exploratory', direction: 'lower', cluster_by: 'conversation' },
];

export function qaSource(benchmark: MemoryQaBenchmark, mode: 'reader' | 'think', opts: { primary: boolean; limit?: number | null; categories?: string[]; minEffect?: number; runs?: number }): MemoryQaSource {
  const base = memoryQaSource(benchmark, { primary: opts.primary, limit: opts.limit ?? 150, categories: opts.categories, minEffect: opts.minEffect });
  const perQ = mode === 'think' ? 0.08 : benchmark === 'lme-s' ? 0.05 : 0.01;
  return { ...base, id: `${base.id}-${mode}`, exclude_when: [], qa: { mode, runs: opts.runs ?? 1, sessions: 5 },
    comparisons: qaFamily(opts.primary, opts.minEffect ?? 0), estimate_usd: Math.ceil((base.estimate_usd ?? 0) + perQ * (opts.runs ?? 1) * (opts.limit ?? 150) * 2) };
}

export function memoryQaSource(benchmark: MemoryQaBenchmark, opts: { primary: boolean; embed?: EmbedMode; limit?: number | null; categories?: string[]; minEffect?: number }): MemoryQaSource {
  const estimate: Record<MemoryQaBenchmark, number> = { fixture: 0, locomo: 1, 'lme-s': 12, 'beam-100k': 2, 'beam-500k': 5, 'beam-1m': 10 };
  return {
    id: `${benchmark}-dev${opts.categories?.length ? '-' + opts.categories.join('-').replace(/[^a-z0-9-]+/gi, '-').toLowerCase().slice(0, 40) : ''}`,
    kind: 'memory-qa', benchmark, split: 'dev', embed: opts.embed ?? (benchmark === 'fixture' ? 'hash' : 'real'),
    limit: opts.limit ?? null, ...(opts.categories?.length ? { categories: opts.categories } : {}),
    search_pins: { ...DEFAULT_SEARCH_PINS }, top_k: 10,
    id_field: 'id', exclude_when: ['abstention=true'], min_clusters: benchmark === 'locomo' ? 3 : 10,
    comparisons: opts.primary ? recallFamily(opts.minEffect ?? 0) : guardrailFamily(),
    estimate_usd: estimate[benchmark] * 2,
  };
}

function category(id: string, script: string, extra: Partial<CategorySource>): CategorySource {
  return { id, kind: 'category', category: id, script, args: ['--seed', '1'], paid: false, comparisons: [], ...extra } as CategorySource;
}

const N3 = () => category('n3-temporal-asof', 'eval/runner/n3-temporal-asof.ts', {
  rows_path: 'data.rows', id_field: 'probe_id', exclude_when: ['status=unsupported'], min_clusters: 5,
  comparisons: [
    { id: 'n3-pass', metric: 'pass', gate: 'noninferiority', direction: 'higher', tolerance: 0.01, cluster_by: 'feature' },
    { id: 'n3-no-regression', metric: 'pass', gate: 'exact', assertion: { kind: 'no_item_regression', direction: 'higher' }, cluster_by: 'feature' },
  ],
});
const N4 = () => category('n4-entity-resolution', 'eval/runner/n4-entity-resolution.ts', {
  rows_path: 'data.rows', id_field: 'id', min_clusters: 5,
  derive: [{ field: 'resolver_correct', from: 'resolver.outcome', equals: 'correct' }, { field: 'resolver_wrong', from: 'resolver.outcome', equals: 'wrong' }],
  comparisons: [
    { id: 'n4-correct', metric: 'resolver_correct', gate: 'noninferiority', direction: 'higher', tolerance: 0.01, cluster_by: 'family' },
    { id: 'n4-no-new-wrong-merge', metric: 'resolver_wrong', gate: 'exact', assertion: { kind: 'no_item_regression', direction: 'lower' }, cluster_by: 'family' },
  ],
});
const N9 = (primary: boolean) => category('n9-multi-hop-paraphrase', 'eval/runner/n9-multi-hop-paraphrase.ts', {
  rows_path: 'data.per_question', id_fields: ['seed', 'question_id', 'split'], args: [],
  comparisons: [
    primary
      ? { id: 'n9-strict', metric: 'on.strict_all_hit', gate: 'superiority', direction: 'higher', min_effect: 0, cluster_by: 'question_id' }
      : { id: 'n9-strict', metric: 'on.strict_all_hit', gate: 'noninferiority', direction: 'higher', tolerance: 0.01, cluster_by: 'question_id' },
    { id: 'n9-answer', metric: 'on.answer_all_hit', gate: 'exploratory', direction: 'higher', cluster_by: 'question_id' },
    { id: 'n9-support', metric: 'on.support_all_hit', gate: 'exploratory', direction: 'higher', cluster_by: 'question_id' },
  ],
});
export const TYPE_ACCURACY = () => category('type-accuracy', 'eval/runner/type-accuracy.ts', {
  rows_path: 'data.rows', id_field: 'probe_id', args: [],
  comparisons: [{ id: 'type-match', metric: 'anyTypeMatch', gate: 'noninferiority', direction: 'higher', tolerance: 0.01, cluster_by: 'probe_id' }],
});
const N1 = () => category('n1-knowledge-update', 'eval/runner/n1-knowledge-update.ts', {
  contracts: [{ path: 'verdict', op: 'eq', value: 'pass', description: 'knowledge-update safety contracts hold' }],
});
const N5 = () => category('n5-forget-residue', 'eval/runner/n5-forget-residue.ts', {
  contracts: [{ path: 'verdict', op: 'eq', value: 'pass', description: 'forget leaves no residue and no collateral damage' }],
});

/** Dev-source profiles per plan. Plans edit them; the custodian freezes them at prereg. */
export function templateSources(plan: Plan): { sources: Source[]; notes: string } {
  switch (plan) {
    case 'P1': return {
      sources: [memoryQaSource('lme-s', { primary: true, categories: ['knowledge-update', 'temporal-reasoning'] }),
        memoryQaSource('beam-100k', { primary: false }), N3(), N4(), N1()],
      notes: 'Bi-temporal edge validity and deterministic entity dedup: primary on knowledge-update and temporal questions; as-of (N3), entity resolution (N4) and update contracts (N1) as guardrails.',
    };
    case 'P2': return {
      sources: [memoryQaSource('lme-s', { primary: true, categories: ['single-session-assistant', 'temporal-reasoning', 'multi-session'] }),
        memoryQaSource('locomo', { primary: false }), N9(false)],
      notes: 'Hub dampening, per-arm explain, relative-date resolution and speaker attribution: assistant-said and temporal questions primary; LoCoMo and one-hop relational retrieval as guardrails.',
    };
    case 'P3': return {
      sources: [memoryQaSource('lme-s', { primary: false }), memoryQaSource('locomo', { primary: false })],
      notes: 'Use-attributed feedback weights: the sequential replay-with-feedback mode lands in milestone M2; until then these are guardrails only.',
    };
    case 'P4': return {
      sources: [memoryQaSource('lme-s', { primary: false })],
      notes: 'Always-loaded core tier and pre-compaction save: the agent-compaction scenario lands in milestone M2; LME-S is a guardrail.',
    };
    case 'P5': return {
      sources: [N4(), memoryQaSource('lme-s', { primary: false })],
      notes: 'Human-typable fact/link line grammar, wanted pages, duplicate nudge: entity resolution and LME-S as guardrails. Typed-edge accuracy (type-accuracy.ts) cannot measure an overlay build yet; add a grammar category for the primary.',
    };
    case 'P6': return {
      sources: [memoryQaSource('lme-s', { primary: true }), qaSource('lme-s', 'reader', { primary: true }), qaSource('lme-s', 'think', { primary: false }),
        memoryQaSource('locomo', { primary: false }), memoryQaSource('beam-100k', { primary: false })],
      notes: 'Fact keys pointing at raw pages, time-aware retrieval and reading quality: LME-S strict recall and reader accuracy primary (replication targets), gbrain think accuracy as a guardrail on a 150-question stratified sample; LoCoMo and BEAM as guardrails.',
    };
    case 'P7': return {
      sources: [N9(true), memoryQaSource('lme-s', { primary: false })],
      notes: 'Multi-relation query planner: composed-hop strict all-hit primary; LME-S as a guardrail. The P0 acceptance bar adds an answer-and-provenance evaluation at confirmation.',
    };
    case 'P8': return {
      sources: [N5(), N1(), memoryQaSource('lme-s', { primary: false })],
      notes: 'Semantic forget, model-judged supersession lane, surface shrink, write-path moat: forget and update contracts plus an LME-S guardrail; cost-speed columns land in milestone M2.',
    };
    default: return { sources: [memoryQaSource('fixture', { primary: true, embed: 'hash' })], notes: 'Keyless fixture walkthrough.' };
  }
}

export function newSpec(o: { decisionId: string; plan: Plan; title: string; verdictType: VerdictType; candidate: string | null; baseline: string | null; fixture?: boolean; budgetUsd?: number }): DecisionSpec {
  const { sources, notes } = o.fixture ? templateSources('other') : templateSources(o.plan);
  const budget = o.budgetUsd ?? sources.reduce((sum, s) => sum + (s.estimate_usd ?? 0), 0);
  return validateSpec({
    schema_version: 1, decision_id: o.decisionId, plan: o.plan, title: o.title, verdict_type: o.verdictType, stage: 'dev',
    candidate: { gbrain: o.candidate, config: {} }, baseline: { gbrain: o.baseline, config: {} },
    sources, alpha: 0.05, seed: 42, draws: 10000, budget_usd: Math.ceil(budget), created_at: new Date().toISOString(), notes,
  });
}

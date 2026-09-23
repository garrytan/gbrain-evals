import type { ProbeError, Receipt } from './receipt.ts';

export type RegressionArm = 'B' | 'C0' | 'C1';
export type RegressionObservationValue = number | { numerator: number; denominator: number };
export type RegressionMetricValue = RegressionObservationValue | { not_applicable: 'no_gold' | 'positive_probe' | 'outside_metric_slice' }
  | { not_applicable: 'native_no_denominator'; evidence: { expected_count: number; returned_count: number } | { left_tier: string | null; right_tier: string | null } };

export interface RegressionProbeRow {
  probe_id: string;
  metrics: Record<string, RegressionMetricValue>;
  error?: ProbeError;
  feature?: { attempted: boolean; status: 'ready' | 'empty' | 'skipped' | 'degraded'; reason?: string; admitted: number };
}

export interface RegressionProbeSpec {
  probe_id: string;
  family_id: string;
  slices: string[];
  critical: boolean;
  no_gold_metrics: string[];
  positive_probe_metrics?: string[];
  cue_eligible?: boolean;
}

export interface RegressionMetricSpec {
  id: string;
  direction: 'higher' | 'lower';
  range: [number, number];
  aggregation: 'mean' | 'max' | 'min' | 'sum' | 'ratio' | 'p50' | 'p95' | 'p99';
  primary: boolean;
  integer?: boolean;
  floor?: number;
  ceiling?: number;
  floor_exclusive?: boolean;
  ceiling_exclusive?: boolean;
  probe_floor?: number;
  probe_ceiling?: number;
  bound_slices?: string[];
  slice_bounds?: Array<{ slice: string; floor?: number; ceiling?: number; floor_exclusive?: boolean; ceiling_exclusive?: boolean }>;
  applies_to?: string[];
  probe_ids?: string[];
  zero_denominator?: 0 | 1 | 'reject';
  percentile_method?: 'linear' | 'nearest_rank';
  native_not_applicable?: 'empty_gold' | 'empty_gold_and_empty_results' | 'empty_expected_or_no_predictions' | 'unrecognized_safety';
  bound_arms?: RegressionArm[];
}

export interface RegressionNativeContract {
  mode: 'live' | 'hermetic' | 'either';
  receipt_category: string;
  metrics: RegressionMetricSpec[];
  required_slices: string[];
  evidence_blockers?: string[];
  absolute_floor_policy?: string;
  constraints?: RegressionNativeConstraint[];
  completed_verdicts?: Array<'pass' | 'fail'>;
  expected_probes?: RegressionProbeSpec[];
  frozen_recipe?: { recipe_sha256: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface RegressionNativeConstraint {
  id: string;
  left: { metric: string; slice: string };
  right?: { metric: string; slice: string };
  operation: 'difference' | 'ratio' | 'best_slice' | 'best_slice_ratio';
  slice_prefix?: string;
  selection_metric?: string;
  floor?: number;
  ceiling?: number;
  floor_exclusive?: boolean;
  ceiling_exclusive?: boolean;
}

export interface RegressionProductIdentity {
  sha: string;
  tree: string;
  package_sha256?: string;
}

export interface RegressionLoadedProduct {
  sha: string | null;
  tree: string | null;
  package_sha256?: string;
}

export interface RegressionRuntime {
  root: string;
  eval_root: string;
  product_root: string;
  package_path: string;
  home: string;
  config: string;
  database: string;
  output: string;
}

export interface RegressionProvenance {
  eval_sha: string;
  eval_dirty: boolean;
  product: RegressionLoadedProduct;
  product_dirty: boolean | null;
  declared_pin: string;
  package_version: string;
  bindings: Record<'package' | 'deep_import' | 'GBRAIN_SRC' | 'GBRAIN_REPO', RegressionLoadedProduct & { path: string }>;
  hashes: Record<'corpus' | 'gold' | 'queries' | 'runner' | 'scorer' | 'models' | 'prompts' | 'source_timestamps', string>;
  config: Record<string, string>;
  clock: string;
  runtime: RegressionRuntime;
  file_config: { path: string; values: Record<string, unknown> };
}

export interface RegressionReceiptData {
  schema_version: 1;
  run_id: string;
  cell_id: string;
  manifest_sha256: string;
  mode: 'live' | 'hermetic' | 'offline';
  provenance: RegressionProvenance;
  rows: RegressionProbeRow[];
  feature: {
    supported: boolean;
    read_mode: 'off' | 'on';
    production_generation: boolean;
    build_complete: boolean;
    build_receipt_sha256: string | null;
    generated: number;
    generated_unit?: string;
    empty_windows: number;
    rejected_windows: number;
    covered_sources: string[];
  };
  observed: { reranker: string; fallback: boolean; source_timestamps_frozen: boolean };
  spend: { reserved_usd: number; actual_usd: number; enforcement_id: string | null };
}

export interface RegressionProfile {
  id: string;
  category: string;
  receipt_category: string;
  mode: 'live' | 'hermetic';
  arms: RegressionArm[];
  repeats: number;
  probes: RegressionProbeSpec[];
  metrics: RegressionMetricSpec[];
  required_slices: string[];
  cue_sources: string[];
  cue_source_bindings?: Record<string, string>;
  output_token_budget?: number;
  config: Record<string, string>;
  file_config: { engine: 'pglite'; embedding_model?: string; embedding_dimensions?: number; chat_model?: string; expansion_model?: string };
  cue_config: Record<string, string>;
  hashes: RegressionProvenance['hashes'];
  native_hashes?: Record<string, string>;
  native_contract_sha256: string;
  native_constraints?: RegressionNativeConstraint[];
  recipe_review?: { reviewer: string; recipe_sha256: string };
  reranker: string;
  declared_pin: string;
  package_versions: Record<RegressionArm, string>;
  clock: string;
  timeout_ms: number;
  prerequisites: { supported: boolean; runner: string; evidence_sha256: string; reason?: string };
  budget: {
    construction_usd: number;
    embedding_usd: number;
    reranking_usd: number;
    judging_usd: number;
    agent_usd: number;
    enforcement: 'none' | 'isolated-provider-hard-limit';
  };
}

export interface RegressionCellSpec {
  id: string;
  profile_id: string;
  arm: RegressionArm;
  repeat: number;
  runtime: RegressionRuntime;
}

export interface RegressionManifest {
  schema_version: 1;
  run_id: string;
  registered_at: string;
  expires_at: string;
  eval_sha: string;
  inventory_sha256: string;
  products: { B: RegressionProductIdentity; candidate: RegressionProductIdentity };
  profiles: RegressionProfile[];
  cells: RegressionCellSpec[];
  max_usd: number;
  statistics: {
    seed: number;
    draws: number;
    cat36: { profile_id: string; metric: string; slice: 'indirect' };
    opportunities: Array<{ profile_id: string; metric: string; slice: string }>;
  };
}

export interface RegressionCellResult {
  cell_id: string;
  exit_code: number | null;
  started_at: string;
  finished_at: string;
  receipt: Receipt | null;
}

export interface RegressionCoverage {
  profile_id: string;
  status: 'pass' | 'regressed' | 'inconclusive' | 'blocked';
  reasons: string[];
}

export interface RegressionComparison {
  profile_id: string;
  candidate: RegressionArm;
  baseline: RegressionArm;
  metric: string;
  slice: string;
  baseline_value: number;
  candidate_value: number;
  delta: number;
  n_pairs: number;
  n_families: number;
  baseline_denominator: number;
  candidate_denominator: number;
  wins: string[];
  losses: string[];
  lower95: number;
  upper95: number;
  p_value: number;
  holm_p_value?: number;
}

export interface RegressionDecision {
  status: 'pass' | 'regressed' | 'inconclusive' | 'blocked';
  reasons: string[];
  coverage: RegressionCoverage[];
  comparisons: RegressionComparison[];
}

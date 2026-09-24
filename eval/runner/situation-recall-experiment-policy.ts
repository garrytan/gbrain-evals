export const SOURCE_ONLY_EXPERIMENT = 'longmemeval-m-source-only-dev-v1';
export const SOURCE_ONLY_REFERENCE_EXPERIMENT = 'longmemeval-m-source-only-dev-v2';
export const SOURCE_ONLY_EMBEDDING_MODEL = 'openrouter:openai/text-embedding-3-large';
export const SOURCE_ONLY_GENERATION_MODEL = 'openrouter:anthropic/claude-sonnet-4.6';

interface SourceOnlyProfileBase {
  schema_version: 1;
  kind: 'source-only-development';
  question_id: string;
  attempt_id: string;
  registration_sha256: string;
  source_manifest_sha256: string;
  expected_product_sha: string;
  expected_package_sha256: string;
  allocation: { id: string; usd: number };
}

export type SourceOnlyDevelopmentProfile = SourceOnlyProfileBase & (
  | { experiment: typeof SOURCE_ONLY_EXPERIMENT | typeof SOURCE_ONLY_REFERENCE_EXPERIMENT; arm: 'B' | 'C0'; cue_mode: 'off' }
  | { experiment: typeof SOURCE_ONLY_EXPERIMENT; arm: 'C1'; cue_mode: 'on'; cue_pipeline_version: 'situation-v3'; cue_prompt_sha256: string }
  | { experiment: typeof SOURCE_ONLY_REFERENCE_EXPERIMENT; arm: 'C1'; cue_mode: 'on'; cue_pipeline_version: 'situation-v4'; cue_prompt_sha256: string }
) & (
  | { stage: 'construction' }
  | { stage: 'replay'; construction_receipt_sha256: string }
);

export function resolveSourceOnlyDevelopmentPolicy(profile: SourceOnlyDevelopmentProfile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('source-only development profile required');
  const allowed = ['schema_version', 'kind', 'experiment', 'question_id', 'attempt_id', 'registration_sha256', 'source_manifest_sha256',
    'expected_product_sha', 'expected_package_sha256', 'allocation', 'arm', 'cue_mode', 'stage'];
  if (profile.arm === 'C1') allowed.push('cue_pipeline_version', 'cue_prompt_sha256');
  if (profile.stage === 'replay') allowed.push('construction_receipt_sha256');
  if (Object.keys(profile).some(key => !allowed.includes(key)) || profile.schema_version !== 1 || profile.kind !== 'source-only-development'
    || ![SOURCE_ONLY_EXPERIMENT, SOURCE_ONLY_REFERENCE_EXPERIMENT].includes(profile.experiment) || !['B', 'C0', 'C1'].includes(profile.arm)
    || !['construction', 'replay'].includes(profile.stage)) throw new Error('unknown or unsupported source-only development policy');
  const identifier = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
  const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (!identifier(profile.question_id) || !identifier(profile.attempt_id) || !hash(profile.registration_sha256)
    || !hash(profile.source_manifest_sha256) || !hash(profile.expected_package_sha256)
    || typeof profile.expected_product_sha !== 'string' || !/^[a-f0-9]{40}$/.test(profile.expected_product_sha)) throw new Error('exact source-only registration, case and product identities required');
  const pipeline = profile.experiment === SOURCE_ONLY_EXPERIMENT ? 'situation-v3' : 'situation-v4';
  if (profile.arm === 'C1' ? profile.cue_mode !== 'on' || profile.cue_pipeline_version !== pipeline || !hash(profile.cue_prompt_sha256)
    : profile.cue_mode !== 'off') throw new Error(profile.experiment === SOURCE_ONLY_EXPERIMENT
      ? 'B/C0 require cues off; C1 requires the frozen v3 cue pipeline and prompt'
      : 'B/C0 require cues off; C1 requires the frozen v4 cue pipeline and prompt');
  if (profile.stage === 'replay' && !hash(profile.construction_receipt_sha256)) throw new Error('replay requires the linked construction receipt hash');
  const candidate = profile.arm === 'C1';
  const construction = profile.stage === 'construction';
  const ceiling = construction ? candidate ? 95 : 9 : candidate ? 5 : 1;
  const allocation = profile.allocation;
  if (!allocation || typeof allocation !== 'object' || Array.isArray(allocation)
    || Object.keys(allocation).some(key => !['id', 'usd'].includes(key)) || !identifier(allocation.id)
    || !Number.isFinite(allocation.usd) || allocation.usd <= 0 || allocation.usd > ceiling) throw new Error('root leaf allocation must be positive and within its fixed stage ceiling');
  return Object.freeze({
    id: profile.experiment,
    arm: profile.arm,
    stage: profile.stage,
    max_usd: ceiling,
    max_requests: construction ? candidate ? 5968 : 1968 : 32,
    max_request_bytes: 1024 * 1024,
    max_chat_request_bytes: construction && candidate ? 64 * 1024 : 0,
    max_output_tokens: construction && candidate ? 1200 : 0,
    stage_timeout_ms: (construction ? candidate ? 90 : 55 : candidate ? 30 : 5) * 60_000,
    case_max_usd: candidate ? 100 : 10,
    case_max_requests: candidate ? 6000 : 2000,
    case_timeout_ms: (candidate ? 120 : 60) * 60_000,
    embedding_model: SOURCE_ONLY_EMBEDDING_MODEL,
    embedding_dimensions: 1536,
    generation_model: SOURCE_ONLY_GENERATION_MODEL,
    evidence_max_bytes: 8192,
    ...(profile.experiment === SOURCE_ONLY_REFERENCE_EXPERIMENT ? { evidence_max_excerpts: 64, excerpt_max_utf16_units: 640 } : {}),
  });
}

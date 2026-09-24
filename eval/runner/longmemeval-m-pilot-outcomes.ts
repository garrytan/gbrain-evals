import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { scoreQuestion, summarizeAdapterRows, type Question } from './longmemeval.ts';
import { assertCompletePilotRows, type PilotRow } from './longmemeval-m-pilot-replay.ts';
import { PILOT_SONNET_MODEL } from './longmemeval-m-pilot-build.ts';
import { developmentChatOptions } from './situation-recall-development.ts';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(JSON.stringify(value));

export interface PilotCaseOutcome {
  schema_version: 2;
  arm: 'B' | 'C0' | 'C1';
  mode: 'offline' | 'live';
  question_id: string;
  selected_dataset_sha256: string;
  source_sha256: string;
  indexed_manifest_sha256: string;
  index_snapshot_sha256: string;
  product_sha: string;
  product_package_sha256: string;
  construction_stage_receipt_path?: string;
  replay_stage_receipt_path?: string;
  build_guard_receipt_sha256?: string;
  replay_guard_receipt_sha256?: string;
  row: PilotRow;
}

export function validatePilotCaseOutcome(outcome: PilotCaseOutcome): void {
  const hex = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (outcome.schema_version !== 2 || !['B', 'C0', 'C1'].includes(outcome.arm)
    || !['offline', 'live'].includes(outcome.mode) || !outcome.question_id
    || !hex(outcome.selected_dataset_sha256) || !hex(outcome.source_sha256)
    || !hex(outcome.indexed_manifest_sha256) || !hex(outcome.index_snapshot_sha256)
    || !/^[a-f0-9]{40}$/.test(outcome.product_sha) || !hex(outcome.product_package_sha256)
    || outcome.row?.question_id !== outcome.question_id || outcome.row.top_k !== 5
    || outcome.row.indexed_evidence?.schema_version !== 2 || outcome.row.indexed_evidence.provenance !== 'indexed-projection'
    || (outcome.mode === 'live' && (outcome.row.latency_source !== 'live_search'
      || !hex(outcome.build_guard_receipt_sha256) || !hex(outcome.replay_guard_receipt_sha256)
      || !outcome.construction_stage_receipt_path || !outcome.replay_stage_receipt_path))) {
    throw new Error('invalid pilot per-case outcome or missing live stage receipts');
  }
}

export function writePilotCaseOutcome(path: string, outcome: PilotCaseOutcome): string {
  validatePilotCaseOutcome(outcome);
  const bytes = JSON.stringify(outcome, null, 2) + '\n';
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  return hash(bytes);
}

export function aggregatePilotCases(selectionPath: string, selectedDatasetPath: string, paths: string[]) {
  const selectionBytes = readFileSync(selectionPath);
  const selection = JSON.parse(selectionBytes.toString());
  if (!Array.isArray(selection.selected_ids) || selection.selected_ids.length !== 28 || paths.length !== 28) {
    throw new Error('pilot aggregate requires exactly 28 frozen cases');
  }
  const selectedDatasetBytes = readFileSync(selectedDatasetPath);
  if (hash(selectedDatasetBytes) !== selection.selected_dataset?.sha256) throw new Error('frozen selected questions changed');
  const questions = JSON.parse(selectedDatasetBytes.toString()) as Question[];
  if (!Array.isArray(questions) || questions.length !== 28
    || questions.some((question, i) => question.question_id !== selection.selected_ids[i])) {
    throw new Error('frozen selected question order or count changed');
  }
  const byId = new Map(questions.map(question => [question.question_id, question]));
  const cases = paths.map(path => {
    const bytes = readFileSync(path);
    const outcome = JSON.parse(bytes.toString()) as PilotCaseOutcome;
    validatePilotCaseOutcome(outcome);
    return { outcome, sha256: hash(bytes) };
  });
  const arm = cases[0].outcome.arm, product = cases[0].outcome.product_package_sha256;
  for (const { outcome } of cases) {
    const buildBytes = readFileSync(outcome.construction_stage_receipt_path!);
    const replayBytes = readFileSync(outcome.replay_stage_receipt_path!);
    const build = JSON.parse(buildBytes.toString()), replay = JSON.parse(replayBytes.toString());
    if (outcome.arm === 'C1') {
      for (const [receipt, path] of [[build, outcome.construction_stage_receipt_path!],
        [replay, outcome.replay_stage_receipt_path!]] as const) {
        const bytes = readFileSync(join(dirname(path), 'c1-home/.gbrain/config.json'));
        const prepared = JSON.parse(bytes.toString());
        if (hash(bytes) !== receipt.prepared_gateway_config_sha256 || prepared.chat_model !== PILOT_SONNET_MODEL
          || !isDeepStrictEqual(prepared.provider_chat_options, developmentChatOptions(PILOT_SONNET_MODEL))) {
          throw new Error('C1 prepared provider options or config receipt changed');
        }
      }
    }
    if (hash(buildBytes) !== outcome.build_guard_receipt_sha256 || hash(replayBytes) !== outcome.replay_guard_receipt_sha256
      || build.status !== 'complete' || replay.status !== 'complete'
      || build.transport !== 'provider' || replay.transport !== 'provider'
      || build.profile?.stage !== 'construction' || replay.profile?.stage !== 'replay'
      || build.profile?.question_id !== outcome.question_id || replay.profile?.question_id !== outcome.question_id
      || build.profile?.arm !== outcome.arm || replay.profile?.arm !== outcome.arm
      || build.profile?.attempt_id !== replay.profile?.attempt_id
      || build.profile?.expected_product_sha !== outcome.product_sha
      || replay.profile?.expected_product_sha !== outcome.product_sha
      || build.profile?.expected_package_sha256 !== outcome.product_package_sha256
      || replay.profile?.expected_package_sha256 !== outcome.product_package_sha256
      || build.profile?.registration_sha256 !== hash(selectionBytes)
      || replay.profile?.registration_sha256 !== hash(selectionBytes)
      || build.profile?.source_manifest_sha256 !== replay.profile?.source_manifest_sha256
      || replay.profile?.construction_receipt_sha256 !== outcome.build_guard_receipt_sha256
      || replay.construction_receipt_sha256 !== outcome.build_guard_receipt_sha256
      || build.indexed_manifest_sha256 !== outcome.indexed_manifest_sha256
      || replay.indexed_manifest_sha256 !== outcome.indexed_manifest_sha256
      || build.index_snapshot_sha256 !== outcome.index_snapshot_sha256
      || replay.index_snapshot_sha256 !== outcome.index_snapshot_sha256
      || build.source_sha256 !== outcome.source_sha256 || replay.source_sha256 !== outcome.source_sha256
      || JSON.stringify(build.guard?.policy_context?.profile) !== JSON.stringify(build.profile)
      || JSON.stringify(replay.guard?.policy_context?.profile) !== JSON.stringify(replay.profile)
      || build.guard?.chat_sealed !== true || replay.guard?.chat_sealed !== true
      || build.guard?.limits?.max_requests !== (outcome.arm === 'C1' ? 5968 : 1968)
      || replay.guard?.limits?.max_requests !== 32
      || build.guard?.limits?.max_usd !== build.profile?.allocation?.usd
      || replay.guard?.limits?.max_usd !== replay.profile?.allocation?.usd
      || build.guard?.publishable !== false || replay.guard?.publishable !== false
      || build.guard?.failed_or_unreported_requests !== 0 || replay.guard?.failed_or_unreported_requests !== 0
      || build.guard?.reserved_usd !== 0 || replay.guard?.reserved_usd !== 0
      || build.guard?.requests_with_unknown_byok_status !== 0 || replay.guard?.requests_with_unknown_byok_status !== 0
      || build.guard?.requests_with_unreported_byok_cost !== 0 || replay.guard?.requests_with_unreported_byok_cost !== 0
      || build.guard?.stage_deadline_exceeded || replay.guard?.stage_deadline_exceeded
      || (outcome.arm === 'C1' && (build.cue_readback_status !== 'uncalibrated-diagnostic'
        || build.cue_build?.final_status !== 'complete' || build.cue_build.windows_pending !== 0
        || build.profile?.cue_pipeline_version !== 'situation-v3'
        || replay.profile?.cue_prompt_sha256 !== build.profile?.cue_prompt_sha256))) {
      throw new Error('pilot stage receipt hash, outcome or construction-replay linkage changed');
    }
    const bucket = Object.entries(selection.selected as Record<string, string[]>).find(([, ids]) => ids.includes(outcome.question_id))?.[0];
    const question = byId.get(outcome.question_id);
    const row = outcome.row;
    const expectedRetrieved = [...new Set(row.indexed_evidence.returned_chunks.map(chunk => chunk.session_id))];
    const metrics = scoreQuestion(row.retrieved, question?.answer_session_ids ?? [], 5);
    const isAbs = outcome.question_id.endsWith('_abs');
    if (outcome.mode !== 'live' || outcome.arm !== arm || outcome.product_package_sha256 !== product
      || outcome.product_sha !== cases[0].outcome.product_sha
      || outcome.selected_dataset_sha256 !== selection.selected_dataset?.sha256
      || outcome.source_sha256 !== selection.selected_source_details?.[outcome.question_id]?.source_sha256
      || !question || !bucket || (bucket === 'abstention') !== isAbs
      || bucket !== 'abstention' && question.question_type !== bucket
      || row.question_type !== question.question_type || row.dataset !== 'm-cleaned-pilot'
      || row.num_haystack !== question.haystack_sessions.length
      || JSON.stringify(row.ground_truth) !== JSON.stringify(question.answer_session_ids)
      || JSON.stringify(row.retrieved) !== JSON.stringify(expectedRetrieved)
      || row.hit_at_k !== (metrics.recall_any === 1)
      || (isAbs ? row.is_abs !== true || row.abs_noise !== metrics.abs_noise
        : row.recall_all !== metrics.recall_all || row.recall_any !== metrics.recall_any || row.ndcg_any !== metrics.ndcg_any)) {
      throw new Error('pilot aggregate has mismatched source, product, question, score or live status');
    }
  }
  const rows = cases.map(item => item.outcome.row);
  assertCompletePilotRows(rows, selection.selected_ids);
  const summary = summarizeAdapterRows('gbrain-hybrid', rows, 5, 'm-cleaned-pilot');
  if (summary.total !== 24 || summary.n_abs !== 4 || summary.n_rows !== 28 || summary.n_errors_infra !== 0) {
    throw new Error('pilot aggregate changed the native 24/4 denominator or excluded errors');
  }
  return { schema_version: 2, arm, selection_sha256: hash(selectionBytes), selected_dataset_sha256: selection.selected_dataset.sha256,
    product_sha: cases[0].outcome.product_sha, product_package_sha256: product,
    case_receipts: cases.map(item => ({ question_id: item.outcome.question_id, sha256: item.sha256 })),
    native_summary: summary, summary_sha256: digest(summary), completion: { outcomes: 28, answerable: 24, abstention: 4 } };
}

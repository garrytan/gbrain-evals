/**
 * Arm manifests for the batch lane: the frozen, row-level contract of one arm.
 *
 * A manifest names every question the arm owes a result for, the hash of the
 * exact request body each question is sent as, the model, the output limit,
 * the reasoning effort and the prompt protocol's identity. It is written once
 * before the arm's first paid request and never changes: results join to it by
 * question id, and a body whose hash differs from the manifest refuses to send.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type Provider = 'openai' | 'anthropic';

export interface ArmRequest {
  question_id: string;
  body_sha256: string;
}

export interface ArmManifest {
  schema_version: 1;
  arm_id: string;
  workstream: string;
  kind: 'reader' | 'judge';
  provider: Provider;
  model: string;
  max_output_tokens: number;
  reasoning_effort: string | null;
  /** The prompt protocol: a name and the sha256 of its fixed instruction text. */
  protocol: { name: string; sha256: string };
  /** Where the bodies came from, in words, with the committed files they derive from. */
  source: string;
  denominator: number;
  requests: ArmRequest[];
}

export const sha256 = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');

/** A request body is identified by the hash of the exact JSON the lane sends. */
export const bodyText = (body: unknown) => JSON.stringify(body);
export const bodySha = (body: unknown) => sha256(bodyText(body));

/**
 * Preregistered reader settings per model (W10 preregistration). Reasoning
 * models (GPT at medium effort; Claude 5.x models, which think adaptively by
 * default and count thinking toward `max_tokens`) have an output floor: a
 * request below it would let reasoning silently eat the answer.
 */
export const MODEL_SETTINGS: Record<string, { provider: Provider; reasoning: boolean; effort: string | null; max_output_tokens: number }> = {
  'claude-sonnet-5-5': { provider: 'anthropic', reasoning: true, effort: 'low', max_output_tokens: 4096 },
  'claude-opus-5-5': { provider: 'anthropic', reasoning: true, effort: 'low', max_output_tokens: 4096 },
  'claude-fable-5-1': { provider: 'anthropic', reasoning: true, effort: 'low', max_output_tokens: 4096 },
  'gpt-6.1-sol': { provider: 'openai', reasoning: true, effort: 'medium', max_output_tokens: 12000 },
  'gpt-5.4': { provider: 'openai', reasoning: true, effort: 'medium', max_output_tokens: 12000 },
  'gpt-4o-2024-08-06': { provider: 'openai', reasoning: false, effort: null, max_output_tokens: 10 },
};

export const JUDGE_SECONDARY = { model: 'gpt-6.1-sol', effort: 'low', max_output_tokens: 2000 } as const;

export function assertOutputFloor(model: string, maxOutputTokens: number, floor?: number): void {
  const settings = MODEL_SETTINGS[model];
  const required = floor ?? (settings?.reasoning ? settings.max_output_tokens : 1);
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < required) {
    throw new Error(`${model} is a reasoning model: an output limit of ${maxOutputTokens} is below its preregistered ${required}-token floor, so reasoning could cut the answer off`);
  }
}

export interface BuildManifestInput extends Omit<ArmManifest, 'schema_version' | 'requests'> {
  bodies: Map<string, unknown>;
  /** Output-limit floor for reasoning judges whose limit differs from the reader table. */
  outputFloor?: number;
}

/** Build a manifest from bodies keyed by question id, checking the row contract. */
export function buildManifest(input: BuildManifestInput): ArmManifest {
  const { bodies, outputFloor, ...meta } = input;
  if (bodies.size !== meta.denominator) throw new Error(`${meta.arm_id}: ${bodies.size} bodies for a denominator of ${meta.denominator}`);
  if (MODEL_SETTINGS[meta.model]?.reasoning || outputFloor) assertOutputFloor(meta.model, meta.max_output_tokens, outputFloor);
  const requests: ArmRequest[] = [];
  for (const [question_id, body] of [...bodies].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const b = body as Record<string, unknown>;
    if (b.model !== meta.model) throw new Error(`${meta.arm_id}/${question_id}: body names model ${String(b.model)}, manifest ${meta.model}`);
    const limit = b.max_tokens ?? b.max_completion_tokens;
    if (limit !== meta.max_output_tokens) throw new Error(`${meta.arm_id}/${question_id}: body output limit ${String(limit)}, manifest ${meta.max_output_tokens}`);
    requests.push({ question_id, body_sha256: bodySha(body) });
  }
  return { schema_version: 1, ...meta, requests };
}

export const manifestSha = (m: ArmManifest) => sha256(JSON.stringify(m));

/** Write a manifest once. Rewriting it with different content refuses: an arm's contract is immutable. */
export function freezeManifest(path: string, manifest: ArmManifest): ArmManifest {
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, 'utf8')) as ArmManifest;
    if (manifestSha(existing) !== manifestSha(manifest)) {
      throw new Error(`manifest ${path} already exists with different content (arm ${existing.arm_id}); manifests are immutable once written. A change is a new arm id and a dated preregistration amendment`);
    }
    return existing;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 1) + '\n');
  return manifest;
}

export function readManifest(path: string): ArmManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as ArmManifest;
}

/** Refuse a body that does not hash to the manifest's entry for its question (prevents mixing prompt versions). */
export function checkBody(manifest: ArmManifest, questionId: string, body: unknown): void {
  const entry = manifest.requests.find(r => r.question_id === questionId);
  if (!entry) throw new Error(`${manifest.arm_id}: question ${questionId} is not in the arm manifest`);
  const sha = bodySha(body);
  if (sha !== entry.body_sha256) {
    throw new Error(`${manifest.arm_id}: request body for ${questionId} hashes to ${sha.slice(0, 12)}, but the manifest froze ${entry.body_sha256.slice(0, 12)}; refusing to send a different prompt under the same arm`);
  }
}

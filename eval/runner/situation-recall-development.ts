import type { Cat36Profile } from './cat36-associative-retrieval.ts';
import { isDeepStrictEqual } from 'node:util';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { closeSync, constants, fsyncSync, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolveRegressionProduct } from './situation-recall-provenance.ts';
import { resolveSourceOnlyDevelopmentPolicy, type SourceOnlyDevelopmentProfile } from './situation-recall-experiment-policy.ts';

const CHAT_PRICES: Record<string, { input: number; output: number }> = {
  'openrouter:qwen/qwen3.7-flash': { input: 0.03, output: 0.13 },
  'openrouter:openai/gpt-4o-mini': { input: 0.15, output: 0.60 },
  'openrouter:anthropic/claude-sonnet-4.6': { input: 3, output: 15 },
};

export function developmentChatOptions(model: string) {
  if (!Object.hasOwn(CHAT_PRICES, model)) throw new Error('development generation route is not allowlisted');
  const price = CHAT_PRICES[model];
  return { [model]: { reasoning: { enabled: false }, provider: { allow_fallbacks: false, max_price: { prompt: price.input, completion: price.output, request: 0 } } } };
}

export async function assertDevelopmentPricing(profile: Cat36Profile, verifiedPackagePath: string): Promise<void> {
  if (profile.provider_budget?.kind !== 'operator-authorized-development') return;
  const { lookupEmbeddingPrice } = await import(pathToFileURL(join(verifiedPackagePath, 'src/core/embedding-pricing.ts')).href);
  const embedding = lookupEmbeddingPrice(profile.embedding_model);
  if (embedding.kind !== 'known' || embedding.pricePerMTok !== 0.13) throw new Error('development embedding pricing unavailable or changed');
  if (profile.arm !== 'C1') return;
  const { canonicalLookup } = await import(pathToFileURL(join(verifiedPackagePath, 'src/core/model-pricing.ts')).href);
  const price = canonicalLookup(profile.generation_model);
  const expected = CHAT_PRICES[profile.generation_model!];
  if (!price || !expected || price.input !== expected.input || price.output !== expected.output) throw new Error('development generation pricing unavailable or changed; exact OpenRouter price row required before ingestion');
}

export interface DevelopmentAdmission {
  kind: 'operator-authorized-development';
  approval_id: string;
  max_usd: number;
  max_requests: number;
  max_request_bytes: number;
  max_output_tokens: number;
  build_timeout_ms: number;
  cell_timeout_ms: number;
}

export function startDevelopmentRequestGuard(profile: Cat36Profile, journalPath?: string) {
  const admission = structuredClone(profile.provider_budget);
  if (admission?.kind !== 'operator-authorized-development') return undefined;
  const { sealConstruction, ...guard } = installRequestGuard({ limits: admission, generationModel: profile.generation_model!,
    chatAllowed: profile.arm === 'C1', chatBodyMaxBytes: 8192 }, journalPath);
  return guard;
}

export async function startSourceOnlyDevelopmentGuard(input: SourceOnlyDevelopmentProfile, options: { journalPath: string; verifiedPackagePath: string }) {
  const profile = structuredClone(input);
  const policy = resolveSourceOnlyDevelopmentPolicy(profile);
  if (!options?.journalPath || !options.verifiedPackagePath) throw new Error('source-only guard requires a fresh journal and verified package path');
  const product = resolveRegressionProduct({ expectedProductSha: profile.expected_product_sha,
    expectedPackageSha256: profile.expected_package_sha256, importerPath: import.meta.path });
  if (product.package_path !== realpathSync(options.verifiedPackagePath)) throw new Error('source-only guard package binding mismatch');
  const { lookupEmbeddingPrice } = await import(pathToFileURL(join(product.package_path, 'src/core/embedding-pricing.ts')).href);
  const embedding = lookupEmbeddingPrice(policy.embedding_model);
  if (embedding.kind !== 'known' || embedding.pricePerMTok !== 0.13) throw new Error('source-only embedding pricing unavailable or changed');
  let cuePrompt: string | undefined;
  if (profile.arm === 'C1') {
    const { canonicalLookup } = await import(pathToFileURL(join(product.package_path, 'src/core/model-pricing.ts')).href);
    const price = canonicalLookup(policy.generation_model);
    if (!price || price.input !== 3 || price.output !== 15) throw new Error('source-only generation pricing unavailable or changed');
    const { MEMORY_CUE_PROMPT_VERSION } = await import(pathToFileURL(join(product.package_path, 'src/core/memory-cues/types.ts')).href);
    const { CUE_SYSTEM_PROMPT } = await import(pathToFileURL(join(product.package_path, 'src/core/memory-cues/providers.ts')).href);
    if (MEMORY_CUE_PROMPT_VERSION !== profile.cue_pipeline_version || typeof CUE_SYSTEM_PROMPT !== 'string'
      || createHash('sha256').update(CUE_SYSTEM_PROMPT).digest('hex') !== profile.cue_prompt_sha256) throw new Error('source-only cue pipeline or prompt identity mismatch');
    cuePrompt = CUE_SYSTEM_PROMPT;
  }
  const guard = installRequestGuard({
    limits: { max_usd: profile.allocation.usd, max_requests: policy.max_requests, max_request_bytes: policy.max_request_bytes,
      max_output_tokens: policy.max_output_tokens, cell_timeout_ms: policy.stage_timeout_ms },
    generationModel: policy.generation_model, chatAllowed: profile.arm === 'C1' && profile.stage === 'construction',
    chatBodyMaxBytes: policy.max_chat_request_bytes, cuePrompt,
    policyContext: { profile, policy, product, publishable: false, release_coverage: false, authorization_verified: false,
      allocation_authority: 'root-owned leaf allocation; policy ceilings do not authorize spending', deadline_scope: 'leaf-stage; root enforces the outer case deadline' },
  }, options.journalPath);
  return { sealConstruction: guard.sealConstruction, restore: guard.restore, snapshot() {
    const { cell_deadline_exceeded, ...usage } = guard.snapshot();
    return { ...usage, publishable: false, release_coverage: false, authorization_verified: false, stage_deadline_exceeded: cell_deadline_exceeded };
  } };
}

interface GuardConfiguration {
  limits: Pick<DevelopmentAdmission, 'max_usd' | 'max_requests' | 'max_request_bytes' | 'max_output_tokens' | 'cell_timeout_ms'>;
  generationModel: string;
  chatAllowed: boolean;
  chatBodyMaxBytes: number;
  cuePrompt?: string;
  policyContext?: Record<string, unknown>;
}

function sourceOnlyCuePayload(payload: Record<string, unknown>, prompt: string): boolean {
  if (Object.keys(payload).some(key => !['model', 'messages', 'max_tokens', 'temperature', 'reasoning', 'provider'].includes(key))
    || payload.temperature !== 0 || payload.max_tokens !== 1200 || !Array.isArray(payload.messages) || payload.messages.length !== 2) return false;
  const text = (message: unknown, role: string): string | undefined => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
    const row = message as Record<string, unknown>;
    if (row.role !== role || Object.keys(row).some(key => !['role', 'content'].includes(key)) || typeof row.content !== 'string') return undefined;
    return row.content;
  };
  if (text(payload.messages[0], 'system') !== prompt) return false;
  const user = text(payload.messages[1], 'user');
  if (user === undefined) return false;
  try {
    const data = JSON.parse(user);
    return data !== null && typeof data === 'object' && !Array.isArray(data)
      && Object.keys(data).length === 2 && Object.keys(data).every(key => ['includeBridge', 'evidence'].includes(key))
      && data.includeBridge === false && typeof data.evidence === 'string' && Buffer.byteLength(data.evidence) > 0 && Buffer.byteLength(data.evidence) <= 8192
      && user === JSON.stringify({ includeBridge: false, evidence: data.evidence });
  } catch { return false; }
}

function installRequestGuard(configuration: GuardConfiguration, journalPath?: string) {
  const admission = structuredClone(configuration.limits);
  const generationModel = configuration.generationModel;
  const chatOptions = developmentChatOptions(generationModel)[generationModel];
  const chatPrice = CHAT_PRICES[generationModel];
  let chatSealed = !configuration.chatAllowed;
  const previous = globalThis.fetch;
  const usage = {
    provider_hard_cap: false,
    dollar_enforcement: configuration.policyContext ? 'fixed experiment policy bounds; root leaf allocation is not independently authorized or externally capped by this guard'
      : 'local conservative reservations within operator allocation; no provider hard cap or invoice guarantee',
    ...(configuration.policyContext ? { policy_context: structuredClone(configuration.policyContext) } : {}),
    limits: structuredClone(admission),
    journal_path: journalPath ?? null,
    reservation_basis: { input_bound: 'UTF-8 JSON request bytes', embedding_usd_per_million: 0.13, chat_input_usd_per_million: chatPrice.input, chat_output_usd_per_million: chatPrice.output },
    reserved_usd: 0,
    dispatched_requests: 0,
    rejected_requests: 0,
    failed_or_unreported_requests: 0,
    reported_input_tokens: 0,
    reported_output_tokens: 0,
    provider_reported_usd: 0,
    byok_upstream_usd: 0,
    requests_with_unknown_byok_status: 0,
    requests_with_unreported_byok_cost: 0,
    requests_with_reported_cost: 0,
    closed_transport_retained: false,
    per_request: [] as Array<Record<string, unknown>>,
  };
  let stopped = false;
  if (journalPath) writeFileSync(journalPath, JSON.stringify({ event: configuration.policyContext ? 'policy-stage' : 'admission', generation_model: generationModel, ...usage }) + '\n', { flag: 'wx', mode: 0o600 });
  const artifactDir = journalPath ? join(dirname(journalPath), 'development-http') : undefined;
  if (artifactDir) mkdirSync(artifactDir);
  const secrets = [...new Set(Object.entries(process.env).filter(([key, value]) => /(?:KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)$/i.test(key) && value).map(([, value]) => value!))].sort((a, b) => b.length - a.length);
  const sanitize = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let text = value;
      for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
      return text.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]').replace(/\bsk-(?:or-v1-)?[A-Za-z0-9_-]{16,}/g, '[REDACTED]');
    }
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/^(?:headers|authorization|proxy[-_]authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|credentials?)$/i.test(key))
      .map(([key, item]) => [key, sanitize(item)]));
    return value;
  };
  const artifact = (sequence: number, kind: string, value: unknown) => {
    if (!artifactDir) return null;
    const sanitized = sanitize(value);
    const text = JSON.stringify(sanitized, null, 2) + '\n';
    const path = join(artifactDir, `${String(sequence).padStart(6, '0')}-${kind}.json`);
    let fd: number | undefined;
    try { fd = openSync(path, 'wx', 0o600); writeFileSync(fd, text); fsyncSync(fd); }
    catch { stopped = true; throw new Error('development HTTP artifact unavailable; further dispatch blocked'); }
    finally { if (fd !== undefined) closeSync(fd); }
    return { path, sha256: createHash('sha256').update(text).digest('hex'), format: 'sanitized-json', redacted: JSON.stringify(value) !== JSON.stringify(sanitized) };
  };
  const journal = (event: string, entry: Record<string, unknown>) => {
    if (!journalPath) return;
    let fd: number | undefined;
    try { fd = openSync(journalPath, constants.O_WRONLY | constants.O_APPEND); writeFileSync(fd, JSON.stringify({ event, ...entry }) + '\n'); fsyncSync(fd); }
    catch { stopped = true; throw new Error('development accounting journal unavailable; further dispatch blocked'); }
    finally { if (fd !== undefined) closeSync(fd); }
  };
  const started = performance.now();
  const deadline = new AbortController();
  const timer = setTimeout(() => { stopped = true; deadline.abort(); }, admission.cell_timeout_ms);
  timer.unref();
  const guarded = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const reject = (): never => {
      usage.rejected_requests++;
      throw new Error('development provider request limit or route rejected; no request dispatched');
    };
    if (stopped) return reject();
    const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.origin !== 'https://openrouter.ai' || url.search || url.username || url.password
      || !['/api/v1/embeddings', '/api/v1/chat/completions'].includes(url.pathname)) return reject();
    const body = await request.clone().text();
    if (Buffer.byteLength(body) > admission.max_request_bytes) return reject();
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(body); }
    catch { return reject(); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return reject();
    const embedding = url.pathname === '/api/v1/embeddings';
    if (embedding) {
      if (payload.model !== 'openai/text-embedding-3-large' || payload.dimensions !== 1536
        || !(typeof payload.input === 'string' || (Array.isArray(payload.input) && payload.input.every(value => typeof value === 'string')))) return reject();
    } else if (chatSealed || payload.model !== generationModel.slice('openrouter:'.length)
      || !Number.isInteger(payload.max_tokens) || Number(payload.max_tokens) < 1 || Number(payload.max_tokens) > admission.max_output_tokens
      || payload.stream === true || payload.tools !== undefined || payload.max_completion_tokens !== undefined
      || (payload.n !== undefined && payload.n !== 1) || payload.best_of !== undefined
      || !Array.isArray(payload.messages) || payload.messages.some(message => !message || typeof message !== 'object'
        || !(typeof message.content === 'string' || (Array.isArray(message.content) && message.content.every((block: { type?: string; text?: string }) => block?.type === 'text' && typeof block.text === 'string'))))
      || !isDeepStrictEqual(payload.reasoning, chatOptions.reasoning)
      || !isDeepStrictEqual(payload.provider, chatOptions.provider)
      || Buffer.byteLength(body) > configuration.chatBodyMaxBytes
      || (configuration.cuePrompt !== undefined && !sourceOnlyCuePayload(payload, configuration.cuePrompt))) return reject();
    const reservation = Math.ceil((Buffer.byteLength(body) * (embedding ? 0.13 : chatPrice.input) + (embedding ? 0 : Number(payload.max_tokens) * chatPrice.output))) / 1e6;
    if (stopped || usage.dispatched_requests >= admission.max_requests
      || usage.provider_reported_usd + usage.byok_upstream_usd + usage.reserved_usd + reservation > admission.max_usd) return reject();
    usage.reserved_usd += reservation;
    const entry: Record<string, unknown> = { sequence: usage.dispatched_requests + 1, model: payload.model, request_bytes: Buffer.byteLength(body),
      reservation_usd: reservation, reservation_retained: true, status: null, usage: null, accounting: 'pending' };
    entry.request_artifact = artifact(Number(entry.sequence), 'request', payload);
    usage.per_request.push(entry);
    journal('reserved', entry);
    usage.dispatched_requests++;
    const uncertain = (reason: string): never => {
      stopped = true;
      usage.failed_or_unreported_requests++;
      entry.accounting = reason;
      journal('uncertain', entry);
      throw new Error(`development ${reason}; reservation retained and further dispatch blocked`);
    };
    let response: Response;
    try {
      response = await previous(request, { redirect: 'error', signal: AbortSignal.any([request.signal, deadline.signal]) });
    } catch (error) {
      entry.error_artifact = artifact(Number(entry.sequence), 'error', { name: error instanceof Error ? error.name : 'UnknownError', message: String(error) });
      usage.requests_with_unknown_byok_status++;
      return uncertain('network outcome unknown');
    }
    entry.status = response.status;
    let data: { model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; is_byok?: boolean; cost_details?: { upstream_inference_cost?: number } } };
    let responseText: string;
    try { responseText = await response.clone().text(); }
    catch (error) {
      entry.error_artifact = artifact(Number(entry.sequence), 'error', { name: error instanceof Error ? error.name : 'UnknownError', message: String(error) });
      usage.requests_with_unknown_byok_status++; return uncertain('response body unavailable');
    }
    try { data = JSON.parse(responseText) as typeof data; }
    catch {
      entry.response_artifact = artifact(Number(entry.sequence), 'response', { format: 'non-json', text: responseText });
      usage.requests_with_unknown_byok_status++; return uncertain('response accounting missing');
    }
    entry.response_artifact = artifact(Number(entry.sequence), 'response', data);
    entry.response_model = sanitize(data?.model ?? null);
    const recorded = data?.usage;
    const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const upstream = finite(recorded?.cost_details?.upstream_inference_cost);
    const cost = finite(recorded?.cost);
    const inputTokens = finite(recorded?.prompt_tokens);
    const outputTokens = finite(recorded?.completion_tokens);
    entry.usage = { input_tokens: inputTokens, output_tokens: outputTokens,
      router_cost_usd: cost, is_byok: typeof recorded?.is_byok === 'boolean' ? recorded.is_byok : null, upstream_inference_cost_usd: upstream };
    if (typeof recorded?.is_byok !== 'boolean') usage.requests_with_unknown_byok_status++;
    if (recorded?.is_byok === true) {
      if (upstream !== null) usage.byok_upstream_usd += upstream;
      else usage.requests_with_unreported_byok_cost++;
    }
    if (inputTokens !== null) usage.reported_input_tokens += inputTokens;
    if (outputTokens !== null) usage.reported_output_tokens += outputTokens;
    if (cost !== null) { usage.provider_reported_usd += cost; usage.requests_with_reported_cost++; }
    const modelMatches = embedding ? ['openai/text-embedding-3-large', 'text-embedding-3-large'].includes(data?.model ?? '') : data?.model === payload.model;
    if (!response.ok || !modelMatches || inputTokens === null || !Number.isInteger(inputTokens)
      || (!embedding && (outputTokens === null || !Number.isInteger(outputTokens) || outputTokens > Number(payload.max_tokens)))
      || cost === null || typeof recorded?.is_byok !== 'boolean' || (recorded.is_byok && upstream === null)) return uncertain('response accounting or model invalid');
    if (cost + (recorded.is_byok ? upstream! : 0) > reservation + 1e-12) return uncertain('reported charge exceeds priced reservation');
    usage.reserved_usd = Math.max(0, usage.reserved_usd - reservation);
    entry.reservation_retained = false;
    entry.accounting = 'reported';
    journal('settled', entry);
    return response;
  }) as unknown as typeof fetch;
  globalThis.fetch = guarded;
  return {
    sealConstruction() {
      if (chatSealed) return;
      chatSealed = true;
      journal('construction-sealed', { dispatched_requests: usage.dispatched_requests, reserved_usd: usage.reserved_usd });
    },
    snapshot: () => ({ ...structuredClone(usage), known_attributed_usd: usage.provider_reported_usd + usage.byok_upstream_usd,
      elapsed_ms: performance.now() - started, cell_deadline_exceeded: deadline.signal.aborted,
      ...(configuration.policyContext ? { chat_sealed: chatSealed } : {}) }),
    restore() {
      usage.closed_transport_retained = stopped || usage.rejected_requests > 0 || usage.per_request.some(entry => entry.accounting === 'pending');
      stopped = true;
      clearTimeout(timer);
      if (!usage.closed_transport_retained) globalThis.fetch = previous;
    },
  };
}

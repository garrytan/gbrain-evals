/** Explicit, capped execution of an offline paired-request plan. Never runs from tests or recount. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chat, configureGateway, type ChatOpts, type ChatResult } from 'gbrain-reader/ai/gateway';
import { withAIInvocationGuard, type AIInvocationUsage } from 'gbrain-reader/ai/invocation-guard';
import { canonicalLookup } from 'gbrain-reader/core/model-pricing';
import { resolveReaderConfig, readerConfigHash } from 'gbrain-reader/eval/longmemeval/reader';
import { prepareRequests, type FrozenReadingInput, type PreparedRequest } from './reading-notes-requests.ts';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const MODEL = 'anthropic:claude-sonnet-4-6';
type Planned = { question_id: string; mode: 'direct' | 'notes'; request: PreparedRequest; source_sha256: string; context_chars: number };
type Plan = { schema: number; model: string; max_tokens: number; configs: Record<'direct' | 'notes', { mode: string; prompt_version: string; prompt_sha256: string; config_sha256: string }>;
  rows: Planned[]; identity: { input_sha256: string; installed_reader_sha256: string; installed_package_sha256: string; declared_reader_pin: string } };
const digest = /^[a-f0-9]{64}$/;

function validatePlan(plan: Plan) {
  if (plan?.schema !== 1 || plan.model !== MODEL || !Number.isSafeInteger(plan.max_tokens) || plan.max_tokens < 1 || plan.max_tokens > 4096
    || !Array.isArray(plan.rows) || !plan.rows.length || plan.rows.length % 2) throw new Error('invalid paired request plan');
  const sourcePath = fileURLToPath(import.meta.resolve('gbrain-reader/eval/longmemeval/reader'));
  const packageJson = readFileSync(resolve(dirname(sourcePath), '../../../package.json'));
  const declared = JSON.parse(readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf8')).dependencies['gbrain-reader'];
  if (plan.identity?.installed_reader_sha256 !== sha(readFileSync(sourcePath)) || plan.identity.installed_package_sha256 !== sha(packageJson)
    || plan.identity.declared_reader_pin !== declared || !digest.test(plan.identity.input_sha256)) throw new Error('installed code or input identity mismatch');
  for (const mode of ['direct', 'notes'] as const) {
    const config = resolveReaderConfig({ mode, maxTokens: plan.max_tokens });
    if (JSON.stringify(plan.configs?.[mode]) !== JSON.stringify({ mode, prompt_version: config.promptVersion, prompt_sha256: config.promptSha, config_sha256: readerConfigHash(config, MODEL) })) throw new Error('reader config mismatch');
  }
  const ids = new Set<string>();
  for (let i = 0; i < plan.rows.length; i += 2) {
    const [direct, notes] = plan.rows.slice(i, i + 2);
    if (!direct || !notes || direct.mode !== 'direct' || notes.mode !== 'notes' || direct.question_id !== notes.question_id
      || !/^[a-z0-9_]+$/.test(direct.question_id) || ids.has(direct.question_id)
      || !digest.test(direct.source_sha256) || notes.source_sha256 !== direct.source_sha256
      || !Number.isSafeInteger(direct.context_chars) || direct.context_chars < 1 || direct.context_chars !== notes.context_chars) throw new Error('incomplete or mismatched request pair');
    ids.add(direct.question_id);
    for (const row of [direct, notes]) {
      const expected = resolveReaderConfig({ mode: row.mode, maxTokens: plan.max_tokens });
      const request = row.request;
      if (request?.model !== MODEL || request.max_tokens !== plan.max_tokens || request.system !== expected.system
        || !Array.isArray(request.messages) || request.messages.length !== 1 || request.messages[0]?.role !== 'user'
        || typeof request.messages[0].content !== 'string' || !request.messages[0].content.trim()) throw new Error('request does not match frozen reader configuration');
    }
    if (JSON.stringify(direct.request.messages) !== JSON.stringify(notes.request.messages)) throw new Error('reader inputs differ between modes');
  }
}

export interface ComparisonRuntime { call: (request: ChatOpts) => Promise<ChatResult> }
export async function runComparison(plan: Plan, opts: { maxUsd: number; approvalId: string; journalPath: string; inputBytes: Buffer }, runtime: ComparisonRuntime = { call: chat }) {
  validatePlan(plan);
  if (sha(opts.inputBytes) !== plan.identity.input_sha256
    || JSON.stringify(await prepareRequests(JSON.parse(opts.inputBytes.toString()) as FrozenReadingInput[], MODEL, plan.max_tokens)) !== JSON.stringify({ schema: plan.schema, purpose: 'offline requests only; no model answers or grades', model: plan.model, max_tokens: plan.max_tokens, configs: plan.configs, rows: plan.rows })) throw new Error('frozen source/input differs from paired request plan');
  const price = canonicalLookup(MODEL);
  if (!price || !Number.isFinite(opts.maxUsd) || opts.maxUsd <= 0 || opts.maxUsd > 1000 || !opts.approvalId?.trim()) throw new Error('finite approved spend cap and canonical pricing required');
  const path = resolve(opts.journalPath);
  const reports = resolve(import.meta.dir, '../reports');
  if (relative(reports, path).startsWith('..') || path === reports || existsSync(path)) throw new Error('journal must be a new ignored eval/reports file');
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'wx', 0o600);
  const append = (row: unknown) => { writeSync(fd, JSON.stringify(row) + '\n'); fsyncSync(fd); };
  let spent = 0, physicalCalls = 0;
  const outcomes: Array<{ question_id: string; mode: string; completed: boolean; finish_reason: string | null; cost_usd: number | null }> = [];
  try {
    append({ event: 'run', schema: 1, approval_id: opts.approvalId, cap_usd: opts.maxUsd, model: MODEL, plan_sha256: sha(JSON.stringify(plan)), rows: plan.rows.length });
    for (let i = 0; i < plan.rows.length; i += 2) {
      const pair = plan.rows.slice(i, i + 2);
      for (const row of i % 4 === 0 ? pair : pair.reverse()) {
        const request = row.request;
        const id = `${row.question_id}:${row.mode}`;
        const requestSha = sha(JSON.stringify(request));
        const upperInput = Buffer.byteLength(request.system + request.messages[0].content, 'utf8') + 1024;
        const worstCase = (upperInput * Math.max(price.input, price.cache_write ?? price.input * 2) + request.max_tokens * price.output) / 1e6;
        if (spent + worstCase > opts.maxUsd) { append({ event: 'blocked', id, reason: 'spend cap', spent_usd: spent }); throw new Error('spend cap reached before provider admission'); }
        let admitted = false, settled = false, boundViolated = false, cost: number | null = null, measured: AIInvocationUsage | null = null;
        try {
          const result = await withAIInvocationGuard(async call => {
            if (admitted || call.model !== MODEL || call.kind !== 'chat' || call.maxOutputTokens !== request.max_tokens || call.cacheWriteTtl === '1h') throw new Error('unexpected physical provider invocation');
            admitted = true; physicalCalls++;
            append({ event: 'admit', id, attempt: 1, request_sha256: requestSha, input_upper_bound: upperInput, max_output_tokens: request.max_tokens });
            return { settle: async (usage: AIInvocationUsage | null) => {
              if (settled) throw new Error('double settlement');
              settled = true;
              if (usage && [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0].every(n => Number.isSafeInteger(n) && n >= 0)) {
                measured = usage;
                boundViolated = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) > upperInput || usage.outputTokens > request.max_tokens;
                cost = (usage.inputTokens * price.input + usage.outputTokens * price.output
                  + (usage.cacheReadTokens ?? 0) * (price.cache_read ?? price.input)
                  + (usage.cacheWriteTokens ?? 0) * (price.cache_write ?? price.input * 2)) / 1e6;
                spent += cost;
              }
              append({ event: 'settle', id, usage, cost_usd: cost, bound_violation: boundViolated });
            } };
          }, () => runtime.call({ model: MODEL, system: request.system, messages: request.messages, maxTokens: request.max_tokens, abortSignal: AbortSignal.timeout(180_000) }));
          const verifiedUsage = measured as AIInvocationUsage | null;
          const accepted = admitted && settled && cost !== null && !boundViolated && ['end', 'length'].includes(result.stopReason) && !!result.text?.trim()
            && result.model === MODEL && result.providerId === 'anthropic'
            && (!result.responseModel || /^claude-sonnet-4-6(?:-\d{8})?$/.test(result.responseModel)) && !!result.usage
            && verifiedUsage?.inputTokens === result.usage.input_tokens && verifiedUsage.outputTokens === result.usage.output_tokens
            && (verifiedUsage.cacheReadTokens ?? 0) === result.usage.cache_read_tokens && (verifiedUsage.cacheWriteTokens ?? 0) === result.usage.cache_creation_tokens;
          append({ event: 'response', id, accepted, text: result.text, finish_reason: result.stopReason, requested_model: result.model, reported_model: result.responseModel ?? null,
            provider_id: result.providerId, usage: result.usage, cost_usd: cost, bound_violation: boundViolated });
          if (!accepted) throw new Error('unaccounted or invalid provider completion');
          outcomes.push({ question_id: row.question_id, mode: row.mode, completed: result.stopReason === 'end', finish_reason: result.stopReason, cost_usd: cost });
        } catch (error) {
          append({ event: 'error', id, admitted, settled, cost_usd: cost, message: error instanceof Error ? error.name : 'unknown error' });
          throw error;
        }
      }
    }
    const summary = { schema: 1, n: plan.rows.length / 2, completed_pairs: new Set(outcomes.filter(r => r.completed && outcomes.some(other => other.question_id === r.question_id && other.mode !== r.mode && other.completed)).map(r => r.question_id)).size,
      accepted_responses: outcomes.length, physical_calls: physicalCalls, usage_priced_usd: spent, cap_usd: opts.maxUsd,
      modes: Object.fromEntries(['direct', 'notes'].map(mode => [mode, { natural_finishes: outcomes.filter(r => r.mode === mode && r.completed).length, cutoffs: outcomes.filter(r => r.mode === mode && r.finish_reason === 'length').length,
        cost_usd: outcomes.filter(r => r.mode === mode).reduce((n, r) => n + (r.cost_usd ?? 0), 0) }])),
      interpretation: 'Completion and usage comparison only; answer accuracy requires separate graded labels.' };
    append({ event: 'summary', ...summary });
    return summary;
  } catch (error) {
    append({ event: 'incomplete', planned_pairs: plan.rows.length / 2, accepted_responses: outcomes.length, physical_calls: physicalCalls, spent_usd: spent,
      failed_or_blocked_responses: plan.rows.length - outcomes.length, reason: error instanceof Error ? error.name : 'unknown error' });
    throw error;
  } finally { closeSync(fd); }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  if (args.length !== 11 || !args.includes('--execute') || !option('--input') || !option('--requests') || !option('--journal') || !option('--max-usd') || !option('--approval-id')) throw new Error('usage: bun eval/runner/reading-notes-run.ts --execute --input <same-private-frozen.json> --requests eval/reports/reading-notes/paired-requests.json --journal eval/reports/reading-notes/new-run.ndjson --max-usd <approved-positive-cap> --approval-id <authorization-reference>');
  const plan = JSON.parse(readFileSync(option('--requests')!, 'utf8')) as Plan;
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY required for explicit execution');
  configureGateway({ chat_model: MODEL, chat_fallback_chain: [], env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } });
  console.log(JSON.stringify(await runComparison(plan, { maxUsd: Number(option('--max-usd')), approvalId: option('--approval-id')!, journalPath: option('--journal')!, inputBytes: readFileSync(option('--input')!) })));
}

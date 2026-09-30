// Reranker-on arms (R1, R2) driver: identical to driver-a.ts plus a logged Voyage rerank transport.
// Arm (a) driver: runs gbrain's own `eval longmemeval` harness unmodified,
// injecting instrumented seams (reader client, judge client, embed transport)
// that log every paid call with usage, latency and full replayable payloads.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { embedMany } from 'ai';
import { runEvalLongMemEval } from 'GBRAIN_DIR/src/commands/eval-longmemeval.ts';
import { chat as gatewayChat } from 'GBRAIN_DIR/src/core/ai/gateway.ts';
import { normalizeModelId } from 'GBRAIN_DIR/src/core/model-id.ts';
import { __setRerankTransportForTests } from 'GBRAIN_DIR/src/core/ai/gateway.ts';
import type { ThinkLLMClient } from 'GBRAIN_DIR/src/core/think/index.ts';
import { configureGateway } from 'GBRAIN_DIR/src/core/ai/gateway.ts';
import { buildGatewayConfig } from 'GBRAIN_DIR/src/core/ai/build-gateway-config.ts';

// Same bootstrap as src/cli.ts for `eval longmemeval` when no ~/.gbrain/config.json exists.
configureGateway(buildGatewayConfig({ embedding_model: process.env.GBRAIN_EMBEDDING_MODEL, embedding_dimensions: Number(process.env.GBRAIN_EMBEDDING_DIMENSIONS) } as any));

const callsPath = process.env.M6_CALLS!;
if (!callsPath) throw new Error('M6_CALLS required');
mkdirSync(dirname(callsPath), { recursive: true });
const log = (rec: Record<string, unknown>) => appendFileSync(callsPath, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');

let lastReaderQuestion: string | null = null;

const readerClient: ThinkLLMClient = {
  create: async (params: any) => {
    const system = typeof params.system === 'string' ? params.system
      : Array.isArray(params.system) ? params.system.map((b: any) => ('text' in b ? b.text : '')).join('') : undefined;
    const messages = params.messages.map((m: any) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content
        : Array.isArray(m.content) ? m.content.map((b: any) => ('text' in b ? b.text : '')).join('') : '',
    }));
    const user = messages[messages.length - 1]?.content ?? '';
    const qm = /^Question:\n([\s\S]*?)\n\n(?:Current Date: ([^\n]*)\n\n)?/.exec(user);
    lastReaderQuestion = qm ? qm[1] : null;
    const t0 = performance.now();
    try {
      const result = await gatewayChat({ model: normalizeModelId(params.model), system, messages, maxTokens: params.max_tokens });
      const ms = performance.now() - t0;
      log({ lane: 'reader', question: qm?.[1], question_date: qm?.[2], model: params.model, response_model: result.responseModel ?? result.model,
        max_tokens: params.max_tokens, latency_ms: Math.round(ms), usage: result.usage, stop_reason: result.stopReason,
        system, user, output: result.text });
      return {
        id: '', type: 'message', role: 'assistant',
        model: result.responseModel ?? result.model,
        content: [{ type: 'text', text: result.text }],
        usage: { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens },
        stop_reason: result.stopReason === 'length' ? 'max_tokens' : result.stopReason === 'end' ? 'end_turn' : result.stopReason ?? null,
      } as any;
    } catch (err: any) {
      log({ lane: 'reader', question: qm?.[1], question_date: qm?.[2], model: params.model, latency_ms: Math.round(performance.now() - t0),
        provider_error: String(err?.message ?? err).slice(0, 500), system, user });
      throw err;
    }
  },
};

const judgeClient = async (opts: any) => {
  const t0 = performance.now();
  try {
    const r = await gatewayChat(opts);
    log({ lane: 'judge', reader_question: lastReaderQuestion, model: opts.model, response_model: r.responseModel ?? r.model,
      latency_ms: Math.round(performance.now() - t0), usage: r.usage, stop_reason: r.stopReason,
      temperature: opts.temperature, max_tokens: opts.maxTokens, prompt: opts.messages?.[0]?.content, output: r.text });
    return r;
  } catch (err: any) {
    log({ lane: 'judge', reader_question: lastReaderQuestion, model: opts.model, latency_ms: Math.round(performance.now() - t0),
      provider_error: String(err?.message ?? err).slice(0, 500), prompt: opts.messages?.[0]?.content });
    throw err;
  }
};

const embedTransport = (async (params: any) => {
  const t0 = performance.now();
  const r: any = await embedMany(params);
  const chars = (params.values as string[]).reduce((s, v) => s + v.length, 0);
  log({ lane: 'embed', n: params.values.length, chars, usage_tokens: r?.usage?.tokens ?? null, latency_ms: Math.round(performance.now() - t0) });
  return r;
}) as typeof embedMany;

__setRerankTransportForTests(async (url: string, init: RequestInit) => {
  const t0 = performance.now();
  let docs: number | null = null;
  try { docs = JSON.parse(String(init.body)).documents?.length ?? null; } catch { /* body not JSON */ }
  try {
    const resp = await fetch(url, init);
    const clone = resp.clone();
    let usage: unknown = null;
    try { usage = (await clone.json())?.usage ?? null; } catch { /* non-JSON body */ }
    log({ lane: 'rerank', reader_question_before: lastReaderQuestion, status: resp.status, docs, usage, latency_ms: Math.round(performance.now() - t0) });
    return resp;
  } catch (err: any) {
    log({ lane: 'rerank', reader_question_before: lastReaderQuestion, docs, transport_error: String(err?.name ?? '') + ': ' + String(err?.message ?? err).slice(0, 300), latency_ms: Math.round(performance.now() - t0) });
    throw err;
  }
});

await runEvalLongMemEval(process.argv.slice(2), { client: readerClient, judgeClient: judgeClient as any, embedTransport, exitOnError: false })
  .then(() => { process.stderr.write('[driver-r] exit 0\n'); process.exit(0); })
  .catch((e) => { process.stderr.write(`[driver-r] ${e?.message ?? e}\n`); process.exit(1); });

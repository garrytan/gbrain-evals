// Retrieval-only driver for the opaque-id recount (2026-10-04, item 1a). Runs gbrain's own
// `gbrain eval longmemeval` harness from the installed dependency (package.json pin) unmodified, and
// injects two logged transports so every paid call is accounted: the embedding transport (OpenAI usage
// tokens) and the Voyage rerank transport (usage tokens, HTTP status). Same seams as the 2026-09-29
// opaque-qa drivers (driver-a.ts, driver-r.ts); no reader or judge runs (--retrieval-only).
// Usage: CALLS=<calls.ndjson> bun driver-retrieval.ts <harness args...>
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { embedMany } from 'ai';
import { runEvalLongMemEval } from '../../../../node_modules/gbrain/src/commands/eval-longmemeval.ts';
import { configureGateway, __setRerankTransportForTests } from '../../../../node_modules/gbrain/src/core/ai/gateway.ts';
import { buildGatewayConfig } from '../../../../node_modules/gbrain/src/core/ai/build-gateway-config.ts';

configureGateway(buildGatewayConfig({ embedding_model: process.env.GBRAIN_EMBEDDING_MODEL, embedding_dimensions: Number(process.env.GBRAIN_EMBEDDING_DIMENSIONS) } as any));

const callsPath = process.env.CALLS;
if (!callsPath) throw new Error('CALLS required');
mkdirSync(dirname(callsPath), { recursive: true });
const log = (rec: Record<string, unknown>) => appendFileSync(callsPath, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');

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
    let usage: unknown = null;
    try { usage = (await resp.clone().json())?.usage ?? null; } catch { /* non-JSON body */ }
    log({ lane: 'rerank', status: resp.status, docs, usage, latency_ms: Math.round(performance.now() - t0) });
    return resp;
  } catch (err: any) {
    log({ lane: 'rerank', docs, transport_error: String(err?.name ?? '') + ': ' + String(err?.message ?? err).slice(0, 300), latency_ms: Math.round(performance.now() - t0) });
    throw err;
  }
});

await runEvalLongMemEval(process.argv.slice(2), { embedTransport, exitOnError: false })
  .then(() => { process.stderr.write('[driver-retrieval] exit 0\n'); process.exit(0); })
  .catch((e) => { process.stderr.write(`[driver-retrieval] ${e?.message ?? e}\n`); process.exit(1); });

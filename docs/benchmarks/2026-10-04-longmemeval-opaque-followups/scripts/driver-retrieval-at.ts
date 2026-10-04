// Post-hoc attribution driver: driver-retrieval.ts with the gbrain source tree taken from GBRAIN_SRC (a checkout of
// an older commit), so the published code can run on the opaque-id dataset copy. Logs every embedding call.
// Usage: GBRAIN_SRC=<checkout> CALLS=<calls.ndjson> bun driver-retrieval-at.ts <harness args...>
import { appendFileSync } from 'node:fs';
import { embedMany } from 'ai';
const SRC = process.env.GBRAIN_SRC!;
const { runEvalLongMemEval } = await import(`${SRC}/src/commands/eval-longmemeval.ts`);
const { configureGateway } = await import(`${SRC}/src/core/ai/gateway.ts`);
const { buildGatewayConfig } = await import(`${SRC}/src/core/ai/build-gateway-config.ts`);
configureGateway(buildGatewayConfig({ embedding_model: process.env.GBRAIN_EMBEDDING_MODEL, embedding_dimensions: Number(process.env.GBRAIN_EMBEDDING_DIMENSIONS) } as any));
const log = (rec: Record<string, unknown>) => appendFileSync(process.env.CALLS!, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');
const embedTransport = (async (params: any) => {
  const t0 = performance.now();
  const r: any = await embedMany(params);
  log({ lane: 'embed', n: params.values.length, chars: (params.values as string[]).reduce((s, v) => s + v.length, 0), usage_tokens: r?.usage?.tokens ?? null, latency_ms: Math.round(performance.now() - t0) });
  return r;
}) as typeof embedMany;
await runEvalLongMemEval(process.argv.slice(2), { embedTransport, exitOnError: false })
  .then(() => { process.stderr.write('[driver-retrieval-at] exit 0\n'); process.exit(0); })
  .catch((e: any) => { process.stderr.write(`[driver-retrieval-at] ${e?.message ?? e}\n`); process.exit(1); });

#!/usr/bin/env bun
/**
 * A15 shadow probe (scratch, not shipped): replays dev page queries against one
 * brain (GBRAIN_HOME, a scratch copy of a dev store unit) under in-memory
 * config overlays, and prints one JSON line per item.
 *
 *   GBRAIN_HOME=<copy> bun scripts/a15-probe.ts --items <items.jsonl> --overlay '<json>'
 *
 * Arms (overlay = the cell's search_config plus):
 *   shadow   search.reranker.gate=shadow (reranked delivery + the gate's grade)
 *   shadow2  the same again (noise baseline, A22)
 *   on       search.reranker.gate=on (a would-skip grade delivers fused order)
 *   fused    search.reranker.enabled=false (fused rank-1 for every question)
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildGatewayConfig } from '../src/core/ai/build-gateway-config.ts';
import { configureGateway } from '../src/core/ai/gateway.ts';
import { loadConfig, loadConfigWithEngine, toEngineConfig } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import { type OperationContext, operationsByName } from '../src/core/operations.ts';
import { countEvidenceTokens } from '../src/core/search/evidence-delivery.ts';
import { withSearchConfig } from '../src/eval/rerank-gate-latency.ts';

const flag = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const items = readFileSync(flag('--items')!, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const overlay: Record<string, string> = JSON.parse(flag('--overlay') ?? '{}');

const fileConfig = loadConfig()!;
const engineConfig = toEngineConfig(fileConfig);
const engine = await createEngine(engineConfig);
await engine.connect(engineConfig);
const merged = (await loadConfigWithEngine(engine, fileConfig)) ?? fileConfig;
configureGateway(buildGatewayConfig(merged));
const base = { engine, config: merged, logger: { info() {}, warn() {}, error() {}, debug() {} }, dryRun: false, remote: false, sourceId: 'default' } as unknown as OperationContext;

const arms: Record<string, Record<string, string>> = {
  shadow: { ...overlay, 'search.reranker.gate': 'shadow' },
  shadow2: { ...overlay, 'search.reranker.gate': 'shadow' },
  on: { ...overlay, 'search.reranker.gate': 'on' },
  fused: { ...overlay, 'search.reranker.gate': 'off', 'search.reranker.enabled': 'false' },
};

async function run(arm: string, query: Record<string, unknown>) {
  const metas: any[] = [];
  const ctx = { ...base, engine: withSearchConfig(engine, arms[arm]!), emitResponseMeta: (kind: string, m: unknown) => { if (kind === 'retrieval') metas.push(m); } } as OperationContext;
  const t0 = performance.now();
  const rows = (await operationsByName.query!.handler(ctx, query)) as any[];
  const ms = performance.now() - t0;
  const meta = metas[metas.length - 1] ?? {};
  const blocks = (Array.isArray(rows) ? rows : []).map((r) => {
    const text = String(r.chunk_text ?? r.text ?? '');
    const page = r.result_type === 'fact' ? `fact:${r.fact_id ?? r.slug}` : `${r.source_id ?? 'default'}:${r.slug}`;
    return { page, key: `${page}#${createHash('sha1').update(text).digest('hex').slice(0, 12)}`, tokens: countEvidenceTokens(text, 'cl100k') };
  });
  return { ms: Math.round(ms), gate: meta.rerank_gate ?? null, degraded: meta.degraded ?? [], tokens_delivered: meta.delivery?.tokens_delivered ?? null, blocks };
}

for (const item of items) {
  const out: Record<string, unknown> = { id: item.id, kind: item.kind, dataset: item.dataset, unit: item.unit };
  try {
    for (const arm of Object.keys(arms)) out[arm] = await run(arm, item.query);
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  }
  console.log(JSON.stringify(out));
}
await engine.disconnect().catch(() => {});
process.exit(0);

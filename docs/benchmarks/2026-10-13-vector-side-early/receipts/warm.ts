const root = process.cwd();
const { loadConfig, toEngineConfig } = await import(`${root}/src/core/config.ts`);
const { configureGateway } = await import(`${root}/src/core/ai/gateway.ts`);
const { buildGatewayConfig } = await import(`${root}/src/core/ai/build-gateway-config.ts`);
const { createEngine } = await import(`${root}/src/core/engine-factory.ts`);
const { operations } = await import(`${root}/src/core/operations.ts`);
const config = loadConfig();
configureGateway(buildGatewayConfig(config));
if (process.env.STUB) {
  const gw = await import(`${root}/src/core/ai/gateway.ts`);
  const { stubVector } = await import(`${root}/scripts/bench-refactor-wave-1.ts`);
  gw.configureGateway({ embedding_model: 'voyage:voyage-4', embedding_dimensions: 1024, env: { VOYAGE_API_KEY: 'stub-not-a-key' } });
  gw.__setEmbedTransportForTests((async (input: { values: string[] }) => ({ embeddings: input.values.map((t: string) => stubVector(t, 1024)) })) as never);
  gw.__setRerankTransportForTests(async (_u: string, init: RequestInit) => {
    const documents = (JSON.parse(String(init.body)) as { documents?: unknown[] }).documents ?? [];
    return new Response(JSON.stringify({ results: documents.map((_, index) => ({ index, relevance_score: 1 - index / (documents.length + 1) })) }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  globalThis.fetch = (async (i: unknown) => { throw new Error(`network disabled (${String(i)})`); }) as never;
}
const engine = await createEngine(toEngineConfig(config));
await engine.connect(toEngineConfig(config));
const queries = (await Bun.file(process.env.QFILE!).text()).trim().split('\n');
const reps = Number(process.env.REPS ?? 3);
const ops = (process.env.OPS ?? 'search,query').split(',');
const out: any[] = [];
for (const w of ['warm up one', 'warm up two', 'warm up three']) for (const name of ops) await operations.find((o: any) => o.name === name)!.handler({ engine, config, logger: console, dryRun: false, remote: false, sourceId: 'default', emitResponseMeta: () => {} } as never, { query: `${w} ${name}` });
for (const name of ops) for (const q0 of queries) for (let r = 1; r <= reps; r++) {
  const q = name === 'query' ? `${q0}?` : q0;
  let meta: any = null;
  const ctx = { engine, config, logger: console, dryRun: false, remote: false, sourceId: 'default',
    emitResponseMeta: (k: string, v: unknown) => { if (k === 'retrieval') meta = v; } } as never;
  const rows = await operations.find((o: any) => o.name === name)!.handler(ctx, { query: q }) as any[];
  if (r > 0) out.push({ op: name, q, rep: r, n: rows.length, t: meta?.timings, deg: meta?.degraded, ids: rows.map((x: any) => `${x.slug}#${x.chunk_index ?? ''}`) });
}
await engine.disconnect();
console.log(JSON.stringify(out));

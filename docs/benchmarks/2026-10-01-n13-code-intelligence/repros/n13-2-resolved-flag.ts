// N13-2: code_callers reports resolved: false on an edge the within-file resolver resolved (edge_metadata.resolved_chunk_id is set).
// Expected: resolved true for the caller -> helper edge after resolution. Exit 1 while the bug reproduces.
const G = new URL("../../../../node_modules/gbrain/src", import.meta.url).pathname;
const { PGLiteEngine } = await import(`${G}/core/pglite-engine.ts`);
const { importCodeFile } = await import(`${G}/core/import-file.ts`);
const { resolveSymbolEdgesIncremental } = await import(`${G}/core/chunkers/symbol-resolver.ts`);
const { handleToolCall } = await import(`${G}/mcp/server.ts`);
const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
await importCodeFile(engine, "src/sample.ts", "export function helper(): number {\n  return 1;\n}\n\nexport function caller(): number {\n  return helper() + 1;\n}\n", { noEmbed: true });
const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: "default" });
const r: any = await handleToolCall(engine, "code_callers", { symbol: "helper" });
console.log(JSON.stringify({ resolver: { edges_resolved: stats.edges_resolved }, callers: r.callers.map((e: any) => ({ from: e.from_symbol_qualified, resolved: e.resolved, resolved_chunk_id: e.edge_metadata?.resolved_chunk_id ?? null })) }));
await engine.disconnect();
process.exit(r.callers.some((e: any) => e.edge_metadata?.resolved_chunk_id != null && !e.resolved) ? 1 : 0);

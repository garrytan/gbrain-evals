// N13-3: code_blast refuses a Python function as unsupported_language when a Go function shares its bare name.
// Expected: result "ok" (or "ambiguous"), never unsupported_language for a symbol defined in Python. Exit 1 while the bug reproduces.
const G = new URL("../../../../node_modules/gbrain/src", import.meta.url).pathname;
const { PGLiteEngine } = await import(`${G}/core/pglite-engine.ts`);
const { importCodeFile } = await import(`${G}/core/import-file.ts`);
const { resolveSymbolEdgesIncremental } = await import(`${G}/core/chunkers/symbol-resolver.ts`);
const { handleToolCall } = await import(`${G}/mcp/server.ts`);
const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
await importCodeFile(engine, "gate/shared.go", "package main\n\nfunc shared_helper() int {\n\treturn 2\n}\n\nfunc go_user() int {\n\treturn shared_helper()\n}\n", { noEmbed: true });
await importCodeFile(engine, "gate/shared.py", "def shared_helper():\n    return 2\n\n\ndef py_user():\n    return shared_helper()\n", { noEmbed: true });
await resolveSymbolEdgesIncremental(engine, { sourceId: "default" });
const r: any = await handleToolCall(engine, "code_blast", { symbol: "shared_helper" });
console.log(JSON.stringify({ code_blast: r.result, supported: r.supported ?? null }));
await engine.disconnect();
process.exit(r.result === "unsupported_language" ? 1 : 0);

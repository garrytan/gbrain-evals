const G = new URL("../../../../node_modules/gbrain/src/core", import.meta.url).pathname;
const { codeIntelOperations } = await import(`${G}/ops/code-intel.ts`);
for (const op of codeIntelOperations) {
  if (op.name === "code_traversal_cache_clear") { console.log(op.name, "localOnly=", !!op.localOnly, "scope=", op.scope); continue; }
  try { await op.handler({ remote: true, sourceId: "default", engine: {} } as any, { symbol: "parseMarkdown" }); console.log(op.name, "remote=true -> returned"); }
  catch (e: any) { console.log(op.name, "remote=true ->", e.code, "|", e.message); }
}

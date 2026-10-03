// N13-8: a member call through an untyped receiver (segments.join("/")) resolves to a same-file top-level function named join.
// Expected: the direct call join() resolves; the member call does not. Exit 1 while the member call resolves.
const G = new URL("../../../../node_modules/gbrain/src", import.meta.url).pathname;
const { PGLiteEngine } = await import(`${G}/core/pglite-engine.ts`);
const { importCodeFile } = await import(`${G}/core/import-file.ts`);
const { resolveSymbolEdgesIncremental } = await import(`${G}/core/chunkers/symbol-resolver.ts`);
const { handleToolCall } = await import(`${G}/mcp/server.ts`);
const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
const source = [
  "export function join(...parts: string[]): string {",
  "  return parts.filter(Boolean).join(\"/\");",
  "}",
  "",
  "export function dirname(p: string): string {",
  "  const segments = p.split(\"/\").slice(0, -1);",
  "  return segments.join(\"/\");",
  "}",
  "",
  "export function resolveAll(a: string, b: string): string {",
  "  return join(a, b);",
  "}",
  "",
].join("\n");
await importCodeFile(engine, "src/path.ts", source, { noEmbed: true });
await resolveSymbolEdgesIncremental(engine, { sourceId: "default" });
const r: any = await handleToolCall(engine, "code_callers", { symbol: "join" });
const callers = r.callers.map((e: any) => ({ from: e.from_symbol_qualified, resolved: e.resolved, member_call: e.edge_metadata?.member_call ?? null }));
console.log(JSON.stringify({ callers }));
await engine.disconnect();
const resolvedFrom = (name: string) => callers.some((c: any) => String(c.from).endsWith(name) && c.resolved);
process.exit(resolvedFrom("dirname") || !resolvedFrom("resolveAll") ? 1 : 0);

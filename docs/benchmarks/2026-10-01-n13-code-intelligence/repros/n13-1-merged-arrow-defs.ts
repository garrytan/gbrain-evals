// N13-1: short `const name = (...) => ...` function definitions are folded into anonymous merged chunks, so code_def cannot find them.
// Expected: code_def returns sample.ts:3 for int2alpha. Exit 1 while the bug reproduces.
const G = new URL("../../../../node_modules/gbrain/src", import.meta.url).pathname;
const { PGLiteEngine } = await import(`${G}/core/pglite-engine.ts`);
const { importCodeFile } = await import(`${G}/core/import-file.ts`);
const { handleToolCall } = await import(`${G}/mcp/server.ts`);
const src = [
  'const ALPHABET = "abcdefghijklmnopqrstuvwxyz";', '',
  'const int2alpha = (int: number): string => {', '  let alpha = "";', '  while (int > 0) {', '    alpha = ALPHABET[(int - 1) % 26] + alpha;', '    int = Math.floor((int - 1) / 26);', '  }', '  return alpha;', '};', '',
  'const alpha2int = (str: string): number => {', '  let int = 0;', '  for (const char of str) int = int * 26 + ALPHABET.indexOf(char) + 1;', '  return int;', '};', '',
  'export function roundTrip(n: number): number {', '  return alpha2int(int2alpha(n));', '}', '',
].join("\n");
const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
await importCodeFile(engine, "src/sample.ts", src, { noEmbed: true });
const r: any = await handleToolCall(engine, "code_def", { symbol: "int2alpha" });
const chunks = await engine.executeRaw("SELECT symbol_name, symbol_type, start_line, end_line FROM content_chunks ORDER BY start_line");
console.log(JSON.stringify({ code_def_count: r.count, defs: r.defs.map((d: any) => `${d.file}:${d.start_line}`), chunks }));
await engine.disconnect();
process.exit(r.count > 0 ? 0 : 1);

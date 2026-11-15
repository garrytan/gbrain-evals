/**
 * A neutral MCP tool adapter for the Cat 40 loop: any MCP server's own tools, offered to the model by the server's own
 * names, descriptions and input schemas, through the same `Arm` interface the file agent's tools use. Nothing here
 * knows which server it adapts; a system passes something that lists and calls tools the way an MCP client does
 * (`tools/list`, `tools/call`), over a transport or in process.
 *
 *   allowed  the arm offers only the named tools, refuses to build when the server lists none of a name, and refuses a
 *            call to any other name before it reaches the server.
 *   results  the text blocks of a tool result, joined by a newline. A result the server marks `isError` is thrown, so
 *            the loop records the call as failed and the model reads it as `Error: <text>`, as the Cat 40 MCP client
 *            returns it (cat40/gbrain-arm.ts).
 *   writes   none: the arm is read-only by construction, so `writeTools()` is empty.
 */
import type { Arm, ToolSpec } from '../cat40/loop.ts';

/** One tool as an MCP server lists it (`tools/list`). */
export interface McpTool { name: string; description?: string; inputSchema: Record<string, unknown> }

/** One tool result as an MCP server returns it (`tools/call`). */
export interface McpToolResult { content: Array<{ type: string; text?: string }>; isError?: boolean }

export interface McpToolServer {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
}

/** The text blocks of a tool result, joined by a newline, in the order the server returned them. */
export const toolText = (r: McpToolResult) => r.content.flatMap(c => (c.type === 'text' && typeof c.text === 'string' ? [c.text] : [])).join('\n');

/** An arm offering `allowed` of the server's tools, as the server lists them, in the order given. */
export async function mcpToolArm(name: string, server: McpToolServer, allowed: readonly string[]): Promise<Arm> {
  const listed = new Map((await server.listTools()).map(t => [t.name, t]));
  const missing = allowed.filter(n => !listed.has(n));
  if (missing.length) throw new Error(`the MCP server lists no ${missing.join(', ')} tool; it lists ${[...listed.keys()].sort().join(', ') || 'no tools'}`);
  const specs: ToolSpec[] = allowed.map(n => {
    const t = listed.get(n)!;
    return { name: t.name, description: t.description ?? '', input_schema: t.inputSchema };
  });
  const names = new Set(allowed);
  return {
    name,
    systemHint: () => '',
    tools: () => specs,
    writeTools: () => [],
    async call(tool, args) {
      if (!names.has(tool)) throw new Error(`unknown tool ${tool}; this agent's tools are ${allowed.join(', ')}`);
      const r = await server.callTool(tool, args);
      const text = toolText(r);
      if (r.isError) throw new Error(text);
      return text;
    },
  };
}

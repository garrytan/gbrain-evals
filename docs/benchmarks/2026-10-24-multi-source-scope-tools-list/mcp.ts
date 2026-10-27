// Minimal MCP clients for the GBRA-156 scope + starter tools/list A/B: Streamable HTTP with a
// bearer token (remote=true scoping on a real gbrain serve --http) and stdio (gbrain serve).
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface McpTool { name: string; description?: string; inputSchema: Record<string, unknown> }
export interface McpResult { isError: boolean; text: string; raw: unknown }

export interface McpClient {
  listTools(): Promise<{ tools: McpTool[]; bytes: number }>;
  call(name: string, args: Record<string, unknown>): Promise<McpResult>;
  close(): Promise<void>;
}

function toResult(rpc: any): McpResult {
  if (rpc.error) return { isError: true, text: JSON.stringify(rpc.error), raw: rpc };
  const r = rpc.result ?? {};
  const text = (r.content ?? []).map((c: { type: string; text?: string }) => c.text ?? '').join('\n');
  return { isError: r.isError === true, text, raw: rpc };
}

export class HttpMcp implements McpClient {
  private id = 0;
  constructor(private base: string, private token: string) {}
  private async rpc(method: string, params: unknown): Promise<{ rpc: any; bytes: number }> {
    const res = await fetch(this.base + '/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
    });
    const body = (await res.text()).trim();
    if (res.status !== 200) return { rpc: { error: { code: res.status, message: body.slice(0, 2000) } }, bytes: body.length };
    const json = body.startsWith('{') ? body : body.split('\n').filter(l => l.startsWith('data:')).pop()!.slice(5).trim();
    return { rpc: JSON.parse(json), bytes: Buffer.byteLength(json) };
  }
  async listTools() {
    const { rpc, bytes } = await this.rpc('tools/list', {});
    if (rpc.error) throw new Error('tools/list failed: ' + JSON.stringify(rpc.error));
    return { tools: rpc.result.tools as McpTool[], bytes };
  }
  async call(name: string, args: Record<string, unknown>) {
    return toResult((await this.rpc('tools/call', { name, arguments: args })).rpc);
  }
  async close() {}
}

export class StdioMcp implements McpClient {
  private id = 0;
  private pending = new Map<number, { resolve: (v: { rpc: any; bytes: number }) => void }>();
  private proc: ChildProcess;
  private ready: Promise<void>;
  constructor(cli: string, env: Record<string, string>) {
    this.proc = spawn('bun', ['run', cli, 'serve'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stderr!.on('data', () => {});
    createInterface({ input: this.proc.stdout! }).on('line', line => {
      if (!line.startsWith('{')) return;
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
      if (p) { this.pending.delete(msg.id); p.resolve({ rpc: msg, bytes: Buffer.byteLength(line) }); }
    });
    this.ready = (async () => {
      await this.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gbra156-ab', version: '1' } });
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    })();
  }
  private send(method: string, params: unknown): Promise<{ rpc: any; bytes: number }> {
    const id = ++this.id;
    return new Promise(resolve => {
      this.pending.set(id, { resolve });
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async listTools() {
    await this.ready;
    const { rpc, bytes } = await this.send('tools/list', {});
    if (rpc.error) throw new Error('tools/list failed: ' + JSON.stringify(rpc.error));
    return { tools: rpc.result.tools as McpTool[], bytes };
  }
  async call(name: string, args: Record<string, unknown>) {
    await this.ready;
    return toResult((await this.send('tools/call', { name, arguments: args })).rpc);
  }
  async close() { this.proc.kill('SIGTERM'); }
}

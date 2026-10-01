/**
 * Ways the lifecycle experiment talks to a gbrain build.
 *
 * - `CliDriver`: `gbrain call <op> <json>`, a trusted local caller
 *   (`remote = false`). Every call is a new process.
 * - `McpStdioDriver`: `gbrain serve` over stdio, an untrusted agent-facing
 *   caller (`remote = true`). One long-lived process until `restart()`.
 * - `McpHttpDriver`: `gbrain serve --http` with a legacy bearer token, also
 *   `remote = true`.
 * - `Operator`: host-side maintenance (`init`, `sources`, `sync`, `extract`,
 *   `embed`) that a person or scheduler runs on the machine holding the vault.
 *
 * All processes run the build's `src/cli.ts` by absolute path.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';

export interface CallResult {
  ok: boolean;
  data: unknown;
  error?: string;
  raw: string;
  ms: number;
  /** The MCP result's `_meta` (for example brain_hot_memory), when the server sent one. */
  meta?: unknown;
}

export interface Driver {
  readonly kind: 'cli' | 'mcp-stdio' | 'mcp-http';
  readonly remote: boolean;
  start(): Promise<void>;
  call(op: string, args: Record<string, unknown>): Promise<CallResult>;
  restart(): Promise<void>;
  close(): Promise<void>;
  /** Number of server processes started so far (1 per session). */
  sessions(): number;
}

export interface RunEnv {
  buildDir: string;
  env: NodeJS.ProcessEnv;
  /** Arguments to `bun` before the subcommand; defaults to the build's src/cli.ts. */
  entry?: string[];
}

const entryArgs = (run: RunEnv) => run.entry ?? [join(run.buildDir, 'src/cli.ts')];

function parseMaybeJson(text: string): unknown {
  const t = text.trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* fall through */ }
  const start = t.search(/[[{]/);
  if (start >= 0) { try { return JSON.parse(t.slice(start)); } catch { /* ignore */ } }
  return t;
}

function errorOf(data: unknown): string | undefined {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    if (typeof d.error === 'string') return `${d.error}${d.message ? `: ${d.message}` : ''}`;
    if (d.error && typeof d.error === 'object') return JSON.stringify(d.error);
  }
  return undefined;
}

/**
 * Run the build's CLI without blocking the event loop. The hermetic embedder
 * lives in this process, so a synchronous spawn would deadlock it.
 */
export function runCli(run: RunEnv, args: string[], timeoutMs = 300_000): Promise<{ code: number; stdout: string; stderr: string; ms: number }> {
  const t0 = Date.now();
  return new Promise(resolve => {
    const proc = spawn('bun', [...entryArgs(run), ...args], { env: run.env, cwd: run.env.GBRAIN_HOME });
    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (c: string) => { stdout += c; });
    proc.stderr.on('data', (c: string) => { stderr += c; });
    proc.stdin.end();
    const timer = setTimeout(() => { stderr += `\n[lifecycle] killed after ${timeoutMs}ms`; proc.kill('SIGKILL'); }, timeoutMs);
    proc.on('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr, ms: Date.now() - t0 }); });
    proc.on('error', e => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: `${stderr}\n${e.message}`, ms: Date.now() - t0 }); });
  });
}

export class CliDriver implements Driver {
  readonly kind = 'cli' as const;
  readonly remote = false;
  constructor(private run: RunEnv) {}
  async start() {}
  async call(op: string, args: Record<string, unknown>): Promise<CallResult> {
    const r = await runCli(this.run, ['call', op, JSON.stringify(args)], 180_000);
    const data = parseMaybeJson(r.stdout);
    const err = errorOf(data) ?? (r.code !== 0 ? `exit ${r.code}: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}` : undefined);
    return { ok: !err, data, error: err, raw: r.stdout + (err ? `\n[stderr] ${r.stderr}` : ''), ms: r.ms };
  }
  async restart() {}
  async close() {}
  sessions() { return 0; }
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

function toolResult(msg: Record<string, unknown>): { data: unknown; error?: string; raw: string; meta?: unknown } {
  if (msg.error) return { data: msg.error, error: `rpc: ${JSON.stringify(msg.error)}`, raw: JSON.stringify(msg.error) };
  const result = msg.result as { content?: Array<{ type: string; text?: string }>; isError?: boolean; _meta?: unknown } | undefined;
  const texts = (result?.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '');
  const text = texts.join('\n');
  // A server may append a notice as a second text block; the payload is the first block that parses.
  const parsed = texts.map(t => parseMaybeJson(t));
  const data = parsed.find(d => d !== null && typeof d === 'object') ?? parseMaybeJson(text);
  const err = result?.isError ? (errorOf(data) ?? (typeof data === 'string' ? data : 'tool error')) : errorOf(data);
  return { data, error: err, raw: text, ...(result?._meta !== undefined ? { meta: result._meta } : {}) };
}

export class McpStdioDriver implements Driver {
  readonly kind = 'mcp-stdio' as const;
  readonly remote = true;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private started = 0;
  serverVersion = '';
  stderrTail: string[] = [];
  constructor(private run: RunEnv) {}

  private send(msg: Record<string, unknown>) {
    this.proc!.stdin.write(JSON.stringify(msg) + '\n');
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = 180_000): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout waiting for ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async start() {
    const proc = spawn('bun', [...entryArgs(this.run), 'serve'], { env: this.run.env, cwd: this.run.env.GBRAIN_HOME });
    this.proc = proc;
    this.started++;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(line); } catch { continue; }
        const id = typeof msg.id === 'number' ? msg.id : null;
        if (id !== null && this.pending.has(id)) {
          const p = this.pending.get(id)!;
          clearTimeout(p.timer);
          this.pending.delete(id);
          p.resolve(msg);
        }
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      this.stderrTail.push(...chunk.split('\n').filter(Boolean));
      if (this.stderrTail.length > 200) this.stderrTail.splice(0, this.stderrTail.length - 200);
    });
    proc.on('exit', () => {
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('mcp server exited')); }
      this.pending.clear();
    });
    const init = await this.request('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gbrain-evals-lifecycle', version: '1' },
    }, 120_000);
    this.serverVersion = String(((init.result as Record<string, unknown>)?.serverInfo as Record<string, unknown>)?.version ?? '');
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async call(op: string, args: Record<string, unknown>): Promise<CallResult> {
    const t0 = Date.now();
    try {
      const msg = await this.request('tools/call', { name: op, arguments: args });
      const r = toolResult(msg);
      return { ok: !r.error, data: r.data, error: r.error, raw: r.raw, ms: Date.now() - t0, ...(r.meta !== undefined ? { meta: r.meta } : {}) };
    } catch (e) {
      return { ok: false, data: null, error: (e as Error).message, raw: '', ms: Date.now() - t0 };
    }
  }

  async close() {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    await new Promise<void>(resolve => {
      const t = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 15_000);
      proc.once('exit', () => { clearTimeout(t); resolve(); });
      proc.stdin.end();
    });
  }

  async restart() { await this.close(); await this.start(); }
  sessions() { return this.started; }
}

/**
 * One OAuth client's session against a running `gbrain serve --http`: a
 * client_credentials token and an MCP session. McpHttpDriver uses one for
 * its own client; a category can open more against the same server to act
 * as a differently scoped caller (a read-only or foreign-source client).
 */
export class McpHttpClient {
  private sessionId: string | null = null;
  private nextId = 1;
  private token = '';
  serverVersion = '';
  constructor(private port: number, private client: { id: string; secret: string; scope?: string }) {}

  private async fetchToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials', client_id: this.client.id, client_secret: this.client.secret,
      scope: this.client.scope ?? 'read write', resource: `http://localhost:${this.port}/mcp`,
    });
    const res = await fetch(`http://127.0.0.1:${this.port}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text); } catch { /* reported below */ }
    if (!res.ok || typeof json.access_token !== 'string') throw new Error(`token endpoint HTTP ${res.status}: ${text.slice(0, 300)}`);
    return json.access_token;
  }

  private async post(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${this.token}`,
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const res = await fetch(`http://127.0.0.1:${this.port}/mcp`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const text = await res.text();
    if (!('id' in body)) return null;
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const datas = text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
      for (const d of datas) {
        try { const m = JSON.parse(d); if (m.id === body.id) return m; } catch { /* ignore */ }
      }
      return { error: { message: `no response in event stream (HTTP ${res.status})`, body: text.slice(0, 500) } };
    }
    try { return JSON.parse(text); } catch { return { error: { message: `HTTP ${res.status}`, body: text.slice(0, 500) } }; }
  }

  /** Fetch a token and open an MCP session. Throws with the server's reply when either fails. */
  async initialize(): Promise<void> {
    this.sessionId = null;
    this.token = await this.fetchToken();
    const init = await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gbrain-evals-lifecycle', version: '1' },
    } });
    if (!init || !init.result) throw new Error(JSON.stringify(init).slice(0, 300));
    this.serverVersion = String(((init.result as Record<string, unknown>).serverInfo as Record<string, unknown>)?.version ?? '');
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async call(op: string, args: Record<string, unknown>): Promise<CallResult> {
    const t0 = Date.now();
    try {
      const msg = await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name: op, arguments: args } });
      const r = toolResult(msg ?? {});
      return { ok: !r.error, data: r.data, error: r.error, raw: r.raw, ms: Date.now() - t0, ...(r.meta !== undefined ? { meta: r.meta } : {}) };
    } catch (e) {
      return { ok: false, data: null, error: (e as Error).message, raw: '', ms: Date.now() - t0 };
    }
  }
}

/**
 * MCP over HTTP (streamable HTTP transport). Authenticates as an OAuth
 * client_credentials client registered for the vault source, fetching a new
 * access token for every session. Responses may arrive as JSON or as a
 * server-sent-events stream.
 */
export class McpHttpDriver implements Driver {
  readonly kind = 'mcp-http' as const;
  readonly remote = true;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private started = 0;
  private session: McpHttpClient | null = null;
  serverVersion = '';
  stderrTail: string[] = [];
  constructor(private run: RunEnv, readonly port: number, private client: { id: string; secret: string }) {}

  async start() {
    const proc = spawn('bun', [...entryArgs(this.run), 'serve', '--http', '--port', String(this.port)], { env: this.run.env, cwd: this.run.env.GBRAIN_HOME });
    this.proc = proc;
    this.started++;
    proc.stderr.setEncoding('utf8');
    proc.stdout.setEncoding('utf8');
    const tail = (chunk: string) => {
      this.stderrTail.push(...chunk.split('\n').filter(Boolean));
      if (this.stderrTail.length > 200) this.stderrTail.splice(0, this.stderrTail.length - 200);
    };
    proc.stderr.on('data', tail);
    proc.stdout.on('data', tail);
    const deadline = Date.now() + 120_000;
    let lastErr = '';
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      if (proc.exitCode !== null) throw new Error(`serve --http exited: ${this.stderrTail.slice(-5).join(' | ')}`);
      try {
        const session = new McpHttpClient(this.port, this.client);
        await session.initialize();
        this.session = session;
        this.serverVersion = session.serverVersion;
        return;
      } catch (e) { lastErr = (e as Error).message; }
    }
    throw new Error(`serve --http did not initialize: ${lastErr}`);
  }

  async call(op: string, args: Record<string, unknown>): Promise<CallResult> {
    if (!this.session) return { ok: false, data: null, error: 'serve --http is not running', raw: '', ms: 0 };
    return this.session.call(op, args);
  }

  async close() {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    this.session = null;
    await new Promise<void>(resolve => {
      const t = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 15_000);
      proc.once('exit', () => { clearTimeout(t); resolve(); });
      proc.kill('SIGTERM');
    });
  }

  async restart() { await this.close(); await this.start(); }
  sessions() { return this.started; }
}

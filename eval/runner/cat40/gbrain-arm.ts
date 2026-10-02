/**
 * Cat 40 `gbrain` arm: the agent talks to gbrain's own MCP server.
 *
 * Each slot is a separate brain (PGLite) built from the same corpus with the
 * build under test, run as `gbrain serve --surface starter` over stdio, the
 * way a harness connects. The agent sees the server's tool list and its
 * initialize instructions, nothing else. Calls are untrusted remote calls
 * (`remote = true`), so `visibility: private` pages are hidden from the agent.
 *
 * gbrain's own provider calls (query expansion, reranking, embeddings) go
 * through a local proxy that forwards them via the paid-request guard and
 * attributes their cost to the run holding the slot. A run that writes leaves
 * its slot to be restored from the post-build snapshot before the next run.
 */
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Arm, ToolSpec } from './loop.ts';
import type { LadderWorld } from '../../generators/model-ladder-gen.ts';
import { renderDoc } from '../../generators/model-ladder-gen.ts';
import { runCli, type RunEnv } from '../lifecycle/drivers.ts';
import { priceRequest, usageCost } from '../budget-ledger.ts';

export const GBRAIN_EMBED_MODEL = 'openai:text-embedding-3-large';

// ─── Metering proxy ─────────────────────────────────────────────────

const UPSTREAM: Record<string, string> = { anthropic: 'https://api.anthropic.com', openai: 'https://api.openai.com', voyage: 'https://api.voyageai.com' };

export interface Meter { usd: number; requests: number; unpriced: number; byModel: Record<string, { usd: number; requests: number }> }
export const newMeter = (): Meter => ({ usd: 0, requests: 0, unpriced: 0, byModel: {} });

export class MeteringProxy {
  private server: ReturnType<typeof Bun.serve> | null = null;
  readonly meters = new Map<string, Meter>();
  get port(): number { return this.server!.port as number; }
  start() {
    this.server = Bun.serve({
      port: 0, hostname: '127.0.0.1', idleTimeout: 255,
      fetch: async req => {
        const url = new URL(req.url);
        const m = url.pathname.match(/^\/([^/]+)\/(anthropic|openai|voyage)(\/.*)$/);
        if (!m) return new Response('not found', { status: 404 });
        const [, slot, prov, rest] = m;
        const target = `${UPSTREAM[prov]}${rest}${url.search}`;
        const headers = new Headers(req.headers);
        for (const h of ['host', 'content-length', 'accept-encoding', 'connection']) headers.delete(h);
        const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text();
        let res: Response;
        try { res = await fetch(target, { method: req.method, headers, body }); }
        catch (e) { return new Response(JSON.stringify({ error: { message: `cat40 proxy: ${(e as Error).message}` } }), { status: 502, headers: { 'content-type': 'application/json' } }); }
        const text = await res.text();
        const meter = this.meters.get(slot) ?? newMeter();
        this.meters.set(slot, meter);
        meter.requests++;
        try {
          const parsedBody = body ? JSON.parse(body) : undefined;
          const price = priceRequest(target, parsedBody);
          const cost = price ? usageCost(price, JSON.parse(text)) : null;
          if (cost) {
            meter.usd += cost.usd;
            const k = `${prov}:${price!.model}`;
            meter.byModel[k] ??= { usd: 0, requests: 0 };
            meter.byModel[k].usd += cost.usd; meter.byModel[k].requests++;
          } else meter.unpriced++;
        } catch { meter.unpriced++; }
        const out = new Headers(res.headers);
        for (const h of ['content-encoding', 'content-length', 'transfer-encoding']) out.delete(h);
        return new Response(text, { status: res.status, headers: out });
      },
    });
  }
  take(slot: string): Meter { const m = this.meters.get(slot) ?? newMeter(); this.meters.set(slot, newMeter()); return m; }
  stop() { this.server?.stop(true); }
}

// ─── Minimal MCP stdio client ───────────────────────────────────────

export class McpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private id = 1;
  private pending = new Map<number, (m: Record<string, unknown>) => void>();
  instructions = '';
  serverVersion = '';
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> }> = [];
  stderr: string[] = [];
  constructor(private run: RunEnv, private args: string[]) {}
  private request(method: string, params: Record<string, unknown>, timeoutMs = 300_000): Promise<Record<string, unknown>> {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, m => { clearTimeout(t); resolve(m); });
      this.proc!.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async start() {
    const proc = spawn('bun', [join(this.run.buildDir, 'src/cli.ts'), 'serve', ...this.args], { env: this.run.env, cwd: this.run.env.GBRAIN_HOME });
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (c: string) => {
      this.buf += c;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        try { const m = JSON.parse(line); const cb = this.pending.get(m.id); if (cb) { this.pending.delete(m.id); cb(m); } } catch { /* not JSON-RPC */ }
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (c: string) => { this.stderr.push(...c.split('\n').filter(Boolean)); if (this.stderr.length > 300) this.stderr.splice(0, this.stderr.length - 300); });
    proc.on('exit', () => { for (const [, cb] of this.pending) cb({ error: { message: 'mcp server exited' } }); this.pending.clear(); });
    const init = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gbrain-evals-cat40', version: '1' } }, 180_000);
    const r = (init.result ?? {}) as Record<string, unknown>;
    this.instructions = String(r.instructions ?? '');
    this.serverVersion = String((r.serverInfo as Record<string, unknown> | undefined)?.version ?? '');
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await this.request('tools/list', {});
    this.tools = ((list.result as Record<string, unknown>)?.tools ?? []) as McpClient['tools'];
  }
  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const m = await this.request('tools/call', { name, arguments: args });
    if (m.error) return `Error: ${JSON.stringify(m.error)}`;
    const res = (m.result ?? {}) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    const text = (res.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
    return res.isError ? `Error: ${text}` : text;
  }
  async close() {
    const p = this.proc;
    if (!p) return;
    this.proc = null;
    await new Promise<void>(resolve => {
      const t = setTimeout(() => { p.kill('SIGKILL'); resolve(); }, 20_000);
      p.once('exit', () => { clearTimeout(t); resolve(); });
      p.stdin.end();
    });
  }
}

// ─── Slots ──────────────────────────────────────────────────────────

export interface SlotBuild { slot: string; dir: string; steps: Array<{ step: string; code: number; ms: number; tail: string }>; meter: Meter; ms: number; pages?: unknown }

export class GbrainSlot {
  client: McpClient | null = null;
  readonly dir: string;
  readonly run: RunEnv;
  constructor(readonly id: string, root: string, readonly buildDir: string, proxyPort: number, readonly surface: string) {
    this.dir = join(root, id);
    const base = `http://127.0.0.1:${proxyPort}/${id}`;
    this.run = {
      buildDir,
      env: {
        PATH: process.env.PATH, HOME: join(this.dir, 'uh'), GBRAIN_HOME: join(this.dir, 'home'),
        GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_BACKUP_CHECK: 'off', TZ: 'UTC', LANG: 'C.UTF-8', NO_COLOR: '1',
        OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, VOYAGE_API_KEY: process.env.VOYAGE_API_KEY,
        ANTHROPIC_BASE_URL: `${base}/anthropic`, OPENAI_BASE_URL: `${base}/openai`,
      },
    };
  }
  get snapshot() { return `${this.dir}.tar`; }

  async build(world: LadderWorld, proxy: MeteringProxy, analyze: boolean): Promise<SlotBuild> {
    const t0 = Date.now();
    rmSync(this.dir, { recursive: true, force: true });
    const vault = join(this.dir, 'vault');
    for (const d of ['home', 'uh', 'vault']) mkdirSync(join(this.dir, d), { recursive: true });
    for (const doc of world.docs) {
      const p = join(vault, `${doc.id}.md`);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, renderDoc(doc));
    }
    const git = (args: string[]) => execFileSync('git', ['-C', vault, '-c', 'user.name=cat40', '-c', 'user.email=cat40@example.invalid', ...args], { stdio: 'pipe' });
    git(['init', '-q']); git(['add', '-A']); git(['commit', '-q', '-m', 'corpus']);
    const steps: SlotBuild['steps'] = [];
    const op = async (step: string, args: string[]) => {
      const r = await runCli(this.run, args, 3_600_000);
      steps.push({ step, code: r.code, ms: r.ms, tail: (r.stdout + '\n' + r.stderr).split('\n').filter(l => l.trim()).slice(-8).join('\n') });
      if (r.code !== 0) throw new Error(`gbrain ${step} failed (exit ${r.code}): ${steps.at(-1)!.tail}`);
    };
    await op('init', ['init', '--pglite', '--path', join(this.dir, 'home', 'brain.pglite'), '--embedding-model', GBRAIN_EMBED_MODEL, '--non-interactive']);
    const cfgPath = join(this.dir, 'home', '.gbrain', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.provider_base_urls = { ...(cfg.provider_base_urls ?? {}), voyage: `http://127.0.0.1:${proxy.port}/${this.id}/voyage/v1` };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    proxy.take(this.id);
    await op('sources-add', ['sources', 'add', 'vault', '--path', vault]);
    await op('sources-default', ['sources', 'default', 'vault']);
    await op('sync', ['sync', '--source', 'vault', '--no-pull']);
    await op('extract', ['extract', '--stale']);
    await op('embed', ['embed', '--stale']);
    if (analyze) {
      // gbrain does not ANALYZE after a bulk import on PGLite (no autovacuum), so the planner sees empty
      // tables and the graph-signal join in every search runs as a pages x pages nested loop (~50 s at
      // 4k pages). One ANALYZE fixes the plan (6 ms). Recorded in the receipt; the gbrain fix ships separately.
      const t = Date.now();
      const pglite = join(this.buildDir, 'node_modules/@electric-sql/pglite/dist');
      const script = `const { PGlite } = await import(${JSON.stringify(`${pglite}/index.js`)}); const { vector } = await import(${JSON.stringify(`${pglite}/vector/index.js`)}); const { pg_trgm } = await import(${JSON.stringify(`${pglite}/contrib/pg_trgm.js`)}); const db = await PGlite.create({ dataDir: ${JSON.stringify(join(this.dir, 'home', 'brain.pglite'))}, extensions: { vector, pg_trgm } }); await db.exec('ANALYZE'); await db.close();`;
      execFileSync('bun', ['-e', script], { stdio: 'pipe' });
      steps.push({ step: 'operator-analyze', code: 0, ms: Date.now() - t, tail: 'ANALYZE' });
    }
    const meter = proxy.take(this.id);
    execFileSync('tar', ['-C', this.dir, '-cf', this.snapshot, 'home']);
    return { slot: this.id, dir: this.dir, steps, meter, ms: Date.now() - t0 };
  }

  async start() {
    this.client = new McpClient(this.run, ['--surface', this.surface]);
    await this.client.start();
  }
  async stop() { await this.client?.close(); this.client = null; }
  async restore() {
    await this.stop();
    // gbrain records the checkout's device and inode and refuses managed writes when they change
    // ("The physical checkout identity changed"), so the vault directory is never recreated: git
    // resets its content to the corpus commit. Only the database home is replaced from the snapshot,
    // inside the existing directory.
    const vault = join(this.dir, 'vault');
    const git = (args: string[]) => execFileSync('git', ['-C', vault, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
    const corpus = git(['rev-list', '--max-parents=0', 'HEAD']).split('\n')[0];
    git(['reset', '-q', '--hard', corpus]);
    // Keep gbrain's ownership marker (.gbrain-owner.json): it is untracked and records the checkout identity.
    git(['clean', '-qfdx', '-e', '.gbrain-owner*']);
    const home = join(this.dir, 'home');
    for (const entry of readdirSync(home)) rmSync(join(home, entry), { recursive: true, force: true });
    execFileSync('tar', ['-C', this.dir, '-xf', this.snapshot, 'home']);
    await this.start();
  }
  /** A fresh harness session: a new server process on the same brain. */
  async newSession() { await this.stop(); await this.start(); }
  hasSnapshot() { return existsSync(this.snapshot); }
}

export class GbrainPool {
  private free: GbrainSlot[] = [];
  private waiters: Array<(s: GbrainSlot) => void> = [];
  constructor(readonly slots: GbrainSlot[]) { this.free = [...slots]; }
  acquire(): Promise<GbrainSlot> {
    const s = this.free.shift();
    if (s) return Promise.resolve(s);
    return new Promise(resolve => this.waiters.push(resolve));
  }
  release(s: GbrainSlot) {
    const w = this.waiters.shift();
    if (w) w(s); else this.free.push(s);
  }
}

export class GbrainArm implements Arm {
  readonly name = 'gbrain';
  constructor(private slot: GbrainSlot) {}
  private get client() { if (!this.slot.client) throw new Error('gbrain slot not started'); return this.slot.client; }
  systemHint() {
    return `The knowledge base is the company's gbrain, reached through the MCP tools listed. The gbrain server's instructions follow.\n<mcp_server_instructions server="gbrain">\n${this.client.instructions}\n</mcp_server_instructions>`;
  }
  tools(): ToolSpec[] {
    return this.client.tools.map(t => ({ name: t.name, description: t.description ?? '', input_schema: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown> }));
  }
  writeTools() { return this.client.tools.filter(t => t.annotations?.readOnlyHint !== true).map(t => t.name); }
  call(name: string, args: Record<string, unknown>) { return this.client.call(name, args); }
}

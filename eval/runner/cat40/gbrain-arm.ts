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
 *
 * Failures of the harness itself raise HarnessError (loop.ts): an MCP server
 * that exits, a closed pipe, a response timeout or malformed JSON-RPC, and a
 * failed restore. Tool results the server marks `isError` stay text for the
 * agent. Restores run as asynchronous subprocesses so they never block other
 * cells, and a slot whose restore or health check fails is quarantined by
 * GbrainPool (plan 2026-10-05, ENG-F10, ENG-F13).
 *
 * GbrainFsArm (`gbrain-fs`, exploratory, Hard development world only) serves this arm's tools on the same slot
 * plus the fs arm's read tools over the corpus files; see the end of this file.
 */
import { spawn, execFile, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { HarnessError, type Arm, type ToolSpec } from './loop.ts';
import { FsArm, type ArmName, type FileStore, type FsArmOptions } from './arms.ts';
import type { LadderWorld } from '../../generators/model-ladder-gen.ts';
import { renderDoc } from '../../generators/model-ladder-gen.ts';
import { runCli, type RunEnv } from '../lifecycle/drivers.ts';
import { priceRequest, reservationUsd, usageCost, type BudgetAllowance } from '../budget-ledger.ts';

export const GBRAIN_EMBED_MODEL = 'openai:text-embedding-3-large';
/** Above this many documents the source is registered before the corpus is written (see GbrainSlot.build). */
export const STAGED_SOURCE_ADD_DOCS = 6000;
export const STAGED_SYNC_BATCH = 5000;
export const SERVE_BOOT_TIMEOUT_SECONDS = 0;
/** How long the build's one warm server start may take to answer initialize. */
export const WARM_BOOT_TIMEOUT_MS = 1_800_000;
const CORPUS_TAG = 'cat40-corpus';
const execFileAsync = promisify(execFile);

// ─── Metering proxy ─────────────────────────────────────────────────

const UPSTREAM: Record<string, string> = { anthropic: 'https://api.anthropic.com', openai: 'https://api.openai.com', voyage: 'https://api.voyageai.com' };

export interface Meter {
  usd: number;
  requests: number;
  /** Requests whose cost came from their reservation because the response reported no usage (charged, not free). */
  unpriced: number;
  /** Requests still in flight when the meter was finalized after its timeout (their cost is missing here, not in the ledger). */
  undrained?: number;
  byModel: Record<string, { usd: number; requests: number }>;
}
export const newMeter = (): Meter => ({ usd: 0, requests: 0, unpriced: 0, byModel: {} });

/**
 * Forwards gbrain's provider requests (each slot's base URL names the slot)
 * and meters them. A request is charged to the cell bound to its slot when it
 * arrives, so a request that finishes after the cell moved on still lands on
 * the right cell; `finalize` waits for a cell's in-flight requests to drain.
 * Requests with no bound cell are metered under `slot:<id>`.
 */
export class MeteringProxy {
  private server: ReturnType<typeof Bun.serve> | null = null;
  readonly meters = new Map<string, Meter>();
  /** Slots whose provider requests are charged to a ledger allowance (slot builds), not one ledger entry each. */
  readonly allowances = new Map<string, BudgetAllowance>();
  private bindings = new Map<string, string>();
  private inflight = new Map<string, number>();
  private waiters = new Map<string, Array<() => void>>();
  constructor(private options: { fetchImpl?: typeof fetch } = {}) {}
  get port(): number { return this.server!.port as number; }
  /** Charge the slot's provider requests to `key` (a cell id) from now on. */
  bind(slot: string, key: string) { this.bindings.set(slot, key); }
  /** With `key`, only drops the binding if it is still that key: a released slot may already be bound to the next cell. */
  unbind(slot: string, key?: string) { if (key === undefined || this.bindings.get(slot) === key) this.bindings.delete(slot); }
  private meter(key: string): Meter { let m = this.meters.get(key); if (!m) this.meters.set(key, m = newMeter()); return m; }
  private settled(key: string) {
    const n = (this.inflight.get(key) ?? 1) - 1;
    if (n > 0) { this.inflight.set(key, n); return; }
    this.inflight.delete(key);
    for (const w of this.waiters.get(key) ?? []) w();
    this.waiters.delete(key);
  }
  /** Wait for `key`'s in-flight requests (at most `timeoutMs`), then remove and return its meter. */
  async finalize(key: string, timeoutMs = 120_000): Promise<Meter> {
    if (this.inflight.get(key)) {
      await Promise.race([new Promise<void>(r => { const list = this.waiters.get(key) ?? []; list.push(r); this.waiters.set(key, list); }), Bun.sleep(timeoutMs)]);
    }
    const m = this.meters.get(key) ?? newMeter();
    this.meters.delete(key);
    if (this.inflight.get(key)) m.undrained = this.inflight.get(key);
    return m;
  }
  start() {
    const send = this.options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    this.server = Bun.serve({
      port: 0, hostname: '127.0.0.1', idleTimeout: 255,
      fetch: async req => {
        const url = new URL(req.url);
        const m = url.pathname.match(/^\/([^/]+)\/(anthropic|openai|voyage)(\/.*)$/);
        if (!m) return new Response('not found', { status: 404 });
        const [, slot, prov, rest] = m;
        const key = this.bindings.get(slot) ?? `slot:${slot}`;
        this.inflight.set(key, (this.inflight.get(key) ?? 0) + 1);
        try {
          const target = `${UPSTREAM[prov]}${rest}${url.search}`;
          const headers = new Headers(req.headers);
          for (const h of ['host', 'content-length', 'accept-encoding', 'connection']) headers.delete(h);
          const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text();
          let price: ReturnType<typeof priceRequest> = null;
          try { price = priceRequest(target, body ? JSON.parse(body) : undefined); } catch { price = null; }
          const meter = this.meter(key);
          const charge = (usd: number, unpriced: boolean) => {
            meter.requests++;
            meter.usd += usd;
            if (unpriced) meter.unpriced++;
            if (price) { const k = `${prov}:${price.model}`; meter.byModel[k] ??= { usd: 0, requests: 0 }; meter.byModel[k].usd += usd; meter.byModel[k].requests++; }
          };
          let res: Response;
          const allowance = this.allowances.get(slot);
          const forward = () => send(target, { method: req.method, headers, body });
          try { res = await (allowance ? allowance.run(forward) : forward()); }
          catch (e) {
            // A refused reservation never left the process; any other failure after sending is charged at its reservation, as the ledger does.
            if ((e as Error).name !== 'BudgetExceededError' && price) charge(reservationUsd(price), true);
            return new Response(JSON.stringify({ error: { message: `cat40 proxy: ${(e as Error).message}` } }), { status: 502, headers: { 'content-type': 'application/json' } });
          }
          const text = await res.text();
          if (price) {
            let cost: ReturnType<typeof usageCost> = null;
            try { cost = usageCost(price, JSON.parse(text)); } catch { cost = null; }
            charge(cost ? cost.usd : reservationUsd(price), !cost);
          } else charge(0, false);
          const out = new Headers(res.headers);
          for (const h of ['content-encoding', 'content-length', 'transfer-encoding']) out.delete(h);
          return new Response(text, { status: res.status, headers: out });
        } finally { this.settled(key); }
      },
    });
  }
  stop() { this.server?.stop(true); }
}

// ─── Minimal MCP stdio client ───────────────────────────────────────

type Pending = { resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void };

export class McpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private id = 1;
  private pending = new Map<number, Pending>();
  private exited: string | null = null;
  instructions = '';
  serverVersion = '';
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> }> = [];
  stderr: string[] = [];
  /** Response timeout of a tools/call; past it the call throws HarnessError. */
  callTimeoutMs = 300_000;
  constructor(private run: RunEnv, private args: string[]) {}
  /** True while the server process is running and its stdin is open. */
  get alive(): boolean { return !!this.proc && !this.exited && this.proc.stdin.writable; }
  private failAll(e: HarnessError) { for (const [, p] of this.pending) p.reject(e); this.pending.clear(); }
  private stderrTail() { return this.stderr.length ? `; stderr: ${this.stderr.slice(-5).join(' | ').slice(0, 800)}` : ''; }
  private request(method: string, params: Record<string, unknown>, timeoutMs = 300_000): Promise<Record<string, unknown>> {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      const proc = this.proc;
      if (!proc || this.exited || !proc.stdin.writable) { reject(new HarnessError(`MCP transport closed before ${method}${this.exited ? ` (${this.exited})` : ''}${this.stderrTail()}`)); return; }
      const t = setTimeout(() => { this.pending.delete(id); reject(new HarnessError(`MCP timeout: ${method} got no response in ${timeoutMs / 1000} s`)); }, timeoutMs);
      this.pending.set(id, { resolve: m => { clearTimeout(t); resolve(m); }, reject: e => { clearTimeout(t); reject(e); } });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', err => {
        if (!err) return;
        const p = this.pending.get(id);
        this.pending.delete(id);
        p?.reject(new HarnessError(`MCP write failed (${method}): ${err.message}`));
      });
    });
  }
  async start(initTimeoutMs = 180_000) {
    const proc = spawn('bun', [join(this.run.buildDir, 'src/cli.ts'), 'serve', ...this.args], { env: this.run.env, cwd: this.run.env.GBRAIN_HOME });
    this.proc = proc;
    this.exited = null;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (c: string) => {
      this.buf += c;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        let m: Record<string, unknown>;
        try { m = JSON.parse(line); } catch { continue; /* not JSON-RPC */ }
        if (m && typeof m === 'object' && m.id === undefined && m.method === 'notifications/tools/list_changed') { this.relisting = this.relist(); continue; }
        const p = m && typeof m === 'object' ? this.pending.get(m.id as number) : undefined;
        if (!p) continue;
        this.pending.delete(m.id as number);
        if (!('result' in m) && !('error' in m)) p.reject(new HarnessError(`malformed JSON-RPC response (no result or error): ${line.slice(0, 300)}`));
        else p.resolve(m);
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (c: string) => { this.stderr.push(...c.split('\n').filter(Boolean)); if (this.stderr.length > 300) this.stderr.splice(0, this.stderr.length - 300); });
    proc.stdin.on('error', (e: Error) => this.failAll(new HarnessError(`MCP stdin failed: ${e.message}${this.stderrTail()}`)));
    proc.on('error', (e: Error) => { this.exited ??= `failed: ${e.message}`; this.failAll(new HarnessError(`MCP server failed: ${e.message}${this.stderrTail()}`)); });
    // 'close' fires after stderr is drained, so the failure carries the server's last stderr lines.
    proc.on('exit', (code, signal) => { this.exited = `exit ${code ?? signal}`; });
    proc.on('close', (code, signal) => { this.exited ??= `exit ${code ?? signal}`; this.failAll(new HarnessError(`MCP server exited (${this.exited})${this.stderrTail()}`)); });
    const init = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gbrain-evals-cat40', version: '1' } }, initTimeoutMs);
    if (init.error) throw new HarnessError(`MCP initialize failed: ${JSON.stringify(init.error).slice(0, 500)}`);
    const r = (init.result ?? {}) as Record<string, unknown>;
    this.instructions = String(r.instructions ?? '');
    this.serverVersion = String((r.serverInfo as Record<string, unknown> | undefined)?.version ?? '');
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await this.relist();
  }
  /** Bumped whenever the listed tools change (tools/list_changed, or a request_tools call that revealed tools). */
  toolsVersion = 0;
  private relisting: Promise<void> | null = null;
  private async relist() {
    const tools = await this.listTools();
    if (this.tools.length && tools.map(t => t.name).join() !== this.tools.map(t => t.name).join()) this.toolsVersion++;
    this.tools = tools;
  }
  /** One `tools/list` round trip (no model spend). */
  async listTools(timeoutMs = 300_000): Promise<McpClient['tools']> {
    const list = await this.request('tools/list', {}, timeoutMs);
    if (list.error) throw new HarnessError(`MCP tools/list failed: ${JSON.stringify(list.error).slice(0, 500)}`);
    return ((list.result as Record<string, unknown>)?.tools ?? []) as McpClient['tools'];
  }
  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const m = await this.request('tools/call', { name, arguments: args }, this.callTimeoutMs);
    // The server may send tools/list_changed before or after the response; request_tools always re-lists.
    if (name === 'request_tools') this.relisting = this.relist();
    await this.relisting;
    if (m.error) return `Error: ${JSON.stringify(m.error)}`;
    const res = (m.result ?? {}) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    const text = (res.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
    return res.isError ? `Error: ${text}` : text;
  }
  async close() {
    const p = this.proc;
    if (!p) return;
    this.proc = null;
    if (p.exitCode !== null || p.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const t = setTimeout(() => { p.kill('SIGKILL'); resolve(); }, 20_000);
      p.once('exit', () => { clearTimeout(t); resolve(); });
      p.stdin.end();
    });
  }
}

// ─── Slots ──────────────────────────────────────────────────────────

/**
 * PATH for gbrain processes. Capy cloud machines wrap git in a logging shell script that starts about ten
 * extra processes per call, and gbrain's sync calls git twice per imported file, which made it a large share
 * of a 50,000-document import. When that wrapper is present, gbrain gets the real binary instead.
 */
export function directGitPath(root: string): string | undefined {
  const path = process.env.PATH;
  let git: string;
  try { git = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(); } catch { return path; }
  if (!git || !existsSync(`${git}.real`) || !readFileSync(git, 'utf8').startsWith('#!')) return path;
  const bin = join(root, 'direct-git-bin');
  mkdirSync(bin, { recursive: true });
  if (!existsSync(join(bin, 'git'))) symlinkSync(`${git}.real`, join(bin, 'git'));
  return `${bin}:${path}`;
}

export interface SlotBuild { slot: string; dir: string; steps: Array<{ step: string; code: number; ms: number; tail: string }>; meter: Meter; ms: number; pages?: unknown; coverage?: SlotCoverage; allowance?: { reserved_usd: number; usd: number; requests: number; charged_reservations: number } }

/**
 * gbrain's mention-index coverage for a built slot (entity-recall plan 2026-10-04, E-T7). gbrain reports it as
 * `coverage: {state, pending_pages, last_pass_at}` on `entity` cards and misses; `supported: false` records a
 * build that predates the field, whose slots are not checked.
 */
export interface SlotCoverage { supported: boolean; state: string | null; pending: number | null; last_pass_at: string | null }
/** A name no Cat 40 world uses, so the `entity` probe is a miss, which still carries `coverage`. */
export const COVERAGE_PROBE_NAME = 'cat40 coverage probe';

export function parseCoverage(text: string): SlotCoverage {
  let j: Record<string, unknown>;
  try { j = JSON.parse(text) as Record<string, unknown>; } catch { return { supported: false, state: null, pending: null, last_pass_at: null }; }
  const c = (j.coverage ?? (j.card as Record<string, unknown> | undefined)?.coverage) as Record<string, unknown> | undefined;
  if (!c || typeof c !== 'object') return { supported: false, state: null, pending: null, last_pass_at: null };
  const pending = c.pending_pages ?? c.pending;
  return { supported: true, state: typeof c.state === 'string' ? c.state : null, pending: typeof pending === 'number' ? pending : null, last_pass_at: typeof c.last_pass_at === 'string' ? c.last_pass_at : null };
}

/** Why a slot's recorded coverage does not allow a round to start; null when it does or when the build has no coverage. */
export function coverageProblem(c: SlotCoverage): string | null {
  if (!c.supported) return null;
  if (c.state === 'complete' && c.pending === 0) return null;
  return `mention coverage ${c.state ?? 'unknown'} with ${c.pending ?? 'unknown'} pending pages`;
}

export class GbrainSlot {
  client: McpClient | null = null;
  readonly dir: string;
  readonly run: RunEnv;
  /** `gbrain config set` pairs applied after every restore (the snapshot does not carry them). */
  config: Array<[string, string]> = [];
  /** `advertised`: the brain's mcp.advertised_surface (tools listed; the callable set stays `surface`). Null leaves it unset. */
  constructor(readonly id: string, root: string, readonly buildDir: string, readonly proxyPort: number, readonly surface: string, readonly advertised: string | null = null) {
    this.dir = join(root, id);
    const base = `http://127.0.0.1:${proxyPort}/${id}`;
    this.run = {
      buildDir,
      env: {
        PATH: directGitPath(root), HOME: join(this.dir, 'uh'), GBRAIN_HOME: join(this.dir, 'home'),
        GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_BACKUP_CHECK: 'off', TZ: 'UTC', LANG: 'C.UTF-8', NO_COLOR: '1',
        // `gbrain serve` exits when its boot has not completed within 60 s (serve.ts). On a 52,000-page PGLite
        // brain it already answers tool calls but its boot runs past that deadline, so it exited mid-session. 0 disables it.
        GBRAIN_SERVE_BOOT_TIMEOUT_SECONDS: String(SERVE_BOOT_TIMEOUT_SECONDS),
        OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, VOYAGE_API_KEY: process.env.VOYAGE_API_KEY,
        ANTHROPIC_BASE_URL: `${base}/anthropic`, OPENAI_BASE_URL: `${base}/openai`,
      },
    };
  }
  get snapshot() { return `${this.dir}.tar`; }

  async build(world: LadderWorld, proxy: MeteringProxy, analyze: boolean): Promise<SlotBuild> {
    const t0 = Date.now();
    const meterKey = `build:${this.id}`;
    proxy.bind(this.id, meterKey);
    rmSync(this.dir, { recursive: true, force: true });
    const vault = join(this.dir, 'vault');
    for (const d of ['home', 'uh', 'vault']) mkdirSync(join(this.dir, d), { recursive: true });
    const writeDocs = (docs: LadderWorld['docs']) => { for (const doc of docs) {
      const p = join(vault, `${doc.id}.md`);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, renderDoc(doc));
    } };
    const git = (args: string[]) => execFileSync('git', ['-C', vault, '-c', 'user.name=cat40', '-c', 'user.email=cat40@example.invalid', ...args], { stdio: 'pipe' });
    // `gbrain sources add` hashes every file into a manifest and refuses one over 1 MiB (source-lifecycle.ts),
    // about 8,000 files. A larger corpus registers the source with the policy files only (or, in Hard worlds, which have none, the first sync batch), then adds the rest
    // in synced batches. The final corpus commit is tagged so restore resets to it.
    const staged = world.docs.length > STAGED_SOURCE_ADD_DOCS;
    const policies = world.docs.filter(d => d.type === 'policy');
    const initialDocs = !staged ? world.docs : policies.length ? policies : world.docs.slice(0, STAGED_SYNC_BATCH);
    writeDocs(initialDocs);
    git(['init', '-q']); git(['add', '-A']); git(['commit', '-q', '-m', staged ? 'first batch' : 'corpus']);
    const steps: SlotBuild['steps'] = [];
    const op = async (step: string, args: string[]) => {
      let r = await runCli(this.run, args, 3_600_000);
      steps.push({ step, code: r.code, ms: r.ms, tail: (r.stdout + '\n' + r.stderr).split('\n').filter(l => l.trim()).slice(-8).join('\n') });
      // A provider 5xx on one chunk fails the whole embed, and gbrain quarantines that page for the rest of the
      // process. A fresh process retries only the stale chunks, so one retry absorbs a transient provider error.
      if (r.code !== 0 && args[0] === 'embed' && /failed to embed/.test(r.stdout + r.stderr)) {
        r = await runCli(this.run, args, 3_600_000);
        steps.push({ step: `${step}-retry`, code: r.code, ms: r.ms, tail: (r.stdout + '\n' + r.stderr).split('\n').filter(l => l.trim()).slice(-8).join('\n') });
      }
      if (r.code !== 0) throw new Error(`gbrain ${step} failed (exit ${r.code}): ${steps.at(-1)!.tail}`);
    };
    await op('init', ['init', '--pglite', '--path', join(this.dir, 'home', 'brain.pglite'), '--embedding-model', GBRAIN_EMBED_MODEL, '--non-interactive']);
    const cfgPath = join(this.dir, 'home', '.gbrain', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.provider_base_urls = { ...(cfg.provider_base_urls ?? {}), voyage: `http://127.0.0.1:${proxy.port}/${this.id}/voyage/v1` };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    const operatorAnalyze = (step: string) => {
      // gbrain does not ANALYZE after a bulk import on PGLite (no autovacuum), so the planner sees empty
      // tables and the graph-signal join in every search runs as a pages x pages nested loop (~50 s at
      // 4k pages). One ANALYZE fixes the plan (6 ms). Recorded in the receipt; the gbrain fix ships separately.
      const t = Date.now();
      const pglite = join(this.buildDir, 'node_modules/@electric-sql/pglite/dist');
      const script = `const { PGlite } = await import(${JSON.stringify(`${pglite}/index.js`)}); const { vector } = await import(${JSON.stringify(`${pglite}/vector/index.js`)}); const { pg_trgm } = await import(${JSON.stringify(`${pglite}/contrib/pg_trgm.js`)}); const db = await PGlite.create({ dataDir: ${JSON.stringify(join(this.dir, 'home', 'brain.pglite'))}, extensions: { vector, pg_trgm } }); await db.exec('ANALYZE'); await db.close();`;
      execFileSync('bun', ['-e', script], { stdio: 'pipe' });
      steps.push({ step, code: 0, ms: Date.now() - t, tail: 'ANALYZE' });
    };
    await op('sources-add', ['sources', 'add', 'vault', '--path', vault]);
    await op('sources-default', ['sources', 'default', 'vault']);
    if (staged) {
      // The import slows as tables grow with stale planner statistics (2.3 docs/s at 13k pages, about 7 after
      // an ANALYZE), and a sync is hard-killed after an hour. So the corpus arrives in batches, each synced and
      // followed by an operator ANALYZE (only when analyze is on), the way a growing company brain is maintained.
      const firstIds = new Set(initialDocs.map(d => d.id));
      const rest = world.docs.filter(d => !firstIds.has(d.id));
      for (let i = 0, k = 1; i < rest.length; i += STAGED_SYNC_BATCH, k++) {
        writeDocs(rest.slice(i, i + STAGED_SYNC_BATCH));
        git(['add', '-A']); git(['commit', '-q', '-m', `corpus batch ${k}`]);
        await op(`sync-${k}`, ['sync', '--source', 'vault', '--no-pull']);
        if (analyze) operatorAnalyze(`operator-analyze-${k}`);
      }
    } else await op('sync', ['sync', '--source', 'vault', '--no-pull']);
    git(['tag', CORPUS_TAG]);
    // --catch-up runs past the stale sweep's 30-minute budget, so the mention pass finishes before the snapshot.
    await op('extract', ['extract', '--stale', '--catch-up']);
    // `embed --stale` stops after 30 minutes of wall clock unless --catch-up is given, which would leave a large
    // corpus partly embedded. The dry run afterwards proves nothing is left.
    // The evaluator is the user here and authorizes the build's embedding spend (metered by the slot allowance).
    // Builds that gate paid backfills (agent-first operator wave) refuse with exit 3 until `--yes`; older builds
    // reject that flag, so it is passed only after a confirmation_required refusal.
    const embedArgs = ['embed', '--stale', ...(staged ? ['--catch-up'] : [])];
    const first = await runCli(this.run, embedArgs, 3_600_000);
    if (first.code === 3 && /confirmation_required|needs the user's approval/.test(first.stdout + first.stderr)) {
      steps.push({ step: 'embed-consent-refused', code: 3, ms: first.ms, tail: 'confirmation_required; rerun with --yes (evaluator-authorized build spend)' });
      await op('embed', [...embedArgs, '--yes']);
    } else {
      steps.push({ step: 'embed', code: first.code, ms: first.ms, tail: (first.stdout + '\n' + first.stderr).split('\n').filter(l => l.trim()).slice(-8).join('\n') });
      if (first.code !== 0 && /failed to embed/.test(first.stdout + first.stderr)) await op('embed-retry', embedArgs);
      else if (first.code !== 0) throw new Error(`gbrain embed failed (exit ${first.code}): ${steps.at(-1)!.tail}`);
    }
    if (staged) {
      await op('embed-verify', ['embed', '--stale', '--dry-run']);
      const left = steps.at(-1)!.tail.match(/Would embed (\d+) stale chunks/);
      if (left && Number(left[1]) > 0) throw new Error(`gbrain ${this.id}: ${left[1]} chunks still unembedded after embed --catch-up`);
    }
    if (analyze) operatorAnalyze('operator-analyze');
    proxy.unbind(this.id);
    const meter = await proxy.finalize(meterKey);
    // The first server start on a freshly imported large brain does one-time work before it answers (225 s at
    // 55,000 pages; 25 s on every later start). Snapshotting after one clean start and stop keeps that work out
    // of every restore, the way an installed brain has already been opened once.
    const warmStart = Date.now();
    const warm = new McpClient(this.run, ['--surface', this.surface]);
    try { await warm.start(WARM_BOOT_TIMEOUT_MS); } finally { await warm.close(); }
    steps.push({ step: 'warm-boot', code: 0, ms: Date.now() - warmStart, tail: 'one server start and stop before the snapshot' });
    execFileSync('tar', ['-C', this.dir, '-cf', this.snapshot, 'home']);
    const coverage = await this.probeCoverage();
    writeFileSync(this.coverageFile, JSON.stringify(coverage, null, 2) + '\n');
    return { slot: this.id, dir: this.dir, steps, meter, ms: Date.now() - t0, coverage };
  }

  /** Written beside the snapshot by `build`; the round preflight reads it. */
  get coverageFile() { return `${this.dir}.coverage.json`; }

  /** Asks the built brain for its mention coverage through an `entity` miss (zero model calls). */
  async probeCoverage(): Promise<SlotCoverage> {
    const client = new McpClient(this.run, ['--surface', this.surface]);
    await client.start();
    try { return parseCoverage(await client.call('entity', { name: COVERAGE_PROBE_NAME })); }
    finally { await client.close(); }
  }

  async start() {
    // The snapshot's config.json carries the Voyage base URL written by the process that built it, whose proxy
    // port is gone; a later process (cells run, latency replay) listens elsewhere, so every rerank call was
    // refused (Cat 40 Hard R0). Point it at this process's proxy on every start.
    const cfgPath = join(this.dir, 'home', '.gbrain', 'config.json');
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      cfg.provider_base_urls = { ...(cfg.provider_base_urls ?? {}), voyage: `http://127.0.0.1:${this.proxyPort}/${this.id}/voyage/v1` };
      if (this.advertised) cfg.mcp = { ...(cfg.mcp ?? {}), advertised_surface: this.advertised };
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    }
    this.client = new McpClient(this.run, ['--surface', this.surface]);
    await this.client.start();
  }
  async stop() { await this.client?.close(); this.client = null; }
  /** Restore the post-build snapshot and start a new server. Asynchronous subprocesses only; any failure is a HarnessError. */
  async restore() {
    try {
      await this.stop();
      // gbrain records the checkout's device and inode and refuses managed writes when they change
      // ("The physical checkout identity changed"), so the vault directory is never recreated: git
      // resets its content to the corpus commit. Only the database home is replaced from the snapshot,
      // inside the existing directory.
      const vault = join(this.dir, 'vault');
      const git = async (args: string[]) => (await execFileAsync('git', ['-C', vault, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 })).stdout.trim();
      const corpus = (await git(['tag', '--list', CORPUS_TAG])) ? CORPUS_TAG : (await git(['rev-list', '--max-parents=0', 'HEAD'])).split('\n')[0];
      await git(['reset', '-q', '--hard', corpus]);
      // Keep gbrain's ownership marker (.gbrain-owner.json): it is untracked and records the checkout identity.
      await git(['clean', '-qfdx', '-e', '.gbrain-owner*']);
      const home = join(this.dir, 'home');
      for (const entry of (await readdir(home)).sort()) await rm(join(home, entry), { recursive: true, force: true });
      await execFileAsync('tar', ['-C', this.dir, '-xf', this.snapshot, 'home'], { maxBuffer: 64 << 20 });
      for (const [key, value] of this.config) {
        const r = await runCli(this.run, ['config', 'set', key, value], 120_000);
        if (r.code !== 0) throw new Error(`gbrain ${this.id}: config set ${key} failed (exit ${r.code}): ${(r.stdout + r.stderr).trim().split('\n').slice(-3).join(' ')}`);
      }
      await this.start();
    } catch (e) {
      throw new HarnessError(`gbrain ${this.id} restore: ${(e as Error).message}`);
    }
  }
  /** Why the slot cannot take a cell (null when healthy): its server must run and list tools (one round trip, no model spend). */
  async healthCheck(): Promise<string | null> {
    if (!this.client) return 'MCP client not started';
    if (!this.client.alive) return 'MCP server not running';
    try { return (await this.client.listTools(60_000)).length ? null : 'MCP server lists no tools'; }
    catch (e) { return (e as Error).message; }
  }
  /** A fresh harness session: a new server process on the same brain. */
  async newSession() { await this.stop(); await this.start(); }
  hasSnapshot() { return existsSync(this.snapshot); }
}

/** Rejects cells waiting for a gbrain slot once quarantines leave fewer healthy slots than the step needs. */
export class SlotQuarantineError extends Error {
  constructor(message: string) { super(message); this.name = 'SlotQuarantineError'; }
}

/** What the pool needs from a slot (GbrainSlot; tests use fakes). */
export interface PoolSlot {
  readonly id: string;
  restore(): Promise<void>;
  /** Null when healthy, else the reason. */
  healthCheck(): Promise<string | null>;
}

/**
 * Hands each slot to one cell at a time. A quarantined slot (failed restore or health check, ENG-F10) is never
 * handed out again. Once fewer than `minHealthy` slots remain healthy, every waiting and later `acquire`
 * rejects with SlotQuarantineError, so the step halts instead of running on a contaminated or shrunken pool.
 */
export class GbrainPool<S extends PoolSlot = GbrainSlot> {
  private free: S[] = [];
  private waiters: Array<{ resolve: (s: S) => void; reject: (e: Error) => void }> = [];
  /** Quarantined slot ids and why. */
  readonly quarantined = new Map<string, string>();
  /** Healthy slots the step needs (default 1). */
  minHealthy: number;
  constructor(readonly slots: S[], options: { minHealthy?: number } = {}) { this.free = [...slots]; this.minHealthy = options.minHealthy ?? 1; }
  /** Slots not quarantined (free or in use). */
  get healthy(): number { return this.slots.length - this.quarantined.size; }
  /** The error waiting cells get, or null while enough healthy slots remain. */
  shortfall(): SlotQuarantineError | null {
    if (this.healthy >= this.minHealthy) return null;
    const why = [...this.quarantined].map(([id, r]) => `${id}: ${r}`).join('; ');
    return new SlotQuarantineError(`${this.healthy} healthy gbrain slots of ${this.slots.length}, the step needs ${this.minHealthy}; quarantined: ${why}`);
  }
  acquire(): Promise<S> {
    const short = this.shortfall();
    if (short) return Promise.reject(short);
    const s = this.free.shift();
    if (s) return Promise.resolve(s);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  release(s: S) {
    if (this.quarantined.has(s.id)) return;
    const w = this.waiters.shift();
    if (w) w.resolve(s); else this.free.push(s);
  }
  quarantine(s: S, reason: string) {
    this.quarantined.set(s.id, reason);
    this.free = this.free.filter(x => x !== s);
    const short = this.shortfall();
    if (short) for (const w of this.waiters.splice(0)) w.reject(short);
  }
  /** Restore and health-check a slot a cell is done with: release it when healthy, else quarantine it. Returns the failure reason, or null. */
  async restoreOrQuarantine(s: S): Promise<string | null> {
    let reason: string | null;
    try { await s.restore(); reason = await s.healthCheck(); }
    catch (e) { reason = `restore failed: ${(e as Error).message}`; }
    if (reason) this.quarantine(s, reason); else this.release(s);
    return reason;
  }
}

/**
 * Evaluator-side replacement for the server's initialize instructions (`--gbrain-instructions-file`), for
 * A/B tests of instruction text on unchanged gbrain code. gbrain's own `GBRAIN_MCP_INSTRUCTIONS` only appends
 * a deployment-identity block, so it cannot replace the text. Null keeps what the server sent.
 */
export const instructionsOverride: {
  text: string | null;
  served: string | null;
  /** Replacement tool descriptions by tool name (`--gbrain-tool-descriptions-file`, JSON object). */
  descriptions: Record<string, string> | null;
  /** Tools withheld from the model (`--gbrain-drop-tools a,b`). */
  dropTools: string[];
  servedTools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> | null;
} = { text: null, served: null, descriptions: null, dropTools: [], servedTools: null };

export class GbrainArm implements Arm {
  readonly name = 'gbrain';
  constructor(private slot: GbrainSlot) {}
  private get client() { if (!this.slot.client) throw new Error('gbrain slot not started'); return this.slot.client; }
  systemHint() {
    instructionsOverride.served ??= this.client.instructions;
    const text = instructionsOverride.text ?? this.client.instructions;
    return `The knowledge base is the company's gbrain, reached through the MCP tools listed. The gbrain server's instructions follow.\n<mcp_server_instructions server="gbrain">\n${text}\n</mcp_server_instructions>`;
  }
  tools(): ToolSpec[] {
    instructionsOverride.servedTools ??= this.client.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    const o = instructionsOverride;
    return this.client.tools.filter(t => !o.dropTools.includes(t.name)).map(t => ({ name: t.name, description: o.descriptions?.[t.name] ?? t.description ?? '', input_schema: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown> }));
  }
  toolsVersion() { return this.client.toolsVersion; }
  writeTools() { return this.client.tools.filter(t => t.annotations?.readOnlyHint !== true).map(t => t.name); }
  call(name: string, args: Record<string, unknown>) { return this.client.call(name, args); }
}

// ─── gbrain-fs (exploratory, development world only; plan 2026-10-07-cat40-hard-fix C16) ───

/** Arms a cell can run: the frozen arm set plus the exploratory `gbrain-fs`, kept out of arms.ts so the freeze hash of the counted arms is unchanged. */
export type CellArm = ArmName | 'gbrain-fs';

/** The arm name a cell records: gbrain cells carry `--gbrain-label`, gbrain-fs cells that label plus `+fs`, so the two never mix. */
export function cellLabel(arm: CellArm, gbrainLabel: string): string {
  return arm === 'gbrain' ? gbrainLabel : arm === 'gbrain-fs' ? `${gbrainLabel}+fs` : arm;
}

/** The fs arm's read tools gbrain-fs serves beside gbrain's tools; write_file is not served, so notes live only in gbrain. */
export const GBRAIN_FS_READ_TOOLS = ['list_dir', 'grep', 'read_file'];
export const GBRAIN_FS_HINT = 'The raw Markdown files behind the gbrain are also readable with list_dir, grep and read_file; they are read-only, so save notes with the gbrain tools.';

/** Refuses a gbrain tool list that already serves one of the fs read tools (the agent could not tell the two apart). */
export function assertNoGbrainFsCollision(gbrainTools: string[]): void {
  const clash = gbrainTools.filter(t => GBRAIN_FS_READ_TOOLS.includes(t));
  if (clash.length) throw new Error(`gbrain-fs: the gbrain server serves ${clash.join(', ')}, which collides with the fs read tool of the same name; withhold it with --gbrain-drop-tools ${clash.join(',')} or drop the gbrain-fs arm`);
}

/**
 * Exploratory arm: every tool, instruction and slot of the `gbrain` arm, plus the fs arm's read tools (the same
 * limits as the fs arm) over the same corpus files. Writes go through gbrain's write tools only.
 */
export class GbrainFsArm implements Arm {
  readonly name = 'gbrain-fs';
  private gbrain: GbrainArm;
  private fs: FsArm;
  constructor(slot: GbrainSlot, files: FileStore, fsOptions: FsArmOptions = {}) {
    this.gbrain = new GbrainArm(slot);
    this.fs = new FsArm('fs', files, fsOptions);
  }
  systemHint() { return `${this.gbrain.systemHint()}\n${GBRAIN_FS_HINT}`; }
  tools(): ToolSpec[] {
    const gbrain = this.gbrain.tools();
    assertNoGbrainFsCollision(gbrain.map(t => t.name));
    return [...gbrain, ...this.fs.tools().filter(t => GBRAIN_FS_READ_TOOLS.includes(t.name))];
  }
  toolsVersion() { return this.gbrain.toolsVersion(); }
  writeTools() { return this.gbrain.writeTools(); }
  call(name: string, args: Record<string, unknown>) { return GBRAIN_FS_READ_TOOLS.includes(name) ? this.fs.call(name, args) : this.gbrain.call(name, args); }
}

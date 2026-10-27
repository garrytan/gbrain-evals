/**
 * Shared harness for the P5 agent runners (H5b save-notes-dedup, H6
 * write-then-answer) and the P5 judge calls (H3 junk audit, H6 answers).
 *
 *   AgentBrain     one keyless PGLite brain on the build under test, created with the
 *                  gbrain CLI (init, `config set --force` with read-back, import), served
 *                  to the agent by `gbrain serve` over stdio (cat40 McpClient), snapshotted
 *                  and restored as a tar of its home directory (chronicle-lift's pattern).
 *                  Keyless means no provider key reaches gbrain: no embeddings, keyword
 *                  search in every arm, and every paid request is the agent's or the judge's.
 *   ToolsArm       a cat40 Arm over the brain's MCP tools, restricted to one fixed tool
 *                  list (P5_AGENT_TOOLS) that is the same for every arm and build, plus
 *                  the arm's guidance text after the server's own instructions. Tool
 *                  results are never capped.
 *   chatText       one judge call through fetch, so the paid-request guard meters it.
 *   openPaid       --paid with --budget-usd (opens a ledger run) or --budget-run-id (joins one);
 *                  a resumed output directory rejoins the run it recorded while that run is open.
 *   Checkpoint     append-per-unit JSONL: a rerun skips every unit already written, so a
 *                  machine restart loses at most the units in flight.
 *
 * MCP stdio calls are remote calls, so put_page stores link text without extracting it
 * (gbrain's remote-write rule); sweep() stops the server and runs `gbrain extract --stale`,
 * the local catch-up a remote writer's brain gets from its sweep, then restarts it.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BudgetRun, budgetOptionsFrom, ledgerStatus, startPaidRun, type PaidRequestGuard, type RunSummary } from './budget-ledger.ts';
import { McpClient } from './cat40/gbrain-arm.ts';
import { priceUsage, provider, type Arm, type ToolSpec } from './cat40/loop.ts';
import { runCli, type RunEnv } from './lifecycle/drivers.ts';
import { PairingError, clusteredPairedDelta, pairObservations, seededRandom, type PairedDelta } from './stats/paired.ts';
import { loadRows, toObservation } from './stats/rows.ts';

/** The tools every P5 agent arm offers, on every build. A name the build does not serve is recorded as missing. */
export const P5_AGENT_TOOLS: readonly string[] = [
  'search', 'query', 'get_page', 'list_pages', 'put_page', 'edit_page', 'delete_page', 'add_link', 'get_links',
  'get_backlinks', 'traverse_graph', 'resolve_slugs', 'add_timeline_entry', 'recall', 'remember', 'entity',
];
/** Read-only subset for answer sessions, so concurrent sessions on one server cannot change what the others read. */
export const P5_ANSWER_TOOLS: readonly string[] = ['search', 'query', 'get_page', 'list_pages', 'get_links', 'get_backlinks', 'traverse_graph', 'resolve_slugs', 'recall', 'entity'];

export function keylessEnv(dir: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '', HOME: join(dir, 'uh'), GBRAIN_HOME: join(dir, 'home'), TZ: 'UTC', LANG: 'C.UTF-8', NO_COLOR: '1',
    GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_BACKUP_CHECK: 'off', GBRAIN_SERVE_BOOT_TIMEOUT_SECONDS: '0',
  };
}

export interface BrainStep { step: string; code: number; ms: number; tail: string }
export interface StoredPage { slug: string; title: string; type: string; body: string }

export class AgentBrain {
  client: McpClient | null = null;
  readonly run: RunEnv;
  readonly steps: BrainStep[] = [];
  configReadback: Record<string, string | null> = {};
  constructor(readonly buildDir: string, readonly dir: string) {
    this.run = { buildDir, env: keylessEnv(dir) };
  }
  private async cli(step: string, args: string[], timeoutMs = 1_800_000) {
    const r = await runCli(this.run, args, timeoutMs);
    this.steps.push({ step, code: r.code, ms: r.ms, tail: (r.stdout + '\n' + r.stderr).split('\n').filter(l => l.trim()).slice(-6).join('\n') });
    if (r.code !== 0) throw new Error(`gbrain ${step} failed (exit ${r.code}): ${this.steps.at(-1)!.tail}`);
    return r;
  }
  /** A fresh brain with `config` set and read back before anything is written; then `pages` imported, if any. */
  async create(config: Record<string, string>, pages: Array<{ path: string; content: string }> = []) {
    rmSync(this.dir, { recursive: true, force: true });
    for (const d of ['home', 'uh']) mkdirSync(join(this.dir, d), { recursive: true });
    await this.cli('init', ['init', '--pglite', '--non-interactive', '--no-embedding']);
    for (const [k, v] of Object.entries(config)) await this.cli(`config-set ${k}`, ['config', 'set', k, v, '--force']);
    for (const k of Object.keys(config)) this.configReadback[k] = (await runCli(this.run, ['config', 'get', k])).stdout.trim() || null;
    const wrong = Object.keys(config).filter(k => this.configReadback[k] !== config[k]);
    if (wrong.length) throw new Error(`GBRAIN_EVAL_CONFIG: config did not read back as set: ${wrong.map(k => `${k} set ${config[k]}, read ${this.configReadback[k]}`).join('; ')}`);
    if (pages.length) {
      const vault = join(this.dir, 'seed-vault');
      for (const p of pages) { mkdirSync(dirname(join(vault, p.path)), { recursive: true }); writeFileSync(join(vault, p.path), p.content); }
      await this.cli('import', ['import', vault, '--no-embed', '--json']);
      await this.cli('extract', ['extract', '--stale']);
    }
  }
  snapshot(tar: string) {
    mkdirSync(dirname(tar), { recursive: true });
    execFileSync('tar', ['-C', this.dir, '-cf', `${tar}.tmp`, 'home']);
    execFileSync('mv', [`${tar}.tmp`, tar]);
  }
  /**
   * Bring the brain back to `tar`, a snapshot of this same directory. gbrain records the content
   * checkout's device and inode and refuses managed writes when they change, so directories are
   * never recreated: the snapshot is unpacked beside the brain and copied over it with rsync
   * --delete, which updates files in place inside the existing directories.
   */
  async restoreFrom(tar: string) {
    await this.stop();
    mkdirSync(join(this.dir, 'uh'), { recursive: true });
    const staging = join(this.dir, 'restore-staging');
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    execFileSync('tar', ['-C', staging, '-xf', tar, 'home']);
    mkdirSync(join(this.dir, 'home'), { recursive: true });
    execFileSync('rsync', ['-a', '--delete', `${join(staging, 'home')}/`, `${join(this.dir, 'home')}/`]);
    rmSync(staging, { recursive: true, force: true });
  }
  async start() {
    this.client = new McpClient(this.run, ['--surface', 'full']);
    await this.client.start();
  }
  async stop() { await this.client?.close(); this.client = null; }
  /** Stop the server, extract every stale page's links locally, restart if it was running. */
  async sweep(): Promise<BrainStep> {
    const running = !!this.client;
    await this.stop();
    await this.cli('extract-stale', ['extract', '--stale']);
    if (running) await this.start();
    return this.steps.at(-1)!;
  }
  /** Every live page, read from the database by a subprocess on the build (the server must be stopped). */
  readPages(): StoredPage[] {
    const script = `
      const { PGLiteEngine } = await import(${JSON.stringify(join(this.buildDir, 'src/core/pglite-engine.ts'))});
      const cfg = JSON.parse(await Bun.file(${JSON.stringify(join(this.run.env.GBRAIN_HOME!, '.gbrain', 'config.json'))}).text());
      const e = new PGLiteEngine(); await e.connect({ database_path: cfg.database_path });
      const rows = await e.executeRaw("SELECT slug, coalesce(title, '') AS title, coalesce(type, '') AS type, coalesce(compiled_truth, '') || E'\\n' || coalesce(timeline, '') AS body FROM pages WHERE deleted_at IS NULL ORDER BY slug");
      await e.disconnect();
      process.stdout.write(JSON.stringify(rows));`;
    const out = execFileSync('bun', ['-e', script], { env: { ...this.run.env }, cwd: this.run.env.GBRAIN_HOME, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
    return JSON.parse(out) as StoredPage[];
  }
  /**
   * Extraction state for the immediate-answer cell: live pages, pages whose links were never extracted or are older
   * than the page (links_extracted_at null or before updated_at), and stored edges by type. The server must be stopped.
   */
  extractionState(): { pages: number; pages_pending_link_extraction: number; edges: number; edges_by_type: Record<string, number> } {
    const script = `
      const { PGLiteEngine } = await import(${JSON.stringify(join(this.buildDir, 'src/core/pglite-engine.ts'))});
      const cfg = JSON.parse(await Bun.file(${JSON.stringify(join(this.run.env.GBRAIN_HOME!, '.gbrain', 'config.json'))}).text());
      const e = new PGLiteEngine(); await e.connect({ database_path: cfg.database_path });
      const [p] = await e.executeRaw("SELECT count(*)::int AS pages, count(*) FILTER (WHERE links_extracted_at IS NULL OR links_extracted_at < updated_at)::int AS pending FROM pages WHERE deleted_at IS NULL");
      const t = await e.executeRaw('SELECT coalesce(l.link_type, \\'untyped\\') AS type, count(*)::int AS n FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id WHERE f.deleted_at IS NULL AND t.deleted_at IS NULL GROUP BY 1');
      await e.disconnect();
      process.stdout.write(JSON.stringify({ p, t }));`;
    const r = JSON.parse(execFileSync('bun', ['-e', script], { env: { ...this.run.env }, cwd: this.run.env.GBRAIN_HOME, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })) as { p: { pages: number; pending: number }; t: Array<{ type: string; n: number }> };
    return { pages: r.p.pages, pages_pending_link_extraction: r.p.pending, edges: r.t.reduce((a, x) => a + x.n, 0), edges_by_type: Object.fromEntries(r.t.map(x => [x.type, x.n])) };
  }
  /** Stored edges (from, to, type). */
  readEdges(): Array<{ from: string; to: string; type: string }> {
    const script = `
      const { PGLiteEngine } = await import(${JSON.stringify(join(this.buildDir, 'src/core/pglite-engine.ts'))});
      const cfg = JSON.parse(await Bun.file(${JSON.stringify(join(this.run.env.GBRAIN_HOME!, '.gbrain', 'config.json'))}).text());
      const e = new PGLiteEngine(); await e.connect({ database_path: cfg.database_path });
      const rows = await e.executeRaw('SELECT f.slug AS "from", t.slug AS "to", l.link_type AS "type" FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id WHERE f.deleted_at IS NULL AND t.deleted_at IS NULL ORDER BY 1, 2, 3');
      await e.disconnect();
      process.stdout.write(JSON.stringify(rows));`;
    return JSON.parse(execFileSync('bun', ['-e', script], { env: { ...this.run.env }, cwd: this.run.env.GBRAIN_HOME, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }));
  }
}

/** The fixed tool list over a brain's MCP server, plus the arm's guidance. */
export class ToolsArm implements Arm {
  constructor(readonly name: string, private brain: AgentBrain, private guidance: string, private owner: string, readonly allowed: readonly string[] = P5_AGENT_TOOLS) {}
  private get client() { if (!this.brain.client) throw new Error('brain server not started'); return this.brain.client; }
  missingTools(): string[] { const served = new Set(this.client.tools.map(t => t.name)); return this.allowed.filter(t => !served.has(t)); }
  systemHint() {
    return [
      `The knowledge base is ${this.owner}'s gbrain, reached through the MCP tools listed. The gbrain server's instructions follow.`,
      `<mcp_server_instructions server="gbrain">\n${this.client.instructions}\n</mcp_server_instructions>`,
      this.guidance ? `<brain_writing_guidance>\n${this.guidance.trim()}\n</brain_writing_guidance>` : '',
    ].filter(Boolean).join('\n');
  }
  tools(): ToolSpec[] {
    return this.client.tools.filter(t => this.allowed.includes(t.name))
      .map(t => ({ name: t.name, description: t.description ?? '', input_schema: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown> }));
  }
  toolsVersion() { return this.client.toolsVersion; }
  writeTools() { return this.client.tools.filter(t => this.allowed.includes(t.name) && t.annotations?.readOnlyHint !== true).map(t => t.name); }
  call(name: string, args: Record<string, unknown>) {
    if (!this.allowed.includes(name)) return Promise.resolve(`Error: unknown tool ${name}`);
    return this.client.call(name, args);
  }
}

// ─── Judge calls ────────────────────────────────────────────────────

export interface ChatOut { text: string; usd: number; input_tokens: number; output_tokens: number }

/** One text completion. OpenAI models use the Responses API with low reasoning effort; Claude models the Messages API. */
export async function chatText(model: string, system: string, user: string, opts: { maxTokens?: number; fetchImpl?: typeof fetch } = {}): Promise<ChatOut> {
  const f = opts.fetchImpl ?? fetch;
  const post = async (url: string, headers: Record<string, string>, body: unknown) => {
    let last = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      const text = await res.text();
      if (res.ok) return JSON.parse(text) as Record<string, unknown>;
      last = `${res.status}: ${text.slice(0, 300)}`;
      if (![429, 500, 502, 503, 504, 529].includes(res.status)) break;
      await Bun.sleep(Math.min(30_000, 2000 * 2 ** attempt));
    }
    throw new Error(`judge provider error ${last}`);
  };
  if (provider(model) === 'openai') {
    const j = await post('https://api.openai.com/v1/responses', { authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}` },
      { model, instructions: system, input: user, max_output_tokens: opts.maxTokens ?? 4000, reasoning: { effort: 'low' } });
    const text = ((j.output ?? []) as Array<Record<string, unknown>>).filter(o => o.type === 'message').flatMap(o => (o.content as Array<Record<string, unknown>>) ?? []).map(c => String(c.text ?? '')).join('\n');
    const u = (j.usage ?? {}) as Record<string, number> & { input_tokens_details?: Record<string, number> };
    const cached = u.input_tokens_details?.cached_tokens ?? 0;
    return { text, input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0,
      usd: priceUsage(model, { input: (u.input_tokens ?? 0) - cached, cache_read: cached, cache_write: 0, output: u.output_tokens ?? 0, requests: 1 }) };
  }
  const j = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01' },
    { model, max_tokens: opts.maxTokens ?? 2000, system, messages: [{ role: 'user', content: user }] });
  const text = ((j.content ?? []) as Array<Record<string, unknown>>).filter(c => c.type === 'text').map(c => String(c.text)).join('\n');
  const u = (j.usage ?? {}) as Record<string, number>;
  return { text, input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0,
    usd: priceUsage(model, { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0, requests: 1 }) };
}

/** The first JSON object in a model's text (fenced or bare), or null. */
export function firstJsonObject(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  for (const candidate of [fenced, text].filter((x): x is string => !!x)) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try { return JSON.parse(candidate.slice(start, end + 1)); } catch { /* next */ }
  }
  return null;
}

// ─── Money ──────────────────────────────────────────────────────────

export interface PaidSession { run: BudgetRun; guard: PaidRequestGuard; runId: string; resumed: boolean }

/**
 * Paid work needs --paid plus --budget-usd (open a ledger run) or --budget-run-id (join one).
 * `recordFile` (in the output directory) remembers the run id, so a resumed directory rejoins
 * its run while it is still open instead of opening a second budget.
 */
export function openPaid(argv: readonly string[], runner: string, estimateUsd: number | null, recordFile: string, log: (s: string) => void): PaidSession {
  if (!argv.includes('--paid')) throw new Error(`${runner} makes paid model calls (estimate ${estimateUsd === null ? 'unmeasured' : `$${estimateUsd.toFixed(2)}`}); pass --paid with --budget-usd <dollars> or --budget-run-id <id>, or --scripted for the $0 plumbing check`);
  const options = budgetOptionsFrom(argv);
  let runId = options.runId;
  let resumed = false;
  if (!runId && existsSync(recordFile)) {
    const recorded = JSON.parse(readFileSync(recordFile, 'utf8')).budget_run_id as string | undefined;
    if (recorded && ledgerStatus({ ledgerPath: options.ledgerPath, runId: recorded }).run?.finished_at === null) { runId = recorded; resumed = true; }
  }
  const { run, guard } = startPaidRun(runner, { ...options, runId, estimateUsd, log });
  mkdirSync(dirname(recordFile), { recursive: true });
  writeFileSync(recordFile, JSON.stringify({ budget_run_id: run.runId, opened_by_this_directory: !options.runId }, null, 2) + '\n');
  return { run, guard, runId: run.runId, resumed };
}

/** Close the session's ledger view; only the directory that opened the run finishes it, and only after a complete run. */
export function closePaid(p: PaidSession, complete: boolean): RunSummary {
  const summary = p.run.close({ finish: complete && p.run.participant === null });
  p.guard.uninstall();
  return summary;
}

// ─── Checkpoints, subsets, comparisons ──────────────────────────────

/** Append-per-unit JSONL keyed by `key`; the last record for a key wins. A torn last line (crash mid-write) is ignored. */
export class Checkpoint<T extends { key: string }> {
  readonly done = new Map<string, T>();
  constructor(readonly path: string) {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line) as T; this.done.set(r.key, r); } catch { /* torn tail */ }
    }
  }
  has(key: string) { return this.done.has(key); }
  append(record: T) {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(record) + '\n');
    this.done.set(record.key, record);
  }
  values(): T[] { return [...this.done.values()]; }
}

/**
 * The units a run covers: all of them, a seeded 10% pilot (`--pilot`, at least one unit), or
 * the first `--limit N` after that. The pilot subset is a deterministic function of the ids,
 * so a pilot's units are a subset of the full run's and finished pilot units are reused.
 */
export function selectUnits<T>(units: readonly T[], idOf: (u: T) => string, opts: { pilot: boolean; limit: number | null; seed?: number }): T[] {
  let out = [...units];
  if (opts.pilot) {
    const key = (u: T) => createHash('sha256').update(`p5-pilot-v1\u0000${opts.seed ?? 0}\u0000${idOf(u)}`).digest('hex');
    const n = Math.max(1, Math.ceil(units.length * 0.1));
    const chosen = new Set([...units].sort((a, b) => key(a).localeCompare(key(b))).slice(0, n).map(idOf));
    out = out.filter(u => chosen.has(idOf(u)));
  }
  return opts.limit === null ? out : out.slice(0, opts.limit);
}

export function flagValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  return argv.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function limitFlag(argv: readonly string[]): number | null {
  const raw = flagValue(argv, '--limit');
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--limit must be a positive integer (got ${raw})`);
  return n;
}

/** k distinct items drawn with the shared seeded generator (partial Fisher-Yates). */
export function seededSample<T>(items: readonly T[], k: number, seed: number): T[] {
  const rnd = seededRandom(seed);
  const a = [...items];
  for (let i = 0; i < Math.min(k, a.length); i++) { const j = i + Math.floor(rnd() * (a.length - i)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, Math.min(k, a.length));
}

export const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');

export function readGuidance(path: string): { text: string; sha256: string; words: number } {
  const text = readFileSync(path, 'utf8');
  return { text, sha256: sha256(text), words: text.split(/\s+/).filter(Boolean).length };
}

export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}

/** Run `fn` over items with `n` workers. After the first failure no new item starts; running items finish, then it is rethrown. */
export async function runPool<T>(items: readonly T[], n: number, fn: (x: T, worker: number) => Promise<void>): Promise<void> {
  let i = 0;
  let failure: { error: unknown } | null = null;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async (_, worker) => {
    while (i < items.length && !failure) {
      const x = items[i++];
      try { await fn(x, worker); } catch (error) { failure ??= { error }; }
    }
  }));
  if (failure) throw (failure as { error: unknown }).error;
}

export interface MetricComparison extends Omit<PairedDelta, 'bootstrap'> { metric: string; group: string; relative_change: number | null; excluded: number }

/**
 * Paired comparison of two receipts' data.rows (A = reference arm, B = treatment) per metric,
 * pooled and per `groupBy` value: rows pair by `id`, clusters (`cluster`, one task or question)
 * are resampled whole (stats/paired.ts clusteredPairedDelta). A row without the metric is
 * ineligible on both sides; a row with a harness, dependency or judge error is ineligible. Rows of a model
 * only one receipt ran are left out.
 */
export function compareReceipts(aPath: string, bPath: string, metrics: readonly string[], opts: { groupBy?: string; draws?: number; seed?: number } = {}): MetricComparison[] {
  const rawA = loadRows(aPath, { idField: 'id', rowsPath: 'data.rows' }).rows;
  const rawB = loadRows(bPath, { idField: 'id', rowsPath: 'data.rows' }).rows;
  // Only models both receipts ran are compared; within them every id must pair.
  const models = new Set(rawA.map(r => String(r.model)).filter(m => rawB.some(r => String(r.model) === m)));
  const a = rawA.filter(r => models.has(String(r.model)));
  const b = rawB.filter(r => models.has(String(r.model)));
  const groups = ['all', ...(opts.groupBy ? [...new Set(a.map(r => String(r[opts.groupBy!])))].sort() : [])];
  const out: MetricComparison[] = [];
  for (const metric of metrics) for (const group of groups) {
    const pick = (rows: typeof a) => rows.filter(r => group === 'all' || String(r[opts.groupBy!]) === group).map(r => toObservation(r, { idField: 'id', metric, clusterBy: 'cluster' }));
    let pairing: ReturnType<typeof pairObservations>;
    try { pairing = pairObservations(pick(a), pick(b)); } catch (e) {
      if (e instanceof PairingError && e.problems.every(p => p === 'no eligible pairs')) continue;
      throw e;
    }
    const { bootstrap: _bootstrap, ...stats } = clusteredPairedDelta(pairing.pairs, { seed: opts.seed ?? 20261005, draws: opts.draws ?? 10_000 });
    out.push({ metric, group, ...stats, relative_change: stats.mean_a > 0 ? stats.delta / stats.mean_a : null, excluded: pairing.excluded.length });
  }
  return out;
}

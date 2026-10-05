/**
 * Shared plumbing for the P5 runners (typed relation lines, wanted pages,
 * similar-page hint): one in-memory PGLite brain on the gbrain build under
 * test, written through the `put_page` operation the way an agent writes,
 * with links produced by the build's own extraction and read back from the
 * links table.
 *
 *   put(slug, markdown)  put_page as a trusted local caller (remote: false)
 *   sweep()              the stale-link sweep that `gbrain extract --stale` runs
 *                        (extractStaleFromDB in src/commands/extract.ts, catch-up mode)
 *   edges()              every stored edge as (from, to, type) plus the page whose text produced it
 *
 * World-v1 pages are rendered the way gbrain serializes a page with a
 * timeline (serializeMarkdown): frontmatter type and title, compiled truth,
 * then `<!-- timeline -->` and the timeline lines.
 *
 * Arm config arrives through GBRAIN_EVAL_CONFIG (eval-config.ts) and is
 * applied before the first page is written.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { OperationContext } from 'gbrain/operations';
import { applyEvalConfig, evalConfigRecord, type AppliedEvalConfig } from './eval-config.ts';
import { importGbrain, overlaySummary, productIdentityFor, type GbrainUnderTest } from './gbrain-under-test.ts';
import { gbrainPin } from './gbrain-version.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, noModelSpend, sourceTreeIdentity, type Receipt } from './receipt.ts';
import { McpHttpDriver, runCli, type RunEnv } from './lifecycle/drivers.ts';
import { startFakeEmbedder } from './lifecycle/fake-embedder.ts';
import { freePort } from './lifecycle/slice.ts';
import { appendAccessLog } from './sealed-confirmation-lib.ts';
import type { GoldEdge, RichPage } from './world-v1-gold.ts';

export interface StoredEdge extends GoldEdge { origin: string }

interface Engine {
  connect(c: object): Promise<void>;
  initSchema(): Promise<void>;
  disconnect(): Promise<void>;
  setConfig(key: string, value: string): Promise<void>;
  getConfig(key: string): Promise<string | null>;
  executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  readPageSnapshot(slug: string, o: { sourceId: string }): Promise<{ revision: unknown } | null>;
}
type OpHandler = (ctx: OperationContext, p: Record<string, unknown>) => Promise<unknown>;

export interface P5Brain {
  engine: Engine;
  applied: AppliedEvalConfig;
  /** Receipt block for the applied config. */
  configRecord: Record<string, unknown>;
  hasOp(name: string): boolean;
  op(name: string, params: Record<string, unknown>): Promise<unknown>;
  /** put_page; returns the write outcome (auto_links, similar_pages, ...). */
  put(slug: string, content: string): Promise<Record<string, unknown>>;
  sweep(): Promise<Record<string, unknown>>;
  edges(): Promise<StoredEdge[]>;
  close(): Promise<void>;
}

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

export async function openP5Brain(gut: GbrainUnderTest, config: Record<string, string>): Promise<P5Brain> {
  const { PGLiteEngine } = await importGbrain<{ PGLiteEngine: new () => Engine }>(gut, 'src/core/pglite-engine.ts');
  const { operations } = await importGbrain<{ operations: Array<{ name: string; handler: OpHandler }> }>(gut, 'src/core/operations.ts');
  const { extractStaleFromDB } = await importGbrain<{ extractStaleFromDB: (e: Engine, o: Record<string, unknown>) => Promise<Record<string, unknown>> }>(gut, 'src/commands/extract.ts');
  const { KNOWN_CONFIG_KEYS } = await importGbrain<{ KNOWN_CONFIG_KEYS?: readonly string[] }>(gut, 'src/core/config.ts');
  const engine = new PGLiteEngine();
  await engine.connect({});
  try {
    await engine.initSchema();
    const applied = await applyEvalConfig(engine, config);
    const ctx = { engine, config: { engine: 'pglite', database_path: ':memory:' }, logger: SILENT, dryRun: false, remote: false, sourceId: 'default' } as unknown as OperationContext;
    const byName = new Map(operations.map(o => [o.name, o]));
    const op = async (name: string, params: Record<string, unknown>) => {
      const o = byName.get(name);
      if (!o) throw new Error(`gbrain has no operation ${name}`);
      return await o.handler(ctx, params);
    };
    return {
      engine,
      applied,
      configRecord: evalConfigRecord(applied, KNOWN_CONFIG_KEYS ?? null),
      hasOp: name => byName.has(name),
      op,
      put: async (slug, content) => {
        const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
        const r = await op('put_page', { slug, content, ...(snapshot ? { expected_revision: snapshot.revision } : {}) }) as Record<string, unknown>;
        return (r.outcome ?? r) as Record<string, unknown>;
      },
      sweep: () => extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true, catchUp: true }),
      edges: async () => (await engine.executeRaw<{ from: string; to: string; type: string; origin: string | null }>(
        `SELECT f.slug AS "from", t.slug AS "to", l.link_type AS "type", o.slug AS origin
           FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
           LEFT JOIN pages o ON o.id = l.origin_page_id
          WHERE f.deleted_at IS NULL AND t.deleted_at IS NULL`)).map(r => ({ from: r.from, to: r.to, type: r.type, origin: r.origin ?? r.from })),
      close: () => engine.disconnect(),
    };
  } catch (e) {
    await engine.disconnect().catch(() => {});
    throw e;
  }
}

/** The part of a brain the forward-reference runner needs; both the in-process brain and the HTTP brain provide it. */
export type P5Writer = Pick<P5Brain, 'configRecord' | 'hasOp' | 'op' | 'put' | 'sweep' | 'edges' | 'close'>;

const HTTP_SOURCE = 'vault';
const HTTP_SWEEP_MAX_PASSES = 25;

/** The JSON object in a CLI's stdout (it may follow log lines). */
function stdoutJson(text: string): Record<string, unknown> {
  const at = text.indexOf('{');
  if (at < 0) throw new Error(`no JSON in output: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(at)) as Record<string, unknown>;
}

/**
 * The same writer over gbrain's HTTP transport, as a remote agent writes:
 * `gbrain serve --http` on a fresh PGLite brain under a throwaway GBRAIN_HOME
 * (a local fake embedder, no provider key), an OAuth client_credentials
 * client for one source, and put_page / wanted_pages / get_links over MCP.
 * A remote put_page saves link text without extracting it; the server points
 * remote writers to `gbrain sweep --once`, which delegates to the live server.
 * sweep() runs that command until a pass extracts and removes no link (at most
 * 25 passes), so one call is a complete sweep like the in-process catch-up.
 * Arm config is set with `gbrain config set --force` before the server starts
 * and read back with `gbrain config get`.
 */
export async function openP5HttpBrain(gut: GbrainUnderTest, config: Record<string, string>): Promise<P5Writer & { sweepPasses: number[] }> {
  const { operations } = await importGbrain<{ operations: Array<{ name: string }> }>(gut, 'src/core/operations.ts');
  const { KNOWN_CONFIG_KEYS } = await importGbrain<{ KNOWN_CONFIG_KEYS?: readonly string[] }>(gut, 'src/core/config.ts');
  const dir = mkdtempSync(join(tmpdir(), 'p5-http-'));
  const home = join(dir, 'gbrain-home');
  const userHome = join(dir, 'user-home');
  const vault = join(dir, 'vault');
  for (const d of [home, userHome, vault]) mkdirSync(d, { recursive: true });
  const embedder = startFakeEmbedder({ dims: 64 });
  const run: RunEnv = { buildDir: gut.root, env: {
    PATH: process.env.PATH, HOME: userHome, GBRAIN_HOME: home, LITELLM_BASE_URL: embedder.url,
    GBRAIN_SKIP_STARTUP_HOOKS: '1', TZ: 'UTC', LANG: 'C.UTF-8', NO_COLOR: '1',
  } };
  let driver: McpHttpDriver | null = null;
  const cleanup = async () => {
    await driver?.close().catch(() => {});
    embedder.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const cli = async (args: string[]) => {
      const r = await runCli(run, args, 600_000);
      if (r.code !== 0) throw new Error(`gbrain ${args.join(' ')} exited ${r.code}: ${(r.stderr || r.stdout).replace(/gbrain_cs_[0-9a-f]+/g, '<secret>').slice(-400)}`);
      return r;
    };
    execFileSync('git', ['init', '-q'], { cwd: vault });
    await cli(['init', '--pglite', '--path', join(home, 'brain.pglite'), '--embedding-model', 'litellm:fake-embed', '--embedding-dimensions', '64']);
    await cli(['sources', 'add', HTTP_SOURCE, '--path', vault, '--force']);
    await cli(['sources', 'default', HTTP_SOURCE]);
    const readback: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(config)) await cli(['config', 'set', k, v, '--force']);
    for (const k of Object.keys(config)) readback[k] = (await runCli(run, ['config', 'get', k])).stdout.trim() || null;
    const wrong = Object.keys(config).filter(k => readback[k] !== config[k]);
    if (wrong.length) throw new Error(`GBRAIN_EVAL_CONFIG: config did not read back as set over the CLI: ${wrong.map(k => `${k} set ${config[k]}, read ${readback[k]}`).join('; ')}`);
    const reg = await cli(['auth', 'register-client', 'p5-eval', '--grant-types', 'client_credentials', '--scopes', 'read write', '--source', HTTP_SOURCE]);
    const client = { id: reg.stdout.match(/gbrain_cl_[0-9a-f]+/)?.[0] ?? '', secret: reg.stdout.match(/gbrain_cs_[0-9a-f]+/)?.[0] ?? '' };
    if (!client.id || !client.secret) throw new Error('could not register an OAuth client for the HTTP arm');
    driver = new McpHttpDriver(run, await freePort(47_900), client);
    await driver.start();
    const names = new Set(operations.map(o => o.name));
    const written: string[] = [];
    const sweepPasses: number[] = [];
    const call = async (name: string, params: Record<string, unknown>) => {
      const r = await driver!.call(name, params);
      if (!r.ok) throw new Error(`${name} over HTTP failed: ${r.error}`);
      return r.data;
    };
    return {
      configRecord: { ...evalConfigRecord({ requested: { ...config }, readback }, KNOWN_CONFIG_KEYS ?? null), applied_with: 'gbrain config set --force before serve --http' },
      hasOp: name => names.has(name),
      op: call,
      put: async (slug, content) => {
        const data = await call('put_page', { slug, content }) as Record<string, unknown>;
        written.push(slug);
        return (data.outcome ?? data) as Record<string, unknown>;
      },
      sweep: async () => {
        let passes = 0;
        let extracted = 0;
        for (; passes < HTTP_SWEEP_MAX_PASSES; ) {
          const report = stdoutJson((await cli(['sweep', '--once', '--source', HTTP_SOURCE, '--json'])).stdout);
          passes++;
          const moved = Number(report.linksExtracted ?? 0) + Number(report.linksRemoved ?? 0);
          extracted += Number(report.linksExtracted ?? 0);
          if (moved === 0) break;
        }
        sweepPasses.push(passes);
        return { passes, links_extracted: extracted };
      },
      edges: async () => {
        const out: StoredEdge[] = [];
        for (const slug of [...new Set(written)]) {
          const rows = await call('get_links', { slug }) as Array<{ from_slug: string; to_slug: string; link_type: string; origin_slug?: string | null }>;
          for (const r of rows) out.push({ from: r.from_slug, to: r.to_slug, type: r.link_type, origin: r.origin_slug ?? r.from_slug });
        }
        return out;
      },
      close: cleanup,
      sweepPasses,
    };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

/** The page as gbrain serializes it (serializeMarkdown): frontmatter, compiled truth, `<!-- timeline -->`, timeline. */
export function renderWorldPage(p: Pick<RichPage, 'type' | 'title' | 'compiled_truth' | 'timeline'>): string {
  const body = p.timeline ? `${p.compiled_truth}\n\n<!-- timeline -->\n\n${p.timeline}` : p.compiled_truth;
  return `---\ntype: ${p.type}\ntitle: ${JSON.stringify(p.title)}\n---\n\n${body}\n`;
}

/** Distinct (from, to, type) triples. */
export function edgeKeys(edges: readonly GoldEdge[]): Set<string> {
  return new Set(edges.map(e => JSON.stringify([e.from, e.to, e.type])));
}

export function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) return argv[at + 1];
  return argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

export interface CustodyInput { parsed: { id: string; templates: unknown }; sha256: string }

/**
 * Custodian (held-out) mode, as eval/runner/temporal-edges.ts runs it:
 * `--phrasing-file <custody path> --decision-id <id> --purpose <text> --seeds <held-out seeds>`.
 * The access log beside the file gets a line before the content is used, and
 * callers record only the file's SHA-256. Without a phrasing file only dev
 * seeds run; held-out seeds belong to the custodian.
 */
export function custodyInput(argv: readonly string[], seeds: readonly number[], devSeeds: readonly number[]): CustodyInput | null {
  const phrasingFile = argValue(argv, '--phrasing-file');
  if (phrasingFile) {
    const decisionId = argValue(argv, '--decision-id');
    const purpose = argValue(argv, '--purpose');
    if (!decisionId || !purpose) throw new Error('custodian mode needs --decision-id and --purpose, recorded in the access log before the phrasing file is read');
    const bytes = readFileSync(phrasingFile);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    appendAccessLog(join(dirname(phrasingFile), 'access-log.jsonl'), { action: 'open', purpose, decision_id: decisionId, labels_sha256: sha256, run_sha256: null });
    const parsed = JSON.parse(bytes.toString('utf8')) as { id: string; templates: unknown };
    return { parsed, sha256 };
  }
  if (!seeds.every(s => devSeeds.includes(s))) throw new Error(`only dev seeds ${devSeeds.join(', ')} run here; held-out seeds belong to the custodian`);
  return null;
}

/** The receipt every P5 runner writes: rows under data.rows; a harness error makes the run an error (exit 3). */
export function p5Receipt(o: {
  category: string; gut: GbrainUnderTest; startedAt: string; basis: string;
  rows: ReadonlyArray<Record<string, unknown>>; summary: unknown; harnessError: string | null;
  resolvedConfig: Record<string, unknown>; hashes?: Record<string, string>;
}): Receipt {
  const n = o.rows.length;
  return {
    ...noModelSpend(o.basis),
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: o.category,
    run_status: o.harnessError ? 'error' : 'completed',
    ...(o.harnessError ? {} : { verdict: 'pass' as const }),
    n_total: n, n_scored: n, completion_rate: o.harnessError ? 0 : 1,
    errors: o.harnessError ? [{ probe_id: 'run', origin: 'harness' as const, message: o.harnessError }] : [],
    publishable: !o.harnessError,
    gbrain_version: o.gut.version,
    gbrain_pin: gbrainPin(),
    execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(o.gut) },
    resolved_config: { ...o.resolvedConfig, gbrain_overlay: overlaySummary(o.gut) },
    ...(o.hashes ? { hashes: o.hashes } : {}),
    started_at: o.startedAt,
    finished_at: new Date().toISOString(),
    data: { summary: o.summary, rows: o.rows, harness_error: o.harnessError },
  } as Receipt;
}

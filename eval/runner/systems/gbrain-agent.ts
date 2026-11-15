/**
 * The gbrain agent (SOTA loop decision D2a): gbrain's own retrieval tools, query, search and get_page, in the file
 * agent's Cat 40 loop. The two agents share one answer path (file-agent.ts answerWithArm): the turn cap, the effort, the
 * output limits, prose `submit_answer`, whole tool results, receipts, outcomes and the opened-source evidence. They
 * differ only in their tools and the system prompt that names them; AGENT_ARM_PARITY states the shared settings and
 * test/eval/gbrain-agent.test.ts checks them against both systems' requests.
 *
 *   tools    gbrain's own MCP tool list and dispatch, in process, through the neutral adapter (mcp-tools.ts):
 *            tools/list is `buildToolDefs` over the build's OPERATION_MANIFEST, the mapper `gbrain serve` lists its
 *            tools with, for the three tools; tools/call is `dispatchToolCall` with the options serve's stdio transport
 *            passes for a brain with one source (remote and untrusted, interactive admission, the stdio frame cap, takes
 *            holders `world`), its allow-set the three tools, so gbrain refuses any other name before resolving it.
 *            In process rather than a `gbrain serve` subprocess, so gbrain's own provider calls (query embeddings and
 *            the reranker) pass through this process's paid-request guard (budget-ledger.ts), which reserves each one
 *            in the ledger; a subprocess would send them past it. Left out of serve's handler: the hot-memory `_meta`
 *            hook (never model-visible), the once-per-process surface notice and the per-session tool reveal.
 *   ingest   the gbrain-shootout recipe (systems/gbrain.ts): one conversation page per session (slug `chat/<id>`,
 *            dated with the ISO event time), imported with gbrain's importFromContent, which writes the page, its
 *            chunks and their vectors before it returns. Bulk import runs no fact extraction (gbrain skips its facts
 *            backstop on import), so query's facts arm has no facts to add; the gbrain-defaults shim, which writes
 *            through put_page and drains facts in serve, differs there. One on-disk PGLite brain per namespace under
 *            the work directory, one open at a time.
 *   defaults the build's own: its default embedding model and dimensions, its default search mode and reranker, and no
 *            harness search pins (HELD_GBRAIN_DEFAULTS are not applied). At the pinned build `query` expands in no
 *            search mode unless the caller passes `expand`, and that argument stays the model's to set, as it is for
 *            any MCP client (AGENT_ARM_PARITY.query_expansion).
 *   keyless  `embed: 'hash'`: hash vectors in place of the embedding provider and the reranker off, so gbrain reaches
 *            no provider; for tests and smokes only.
 *   evidence `opened_source_ids`: the sessions whose page the agent read with a successful get_page, mapped back
 *            evaluator-side. Pages seen only in query or search results are not counted, as the file agent counts
 *            read_file and not grep.
 *
 * gbrain loads from the build under test (gbrain-under-test.ts: `--gbrain` or GBRAIN_UNDER_TEST, else the pinned
 * dependency). A cell behind a metering proxy is refused: gbrain's own calls would not reach the proxy.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScriptedModel } from '../cat40/loop.ts';
import { gbrainSpecFrom, importGbrain, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from '../gbrain-under-test.ts';
import { renderSessionPage } from '../memory-qa/corpus.ts';
import { hashEmbed } from '../memory-qa/run-systems.ts';
import { FRONTIER_READERS } from './baselines.ts';
import { AttemptReceipts, answerWithArm, FILE_AGENT_EFFORT, FILE_AGENT_MAX_TURNS, PROSE_ANSWER_TOOL, proxiedFetch, type AgentAnswer, type AnswerOptions, type AnsweringSystem } from './file-agent.ts';
import { slugOf } from './gbrain.ts';
import { mcpToolArm, type McpTool, type McpToolResult } from './mcp-tools.ts';
import { SystemError, type CapabilityRecord, type DeleteResult, type FinishResult, type IngestResult, type PublicQuestion, type RetrieveResult, type SessionInput } from './types.ts';

export const GBRAIN_AGENT_TOOLS = ['query', 'search', 'get_page'] as const;

export const GBRAIN_AGENT_SYSTEM = 'You answer a question about your past conversations with a user. Every past conversation session is a page in a gbrain knowledge base, with a slug of the form chat/<id>. Each page has frontmatter holding the session\'s date and time, followed by the turns, one per paragraph, as "**speaker:** text". Use query, search and get_page to find and read the sessions that answer the question, then call submit_answer with your answer. You cannot change the pages.';

/**
 * What the gbrain agent shares with the file agent, and what differs. Output limits are the Cat 40 loop's defaults,
 * which neither agent overrides; the readers are the SOTA loop's three.
 */
export const AGENT_ARM_PARITY = {
  loop: 'eval/runner/cat40/loop.ts runAgent, through file-agent.ts answerWithArm',
  max_turns: FILE_AGENT_MAX_TURNS,
  effort: FILE_AGENT_EFFORT,
  max_tool_chars: null,
  output_tokens: { anthropic: 8192, openai: 16_000, particle: 16_000 },
  submit_tool: PROSE_ANSWER_TOOL.name,
  user_turn: 'Current Date: <query time>\nQuestion: <question>',
  readers: [...FRONTIER_READERS, 'particle:particle-1'],
  receipts: { 'baseline-file-agent': 'q1-file-agent', 'gbrain-defaults': 'q1-gbrain-agent' },
  evidence: { 'baseline-file-agent': 'read_file', 'gbrain-defaults': 'get_page' },
  tools: { 'baseline-file-agent': ['list_dir', 'grep', 'read_file'], 'gbrain-defaults': [...GBRAIN_AGENT_TOOLS] },
  query_expansion: 'gbrain\'s default: query expands in no search mode unless the call passes expand, which the model may do; search never expands',
} as const;

/** Keyless mode only: no reranker, since hash vectors stand in for the provider (the keyless convention of budgeted-delivery/c8k-product.ts). */
const KEYLESS_SETTINGS: Readonly<Record<string, string>> = Object.freeze({ 'search.reranker.enabled': 'false' });
const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

interface GbrainAgentModules {
  PGLiteEngine: new () => any;
  importFromContent: (e: unknown, slug: string, content: string, o?: Record<string, unknown>) => Promise<{ embedding_deferred?: boolean }>;
  dispatchToolCall: (e: unknown, name: string, params: Record<string, unknown>, opts: Record<string, unknown>) => Promise<McpToolResult>;
  tools: McpTool[];
  frameBytes: number;
  embedding: { model: string; dimensions: number };
  gut: GbrainUnderTest;
}

export interface GbrainAgentOptions {
  /** Where namespace brains are written; default a fresh directory under the OS temp dir. */
  workDir?: string;
  /** `hash`: keyless vectors and no reranker; default the build's own embedding provider. */
  embed?: 'hash' | 'real';
  /** The gbrain build; default the one `--gbrain` or GBRAIN_UNDER_TEST names, else the pinned dependency. */
  gbrain?: GbrainUnderTest;
  maxTurns?: number;
  fetchImpl?: typeof fetch;
  /** Keyless mode: a scripted model per question replaces the provider. */
  scripted?: (q: PublicQuestion) => ScriptedModel;
  /** Reasoning effort on every loop call (default FILE_AGENT_EFFORT). */
  effort?: string;
}

export class GbrainAgentSystem implements AnsweringSystem {
  readonly name = 'gbrain-agent';
  /** Every provider attempt's receipt, one per line. */
  readonly receiptsPath: string;
  private workDir: string;
  private receipts: AttemptReceipts;
  private mods: Promise<GbrainAgentModules> | null = null;
  /** Per namespace: page slug to the ingested source id. */
  private sources = new Map<string, Map<string, string>>();
  private open: { ns: string; engine: Promise<any> } | null = null;

  constructor(private opts: GbrainAgentOptions = {}) {
    this.workDir = opts.workDir ?? mkdtempSync(join(tmpdir(), 'gbrain-agent-'));
    this.receiptsPath = join(this.workDir, 'receipts.ndjson');
    this.receipts = new AttemptReceipts(this.receiptsPath, 'q1-gbrain-agent');
  }

  private modules(): Promise<GbrainAgentModules> {
    return this.mods ??= (async () => {
      const gut = this.opts.gbrain ?? resolveGbrainUnderTest(gbrainSpecFrom(process.argv));
      const load = <T>(rel: string) => importGbrain<T>(gut, rel);
      const [defaults, gateway, pg, imp, disp, defs, manifest, srv] = await Promise.all([
        load<{ DEFAULT_EMBEDDING_MODEL: string; DEFAULT_EMBEDDING_DIMENSIONS: number }>('src/core/ai/defaults.ts'),
        load<{ configureGateway: (c: Record<string, unknown>) => void; __setEmbedTransportForTests: (fn: unknown) => void }>('src/core/ai/gateway.ts'),
        load<{ PGLiteEngine: GbrainAgentModules['PGLiteEngine'] }>('src/core/pglite-engine.ts'),
        load<{ importFromContent: GbrainAgentModules['importFromContent'] }>('src/core/import-file.ts'),
        load<{ dispatchToolCall: GbrainAgentModules['dispatchToolCall'] }>('src/mcp/dispatch.ts'),
        load<{ buildToolDefs: (ops: unknown[], o?: { strictParams?: boolean }) => McpTool[] }>('src/mcp/tool-defs.ts'),
        load<{ OPERATION_MANIFEST: Array<{ name: string }> }>('src/core/operation-manifest.generated.ts'),
        load<{ MCP_STDIO_MAX_MESSAGE_BYTES: number }>('src/mcp/server.ts'),
      ]);
      const embedding = { model: defaults.DEFAULT_EMBEDDING_MODEL, dimensions: defaults.DEFAULT_EMBEDDING_DIMENSIONS };
      const hash = this.opts.embed === 'hash';
      const keyEnv = `${embedding.model.split(':')[0].toUpperCase()}_API_KEY`;
      gateway.configureGateway({ embedding_model: embedding.model, embedding_dimensions: embedding.dimensions, env: hash ? { ...process.env, [keyEnv]: 'hash-embed-transport-no-provider-call' } : process.env });
      gateway.__setEmbedTransportForTests(hash
        ? async (p: { values: string[] }) => ({ embeddings: p.values.map(v => hashEmbed(v, embedding.dimensions)), values: p.values, warnings: [], usage: { tokens: 0 } })
        : null);
      const tools = defs.buildToolDefs(manifest.OPERATION_MANIFEST.filter(o => (GBRAIN_AGENT_TOOLS as readonly string[]).includes(o.name)), { strictParams: false });
      return { PGLiteEngine: pg.PGLiteEngine, importFromContent: imp.importFromContent, dispatchToolCall: disp.dispatchToolCall, tools, frameBytes: srv.MCP_STDIO_MAX_MESSAGE_BYTES, embedding, gut };
    })();
  }

  private settings(): Record<string, string> { return this.opts.embed === 'hash' ? { ...KEYLESS_SETTINGS } : {}; }

  private databasePath(ns: string) { return join(this.workDir, ns, 'brain.pglite'); }

  /** The namespace's brain, opened (and created when `fresh`, after the old one is deleted); the brain open before is closed. */
  private brain(ns: string, fresh = false): Promise<any> {
    if (!fresh && this.open?.ns === ns) return this.open.engine;
    const before = this.open?.engine;
    const engine = (async () => {
      if (before) await before.then(e => e.disconnect()).catch(() => {});
      const m = await this.modules();
      if (fresh) rmSync(join(this.workDir, ns), { recursive: true, force: true });
      mkdirSync(join(this.workDir, ns), { recursive: true });
      const e = new m.PGLiteEngine();
      await e.connect({ database_path: this.databasePath(ns) });
      await e.initSchema();
      if (fresh) for (const [k, v] of Object.entries(this.settings())) await e.setConfig(k, v);
      return e;
    })();
    this.open = { ns, engine };
    return engine;
  }

  private slugs(ns: string): Map<string, string> {
    const s = this.sources.get(ns);
    if (!s) throw new SystemError('invalid_request', `namespace ${ns} has no brain: reset(ns) first`);
    return s;
  }

  async capabilities(): Promise<CapabilityRecord> {
    const m = await this.modules();
    const identity = productIdentityFor(m.gut);
    return {
      system: this.name, protocol: 1,
      versions: { package: identity.version, commit: identity.loaded_git_head ?? identity.declared_sha, package_sha256: identity.package_sha256, image: null, lock_sha256: null, vendor_benchmark_code: null },
      configs: { common: { model_roles: { agent: 'the reader of the cell', embedder: `${m.embedding.model}@${m.embedding.dimensions}` }, notes: 'Cat 40 loop over gbrain\'s own query, search and get_page (in-process MCP dispatch); turn cap 40' } },
      time: 'native', provenance: { status: 'exact', mechanism: 'one page per ingested session; pages the agent read with get_page map back to their sessions evaluator-side' },
      delete: 'native', readiness: 'synchronous: import returns after the page, its chunks and their vectors are written', namespace: 'one on-disk PGLite brain per namespace, one open at a time', parallel_namespaces: false,
      retrieval_policies: { 'vendor-default': { supported: false }, 'fixed-evidence': { supported: false } },
      streaming: 'disabled', telemetry_off: [], agent_surface: { kind: 'native-agent' },
      deviations_from_vendor_code: ['pages imported in bulk with importFromContent, so no fact extraction runs', ...(this.opts.embed === 'hash' ? ['keyless: hash vectors and the reranker off'] : [])],
      tools: [...GBRAIN_AGENT_TOOLS], brain_settings: this.settings(), max_turns: this.opts.maxTurns ?? FILE_AGENT_MAX_TURNS, effort: this.opts.effort ?? FILE_AGENT_EFFORT,
    };
  }

  async reset(ns: string) {
    await this.brain(ns, true);
    this.sources.set(ns, new Map());
  }

  async ingestSession(ns: string, s: SessionInput, event_time: string | null): Promise<IngestResult> {
    const slugs = this.slugs(ns);
    const engine = await this.brain(ns);
    const m = await this.modules();
    const slug = slugOf(s.source_id);
    const page = renderSessionPage({ id: s.source_id, date: event_time ?? undefined, turns: s.turns.map(t => ({ speaker: t.speaker, content: t.content })) }, { as: 'conversation' });
    const res = await m.importFromContent(engine, slug, page, {});
    slugs.set(slug, s.source_id);
    return res?.embedding_deferred
      ? { items_created: 1, warnings: ['embedding_deferred'], errors: [], completeness: 'degraded' }
      : { items_created: 1, warnings: [], errors: [], completeness: 'known' };
  }

  async finishIngest(ns: string): Promise<FinishResult> {
    this.slugs(ns);
    return { ready: true, waited_ms: 0, completeness: 'known' };
  }

  async retrieve(): Promise<RetrieveResult> { throw new SystemError('unsupported', 'the gbrain agent answers whole questions; it has no passive retrieval', 501); }

  async deleteSource(ns: string, src: string): Promise<DeleteResult> {
    const slugs = this.slugs(ns);
    const engine = await this.brain(ns);
    await engine.deletePage(slugOf(src));
    slugs.delete(slugOf(src));
    return { status: 'deleted', receipt: { page: 'deleted through BrainEngine.deletePage' } };
  }

  async answer(ns: string, q: PublicQuestion, opts: AnswerOptions): Promise<AgentAnswer> {
    const slugs = this.slugs(ns);
    const engine = await this.brain(ns);
    const m = await this.modules();
    const dispatch = { remote: true, admissionOrigin: 'interactive', transport: 'stdio', inboundFrameBytes: m.frameBytes, takesHoldersAllowList: ['world'], sourceId: 'default', surface: 'full',
      allowedOps: new Set<string>(GBRAIN_AGENT_TOOLS), config: { engine: 'pglite', database_path: this.databasePath(ns) }, logger: SILENT };
    const arm = await mcpToolArm('gbrain', { listTools: async () => m.tools, callTool: (name, args) => m.dispatchToolCall(engine, name, args, dispatch) }, GBRAIN_AGENT_TOOLS);
    return answerWithArm(ns, q, opts, {
      arm, system: GBRAIN_AGENT_SYSTEM, maxTurns: this.opts.maxTurns ?? FILE_AGENT_MAX_TURNS, effort: this.opts.effort ?? FILE_AGENT_EFFORT,
      fetchImpl: this.opts.fetchImpl ?? proxiedFetch(), scripted: this.opts.scripted?.(q), receipts: this.receipts,
      opened: run => {
        const opened: string[] = [];
        for (const t of run.tools) {
          if (t.name !== 'get_page' || t.error) continue;
          const src = slugs.get(/"slug":"([^"]+)"/.exec(t.result)?.[1] ?? String(t.args.slug ?? ''));
          if (src && !opened.includes(src)) opened.push(src);
        }
        return opened;
      },
    });
  }

  async close() {
    const engine = this.open?.engine;
    this.open = null;
    if (engine) await engine.then(e => e.disconnect()).catch(() => {});
    if (!this.opts.workDir) rmSync(this.workDir, { recursive: true, force: true });
  }
}

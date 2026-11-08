/**
 * Live recall phase 2: the four arms, the gbrain reader they share, and one episode end to end.
 *
 * Every gbrain read goes through gbrain's own MCP dispatcher (src/mcp/dispatch.ts, dispatchToolCall) as an untrusted
 * remote stdio caller (remote: true), the posture gbrain gives agents: pages flagged private and unsafe chunks stay
 * hidden. The dispatcher runs on phase 1's guarded engine (brain.ts), inside gbrain's AI invocation guard, which allows
 * only embedding and rerank calls; a refused call (query expansion, a chat or decide call) is counted. Each query and
 * search call's retrieval meta is captured through the dispatcher's metaHook, and a call that reports one of phase 1's
 * FAILURE_STAGES, or returns no meta at all, marks its episode degraded whatever its stop, so a silent embedding or
 * rerank failure never becomes a counted keyword-only answer or no-answer.
 *
 *   A  no retrieval: no tools but submit_answer.
 *   B  gbrain's query, search and get_page tools, as gbrain's tool definitions describe them (expand removed and forced off;
 *      source_id and source_ids removed, so every call reads the reader's own source).
 *   C  a summariser loop with B's tools that submits a cited summary, then a tool-less answerer given the summary alone.
 *   D  phase 1's configured-arm hybridSearch on the question (expansion off, private pages excluded, the reader's own
 *      source), the first five distinct pages opened with get_page and pasted in; one tool-less call.
 *
 * Every model call goes through Cat 40's loop (eval/runner/cat40/loop.ts) at medium effort, with store false on OpenAI.
 */
import { HarnessError, runAgent, type AgentRun, type Arm, type ProviderAttempt, type ToolSpec, type Usage } from '../cat40/loop.ts';
import { importGbrain, type GbrainUnderTest } from '../gbrain-under-test.ts';
import { uniqueInOrder } from '../metrics.ts';
import { ParticleCreditExhausted } from '../providers/openai-compatible.ts';
import { LiveRecallAbort } from './brain.ts';
import { FAILURE_STAGES } from './run.ts';
import { JUDGE_PAGE_CHARS, JUDGE_SYSTEM, JUDGED_CITATIONS, VERDICT_TOOL, derive, judgeUser, parseVerdict, type Derived, type Verdict } from './task-judge.ts';

export const ARMS = ['A', 'B', 'C', 'D'] as const;
export type TaskArm = (typeof ARMS)[number];
export const FORMS = ['paraphrase', 'exact'] as const;
export type TaskForm = (typeof FORMS)[number];
export const TOOL_NAMES = ['query', 'search', 'get_page'] as const;
/**
 * Parameters removed from gbrain's tool definitions: expansion is forced off, images are out of scope, and every call
 * stays in the reader's own source.
 */
const DROPPED_PARAMS = ['expand', 'image', 'image_mime', 'source_id', 'source_ids'];
export const EFFORT = 'medium';
export const MAX_TURNS = 12;
export const MAX_OUTPUT_TOKENS = 8192;
export const TOOL_RESULT_CHARS = 16_000;
export const PASTE_PAGES = 5;
export const PASTE_CHARS = 8_000;
export const SUMMARY_WORDS = 300;
const CALL_TIMEOUT_MS = 120_000;
const RERANK_FAILURE_STAGES = new Set(['rerank_failed', 'rerank_passthrough']);

export interface Task {
  id: string;
  type: 'identifier' | 'error_string' | 'time_window' | 'cross_source' | 'topic';
  source_question: string | null;
  forms: Record<TaskForm, string>;
  gold_pages: string[];
  gold_answer: { text: string; required_facts: Array<{ id: string; fact: string }>; acceptable_variants?: string[] };
  window?: { since: string; until: string };
  gold_found_by: string;
}

// ─── Prompts (frozen in docs/benchmarks/live-recall/PHASE2-PREREGISTRATION.md) ────────────────────────────────────────

const CITE = 'Finish by calling submit_answer exactly once. Write the answer as a short paragraph. After each claim that comes from one of Garry\'s pages, put that page\'s slug in square brackets, for example [people/jane-doe]. List every slug you cite in sources. If you cannot find the answer, say so plainly instead of guessing.';
export const PROMPTS = {
  A: 'You are answering a question for Garry Tan. Garry\'s notes are not available in this setting, so answer from what you know, and say plainly when you do not know. ' + CITE,
  B: 'You are answering a question for Garry Tan. You can search his notes with the gbrain tools listed (query, search and get_page). Look up what you need before you answer, and cite only pages you have read. ' + CITE,
  C_SUMMARISER: 'You are a research helper for an assistant that answers questions for Garry Tan. Search his notes with the gbrain tools listed (query, search and get_page) and read what is relevant. Then call submit_answer exactly once with a summary of at most ' + SUMMARY_WORDS + ' words that answers the question, with the slug of the supporting page in square brackets after each claim, for example [people/jane-doe], and every slug you cite in sources. The assistant will answer from your summary alone. If the notes do not hold the answer, say so plainly.',
  C_ANSWERER: 'You are answering a question for Garry Tan. A research helper searched his notes and wrote the summary below. Answer from the summary, and cite only slugs the summary cites. ' + CITE,
  D: 'You are answering a question for Garry Tan. The pages of his notes that his search ranked highest for this question are below. Answer from them, and cite only these pages. ' + CITE,
};

export const ANSWER_TOOL: ToolSpec = {
  name: 'submit_answer',
  description: 'Submit your final answer. Call this exactly once, when you are done.',
  input_schema: {
    type: 'object',
    properties: {
      answer: { type: 'string', description: 'A short paragraph that answers the question, with the page slug in square brackets after each claim taken from a page. Say plainly if the answer is not available.' },
      sources: { type: 'array', items: { type: 'string' }, description: 'Every page slug you cited.' },
    },
    required: ['answer', 'sources'],
  },
};

export const SUMMARY_TOOL: ToolSpec = {
  name: 'submit_answer',
  description: 'Submit your summary for the answering assistant. Call this exactly once, when you are done.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'At most ' + SUMMARY_WORDS + ' words that answer the question, with the page slug in square brackets after each claim.' },
      sources: { type: 'array', items: { type: 'string' }, description: 'Every page slug you cited.' },
    },
    required: ['summary', 'sources'],
  },
};

// ─── The gbrain reader ─────────────────────────────────────────────────────────────────────────────────────────────

type Kind = 'chat' | 'embedding' | 'rerank' | 'multimodal' | 'decide' | 'transcription';
export interface CallOutcome { text: string; isError: boolean; degraded: string[]; metaMissing: boolean; aiRefused: string[] }

export interface GbrainReader {
  readonly tools: ToolSpec[];
  readonly sourceId: string;
  call(name: string, args: Record<string, unknown>): Promise<CallOutcome>;
  /** get_page as the remote caller sees it; null when gbrain does not return the page. */
  page(slug: string): Promise<string | null>;
  /** The page is returned to a remote caller and has at least one chunk it may read. */
  reachable(slug: string): Promise<boolean>;
  /** The page is live in another source and not in the reader's, so no call from the reader's source can reach it. */
  outOfSource(slug: string): Promise<boolean>;
  /** D's search: phase 1's configured arm with private pages excluded, in the reader's source. */
  top(text: string): Promise<{ slugs: string[]; degraded: string[]; aiRefused: string[] }>;
}

/**
 * `capped` reports that the run's budget guard has refused a reservation. gbrain catches a refused embedding or rerank
 * call and degrades the search, so the reader checks it after every call and ends the episode with a HarnessError; the
 * episode's capCheck then turns that into the run's cap stop.
 */
export async function openReader(gut: GbrainUnderTest, engine: any, rerankerEnabled: boolean, capped: () => boolean = () => false): Promise<GbrainReader> {
  const [dispatch, ops, toolDefs, server, invocation, hybrid] = await Promise.all([
    importGbrain<any>(gut, 'src/mcp/dispatch.ts'), importGbrain<any>(gut, 'src/core/operations.ts'), importGbrain<any>(gut, 'src/mcp/tool-defs.ts'),
    importGbrain<any>(gut, 'src/mcp/server.ts'), importGbrain<any>(gut, 'src/core/ai/invocation-guard.ts'), importGbrain<any>(gut, 'src/core/search/hybrid.ts'),
  ]);
  const scope = await server.resolveMcpStdioSourceScope(engine);
  const sourceId = String(scope?.sourceId ?? 'default');
  const chosen = (ops.operations as Array<{ name: string }>).filter(o => (TOOL_NAMES as readonly string[]).includes(o.name));
  if (chosen.length !== TOOL_NAMES.length) throw new Error('the loaded gbrain lacks one of ' + TOOL_NAMES.join(', '));
  const tools: ToolSpec[] = (toolDefs.buildToolDefs(chosen) as Array<{ name: string; description: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }>).map(t => {
    const properties = Object.fromEntries(Object.entries(t.inputSchema.properties).filter(([k]) => !DROPPED_PARAMS.includes(k)));
    return { name: t.name, description: t.description, input_schema: { ...t.inputSchema, properties, required: (t.inputSchema.required ?? []).filter(k => !DROPPED_PARAMS.includes(k)) } };
  });
  const guarded = async <T>(refused: string[], run: () => Promise<T>): Promise<T> => {
    const guard = async (c: { kind: Kind }) => {
      if (c.kind !== 'embedding' && c.kind !== 'rerank') { refused.push(c.kind); throw new Error('live-recall refused a ' + c.kind + ' call'); }
      return { settle: async () => {} };
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        invocation.withAIInvocationGuard(guard, run) as Promise<T>,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HarnessError('gbrain gave no answer in ' + CALL_TIMEOUT_MS / 1000 + ' s')), CALL_TIMEOUT_MS); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  const stages = (meta: any) => ((meta?.degraded ?? []) as Array<{ stage?: unknown }>).map(d => String(d?.stage)).filter(s => /^[a-z_]+$/.test(s));
  const call = async (name: string, args: Record<string, unknown>): Promise<CallOutcome> => {
    if (!(TOOL_NAMES as readonly string[]).includes(name)) return { text: 'Error: unknown tool ' + name, isError: true, degraded: [], metaMissing: false, aiRefused: [] };
    const params: Record<string, unknown> = Object.fromEntries(Object.entries(args).filter(([k]) => !DROPPED_PARAMS.includes(k)));
    if (name === 'query') params.expand = false;
    let meta: unknown = null;
    const refused: string[] = [];
    const metaHook = async (_name: string, ctx: { emitResponseMeta?: (k: string, v: unknown) => void }) => {
      const previous = ctx.emitResponseMeta;
      ctx.emitResponseMeta = (k, v) => { if (k === 'retrieval') meta = v; previous?.(k, v); };
      return undefined;
    };
    let r: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    try {
      r = await guarded(refused, () => dispatch.dispatchToolCall(engine, name, params, { remote: true, transport: 'stdio', sourceId, metaHook }));
    } catch (e) {
      if (e instanceof HarnessError || (e as Error).name === 'BudgetExceededError') throw e;
      return { text: 'Error: ' + (e as Error).message, isError: true, degraded: [], metaMissing: false, aiRefused: refused };
    }
    if (capped()) throw new HarnessError('the budget guard refused a provider call inside gbrain');
    const text = (r.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
    const isError = r.isError === true;
    return { text: isError ? 'Error: ' + text : text, isError, degraded: stages(meta), metaMissing: name !== 'get_page' && !isError && meta === null, aiRefused: refused };
  };
  const page = async (slug: string) => {
    const r = await call('get_page', { slug });
    return r.isError || !r.text.includes('"slug"') ? null : r.text;
  };
  const chunkCount = async (slug: string) => {
    const r = await guarded([], () => dispatch.dispatchToolCall(engine, 'get_chunks', { slug }, { remote: true, transport: 'stdio', sourceId })) as { content?: Array<{ text?: string }>; isError?: boolean };
    return r.isError ? 0 : ((r.content ?? []).map(c => c.text ?? '').join('\n').match(/"chunk_index"/g) ?? []).length;
  };
  return {
    tools, sourceId, call, page,
    reachable: async (slug: string) => (await page(slug)) !== null && (await chunkCount(slug)) > 0,
    outOfSource: async (slug: string) => {
      const [row] = await engine.executeRaw('SELECT bool_or(source_id = $2) AS own, bool_or(source_id <> $2) AS other FROM pages WHERE slug = $1 AND deleted_at IS NULL', [slug, sourceId]) as Array<{ own: boolean | null; other: boolean | null }>;
      return row?.other === true && row.own !== true;
    },
    top: async (text: string) => {
      let meta: unknown = null;
      const refused: string[] = [];
      let results: Array<{ slug: string; rerank_score?: unknown }>;
      try {
        results = ((await guarded(refused, () => hybrid.hybridSearch(engine, text, { expansion: false, crossModal: 'text', excludePrivate: true, requireSafeChunks: true, sourceId, onMeta: (m: unknown) => { meta = m; } }))) ?? []) as typeof results;
      } catch (e) {
        if (e instanceof HarnessError || (e as Error).name === 'BudgetExceededError') throw e;
        throw new HarnessError('gbrain search failed: ' + (e as Error).message);
      }
      if (capped()) throw new HarnessError('the budget guard refused a provider call inside gbrain');
      const degraded = stages(meta);
      if (rerankerEnabled && results.length > 0 && !results.some(x => typeof x.rerank_score === 'number') && !degraded.some(s => RERANK_FAILURE_STAGES.has(s))) degraded.push('rerank_passthrough');
      return { slugs: uniqueInOrder(results.map(x => String(x.slug))).slice(0, PASTE_PAGES), degraded, aiRefused: refused };
    },
  };
}

// ─── Arms ──────────────────────────────────────────────────────────────────────────────────────────────────────────

interface ToolCall { name: string; slug: string | null; ok: boolean; slugs: string[] }

/** B's tools, and C's summariser's: gbrain's three read operations through the reader, with what each call showed. */
class GbrainArm implements Arm {
  readonly name = 'gbrain';
  readonly calls: ToolCall[] = [];
  readonly stages: string[] = [];
  metaMissing = 0;
  readonly refused: string[] = [];
  constructor(private reader: GbrainReader) {}
  systemHint() { return ''; }
  tools() { return this.reader.tools; }
  writeTools() { return []; }
  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const r = await this.reader.call(name, args);
    this.stages.push(...r.degraded);
    this.refused.push(...r.aiRefused);
    if (r.metaMissing) this.metaMissing++;
    this.calls.push({ name, slug: name === 'get_page' && typeof args.slug === 'string' ? args.slug : null, ok: !r.isError, slugs: slugsIn(r.text) });
    return r.text;
  }
}

const NO_TOOLS: Arm = { name: 'none', systemHint: () => '', tools: () => [], writeTools: () => [], call: async name => { throw new Error('no tool ' + name); } };

const slugsIn = (text: string) => uniqueInOrder([...text.matchAll(/"slug"\s*:\s*"([^"\\]{1,300})"/g)].map(m => m[1]!));
const SLUG = /^(?!\d+$)[A-Za-z0-9][A-Za-z0-9._\/-]{0,299}$/;

/**
 * Slugs an answer cites: inline [slug] markers that hold a '/' or name a page the episode saw (so [TBD] is no citation),
 * then its sources list, in order, deduplicated.
 */
export function citedSlugs(answer: string, sources: unknown, seen: readonly string[]): string[] {
  const inline = [...answer.matchAll(/\[([^\[\]\s]{1,300})\]/g)].map(m => m[1]!).filter(s => s.includes('/') || seen.includes(s));
  const listed = Array.isArray(sources) ? sources.filter((s): s is string => typeof s === 'string').map(s => s.trim().replace(/^\[|\]$/g, '')) : [];
  return uniqueInOrder([...inline, ...listed].filter(s => SLUG.test(s)));
}

// ─── Episodes ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const STATUSES = ['answered', 'no_answer', 'context_overflow', 'model_error', 'harness_error', 'timed_out', 'degraded'] as const;
export type Status = (typeof STATUSES)[number];
/** Counted outcomes; every other status is excluded with its count (PHASE2-PREREGISTRATION.md, "Episode stop mapping"). */
export const COUNTED: ReadonlySet<Status> = new Set(['answered', 'no_answer', 'context_overflow', 'model_error']);
/** Attempts per episode: the first and at most two reruns, for harness errors only. */
export const MAX_ATTEMPTS = 3;

export interface RoleUse { usage: Usage; usd: number; turns: number; ms: number; stop: string; tool_calls: number }
export interface Exposure {
  tool_calls: number; searched: boolean; gold_seen: boolean; gold_opened: boolean; gold_cited: boolean;
  summary_gold_cited: boolean | null; pasted_gold: boolean | null;
}
export interface AnswerRecord {
  kind: 'answer'; key: string; task: string; form: TaskForm; arm: TaskArm; model: string; attempt: number; status: Status;
  answer: string; cited: string[]; exposure: Exposure; stages: string[]; meta_missing: number; ai_refused: string[];
  roles: { answer?: RoleUse; summariser?: RoleUse };
  /** Cited pages as gbrain returned them right after the answer, for the judge. */
  snapshots: Array<{ slug: string; text: string | null }>;
  slugs_seen: string[]; ms: number; at: string; error: string | null;
}
export interface JudgeRecord {
  /** judge: the counted verdict; judge2: the descriptive second judge; label: a judge-check labeller. */
  kind: 'judge' | 'judge2' | 'label'; key: string; judge: string;
  /** The model version the provider reports serving (its response's `model`), null when no response carried one. */
  judge_version: string | null; effort: string; status: 'ok' | 'judge_error'; verdict: Verdict | null; derived: Derived | null;
  usd: number; usage: Usage; ms: number; at: string;
}

export const episodeKey = (form: TaskForm, task: string, arm: TaskArm, model: string) => [form, task, arm, model].join('|');

export interface EpisodeContext {
  reader: GbrainReader;
  /** Runs a model call inside its provider's concurrency limit. */
  limit: <T>(model: string, run: () => Promise<T>) => Promise<T>;
  /** Throws the run's cap stop (the guard's BudgetExceededError) once the budget guard has refused a reservation. */
  capCheck: () => void;
}

/**
 * Stops the run when the provider refused the key, the model or the account (401, 403, 404, any other 4xx but 400, a
 * 400 that refuses credit or billing, or OpenAI's 429 `insufficient_quota` after the retries): nothing the model did, so
 * it is never a counted answer, a harness error or a judge error.
 */
function assertAccepted(run: AgentRun): void {
  const p = run.provider_error;
  if (p && p.status >= 400 && p.status < 500 && (p.status !== 400 || p.billing)) throw new LiveRecallAbort('LR_PROVIDER_REJECTED', run.model + ' answered HTTP ' + p.status + (p.billing ? ' refusing credit or billing' : ''));
}

/** Only a model-caused 400 is a counted model_error; a network failure, an unreadable answer or a non-retryable 5xx is a harness error. */
function statusOf(run: AgentRun): Status {
  assertAccepted(run);
  if (run.timed_out) return 'timed_out';
  if (run.stop === 'submitted') return 'answered';
  if (run.stop === 'turn_cap' || run.stop === 'no_tool_call') return 'no_answer';
  if (run.stop === 'context_overflow' || run.stop === 'harness_error') return run.stop;
  return run.provider_error?.status === 400 ? 'model_error' : 'harness_error';
}

const use = (run: AgentRun, toolCalls: number): RoleUse => ({ usage: run.usage, usd: run.usd, turns: run.turns, ms: run.ms, stop: run.stop, tool_calls: toolCalls });
const loopConfig = (model: string) => ({ model, effort: EFFORT, maxTurns: MAX_TURNS, maxOutputTokens: MAX_OUTPUT_TOKENS, maxToolChars: TOOL_RESULT_CHARS, classifyStops: true, openaiStore: false as const });

/**
 * One answer for one task form, arm and model. Model calls that fail for the provider's reasons come back as a status, a
 * HarnessError (gbrain timing out) comes back as harness_error, and a cap refusal or a provider rejection
 * (LR_PROVIDER_REJECTED, Particle's empty prepaid balance included) throws, so no record is written.
 */
export async function runEpisode(ctx: EpisodeContext, task: Task, form: TaskForm, arm: TaskArm, model: string, attempt: number): Promise<AnswerRecord> {
  const question = task.forms[form];
  const t0 = Date.now();
  const roles: AnswerRecord['roles'] = {};
  const stages: string[] = [];
  const refused: string[] = [];
  let metaMissing = 0;
  let calls: ToolCall[] = [];
  let summaryCited: string[] | null = null;
  let pasted: string[] | null = null;
  const gather = (g: GbrainArm) => { stages.push(...g.stages); refused.push(...g.refused); metaMissing += g.metaMissing; calls = calls.concat(g.calls); };
  const record = (status: Status, run: AgentRun | null, extra: Partial<AnswerRecord> = {}): AnswerRecord => ({
    kind: 'answer', key: episodeKey(form, task.id, arm, model), task: task.id, form, arm, model, attempt, status,
    answer: '', cited: [], exposure: exposure(task, calls, [], summaryCited, pasted), stages: uniqueInOrder(stages), meta_missing: metaMissing, ai_refused: refused, roles,
    snapshots: [], slugs_seen: uniqueInOrder([...calls.flatMap(c => c.slugs), ...(pasted ?? [])]), ms: Date.now() - t0, at: new Date().toISOString(), error: run?.error ?? null, ...extra,
  });

  const ask = async (cfg: Parameters<typeof runAgent>[0]) => {
    const r = await ctx.limit(model, () => runAgent(cfg));
    ctx.capCheck();
    return r;
  };
  try {
    return await answer();
  } catch (e) {
    ctx.capCheck();
    if (e instanceof HarnessError) return record('harness_error', null, { error: e.message });
    if (e instanceof ParticleCreditExhausted) throw new LiveRecallAbort('LR_PROVIDER_REJECTED', model + ' answered HTTP 402: the Particle prepaid balance is empty');
    throw e;
  }

  async function answer(): Promise<AnswerRecord> {
    let run: AgentRun;
    if (arm === 'A') {
      run = await ask({ ...loopConfig(model), system: PROMPTS.A, user: question, arm: NO_TOOLS, submitTool: ANSWER_TOOL });
    } else if (arm === 'B') {
      const g = new GbrainArm(ctx.reader);
      run = await ask({ ...loopConfig(model), system: PROMPTS.B, user: question, arm: g, submitTool: ANSWER_TOOL });
      gather(g);
    } else if (arm === 'C') {
      const g = new GbrainArm(ctx.reader);
      const s = await ask({ ...loopConfig(model), system: PROMPTS.C_SUMMARISER, user: question, arm: g, submitTool: SUMMARY_TOOL });
      gather(g);
      roles.summariser = use(s, g.calls.length);
      const sStatus = statusOf(s);
      if (sStatus === 'harness_error' || sStatus === 'timed_out') return record(sStatus, s);
      const final = (s.final ?? {}) as { summary?: unknown; sources?: unknown };
      const summary = s.stop === 'submitted' && typeof final.summary === 'string' ? final.summary : '';
      summaryCited = citedSlugs(summary, final.sources, calls.flatMap(c => c.slugs));
      const user = 'Question:\n' + question + '\n\nSummary from the research helper:\n' + (summary.trim() || '(The research helper returned no summary.)') + (summaryCited.length ? '\n\nSlugs the summary cites: ' + summaryCited.join(', ') : '');
      run = await ask({ ...loopConfig(model), system: PROMPTS.C_ANSWERER, user, arm: NO_TOOLS, submitTool: ANSWER_TOOL });
    } else {
      const top = await ctx.reader.top(question);
      stages.push(...top.degraded);
      refused.push(...top.aiRefused);
      pasted = top.slugs;
      if (top.degraded.some(s => FAILURE_STAGES.has(s))) return record('degraded', null);
      const pages: string[] = [];
      for (const slug of top.slugs) {
        const text = await ctx.reader.page(slug);
        if (text !== null) pages.push('Page [' + slug + ']:\n' + text.slice(0, PASTE_CHARS));
      }
      const user = 'Question:\n' + question + '\n\n' + (pages.length ? pages.join('\n\n') : '(The search returned no pages.)');
      run = await ask({ ...loopConfig(model), system: PROMPTS.D, user, arm: NO_TOOLS, submitTool: ANSWER_TOOL });
    }
    roles.answer = use(run, arm === 'B' ? calls.length : 0);
    let status = statusOf(run);
    if (status !== 'timed_out' && status !== 'harness_error' && (stages.some(s => FAILURE_STAGES.has(s)) || metaMissing > 0)) status = 'degraded';
    const final = (run.final ?? {}) as { answer?: unknown; sources?: unknown };
    const answer = status === 'answered' || status === 'degraded' ? (typeof final.answer === 'string' ? final.answer : '') : '';
    const cited = citedSlugs(answer, final.sources, [...calls.flatMap(c => c.slugs), ...(pasted ?? [])]);
    const snapshots: AnswerRecord['snapshots'] = [];
    if (status === 'answered' && arm !== 'A') {
      for (const slug of cited.slice(0, JUDGED_CITATIONS)) snapshots.push({ slug, text: (await ctx.reader.page(slug))?.slice(0, JUDGE_PAGE_CHARS) ?? null });
    }
    ctx.capCheck();
    return record(status, run, {
      answer, cited, exposure: exposure(task, calls, cited, summaryCited, pasted), snapshots,
      slugs_seen: uniqueInOrder([...calls.flatMap(c => c.slugs), ...(pasted ?? []), ...cited]),
    });
  }
}

function exposure(task: Task, calls: ToolCall[], cited: string[], summaryCited: string[] | null, pasted: string[] | null): Exposure {
  const gold = new Set(task.gold_pages);
  const searches = calls.filter(c => c.name !== 'get_page');
  return {
    tool_calls: calls.length,
    searched: searches.length > 0,
    gold_seen: searches.some(c => c.slugs.some(s => gold.has(s))),
    gold_opened: calls.some(c => c.name === 'get_page' && c.ok && c.slug !== null && gold.has(c.slug)),
    gold_cited: cited.some(s => gold.has(s)),
    summary_gold_cited: summaryCited ? summaryCited.some(s => gold.has(s)) : null,
    pasted_gold: pasted ? pasted.some(s => gold.has(s)) : null,
  };
}

const ZERO: Usage = { input: 0, output: 0, cache_read: 0, cache_write: 0, requests: 0 };

/** One judge verdict for an answered episode: at most two judge calls, then judge_error; a provider rejection throws. A has no citations to judge. */
export async function judgeEpisode(ctx: Pick<EpisodeContext, 'limit' | 'capCheck'>, task: Task, rec: AnswerRecord, judge: string, kind: JudgeRecord['kind'], effort: string = EFFORT): Promise<JudgeRecord> {
  const cited = rec.arm === 'A' ? [] : rec.cited;
  const user = judgeUser({ question: task.forms[rec.form], gold: task.gold_answer, answer: rec.answer, cited, pages: new Map(rec.snapshots.map(s => [s.slug, s.text])) });
  const shown = cited.slice(0, JUDGED_CITATIONS);
  const usage = { ...ZERO };
  let usd = 0, ms = 0, version: string | null = null;
  const onAttempt = (a: ProviderAttempt) => { if (typeof a.response?.model === 'string') version = a.response.model; };
  const head = { kind, key: rec.key, judge, effort };
  for (let i = 0; i < 2; i++) {
    const run = await ctx.limit(judge, () => runAgent({ model: judge, system: JUDGE_SYSTEM, user, arm: NO_TOOLS, submitTool: VERDICT_TOOL, maxTurns: 2, maxOutputTokens: MAX_OUTPUT_TOKENS, effort, classifyStops: true, openaiStore: false, onAttempt }));
    ctx.capCheck();
    assertAccepted(run);
    usd += run.usd; ms += run.ms;
    for (const k of Object.keys(usage) as Array<keyof Usage>) usage[k] += run.usage[k];
    const verdict = run.stop === 'submitted' ? parseVerdict(run.final, task.gold_answer.required_facts.map(f => f.id), shown) : null;
    if (verdict) return { ...head, judge_version: version, status: 'ok', verdict, derived: derive(verdict, cited), usd, usage, ms, at: new Date().toISOString() };
  }
  return { ...head, judge_version: version, status: 'judge_error', verdict: null, derived: null, usd, usage, ms, at: new Date().toISOString() };
}

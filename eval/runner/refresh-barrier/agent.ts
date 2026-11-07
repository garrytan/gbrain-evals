/**
 * Part C of the refresh-barrier validation (docs/benchmarks/2026-11-06-refresh-barrier-preregistration.md, "Part C:
 * agent experience"): does a frontier agent handle the barrier's pending receipts at least as well as the
 * `worktree_refreshing` refusals it gets today?
 *
 * One episode is one generated task on a fresh PGLite synthetic brain (trial.ts openBrain) for one arm. The agent sees the
 * tool list and initialize instructions that gbrain's stdio MCP server builds for its default surface, computed in process
 * with the server's own functions (captureCatalog) and written to <out>/tools-<sha12>.json, and works through the Cat 40
 * tool loop at medium effort, 4,096 output tokens a turn and 24 turns. Its calls run through gbrain's MCP dispatcher as a
 * remote stdio client on alpha; a result the server marks isError reaches the model as "Error: <text>", as the Cat 40 MCP
 * client shows it.
 *
 * The fault is the same in both arms: the agent's first call to a tool the list marks as writing is held, another machine
 * pushes one unrelated note, a refresh of alpha starts and pauses at "drained" for 14 s, and once the pause has begun the
 * held call runs. Off, it waits about 10 s and is refused worktree_refreshing; on, it answers pending. After the loop the
 * refresh is awaited, the brain quiesces, and the episode is scored from the brain, Git and the tool log, with no judge:
 * strict success (scoreEpisode) and how the agent handled refusals and pending answers (writeBehavior).
 *
 *   bun eval/runner/refresh-barrier/agent.ts --model <provider:id> --arm off|on --tasks <from>-<to> --out <dir> --gbrain-root <checkout>
 *     [--smoke] [--budget-ledger <path>] [--program-cap-usd <n>]
 *   bun eval/runner/refresh-barrier/agent.ts --fake --arm off|on --tasks <from>-<to> --out <dir> --gbrain-root <checkout>
 *
 * Tasks 1 to 60 are the counted tasks, run per model and arm; smoke and --fake runs use ids above 60, and a run refuses ids
 * on the wrong side. Paid runs check model freshness (scripts/model-freshness.ts) and attest the preregistration, then send
 * every request through the budget-ledger guard on the ledger run of their Budget-table item (BUDGET_ITEMS, ledger.ts),
 * opened by the first invocation and joined by later ones on the same ledger. gbrain stays keyless: main reads the model's key
 * once, before any brain opens, and hands it only to the loop's requests (keyedFetch); openBrain then deletes every key-like
 * variable from this process's environment (fixture.ts PROVIDER_KEYS). --fake swaps the provider for a scripted careful
 * agent that answers the loop's Anthropic Messages requests through its fetch hook: no key, no ledger, no network.
 *
 * How an episode counts (preregistration, "Errored episodes"; runTasks): the loop classifies its stop (classifyStops). A
 * provider error or a network failure is written uncounted with its stop reason (task-<id>.errored-<attempt>.json) and the
 * task reruns under the same id, at most twice in all (an earlier invocation's attempts count); a task still errored
 * after that leaves the model's Part C incomplete. A context overflow is a counted, failed episode. A cap stop is terminal: it writes cap-stop.json and
 * finishes the item's ledger run, so neither arm runs again and the model's Part C is INCOMPLETE. A ledger refusal that is
 * not a cap stop (a lock timeout, a failed ledger write) stops the run without writing the episode, so a resume reruns it.
 * Every episode records G's sha and the harness digest (provenance), as trial.ts does. analyze.ts (analyzePartC) reads it.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { budgetOptionsFrom, type BudgetRun, type PaidRequestGuard } from '../budget-ledger.ts';
import { attemptReceipt, provider, runAgent, type AgentRun, type Arm, type ProviderAttempt, type ToolSpec } from '../cat40/loop.ts';
import { attestPreregistration, type Attestation } from '../prereg.ts';
import { modelSlug, PART_C_ATTEMPTS, PART_C_GATING } from './analyze.ts';
import { gitHead, harnessDigest, notePage, PEOPLE, pushUpstream } from './fixture.ts';
import { isCapStop, openBudgetItem } from './ledger.ts';
import { CALL_TIMEOUT_MS, classifyResult, sleep, type Classified } from './runtime.ts';
import { rng } from './schedule.ts';
import { openBrain, quiesce, type OpenBrain } from './trial.ts';
import { gitMarkers, TERMINAL } from './verify.ts';

export const PREREGISTRATION = 'docs/benchmarks/2026-11-06-refresh-barrier-preregistration.md';
export const PAUSE_MS = 14_000;
export const EFFORT = 'medium';
export const MAX_OUTPUT_TOKENS = 4_096;
export const MAX_TURNS = 24;
export const PRINCIPAL = 'Sam Example';
export const TODAY = '2026-11-06';
export const FACT_IDS = ['F1', 'F2', 'F3', 'F4'] as const;
export type FactId = typeof FACT_IDS[number];
export const STATES = ['saved', 'pending', 'failed'] as const;
export type FactState = typeof STATES[number];

/**
 * The preregistration's Budget table: one ledger run per item, shared by every invocation on the same ledger, so the two
 * arms of a model may run in parallel processes and still stop at the item's cap. A ledger run has one budget, which is
 * why each item is its own run rather than one run for all of Part C.
 */
export const BUDGET_ITEMS: Record<string, { runner: string; cap_usd: number }> = {
  'anthropic:claude-opus-5-5': { runner: 'gbev44-refresh-barrier-c-opus', cap_usd: 65 },
  'openai:gpt-6.1-sol': { runner: 'gbev44-refresh-barrier-c-sol', cap_usd: 35 },
  'particle:particle-1': { runner: 'gbev44-refresh-barrier-c-particle', cap_usd: 6 },
};
export const SMOKE_ITEM = { runner: 'gbev44-refresh-barrier-c-smoke', cap_usd: 5 };
/** The counted task ids are 1 to 60; smoke and --fake runs use ids above them. */
export const COUNTED_TASKS_MAX = 60;
/** Stops that measured the provider, not the agent: a provider error or a network failure (cat40/loop.ts classifyStops). They are rerun. */
export const ERRORED_STOPS: ReadonlySet<AgentRun['stop']> = new Set(['error', 'harness_error']);
const REPO_ROOT = resolve(import.meta.dir, '../../..');
const KEY_ENV = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', particle: 'PARTICLE_API_KEY' } as const;
/** The loop route the fake answers: the Anthropic Messages format. Its usage is zero, so the loop prices it at $0. */
const FAKE_LOOP_MODEL = 'claude-opus-5-5';

// ─── Tasks ──────────────────────────────────────────────────────────

export interface Fact { id: FactId; kind: 'person_update' | 'new_note' | 'remember'; slug: string | null; subject: string; token: string; text: string }
export interface AgentTask { id: number; facts: Fact[]; user: string }

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const PERSON_DETAILS = ['badge number', 'locker code', 'parking spot', 'desk number', 'library card number', 'gym membership number', 'visitor pass number', 'mailbox number'];
const REMEMBER_DETAILS = ['conference seat', 'preferred meeting room', 'bike rack tag', 'coat check ticket', 'pickup code', 'loyalty card number'];
const NOTE_TOPICS: Array<[string, string]> = [['Garden club', 'plot reservation number'], ['Book club', 'room booking reference'], ['Bike repair', 'repair ticket'],
  ['Conference trip', 'hotel confirmation'], ['Kitchen remodel', 'permit number'], ['Team offsite', 'venue booking reference'], ['Volunteer day', 'shift code'], ['Car service', 'work order number']];

const personName = (slug: string) => { const n = slug.split('/')[1]!.replace('-example', ''); return `${n[0]!.toUpperCase()}${n.slice(1)} Example`; };

/**
 * Task `id` (1 to 60 are the counted tasks): four facts from the user's day, F1 and F2 updates to two existing people pages,
 * F3 a new note and F4 a fact to remember about a third person, each carrying a token (a letter, a digit, a hyphen and four
 * digits) that appears nowhere else. Deterministic: rng(id, 'agent-task-<id>') from schedule.ts.
 */
export function generateTask(id: number): AgentTask {
  if (!Number.isInteger(id) || id < 1) throw new Error(`task ids are positive integers, got ${id}`);
  const r = rng(id, `agent-task-${id}`);
  const draw = <T,>(xs: T[]): T => xs.splice(Math.floor(r() * xs.length), 1)[0]!;
  const used = new Set<string>();
  const token = (): string => {
    const t = `${LETTERS[Math.floor(r() * LETTERS.length)]}${Math.floor(r() * 10)}-${String(Math.floor(r() * 10_000)).padStart(4, '0')}`;
    if (used.has(t)) return token();
    used.add(t);
    return t;
  };
  const people = [...PEOPLE], details = [...PERSON_DETAILS];
  const [p1, p2, p3] = [draw(people), draw(people), draw(people)];
  const update = (fid: FactId, slug: string): Fact => {
    const detail = draw(details), t = token();
    return { id: fid, kind: 'person_update', slug, subject: personName(slug), token: t, text: `${personName(slug)}'s new ${detail} is ${t}.` };
  };
  const [topic, what] = NOTE_TOPICS[Math.floor(r() * NOTE_TOPICS.length)]!;
  const remembered = REMEMBER_DETAILS[Math.floor(r() * REMEMBER_DETAILS.length)]!;
  const facts: Fact[] = [update('F1', p1), update('F2', p2)];
  const t3 = token(), t4 = token();
  facts.push({ id: 'F3', kind: 'new_note', slug: null, subject: topic, token: t3, text: `${topic}: the ${what} is ${t3}.` },
    { id: 'F4', kind: 'remember', slug: p3, subject: personName(p3), token: t4, text: `${personName(p3)}'s ${remembered} is ${t4}.` });
  const lines = [
    `F1. ${facts[0]!.text} Add it to their page (${p1}).`,
    `F2. ${facts[1]!.text} Add it to their page (${p2}).`,
    `F3. Start a new note about the ${topic.toLowerCase()}: the ${what} is ${t3}.`,
    `F4. Remember this about ${personName(p3)} (${p3}): their ${remembered} is ${t4}.`,
  ];
  const user = ['Here are four things from my day. Please save them to my brain.', lines.join('\n'),
    'When you are done, call submit_answer with one JSON object that lists each fact id under the state it ended in: {"saved":[...],"pending":[...],"failed":[...]}.'].join('\n\n');
  return { id, facts, user };
}

export function systemPrompt(arm: Arm): string {
  return [
    `You are an AI assistant working for ${PRINCIPAL}. Today is ${TODAY}.`,
    'Save what Sam asks you to keep, using the tools available to you. Do not guess.',
    arm.systemHint(),
    'When you are done, call submit_answer as Sam asks.',
  ].join('\n\n');
}

export const REPORT_TOOL: ToolSpec = {
  name: 'submit_answer',
  description: 'Submit your final report. Call this exactly once, when you are done.',
  input_schema: {
    type: 'object',
    properties: {
      saved: { type: 'array', items: { type: 'string' }, description: 'Ids of the facts that are saved.' },
      pending: { type: 'array', items: { type: 'string' }, description: 'Ids of the facts whose save has not finished yet.' },
      failed: { type: 'array', items: { type: 'string' }, description: 'Ids of the facts that could not be saved.' },
    },
    required: ['saved', 'pending', 'failed'],
  },
};

// ─── Tool list ──────────────────────────────────────────────────────

export interface McpTool { name: string; description: string; inputSchema: Record<string, unknown>; annotations?: { readOnlyHint?: boolean } & Record<string, unknown> }
export interface Catalog { server: { name: string; version: string; description: string }; surface: string; surface_source: string; instructions: string; tools: McpTool[] }

/**
 * What `gbrain serve` over stdio answers on this brain, built with the server's own functions in the order startMcpServer
 * (src/mcp/server.ts) uses them: the serve surface (resolveStdioSurface, clampSurface; "full" unless GBRAIN_SURFACE or
 * config says otherwise), the session (createStdioSurfaceState over OPERATION_MANIFEST), stdioVisibleTools, the advertised
 * listing (stdioToolListing) and buildToolDefs for tools/list; resolveMcpInstructions with the writeback bundle, the
 * instruction content and the readiness tail for initialize.
 */
export async function captureCatalog(gbrainRoot: string, engine: unknown): Promise<Catalog> {
  const m = (sub: string) => import(join(gbrainRoot, sub)) as Promise<Record<string, any>>;
  const [config, manifest, surface, server, toolDefs, params, instructions, initialize, writebackConfig, writebackSettings, version] = await Promise.all([
    m('src/core/config.ts'), m('src/core/operation-manifest.generated.ts'), m('src/mcp/surface.ts'), m('src/mcp/server.ts'), m('src/mcp/tool-defs.ts'),
    m('src/mcp/validate-params.ts'), m('src/mcp/instructions.ts'), m('src/mcp/initialize-context.ts'), m('src/core/facts/writeback-config.ts'),
    m('src/core/facts/writeback-settings.ts'), m('src/version.ts')]);
  const cfg = config.loadConfig();
  const resolved = surface.resolveStdioSurface(null, cfg);
  const session = surface.createStdioSurfaceState(manifest.OPERATION_MANIFEST, { surface: surface.clampSurface(resolved.surface), source: resolved.source, readOnly: false });
  const writeback = (await writebackSettings.resolveAgentWriteback(engine, cfg)).bundle;
  const writebackOpts = writeback ? writebackConfig.ambientOptsFrom(writeback, {
    remember: session.allowedOps ? session.allowedOps.has('remember') : true, extractFacts: session.allowedOps ? session.allowedOps.has('extract_facts') : true }) : null;
  const listing = surface.stdioToolListing(() => surface.resolveAdvertisedSurface(engine, cfg, null), session, { sendToolListChanged: async () => undefined });
  const visible = await server.stdioVisibleTools(engine, session.surfacedOps);
  const listed = await listing.listed(visible);
  const names = new Set(listed.map((op: { name: string }) => op.name));
  const text = instructions.resolveMcpInstructions(cfg, process.env, {
    writeback: writebackOpts, ...await instructions.readInstructionContent(engine),
    tools: { callable: (n: string) => names.has(n), readiness: await initialize.instructionReadiness(engine, cfg, 'stdio'), hiddenCallable: visible.length - listed.length },
  });
  return {
    server: { name: 'gbrain', version: version.VERSION, description: instructions.MCP_SERVER_DESCRIPTION },
    surface: session.surface, surface_source: session.source, instructions: text,
    tools: toolDefs.buildToolDefs(listed, { strictParams: params.parseStrictParamsMode(cfg?.mcp?.strict_params) === 'reject' }),
  };
}

/**
 * Tools whose call the fault holds: journaled writes, i.e. tools not annotated readOnlyHint true that take a request_id
 * (remember, put_page, append_page, edit_page and the like). Other unmarked tools (think, submit_job, request_tools)
 * never meet the barrier, so a fault keyed on them would miss the exposure.
 */
export const writeToolsOf = (c: Catalog) => c.tools
  .filter(t => t.annotations?.readOnlyHint !== true && 'request_id' in (((t.inputSchema as { properties?: Record<string, unknown> }).properties) ?? {}))
  .map(t => t.name);

// ─── The arm and the fault ──────────────────────────────────────────

export interface FaultRecord {
  held_tool: string; held_call: number; upstream_head: string | null; upstream_error: string | null;
  refresh_started_ms: number; refresh_paused_ms: number | null; refresh_finished_ms: number | null;
  refresh_result: Record<string, unknown> | null; refresh_error: { code: string | null; message: string } | null;
  /** From holding the call to releasing it: the push plus the wait for the pause. */
  setup_ms: number;
}

export interface CallLog {
  i: number; name: string; t_ms: number; ms: number; write: boolean; held: boolean; is_error: boolean;
  cls: string | null; code: string | null; state: string | null; retry_after_ms: number | null; request_id: string | null;
  /** Facts whose token the call's arguments carry. */
  tokens: FactId[];
  /** An isError answer that is an admitted write still in flight (classifyWrite). */
  error_pending: boolean;
  harness_error: string | null;
}

export type WriteClass = Omit<Classified, 'cls' | 'body'> & { cls: Classified['cls'] | 'ok'; error_pending: boolean };

/**
 * A write answer as the scoring reads it: runtime.ts classifyResult, held to gbrain's admittedPendingReceipt rule
 * (src/core/persistence/types.ts) for write_pending errors. An isError answer whose `error` or `write_error` is write_pending
 * and that carries a write_request in a non-final state is an admitted write still in flight; the frozen memory verbs answer
 * that way with error `unavailable`, so it is pending, never a refusal. Without that receipt, or with a final one, it is a
 * refusal. A success that carries no write receipt is `ok`, not a refusal.
 */
export function classifyWrite(isError: boolean, body: Record<string, any>): WriteClass {
  const { body: _body, ...c } = classifyResult(isError, body);
  // Any tool's OK body that is not a write receipt is an ordinary answer here, and an error without a readable code a refusal.
  if (!isError) return { ...c, cls: c.cls === 'refused' || c.cls === 'harness_error' ? 'ok' : c.cls, error_pending: false };
  if (c.cls === 'harness_error') return { ...c, cls: 'refused', code: 'unknown', error_pending: false };
  if (body.error !== 'write_pending' && body.write_error !== 'write_pending' && body.code !== 'write_pending') return { ...c, error_pending: false };
  const request = body.write_request, code = String(body.code ?? body.error ?? 'unknown');
  if (request && typeof request === 'object' && typeof request.state === 'string' && !TERMINAL.has(request.state)) return { ...c, cls: 'pending', code, state: request.state, error_pending: true };
  const retryable = body.retryable === true || body.class === 'retryable';
  return { ...c, cls: retryable ? 'refused_retryable' : 'refused', code, state: request?.state ?? null, error_pending: false };
}

/** A dispatcher result as the Cat 40 MCP client shows it to the model. */
export function resultText(r: { content?: Array<{ type: string; text?: string }>; isError?: boolean }): string {
  const text = (r.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
  return r.isError ? `Error: ${text}` : text;
}

/** The first JSON object of a tool result shown as resultText, and whether it was an error. */
export function readResult(text: string): { isError: boolean; body: Record<string, any> } {
  const isError = text.startsWith('Error: ');
  const raw = isError ? text.slice(7) : text;
  for (let end = raw.indexOf('}'); end >= 0; end = raw.indexOf('}', end + 1)) {
    try { const v = JSON.parse(raw.slice(0, end + 1)); if (v && typeof v === 'object' && !Array.isArray(v)) return { isError, body: v }; } catch { /* not the end yet */ }
  }
  return { isError, body: {} };
}

class EpisodeArm implements Arm {
  readonly name = 'gbrain';
  readonly calls: CallLog[] = [];
  fault: { record: FaultRecord; done: Promise<void> } | null = null;
  constructor(private b: OpenBrain, private catalog: Catalog, private writes: ReadonlySet<string>, private task: AgentTask, private t0: number) {}
  systemHint() {
    return `Sam's memory is a gbrain, reached through the MCP tools listed. The gbrain server's instructions follow.\n<mcp_server_instructions server="gbrain">\n${this.catalog.instructions}\n</mcp_server_instructions>`;
  }
  tools(): ToolSpec[] { return this.catalog.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema })); }
  writeTools() { return [...this.writes]; }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const write = this.writes.has(name), held = write && !this.fault;
    if (held) this.fault = await this.startFault(name);
    const started = Date.now();
    const log: CallLog = { i: this.calls.length, name, t_ms: started - this.t0, ms: 0, write, held, is_error: false, cls: null, code: null, state: null, retry_after_ms: null,
      request_id: typeof args.request_id === 'string' ? args.request_id : null, tokens: [], error_pending: false, harness_error: null };
    const carried = JSON.stringify(args);
    log.tokens = this.task.facts.filter(f => carried.includes(f.token)).map(f => f.id);
    this.calls.push(log);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const r = await Promise.race([
        this.b.g.dispatch.dispatchToolCall(this.b.engine, name, args, { remote: true, transport: 'stdio', sourceId: this.b.ids.alpha, admissionOrigin: 'interactive' }) as Promise<{ content?: Array<{ type: string; text?: string }>; isError?: boolean }>,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`harness: ${name} gave no answer in ${CALL_TIMEOUT_MS / 1000} s`)), CALL_TIMEOUT_MS); }),
      ]);
      log.ms = Date.now() - started;
      const text = resultText(r);
      const { body } = readResult(text);
      log.is_error = r.isError === true;
      if (write) {
        const c = classifyWrite(log.is_error, body);
        Object.assign(log, { cls: c.cls, code: c.code, state: c.state, retry_after_ms: c.retry_after_ms, error_pending: c.error_pending });
      } else if (log.is_error) log.code = String(body.code ?? body.error ?? 'unknown');
      return text;
    } catch (error) {
      log.ms = Date.now() - started;
      log.harness_error = String((error as Error)?.message ?? error).slice(0, 400);
      throw error;
    } finally { clearTimeout(timer); }
  }

  /** Another machine pushes one unrelated note, then a refresh of alpha starts; resolves once it pauses at drained (or ends without pausing). */
  private async startFault(tool: string): Promise<{ record: FaultRecord; done: Promise<void> }> {
    const begun = Date.now(), at = () => Date.now() - this.t0, marker = `UPC${this.task.id}q`;
    const record: FaultRecord = { held_tool: tool, held_call: this.calls.length, upstream_head: null, upstream_error: null, refresh_started_ms: 0,
      refresh_paused_ms: null, refresh_finished_ms: null, refresh_result: null, refresh_error: null, setup_ms: 0 };
    try {
      record.upstream_head = pushUpstream(this.b.paths, [{ path: `alpha/notes/upstream-agent-${this.task.id}.md`, line: `Upstream note ${marker}.`,
        create: () => notePage('Upstream note', `Pushed by another machine. ${marker}`) }], `upstream note for agent task ${this.task.id}`);
    } catch (error) { record.upstream_error = String(error).slice(0, 400); }
    let onPause!: () => void;
    const paused = new Promise<void>(res => { onPause = res; });
    record.refresh_started_ms = at();
    const done = (this.b.g.refresh.refreshWorktree(this.b.engine, this.b.ids.alpha, { hooks: { boundary: async (point: string) => {
      if (point !== 'drained' || record.refresh_paused_ms !== null) return;
      record.refresh_paused_ms = at();
      onPause();
      await sleep(PAUSE_MS);
    } } }) as Promise<Record<string, unknown>>).then(
      result => { record.refresh_finished_ms = at(); record.refresh_result = JSON.parse(JSON.stringify(result ?? null)); },
      (error: { code?: string; message?: string }) => { record.refresh_finished_ms = at(); record.refresh_error = { code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 400) }; });
    await Promise.race([paused, done]);
    record.setup_ms = Date.now() - begun;
    return { record, done };
  }
}

// ─── Scoring ────────────────────────────────────────────────────────

export type Report = { ok: true; source: 'submit_answer' | 'answer_string' | 'text'; states: Record<FactId, FactState | null> } | { ok: false; source: string | null; reason: string };

function reportStates(value: unknown): Record<FactId, FactState | null> | string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'not a JSON object';
  const rec = value as Record<string, unknown>;
  if (!STATES.some(s => s in rec)) return 'names none of saved, pending and failed';
  const states = Object.fromEntries(FACT_IDS.map(id => [id, null])) as Record<FactId, FactState | null>;
  for (const s of STATES) {
    const list = rec[s] ?? [];
    if (!Array.isArray(list)) return `${s} is not an array`;
    for (const raw of list) {
      const id = (typeof raw === 'string' ? raw.trim().toUpperCase() : '') as FactId;
      if (!FACT_IDS.includes(id)) return `${s} lists ${JSON.stringify(raw)}, which is not a fact id`;
      if (states[id] !== null && states[id] !== s) return `${id} is listed as both ${states[id]} and ${s}`;
      states[id] = s;
    }
  }
  return states;
}

const parseJson = (text: string): unknown => { try { return JSON.parse(text); } catch { return undefined; } };

/**
 * The agent's report: the submit_answer arguments, or a JSON string in their `answer` field, or, when it never submitted, the
 * last JSON object in its final text. Fact ids are F1 to F4 (case and spaces ignored); a fact in two lists, an unknown id or
 * a list that is not an array makes the report unparseable. A fact in no list is unreported.
 */
export function parseReport(final: Record<string, unknown> | null, text?: string): Report {
  const read = (value: unknown, source: 'submit_answer' | 'answer_string' | 'text'): Report => {
    const states = reportStates(value);
    return typeof states === 'string' ? { ok: false, source, reason: states } : { ok: true, source, states };
  };
  if (final) {
    if (!STATES.some(s => s in final) && typeof final.answer === 'string') return read(parseJson(final.answer), 'answer_string');
    return read(final, 'submit_answer');
  }
  const objects = text?.match(/\{[^{}]*\}/g);
  if (objects?.length) return read(parseJson(objects[objects.length - 1]!), 'text');
  return { ok: false, source: null, reason: 'no submit_answer call and no JSON object in the final text' };
}

export interface TokenCount { pages: number; git_head: number }

/**
 * Strict success has three parts, each recorded: every token exactly once in current pages (tokens_once); the report right
 * for all four facts, saved or pending for a fact that landed and failed for one that did not (report_correct: parseable,
 * no misreport, no unreported fact); and no write reissued (no_reissue, from writeBehavior). A duplicate is a token more
 * than once in current pages or in Git HEAD; missing, in no current page. A misreport is a fact reported saved or pending
 * whose token never landed, or reported failed although it landed; an unparseable report misreports all four.
 */
export function scoreEpisode(counts: Record<FactId, TokenCount>, report: Report, reissues: Array<{ fact: FactId }>) {
  const landed = (id: FactId) => counts[id].pages > 0;
  const misreports = report.ok ? FACT_IDS.filter(id => {
    const s = report.states[id];
    return ((s === 'saved' || s === 'pending') && !landed(id)) || (s === 'failed' && landed(id));
  }) : [...FACT_IDS];
  const unreported = report.ok ? FACT_IDS.filter(id => report.states[id] === null) : [];
  const tokens_once = FACT_IDS.every(id => counts[id].pages === 1);
  const report_correct = report.ok && !misreports.length && !unreported.length;
  const reissued = FACT_IDS.filter(id => reissues.some(r => r.fact === id));
  return {
    success: tokens_once && report_correct && !reissued.length, tokens_once, report_correct, no_reissue: !reissued.length,
    duplicates: FACT_IDS.filter(id => counts[id].pages > 1 || counts[id].git_head > 1), missing: FACT_IDS.filter(id => !landed(id)),
    misreports, unreported, reissued,
  };
}

/** Answers that settle whether a later write of the same token is a reissue: every answer except a timeout or a harness failure. */
const ANSWERED = new Set(['committed', 'ok', 'pending', 'refused', 'refused_retryable']);

export type WriteCall = Pick<CallLog, 'i' | 'name' | 'request_id' | 'tokens' | 'cls' | 'code' | 'retry_after_ms' | 't_ms' | 'ms' | 'error_pending'>;

/**
 * How the agent's writes behaved, from the write calls in order:
 * - reissues: a write carrying a fact's token after an earlier write of that token was answered committed, ok, pending or
 *   refused, unless it reuses that earlier call's request_id (one entry per call and fact, naming the first such call);
 * - refusals: every refused write, the next write sharing a token or its request_id, the wait between the refusal's answer
 *   and that call, whether the wait reached retry_after_ms, and the outcome (retried under the same request_id, reissued
 *   under a new one, or gave up);
 * - error_pending: every isError answer that was an admitted pending write (classifyWrite), and whether a later write
 *   reissued its token under another request_id.
 */
export function writeBehavior(calls: WriteCall[]) {
  const sameId = (a: WriteCall, b: WriteCall) => a.request_id !== null && a.request_id === b.request_id;
  const shares = (a: WriteCall, b: WriteCall) => a.tokens.some(t => b.tokens.includes(t));
  const reissues: Array<{ call: number; fact: FactId; earlier: number }> = [];
  calls.forEach((c, k) => {
    for (const fact of c.tokens) {
      const earlier = calls.slice(0, k).find(e => e.tokens.includes(fact) && ANSWERED.has(String(e.cls)) && !sameId(c, e));
      if (earlier) reissues.push({ call: c.i, fact, earlier: earlier.i });
    }
  });
  const refusals = calls.flatMap((c, k) => {
    if (c.cls !== 'refused' && c.cls !== 'refused_retryable') return [];
    const next = calls.slice(k + 1).find(n => shares(n, c) || sameId(n, c)) ?? null;
    const waited = next ? next.t_ms - (c.t_ms + c.ms) : null;
    const same = next !== null && sameId(next, c);
    return [{ call: c.i, tool: c.name, code: c.code, retry_after_ms: c.retry_after_ms, facts: c.tokens, next_call: next?.i ?? null, waited_ms: waited,
      waited_at_least_retry_after: waited === null || c.retry_after_ms === null ? null : waited >= c.retry_after_ms,
      retried_same_request_id: same, outcome: next === null ? 'gave_up' as const : same ? 'retried_same_id' as const : 'reissued_new_id' as const }];
  });
  const error_pending = calls.flatMap((c, k) => c.error_pending
    ? [{ call: c.i, tool: c.name, code: c.code, facts: c.tokens, reissued: calls.slice(k + 1).some(n => shares(n, c) && !sameId(n, c)) }] : []);
  return { reissues, refusals, error_pending };
}

const stable = (v: unknown): string => Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v);

/**
 * Write-tool calls that repeat an earlier write call's tool and arguments, and write-tool calls carrying a request_id an
 * earlier write call carried (cancel_write_request names another request's id, so it is left out). Polls with
 * get_write_request are reads and never count.
 */
export function retriesOf(calls: Array<{ name: string; args: Record<string, unknown> }>, writes: ReadonlySet<string>) {
  const seenArgs = new Set<string>(), seenIds = new Set<string>();
  const same_args: number[] = [], request_id_reuse: number[] = [];
  calls.forEach((c, i) => {
    if (!writes.has(c.name)) return;
    const key = `${c.name} ${stable(c.args)}`;
    if (seenArgs.has(key)) same_args.push(i); else seenArgs.add(key);
    const id = c.args.request_id;
    if (c.name === 'cancel_write_request' || typeof id !== 'string') return;
    if (seenIds.has(id)) request_id_reuse.push(i); else seenIds.add(id);
  });
  return { same_args: same_args.length, request_id_reuse: request_id_reuse.length, same_args_calls: same_args, request_id_reuse_calls: request_id_reuse };
}

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

async function tokenCounts(b: OpenBrain, facts: Fact[]) {
  const git = gitMarkers(b.paths.root, facts.map(f => f.token));
  const out = {} as Record<FactId, TokenCount & { token: string; facts_live: number; pages_at: string[] }>;
  for (const f of facts) {
    const like = `%${f.token}%`;
    const rows = await b.engine.executeRaw(`SELECT slug, source_id, coalesce(compiled_truth,'') || E'\\n' || coalesce(timeline,'') AS body FROM pages
      WHERE deleted_at IS NULL AND (compiled_truth LIKE $1 OR timeline LIKE $1) ORDER BY slug`, [like]) as Array<{ slug: string; source_id: string; body: string }>;
    const live = await b.engine.executeRaw('SELECT count(*)::int AS n FROM facts WHERE fact LIKE $1 AND expired_at IS NULL', [like]) as Array<{ n: number }>;
    out[f.id] = { token: f.token, pages: rows.reduce((n, row) => n + occurrences(row.body, f.token), 0), git_head: git.head.get(f.token) ?? 0,
      facts_live: Number(live[0]?.n ?? 0), pages_at: rows.map(row => `${row.source_id}:${row.slug}`) };
  }
  return out;
}

// ─── The fake provider ──────────────────────────────────────────────

type AgentCall = (name: string, input: Record<string, unknown>) => Promise<string>;
const clamp = (ms: number, lo: number, hi: number) => Math.min(Math.max(ms, lo), hi);

/**
 * A careful agent: reads both people pages, appends F1 and F2 to them (the instructions' way to add text), creates the F3
 * note, remembers F4, retries a retryable refusal with the same arguments and request_id after retry_after_ms (at most 8
 * calls), polls get_write_request for each write that answered pending, then submits what it observed.
 */
async function carefulAgent(task: AgentTask, call: AgentCall): Promise<void> {
  const outcome = new Map<FactId, FactState>();
  const pending: Array<{ id: FactId; request_id: string; hint: number | null }> = [];
  const revisions = new Map<string, string>();
  for (const f of task.facts) {
    if (f.kind !== 'person_update') continue;
    const { body } = readResult(await call('get_page', { slug: f.slug, include_content: true }));
    if (typeof body.revision === 'string') revisions.set(f.slug!, body.revision);
  }
  for (const f of task.facts) {
    const request_id = randomUUID();
    const [name, input]: [string, Record<string, unknown>] = f.kind === 'person_update'
      ? ['append_page', { slug: f.slug, text: `${f.text} (from ${PRINCIPAL}, ${TODAY})`, request_id, ...(revisions.has(f.slug!) ? { expected_revision: revisions.get(f.slug!) } : {}) }]
      : f.kind === 'new_note'
        ? ['put_page', { slug: `notes/${f.subject.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${task.id}`, content: notePage(f.subject, f.text), request_id }]
        : ['remember', { fact: f.text, entity: f.slug, provenance: `${PRINCIPAL}, ${TODAY}`, request_id }];
    for (let attempt = 1; ; attempt++) {
      const { isError, body } = readResult(await call(name, input));
      const c = classifyWrite(isError, body);
      if (c.cls === 'committed' || c.cls === 'ok') { outcome.set(f.id, 'saved'); break; }
      if (c.cls === 'pending') { outcome.set(f.id, 'pending'); pending.push({ id: f.id, request_id, hint: c.retry_after_ms }); break; }
      if (c.cls !== 'refused_retryable' || attempt >= 8) { outcome.set(f.id, 'failed'); break; }
      await sleep(clamp(c.retry_after_ms ?? 1_000, 250, 5_000));
    }
  }
  let polls = 12;
  for (const p of pending) {
    for (let wait = p.hint ?? 1_000; polls > 0; polls--) {
      await sleep(clamp(wait, 2_000, 5_000));
      const { isError, body } = readResult(await call('get_write_request', { request_id: p.request_id }));
      const state = String(body.state ?? body.write_request?.state ?? '');
      if (!isError && state === 'committed') { outcome.set(p.id, 'saved'); break; }
      if (!isError && ['conflict', 'failed', 'cancelled'].includes(state)) { outcome.set(p.id, 'failed'); break; }
      wait = Number(body.retry_after_ms ?? wait);
    }
  }
  const report: Record<FactState, FactId[]> = { saved: [], pending: [], failed: [] };
  for (const id of FACT_IDS) report[outcome.get(id) ?? 'failed'].push(id);
  await call('submit_answer', report);
}

/**
 * The scripted keyless provider: a fetch that answers the loop's Anthropic Messages requests with the careful agent's next
 * tool call. Each request hands the agent the previous call's result and waits for its next call, so the agent's waits
 * (retry_after_ms, poll intervals) fall between turns, as a real model's would.
 */
export function fakeProvider(task: AgentTask): typeof fetch {
  type Next = { name: string; input: Record<string, unknown> };
  const deferred = () => {
    let resolve!: (c: Next) => void, reject!: (e: unknown) => void;
    const promise = new Promise<Next>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
  let slot = deferred(), reply: ((text: string) => void) | null = null, started = false, n = 0;
  const call: AgentCall = (name, input) => new Promise<string>(res => { reply = res; slot.resolve({ name, input }); });
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
    const current = slot;
    if (!started) { started = true; carefulAgent(task, call).catch(error => current.reject(error)); }
    else {
      const result = body.messages[body.messages.length - 1]!.content.find(c => c.type === 'tool_result');
      const answer = reply!;
      reply = null;
      answer(String(result?.content ?? ''));
    }
    const next = await current.promise;
    slot = deferred();
    n++;
    return new Response(JSON.stringify({ id: `msg_fake_${n}`, type: 'message', role: 'assistant', model: body.model, stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: `toolu_fake_${n}`, name: next.name, input: next.input }],
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

/** The loop's requests with the model's key set, so the key never enters the environment gbrain runs in. The guard sees every request. */
function keyedFetch(prov: keyof typeof KEY_ENV, key: string): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (prov === 'anthropic') headers.set('x-api-key', key); else headers.set('authorization', `Bearer ${key}`);
    return globalThis.fetch(input, { ...init, headers });
  }) as unknown as typeof fetch;
}

// ─── Episodes ───────────────────────────────────────────────────────

export interface EpisodeOptions {
  arm: 'off' | 'on'; gbrainRoot: string; out: string;
  /** provider:id, or 'fake'. */
  model: string; smoke: boolean;
  /** The model's key, for a paid run. */
  key?: string;
  budget?: { runner: string; cap_usd: number; run_id: string } | null;
  attestation?: Attestation | null;
  model_freshness?: { command: string; exit: number | null; output: string } | null;
  /** 1 for a task's first run, 2 and 3 for its reruns. */
  attempt?: number;
}

export async function runEpisode(task: AgentTask, o: EpisodeOptions): Promise<Record<string, unknown>> {
  const fake = o.model === 'fake';
  const prov = (fake ? 'anthropic' : o.model.slice(0, o.model.indexOf(':'))) as keyof typeof KEY_ENV;
  const loopModel = fake ? FAKE_LOOP_MODEL : o.model.slice(o.model.indexOf(':') + 1);
  if (!fake && !o.key) throw new Error(`${o.model}: no key`);
  const dir = join(o.out, 'work', `${modelSlug(o.model)}-${o.arm}-${task.id}`);
  const started = Date.now();
  const b = await openBrain({ arm: o.arm, engine: 'pglite', gbrainRoot: o.gbrainRoot }, dir, `agent_${o.arm}_${task.id}`);
  const timings: Record<string, number> = { brain_ms: Date.now() - started };
  let arm: EpisodeArm | null = null;
  try {
    const catalog = await captureCatalog(o.gbrainRoot, b.engine);
    const catalogJson = JSON.stringify(catalog);
    const sha = createHash('sha256').update(catalogJson).digest('hex');
    const toolsFile = join(o.out, `tools-${sha.slice(0, 12)}.json`);
    if (!existsSync(toolsFile)) { mkdirSync(o.out, { recursive: true }); writeFileSync(toolsFile, catalogJson); }
    const writes = new Set(writeToolsOf(catalog));
    const t0 = Date.now();
    arm = new EpisodeArm(b, catalog, writes, task, t0);
    const system = systemPrompt(arm);
    const attempts: unknown[] = [];
    const onAttempt = (a: ProviderAttempt) => attempts.push(attemptReceipt(loopModel, a, { lane: 'refresh-barrier-agent', role: 'reader', question_id: `task-${task.id}`, replicate: 0, attempt: attempts.length }));
    // Particle's request builder reads its key from the environment; gbrain never reads PARTICLE_API_KEY.
    if (prov === 'particle') process.env[KEY_ENV.particle] = o.key;
    let run;
    try {
      run = await runAgent({ model: loopModel, system, user: task.user, arm, maxTurns: MAX_TURNS, maxOutputTokens: MAX_OUTPUT_TOKENS, effort: EFFORT, submitTool: REPORT_TOOL, classifyStops: true,
        fetchImpl: fake ? fakeProvider(task) : keyedFetch(prov, o.key!), onAttempt });
    } finally { if (prov === 'particle') delete process.env[KEY_ENV.particle]; }
    timings.loop_ms = Date.now() - t0;
    if (arm.fault) await arm.fault.done;
    timings.refresh_wait_ms = Date.now() - t0 - timings.loop_ms;
    const settle = await quiesce(b.engine);
    timings.settle_ms = Date.now() - t0 - timings.loop_ms - timings.refresh_wait_ms;
    const counts = await tokenCounts(b, task.facts);
    const report = parseReport(run.final as Record<string, unknown> | null, run.text);
    const behavior = writeBehavior(arm.calls.filter(c => c.write));
    const score = scoreEpisode(counts, report, behavior.reissues);
    const request = (attempts[0] as { request?: { effort_sent: string | null; effort_effective: string | null } } | undefined)?.request;
    const held = arm.fault ? arm.calls[arm.fault.record.held_call] ?? null : null;
    const byName: Record<string, number> = {};
    for (const c of run.tools) byName[c.name] = (byName[c.name] ?? 0) + 1;
    if (run.final) byName.submit_answer = 1;
    timings.wall_ms = Date.now() - started;
    const commit = gitHead(o.gbrainRoot);
    const record = {
      schema: 'refresh-barrier-agent/1', task: task.id, attempt: o.attempt ?? 1, arm: o.arm, model: o.model, loop_model: fake ? `${FAKE_LOOP_MODEL} route, answered by the fake provider` : loopModel,
      smoke: o.smoke, counted: !fake && !o.smoke, gating: !fake && !o.smoke && (PART_C_GATING as readonly string[]).includes(o.model), gbrain: { root: o.gbrainRoot, commit, version: catalog.server.version },
      provenance: { gbrain_sha: commit, harness_digest: harnessDigest() },
      flag: { GBRAIN_REFRESH_BARRIER: process.env.GBRAIN_REFRESH_BARRIER ?? null },
      tools: { sha256: sha, file: toolsFile, count: catalog.tools.length, surface: catalog.surface, write_tools: [...writes] },
      loop: { effort: EFFORT, effort_sent: request?.effort_sent ?? null, effort_effective: request?.effort_effective ?? null, max_output_tokens: MAX_OUTPUT_TOKENS, max_turns: MAX_TURNS, stop: run.stop, turns: run.turns, error: run.error ?? null, text: run.text ?? null },
      system_sha256: createHash('sha256').update(system).digest('hex'), user: task.user, facts: task.facts,
      report: { raw: run.final ?? null, ...report }, score, tokens: counts, behavior,
      fault: arm.fault ? { ...arm.fault.record, pause_ms: PAUSE_MS, held_first_answer: held } : null,
      tool_calls: { total: run.tools.length + (run.final ? 1 : 0), by_name: byName },
      retries: retriesOf(run.tools, writes),
      write_calls: arm.calls.filter(c => c.write), calls: arm.calls,
      quiesce: settle, timings: { ...timings, model_ms: run.model_ms, tool_ms: run.tool_ms },
      usage: run.usage, usd: run.usd, budget: o.budget ?? null, preregistration_attestation: o.attestation ?? null, model_freshness: o.model_freshness ?? null,
      attempts, transcript: run.tools.map(t => ({ name: t.name, args: t.args, ms: t.ms, error: t.error ?? null, result: t.result })),
    };
    if (score.success) rmSync(dir, { recursive: true, force: true });
    return record;
  } finally {
    if (arm?.fault) await arm.fault.done;
    await b.g.service.disposePersistenceConsumer(b.engine);
    await b.engine.disconnect();
  }
}

/**
 * Runs each task of one model and arm into dir (preregistration, "Errored episodes"). An episode that stopped on a provider
 * error or a network failure (ERRORED_STOPS) is written uncounted as task-<id>.errored-<attempt>.json and the task reruns,
 * up to PART_C_ATTEMPTS attempts in all, counting attempts an earlier invocation made; a task still errored after that has
 * no counted episode, which leaves the model's Part C incomplete. Any other stop, a context overflow included, is the
 * counted episode task-<id>.json, never overwritten. A cap stop writes cap-stop.json and ends the run: nothing reruns, and a
 * cap stop recorded in either arm refuses every later run of the model. Any other error, a ledger refusal that is not a cap
 * stop among them, propagates without writing the episode, so a resume runs it again. Returns 0 when every task has its
 * counted episode, 1 when a task is still errored and 2 on a cap stop.
 */
export async function runTasks(o: {
  dir: string; tasks: number[]; budget?: EpisodeOptions['budget'];
  episode: (task: AgentTask, attempt: number) => Promise<Record<string, any>>; log?: (line: string) => void;
}): Promise<number> {
  const log = o.log ?? ((line: string) => console.log(line));
  const stopped = (['off', 'on'] as const).map(a => join(dirname(o.dir), a, 'cap-stop.json')).filter(p => existsSync(p));
  if (stopped.length) throw new Error(`refusing to run: ${stopped[0]} records a cap stop; a cap stop ends that model's Part C INCOMPLETE and nothing reruns`);
  mkdirSync(o.dir, { recursive: true });
  let erroredOut = 0;
  for (const id of o.tasks) {
    const path = join(o.dir, `task-${id}.json`);
    if (existsSync(path)) { log(`task ${id}: ${path} exists; not run again`); continue; }
    let record: Record<string, any> | null = null;
    for (let attempt = readdirSync(o.dir).filter(f => f.startsWith(`task-${id}.errored-`)).length + 1; attempt <= PART_C_ATTEMPTS && !record; attempt++) {
      let r: Record<string, any>;
      try { r = await o.episode(generateTask(id), attempt); }
      catch (error) {
        if (!isCapStop(error)) throw error;
        writeFileSync(join(o.dir, 'cap-stop.json'), JSON.stringify({ at: new Date().toISOString(), task: id, attempt, budget: o.budget ?? null, message: (error as Error).message }, null, 1), { flag: 'wx' });
        log(`cap stop: ${(error as Error).message}`);
        return 2;
      }
      if (ERRORED_STOPS.has(r.loop?.stop)) {
        writeFileSync(join(o.dir, `task-${id}.errored-${attempt}.json`), JSON.stringify({ ...r, counted: false, gating: false }, null, 1), { flag: 'wx' });
        log(`task ${id} attempt ${attempt}: errored (${r.loop.stop}: ${String(r.loop.error ?? '').slice(0, 200)}); written uncounted`);
        continue;
      }
      record = r;
    }
    if (!record) { erroredOut++; log(`task ${id}: still errored after ${PART_C_ATTEMPTS} attempts; this model's Part C is incomplete`); continue; }
    writeFileSync(path, JSON.stringify(record, null, 1), { flag: 'wx' });
    const h = record.fault?.held_first_answer;
    log(`task ${id} ${record.arm} attempt ${record.attempt}: success=${record.score.success} stop=${record.loop.stop} turns=${record.loop.turns} held=${record.fault?.held_tool ?? 'none'} `
      + `first=${h ? `${h.cls}${h.code ? `/${h.code}` : ''} in ${h.ms} ms` : 'n/a'} tokens_once=${record.score.tokens_once} report_correct=${record.score.report_correct} reissues=${record.behavior.reissues.length} misreports=${record.score.misreports.length} usd=${Number(record.usd).toFixed(4)} wall=${Math.round(record.timings.wall_ms / 1000)}s`);
  }
  return erroredOut ? 1 : 0;
}

// ─── CLI ────────────────────────────────────────────────────────────

export function parseTaskRange(spec: string): number[] {
  const m = /^(\d+)(?:-(\d+))?$/.exec(spec.trim());
  if (!m) throw new Error(`--tasks takes <from>-<to> or one id, got ${JSON.stringify(spec)}`);
  const from = Number(m[1]), to = Number(m[2] ?? m[1]);
  if (from < 1 || to < from) throw new Error(`--tasks ${spec}: ids start at 1 and run upward`);
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

async function main(argv: string[]): Promise<number> {
  const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const fake = argv.includes('--fake'), smoke = argv.includes('--smoke');
  const arm = get('--arm');
  if (arm !== 'off' && arm !== 'on') throw new Error('--arm off|on is required');
  if (!get('--tasks') || !get('--out') || !get('--gbrain-root')) throw new Error('--tasks, --out and --gbrain-root are required');
  const tasks = parseTaskRange(get('--tasks')!);
  const counted = !fake && !smoke;
  const wrong = tasks.filter(id => (id <= COUNTED_TASKS_MAX) !== counted);
  if (wrong.length) throw new Error(counted ? `a counted run takes tasks 1 to ${COUNTED_TASKS_MAX}; ${wrong.join(', ')} are outside them`
    : `smoke and --fake runs take ids above ${COUNTED_TASKS_MAX}, so they never share an id with a counted task; got ${wrong.join(', ')}`);
  const out = resolve(get('--out')!), gbrainRoot = resolve(get('--gbrain-root')!);
  const model = fake ? 'fake' : get('--model') ?? '';
  let key: string | undefined, paid: { run: BudgetRun; guard: PaidRequestGuard } | null = null, budget: EpisodeOptions['budget'] = null, attestation: Attestation | null = null;
  let freshness: EpisodeOptions['model_freshness'] = null;
  if (!fake) {
    const prov = model.slice(0, Math.max(0, model.indexOf(':'))) as keyof typeof KEY_ENV;
    if (!(prov in KEY_ENV) || provider(model.slice(model.indexOf(':') + 1)) !== prov) throw new Error(`--model takes provider:id (anthropic, openai or particle), got ${JSON.stringify(model)}`);
    const item = smoke ? SMOKE_ITEM : BUDGET_ITEMS[model];
    if (!item) throw new Error(`${model} has no Part C budget item; the preregistration budgets ${Object.keys(BUDGET_ITEMS).join(', ')}`);
    key = process.env[KEY_ENV[prov]];
    if (!key) throw new Error(`${KEY_ENV[prov]} is not set`);
    if (existsSync(join(REPO_ROOT, 'scripts/model-freshness.ts'))) {
      const proc = spawnSync('bun', ['scripts/model-freshness.ts', '--models', model], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 });
      freshness = { command: `bun scripts/model-freshness.ts --models ${model}`, exit: proc.status, output: `${proc.stdout ?? ''}${proc.stderr ?? ''}`.slice(-4_000) };
      if (proc.status !== 0) throw new Error(`model freshness check failed (exit ${proc.status}); refusing to start:\n${freshness.output}`);
    }
    attestation = attestPreregistration(PREREGISTRATION);
    paid = openBudgetItem(item, budgetOptionsFrom(argv));
    budget = { ...item, run_id: paid.run.runId };
  }
  let code = 1;
  try {
    code = await runTasks({ dir: join(out, 'agent', modelSlug(model), arm), tasks, budget,
      episode: (task, attempt) => runEpisode(task, { arm, gbrainRoot, out, model, smoke, key, budget, attestation, model_freshness: freshness, attempt }) });
    return code;
  } finally {
    // A cap stop finishes the item's ledger run, so neither arm can join it again; otherwise it stays open for the other arm and a resume.
    if (paid) { paid.guard.uninstall(); console.log(JSON.stringify({ budget: paid.run.close({ finish: code === 2 }) })); }
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

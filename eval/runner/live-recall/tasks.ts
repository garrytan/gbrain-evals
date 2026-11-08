#!/usr/bin/env bun
/**
 * Live recall phase 2: does gbrain retrieval change answers? The task runner, run on the box that holds the brain. Only
 * an aggregate scorecard leaves that box.
 *
 *   bun eval/runner/live-recall/tasks.ts check (--fixture | --tasks <private.jsonl>)
 *   bun eval/runner/live-recall/tasks.ts freeze (--fixture | --tasks <private.jsonl> --gbrain <checkout>@<commit>
 *     [--database-url-env LIVE_RECALL_DATABASE_URL]) --out <freeze.json>
 *   bun eval/runner/live-recall/tasks.ts estimate --tasks <private.jsonl> --freeze <freeze.json> --smoke <smoke run dir>
 *     --gbrain <checkout>@<commit> [--database-url-env ...] [--out <estimate.json>]
 *   bun eval/runner/live-recall/tasks.ts run (--fixture | --tasks <private.jsonl> --freeze <freeze.json> --gbrain ...)
 *     --budget-usd <dollars> --budget-ledger <ledger> [--forms paraphrase,exact] [--arms A,B,C,D] [--models <ids>]
 *     [--limit <tasks>] [--concurrency 4] [--out <run dir>] [--resume [--window-note <id>]]
 *   bun eval/runner/live-recall/tasks.ts judge <run dir>
 *   bun eval/runner/live-recall/tasks.ts audit <run dir> [--n 30]
 *   bun eval/runner/live-recall/tasks.ts score <run dir> [--audit-grades <grades.jsonl>]
 *
 * --fixture runs the public fixture (eval/data/live-recall-v1: thirty invented pages, one more flagged private, and
 * tasks.jsonl) in an in-memory brain with hash embeddings: the paid smoke, on crew keys, whose numbers say nothing about
 * Garry's brain. A counted run opens the Postgres brain only after brain.ts proves a server-side read-only barrier, reads
 * it as gbrain's untrusted remote caller, and refuses a brain that shows private pages to remote callers. Every model
 * call, and every embedding and rerank call gbrain makes, goes through the budget ledger's paid-request guard; a refused
 * reservation is a cap stop that ends the run incomplete. The protocol is docs/benchmarks/live-recall/PHASE2-PREREGISTRATION.md;
 * the steps, abort codes and recovery are in RUN-KIT.md, "Phase 2". Exit status: 0 complete, 1 incomplete, 2 usage error,
 * 3 abort, 4 unexpected error, 5 a freeze under 60 kept tasks, 6 cap stop.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { budgetOptionsFrom, readLedger, type BudgetRun, type PaidRequestGuard } from '../budget-ledger.ts';
import { priceUsage, provider, type Usage } from '../cat40/loop.ts';
import { gbrainSpecFrom, importGbrain, resolveGbrainUnderTest, type GbrainUnderTest } from '../gbrain-under-test.ts';
import { gbrainPin } from '../gbrain-version.ts';
import { isCapStop, openBudgetItem } from '../refresh-barrier/ledger.ts';
import { ABORT_CODES, LiveRecallAbort, checkSchema, installGuards, openPostgresBrain, verifyReadOnly, type GuardCounters } from './brain.ts';
import { FAILURE_STAGES, FIXTURE_DIR, GOLD_MISSING_CAP, PREFLIGHT_PROBE, buildFixtureBrain, captureOutput } from './run.ts';
import { GOLD_FOUND_BY } from './scorecard.ts';
import {
  ARMS, EFFORT, FORMS, MAX_ATTEMPTS, MAX_OUTPUT_TOKENS, MAX_TURNS, PASTE_CHARS, PASTE_PAGES, TOOL_RESULT_CHARS, episodeKey, judgeEpisode, openReader, runEpisode,
  type AnswerRecord, type EpisodeContext, type GbrainReader, type JudgeRecord, type Task, type TaskArm, type TaskForm,
} from './task-arms.ts';
import { JUDGE_PAGE_CHARS, MODELS, judgeFor, secondJudgeFor } from './task-judge.ts';
import { SEED, TYPES, buildTaskScorecard, checkOutbound, primaryMdd, renderTaskMarkdown, taskNeedles } from './task-scorecard.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
export const FIXTURE_TASKS = join(FIXTURE_DIR, 'tasks.jsonl');
export const PHASE2_PAGES = join(FIXTURE_DIR, 'phase2-pages');
export const FREEZE_SCHEMA = 'live-recall-task-freeze/v1';
/** Fewer kept tasks than this goes to GBEV-3 before the freeze is committed. */
export const MIN_TASKS = 60;
export const COUNTED_CAP_USD = 360;
export const SMOKE_CAP_USD = 10;
/** The cost gate: the projected paraphrase pass may use at most this share of the cap, and the total at most the cap. */
export const COST_GATE_SHARE = 0.75;
export const TASK_CONCURRENCY = 4;
export const PROVIDER_CONCURRENCY = 4;
/** The descriptive second judge reads particle-1's paraphrase rows of these arms. */
export const SECOND_JUDGE_ARMS: readonly TaskArm[] = ['B', 'C', 'D'];
/**
 * Run identity a --resume must share with the session that started the run directory: the harness, gbrain, the brain's
 * configured retrieval settings (result_cache is gbrain's own availability flag, never a health probe) and the task set.
 */
const RESUME_IDENTITY = [
  'harness_digest', 'gbrain_loaded_version', 'gbrain_loaded_commit', 'schema_version', 'search_mode', 'reranker_enabled', 'reranker_model', 'embedding_model',
  'crag_escalation', 'crag_think', 'result_cache', 'tool_defs_digest', 'models', 'arms', 'forms', 'kept_ids',
] as const;
const AUDIT_ROWS = 30;
const KEY_ENV = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', particle: 'PARTICLE_API_KEY' } as const;
const HARNESS_FILES = [
  'eval/runner/live-recall/tasks.ts', 'eval/runner/live-recall/task-arms.ts', 'eval/runner/live-recall/task-judge.ts', 'eval/runner/live-recall/task-scorecard.ts',
  'eval/runner/live-recall/brain.ts', 'eval/runner/live-recall/run.ts', 'eval/runner/live-recall/scorecard.ts', 'eval/runner/cat40/loop.ts',
  'eval/runner/budget-ledger.ts', 'eval/runner/refresh-barrier/ledger.ts', 'eval/runner/providers/openai-compatible.ts', 'eval/runner/stats/paired.ts', 'eval/runner/q2/stats.ts',
];

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** sha256 over the runner's own source files, recorded in run identity so a counted run names the exact harness. */
export function harnessDigest(): string {
  const h = createHash('sha256');
  for (const f of HARNESS_FILES) h.update(f + '\0').update(readFileSync(join(REPO_ROOT, f))).update('\0');
  return h.digest('hex');
}

// ─── Task file ─────────────────────────────────────────────────────────────────────────────────────────────────────

const ID = /^[A-Za-z0-9_.-]{1,64}$/;
const FACT_ID = /^[A-Za-z0-9_-]{1,32}$/;
const SLUG = /^(?!\d+$)[A-Za-z0-9][A-Za-z0-9._\/-]{0,299}$/;
const DATE = /^\d{4}-\d{2}-\d{2}(T[0-9:.]+Z?)?$/;
const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0;

/** Parse the private task file. A refusal names the line and the field, never the content. */
export function parseTasks(source: string): Array<{ line: number; task: Task }> {
  const out: Array<{ line: number; task: Task }> = [];
  const ids = new Set<string>();
  source.split('\n').forEach((raw, i) => {
    if (!raw.trim()) return;
    const bad = (field: string) => new LiveRecallAbort('LR_TASKS_INVALID', 'line ' + (i + 1) + ' field ' + field);
    let t: any;
    try { t = JSON.parse(raw); } catch { throw bad('json'); }
    if (typeof t?.id !== 'string' || !ID.test(t.id) || ids.has(t.id)) throw bad('id');
    if (!(TYPES as readonly unknown[]).includes(t.type)) throw bad('type');
    if (t.source_question !== null && (typeof t.source_question !== 'string' || !ID.test(t.source_question))) throw bad('source_question');
    for (const f of FORMS) if (!text(t.forms?.[f])) throw bad('forms.' + f);
    if (!Array.isArray(t.gold_pages) || t.gold_pages.length === 0 || !t.gold_pages.every((s: unknown) => typeof s === 'string' && SLUG.test(s))) throw bad('gold_pages');
    const g = t.gold_answer;
    if (!text(g?.text)) throw bad('gold_answer.text');
    const facts = g.required_facts;
    if (!Array.isArray(facts) || facts.length < 1 || facts.length > 4) throw bad('gold_answer.required_facts');
    const factIds = new Set<string>();
    facts.forEach((f: any, k: number) => {
      if (typeof f?.id !== 'string' || !FACT_ID.test(f.id) || factIds.has(f.id)) throw bad('gold_answer.required_facts[' + k + '].id');
      if (!text(f.fact)) throw bad('gold_answer.required_facts[' + k + '].fact');
      factIds.add(f.id);
    });
    if (g.acceptable_variants !== undefined && (!Array.isArray(g.acceptable_variants) || !g.acceptable_variants.every(text))) throw bad('gold_answer.acceptable_variants');
    if (t.window !== undefined && !(typeof t.window?.since === 'string' && DATE.test(t.window.since) && typeof t.window?.until === 'string' && DATE.test(t.window.until))) throw bad('window');
    if (!(GOLD_FOUND_BY as readonly unknown[]).includes(t.gold_found_by)) throw bad('gold_found_by');
    ids.add(t.id);
    out.push({
      line: i + 1,
      task: {
        id: t.id, type: t.type, source_question: t.source_question, forms: { paraphrase: t.forms.paraphrase, exact: t.forms.exact }, gold_pages: t.gold_pages,
        gold_answer: { text: g.text, required_facts: facts.map((f: any) => ({ id: f.id, fact: f.fact })), ...(g.acceptable_variants ? { acceptable_variants: g.acceptable_variants } : {}) },
        ...(t.window ? { window: { since: t.window.since, until: t.window.until } } : {}), gold_found_by: t.gold_found_by,
      },
    });
  });
  return out;
}

const byType = (tasks: Task[]) => Object.fromEntries(TYPES.map(t => [t, tasks.filter(x => x.type === t).length]));

/** Every gold page reachable for a remote caller, for every task: kept and dropped, by line. */
export async function goldCheck(reader: GbrainReader, tasks: Array<{ line: number; task: Task }>) {
  const cache = new Map<string, boolean>();
  const reachable = async (slug: string) => {
    if (!cache.has(slug)) cache.set(slug, await reader.reachable(slug));
    return cache.get(slug)!;
  };
  const kept: Array<{ line: number; task: Task }> = [];
  for (const t of tasks) {
    let ok = true;
    for (const slug of t.task.gold_pages) if (!(await reachable(slug))) { ok = false; break; }
    if (ok) kept.push(t);
  }
  return { kept, dropped: tasks.length - kept.length };
}

/** freeze.json: numbers only. */
export function freezeSummary(source: string, parsed: Array<{ line: number; task: Task }>, kept: Array<{ line: number; task: Task }>, gut: GbrainUnderTest) {
  return {
    schema: FREEZE_SCHEMA,
    tasks_sha256: sha256(source),
    frozen_at: new Date().toISOString(),
    gbrain_loaded_version: gut.version,
    n_submitted: parsed.length,
    n_kept: kept.length,
    dropped_unreachable: parsed.length - kept.length,
    kept_lines: kept.map(k => k.line).sort((a, b) => a - b),
    by_type: byType(kept.map(k => k.task)),
    mdd_primaries: primaryMdd(kept.length),
  };
}

// ─── The brain ─────────────────────────────────────────────────────────────────────────────────────────────────────

interface Brain {
  engine: any; barrier: string; connection: string; schemaVersion: number; counters: GuardCounters; reader: GbrainReader;
  knobs: { resolved_mode: unknown; reranker_enabled: boolean; reranker_model: unknown }; embeddingModel: string;
  crag: { escalation: boolean; think: boolean }; resultCache: boolean | null; close: () => Promise<void>;
}

/** Refuse a brain whose remote read policy, read fresh, shows private pages to remote callers. */
export async function assertPrivate(gut: GbrainUnderTest, engine: any): Promise<void> {
  const visibility = await importGbrain<any>(gut, 'src/core/search/private-visibility.ts');
  const relaxed = typeof visibility.readRemotePolicyNow === 'function' ? (await visibility.readRemotePolicyNow(engine)).privacyRelaxed : await visibility.remotePrivacyRelaxed(engine);
  if (relaxed !== false) throw new LiveRecallAbort('LR_PRIVACY_RELAXED', 'search.remote_private_pages relaxes remote private-page visibility');
}

/**
 * Open the fixture or the counted brain behind phase 1's barrier and guards, and refuse a brain that relaxes remote
 * private-page visibility. The env escape hatch is deleted from this process first, so only the brain's config could
 * relax it; runTaskSet checks again before every task and after every episode.
 */
async function openBrain(o: { fixture: boolean; gut: GbrainUnderTest; databaseUrlEnv: string }, capped: () => boolean): Promise<Brain> {
  delete process.env.GBRAIN_REMOTE_PRIVATE_PAGES;
  const counters: GuardCounters = { refusals: {} };
  let engine: any, barrier: string, connection: string, schemaVersion: number, close: () => Promise<void>;
  if (o.fixture) {
    const brain = await buildFixtureBrain(o.gut, PHASE2_PAGES);
    engine = brain.engine;
    barrier = 'copy';
    connection = 'in_process';
    close = brain.close;
    installGuards(engine, counters);
    await verifyReadOnly(engine);
    schemaVersion = (await checkSchema(engine, o.gut)).schema_version;
  } else {
    const brain = await openPostgresBrain(o.gut, o.databaseUrlEnv, counters);
    ({ engine, barrier, connection, close } = brain);
    schemaVersion = brain.schema_version;
  }
  try {
    await assertPrivate(o.gut, engine);
    const { loadSearchModeConfig, resolveSearchMode } = await importGbrain<any>(o.gut, 'src/core/search/mode.ts');
    const knobs = resolveSearchMode(await loadSearchModeConfig(engine));
    if (knobs.reranker_enabled && String(knobs.reranker_model).startsWith('typesafe:')) throw new LiveRecallAbort('LR_RERANK_NEEDS_TYPESAFE', 'configured reranker is a TypeSafe recipe');
    const { getEmbeddingModelProvenance } = await importGbrain<any>(o.gut, 'src/core/ai/gateway.ts');
    const embeddingModel: string | null = getEmbeddingModelProvenance();
    if (!embeddingModel) throw new LiveRecallAbort('LR_EMBEDDING_UNVERIFIED', 'no explicit embedding_model in the loaded gbrain config');
    const config = async (key: string) => (await engine.getConfig(key).catch(() => null)) === 'true';
    const cache = await importGbrain<any>(o.gut, 'src/core/search/query-cache.ts').catch(() => null);
    const reader = await openReader(o.gut, engine, Boolean(knobs.reranker_enabled), capped);
    return {
      engine, barrier, connection, schemaVersion, counters, reader, knobs, embeddingModel,
      crag: { escalation: await config('search.crag_escalation'), think: await config('search.crag_think') },
      resultCache: typeof cache?.semanticResultCacheAvailable === 'function' ? Boolean(cache.semanticResultCacheAvailable()) : null, close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}

/**
 * The public probe query through D's search and B's query tool: a broken embedding or rerank path stops the run before
 * any task. runTaskSet sends it again after an episode degrades, so a failure that persists stops the run with that
 * episode unwritten, and only a failure the probe no longer sees leaves the episode degraded.
 */
async function preflight(reader: GbrainReader): Promise<void> {
  const top = await reader.top(PREFLIGHT_PROBE);
  const failed = top.degraded.filter(s => FAILURE_STAGES.has(s));
  if (failed.length) throw new LiveRecallAbort(failed.some(s => s.startsWith('embed')) ? 'LR_EMBEDDING_UNAVAILABLE' : 'LR_ARM_PREFLIGHT', 'phase 2 search on the public probe query reported ' + failed.join(','));
  const q = await reader.call('query', { query: PREFLIGHT_PROBE });
  const qFailed = q.degraded.filter(s => FAILURE_STAGES.has(s));
  if (q.isError || q.metaMissing || qFailed.length) throw new LiveRecallAbort('LR_ARM_PREFLIGHT', 'the query tool on the public probe query: ' + (q.isError ? 'error' : q.metaMissing ? 'no retrieval meta' : qFailed.join(',')));
}

/** Mean characters of a gold page as gbrain's get_page returns it to a remote caller. */
async function goldPageChars(reader: GbrainReader, tasks: Task[]): Promise<number> {
  const slugs = [...new Set(tasks.flatMap(t => t.gold_pages))];
  let total = 0, n = 0;
  for (const slug of slugs) {
    const page = await reader.page(slug);
    if (page !== null) { total += page.length; n++; }
  }
  return n ? Math.round(total / n) : 0;
}

// ─── Records ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type RunRecord = AnswerRecord | JudgeRecord;

/** The run's records, oldest first. A line torn by a crash is skipped and counted. */
export function loadRecords(path: string): { records: RunRecord[]; torn: number } {
  if (!existsSync(path)) return { records: [], torn: 0 };
  const records: RunRecord[] = [];
  let torn = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { torn++; }
  }
  return { records, torn };
}

class RecordStore {
  readonly answers = new Map<string, AnswerRecord>();
  readonly judges = new Map<string, JudgeRecord>();
  readonly judges2 = new Map<string, JudgeRecord>();
  readonly torn: number;
  constructor(private readonly path: string) {
    const { records, torn } = loadRecords(path);
    this.torn = torn;
    if (torn && !readFileSync(path, 'utf8').endsWith('\n')) appendFileSync(path, '\n');
    for (const r of records) this.index(r);
  }
  get size() { return this.answers.size; }
  private index(r: RunRecord) {
    if (r.kind === 'answer') this.answers.set(r.key, r);
    else (r.kind === 'judge' ? this.judges : this.judges2).set(r.key, r);
  }
  /** One record, appended synchronously, so concurrent episodes never interleave a line. */
  write(r: RunRecord) {
    appendFileSync(this.path, JSON.stringify(r) + '\n', { mode: 0o600 });
    this.index(r);
  }
}

// ─── Scheduling ────────────────────────────────────────────────────────────────────────────────────────────────────

/** At most n calls in flight; a released slot passes straight to the next waiter. */
function semaphore(n: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async <T>(run: () => Promise<T>): Promise<T> => {
    if (active < n) active++;
    else await new Promise<void>(resolve => queue.push(resolve));
    try { return await run(); } finally { const next = queue.shift(); if (next) next(); else active--; }
  };
}

async function pool<T>(items: T[], n: number, work: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await work(items[i++]!); }));
}

/** A task's arm-model cells in an order seeded from its id. */
export function cellOrder(taskId: string, arms: readonly TaskArm[], models: readonly string[]): Array<[TaskArm, string]> {
  const cells = arms.flatMap(a => models.map(m => [a, m] as [TaskArm, string]));
  let seed = parseInt(sha256(SEED + ':' + taskId).slice(0, 8), 16) | 0;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [cells[i], cells[j]] = [cells[j]!, cells[i]!];
  }
  return cells;
}

/** n tasks spread over the five types in turn, for the smoke. */
export function spread(tasks: Task[], n: number): Task[] {
  const queues = TYPES.map(t => tasks.filter(x => x.type === t));
  const out: Task[] = [];
  while (out.length < Math.min(n, tasks.length)) for (const q of queues) if (q.length && out.length < n) out.push(q.shift()!);
  return out;
}

/**
 * Note every refusal of the budget guard that reaches a fetch caller. gbrain catches a refused embedding or rerank call
 * and degrades its search instead of failing, so the episode checks this after every call and turns the guard's own
 * error into the run's stop.
 */
export function watchRefusals() {
  const inner = globalThis.fetch;
  let refusal: Error | null = null;
  const watching = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try { return await inner(input, init); } catch (e) {
      if ((e as Error)?.name === 'BudgetExceededError') refusal ??= e as Error;
      throw e;
    }
  }) as typeof fetch;
  globalThis.fetch = watching;
  return {
    capped: () => refusal !== null,
    check: () => { if (refusal) throw refusal; },
    restore: () => { if (globalThis.fetch === watching) globalThis.fetch = inner; },
  };
}

function limiter() {
  const limits = new Map<string, ReturnType<typeof semaphore>>();
  return <T>(model: string, run: () => Promise<T>) => {
    const p = provider(model);
    if (!limits.has(p)) limits.set(p, semaphore(PROVIDER_CONCURRENCY));
    return limits.get(p)!(run);
  };
}

const judgedAfter = (a: AnswerRecord, j: JudgeRecord | undefined) => j !== undefined && j.at >= a.at;
const needsSecondJudge = (a: AnswerRecord) => a.form === 'paraphrase' && SECOND_JUDGE_ARMS.includes(a.arm) && secondJudgeFor(a.model) !== null;

// ─── run ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Paid { run: BudgetRun; guard: PaidRequestGuard; runner: string; capUsd: number; ledgerPath: string }

export interface RunOptions {
  out: string; gut: GbrainUnderTest; fixture: boolean;
  tasksPath: string; freezePath: string | null; databaseUrlEnv: string;
  forms: TaskForm[]; arms: TaskArm[]; models: string[];
  limit: number | null; concurrency: number; resume: boolean; windowNote: string | null;
  paid: Paid;
}

interface RunFile {
  identity: Record<string, unknown>;
  tasks_path: string; tasks_sha256: string; kept_ids: string[];
  task_summary: { submitted: number; kept_at_freeze: number; dropped_unreachable: number; gold_missing_at_run: number; sha_prefix: string; n_frozen: number };
  gold_page_chars_mean: number;
  custody: { readonly_verified_start: boolean; readonly_verified_end: boolean | null; guard_refusals: Record<string, number> };
  budget: { runner: string; run_id: string; ledger_path: string; cap_usd: number };
  forms: TaskForm[]; arms: TaskArm[]; models: string[];
}

const paths = (dir: string) => ({ run: join(dir, 'run.json'), records: join(dir, 'records.local.jsonl'), capStop: join(dir, 'cap-stop.json'), auditKey: join(dir, 'audit-key.local.json'), auditRows: join(dir, 'audit-rows.local.jsonl') });
const readRun = (dir: string): RunFile => JSON.parse(readFileSync(paths(dir).run, 'utf8'));
const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

function git(args: string[]): string {
  try { return execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' }).trim(); } catch { return ''; }
}

export type RunResult = 'complete' | 'incomplete' | 'cap_stop';

/** One counted run or fixture smoke: answers, judges and the scorecard. The caller owns the paid-request guard. */
export async function runTaskSet(o: RunOptions, say: (line: string) => void): Promise<{ result: RunResult; scorecard: string; markdown: string }> {
  const p = paths(o.out);
  mkdirSync(o.out, { recursive: true, mode: 0o700 });
  if (existsSync(p.capStop)) throw new LiveRecallAbort('LR_CAP_STOP', 'this run directory records a cap stop; nothing reruns');
  if (o.resume && !o.fixture && !o.windowNote) throw new LiveRecallAbort('LR_RESUME_NEEDS_WINDOW', 'a counted --resume needs --window-note');
  const store = new RecordStore(p.records);
  if (store.size > 0 && !o.resume) throw new Error('the run directory already holds records; pass --resume to continue it');
  const source = readFileSync(o.tasksPath, 'utf8');
  const parsed = parseTasks(source);
  let frozen: ReturnType<typeof freezeSummary> | null = null;
  if (!o.fixture) {
    if (!o.freezePath) throw new LiveRecallAbort('LR_FREEZE_MISMATCH', 'a counted run needs --freeze');
    frozen = JSON.parse(readFileSync(o.freezePath, 'utf8'));
    if (frozen?.schema !== FREEZE_SCHEMA || frozen.tasks_sha256 !== sha256(source)) throw new LiveRecallAbort('LR_FREEZE_MISMATCH', 'task file hash differs from the freeze');
  }
  const previous = o.resume && existsSync(p.run) ? readRun(o.out) : null;
  if (previous && previous.tasks_sha256 !== sha256(source)) throw new LiveRecallAbort('LR_FREEZE_MISMATCH', 'the resumed run was made on another task file');
  const startedAt = new Date().toISOString();
  const refusals = watchRefusals();
  const brain = await openBrain(o, refusals.capped).catch(e => { refusals.restore(); throw e; });
  say('gbrain ' + o.gut.version + ', schema ' + brain.schemaVersion + ', barrier ' + brain.barrier + ', connection ' + brain.connection + '; read-only verified; private pages hidden from remote callers');
  try {
    let candidates: Array<{ line: number; task: Task }>, summary: RunFile['task_summary'];
    if (o.fixture) {
      const { kept, dropped } = await goldCheck(brain.reader, parsed);
      candidates = kept;
      summary = { submitted: parsed.length, kept_at_freeze: kept.length, dropped_unreachable: dropped, gold_missing_at_run: 0, sha_prefix: sha256(source).slice(0, 12), n_frozen: kept.length };
    } else {
      const lines = new Set(frozen!.kept_lines);
      const atFreeze = parsed.filter(t => lines.has(t.line));
      if (atFreeze.length !== frozen!.n_kept) throw new LiveRecallAbort('LR_FREEZE_MISMATCH', 'kept line count differs from the freeze');
      const { kept, dropped } = await goldCheck(brain.reader, atFreeze);
      if (dropped / Math.max(1, atFreeze.length) > GOLD_MISSING_CAP) throw new LiveRecallAbort('LR_GOLD_MISSING_CAP', dropped + ' of ' + atFreeze.length + ' kept tasks lost a gold page since the freeze');
      candidates = kept;
      summary = { submitted: frozen!.n_submitted, kept_at_freeze: frozen!.n_kept, dropped_unreachable: frozen!.dropped_unreachable, gold_missing_at_run: dropped, sha_prefix: sha256(source).slice(0, 12), n_frozen: frozen!.n_kept };
    }
    let tasks = candidates.map(c => c.task);
    if (o.limit !== null) tasks = spread(tasks, o.limit);
    if (previous) {
      const ids = new Set(previous.kept_ids);
      tasks = tasks.filter(t => ids.has(t.id));
    }
    say(summary.submitted + ' tasks submitted, ' + summary.kept_at_freeze + ' kept at the freeze, ' + summary.dropped_unreachable + ' dropped as unreachable to a remote caller, ' + summary.gold_missing_at_run + ' lost since; running ' + tasks.length);
    await preflight(brain.reader);
    refusals.check();
    say('preflight passed: the public probe query ran clean through D\'s search and B\'s query tool');
    const pinCommit = (gbrainPin().split('#')[1] ?? 'unknown').toLowerCase();
    const hex = (v: string) => (/^[0-9a-f]{7,64}$/.test(v) ? v : 'unknown');
    const run: RunFile = {
      identity: {
        started_at: previous?.identity.started_at ?? startedAt, finished_at: null,
        runner_commit: git(['rev-parse', 'HEAD']) || 'unknown', runner_dirty: git(['status', '--porcelain', '--untracked-files=no']) !== '', harness_digest: harnessDigest(),
        gbrain_pin_version: JSON.parse(readFileSync(join(REPO_ROOT, 'node_modules/gbrain/package.json'), 'utf8')).version, gbrain_pin_commit: hex(pinCommit),
        gbrain_loaded_version: o.gut.version, gbrain_loaded_commit: o.gut.overlay?.build.commit ?? hex(pinCommit), gbrain_overlay: o.gut.overlay !== null,
        schema_version: brain.schemaVersion, engine: o.fixture ? 'pglite' : 'postgres', barrier: brain.barrier, connection: brain.connection, control: o.fixture,
        search_mode: String(brain.knobs.resolved_mode), reranker_enabled: Boolean(brain.knobs.reranker_enabled), reranker_model: String(brain.knobs.reranker_model), embedding_model: brain.embeddingModel,
        source_scope_default: brain.reader.sourceId === 'default', privacy_posture: 'remote', remote_private_pages: false,
        crag_escalation: brain.crag.escalation, crag_think: brain.crag.think, result_cache: brain.resultCache, tool_defs_digest: sha256(JSON.stringify(brain.reader.tools)),
        models: o.models, arms: o.arms, forms: o.forms, judges: Object.fromEntries(o.models.map(m => [m, judgeFor(m)])), second_judge_model: 'claude-opus-5-5',
        effort: EFFORT, max_output_tokens: MAX_OUTPUT_TOKENS, max_turns: MAX_TURNS, tool_result_chars: TOOL_RESULT_CHARS, paste_pages: PASTE_PAGES, paste_chars: PASTE_CHARS,
        budget_usd: o.paid.capUsd, window_note: o.windowNote, concurrency: o.concurrency, openai_store: false,
      },
      tasks_path: resolve(o.tasksPath), tasks_sha256: sha256(source), kept_ids: tasks.map(t => t.id), task_summary: summary,
      gold_page_chars_mean: await goldPageChars(brain.reader, tasks),
      custody: { readonly_verified_start: true, readonly_verified_end: null, guard_refusals: brain.counters.refusals },
      budget: { runner: o.paid.runner, run_id: o.paid.run.runId, ledger_path: o.paid.ledgerPath, cap_usd: o.paid.capUsd },
      forms: o.forms, arms: o.arms, models: o.models,
    };
    if (previous) {
      const was: Record<string, unknown> = { ...previous.identity, kept_ids: previous.kept_ids }, now: Record<string, unknown> = { ...run.identity, kept_ids: run.kept_ids };
      const norm = (v: unknown) => JSON.stringify(Array.isArray(v) ? [...v].sort() : v);
      const changed = RESUME_IDENTITY.filter(k => norm(was[k]) !== norm(now[k]));
      if (changed.length) throw new LiveRecallAbort('LR_FREEZE_MISMATCH', 'the resume differs from the first session in ' + changed.join(', '));
    }
    writeJson(p.run, run);
    if (store.torn) say(store.torn + ' torn record line(s) from an interrupted write were skipped');

    const ctx: EpisodeContext = { reader: brain.reader, limit: limiter(), capCheck: refusals.check };
    const halt: { cap: Error | null; fatal: unknown } = { cap: null, fatal: null };
    const stopped = () => halt.cap !== null || halt.fatal !== null;
    const cell = async (form: TaskForm, task: Task, arm: TaskArm, model: string) => {
      let a = store.answers.get(episodeKey(form, task.id, arm, model));
      while (!a || (a.status === 'harness_error' && a.attempt < MAX_ATTEMPTS)) {
        if (stopped()) return;
        a = await runEpisode(ctx, task, form, arm, model, (a?.attempt ?? 0) + 1);
        await assertPrivate(o.gut, brain.engine);
        if (a.status === 'degraded') await preflight(brain.reader).catch(e => { ctx.capCheck(); throw e; });
        store.write(a);
      }
      if (a.status !== 'answered') return;
      if (!judgedAfter(a, store.judges.get(a.key))) store.write(await judgeEpisode(ctx, task, a, judgeFor(model), 'judge'));
      if (needsSecondJudge(a) && !judgedAfter(a, store.judges2.get(a.key))) store.write(await judgeEpisode(ctx, task, a, secondJudgeFor(model)!, 'judge2'));
    };
    for (const form of FORMS.filter(f => o.forms.includes(f))) {
      let done = 0;
      await pool(tasks, o.concurrency, async task => {
        try {
          if (stopped()) return;
          await assertPrivate(o.gut, brain.engine);
          for (const [arm, model] of cellOrder(task.id, o.arms, o.models)) {
            if (stopped()) return;
            await cell(form, task, arm, model);
          }
        } catch (e) {
          if (isCapStop(e)) halt.cap ??= e as Error;
          else halt.fatal ??= e;
          return;
        }
        done++;
        if (done % 10 === 0 || done === tasks.length) say(form + ' pass: ' + done + '/' + tasks.length + ' tasks');
      });
      if (stopped()) break;
    }
    if (halt.fatal) throw halt.fatal;
    if (halt.cap) {
      const s = o.paid.run.summary();
      writeJson(p.capStop, { at: new Date().toISOString(), message: halt.cap.message, actual_usd: s.actual_usd, reserved_usd: s.reserved_usd, charged_reservations: s.charged_reservations });
      say('LR_CAP_STOP: the ledger refused a reservation; spent $' + s.actual_usd.toFixed(2) + ' of $' + o.paid.capUsd.toFixed(2) + ' (' + s.charged_reservations + ' requests charged at their reservation). The run is incomplete and is never rerun.');
    }
    await verifyReadOnly(brain.engine);
    run.custody.readonly_verified_end = true;
    run.identity.finished_at = new Date().toISOString();
    writeJson(p.run, run);
  } finally {
    refusals.restore();
    await brain.close();
  }
  const scored = scoreRunDir(o.out);
  const result: RunResult = existsSync(p.capStop) ? 'cap_stop' : scored.complete ? 'complete' : 'incomplete';
  return { result, scorecard: scored.scorecard, markdown: scored.markdown };
}

// ─── judge, audit, score ───────────────────────────────────────────────────────────────────────────────────────────

function runTasksOf(run: RunFile): Task[] {
  const source = readFileSync(run.tasks_path, 'utf8');
  if (sha256(source) !== run.tasks_sha256) throw new LiveRecallAbort('LR_FREEZE_MISMATCH', 'the task file changed since the run');
  const byId = new Map(parseTasks(source).map(t => [t.task.id, t.task]));
  return run.kept_ids.map(id => byId.get(id)!).filter(Boolean);
}

/** Judge every answered episode whose judge is missing, older than the answer, or a judge_error; never re-answers. */
export async function judgeRunDir(dir: string, paid: Paid, say: (line: string) => void): Promise<number> {
  const p = paths(dir);
  if (existsSync(p.capStop)) throw new LiveRecallAbort('LR_CAP_STOP', 'this run directory records a cap stop; nothing reruns');
  const run = readRun(dir);
  const tasks = new Map(runTasksOf(run).map(t => [t.id, t]));
  const store = new RecordStore(p.records);
  const refusals = watchRefusals();
  const ctx = { limit: limiter(), capCheck: refusals.check };
  let judged = 0;
  const halt: { cap: Error | null } = { cap: null };
  try {
    const todo = [...store.answers.values()].filter(a => a.status === 'answered' && tasks.has(a.task));
    await pool(todo, TASK_CONCURRENCY, async a => {
      if (halt.cap) return;
      const task = tasks.get(a.task)!;
      try {
        const j = store.judges.get(a.key);
        if (!judgedAfter(a, j) || j!.status === 'judge_error') { store.write(await judgeEpisode(ctx, task, a, judgeFor(a.model), 'judge')); judged++; }
        const j2 = store.judges2.get(a.key);
        if (needsSecondJudge(a) && (!judgedAfter(a, j2) || j2!.status === 'judge_error')) { store.write(await judgeEpisode(ctx, task, a, secondJudgeFor(a.model)!, 'judge2')); judged++; }
      } catch (e) {
        if (!isCapStop(e)) throw e;
        halt.cap ??= e as Error;
      }
    });
  } finally { refusals.restore(); }
  if (halt.cap) {
    const s = paid.run.summary();
    writeJson(p.capStop, { at: new Date().toISOString(), message: halt.cap.message, actual_usd: s.actual_usd, reserved_usd: s.reserved_usd, charged_reservations: s.charged_reservations });
    say('LR_CAP_STOP during judging; the run is incomplete and is never rerun.');
  }
  say(judged + ' judge calls made');
  return judged;
}

/**
 * Draw the Wintermute audit: n judged answers, seeded, blind to arm and model. audit-rows.local.jsonl holds what the
 * grader reads (question, gold answer, answer, cited page snapshots); audit-key.local.json maps each row to its episode
 * and the counted judge's verdict. Both stay on the box. The grader writes one line per row, {"row": n, "correct": bool}.
 */
export function drawAudit(dir: string, n = AUDIT_ROWS): number {
  const p = paths(dir);
  const run = readRun(dir);
  const tasks = new Map(runTasksOf(run).map(t => [t.id, t]));
  const store = new RecordStore(p.records);
  const eligible = [...store.answers.values()].filter(a => a.status === 'answered' && store.judges.get(a.key)?.status === 'ok' && judgedAfter(a, store.judges.get(a.key)) && tasks.has(a.task));
  const keyed = eligible.map(a => ({ a, k: sha256(SEED + ':audit:' + a.key) })).sort((x, y) => x.k.localeCompare(y.k)).slice(0, n);
  writeFileSync(p.auditRows, keyed.map(({ a }, i) => {
    const t = tasks.get(a.task)!;
    return JSON.stringify({ row: i + 1, question: t.forms[a.form], gold_answer: t.gold_answer, answer: a.answer, cited: a.cited, pages: a.snapshots });
  }).join('\n') + '\n', { mode: 0o600 });
  writeJson(p.auditKey, keyed.map(({ a }, i) => ({ row: i + 1, key: a.key, judge_correct: store.judges.get(a.key)!.derived!.correct })));
  return keyed.length;
}

function auditAgreement(dir: string, gradesPath: string): { n: number; agree: number } {
  const key = JSON.parse(readFileSync(paths(dir).auditKey, 'utf8')) as Array<{ row: number; judge_correct: boolean }>;
  const grades = new Map<number, boolean>();
  for (const line of readFileSync(gradesPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const g = JSON.parse(line);
    if (Number.isInteger(g?.row) && typeof g?.correct === 'boolean') grades.set(g.row, g.correct);
  }
  const graded = key.filter(k => grades.has(k.row));
  return { n: graded.length, agree: graded.filter(k => grades.get(k.row) === k.judge_correct).length };
}

function ledgerUsd(budget: RunFile['budget']): number | null {
  try {
    const entries = readLedger(budget.ledger_path).entries.filter(e => e.run_id === budget.run_id);
    return entries.reduce((s, e) => s + (e.actual_usd ?? e.reserved_usd), 0);
  } catch { return null; }
}

/** Build, check and write scorecard.json and scorecard.md from the run directory alone. Re-runnable. */
export function scoreRunDir(dir: string, opts: { auditGrades?: string } = {}): { scorecard: string; markdown: string; complete: boolean } {
  const p = paths(dir);
  const run = readRun(dir);
  const tasks = runTasksOf(run);
  const { records } = loadRecords(p.records);
  const card = buildTaskScorecard({
    tasks, forms: run.forms, arms: run.arms, models: run.models, records, identity: run.identity, task_summary: run.task_summary, custody: run.custody,
    stop: existsSync(p.capStop) ? 'LR_CAP_STOP' : null, ledger_usd: ledgerUsd(run.budget), audit: opts.auditGrades ? auditAgreement(dir, opts.auditGrades) : null,
  });
  const json = JSON.stringify(card, null, 2) + '\n';
  const markdown = renderTaskMarkdown(card);
  checkOutbound(json, markdown, taskNeedles(tasks, records));
  const scorecard = join(dir, 'scorecard.json'), md = join(dir, 'scorecard.md');
  writeFileSync(scorecard, json);
  writeFileSync(md, markdown);
  return { scorecard, markdown: md, complete: card.status === 'complete' };
}

// ─── estimate ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Estimate { per_task_form_usd: number; second_judge_per_task_usd: number; paraphrase_usd: number; total_usd: number; cap_usd: number; page_factor: Record<string, number>; passed: boolean }

/**
 * Project the counted cost from the smoke's measured usage per episode. Input tokens of every role that reads pages are
 * scaled by the ratio of the frozen gold pages' mean size to the smoke's, each side capped at what that role reads of a
 * page (B and C's summariser: a tool result; D: a pasted page; the judge: a cited page); A, C's answerer and every output
 * stay as measured.
 */
export function estimateCost(smoke: RunRecord[], smokePageChars: number, pageChars: number, n: number, forms: number, capUsd: number, models: readonly string[] = MODELS, arms: readonly TaskArm[] = ARMS): Estimate {
  const factor = (cap: number) => Math.max(1, Math.min(pageChars, cap) / Math.max(1, Math.min(smokePageChars, cap)));
  const f = { tool: factor(TOOL_RESULT_CHARS), paste: factor(PASTE_CHARS), judge: factor(JUDGE_PAGE_CHARS) };
  const scale = (u: Usage, k: number): Usage => ({ input: u.input * k, cache_read: u.cache_read * k, cache_write: u.cache_write * k, output: u.output, requests: u.requests });
  const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const mean = (xs: Usage[]): Usage | null => xs.length ? { input: avg(xs.map(x => x.input)), output: avg(xs.map(x => x.output)), cache_read: avg(xs.map(x => x.cache_read)), cache_write: avg(xs.map(x => x.cache_write)), requests: avg(xs.map(x => x.requests)) } : null;
  const answers = smoke.filter((r): r is AnswerRecord => r.kind === 'answer');
  const judgesOf = (kind: JudgeRecord['kind'], keys: Set<string>) => smoke.filter((r): r is JudgeRecord => r.kind === kind && keys.has(r.key)).map(r => r.usage);
  let perTaskForm = 0, secondJudge = 0;
  for (const arm of arms) for (const model of models) {
    const rows = answers.filter(a => a.arm === arm && a.model === model);
    const keys = new Set(rows.map(a => a.key));
    const answer = mean(rows.flatMap(a => (a.roles.answer ? [a.roles.answer.usage] : [])));
    const judge = mean(judgesOf('judge', keys));
    if (!answer || !judge) throw new Error('the smoke has no ' + (answer ? 'judged ' : '') + 'episode for arm ' + arm + ' and ' + model);
    perTaskForm += priceUsage(model, scale(answer, arm === 'B' ? f.tool : arm === 'D' ? f.paste : 1));
    if (arm === 'C') {
      const summariser = mean(rows.flatMap(a => (a.roles.summariser ? [a.roles.summariser.usage] : [])));
      if (!summariser) throw new Error('the smoke has no summariser call for ' + model);
      perTaskForm += priceUsage(model, scale(summariser, f.tool));
    }
    perTaskForm += priceUsage(judgeFor(model), scale(judge, arm === 'A' ? 1 : f.judge));
    const second = secondJudgeFor(model);
    if (second && SECOND_JUDGE_ARMS.includes(arm)) {
      const j2 = mean(judgesOf('judge2', keys));
      if (!j2) throw new Error('the smoke has no second-judge call for arm ' + arm);
      secondJudge += priceUsage(second, scale(j2, f.judge));
    }
  }
  const paraphrase = n * (perTaskForm + secondJudge);
  const total = paraphrase + (forms > 1 ? n * perTaskForm * (forms - 1) : 0);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    per_task_form_usd: r2(perTaskForm), second_judge_per_task_usd: r2(secondJudge), paraphrase_usd: r2(paraphrase), total_usd: r2(total), cap_usd: capUsd,
    page_factor: { tool_result: r2(f.tool), paste: r2(f.paste), judge: r2(f.judge) }, passed: paraphrase <= COST_GATE_SHARE * capUsd && total <= capUsd,
  };
}

// ─── CLI ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

function list<T extends string>(raw: string | undefined, all: readonly T[], name: string): T[] {
  if (raw === undefined) return [...all];
  const xs = raw.split(',').map(s => s.trim()).filter(Boolean);
  const bad = xs.filter(x => !(all as readonly string[]).includes(x));
  if (bad.length || !xs.length) throw new Error(name + ' takes a comma list of ' + all.join(', '));
  return all.filter(a => xs.includes(a));
}

/** Run one command with the terminal kept to say() lines; everything else goes to the run's local log. */
async function withLog<T>(dir: string, body: (say: (line: string) => void) => Promise<T>): Promise<T | number> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { say, restore } = captureOutput(join(dir, 'gbrain.local.log'));
  try {
    return await body(say);
  } catch (error) {
    if (error instanceof LiveRecallAbort) {
      say('ABORT ' + error.code + ': ' + error.detail);
      say('fix: ' + ABORT_CODES[error.code] + ' (docs/benchmarks/live-recall/RUN-KIT.md#' + error.code.toLowerCase() + ').');
      return 3;
    }
    say('ABORT LR_INTERNAL: ' + (error instanceof Error ? error.name : 'unknown') + '; the full message is in ' + join(dir, 'gbrain.local.log') + ', which stays on this box.');
    console.error(error instanceof Error ? error.stack : String(error));
    return 4;
  } finally {
    restore();
  }
}

/** The scorecard's judge errors and invalid cells, as codes and counts for the terminal. */
function sayScorecard(path: string, say: (line: string) => void): void {
  const card = JSON.parse(readFileSync(path, 'utf8'));
  let judgeErrors = 0, invalid = 0;
  for (const form of FORMS) for (const byModel of Object.values(card.cells?.[form] ?? {}) as Array<Record<string, any>>) for (const c of Object.values(byModel)) {
    judgeErrors += c.excluded?.judge_error ?? 0;
    if (c.invalid) invalid++;
  }
  if (judgeErrors) say('LR_JUDGE_ERROR: ' + judgeErrors + ' answers have no verdict; tasks.ts judge <run dir> re-judges them without re-answering');
  if (invalid) say('LR_CELL_INVALID: ' + invalid + ' form, arm and model cells passed their error or degraded-search cap; the scorecard marks them invalid');
}

function openPaid(argv: string[], runner: string, capUsd: number): Paid {
  const options = budgetOptionsFrom(argv);
  const paid = openBudgetItem({ runner, cap_usd: capUsd }, options);
  return { ...paid, runner, capUsd, ledgerPath: options.ledgerPath };
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  const fixture = argv.includes('--fixture');
  const tasksPath = fixture ? FIXTURE_TASKS : flag(argv, '--tasks');
  const databaseUrlEnv = flag(argv, '--database-url-env') ?? 'LIVE_RECALL_DATABASE_URL';
  if (command === 'check') {
    if (!tasksPath) { console.error('usage: tasks.ts check (--fixture | --tasks <file>)'); return 2; }
    try {
      const parsed = parseTasks(readFileSync(tasksPath, 'utf8'));
      console.log('live-recall: ' + parsed.length + ' tasks valid; by type ' + JSON.stringify(byType(parsed.map(t => t.task))));
      return 0;
    } catch (e) {
      if (!(e instanceof LiveRecallAbort)) throw e;
      console.error('live-recall: ABORT ' + e.code + ': ' + e.detail);
      return 3;
    }
  }
  if (command === 'freeze' || command === 'estimate') {
    const out = flag(argv, '--out');
    if (!tasksPath || (command === 'freeze' && !out) || (command === 'estimate' && (!flag(argv, '--freeze') || !flag(argv, '--smoke')))) {
      console.error('usage: tasks.ts freeze (--fixture | --tasks <file> --gbrain <checkout>@<commit>) --out <freeze.json>\n       tasks.ts estimate --tasks <file> --freeze <freeze.json> --smoke <smoke run dir> --gbrain <checkout>@<commit> [--out <estimate.json>]');
      return 2;
    }
    return withLog(join(dirname(resolve(out ?? flag(argv, '--freeze')!)), command + '-log'), async say => {
      const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
      const source = readFileSync(tasksPath, 'utf8');
      const parsed = parseTasks(source);
      const brain = await openBrain({ fixture, gut, databaseUrlEnv }, () => false);
      try {
        if (command === 'freeze') {
          const { kept } = await goldCheck(brain.reader, parsed);
          const summary = freezeSummary(source, parsed, kept, gut);
          writeJson(out!, summary);
          say('freeze ' + out + ': ' + summary.n_submitted + ' submitted, ' + summary.n_kept + ' kept, ' + summary.dropped_unreachable + ' dropped as unreachable to a remote caller; MDD at alpha 0.05 with 20% discordant pairs ' + (100 * (summary.mdd_primaries.pd20.alpha_05 ?? 0)).toFixed(1) + ' points (' + (100 * (summary.mdd_primaries.pd20.holm_0125 ?? 0)).toFixed(1) + ' at Holm\'s tightest)');
          if (!fixture && summary.n_kept < MIN_TASKS) { say('FREEZE UNDER MINIMUM: ' + summary.n_kept + ' kept is under ' + MIN_TASKS + '; tell GBEV-3 before this freeze is committed or used.'); return 5; }
          return 0;
        }
        const frozen = JSON.parse(readFileSync(flag(argv, '--freeze')!, 'utf8'));
        if (frozen?.schema !== FREEZE_SCHEMA || frozen.tasks_sha256 !== sha256(source)) throw new LiveRecallAbort('LR_FREEZE_MISMATCH', 'task file hash differs from the freeze');
        const lines = new Set<number>(frozen.kept_lines);
        const kept = parsed.filter(t => lines.has(t.line)).map(t => t.task);
        const smokeDir = flag(argv, '--smoke')!;
        const smokeRun = readRun(smokeDir);
        const e = estimateCost(loadRecords(paths(smokeDir).records).records, smokeRun.gold_page_chars_mean, await goldPageChars(brain.reader, kept), kept.length, FORMS.length, COUNTED_CAP_USD);
        if (out) writeJson(out, e);
        say('estimate: $' + e.per_task_form_usd.toFixed(2) + ' per task form (+$' + e.second_judge_per_task_usd.toFixed(2) + ' second judge per paraphrase task), page factors ' + JSON.stringify(e.page_factor) + '; projected paraphrase pass $' + e.paraphrase_usd.toFixed(2) + ', total $' + e.total_usd.toFixed(2) + ' against the $' + e.cap_usd + ' cap');
        if (!e.passed) throw new LiveRecallAbort('LR_COST_GATE', 'projected paraphrase pass $' + e.paraphrase_usd.toFixed(2) + ' (gate $' + (COST_GATE_SHARE * e.cap_usd).toFixed(2) + '), total $' + e.total_usd.toFixed(2) + ' (cap $' + e.cap_usd + ')');
        say('cost gate passed');
        return 0;
      } finally {
        await brain.close();
      }
    });
  }
  if (command === 'judge' || command === 'score' || command === 'audit') {
    const dir = argv[1] && !argv[1].startsWith('--') ? resolve(argv[1]) : null;
    if (!dir || !existsSync(paths(dir).run)) { console.error('usage: tasks.ts ' + command + ' <run dir>'); return 2; }
    return withLog(dir, async say => {
      if (command === 'audit') {
        const n = drawAudit(dir, Number(flag(argv, '--n') ?? AUDIT_ROWS));
        say(n + ' audit rows in ' + paths(dir).auditRows + ' (stays on this box); grades go one per line as {"row": n, "correct": true|false}');
        return 0;
      }
      if (command === 'judge') {
        const run = readRun(dir);
        const paid = openPaid(['--budget-ledger', run.budget.ledger_path, ...argv], run.budget.runner, run.budget.cap_usd);
        try { await judgeRunDir(dir, paid, say); } finally { paid.guard.uninstall(); paid.run.close({ finish: existsSync(paths(dir).capStop) }); }
      }
      const s = scoreRunDir(dir, { auditGrades: flag(argv, '--audit-grades') });
      sayScorecard(s.scorecard, say);
      say('scorecard (' + (s.complete ? 'complete' : 'incomplete') + '; send these two files): ' + s.scorecard + ' and ' + s.markdown);
      return 0;
    });
  }
  if (command !== 'run') { console.error('usage: tasks.ts check|freeze|estimate|run|judge|audit|score (see the header of this file)'); return 2; }
  if (!tasksPath) { console.error('usage: tasks.ts run (--fixture | --tasks <file> --freeze <freeze.json> --gbrain <checkout>@<commit>) --budget-usd <dollars> --budget-ledger <ledger>'); return 2; }
  const out = resolve(flag(argv, '--out') ?? join(REPO_ROOT, 'eval/reports/live-recall-tasks', new Date().toISOString().replace(/[:.]/g, '-') + (fixture ? '-fixture' : '')));
  let models: string[], forms: TaskForm[], arms: TaskArm[];
  try {
    models = list(flag(argv, '--models'), MODELS, '--models');
    forms = list(flag(argv, '--forms'), FORMS, '--forms');
    arms = list(flag(argv, '--arms'), ARMS, '--arms');
  } catch (e) { console.error('live-recall: ' + (e as Error).message); return 2; }
  const missing = [...new Set(models.map(m => KEY_ENV[provider(m)]))].filter(k => !process.env[k]);
  if (missing.length) { console.error('live-recall: set ' + missing.join(', ') + ' (test -n only; never print them)'); return 2; }
  const capUsd = fixture ? SMOKE_CAP_USD : COUNTED_CAP_USD;
  const budgetUsd = budgetOptionsFrom(argv).budgetUsd;
  if (budgetUsd === null || budgetUsd > capUsd) { console.error('live-recall: pass --budget-usd at most ' + capUsd + ' (the ' + (fixture ? 'smoke' : 'counted') + ' cap) and --budget-ledger'); return 2; }
  return withLog(out, async say => {
    process.env.GBRAIN_AUDIT_DIR = out;
    const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
    const paid = openPaid(argv, fixture ? 'live-recall-phase2-smoke' : 'live-recall-phase2', budgetUsd);
    let result: RunResult = 'incomplete';
    try {
      const r = await runTaskSet({
        out, gut, fixture, tasksPath, freezePath: flag(argv, '--freeze') ?? null, databaseUrlEnv, forms, arms, models,
        limit: flag(argv, '--limit') ? Number(flag(argv, '--limit')) : null, concurrency: Number(flag(argv, '--concurrency') ?? TASK_CONCURRENCY),
        resume: argv.includes('--resume'), windowNote: flag(argv, '--window-note') ?? null, paid: { ...paid, capUsd: budgetUsd },
      }, say);
      result = r.result;
      sayScorecard(r.scorecard, say);
      say('scorecard (' + r.result + '; send these two files): ' + r.scorecard + ' and ' + r.markdown);
      say('records, run.json and the gbrain log stay on this box: ' + out);
      return result === 'cap_stop' ? 6 : result === 'complete' ? 0 : 1;
    } finally {
      paid.guard.uninstall();
      const s = paid.run.close({ finish: result === 'cap_stop' });
      say('ledger run ' + s.run_id + ': $' + s.actual_usd.toFixed(4) + ' over ' + s.requests + ' requests');
    }
  });
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

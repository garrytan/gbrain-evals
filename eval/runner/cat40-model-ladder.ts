/**
 * Cat 40: Model Ladder. Does gbrain's advantage over simpler memory persist
 * as models improve?
 *
 * Runs every (model, arm, task) cell of the fictional company world in
 * eval/data/model-ladder-v1 through one agent loop (cat40/loop.ts). Arms differ
 * only in their tools. Writes one JSON line per cell to results.jsonl (a rerun
 * with the same --out resumes), then a summary and receipt.
 *
 * Protocol: docs/benchmarks/2026-10-02-model-ladder-protocol.md.
 *
 * Usage:
 *   bun eval/runner/cat40-model-ladder.ts --models claude-sonnet-4-6,gpt-5.4 \
 *     --arms oracle,fs,pg,memory,gbrain --budget-usd 100 [--families A,B] [--tasks A01,B02] \
 *     [--repeat 1] [--concurrency 6] [--slots 3] [--gbrain-repo ../gbrain --gbrain-ref <sha>] \
 *     [--judge gpt-5.4-mini|none] [--world eval/data/model-ladder-v1-large/world.json] [--out eval/reports/cat40/<name>] \
 *     [--max-tool-chars <n>|none] [--order task|model] [--slot-ref <sha>] [--no-pglite-analyze] [--surface starter] [--advertised verbs|starter|full] [--gbrain-config key=value,...]
 *     [--gbrain-instructions-file <file>] [--gbrain-tool-descriptions-file <json>] [--gbrain-drop-tools a,b]
 *       (evaluator-side A/B of the instruction and tool-description text the model sees; gbrain code unchanged)
 *   bun eval/runner/cat40-model-ladder.ts --scripted --arms fs,memory,oracle   (hermetic, $0)
 *   --gbrain <checkout>@<ref> is shorthand for --gbrain-repo <checkout> --gbrain-ref <ref>.
 *
 * Worlds: v1 (default), `--world eval/data/model-ladder-wide-dev/world.json` (scale wide: families A-F plus
 * H, hidden tool; every record carries its task's stratum). Dev mode runs only dev seeds and dev template sets.
 * Custodian (held-out) mode: --world <custody dir>/world.json --world-templates-file <custody path>
 *   --decision-id <id> --purpose <text> --out <dir outside the repository>. The templates file gets an
 *   access-log.jsonl line beside it before its contents are used (the world is regenerated from it and must
 *   match); the receipt records only the templates file's SHA-256.
 *   bun eval/runner/cat40-model-ladder.ts --build-slots --gbrain-ref <sha> --slots 5 --budget-usd 10 --slot-build-allowance-usd 2
 *
 * Tool results reach the model whole unless --max-tool-chars <n> sets a cap
 * (`none` spells the default). gbrain slot brains are built by their own
 * `--build-slots` step, one at a time; an agent step refuses to start when
 * a snapshot it needs is missing, or when a slot's recorded mention coverage
 * (`slotN.coverage.json`, from a build whose gbrain reports it) is not
 * `complete` with 0 pending pages. Each --out directory is bound to one
 * experiment (experiment.json): a rerun with the same command resumes and
 * joins the step's original budget run; a different build, world or flag set
 * is refused. `--order model` finishes each model's tasks before the next.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { generateLadderWorld, worldDigest, DEFAULT_LADDER_DIR, WIDE_FAMILIES, stratumOf, openCustodianTemplates, assertDevWorld, type LadderTask, type LadderWorld, type Family, type Stratum } from '../generators/model-ladder-gen.ts';
import { gbrainSpecFrom, parseGbrainSpec } from './gbrain-under-test.ts';
import { runAgent, runAgentText, provider, HarnessError, type AgentRun, type Arm, type ScriptedModel } from './cat40/loop.ts';
import { FsArm, MemoryArm, OracleArm, FileStore, isWriteCall, type ArmName } from './cat40/arms.ts';
import { renderDoc } from '../generators/model-ladder-gen.ts';
import { PgArm, PgStore, cachedOpenAIEmbedder } from './cat40/pg-arm.ts';
import { GbrainArm, instructionsOverride, GbrainPool, GbrainSlot, MeteringProxy, SERVE_BOOT_TIMEOUT_SECONDS, STAGED_SOURCE_ADD_DOCS, STAGED_SYNC_BATCH, coverageProblem, type Meter, type SlotBuild, type SlotCoverage } from './cat40/gbrain-arm.ts';
import { scoreTask, judgePrompt, parseClaims, JUDGE_PROMPT_VERSION, type TaskScore, type ClaimVerdicts } from './cat40/score.ts';
import { budgetOptionsFrom, startPaidRun, receiptCost, type BudgetRun, type PaidRequestGuard } from './budget-ledger.ts';
import { HARD_FAMILIES, isHardWorld, type HardWorld, type HardTask } from '../generators/hard/schema.ts';
import { hardWorldDigest } from '../generators/model-ladder-hard.ts';
import {
  HardStop, hardRefusals, checkHardWorld, identityOf, identityRefusal, requiresFreeze, oracleOversize, runHardCell, runWithRetries, hardTranscripts, codeHashes, settingsDigest,
  type HardCtx,
} from './cat40/hard.ts';
import { HARD_MAX_RETRIES, type CellRecordV2 } from './cat40/records.ts';
import { HARD_SCORER_VERSION } from './cat40/score-hard.ts';
import { HARD_JUDGE_PROMPT_VERSION } from './cat40/judge-hard.ts';
import { terminateGrepWorkers } from './cat40/hard-grep.ts';
import { checkRoster, loadRoster, project, loadCostBasis, frozenKnobDigest, freezeDrift, REPO_ROOT, type StepPlan } from './cat40/hard-ops.ts';
import { canonicalCells, readRecords } from './cat40/records.ts';
import { CHAT_PRICE_OVERRIDES } from './budget-ledger.ts';
import { prepareBuild } from './lifecycle/builds.ts';

export const CAT40_VERSION = 'cat40-v1';

export function systemPrompt(world: LadderWorld, arm: Arm): string {
  const p = world.principal;
  return [
    `You are an AI assistant working for ${p.name}, an ${p.role} at Acme Example Inc. Today is ${world.today}.`,
    'Answer using the company knowledge base available through your tools. Do not guess.',
    `Some information is restricted. Share only what ${p.name.split(' ')[0]} is allowed to see.`,
    arm.systemHint(),
    'When you are done, call submit_answer with the value only in `answer` (or one value per requested item in `fields`), the ids or paths of the documents you relied on in `sources`, and any caveats in `notes`. Write dates as YYYY-MM-DD.',
    `If the information is not available to ${p.name.split(' ')[0]}, answer NOT_ACCESSIBLE. If the knowledge base does not contain it, answer UNKNOWN.`,
  ].join('\n\n');
}

export function userMessage(world: LadderWorld, task: LadderTask, arm: Arm, session: 1 | 2): string {
  if (session === 1) return task.session1!;
  const parts = [task.question];
  if (task.answer_kind === 'fields') parts.push(`Use these keys in fields: ${task.fields!.join(', ')}.`);
  if (arm.name === 'oracle') parts.push(`Relevant documents:\n\n${OracleArm.evidence(world, task)}`);
  return parts.join('\n\n');
}

export interface CellRecord {
  key: string;
  model: string;
  provider: string;
  arm: string;
  task: string;
  family: Family;
  /** memory-only (A, B, C, E), page-authoring (F) or hidden-tool (H). */
  /** Absent on records written before the wide world (derive it with stratumOf(family)). */
  stratum?: Stratum;
  variant: string;
  repeat: number;
  score: TaskScore;
  claims: ClaimVerdicts | null;
  /** Set when the claims judge failed; the paid agent run is still recorded, with `claims: null`. */
  judge_error?: string;
  run: Omit<AgentRun, 'tools'> & { tool_calls: Array<{ name: string; ms: number; chars: number; truncated: boolean; error?: string }> };
  session1?: Omit<AgentRun, 'tools'> & { tool_calls: Array<{ name: string; ms: number; chars: number }> };
  /** gbrain's own provider calls during the cell (its sessions and the restore after it), from the metering proxy. */
  gbrain_internal?: Meter;
  /** Agent sessions plus gbrain's provider calls; the judge is separate. */
  total_usd: number;
  judge_usd?: number;
  /** Time to restore the gbrain slot after the cell (synchronous git, delete and tar work), so a restore stall is visible. */
  restore_ms?: number;
  /** The budget-ledger run that paid for the cell (for reconciliation in analyze.ts). */
  budget_run_id?: string | null;
  wall_ms: number;
  started_at: string;
}

/** Tool calls with (shortened) results per cell, for --transcripts diagnostics. */
export const lastTools = new Map<string, Array<{ session: number; name: string; args: Record<string, unknown>; result: string }>>();

function strip(r: AgentRun) {
  const { tools, ...rest } = r;
  return { ...rest, tool_calls: tools.map(t => ({ name: t.name, ms: t.ms, chars: t.chars, truncated: t.truncated, ...(t.error ? { error: t.error } : {}) })) };
}

/** Hermetic scripted agent: greps for the account, reads its files, submits whatever the first gold-shaped value is. Proves the plumbing, not quality. */
export function scriptedAgent(task: LadderTask, armName: string): ScriptedModel {
  return history => {
    const sub = { name: 'submit_answer', args: { answer: 'UNKNOWN', sources: [] as string[] } };
    if (armName === 'oracle') return sub;
    if (history.length === 0) {
      if (armName === 'memory') return { name: 'memory', args: { command: 'view', path: `/memories/accounts/${task.account}` } };
      return { name: 'list_dir', args: { path: `accounts/${task.account}` } };
    }
    return sub;
  };
}

interface Ctx {
  world: LadderWorld;
  /** Rendered corpus files, built once and shared read-only by every file-backed run (each run writes to its own overlay). */
  files: { all: Map<string, string>; acl: Map<string, string> };
  out: string;
  pg?: PgStore;
  pool?: GbrainPool;
  proxy?: MeteringProxy;
  scripted: boolean;
  judge: string | null;
  /** Arm name recorded for gbrain cells, so two gbrain builds can be compared (`--gbrain-label`). */
  gbrainLabel: string;
  /** Per-tool-result character cap for every arm (`--max-tool-chars`); null (the default) passes results through unmodified. */
  maxToolChars: number | null;
  budgetRunId: string | null;
  /** gbrain provider spend of cells that failed before writing a record (it is in the ledger, not in any cell). */
  failedCellsProxyUsd: number;
  /** Turns per session (`--max-turns`; the loop default otherwise). */
  maxTurns?: number;
}

async function judgeClaims(ctx: Ctx, task: LadderTask, run: AgentRun): Promise<{ claims: ClaimVerdicts | null; usd: number }> {
  if (!ctx.judge || ctx.scripted) return { claims: null, usd: 0 };
  const p = judgePrompt(ctx.world, task, run);
  if (!p) return { claims: null, usd: 0 };
  const r = await runAgentText(ctx.judge, p.system, p.user);
  return { claims: parseClaims(r.text), usd: r.usd };
}

async function runCell(ctx: Ctx, model: string, armName: ArmName, task: LadderTask, repeat: number): Promise<CellRecord> {
  const started = new Date();
  const label = armName === 'gbrain' ? ctx.gbrainLabel : armName;
  const runId = `${model}|${label}|${task.id}|${repeat}`;
  let arm: Arm;
  let slot: GbrainSlot | null = null;
  if (armName === 'fs') arm = new FsArm('fs', new FileStore(ctx.files.all));
  else if (armName === 'fs-acl') arm = new FsArm('fs-acl', new FileStore(ctx.files.acl));
  else if (armName === 'memory') arm = new MemoryArm(new FileStore(ctx.files.all));
  else if (armName === 'oracle') arm = new OracleArm();
  else if (armName === 'pg') arm = new PgArm(ctx.pg!, runId);
  else {
    slot = await ctx.pool!.acquire();
    // Every provider request the slot's server makes from now until its restore is charged to this cell.
    ctx.proxy!.bind(slot.id, runId);
    arm = new GbrainArm(slot);
  }
  let partial: Omit<CellRecord, 'total_usd' | 'wall_ms' | 'gbrain_internal' | 'restore_ms'> & { agent_usd: number } | null = null;
  let restoreMs: number | undefined;
  try {
    const isWrite = (name: string, args: Record<string, unknown>) => isWriteCall(arm, name, args);
    const common = { model, arm, system: systemPrompt(ctx.world, arm), maxToolChars: ctx.maxToolChars, ...(ctx.maxTurns ? { maxTurns: ctx.maxTurns } : {}) };
    let session1: AgentRun | undefined;
    if (task.family === 'F' && armName !== 'oracle') {
      session1 = await runAgent({ ...common, user: userMessage(ctx.world, task, arm, 1), scripted: ctx.scripted ? scriptedAgent(task, armName) : undefined });
      if (slot) await slot.newSession();
    }
    const run = await runAgent({ ...common, system: systemPrompt(ctx.world, arm), user: userMessage(ctx.world, task, arm, 2), scripted: ctx.scripted ? scriptedAgent(task, armName) : undefined });
    const score = scoreTask(task, run, { session1, isWrite });
    lastTools.set(runId, [...(session1?.tools ?? []).map(t => ({ session: 1, name: t.name, args: t.args, result: t.result.slice(0, 40_000) })), ...run.tools.map(t => ({ session: 2, name: t.name, args: t.args, result: t.result.slice(0, 40_000) }))]);
    let judged: { claims: ClaimVerdicts | null; usd: number; error?: string };
    try { judged = await judgeClaims(ctx, task, run); }
    catch (e) {
      if ((e as Error).name === 'BudgetExceededError') throw e;
      judged = { claims: null, usd: 0, error: (e as Error).message };
    }
    partial = {
      key: runId, model, provider: ctx.scripted ? 'scripted' : provider(model), arm: label, task: task.id, family: task.family, stratum: stratumOf(task.family), variant: task.variant, repeat,
      score, claims: judged.claims, ...(judged.error ? { judge_error: judged.error } : {}), run: strip(run), ...(session1 ? { session1: strip(session1) } : {}),
      judge_usd: judged.usd, budget_run_id: ctx.budgetRunId, started_at: started.toISOString(), agent_usd: run.usd + (session1?.usd ?? 0),
    };
  } finally {
    if (slot) {
      // Restore after every run: a session can change the brain without a write tool (startup sweeps write too).
      const t = Date.now();
      try { await slot.restore(); }
      finally {
        restoreMs = Date.now() - t;
        ctx.proxy!.unbind(slot.id);
        ctx.pool!.release(slot);
      }
    }
  }
  // After the restore, wait for the cell's last provider requests (they can finish after its server stopped).
  const gbrain_internal = slot ? await ctx.proxy!.finalize(runId) : undefined;
  const { agent_usd, ...rec } = partial!;
  return {
    ...rec, ...(gbrain_internal ? { gbrain_internal } : {}), ...(restoreMs !== undefined ? { restore_ms: restoreMs } : {}),
    total_usd: agent_usd + (gbrain_internal?.usd ?? 0), wall_ms: Date.now() - started.getTime(),
  };
}

/** After the first failure no new item starts, but items already running finish before it is rethrown (so gbrain slots stay up for them). */
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  let failure = null as { error: unknown } | null;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length && !failure) {
      const x = items[i++];
      try { await fn(x); } catch (error) { failure ??= { error }; }
    }
  }));
  if (failure) throw failure.error;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** `--max-tool-chars`: omitted or `none` is uncapped (null); otherwise a positive integer. */
export function parseMaxToolChars(raw: string | undefined): number | null {
  if (raw === undefined || raw === 'none') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--max-tool-chars must be a positive integer or "none" (got ${JSON.stringify(raw)})`);
  return n;
}

export type CellOrder = 'task' | 'model';
export interface PlannedCell { model: string; arm: ArmName; task: LadderTask; repeat: number }

/** The cell key a results.jsonl line carries. */
export const cellKey = (model: string, label: string, task: string, repeat: number) => `${model}|${label}|${task}|${repeat}`;

/**
 * Cells still to run. `task` order (the default) interleaves models within
 * each task; `model` order finishes every task and repeat of one model before
 * the next starts, so a run cut short by its budget leaves complete models.
 */
export function scheduleCells(o: { tasks: LadderTask[]; models: string[]; arms: ArmName[]; repeats: number; order: CellOrder; gbrainLabel: string; done: Set<string> }): PlannedCell[] {
  const cells: PlannedCell[] = [];
  const add = (model: string, task: LadderTask, r: number) => {
    for (const arm of o.arms) {
      if (arm === 'fs-acl' && task.family !== 'C') continue;
      if (!o.done.has(cellKey(model, arm === 'gbrain' ? o.gbrainLabel : arm, task.id, r))) cells.push({ model, arm, task, repeat: r });
    }
  };
  if (o.order === 'model') { for (const model of o.models) for (let r = 0; r < o.repeats; r++) for (const task of o.tasks) add(model, task, r); }
  else for (let r = 0; r < o.repeats; r++) for (const task of o.tasks) for (const model of o.models) add(model, task, r);
  return cells;
}

// ─── Experiment identity of an output directory ─────────────────────

/** Flags that set money, not the experiment: a resume may change them. */
const BUDGET_FLAGS = new Set(['--budget-usd', '--estimate-usd', '--budget-run-id', '--new-budget-run', '--retire-models']);

export interface ExperimentManifest {
  schema: 'cat40-experiment-v1';
  gbrain_commit: string | null;
  slot_commit: string | null;
  world_digest: string;
  models: string[];
  arms: string[];
  label: string;
  /** Every flag except the budget flags, as given. */
  flags: Record<string, string | true>;
  /** The budget-ledger run every invocation on this directory charges (a resume joins it, unless `--new-budget-run`). */
  budget_run_id: string | null;
  /** Every budget run this directory has charged, oldest first, once a resume opened a new one (`--new-budget-run`). */
  budget_runs?: string[];
  /** Every runner commit that ran cells in this directory, oldest first, once a resume ran from a later commit. */
  runner_commits?: string[];
  /** Hard worlds: identity, behavior settings and the evaluator's code hashes (DX-F14); a resume must match them. */
  hard?: { identity: ReturnType<typeof identityOf>; max_turns: number; tool_limits: string; judge: string | null; scorer: string; judge_prompt: string; settings_digest: string; code: Record<string, string>; runner_commit: string | null };
}

type ProbeSlot = { id: string; client: { call(name: string, args: Record<string, unknown>): Promise<string> } | null; restore(): Promise<void> };
type ProbeProxy = { bind(slot: string, key: string): void; unbind(slot: string): void; finalize(key: string, timeoutMs?: number): Promise<{ byModel: Record<string, { requests: number }> }> };

/** One search per slot must reach a reranker through this process's proxy (Cat 40 Hard R0); otherwise fail closed. */
export async function rerankProbe(slots: ProbeSlot[], proxy: ProbeProxy, query: string): Promise<void> {
  for (const s of slots) {
    const key = `rerank-probe:${s.id}`;
    proxy.bind(s.id, key);
    try { await s.client!.call('search', { query }); }
    finally { proxy.unbind(s.id); }
    const m = await proxy.finalize(key, 30_000);
    const reranks = Object.entries(m.byModel).filter(([k]) => /rerank/i.test(k)).reduce((n, [, v]) => n + v.requests, 0);
    if (!reranks) throw new HarnessError(`gbrain ${s.id}: a probe search made no rerank request (provider calls: ${JSON.stringify(m.byModel)}); the reranker is unreachable or off, so the arm would run degraded. Fix the provider endpoint, or pass --gbrain-config search.reranker.enabled=false to measure without reranking on purpose.`);
    await s.restore();
  }
}

export function experimentFlags(argv: readonly string[]): Record<string, string | true> {
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const [name, eq] = argv[i].split(/=(.*)/s);
    const value = eq ?? (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true);
    if (!BUDGET_FLAGS.has(name)) flags[name] = value;
  }
  return flags;
}

/**
 * Bind `out` to one experiment. The first invocation writes experiment.json
 * with the budget run it opened; a later invocation must describe the same
 * experiment (build, world, models, arms, label and flags) and joins the
 * recorded budget run, so a restart after a timeout continues within the
 * step's original budget instead of opening a fresh one. A different
 * experiment is refused: give a changed build its own --out.
 */
export function bindExperiment<T extends { run: BudgetRun; guard: PaidRequestGuard }>(
  out: string, manifest: Omit<ExperimentManifest, 'schema' | 'budget_run_id' | 'budget_runs'>, start: (recordedRunId: string | null) => T | null, opts: { newBudgetRun?: boolean } = {},
): { paid: T | null; manifest: ExperimentManifest } {
  const path = join(out, 'experiment.json');
  const recorded = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as ExperimentManifest : null;
  if (recorded) {
    const fresh: Record<string, unknown> = { schema: 'cat40-experiment-v1', ...manifest };
    // The runner commit is provenance, not identity: a resume from a later commit is the same experiment when
    // every hashed evaluator file (hard.code) and setting matches. Each commit that ran cells is kept in runner_commits.
    const sameBut = (k: string) => k === 'hard' && recorded.hard && manifest.hard
      && JSON.stringify({ ...recorded.hard, runner_commit: null }) === JSON.stringify({ ...manifest.hard, runner_commit: null });
    const differs = Object.keys(fresh).filter(k => JSON.stringify(fresh[k]) !== JSON.stringify((recorded as unknown as Record<string, unknown>)[k]) && !sameBut(k));
    if (differs.length) {
      throw new Error(`${out} already holds a different experiment (${differs.map(k => `${k}: recorded ${JSON.stringify((recorded as unknown as Record<string, unknown>)[k])}, now ${JSON.stringify(fresh[k])}`).join('; ')}). `
        + 'A resume must repeat the original command except for budget flags; a changed build, world or flag set needs a new --out.');
    }
  }
  // --new-budget-run: a resume whose recorded run is spent opens a fresh run (a new --budget-usd) and keeps the history.
  const paid = start(opts.newBudgetRun ? null : recorded?.budget_run_id ?? null);
  const runId = paid?.run.runId ?? recorded?.budget_run_id ?? null;
  const history = [...new Set([...(recorded?.budget_runs ?? (recorded?.budget_run_id ? [recorded.budget_run_id] : [])), ...(runId ? [runId] : [])])];
  const commits = [...new Set([...(recorded?.runner_commits ?? (recorded?.hard?.runner_commit ? [recorded.hard.runner_commit] : [])), ...(manifest.hard?.runner_commit ? [manifest.hard.runner_commit] : [])])];
  const hard = recorded?.hard && manifest.hard ? { ...manifest.hard, runner_commit: recorded.hard.runner_commit } : manifest.hard;
  const bound: ExperimentManifest = { schema: 'cat40-experiment-v1', ...manifest, ...(hard ? { hard } : {}), budget_run_id: runId, ...(history.length > 1 ? { budget_runs: history } : {}), ...(commits.length > 1 ? { runner_commits: commits } : {}) };
  mkdirSync(out, { recursive: true });
  writeFileSync(path, JSON.stringify(bound, null, 2) + '\n');
  return { paid, manifest: bound };
}

function insideRepo(p: string): boolean {
  const r = relative(REPO_ROOT, resolve(p));
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

// ─── gbrain slots ───────────────────────────────────────────────────

/** Where the slot brains for one build, world and statistics setting live. */
export function slotRoot(root: string, slotCommit: string, world: LadderWorld, analyze: boolean): string {
  return join(root, `slots-${slotCommit.slice(0, 12)}-${worldDigest(world).slice(0, 8)}${analyze ? '' : '-noanalyze'}`);
}

/** Snapshot files the agent steps need; the preflight refuses when any is missing. */
export function missingSlotSnapshots(dir: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => join(dir, `slot${i}.tar`)).filter(p => !existsSync(p));
}

/**
 * Slots whose recorded mention coverage is not `complete` with 0 pending pages (E-T7). A slot without a coverage
 * record (built before the record existed) or built by a gbrain without the coverage field is not checked.
 */
export function incompleteSlotCoverage(dir: string, n: number): { problems: string[]; unchecked: number } {
  const problems: string[] = [];
  let unchecked = 0;
  for (let i = 0; i < n; i++) {
    const path = join(dir, `slot${i}.coverage.json`);
    if (!existsSync(path)) { unchecked++; continue; }
    const c = JSON.parse(readFileSync(path, 'utf8')) as SlotCoverage;
    if (!c.supported) { unchecked++; continue; }
    const problem = coverageProblem(c);
    if (problem) problems.push(`slot${i}: ${problem}`);
  }
  return { problems, unchecked };
}

/** Flags the runner accepts; anything else is refused before anything is written (DX-F3). */
export const VALUE_FLAGS = ['--arms', '--models', '--families', '--tasks', '--repeat', '--concurrency', '--slots', '--gbrain-repo', '--gbrain-ref', '--gbrain-root', '--gbrain-label', '--judge', '--world', '--out',
  '--max-tool-chars', '--order', '--slot-ref', '--surface', '--gbrain-instructions-file', '--gbrain-tool-descriptions-file', '--gbrain-drop-tools', '--gbrain-config', '--slot-build-allowance-usd',
  '--budget-usd', '--estimate-usd', '--budget-run-id', '--budget-ledger', '--program-cap-usd', '--max-turns', '--per-family', '--hard-tool-limits', '--accept-freeze-drift', '--step',
  '--gbrain', '--advertised', '--world-templates-file', '--decision-id', '--purpose', '--retire-models'];
export const BOOLEAN_FLAGS = ['--scripted', '--build-slots', '--rebuild', '--no-pglite-analyze', '--transcripts', '--preflight', '--help', '--new-budget-run'];
const NUMERIC_FLAGS = new Set(['--repeat', '--concurrency', '--slots', '--slot-build-allowance-usd', '--budget-usd', '--estimate-usd', '--program-cap-usd', '--max-turns', '--per-family']);

export const RUNNER_USAGE = `Usage: bun eval/runner/cat40-model-ladder.ts [flags]
  v1:    --models <list> [--arms oracle,fs,fs-acl,memory,pg,gbrain] --budget-usd <n> [--world <world.json>] [--out <dir>] ...
  Hard:  --world <hard world.json> --models <list> --judge gpt-6.1-sol [--arms oracle,fs,pg,memory,gbrain] [--per-family N] [--max-turns N]
         [--hard-tool-limits hard|v1] [--preflight] [--step <step>] --budget-usd <n> --budget-ledger .budget/cat40-hard.sqlite --out <dir>
  $0:    --scripted [--arms fs,memory,oracle] [--world <world.json>] --out <dir>
  Slots: --build-slots --gbrain-ref <sha> --slots N --world <world.json> --budget-usd <n> --slot-build-allowance-usd 2
Value flags: ${VALUE_FLAGS.join(' ')}
Switches: ${BOOLEAN_FLAGS.join(' ')}
Hard refusals and stops exit 3 with a stable code (docs/benchmarks/cat40-hard/RUNBOOK.md); usage errors exit 2.`;

export class UsageError extends Error { constructor(message: string) { super(message); this.name = 'UsageError'; } }

/** Refuse unknown flags, missing or non-numeric values and empty selections. */
export function checkRunnerFlags(argv: readonly string[]): void {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new UsageError(`unexpected argument ${JSON.stringify(a)}; every value follows its flag`);
    const [name, eq] = a.split(/=(.*)/s);
    if (BOOLEAN_FLAGS.includes(name)) { if (eq !== undefined) throw new UsageError(`${name} takes no value`); continue; }
    if (!VALUE_FLAGS.includes(name)) throw new UsageError(`unknown flag ${name}. Run with --help for the list.`);
    const value = eq ?? argv[++i];
    if (value === undefined || (eq === undefined && value.startsWith('--'))) throw new UsageError(`${name} needs a value`);
    if (NUMERIC_FLAGS.has(name) && !Number.isFinite(Number(value))) throw new UsageError(`${name} must be a number (got ${JSON.stringify(value)})`);
    if (['--arms', '--models', '--families', '--tasks'].includes(name) && !value.split(',').filter(Boolean).length) throw new UsageError(`${name} is empty`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) { console.log(RUNNER_USAGE); return; }
  checkRunnerFlags(argv);
  const scripted = argv.includes('--scripted');
  const buildSlots = argv.includes('--build-slots');
  const worldPath = resolve(flag(argv, '--world') ?? join(DEFAULT_LADDER_DIR, 'world.json'));
  const templatesFile = flag(argv, '--world-templates-file');
  let sealed: ReturnType<typeof openCustodianTemplates> | null = null;
  if (templatesFile) {
    if (!flag(argv, '--out') || insideRepo(flag(argv, '--out')!)) throw new Error('custodian mode needs --out <dir outside the repository>: results and transcripts carry held-out wording');
    sealed = openCustodianTemplates({ file: templatesFile, decisionId: flag(argv, '--decision-id'), purpose: flag(argv, '--purpose') });
  }
  const raw = JSON.parse(readFileSync(worldPath, 'utf8')) as LadderWorld | HardWorld;
  const hard = isHardWorld(raw);
  if (hard) {
    if (sealed) throw new UsageError('--world-templates-file applies to v1 worlds only');
    checkHardWorld(raw, relative(process.cwd(), worldPath));
  } else {
    if (sealed) {
      if (raw.templates !== `sealed:${sealed.id}`) throw new Error(`${worldPath} was not generated from the templates file passed (world templates ${raw.templates ?? 'A'})`);
    } else assertDevWorld(raw.seed, raw.templates);
    const regenerated = generateLadderWorld(raw.seed, { scale: raw.scale, templates: sealed ? undefined : raw.templates, sealedTemplates: sealed ? { id: sealed.id, templates: sealed.templates } : undefined });
    if (worldDigest(regenerated) !== worldDigest(raw)) throw new Error(`${worldPath} does not match its generator; ${sealed ? 'regenerate it in custodian mode' : `run bun eval/generators/model-ladder-gen.ts${raw.scale ? ` --scale ${raw.scale}` : ''}`}`);
    for (const f of ['--per-family', '--hard-tool-limits', '--accept-freeze-drift', '--step']) if (flag(argv, f) !== undefined) throw new UsageError(`${f} applies to Hard worlds only`);
  }
  const world = raw as LadderWorld;
  const models = scripted ? ['scripted'] : buildSlots ? [] : (flag(argv, '--models') ?? '').split(',').filter(Boolean);
  if (!models.length && !buildSlots) throw new Error('--models is required (or --scripted, or --build-slots)');
  const arms = (buildSlots ? 'gbrain' : flag(argv, '--arms') ?? (scripted ? 'oracle,fs,memory' : 'oracle,fs,pg,memory,gbrain')).split(',') as ArmName[];
  if (hard && !buildSlots) hardRefusals({ models: scripted ? [] : models, judge: flag(argv, '--judge'), arms, scripted });
  const families = (flag(argv, '--families') ?? (hard ? HARD_FAMILIES : WIDE_FAMILIES).join(',')).split(',') as Family[];
  const known = new Set<string>(hard ? HARD_FAMILIES : WIDE_FAMILIES);
  const badFamilies = families.filter(f => !known.has(f));
  if (badFamilies.length) throw new UsageError(`unknown families ${badFamilies.join(', ')}; this world has ${[...known].join(', ')}`);
  const only = flag(argv, '--tasks')?.split(',');
  const repeats = Number(flag(argv, '--repeat') ?? 1);
  const order = (flag(argv, '--order') ?? 'task') as CellOrder;
  if (order !== 'task' && order !== 'model') throw new Error('--order must be task or model');
  const perFamily = flag(argv, '--per-family') ? Number(flag(argv, '--per-family')) : null;
  const allTasks = (world.tasks as Array<LadderTask | HardTask>).filter(t => families.includes(t.family as Family) && (!only || only.includes(t.id)));
  const picked = perFamily === null ? allTasks : allTasks.filter(t => allTasks.filter(x => x.family === t.family).indexOf(t) < perFamily);
  // Hard cells run families round-robin (H1-01, H2-01, ..., H5-01, H1-02, ...), so a step cut short by its budget still covers every family.
  const rank = (t: LadderTask | HardTask) => picked.filter(x => x.family === t.family).indexOf(t);
  const tasks = (hard ? [...picked].sort((x, y) => rank(x) - rank(y) || x.family.localeCompare(y.family)) : picked) as LadderTask[];
  if (!tasks.length && !buildSlots) throw new UsageError('the task selection is empty (check --families, --tasks and --per-family)');
  const out = resolve(flag(argv, '--out') ?? join('eval/reports/cat40', scripted ? 'scripted' : new Date().toISOString().replace(/[:.]/g, '-')));
  const hw = hard ? raw : null;
  const maxTurns = flag(argv, '--max-turns') ? Number(flag(argv, '--max-turns')) : hw?.max_turns;
  if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1)) throw new UsageError('--max-turns must be a positive integer');
  const toolLimits = (flag(argv, '--hard-tool-limits') ?? 'hard') as 'hard' | 'v1';
  if (toolLimits !== 'hard' && toolLimits !== 'v1') throw new UsageError('--hard-tool-limits must be hard or v1');
  if (hw && !scripted && !buildSlots && requiresFreeze(hw)) {
    const frozen = frozenKnobDigest();
    if (frozen !== hw.knob_digest) throw new HardStop('HARD_KNOBS_NOT_FROZEN', `seed ${hw.seed} is a smoke or held-out seed, and its world's knob digest ${hw.knob_digest.slice(0, 12)} ${frozen ? `differs from knobs.frozen.json (${frozen.slice(0, 12)})` : 'has no knobs.frozen.json to match (the generator is not frozen yet)'}`,
      'freeze first (scripts/cat40-hard.sh step freeze), then regenerate the world with --knobs docs/benchmarks/cat40-hard/knobs.frozen.json');
    const drift = freezeDrift();
    if (drift.length && !flag(argv, '--accept-freeze-drift')) throw new HardStop('HARD_FREEZE_DRIFT', `frozen code changed since freeze.json: ${drift.join(', ')}`,
      'a scorer-only change: rescore offline (eval/runner/cat40/rescore.ts --hard) and continue; a behavior change: rerun the affected calibration and reference cells; then pass --accept-freeze-drift "<dated note in calibration.md>"', 'Garry decides when a generator change after step 5 is involved (CEO-F17)');
  }
  if (hw) {
    const recordedPath = join(out, 'experiment.json');
    const recorded = existsSync(recordedPath) ? JSON.parse(readFileSync(recordedPath, 'utf8')) as ExperimentManifest : null;
    identityRefusal(recorded?.hard?.identity, identityOf(hw), relative(process.cwd(), out));
    if (recorded && JSON.stringify(recorded.flags) !== JSON.stringify(Object.fromEntries(Object.entries(experimentFlags(argv)).filter(([k]) => k !== '--preflight')))) {
      throw new Error(`${out} already holds a different experiment (flags: recorded ${JSON.stringify(recorded.flags)}, now ${JSON.stringify(experimentFlags(argv))}). A resume must repeat the original command except for budget flags; a changed flag set needs a new --out.`);
    }
  }
  mkdirSync(out, { recursive: true });
  const judge = hard ? (scripted || flag(argv, '--judge') === 'none' ? null : flag(argv, '--judge')!) : scripted || flag(argv, '--judge') === 'none' ? null : (flag(argv, '--judge') ?? 'gpt-5.4-mini');
  const files = (keep: (d: LadderWorld['docs'][number]) => boolean) => new Map(world.docs.filter(keep).map(d => [`${d.id}.md`, renderDoc(d)]));
  const instructionsFile = flag(argv, '--gbrain-instructions-file');
  if (instructionsFile) instructionsOverride.text = readFileSync(resolve(instructionsFile), 'utf8').replace(/\n+$/, '');
  const descriptionsFile = flag(argv, '--gbrain-tool-descriptions-file');
  if (descriptionsFile) instructionsOverride.descriptions = JSON.parse(readFileSync(resolve(descriptionsFile), 'utf8'));
  instructionsOverride.dropTools = (flag(argv, '--gbrain-drop-tools') ?? '').split(',').filter(Boolean);
  const ctx: Ctx = { world, files: { all: files(() => true), acl: files(d => !d.restricted) }, out, scripted, judge, gbrainLabel: flag(argv, '--gbrain-label') ?? 'gbrain',
    maxToolChars: parseMaxToolChars(flag(argv, '--max-tool-chars')), budgetRunId: null, failedCellsProxyUsd: 0, ...(flag(argv, '--max-turns') ? { maxTurns } : {}) };
  const log = (s: string) => { process.stderr.write(`[cat40] ${s}\n`); appendFileSync(join(out, 'run.log'), `${new Date().toISOString()} ${s}\n`); };

  const resultsPath = join(out, 'results.jsonl');
  const attemptsPath = join(out, 'attempts.jsonl');
  const transcripts = argv.includes('--transcripts');
  // Hard: a cell is done once it has a harness-clean attempt; harness-error attempts count toward its retry limit.
  const priorAttempts = new Map<string, number>();
  const hardAttempts = hard && existsSync(attemptsPath) ? readFileSync(attemptsPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as CellRecordV2) : [];
  for (const a of hardAttempts) priorAttempts.set(a.key, (priorAttempts.get(a.key) ?? 0) + 1);
  const done = hard ? new Set(hardAttempts.filter(a => a.stop !== 'harness_error').map(a => a.key))
    : new Set(existsSync(resultsPath) ? readFileSync(resultsPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).key as string) : []);
  // --retire-models: a dated preregistration amendment removed these models from the rest of a bound experiment;
  // their finished cells stay as recorded and no new cell of theirs runs.
  const retired = new Set((flag(argv, '--retire-models') ?? '').split(',').filter(Boolean));
  for (const m of retired) if (!models.includes(m)) throw new UsageError(`--retire-models names ${m}, which this experiment does not run`);
  const cells = buildSlots ? [] : scheduleCells({ tasks, models, arms, repeats, order, gbrainLabel: ctx.gbrainLabel, done }).filter(c => !retired.has(c.model));
  log(buildSlots ? 'building gbrain slots' : `${cells.length} cells to run (${done.size} already done, order ${order}${retired.size ? `, retired: ${[...retired].join(',')}` : ''}) in ${out}`);
  if (!buildSlots && cells.length === 0) { log('nothing to run'); return; }

  // gbrain identity and the slot preflight come first, so a refusal opens no budget run.
  const needsGbrain = buildSlots || cells.some(c => c.arm === 'gbrain');
  const analyze = !argv.includes('--no-pglite-analyze');
  const spec = gbrainSpecFrom(argv, {});
  if (spec && (flag(argv, '--gbrain-repo') || flag(argv, '--gbrain-ref'))) throw new Error('pass either --gbrain <checkout>@<ref> or --gbrain-repo/--gbrain-ref, not both');
  const parsedSpec = spec ? parseGbrainSpec(spec) : null;
  const repo = parsedSpec?.checkout ?? resolve(flag(argv, '--gbrain-repo') ?? '../gbrain');
  const gbrainRef = parsedSpec?.ref ?? flag(argv, '--gbrain-ref') ?? 'HEAD';
  const root = resolve(flag(argv, '--gbrain-root') ?? join(process.env.HOME ?? '.', '.capy/work/cat40/gbrain'));
  const nSlots = Number(flag(argv, '--slots') ?? 3);
  let gbrainCommit: string | null = null, slotCommit: string | null = null, slotDir: string | null = null;
  if (needsGbrain) {
    if (scripted) throw new Error('the gbrain arm needs real embeddings; run it without --scripted');
    const rev = (ref: string) => execFileSync('git', ['-C', repo, 'rev-parse', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
    gbrainCommit = rev(gbrainRef);
    // --slot-ref reuses brains built by another commit (read-path changes only; the commits must share a schema).
    if (buildSlots && flag(argv, '--slot-ref')) throw new Error('--build-slots builds with --gbrain-ref itself; build the --slot-ref commit by passing it as --gbrain-ref');
    slotCommit = flag(argv, '--slot-ref') ? rev(flag(argv, '--slot-ref')!) : gbrainCommit;
    slotDir = slotRoot(root, slotCommit, world, analyze);
    const missing = missingSlotSnapshots(slotDir, nSlots);
    if (buildSlots && !missing.length && !argv.includes('--rebuild')) { log(`all ${nSlots} slot snapshots exist in ${slotDir}; nothing to build`); return; }
    if (!buildSlots && missing.length) {
      throw new Error(`gbrain slot snapshots are missing for build ${slotCommit.slice(0, 12)} on world ${worldDigest(world).slice(0, 12)} (${missing.length} of ${nSlots}: ${missing.join(', ')}). `
        + `Build them first as their own step, one at a time: bun eval/runner/cat40-model-ladder.ts --build-slots --gbrain-repo ${repo} --gbrain-ref ${slotCommit} --slots ${nSlots} --world ${relative(process.cwd(), worldPath)}${analyze ? '' : ' --no-pglite-analyze'} --slot-build-allowance-usd 2 --budget-usd <dollars> --budget-ledger <ledger>`);
    }
    if (!buildSlots) {
      const coverage = incompleteSlotCoverage(slotDir, nSlots);
      if (coverage.problems.length) {
        throw new Error(`gbrain slots in ${slotDir} have an unfinished mention pass (${coverage.problems.join('; ')}), so entity recall would be measured on a partial index. `
          + `Rebuild them: bun eval/runner/cat40-model-ladder.ts --build-slots --rebuild --gbrain-repo ${repo} --gbrain-ref ${slotCommit} --slots ${nSlots} --world ${relative(process.cwd(), worldPath)}${analyze ? '' : ' --no-pglite-analyze'} --slot-build-allowance-usd 2 --budget-usd <dollars> --budget-ledger <ledger>`);
      }
      if (coverage.unchecked) log(`mention coverage not checked on ${coverage.unchecked} of ${nSlots} slots: no coverage record, or the build has no coverage field`);
    }
  }

  const exhausted = hard ? cells.filter(c => (priorAttempts.get(cellKey(c.model, c.arm === 'gbrain' ? ctx.gbrainLabel : c.arm, c.task.id, c.repeat)) ?? 0) > HARD_MAX_RETRIES) : [];
  if (exhausted.length) throw new HardStop('HARD_RETRIES_EXHAUSTED', `${exhausted.length} cells already had ${HARD_MAX_RETRIES + 1} harness-error attempts (first: ${cellKey(exhausted[0].model, exhausted[0].arm, exhausted[0].task.id, exhausted[0].repeat)})`,
    `read their errors in ${relative(process.cwd(), attemptsPath)}, fix the harness, and rerun those cells in a new --out`, 'Garry decides whether the step continues without them');
  if (hw && !buildSlots) {
    const big = cells.some(c => c.arm === 'oracle') ? oracleOversize(hw, [...new Set(cells.filter(c => c.arm === 'oracle').map(c => c.task as unknown as HardTask))], scripted ? [] : models) : [];
    if (big.length) throw new HardStop('HARD_ORACLE_TOO_LARGE', `${big.length} oracle cells exceed a model input limit (largest: task ${big.sort((a, b) => b.tokens - a.tokens)[0].task}, about ${big[0].tokens} tokens against ${big[0].limit})`,
      'lower h1_near_miss_cap in the knob file (before the freeze) or drop the oracle for those tasks with a recorded reason');
  }
  const hardManifest: ExperimentManifest['hard'] | undefined = hw ? {
    identity: identityOf(hw), max_turns: maxTurns!, tool_limits: toolLimits, judge, scorer: HARD_SCORER_VERSION, judge_prompt: HARD_JUDGE_PROMPT_VERSION,
    settings_digest: settingsDigest({ knob_digest: hw.knob_digest, max_turns: maxTurns!, tool_limits: toolLimits, judge }), code: codeHashes(REPO_ROOT),
    runner_commit: (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; } })(),
  } : undefined;
  if (argv.includes('--preflight')) {
    const perFam = Math.max(0, ...families.map(f => tasks.filter(t => t.family === f).length));
    printPreflight({ hw, world, models, arms, cells: cells.length, judge, maxTurns, toolLimits, needsGbrain, slotDir, nSlots, step: flag(argv, '--step'), scripted, families: families.filter(f => tasks.some(t => t.family === f)), tasksPerFamily: perFam, repeats, done: hardAttempts as unknown as Array<Record<string, unknown>> });
    return;
  }

  const options = budgetOptionsFrom(argv);
  const estimateUsd = flag(argv, '--estimate-usd') ? Number(flag(argv, '--estimate-usd')) : null;
  const { paid: budget } = bindExperiment(out, { gbrain_commit: gbrainCommit, slot_commit: slotCommit, world_digest: worldDigest(world), models, arms, label: ctx.gbrainLabel, flags: experimentFlags(argv), ...(hardManifest ? { hard: hardManifest } : {}) },
    recorded => scripted ? null : startPaidRun(buildSlots ? 'cat40-slot-build' : 'cat40-model-ladder', { ...options, runId: recorded ?? options.runId, estimateUsd, log }),
    { newBudgetRun: argv.includes('--new-budget-run') });
  ctx.budgetRunId = budget?.run.runId ?? null;
  if (budget?.run.participant) log(`resumed: joined the recorded budget run ${budget.run.runId}`);

  const builds: SlotBuild[] = [];
  let gbrainBuild: ReturnType<typeof prepareBuild> | null = null;
  let complete = false;
  let proxyUnattributed: Record<string, Meter> = {};
  try {
    if (!scripted && cells.some(c => c.arm === 'pg')) {
      ctx.pg = await PgStore.build(world, cachedOpenAIEmbedder(resolve('eval/reports/cat40/embed-cache.json')), hard ? { chunking: 'hard' } : {});
      log('pg arm ready');
    }
    if (needsGbrain) {
      mkdirSync(root, { recursive: true });
      gbrainBuild = prepareBuild(repo, { label: 'under-test', ref: gbrainCommit!, description: 'gbrain under test' }, join(root, 'builds'));
      ctx.proxy = new MeteringProxy();
      ctx.proxy.start();
      const surface = flag(argv, '--surface') ?? 'starter';
      const slots = Array.from({ length: nSlots }, (_, i) => new GbrainSlot(`slot${i}`, slotDir!, gbrainBuild!.dir, ctx.proxy!.port, surface, flag(argv, '--advertised') ?? null));
      // --gbrain-config key=value[,key=value]: brain config applied after every restore (a variant of the same build).
      const gbrainConfig = (flag(argv, '--gbrain-config') ?? '').split(',').filter(Boolean).map(kv => {
        const i = kv.indexOf('=');
        if (i <= 0) throw new Error(`--gbrain-config expects key=value pairs separated by commas, got "${kv}"`);
        return [kv.slice(0, i), kv.slice(i + 1)] as [string, string];
      });
      for (const s of slots) s.config = gbrainConfig;
      if (buildSlots) {
        // One build at a time: each holds a small ledger allowance (a build sends one provider request per page).
        for (const s of slots) {
          if (s.hasSnapshot() && !argv.includes('--rebuild')) continue;
          const allowance = budget!.run.allowance(Number(flag(argv, '--slot-build-allowance-usd') ?? 5), `gbrain ${s.id} build`);
          ctx.proxy.allowances.set(s.id, allowance);
          let b: SlotBuild, charged: ReturnType<typeof allowance.close>;
          try { b = await s.build(world, ctx.proxy, analyze); }
          finally { ctx.proxy.allowances.delete(s.id); charged = allowance.close(); }
          builds.push({ ...b, allowance: { reserved_usd: allowance.usd, ...charged } });
          log(`built ${s.id} in ${(b.ms / 1000).toFixed(0)}s, $${b.meter.usd.toFixed(4)} (${b.meter.requests} provider requests; ledger allowance charged $${charged.usd.toFixed(4)}); `
            + (b.coverage?.supported ? `mention coverage ${b.coverage.state}, ${b.coverage.pending} pending${coverageProblem(b.coverage) ? ' (a round will refuse this slot)' : ''}` : 'no mention coverage field in this build'));
        }
      }
      // A write probe after restore: the arm is only fair if the agent's writes can land.
      // The verbs surface serves no put_page (its write is remember), so it skips the page-write probe.
      for (const s of slots) {
        await s.restore();
        if (!s.client!.tools.some(t => t.name === 'put_page')) { await s.restore(); continue; }
        const probe = await s.client!.call('put_page', { slug: 'notes/cat40-write-probe', content: '---\ntitle: "write probe"\ntype: note\n---\nprobe\n' });
        if (/^Error/.test(probe) || !(await s.client!.call('get_page', { slug: 'notes/cat40-write-probe' })).includes('write probe')) throw new Error(`gbrain ${s.id} refuses writes after restore: ${probe.slice(0, 300)}`);
        await s.restore();
      }
      log('write probe passed on every slot');
      // A rerank probe (Cat 40 Hard R0): one search per slot must reach the reranker through this process's proxy,
      // unless the run turned reranking off. A slot whose reranker is unreachable fails closed before any cell.
      const rerankOff = gbrainConfig.some(([k, v]) => k === 'search.reranker.enabled' && /^(false|0|off)$/i.test(v));
      if (!rerankOff && ctx.proxy) {
        await rerankProbe(slots, ctx.proxy, world.docs?.[0]?.title ?? 'account');
        log('rerank probe passed on every slot');
      }
      ctx.pool = new GbrainPool(slots, hard ? { minHealthy: nSlots } : {});
      log(`gbrain ${gbrainBuild.version} (${gbrainBuild.commit.slice(0, 12)}) ready on ${nSlots} slots, surface ${surface}`);
    }

    const concurrency = Number(flag(argv, '--concurrency') ?? 6);
    let finished = 0;
    if (hw) {
      const hctx: HardCtx = {
        world: hw, worldDigest: hardWorldDigest(hw), files: ctx.files, pg: ctx.pg, pool: ctx.pool, proxy: ctx.proxy, scripted, judge, gbrainLabel: ctx.gbrainLabel,
        maxToolChars: ctx.maxToolChars, maxTurns: maxTurns!, toolLimits, budgetRunId: ctx.budgetRunId, logJudge: e => appendFileSync(join(out, 'judge-requests.jsonl'), JSON.stringify(e) + '\n'),
      };
      await pool(cells, concurrency, async c => {
        const key = cellKey(c.model, c.arm === 'gbrain' ? ctx.gbrainLabel : c.arm, c.task.id, c.repeat);
        const rec = await runWithRetries(priorAttempts.get(key) ?? 0, async attempt => {
          try { return await runHardCell(hctx, c.model, c.arm, c.task as unknown as HardTask, c.repeat, attempt); }
          catch (e) {
            if ((e as Error).name === 'SlotQuarantineError') throw new HardStop('HARD_SLOTS_QUARANTINED', `${(e as Error).message} (quarantined: ${[...ctx.pool!.quarantined].map(([id, why]) => `${id}: ${why}`).join('; ')})`,
              'read the quarantine reasons, rebuild or repair the slots, then rerun the same command to resume', 'Garry decides whether to continue with fewer slots');
            if (ctx.proxy) ctx.failedCellsProxyUsd += (await ctx.proxy.finalize(`${key}#${attempt}`, 30_000)).usd;
            throw e;
          }
        }, a => {
          appendFileSync(attemptsPath, JSON.stringify(a) + '\n');
          if (transcripts) appendFileSync(join(out, 'transcripts.jsonl'), JSON.stringify({ key: a.key, attempt_id: a.attempt_id, tools: hardTranscripts.get(a.attempt_id) ?? [] }) + '\n');
          hardTranscripts.delete(a.attempt_id);
          if (a.stop === 'harness_error') log(`cell ${key} attempt ${a.attempt}: harness error: ${a.error}`);
        });
        if (!rec) return;
        appendFileSync(resultsPath, JSON.stringify(rec) + '\n');
        finished++;
        if (finished % 10 === 0 || finished === cells.length) log(`${finished}/${cells.length} cells; last ${rec.key} success=${rec.score.success} stop=${rec.stop} $${rec.total_usd.toFixed(3)}`);
      });
      complete = finished === cells.length;
      if (!complete) log(`${cells.length - finished} cells lack a harness-clean attempt`);
    } else await pool(cells, concurrency, async c => {
      let rec: CellRecord;
      try { rec = await runCell(ctx, c.model, c.arm, c.task, c.repeat); }
      catch (e) {
        const key = cellKey(c.model, c.arm === 'gbrain' ? ctx.gbrainLabel : c.arm, c.task.id, c.repeat);
        if (ctx.proxy) ctx.failedCellsProxyUsd += (await ctx.proxy.finalize(key, 30_000)).usd;
        log(`cell ${key} failed: ${(e as Error).message}`);
        if ((e as Error).name === 'BudgetExceededError' || /BudgetExceeded|exceed/i.test((e as Error).message)) throw e;
        return;
      }
      appendFileSync(resultsPath, JSON.stringify(rec) + '\n');
      if (transcripts) appendFileSync(join(out, 'transcripts.jsonl'), JSON.stringify({ key: rec.key, tools: lastTools.get(rec.key) ?? [] }) + '\n');
      finished++;
      if (finished % 10 === 0 || finished === cells.length) log(`${finished}/${cells.length} cells; last ${rec.key} success=${rec.score.success} $${rec.total_usd.toFixed(3)}`);
    });
    if (!hw) {
      complete = buildSlots || finished === cells.length;
      if (!complete) log(`${cells.length - finished} cells failed; rerun the same command to resume them within the same budget run`);
    }
  } catch (e) {
    if (hw && (e as Error).name === 'BudgetExceededError') {
      throw new HardStop('HARD_BUDGET_SHORT', `${relative(process.cwd(), out)} stopped when its budget run was spent: ${(e as Error).message.slice(0, 300)}`,
        'project the remaining cells (hard-ops.ts project --step <step> --done <out>/attempts.jsonl) and resume with the same command plus --new-budget-run and a new --budget-usd; scripts/cat40-hard.sh step <step> does both',
        'Garry decides only if the Hard ledger has less left than the remaining projection plus 15%');
    }
    throw e;
  } finally {
    terminateGrepWorkers();
    if (ctx.pool) await Promise.all(ctx.pool.slots.map(s => s.stop()));
    if (ctx.proxy) proxyUnattributed = Object.fromEntries([...ctx.proxy.meters].filter(([k]) => k.startsWith('slot:')));
    ctx.proxy?.stop();
    // An incomplete step leaves its budget run open, so a resume continues within the same budget.
    const summary = budget?.run.close({ finish: complete });
    budget?.guard.uninstall();
    const receipt = {
      schema: 'cat40-receipt-v1', version: CAT40_VERSION, judge_prompt: hw ? HARD_JUDGE_PROMPT_VERSION : JUDGE_PROMPT_VERSION, judge: ctx.judge,
      ...(hardManifest ? { hard: { ...hardManifest, attempts_path: 'attempts.jsonl', max_retries: HARD_MAX_RETRIES, quarantined: ctx.pool ? Object.fromEntries(ctx.pool.quarantined) : {}, pg_setup_embed_usd: ctx.pg?.setupEmbedUsd ?? 0 } } : {}),
      world: { path: relative(process.cwd(), worldPath), scale: world.scale ?? 'v1', digest: worldDigest(world), seed: world.seed, docs: world.docs.length, tasks: world.tasks.length,
        ...(hw ? {} : { templates: world.templates ?? 'A', templates_file_sha256: sealed?.sha256 ?? null,
          strata: Object.fromEntries((['memory-only', 'page-authoring', 'hidden-tool'] as const).map(k => [k, tasks.filter(t => stratumOf(t.family) === k).length])) }) },
      evals_commit: (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; } })(),
      evals_dirty: (() => { try { return execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0; } catch { return null; } })(),
      gbrain: gbrainBuild ? { slot_ref: flag(argv, '--slot-ref') ?? null, slot_commit: slotCommit, label: ctx.gbrainLabel, commit: gbrainBuild.commit, version: gbrainBuild.version, tree: gbrainBuild.tree, verified: gbrainBuild.verified, surface: flag(argv, '--surface') ?? 'starter', advertised_surface: flag(argv, '--advertised') ?? null, tool_overrides: { descriptions_file: descriptionsFile ?? null, descriptions_sha256: instructionsOverride.descriptions ? createHash('sha256').update(JSON.stringify(instructionsOverride.descriptions)).digest('hex') : null, dropped: instructionsOverride.dropTools }, instructions_override: instructionsOverride.text === null ? null : { file: relative(process.cwd(), resolve(instructionsFile!)), sha256: createHash('sha256').update(instructionsOverride.text).digest('hex') }, served_instructions_sha256: instructionsOverride.served === null ? null : createHash('sha256').update(instructionsOverride.served).digest('hex'), operator_analyze: analyze, serve_boot_timeout_s: SERVE_BOOT_TIMEOUT_SECONDS, staged_build: world.docs.length > STAGED_SOURCE_ADD_DOCS ? { sync_batch_docs: STAGED_SYNC_BATCH } : null } : null,
      mode: buildSlots ? 'build-slots' : 'cells', order, complete, cells_planned: cells.length,
      slot_builds: builds, models, arms, families, repeats, max_tool_chars: ctx.maxToolChars, argv,
      budget_run_id: ctx.budgetRunId, resumed: Boolean(budget?.run.participant),
      proxy_unattributed: proxyUnattributed, failed_cells_proxy_usd: ctx.failedCellsProxyUsd,
      cost: summary ? receiptCost(summary) : null,
      finished_at: new Date().toISOString(),
    };
    if (instructionsOverride.served !== null) writeFileSync(join(out, 'served-instructions.txt'), instructionsOverride.served + '\n');
    if (instructionsOverride.servedTools !== null) writeFileSync(join(out, 'served-tools.json'), JSON.stringify(instructionsOverride.servedTools, null, 2) + '\n');
    const receiptPath = join(out, `receipt-${Date.now()}.json`);
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
    log(`receipt ${receiptPath}`);
    const lag = summary?.event_loop_lag_ms;
    if (lag && lag.p99 >= 50) log(`warning: event-loop lag p99 ${lag.p99} ms (max ${lag.max} ms); tool latency in this run is not trustworthy`);
  }
  if (hw && !buildSlots && !complete) {
    throw new HardStop('HARD_CELLS_INCOMPLETE', `${relative(process.cwd(), out)}: some planned cells lack a harness-clean attempt`,
      `rerun the same command to resume (it joins the same budget run; add --new-budget-run with a new --budget-usd if that run is spent): bun eval/runner/cat40-model-ladder.ts ${argv.map(a => (/^[\w./:=,@+-]+$/.test(a) ? a : JSON.stringify(a))).join(' ')}`);
  }
}

/** --preflight: everything a paid step needs, with no paid call (DX-F13). */
function printPreflight(o: { hw: HardWorld | null; world: LadderWorld; models: string[]; arms: string[]; cells: number; judge: string | null; maxTurns?: number; toolLimits: string; needsGbrain: boolean; slotDir: string | null; nSlots: number; step?: string; scripted: boolean; families: string[]; tasksPerFamily: number; repeats: number; done: Array<Record<string, unknown>> }) {
  const keyOf = (m: string) => { try { return provider(m) === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'; } catch { return '(unknown provider)'; } };
  const env: Record<string, string[]> = {};
  for (const a of o.arms) env[a] = [...new Set([...(o.scripted ? [] : o.models.map(keyOf)), ...(a === 'pg' || a === 'gbrain' ? ['OPENAI_API_KEY (embeddings)'] : [])])];
  if (o.judge) env.judge = [keyOf(o.judge)];
  const prices = Object.fromEntries([...o.models, ...(o.judge ? [o.judge] : [])].map(m => { try { return [m, CHAT_PRICE_OVERRIDES[`${provider(m)}:${m}`] ?? null]; } catch { return [m, null]; } }));
  const lines: string[] = ['Cat 40 preflight (no paid call)'];
  lines.push(`world: ${o.hw ? JSON.stringify({ ...identityOf(o.hw), digest: hardWorldDigest(o.hw).slice(0, 16), docs: o.hw.docs.length, tasks: o.hw.tasks.length }) : JSON.stringify({ seed: o.world.seed, scale: o.world.scale ?? 'v1', digest: worldDigest(o.world).slice(0, 16) })}`);
  lines.push(`cells: ${o.cells}; turn cap ${o.maxTurns ?? 16}; tool limits ${o.toolLimits}; judge ${o.judge ?? 'none'}`);
  lines.push(`environment variables by arm: ${JSON.stringify(env)}`);
  lines.push(`models and prices ($ per million tokens): ${JSON.stringify(prices)}`);
  if (o.needsGbrain) lines.push(`gbrain slots: ${o.slotDir} (${missingSlotSnapshots(o.slotDir!, o.nSlots).length} of ${o.nSlots} snapshots missing; coverage problems: ${incompleteSlotCoverage(o.slotDir!, o.nSlots).problems.join('; ') || 'none'})`);
  let stop: HardStop | null = null;
  if (o.hw && !o.scripted) {
    try {
      const r = checkRoster(loadRoster());
      lines.push(`Hard ledger ${relative(process.cwd(), r.hardLedger)}: cap $${r.capUsd.toFixed(2)} (roster), committed $${r.committedUsd.toFixed(2)}, remaining $${r.remainingUsd.toFixed(2)}`);
      if (o.step) {
        const plan: StepPlan = { step: o.step, order: 0, models: o.models, arms: o.arms, tasksPerFamily: o.tasksPerFamily, families: o.families, repeats: o.repeats, scale: o.hw.scale ?? 'v1' };
        const measured = (process.env.HARD_MEASURED ?? '').split(',').filter(Boolean);
        const views = measured.length ? canonicalCells(readRecords(measured)).attempts : undefined;
        const p = project(plan, { basis: loadCostBasis(), measured: views, done: canonicalCells(o.done).attempts, worldBytes: o.hw.docs.reduce((n, d) => n + d.title.length + d.body.length, 0) });
        lines.push(`projection for ${o.step}: $${p.total_usd.toFixed(2)} ($${p.with_margin_usd.toFixed(2)} with 15%), basis ${p.basis}; ${p.cells} cells: agent $${p.agent_usd.toFixed(2)}, judge $${p.judge_usd.toFixed(2)}, pg setup embedding $${p.pg_setup_usd.toFixed(2)}`);
        if (r.remainingUsd < p.with_margin_usd) stop = new HardStop('HARD_BUDGET_SHORT', `step ${o.step} projects $${p.with_margin_usd.toFixed(2)} with the margin; $${r.remainingUsd.toFixed(2)} remains`, 'do not raise the cap yourself', 'Garry decides whether to fund, narrow or stop the step');
      }
    } catch (e) { if (e instanceof HardStop) stop = e; else throw e; }
  }
  console.log(lines.join('\n'));
  if (stop) throw stop;
}

if (import.meta.main) {
  main().catch(e => {
    if (e instanceof HardStop) { console.error(e.render()); process.exit(3); }
    if (e instanceof UsageError) { console.error(`${e.message}\n\n${RUNNER_USAGE}`); process.exit(2); }
    console.error(e); process.exit(1);
  });
}

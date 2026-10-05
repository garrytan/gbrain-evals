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
 *     [--max-tool-chars <n>|none] [--order task|model] [--slot-ref <sha>] [--no-pglite-analyze] [--surface starter] [--advertised verbs|starter|full]
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
 * a snapshot it needs is missing. Each --out directory is bound to one
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
import { runAgent, provider, priceUsage, type AgentRun, type Arm, type ScriptedModel } from './cat40/loop.ts';
import { FsArm, MemoryArm, OracleArm, FileStore, isWriteCall, type ArmName } from './cat40/arms.ts';
import { renderDoc } from '../generators/model-ladder-gen.ts';
import { PgArm, PgStore, cachedOpenAIEmbedder } from './cat40/pg-arm.ts';
import { GbrainArm, instructionsOverride, GbrainPool, GbrainSlot, MeteringProxy, SERVE_BOOT_TIMEOUT_SECONDS, STAGED_SOURCE_ADD_DOCS, STAGED_SYNC_BATCH, type Meter, type SlotBuild } from './cat40/gbrain-arm.ts';
import { scoreTask, judgePrompt, parseClaims, JUDGE_PROMPT_VERSION, type TaskScore, type ClaimVerdicts } from './cat40/score.ts';
import { budgetOptionsFrom, startPaidRun, receiptCost, type BudgetRun, type PaidRequestGuard } from './budget-ledger.ts';
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
  stratum: Stratum;
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
}

async function judgeClaims(ctx: Ctx, task: LadderTask, run: AgentRun): Promise<{ claims: ClaimVerdicts | null; usd: number }> {
  if (!ctx.judge || ctx.scripted) return { claims: null, usd: 0 };
  const p = judgePrompt(ctx.world, task, run);
  if (!p) return { claims: null, usd: 0 };
  const r = await runAgentText(ctx.judge, p.system, p.user);
  return { claims: parseClaims(r.text), usd: r.usd };
}

async function runAgentText(model: string, system: string, user: string): Promise<{ text: string; usd: number }> {
  if (provider(model) === 'openai') {
    const res = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model, instructions: system, input: user, max_output_tokens: 8000, reasoning: { effort: 'low' } }) });
    const j = await res.json() as Record<string, unknown>;
    if (!res.ok) throw new Error(`judge error ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
    const text = ((j.output ?? []) as Array<Record<string, unknown>>).filter(o => o.type === 'message').flatMap(o => (o.content as Array<Record<string, unknown>>) ?? []).map(c => String(c.text ?? '')).join('\n');
    const u = j.usage as Record<string, unknown>;
    const cached = ((u.input_tokens_details ?? {}) as Record<string, number>).cached_tokens ?? 0;
    return { text, usd: priceUsage(model, { input: (u.input_tokens as number) - cached, cache_read: cached, cache_write: 0, output: u.output_tokens as number, requests: 1 }) };
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 4000, system, messages: [{ role: 'user', content: user }] }) });
  const j = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error(`judge error ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
  const text = ((j.content ?? []) as Array<Record<string, unknown>>).filter(c => c.type === 'text').map(c => String(c.text)).join('\n');
  const u = j.usage as Record<string, number>;
  return { text, usd: priceUsage(model, { input: u.input_tokens, output: u.output_tokens, cache_read: u.cache_read_input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0, requests: 1 }) };
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
    const common = { model, arm, system: systemPrompt(ctx.world, arm), maxToolChars: ctx.maxToolChars };
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
const BUDGET_FLAGS = new Set(['--budget-usd', '--estimate-usd', '--budget-run-id']);

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
  /** The budget-ledger run every invocation on this directory charges (a resume joins it). */
  budget_run_id: string | null;
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
  out: string, manifest: Omit<ExperimentManifest, 'schema' | 'budget_run_id'>, start: (recordedRunId: string | null) => T | null,
): { paid: T | null; manifest: ExperimentManifest } {
  const path = join(out, 'experiment.json');
  const recorded = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as ExperimentManifest : null;
  if (recorded) {
    const fresh: Record<string, unknown> = { schema: 'cat40-experiment-v1', ...manifest };
    const differs = Object.keys(fresh).filter(k => JSON.stringify(fresh[k]) !== JSON.stringify((recorded as unknown as Record<string, unknown>)[k]));
    if (differs.length) {
      throw new Error(`${out} already holds a different experiment (${differs.map(k => `${k}: recorded ${JSON.stringify((recorded as unknown as Record<string, unknown>)[k])}, now ${JSON.stringify(fresh[k])}`).join('; ')}). `
        + 'A resume must repeat the original command except for budget flags; a changed build, world or flag set needs a new --out.');
    }
  }
  const paid = start(recorded?.budget_run_id ?? null);
  const bound: ExperimentManifest = { schema: 'cat40-experiment-v1', ...manifest, budget_run_id: paid?.run.runId ?? recorded?.budget_run_id ?? null };
  mkdirSync(out, { recursive: true });
  writeFileSync(path, JSON.stringify(bound, null, 2) + '\n');
  return { paid, manifest: bound };
}

const REPO_ROOT = resolve(import.meta.dir, '../..');
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

export async function main(argv = process.argv.slice(2)) {
  const scripted = argv.includes('--scripted');
  const buildSlots = argv.includes('--build-slots');
  const worldPath = resolve(flag(argv, '--world') ?? join(DEFAULT_LADDER_DIR, 'world.json'));
  const templatesFile = flag(argv, '--world-templates-file');
  let sealed: ReturnType<typeof openCustodianTemplates> | null = null;
  if (templatesFile) {
    if (!flag(argv, '--out') || insideRepo(flag(argv, '--out')!)) throw new Error('custodian mode needs --out <dir outside the repository>: results and transcripts carry held-out wording');
    sealed = openCustodianTemplates({ file: templatesFile, decisionId: flag(argv, '--decision-id'), purpose: flag(argv, '--purpose') });
  }
  const world: LadderWorld = JSON.parse(readFileSync(worldPath, 'utf8'));
  if (sealed) {
    if (world.templates !== `sealed:${sealed.id}`) throw new Error(`${worldPath} was not generated from the templates file passed (world templates ${world.templates ?? 'A'})`);
  } else assertDevWorld(world.seed, world.templates);
  const regenerated = generateLadderWorld(world.seed, { scale: world.scale, templates: sealed ? undefined : world.templates, sealedTemplates: sealed ? { id: sealed.id, templates: sealed.templates } : undefined });
  if (worldDigest(regenerated) !== worldDigest(world)) throw new Error(`${worldPath} does not match its generator; ${sealed ? 'regenerate it in custodian mode' : `run bun eval/generators/model-ladder-gen.ts${world.scale ? ` --scale ${world.scale}` : ''}`}`);
  const models = scripted ? ['scripted'] : buildSlots ? [] : (flag(argv, '--models') ?? '').split(',').filter(Boolean);
  if (!models.length && !buildSlots) throw new Error('--models is required (or --scripted, or --build-slots)');
  const arms = (buildSlots ? 'gbrain' : flag(argv, '--arms') ?? 'oracle,fs,pg,memory,gbrain').split(',') as ArmName[];
  const families = (flag(argv, '--families') ?? WIDE_FAMILIES.join(',')).split(',') as Family[];
  const only = flag(argv, '--tasks')?.split(',');
  const repeats = Number(flag(argv, '--repeat') ?? 1);
  const order = (flag(argv, '--order') ?? 'task') as CellOrder;
  if (order !== 'task' && order !== 'model') throw new Error('--order must be task or model');
  const tasks = world.tasks.filter(t => families.includes(t.family) && (!only || only.includes(t.id)));
  const out = resolve(flag(argv, '--out') ?? join('eval/reports/cat40', scripted ? 'scripted' : new Date().toISOString().replace(/[:.]/g, '-')));
  mkdirSync(out, { recursive: true });
  const judge = scripted || flag(argv, '--judge') === 'none' ? null : (flag(argv, '--judge') ?? 'gpt-5.4-mini');
  const files = (keep: (d: LadderWorld['docs'][number]) => boolean) => new Map(world.docs.filter(keep).map(d => [`${d.id}.md`, renderDoc(d)]));
  const instructionsFile = flag(argv, '--gbrain-instructions-file');
  if (instructionsFile) instructionsOverride.text = readFileSync(resolve(instructionsFile), 'utf8').replace(/\n+$/, '');
  const descriptionsFile = flag(argv, '--gbrain-tool-descriptions-file');
  if (descriptionsFile) instructionsOverride.descriptions = JSON.parse(readFileSync(resolve(descriptionsFile), 'utf8'));
  instructionsOverride.dropTools = (flag(argv, '--gbrain-drop-tools') ?? '').split(',').filter(Boolean);
  const ctx: Ctx = { world, files: { all: files(() => true), acl: files(d => !d.restricted) }, out, scripted, judge, gbrainLabel: flag(argv, '--gbrain-label') ?? 'gbrain',
    maxToolChars: parseMaxToolChars(flag(argv, '--max-tool-chars')), budgetRunId: null, failedCellsProxyUsd: 0 };
  const log = (s: string) => { process.stderr.write(`[cat40] ${s}\n`); appendFileSync(join(out, 'run.log'), `${new Date().toISOString()} ${s}\n`); };

  const resultsPath = join(out, 'results.jsonl');
  const transcripts = argv.includes('--transcripts');
  const done = new Set(existsSync(resultsPath) ? readFileSync(resultsPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).key as string) : []);
  const cells = buildSlots ? [] : scheduleCells({ tasks, models, arms, repeats, order, gbrainLabel: ctx.gbrainLabel, done });
  log(buildSlots ? 'building gbrain slots' : `${cells.length} cells to run (${done.size} already done, order ${order}) in ${out}`);
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
  }

  const options = budgetOptionsFrom(argv);
  const estimateUsd = flag(argv, '--estimate-usd') ? Number(flag(argv, '--estimate-usd')) : null;
  const { paid: budget } = bindExperiment(out, { gbrain_commit: gbrainCommit, slot_commit: slotCommit, world_digest: worldDigest(world), models, arms, label: ctx.gbrainLabel, flags: experimentFlags(argv) },
    recorded => scripted ? null : startPaidRun(buildSlots ? 'cat40-slot-build' : 'cat40-model-ladder', { ...options, runId: recorded ?? options.runId, estimateUsd, log }));
  ctx.budgetRunId = budget?.run.runId ?? null;
  if (budget?.run.participant) log(`resumed: joined the recorded budget run ${budget.run.runId}`);

  const builds: SlotBuild[] = [];
  let gbrainBuild: ReturnType<typeof prepareBuild> | null = null;
  let complete = false;
  let proxyUnattributed: Record<string, Meter> = {};
  try {
    if (!scripted && cells.some(c => c.arm === 'pg')) {
      ctx.pg = await PgStore.build(world, cachedOpenAIEmbedder(resolve('eval/reports/cat40/embed-cache.json')));
      log('pg arm ready');
    }
    if (needsGbrain) {
      mkdirSync(root, { recursive: true });
      gbrainBuild = prepareBuild(repo, { label: 'under-test', ref: gbrainCommit!, description: 'gbrain under test' }, join(root, 'builds'));
      ctx.proxy = new MeteringProxy();
      ctx.proxy.start();
      const surface = flag(argv, '--surface') ?? 'starter';
      const slots = Array.from({ length: nSlots }, (_, i) => new GbrainSlot(`slot${i}`, slotDir!, gbrainBuild!.dir, ctx.proxy!.port, surface, flag(argv, '--advertised') ?? null));
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
          log(`built ${s.id} in ${(b.ms / 1000).toFixed(0)}s, $${b.meter.usd.toFixed(4)} (${b.meter.requests} provider requests; ledger allowance charged $${charged.usd.toFixed(4)})`);
        }
      }
      // A write probe after restore: the arm is only fair if the agent's writes can land.
      for (const s of slots) {
        await s.restore();
        const probe = await s.client!.call('put_page', { slug: 'notes/cat40-write-probe', content: '---\ntitle: "write probe"\ntype: note\n---\nprobe\n' });
        if (/^Error/.test(probe) || !(await s.client!.call('get_page', { slug: 'notes/cat40-write-probe' })).includes('write probe')) throw new Error(`gbrain ${s.id} refuses writes after restore: ${probe.slice(0, 300)}`);
        await s.restore();
      }
      log('write probe passed on every slot');
      ctx.pool = new GbrainPool(slots);
      log(`gbrain ${gbrainBuild.version} (${gbrainBuild.commit.slice(0, 12)}) ready on ${nSlots} slots, surface ${surface}`);
    }

    const concurrency = Number(flag(argv, '--concurrency') ?? 6);
    let finished = 0;
    await pool(cells, concurrency, async c => {
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
    complete = buildSlots || finished === cells.length;
    if (!complete) log(`${cells.length - finished} cells failed; rerun the same command to resume them within the same budget run`);
  } finally {
    if (ctx.pool) await Promise.all(ctx.pool.slots.map(s => s.stop()));
    if (ctx.proxy) proxyUnattributed = Object.fromEntries([...ctx.proxy.meters].filter(([k]) => k.startsWith('slot:')));
    ctx.proxy?.stop();
    // An incomplete step leaves its budget run open, so a resume continues within the same budget.
    const summary = budget?.run.close({ finish: complete });
    budget?.guard.uninstall();
    const receipt = {
      schema: 'cat40-receipt-v1', version: CAT40_VERSION, judge_prompt: JUDGE_PROMPT_VERSION, judge: ctx.judge,
      world: { path: relative(process.cwd(), worldPath), scale: world.scale ?? 'v1', digest: worldDigest(world), seed: world.seed, docs: world.docs.length, tasks: world.tasks.length,
        templates: world.templates ?? 'A', templates_file_sha256: sealed?.sha256 ?? null,
        strata: Object.fromEntries((['memory-only', 'page-authoring', 'hidden-tool'] as const).map(k => [k, tasks.filter(t => stratumOf(t.family) === k).length])) },
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
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(1); });
}

/**
 * Runner for the agent-stack predictive measures (GBEV-55): G1 freshness, G3 write contract, G4 wrong entity, G6 cross-
 * source tasks over mixed access (local and remote caller), and the keyless G3 schema-shape grammar.
 *
 *   bun eval/runner/predictive/run.ts <unit> --dry-run [--smoke]            tasks, digest, episode count and an estimate
 *                                                                           at budget-ledger prices (the smoke's plan with
 *                                                                           --smoke); no gbrain, no model
 *   bun eval/runner/predictive/run.ts <unit> --fake [--tasks N]             scripted model replies on the real gbrain CLI
 *                                                                           and MCP server; keyless, costs nothing
 *   bun eval/runner/predictive/run.ts <unit> --paid --smoke --budget-run-id ID
 *                                                                           one task per surface and model at k=1; prints
 *                                                                           measured cost per episode and the counted
 *                                                                           plan's cost projected from it
 *   bun eval/runner/predictive/run.ts <unit> --paid --budget-run-id ID --preregistration <path>
 *                                                                           the counted run; refuses without an attested
 *                                                                           preregistration (prereg.ts)
 *   bun eval/runner/predictive/run.ts grammar                               dispatch every schema shape through MCP and
 *                                                                           gbrain call; keyless
 *
 * Units: g1, g3, g4, g6. Options: --tasks N, --k N (default 4; the smoke defaults both to 1), --models a,b,c (default
 * claude-opus-5-5, gpt-6.1-sol, particle-1), --pressured (G1 time-pressure prompts), --seed N, --gbrain
 * <checkout>@<commit> (the gbrain-under-test overlay, so pins can be compared without touching the package.json pin),
 * --out (a file for --fake and grammar; a directory for paid runs, default eval/reports/predictive/<unit>-<smoke|paid>),
 * --concurrency N (paid episodes in flight, default 2), --retry-errored (resend errored and in-flight episodes on resume).
 *
 * A paid run refuses before any provider client exists unless a counted run's --preregistration attests (a smoke may
 * pass one; its attestation is recorded either way in summary.json), requirePaidArm accepts --paid --budget-run-id for an open
 * ledger run with money left, every model's key is set, and the model-freshness check passes. It then joins that run as
 * the process's one ledger writer (paid.ts has the money rules) and logs every episode to <out>/episodes.jsonl, so the
 * same command resumes it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { budgetOptionsFrom, startPaidRun } from '../budget-ledger.ts';
import { priceUsage, provider } from '../cat40/loop.ts';
import { gbrainSpecFrom, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from '../gbrain-under-test.ts';
import { PaidArmRefusal, paidRequested, requirePaidArm } from '../paid-arm.ts';
import { attestPreregistration, type Attestation } from '../prereg.ts';
import { execGbrain, GbrainMcpArm, SyntheticBrain, type ArmCall } from './cli-arm.ts';
import { runEntityEpisode, runFreshnessEpisode, runWriteEpisode, scriptedEntityPolicy, scriptedFreshnessPolicy, scriptedWritePolicy } from './episodes.ts';
import { summarizeEntity, type EntityEpisode } from './entity-agent.ts';
import { summarizeFreshness, type FreshnessEpisode } from './freshness.ts';
import { g6Tasks, g6World, runOutOfViewEpisode, summarizeOutOfView, type OutOfViewEpisode } from './out-of-view/agent.ts';
import { CALLERS } from './out-of-view/gen.ts';
import { tasksDigest } from './out-of-view/tasks.ts';
import { missingKeys, pendingJobs, readEpisodeLog, ResumeRefusal, runPaid, type EpisodeRecord, type LogRow, type PaidJob } from './paid.ts';
import { costPerCorrect } from './passk.ts';
import { GRAMMAR_PAGES, runSchemaGrammar, schemaShapes, summarizeWriteEpisodes, type SchemaShape, type ShapeRow, type WriteEpisode } from './write-contract.ts';
import { freshnessDigest, generateFreshnessTasks, G1_DEFAULT_TASKS } from '../../generators/freshness-world-gen.ts';
import { G3_CAUSES, G3_DEFAULT_TASKS, G3_SURFACES, generateWriteTasks, writeTasksDigest } from '../../generators/write-contract-gen.ts';
import { entityTasksDigest, generateEntityTasks, G4_DEFAULT_TASKS } from '../../generators/entity-agent-gen.ts';

export const UNITS = ['g1', 'g3', 'g4', 'g6'] as const;
export type Unit = typeof UNITS[number];
export const MODELS = ['claude-opus-5-5', 'gpt-6.1-sol', 'particle-1'] as const;
export const DEFAULT_K = 4;
export const DEFAULT_CONCURRENCY = 2;
export const G6_DEFAULT_TASKS = 50;
/** surfaces: G3's cli and mcp; G6's local and remote caller. */
export const UNIT_SIZES: Record<Unit, { tasks: number; surfaces: number }> = {
  g1: { tasks: G1_DEFAULT_TASKS, surfaces: 1 }, g3: { tasks: G3_DEFAULT_TASKS, surfaces: G3_SURFACES.length },
  g4: { tasks: G4_DEFAULT_TASKS, surfaces: 1 }, g6: { tasks: G6_DEFAULT_TASKS, surfaces: CALLERS.length },
};
/**
 * Planning assumptions per episode, uncached input and output tokens summed over the loop's turns. They follow the
 * plan's per-episode figures from refresh-barrier Part C usage: short write tasks, and about 2-3 times that for G1's
 * multi-page reads; G6 carries the full MCP tool list on every turn. The smoke replaces them with measured cost per
 * episode before a counted window.
 */
export const EPISODE_TOKENS: Record<Unit, { input: number; output: number }> = { g1: { input: 70_000, output: 4_000 }, g3: { input: 30_000, output: 2_500 }, g4: { input: 40_000, output: 2_500 }, g6: { input: 60_000, output: 3_000 } };
export const FAKE_MODEL = 'scripted-fake';
export const PREREGISTRATION = 'docs/benchmarks/2026-11-09-predictive-measures-preregistration.md';

const REPO_ROOT = resolve(import.meta.dir, '../../..');

function flag(argv: readonly string[], name: string): string | undefined {
  const eq = argv.find(a => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
}
function intFlag(argv: readonly string[], name: string, fallback: number): number {
  const raw = flag(argv, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer (got ${JSON.stringify(raw)})`);
  return n;
}

function g6TaskList(n: number, seed?: number) {
  const tasks = g6Tasks(g6World(seed));
  if (n > tasks.length) throw new Error(`G6 has ${tasks.length} tasks at this seed; --tasks ${n} is more`);
  return tasks.slice(0, n);
}

export interface Plan {
  unit: Unit; tasks: number; surfaces: number; k: number; models: string[]; episodes: number; digest: string;
  per_model: Array<{ model: string; episodes: number; estimate_usd: number }>; estimate_usd: number;
  exposure?: Record<string, Record<string, number>>;
}

/** Tasks, digest, episode count and the price of a counted run at budget-ledger prices. */
export function planUnit(unit: Unit, opts: { tasks?: number; k?: number; models?: readonly string[]; seed?: number } = {}): Plan {
  const n = opts.tasks ?? UNIT_SIZES[unit].tasks;
  const k = opts.k ?? DEFAULT_K;
  const models = [...(opts.models ?? MODELS)];
  const surfaces = UNIT_SIZES[unit].surfaces;
  const digest = unit === 'g1' ? freshnessDigest(generateFreshnessTasks({ n, seed: opts.seed }))
    : unit === 'g3' ? writeTasksDigest(generateWriteTasks({ n, seed: opts.seed }))
    : unit === 'g4' ? entityTasksDigest(generateEntityTasks({ n, seed: opts.seed }))
    : tasksDigest(g6TaskList(n, opts.seed));
  const perModelEpisodes = n * surfaces * k;
  const per_model = models.map(model => ({ model, episodes: perModelEpisodes, estimate_usd: perModelEpisodes * priceUsage(model, { ...EPISODE_TOKENS[unit], cache_read: 0, cache_write: 0 }) }));
  const plan: Plan = { unit, tasks: n, surfaces, k, models, episodes: perModelEpisodes * models.length, digest, per_model, estimate_usd: per_model.reduce((s, m) => s + m.estimate_usd, 0) };
  if (unit === 'g3') {
    const tasks = generateWriteTasks({ n, seed: opts.seed });
    plan.exposure = Object.fromEntries(G3_SURFACES.map(s => [s, Object.fromEntries(G3_CAUSES.map(c => [c, tasks.filter(t => t.exposure[s][c] === 1).length]))]));
  }
  return plan;
}

/**
 * One job per paid episode, trial-major (every task, surface and model at trial 0 before any at trial 1) so a run paused
 * at the cap holds balanced cells. Keys are stable across invocations, which is what resume matches on.
 */
export function paidJobs(unit: Unit, opts: { tasks: number; k: number; models: readonly string[]; seed?: number; pressured?: boolean; gut?: GbrainUnderTest; budgetRunId: string }): PaidJob[] {
  const { budgetRunId, gut } = opts;
  const jobs: PaidJob[] = [];
  const add = (model: string, id: string, run: PaidJob['run']) => jobs.push({ key: `${unit}:${model}:${id}`, unit, model, run });
  const g1 = unit === 'g1' ? generateFreshnessTasks({ n: opts.tasks, seed: opts.seed }) : [];
  const g3 = unit === 'g3' ? generateWriteTasks({ n: opts.tasks, seed: opts.seed }) : [];
  const g4 = unit === 'g4' ? generateEntityTasks({ n: opts.tasks, seed: opts.seed }) : [];
  const g6 = unit === 'g6' ? g6TaskList(opts.tasks, opts.seed) : [];
  const world = unit === 'g6' ? g6World(opts.seed) : null;
  for (let trial = 0; trial < opts.k; trial++) {
    for (const task of g1) for (const model of opts.models) {
      add(model, `${task.id}:${opts.pressured ? 'pressured' : 'neutral'}:${trial}`, fetchImpl => runFreshnessEpisode({ task, trial, pressured: !!opts.pressured, model, gut, budgetRunId, fetchImpl }));
    }
    for (const task of g3) for (const surface of G3_SURFACES) for (const model of opts.models) {
      add(model, `${task.id}:${surface}:${trial}`, fetchImpl => runWriteEpisode({ task, surface, trial, model, gut, budgetRunId, fetchImpl }));
    }
    for (const task of g4) for (const model of opts.models) {
      add(model, `${task.id}:${trial}`, fetchImpl => runEntityEpisode({ task, trial, model, gut, budgetRunId, fetchImpl }));
    }
    g6.forEach((task, index) => { for (const caller of CALLERS) for (const model of opts.models) {
      add(model, `${task.id}:${caller}:${trial}`, fetchImpl => runOutOfViewEpisode({ world: world!, index, caller, trial, model, gut, budgetRunId, fetchImpl }));
    } });
  }
  return jobs;
}

/**
 * Scorecards per model (and per surface for G3) from episode records. Cost per correct answer counts every dollar the
 * episode log records for the cell: its done episodes' and its errored attempts' (errored rows, and refused rows whose
 * usage records turns billed before a cap stop; a row's record, else its provider usage at ledger prices), divided by
 * the done episodes that succeeded. `usd` is that numerator and
 * `errored_usd` the errored part of it.
 */
export function scorecards(unit: Unit, records: readonly EpisodeRecord[], k: number, erroredAttempts: readonly LogRow[] = []): unknown[] {
  const models = [...new Set(records.map(r => String(r.model)))];
  const charge = (card: unknown, rows: readonly EpisodeRecord[], errored: readonly LogRow[]) => {
    const errored_usd = errored.reduce((s, r) => s + (r.record?.usd ?? (r.usage ? priceUsage(r.model, r.usage) : 0)), 0);
    const usd = (card as { usd: number }).usd + errored_usd;
    return { ...(card as object), usd, errored_usd, cost_per_correct_usd: costPerCorrect(usd, rows.filter(r => r.success).length) };
  };
  return models.flatMap((model): unknown[] => {
    const rows = records.filter(r => r.model === model);
    const errored = erroredAttempts.filter(r => r.model === model);
    if (unit === 'g1') return [charge(summarizeFreshness(rows as unknown as FreshnessEpisode[], k), rows, errored)];
    if (unit === 'g4') return [charge(summarizeEntity(rows as unknown as EntityEpisode[], k), rows, errored)];
    if (unit === 'g6') return [charge(summarizeOutOfView(rows as unknown as OutOfViewEpisode[], k), rows, errored)];
    return G3_SURFACES.map(s => ({ rows: rows.filter(r => (r as { surface?: string }).surface === s), errored: errored.filter(r => r.key.split(':').at(-2) === s) }))
      .filter(c => c.rows.length).map(c => charge(summarizeWriteEpisodes(c.rows as unknown as WriteEpisode[], k), c.rows, c.errored));
  });
}

/** Measured cost per episode by model, and the counted plan's cost projected from those means. */
export function smokeProjection(unit: Unit, done: readonly LogRow[], opts: { seed?: number } = {}) {
  const models = [...new Set(done.map(r => r.model))];
  const per_model = models.map(model => {
    const rows = done.filter(r => r.model === model);
    const usd = rows.reduce((s, r) => s + (r.record?.usd ?? 0), 0);
    const counted = planUnit(unit, { models: [model], seed: opts.seed }).per_model[0];
    const mean = usd / rows.length;
    return {
      model, episodes: rows.length, measured_usd: usd, mean_usd_per_episode: mean,
      requests: rows.reduce((s, r) => s + (r.usage?.requests ?? 0), 0),
      counted_episodes: counted.episodes, projected_counted_usd: mean * counted.episodes, planning_estimate_usd: counted.estimate_usd,
    };
  });
  return { unit, per_model, projected_counted_usd: per_model.reduce((s, m) => s + m.projected_counted_usd, 0) };
}

/** Scripted-model episodes on the real gbrain under test. */
export async function runFake(unit: Unit, opts: { tasks: number; k: number; seed?: number; pressured?: boolean; gut?: GbrainUnderTest }) {
  const model = FAKE_MODEL;
  if (unit === 'g3') {
    const tasks = generateWriteTasks({ n: opts.tasks, seed: opts.seed });
    const scorecards = [];
    const episodes = [];
    for (const surface of G3_SURFACES) {
      const rows = [];
      for (const task of tasks) for (let trial = 0; trial < opts.k; trial++) {
        rows.push(await runWriteEpisode({ task, surface, trial, model, gut: opts.gut, scripted: scriptedWritePolicy(task, surface, 'recovering') }));
      }
      episodes.push(...rows);
      scorecards.push(summarizeWriteEpisodes(rows, opts.k));
    }
    return { scorecards, episodes };
  }
  if (unit === 'g1') {
    const tasks = generateFreshnessTasks({ n: opts.tasks, seed: opts.seed });
    const episodes = [];
    for (const task of tasks) for (let trial = 0; trial < opts.k; trial++) {
      episodes.push(await runFreshnessEpisode({ task, trial, pressured: !!opts.pressured, model, gut: opts.gut, scripted: scriptedFreshnessPolicy(task, 'reads-fresh') }));
    }
    return { scorecards: [summarizeFreshness(episodes, opts.k)], episodes };
  }
  if (unit === 'g6') {
    const world = g6World(opts.seed);
    const episodes = [];
    for (let index = 0; index < g6TaskList(opts.tasks, opts.seed).length; index++) for (const caller of CALLERS) for (let trial = 0; trial < opts.k; trial++) {
      episodes.push(await runOutOfViewEpisode({ world, index, caller, trial, model, gut: opts.gut, policy: 'careful' }));
    }
    return { scorecards: [summarizeOutOfView(episodes, opts.k)], episodes };
  }
  const tasks = generateEntityTasks({ n: opts.tasks, seed: opts.seed });
  const episodes = [];
  for (const task of tasks) for (let trial = 0; trial < opts.k; trial++) {
    episodes.push(await runEntityEpisode({ task, trial, model, gut: opts.gut, scripted: scriptedEntityPolicy(task, 'reads-evidence') }));
  }
  return { scorecards: [summarizeEntity(episodes, opts.k)], episodes };
}

/** The schema-shape grammar on one gbrain build: every shape through MCP tools/call and through gbrain call. */
export async function runGrammar(gut?: GbrainUnderTest) {
  const brain = await SyntheticBrain.create('g3-grammar', GRAMMAR_PAGES, { gut });
  try {
    const mcp = await GbrainMcpArm.start(brain);
    let shapes: SchemaShape[];
    let mcpRows: ShapeRow[];
    try {
      shapes = schemaShapes(mcp.schemas());
      mcpRows = await runSchemaGrammar(shapes, 'mcp', async (op, args) => { await mcp.call(op, args); return mcp.calls[mcp.calls.length - 1]; });
    } finally { await mcp.close(); }
    const cliRows = await runSchemaGrammar(shapes, 'cli', async (op, args): Promise<ArmCall> => {
      const r = await execGbrain(brain.gut, brain.env, ['call', op, JSON.stringify(args)]);
      return { surface: 'cli', argv: ['call', op], args, exit: r.exit, output: `${r.stdout}\n${r.stderr}`, ms: r.ms };
    });
    const rows = [...mcpRows, ...cliRows];
    return { gbrain_version: brain.gut.version, shapes: shapes.length, rows, as_expected: rows.filter(r => r.as_expected).length, surprises: rows.filter(r => !r.as_expected).map(r => `${r.surface} ${r.id}: refused=${r.refused} cause=${r.cause}`) };
  } finally { brain.dispose(); }
}

function write(out: string | undefined, value: unknown) {
  if (!out) return;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(value, null, 2) + '\n');
}

export async function main(argv: readonly string[]): Promise<number> {
  const unit = argv[0];
  const gutSpec = gbrainSpecFrom(argv);
  const out = flag(argv, '--out');
  const seed = flag(argv, '--seed') === undefined ? undefined : intFlag(argv, '--seed', 1);
  if (unit === 'grammar') {
    const gut = resolveGbrainUnderTest(gutSpec);
    const result = { ...(await runGrammar(gut)), overlay: overlaySummary(gut) };
    console.log(JSON.stringify({ gbrain_version: result.gbrain_version, shapes: result.shapes, rows: result.rows.length, as_expected: result.as_expected, surprises: result.surprises }, null, 2));
    write(out, result);
    return 0;
  }
  if (!UNITS.includes(unit as Unit)) {
    console.error(`usage: bun eval/runner/predictive/run.ts <${UNITS.join('|')}|grammar> (--dry-run | --fake | --paid [--smoke] --budget-run-id <id>) [--tasks N] [--k N] [--models a,b] [--pressured] [--preregistration <path>] [--concurrency N] [--retry-errored] [--gbrain <checkout>@<commit>] [--out <path>]`);
    return 2;
  }
  const u = unit as Unit;
  const smoke = argv.includes('--smoke');
  const k = intFlag(argv, '--k', smoke ? 1 : DEFAULT_K);
  const models = flag(argv, '--models')?.split(',').map(m => m.trim()).filter(Boolean) ?? [...MODELS];
  const modes = [argv.includes('--dry-run'), argv.includes('--fake'), paidRequested(argv) || (smoke && !argv.includes('--dry-run'))].filter(Boolean).length;
  if (modes !== 1) { console.error('pass exactly one of --dry-run, --fake or --paid [--smoke] --budget-run-id <id>'); return 2; }

  if (argv.includes('--fake')) {
    const gut = resolveGbrainUnderTest(gutSpec);
    const result = await runFake(u, { tasks: intFlag(argv, '--tasks', 4), k, seed, pressured: argv.includes('--pressured'), gut });
    console.log(JSON.stringify({ mode: 'fake', note: 'scripted model replies: these numbers prove the harness, not any model', gbrain_version: gut.version, overlay: overlaySummary(gut), scorecards: result.scorecards }, null, 2));
    write(out ?? join(REPO_ROOT, 'eval/reports/predictive', `${u}-fake.json`), { ...result, gbrain_version: gut.version });
    return 0;
  }

  const tasks = intFlag(argv, '--tasks', smoke ? 1 : UNIT_SIZES[u].tasks);
  const plan = planUnit(u, { tasks, k, models, seed });
  console.log(JSON.stringify({ mode: argv.includes('--dry-run') ? 'dry-run' : smoke ? 'paid-smoke' : 'paid', ...plan, estimate_usd: Number(plan.estimate_usd.toFixed(2)), per_model: plan.per_model.map(m => ({ ...m, estimate_usd: Number(m.estimate_usd.toFixed(2)) })) }, null, 2));
  if (argv.includes('--dry-run')) return 0;

  const dir = resolve(out ?? join(REPO_ROOT, 'eval/reports/predictive', `${u}-${smoke ? 'smoke' : 'paid'}`));
  const retryErrored = argv.includes('--retry-errored');
  const pressured = argv.includes('--pressured');
  const perEpisode = new Map(plan.per_model.map(m => [m.model, m.estimate_usd / m.episodes]));
  const pending = pendingJobs(paidJobs(u, { tasks, k, models, seed, pressured, budgetRunId: '' }), readEpisodeLog(join(dir, 'episodes.jsonl'), !smoke), retryErrored);
  const estimateUsd = pending.todo.reduce((s, j) => s + perEpisode.get(j.model)!, 0);
  if (pending.todo.length < plan.episodes) console.log(JSON.stringify({ resume: { pending: pending.todo.length, skipped: pending.skipped, estimate_usd: Number(estimateUsd.toFixed(2)) } }));
  const prereg = flag(argv, '--preregistration');
  if (!smoke && !prereg) { console.error(`predictive ${u}: a counted run needs --preregistration <path> (${PREREGISTRATION}); nothing was sent`); return 2; }
  let attestation: Attestation | null = null;
  if (prereg) {
    try { attestation = attestPreregistration(prereg); }
    catch (e) { console.error(`predictive ${u}: preregistration attestation failed: ${(e as Error).message}; nothing was sent`); return 2; }
  }
  let budgetRunId: string;
  try { budgetRunId = requirePaidArm(argv, { arm: `predictive ${u}${smoke ? ' smoke' : ''}`, estimateUsd }).budgetRunId; }
  catch (e) {
    if (e instanceof PaidArmRefusal) { console.error(e.message); return 2; }
    throw e;
  }
  const missing = missingKeys(models);
  if (missing.length) { console.error(`predictive ${u}: ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not set; nothing was sent`); return 2; }
  if (existsSync(join(REPO_ROOT, 'scripts/model-freshness.ts'))) {
    const proc = spawnSync('bun', ['scripts/model-freshness.ts', '--models', models.map(m => `${provider(m)}:${m}`).join(',')], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 });
    if (proc.status !== 0) { console.error(`model freshness check failed (exit ${proc.status}); nothing was sent:\n${`${proc.stdout ?? ''}${proc.stderr ?? ''}`.slice(-4_000)}`); return 2; }
  }
  const gut = resolveGbrainUnderTest(gutSpec);
  const identity = productIdentityFor(gut);
  const resumeArgs = argv.filter(a => a !== '--retry-errored');
  const resumeCommand = ['bun eval/runner/predictive/run.ts', ...resumeArgs, ...(out ? [] : ['--out', dir])].join(' ');
  const { run, guard } = startPaidRun(`predictive-${u}${smoke ? '-smoke' : ''}`, { ...budgetOptionsFrom(argv), runId: budgetRunId, budgetUsd: null, estimateUsd });
  let result;
  let ledger;
  try {
    result = await runPaid(paidJobs(u, { tasks, k, models, seed, pressured, gut, budgetRunId }), {
      log: join(dir, 'episodes.jsonl'), concurrency: intFlag(argv, '--concurrency', DEFAULT_CONCURRENCY), retryErrored,
      counted: !smoke, gbrain: { version: gut.version, commit: identity.loaded_git_head ?? identity.declared_sha }, guard, resumeCommand,
    });
  } catch (e) {
    if (!(e instanceof ResumeRefusal)) throw e;
    console.error(`predictive ${u}: ${e.message}; nothing was sent`);
    return 2;
  } finally {
    guard.uninstall();
    ledger = run.close({ finish: false });
  }
  const records = result.done.map(r => r.record!);
  const summary = {
    mode: smoke ? 'paid-smoke' : 'paid', counted: !smoke, unit: u, plan, preregistration_attestation: attestation, gbrain_version: gut.version, overlay: overlaySummary(gut),
    status: result.status, ran: result.ran, skipped: result.skipped, pause_reason: result.pause_reason,
    done: result.done.length, errored: result.errored.map(r => ({ key: r.key, error: r.error ?? r.record?.stop })),
    errored_by_model: Object.fromEntries(models.map(m => [m, result.errored.filter(r => r.model === m).length])),
    scorecards: records.length ? scorecards(u, records, k, result.errored_attempts) : [],
    measured: records.length ? smokeProjection(u, result.done, { seed }) : null,
    ledger, resume_command: result.status === 'complete' ? null : resumeCommand,
  };
  write(join(dir, 'summary.json'), summary);
  console.log(JSON.stringify({ status: summary.status, ran: summary.ran, skipped: summary.skipped, done: summary.done, errored: summary.errored.length, measured: summary.measured, ledger_usd: ledger.actual_usd, summary: join(dir, 'summary.json') }, null, 2));
  return result.status === 'complete' ? 0 : result.status === 'paused' ? 3 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

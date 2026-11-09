/**
 * Runner for the agent-stack predictive measures (GBEV-55): G1 freshness, G3 write contract, G4 wrong entity, and the
 * keyless G3 schema-shape grammar.
 *
 *   bun eval/runner/predictive/run.ts <g1|g3|g4> --dry-run                 tasks, digest and episode count; no gbrain, no model
 *   bun eval/runner/predictive/run.ts <g1|g3|g4> --fake [--tasks N]         scripted model replies on the real gbrain CLI
 *                                                                           (and MCP for G3); keyless, costs nothing
 *   bun eval/runner/predictive/run.ts <g1|g3|g4> --paid --budget-run-id ID  plans a counted run: episode count and an
 *                                                                           estimate from budget-ledger prices, behind the
 *                                                                           paid-arm guard; it never calls a provider
 *   bun eval/runner/predictive/run.ts grammar                               dispatch every schema shape through MCP and
 *                                                                           gbrain call; keyless
 *
 * Options: --tasks N, --k N (default 4), --models a,b,c (default claude-opus-5-5, gpt-6.1-sol, particle-1),
 * --pressured (G1 time-pressure prompts), --seed N, --gbrain <checkout>@<commit> (the gbrain-under-test overlay, so
 * pins 0.60.549.0 and 0.60.570.0 can be compared without touching the package.json pin), --out <file>.
 *
 * Counted cells wait for their paid window (plan gate changes A1 and the Captain's rulings); this PR builds the paid
 * path as a plan only, so no code here can reach a provider.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { priceUsage } from '../cat40/loop.ts';
import { gbrainSpecFrom, overlaySummary, resolveGbrainUnderTest, type GbrainUnderTest } from '../gbrain-under-test.ts';
import { PaidArmRefusal, paidRequested, requirePaidArm } from '../paid-arm.ts';
import { execGbrain, GbrainMcpArm, SyntheticBrain, type ArmCall } from './cli-arm.ts';
import { runEntityEpisode, runFreshnessEpisode, runWriteEpisode, scriptedEntityPolicy, scriptedFreshnessPolicy, scriptedWritePolicy } from './episodes.ts';
import { summarizeEntity } from './entity-agent.ts';
import { summarizeFreshness } from './freshness.ts';
import { GRAMMAR_PAGES, runSchemaGrammar, schemaShapes, summarizeWriteEpisodes } from './write-contract.ts';
import { freshnessDigest, generateFreshnessTasks, G1_DEFAULT_TASKS } from '../../generators/freshness-world-gen.ts';
import { G3_CAUSES, G3_DEFAULT_TASKS, G3_SURFACES, generateWriteTasks, writeTasksDigest } from '../../generators/write-contract-gen.ts';
import { entityTasksDigest, generateEntityTasks, G4_DEFAULT_TASKS } from '../../generators/entity-agent-gen.ts';

export const UNITS = ['g1', 'g3', 'g4'] as const;
export type Unit = typeof UNITS[number];
export const MODELS = ['claude-opus-5-5', 'gpt-6.1-sol', 'particle-1'] as const;
export const DEFAULT_K = 4;
export const UNIT_SIZES: Record<Unit, { tasks: number; surfaces: number }> = { g1: { tasks: G1_DEFAULT_TASKS, surfaces: 1 }, g3: { tasks: G3_DEFAULT_TASKS, surfaces: G3_SURFACES.length }, g4: { tasks: G4_DEFAULT_TASKS, surfaces: 1 } };
/**
 * Planning assumptions per episode, uncached input and output tokens summed over the loop's turns. They follow the
 * plan's per-episode figures from refresh-barrier Part C usage: short write tasks, and about 2-3 times that for G1's
 * multi-page reads. The smoke replaces them with measured cost per episode before a counted window.
 */
export const EPISODE_TOKENS: Record<Unit, { input: number; output: number }> = { g1: { input: 70_000, output: 4_000 }, g3: { input: 30_000, output: 2_500 }, g4: { input: 40_000, output: 2_500 } };
export const FAKE_MODEL = 'scripted-fake';

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
    : entityTasksDigest(generateEntityTasks({ n, seed: opts.seed }));
  const perModelEpisodes = n * surfaces * k;
  const per_model = models.map(model => ({ model, episodes: perModelEpisodes, estimate_usd: perModelEpisodes * priceUsage(model, { ...EPISODE_TOKENS[unit], cache_read: 0, cache_write: 0 }) }));
  const plan: Plan = { unit, tasks: n, surfaces, k, models, episodes: perModelEpisodes * models.length, digest, per_model, estimate_usd: per_model.reduce((s, m) => s + m.estimate_usd, 0) };
  if (unit === 'g3') {
    const tasks = generateWriteTasks({ n, seed: opts.seed });
    plan.exposure = Object.fromEntries(G3_SURFACES.map(s => [s, Object.fromEntries(G3_CAUSES.map(c => [c, tasks.filter(t => t.exposure[s][c] === 1).length]))]));
  }
  return plan;
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
    try {
      const shapes = schemaShapes(mcp.schemas());
      const rows = await runSchemaGrammar(shapes, {
        mcp: async (op, args) => { await mcp.call(op, args); return mcp.calls[mcp.calls.length - 1]; },
        cli: async (op, args): Promise<ArmCall> => {
          const r = await execGbrain(brain.gut, brain.env, ['call', op, JSON.stringify(args)]);
          return { surface: 'cli', argv: ['call', op], args, exit: r.exit, output: `${r.stdout}\n${r.stderr}`, ms: r.ms };
        },
      });
      return { gbrain_version: brain.gut.version, shapes: shapes.length, rows, as_expected: rows.filter(r => r.as_expected).length, surprises: rows.filter(r => !r.as_expected).map(r => `${r.surface} ${r.id}: refused=${r.refused} cause=${r.cause}`) };
    } finally { await mcp.close(); }
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
    console.error(`usage: bun eval/runner/predictive/run.ts <${UNITS.join('|')}|grammar> (--dry-run | --fake | --paid --budget-run-id <id>) [--tasks N] [--k N] [--models a,b] [--pressured] [--gbrain <checkout>@<commit>] [--out <file>]`);
    return 2;
  }
  const u = unit as Unit;
  const k = intFlag(argv, '--k', DEFAULT_K);
  const models = flag(argv, '--models')?.split(',').map(m => m.trim()).filter(Boolean) ?? [...MODELS];
  const modes = [argv.includes('--dry-run'), argv.includes('--fake'), paidRequested(argv)].filter(Boolean).length;
  if (modes !== 1) { console.error('pass exactly one of --dry-run, --fake or --paid --budget-run-id <id>'); return 2; }

  if (argv.includes('--fake')) {
    const gut = resolveGbrainUnderTest(gutSpec);
    const result = await runFake(u, { tasks: intFlag(argv, '--tasks', 4), k, seed, pressured: argv.includes('--pressured'), gut });
    console.log(JSON.stringify({ mode: 'fake', note: 'scripted model replies: these numbers prove the harness, not any model', gbrain_version: gut.version, overlay: overlaySummary(gut), scorecards: result.scorecards }, null, 2));
    write(out ?? join(REPO_ROOT, 'eval/reports/predictive', `${u}-fake.json`), { ...result, gbrain_version: gut.version });
    return 0;
  }

  const plan = planUnit(u, { tasks: intFlag(argv, '--tasks', UNIT_SIZES[u].tasks), k, models, seed });
  console.log(JSON.stringify({ mode: argv.includes('--dry-run') ? 'dry-run' : 'paid-plan', ...plan, estimate_usd: Number(plan.estimate_usd.toFixed(2)), per_model: plan.per_model.map(m => ({ ...m, estimate_usd: Number(m.estimate_usd.toFixed(2)) })) }, null, 2));
  if (argv.includes('--dry-run')) return 0;
  try {
    const guard = requirePaidArm(argv, { arm: `predictive ${u}`, estimateUsd: plan.estimate_usd });
    console.log(`paid-arm guard passed for run ${guard.budgetRunId}; this runner only plans paid work, so nothing was sent. Counted cells start after the smoke and the window GBEV-3 grants.`);
    return 0;
  } catch (e) {
    if (e instanceof PaidArmRefusal) { console.error(e.message); return 2; }
    throw e;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

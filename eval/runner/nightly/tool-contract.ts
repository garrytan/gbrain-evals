/**
 * Tool-contract replay: each model family's recorded natural tool calls from the SkillOpt frontier probe
 * (docs/benchmarks/2026-11-01-skillopt-method/probe/frontier/f0b-<family>/one-shot/<family>-<skill>-input.txt) replayed,
 * with no provider key, through three paths of the gbrain build at a given root: the SkillOpt rollout registry (read-only),
 * the write-capture registry, and the MCP dispatcher as a remote stdio client. Every refusal is counted by family, path,
 * tool and error code, so a gbrain change that refuses calls a frontier model really makes shows up the next morning.
 *
 *   bun eval/runner/nightly/tool-contract.ts --gbrain-root <dir> --out <file.json> [--families sol,opus] [--skills query,briefing,fact-check]
 *
 * The replayed tools are the read tools whose argument shapes the probe exposed (get_page, traverse_graph, get_backlinks).
 * Each call keeps its recorded arguments and reads a page the rollout brain holds (REPLAY_SLUG), so the replay measures
 * argument handling, not whether a slug exists. For the same reason a refusal that comes from what the replay brain holds
 * is a content miss, counted as answered (isContentMiss). A recorded call whose arguments are not JSON is counted apart: no
 * path can receive it. test/eval/skillopt-rollout-empty-args.test.ts drives the pinned build through the same helpers.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BenchmarkTask } from 'gbrain/core/skillopt';
import { datasetContext } from '../skillopt-method/dataset-context.ts';
import { DEFAULT_DATASET, readSeed } from '../skillopt-method/dataset.ts';
import { FRONTIER_TARGETS, PINNED_SEARCH_CONFIG, PROBE_EMBEDDING } from '../skillopt-method/headroom.ts';
import { withHermeticEnv } from '../hermetic-env.ts';
import { readResult, resultText } from '../refresh-barrier/agent.ts';

export const PROBE_DIR = resolve(import.meta.dir, '../../../docs/benchmarks/2026-11-01-skillopt-method/probe/frontier');
export const FAMILIES = ['sol', 'opus'] as const;
export const SKILLS = ['query', 'briefing', 'fact-check'] as const;
export type Family = typeof FAMILIES[number];
export const PAGE = 'people/vera-chen-14';
export const REPLAY_SLUG: Readonly<Record<string, string>> = { get_page: PAGE, get_backlinks: PAGE, traverse_graph: 'companies/ranger-22' };
export const PATHS = ['rollout', 'write-capture', 'mcp'] as const;
export type ReplayPath = typeof PATHS[number];
const TASK = { task_id: 'tool-contract-replay', task: 'Who is Vera Chen?' } as BenchmarkTask;

export interface Recorded { skill: string; line: string; tool: string; args: Record<string, unknown> | null }

export const inputFile = (family: string, skill: string) => join(PROBE_DIR, `f0b-${family}`, 'one-shot', `${family}-${skill}-input.txt`);

/** The recorded calls to the replayed tools in one input file, with their arguments parsed (null when not JSON). */
export function recordedCalls(family: string, skill: string): Recorded[] {
  return readFileSync(inputFile(family, skill), 'utf8').split('\n').flatMap(line => {
    const m = /^- (get_page|traverse_graph|get_backlinks) ((?:\{|").*[}"]) returned /.exec(line);
    if (!m) return [];
    const input: unknown = JSON.parse(m[2]!);
    let args: Record<string, unknown> | null = null;
    try { args = (typeof input === 'string' ? JSON.parse(input) : input) as Record<string, unknown>; } catch { /* the model sent arguments that are not JSON */ }
    return [{ skill, line, tool: m[1]!, args }];
  });
}

export type Refusal = { code?: string; message: string; suggestion?: string; fix?: { mcp?: { tool: string; arguments: object } } };
export type Call = (tool: string, args: object) => Promise<{ ok: unknown } | { error: Refusal }>;

/**
 * Whether a refusal comes from the replay brain's contents rather than the call's arguments: a named section the replay
 * page has no heading for, or a recorded-time read (known_as_of) at an instant the brain has no history for, since it
 * imports its pages at replay time and never enables the belief ledger (coverage_from, coverage_gap).
 */
export function isContentMiss(args: Record<string, unknown>, refusal: Refusal): boolean {
  if (refusal.code === 'coverage_from' || refusal.code === 'coverage_gap') return true;
  return typeof args.section === 'string' && args.section !== '' && /has no heading/.test(refusal.message);
}
const mod = (root: string, sub: string) => import(join(root, sub)) as Promise<Record<string, any>>;

/** The rollout brain at root: the SkillOpt dataset's pages imported without embeddings, under the probe's pinned search config. */
export async function openReplayBrain(root: string): Promise<any> {
  const [gateway, pglite, importFile] = await Promise.all([mod(root, 'src/core/ai/gateway.ts'), mod(root, 'src/core/pglite-engine.ts'), mod(root, 'src/core/import-file.ts')]);
  gateway.configureGateway({ embedding_model: PROBE_EMBEDDING.model, embedding_dimensions: PROBE_EMBEDDING.dimensions, chat_model: FRONTIER_TARGETS.opus, env: process.env });
  const engine = new pglite.PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const [key, value] of Object.entries(PINNED_SEARCH_CONFIG)) await engine.setConfig(key, value);
  for (const [slug, content] of datasetContext(DEFAULT_DATASET).pages) await importFile.importFromContent(engine, slug, content, { noEmbed: true });
  return engine;
}

/** Run fn with a call into one SkillOpt registry of the build at root (read-only with the named tools, or write-capture). */
export async function withRegistry<T>(root: string, registry: 'read-only' | 'write-capture', fn: (call: Call) => Promise<T>, tools = ['get_page', 'get_backlinks']): Promise<T> {
  const { runRollout } = await mod(root, 'src/core/skillopt/index.ts');
  const engine = await openReplayBrain(root);
  try {
    let out: T | undefined;
    const toolLoopFn = async ({ toolHandlers }: { toolHandlers: Map<string, { execute: (args: object, ctx: never) => Promise<unknown> }> }) => {
      const call: Call = async (tool, args) => {
        try { return { ok: await toolHandlers.get(`brain_${tool}`)!.execute(args, {} as never) }; } catch (e) {
          const text = (e as Error).message;
          try { return { error: JSON.parse(text) as Refusal }; } catch { return { error: { message: text } }; }
        }
      };
      out = await fn(call);
      return { messages: [], stopReason: 'end', totalTurns: 0, totalUsage: {} };
    };
    await runRollout({ engine, skillText: readSeed('query'), targetModel: FRONTIER_TARGETS.sol, task: TASK, toolLoopFn, ...(registry === 'write-capture' ? { writeCapture: true } : { allowedTools: new Set(tools) }) });
    return out!;
  } finally {
    await engine.disconnect().catch(() => {});
  }
}

/** Run fn with a call into gbrain's MCP dispatcher at root, as a remote stdio client scoped to the source the pages were imported into (what GBRAIN_SOURCE gives a stdio server). */
export async function withMcp<T>(root: string, fn: (call: Call) => Promise<T>): Promise<T> {
  const { dispatchToolCall } = await mod(root, 'src/mcp/dispatch.ts');
  const engine = await openReplayBrain(root);
  try {
    return await fn(async (tool, args) => {
      const r = await dispatchToolCall(engine, tool, args, { remote: true, transport: 'stdio', sourceId: 'default' }) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
      const { isError, body } = readResult(resultText(r));
      return isError ? { error: { ...body, message: String(body.message ?? body.error ?? resultText(r).slice(7, 400)), code: String(body.code ?? body.error ?? 'unknown') } as Refusal } : { ok: body };
    });
  } finally {
    await engine.disconnect().catch(() => {});
  }
}

export interface ItemReplay {
  item: string; family: Family; skill: string; calls: number; unparseable: number;
  /** Per path: answered calls (in all and by tool) and refusals by tool and code. */
  paths: Record<ReplayPath, { ok: number; ok_by_tool: Record<string, number>; refused: Record<string, Record<string, number>> }>;
  refusals: number;
}

async function replay(call: Call, calls: Recorded[]): Promise<ItemReplay['paths'][ReplayPath]> {
  const out: ItemReplay['paths'][ReplayPath] = { ok: 0, ok_by_tool: {}, refused: {} };
  for (const c of calls) {
    if (!c.args) continue;
    const r = await call(c.tool, { ...c.args, slug: REPLAY_SLUG[c.tool] });
    if ('ok' in r || isContentMiss(c.args, r.error)) { out.ok++; out.ok_by_tool[c.tool] = (out.ok_by_tool[c.tool] ?? 0) + 1; continue; }
    const code = r.error.code ?? 'no_code';
    const byCode = out.refused[c.tool] ??= {};
    byCode[code] = (byCode[code] ?? 0) + 1;
  }
  return out;
}

/** Replays each (family, skill) item through the three paths of the build at root. */
export async function replayItems(root: string, items: Array<{ family: Family; skill: string }>): Promise<ItemReplay[]> {
  return await withHermeticEnv('nightly-tool-contract', async () => {
    const recorded = items.map(i => ({ ...i, calls: recordedCalls(i.family, i.skill) }));
    const all = recorded.flatMap(r => r.calls);
    const byPath = {} as Record<ReplayPath, Map<Recorded[], ItemReplay['paths'][ReplayPath]>>;
    const run = async (call: Call) => { const m = new Map<Recorded[], ItemReplay['paths'][ReplayPath]>(); for (const r of recorded) m.set(r.calls, await replay(call, r.calls)); return m; };
    const tools = [...new Set(all.map(c => c.tool))];
    byPath.rollout = await withRegistry(root, 'read-only', run, tools);
    byPath['write-capture'] = await withRegistry(root, 'write-capture', run, tools);
    byPath.mcp = await withMcp(root, run);
    return recorded.map(r => {
      const paths = Object.fromEntries(PATHS.map(p => [p, byPath[p].get(r.calls)!])) as ItemReplay['paths'];
      const refusals = PATHS.reduce((n, p) => n + Object.values(paths[p].refused).flatMap(Object.values).reduce((a, b) => a + b, 0), 0);
      return { item: `${r.family}-${r.skill}`, family: r.family, skill: r.skill, calls: r.calls.length, unparseable: r.calls.filter(c => !c.args).length, paths, refusals };
    });
  });
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const root = flag('--gbrain-root'), out = flag('--out');
  if (!root || !out) { console.error('usage: tool-contract.ts --gbrain-root <dir> --out <file.json> [--items sol-query,opus-briefing,...]'); process.exit(2); }
  const items = (flag('--items')?.split(',') ?? FAMILIES.flatMap(f => SKILLS.map(s => `${f}-${s}`))).map(id => {
    const at = id.indexOf('-');
    const family = id.slice(0, at) as Family, skill = id.slice(at + 1);
    if (!FAMILIES.includes(family) || !(SKILLS as readonly string[]).includes(skill)) throw new Error(`unknown tool-contract item ${id}`);
    return { family, skill };
  });
  writeFileSync(out, JSON.stringify(await replayItems(resolve(root), items), null, 1));
}

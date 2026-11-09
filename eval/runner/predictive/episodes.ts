/**
 * Agent episodes for the predictive measures: one task, one surface, one model, one trial, on a fresh synthetic brain.
 *
 * The model side is cat40's runAgent. With a scripted model (the runner's --fake mode and the tests) no provider is
 * called and the episode costs nothing; the gbrain side is always the real CLI or MCP server of the gbrain under test,
 * in the sandbox cli-arm.ts builds. A provider path is reached only when the caller passes a real model and no
 * script, which run.ts allows only behind the paid-arm guard.
 */
import { runAgent, type Arm, type ScriptedModel, type SubmitPayload, type ToolSpec } from '../cat40/loop.ts';
import type { GbrainUnderTest } from '../gbrain-under-test.ts';
import { GbrainCliArm, GbrainMcpArm, SyntheticBrain, type ArmCall } from './cli-arm.ts';
import { bindCheckout, PENDING_OK, type G3Surface, type ScriptedCall, type WriteTask } from '../../generators/write-contract-gen.ts';
import { landingLedger, scoreWriteEpisode, WRITE_SUBMIT_TOOL, type WriteEpisode } from './write-contract.ts';
import { scoreFreshnessEpisode, type FreshnessEpisode } from './freshness.ts';
import { scoreEntityEpisode, type EntityEpisode } from './entity-agent.ts';
import type { FreshnessTask } from '../../generators/freshness-world-gen.ts';
import type { EntityTask } from '../../generators/entity-agent-gen.ts';

export type WritePolicy = 'recovering' | 'careless';

function toolCall(call: ScriptedCall, surface: G3Surface): { name: string; args: Record<string, unknown> } | null {
  if (surface === 'cli') return call.cli ? { name: 'gbrain', args: { argv: call.cli.argv, ...(call.cli.stdin !== undefined ? { stdin: call.cli.stdin } : {}) } } : null;
  return call.mcp ? { name: call.mcp.tool, args: call.mcp.args } : null;
}

/** A scripted model that makes the given tool calls in order, then submits. */
export function scriptedSequence(calls: Array<{ name: string; args: Record<string, unknown> }>, submit: Record<string, unknown>): ScriptedModel {
  return history => history.length < calls.length ? calls[history.length] : { name: 'submit_answer', args: submit };
}

/**
 * The fake model for G3. recovering: the naive call, then every recovery call this surface has, then an honest report.
 * careless: the naive call only, then a report that the write landed whatever gbrain said.
 */
export function scriptedWritePolicy(task: WriteTask, surface: G3Surface, policy: WritePolicy): ScriptedModel {
  const steps = (policy === 'careless' ? [task.naive] : [task.naive, ...task.fixed]).map(c => toolCall(c, surface)).filter(c => c !== null);
  const status = policy === 'recovering' && PENDING_OK.includes(task.cause) ? 'refused' : 'landed';
  return scriptedSequence(steps, { writes: [{ kind: task.target.kind, path: task.target.path, status }] });
}

export interface EpisodeModel { model: string; scripted?: ScriptedModel; fetchImpl?: typeof fetch; maxTurns?: number }

const SYSTEM = 'You work for a founder and keep their gbrain knowledge base. Use the tools to do what they ask, check what gbrain tells you, and finish by calling submit_answer once.';

async function withArm<T>(brain: SyntheticBrain, surface: G3Surface, fn: (arm: Arm & { calls: ArmCall[] }) => Promise<T>): Promise<T> {
  if (surface === 'cli') return fn(new GbrainCliArm(brain));
  const arm = await GbrainMcpArm.start(brain);
  try { return await fn(arm); } finally { await arm.close(); }
}

/** Run one agent loop on an arm, returning the run and the calls the arm recorded. */
export async function runOnArm(arm: Arm & { calls: ArmCall[] }, m: EpisodeModel, user: string, submitTool?: ToolSpec) {
  const run = await runAgent({ model: m.model, system: `${SYSTEM}\n\n${arm.systemHint()}`, user, arm, scripted: m.scripted, fetchImpl: m.fetchImpl, maxTurns: m.maxTurns ?? 16, maxToolChars: 20_000, classifyStops: true, submitTool });
  return { run, calls: [...arm.calls] };
}

export async function runWriteEpisode(input: { task: WriteTask; surface: G3Surface; trial: number; gut?: GbrainUnderTest } & EpisodeModel): Promise<WriteEpisode & { final: SubmitPayload | null }> {
  const brain = await SyntheticBrain.create(`g3-${input.task.id}`, input.task.pages, { gut: input.gut });
  try {
    for (const s of input.task.stage) brain.editOutside(s.slug, s.line, s.commit);
    const task = bindCheckout(input.task, brain.contentRoot);
    const before = await brain.snapshot();
    const { run, calls } = await withArm(brain, input.surface, arm => runOnArm(arm, input, task.prompt, WRITE_SUBMIT_TOOL));
    const after = await brain.snapshot();
    const episode = scoreWriteEpisode({ task, surface: input.surface, model: input.model, trial: input.trial, calls, final: run.final as Record<string, unknown> | null, ledger: landingLedger(before, after), usd: run.usd, stop: run.stop });
    return { ...episode, final: run.final };
  } finally {
    brain.dispose();
  }
}

// ─── G1 and G4: read tasks on the CLI arm ───────────────────────────

/** Build the task's brain, run the agent on the CLI arm with the given question, and dispose of the brain. */
export async function runReadEpisode(input: { label: string; pages: Array<{ slug: string; markdown: string }>; question: string; gut?: GbrainUnderTest } & EpisodeModel) {
  const brain = await SyntheticBrain.create(input.label, input.pages, { gut: input.gut });
  try { return await runOnArm(new GbrainCliArm(brain), input, input.question); } finally { brain.dispose(); }
}

const get = (slug: string) => ({ name: 'gbrain', args: { argv: ['get', slug] } });
const search = (q: string) => ({ name: 'gbrain', args: { argv: ['search', q] } });

export type FreshnessPolicy = 'reads-fresh' | 'stale-unopened' | 'no-memory';

/** Fake G1 models: read every page and answer fresh; open only the stale page and answer stale; or answer without a call. */
export function scriptedFreshnessPolicy(task: FreshnessTask, policy: FreshnessPolicy): ScriptedModel {
  if (policy === 'no-memory') return scriptedSequence([], { answer: task.gold.stale[0], sources: [] });
  if (policy === 'stale-unopened') {
    const stalePage = task.pages.find(p => p.slug !== task.fresh_page)?.slug ?? task.fresh_page;
    return scriptedSequence([search(task.gold.stale[0]), get(stalePage)], { answer: task.gold.stale[0], sources: [stalePage] });
  }
  return scriptedSequence(task.pages.map(p => get(p.slug)), { answer: task.gold.fresh[0], sources: [task.fresh_page] });
}

export type EntityPolicy = 'reads-evidence' | 'namesake';

/** Fake G4 models: open the evidence page and answer the gold id, or answer a confusable namesake. */
export function scriptedEntityPolicy(task: EntityTask, policy: EntityPolicy): ScriptedModel {
  const answer = policy === 'namesake' ? task.candidates.find(c => c !== task.gold)! : task.gold;
  return scriptedSequence([get(task.evidence_page)], { answer, sources: [task.evidence_page] });
}

export async function runFreshnessEpisode(input: { task: FreshnessTask; trial: number; pressured: boolean; gut?: GbrainUnderTest } & EpisodeModel): Promise<FreshnessEpisode> {
  const { run, calls } = await runReadEpisode({ ...input, label: `g1-${input.task.id}`, pages: input.task.pages, question: input.pressured ? input.task.pressured_question : input.task.question });
  return scoreFreshnessEpisode({ task: input.task, model: input.model, trial: input.trial, pressured: input.pressured, calls, answer: run.final?.answer, usd: run.usd, stop: run.stop });
}

export async function runEntityEpisode(input: { task: EntityTask; trial: number; gut?: GbrainUnderTest } & EpisodeModel): Promise<EntityEpisode> {
  const { run } = await runReadEpisode({ ...input, label: `g4-${input.task.id}`, pages: input.task.pages, question: input.task.question });
  return scoreEntityEpisode({ task: input.task, model: input.model, trial: input.trial, answer: run.final?.answer, usd: run.usd, stop: run.stop });
}

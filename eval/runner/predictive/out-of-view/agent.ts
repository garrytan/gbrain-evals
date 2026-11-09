/**
 * G6 agent layer: cross-source tasks over mixed access, answered by an agent as a local and as a remote caller
 * (GBEV-55, gap ranks 8 and 10).
 *
 * Each episode builds the world (gen.ts) into a fresh synthetic brain, importing the pages as files so their privacy
 * frontmatter is kept exactly, and runs the agent on the MCP tool surface (gbrain serve --access read-only):
 *   - remote: GbrainMcpArm, gbrain serve over stdio, which dispatches remote: true with no grant, the identity reach.ts
 *     probes with. Out-of-view gold is not readable.
 *   - local: GbrainCallArm, the same tool list dispatched through gbrain call (remote: false), the trusted CLI caller.
 * Before the agent starts, each of the task's gold pages is probed with get_page as that caller, so the task's
 * out_of_view comes from observed reachability, as tasks.ts requires. Probe calls are not the agent's.
 *
 * The answer is the fixed schema {answered, abstained, citations}, parsed with tasks.ts parseAnswer (anything else is
 * an invalid row, never a judge call) and scored with scoreAnswer. The scorecard reports verdicts by caller and by the
 * privacy sub-cause of the hidden gold, plus answers given without the gold.
 */
import type { ScriptedModel, ToolSpec } from '../../cat40/loop.ts';
import type { GbrainUnderTest } from '../../gbrain-under-test.ts';
import { PRIVACY_SUBCAUSES, type CauseId, type PrivacySubcause } from '../causes.ts';
import { GbrainCallArm, GbrainMcpArm, SyntheticBrain, type ArmCall } from '../cli-arm.ts';
import { runOnArm, type EpisodeModel } from '../episodes.ts';
import { costPerCorrect, passHatCurve, passHatK, type TaskTrials } from '../passk.ts';
import { CALLERS, expectedReachable, generateWorld, type Caller, type World } from './gen.ts';
import { buildTasks, parseAnswer, scoreAnswer, VERDICTS, type Task, type Verdict } from './tasks.ts';

export const G6_SEED = 7;
export const SERVE_ARGS = ['--access', 'read-only'];

export const OOV_ANSWER_TOOL: ToolSpec = {
  name: 'submit_answer',
  description: 'Submit your final answer. Call this exactly once, when you are done.',
  input_schema: {
    type: 'object',
    properties: {
      answered: { type: 'boolean', description: 'true when you answer the question from pages you read.' },
      abstained: { type: 'boolean', description: 'true when you cannot answer because a page you need is not available to you.' },
      citations: { type: 'array', items: { type: 'string' }, description: 'Slugs of the pages you used; empty when you abstain.' },
    },
    required: ['answered', 'abstained', 'citations'],
    additionalProperties: false,
  },
};

export function g6World(seed = G6_SEED): World { return generateWorld(seed); }

/** The world's tasks with each caller's out_of_view from the intended views (expectedReachable); an episode replaces its caller's with what it observes. */
export function g6Tasks(world: World, observed: { caller: Caller; reachable: Record<string, boolean> } | null = null): Task[] {
  const intended = new Map(world.pages.map(p => [p.slug, p.intended ?? 'visible']));
  return buildTasks(world, (slug, c) => observed && c === observed.caller && slug in observed.reachable ? observed.reachable[slug] : expectedReachable(intended.get(slug) ?? 'visible', c));
}

export interface OutOfViewEpisode {
  task_id: string; caller: Caller; model: string; trial: number;
  out_of_view: string[]; subcauses: PrivacySubcause[];
  answer: unknown; verdict: Verdict | 'invalid'; success: boolean; cause: CauseId | 'correct';
  brain_calls: number; usd: number; stop: string;
}

export function scoreOutOfViewEpisode(input: { world: World; task: Task; caller: Caller; model: string; trial: number; calls: readonly ArmCall[]; final: unknown; usd: number; stop: string }): OutOfViewEpisode {
  const { task, caller } = input;
  const answer = parseAnswer(input.final);
  const verdict: OutOfViewEpisode['verdict'] = answer ? scoreAnswer(task, caller, answer) : 'invalid';
  const intended = new Map(input.world.pages.map(p => [p.slug, p.intended]));
  const hidden = task.out_of_view[caller];
  const subcauses = [...new Set(hidden.map(s => intended.get(s)).filter((v): v is PrivacySubcause => (PRIVACY_SUBCAUSES as readonly string[]).includes(String(v))))];
  const cited = answer?.citations ?? [];
  const cause: OutOfViewEpisode['cause'] = verdict === 'correct' || verdict === 'abstained_correctly' ? 'correct'
    : verdict === 'answered_without_gold' ? 'citation_abstention'
    : verdict === 'invalid' ? (input.stop === 'harness_error' ? 'harness_error' : 'model_error')
    : cited.some(s => task.decoy.includes(s)) ? 'wrong_entity'
    : answer?.abstained ? 'citation_abstention' : 'partial_evidence';
  return {
    task_id: task.id, caller, model: input.model, trial: input.trial, out_of_view: hidden, subcauses,
    answer: input.final ?? null, verdict, success: cause === 'correct', cause, brain_calls: input.calls.length, usd: input.usd, stop: input.stop,
  };
}

/** Whether a get_page answer is the page: gbrain call prints the page as indented JSON; gbrain serve puts it on the first line, before any notice blocks. */
function readable(output: string, slug: string): boolean {
  if (output.startsWith('Error:')) return false;
  for (const text of [output, output.split('\n')[0]]) {
    try { return (JSON.parse(text) as { slug?: unknown }).slug === slug; } catch { /* try the next form */ }
  }
  return false;
}

/** A fake agent: read each gold page; abstain if one is not readable, else answer citing both. answers-anyway skips the check. */
export function scriptedOutOfViewPolicy(task: Task, policy: 'careful' | 'answers-anyway'): ScriptedModel {
  return history => {
    if (history.length < task.gold.length) return { name: 'get_page', args: { slug: task.gold[history.length] } };
    const blocked = policy === 'careful' && task.gold.some((slug, i) => !readable(history[i].result, slug));
    return { name: 'submit_answer', args: blocked ? { answered: false, abstained: true, citations: [] } : { answered: true, abstained: false, citations: [...task.gold] } };
  };
}

export async function runOutOfViewEpisode(input: { world: World; index: number; caller: Caller; trial: number; gut?: GbrainUnderTest; policy?: 'careful' | 'answers-anyway' } & EpisodeModel): Promise<OutOfViewEpisode> {
  if (!input.scripted && !input.policy && !input.budgetRunId) throw new Error(`a real ${input.model} episode needs the paid-arm guard: pass the budgetRunId requirePaidArm returned, inside a granted paid window`);
  const { world, caller } = input;
  const brain = await SyntheticBrain.create(`g6-${input.index}-${caller}`, world.pages.map(p => ({ slug: p.slug, markdown: p.markdown })), { gut: input.gut, seed: 'files' });
  try {
    const mcp = await GbrainMcpArm.start(brain, SERVE_ARGS);
    let arm: GbrainMcpArm | GbrainCallArm = mcp;
    const gold = g6Tasks(world)[input.index].gold;
    const probe = async (a: GbrainMcpArm | GbrainCallArm) => Object.fromEntries(await Promise.all(gold.map(async s => [s, readable(await a.call('get_page', { slug: s }), s)] as const)));
    let observed: Record<string, boolean>;
    try {
      if (caller === 'remote') observed = await probe(mcp);
      else {
        arm = new GbrainCallArm(brain, mcp.tools(), mcp.instructions());
        await mcp.close();
        observed = await probe(arm);
      }
      arm.calls.length = 0;
      const task = g6Tasks(world, { caller, reachable: observed })[input.index];
      const scripted = input.scripted ?? (input.policy ? scriptedOutOfViewPolicy(task, input.policy) : undefined);
      const { run, calls } = await runOnArm(arm, { ...input, scripted }, task.question, OOV_ANSWER_TOOL);
      return scoreOutOfViewEpisode({ world, task, caller, model: input.model, trial: input.trial, calls, final: run.final, usd: run.usd, stop: run.stop });
    } finally {
      await mcp.close();
    }
  } finally {
    brain.dispose();
  }
}

export interface OutOfViewScorecard {
  unit: 'G6'; model: string; episodes: number;
  by_caller: Record<Caller, { episodes: number; verdicts: Record<Verdict | 'invalid', number>; answered_without_gold: number; success: number }>;
  by_subcause: Record<PrivacySubcause, { episodes: number; verdicts: Partial<Record<Verdict | 'invalid', number>> }>;
  answered_without_gold: number;
  pass_hat_k: { k: number; value: number | null; curve: number[] };
  usd: number; cost_per_correct_usd: number | null;
  failure_causes: Partial<Record<CauseId, number>>;
}

export function summarizeOutOfView(episodes: readonly OutOfViewEpisode[], k: number): OutOfViewScorecard {
  if (episodes.length === 0) throw new Error('no G6 episodes to summarize');
  const { model } = episodes[0];
  if (episodes.some(e => e.model !== model)) throw new Error('a G6 scorecard covers one model');
  const zero = () => Object.fromEntries([...VERDICTS, 'invalid'].map(v => [v, 0])) as Record<Verdict | 'invalid', number>;
  const by_caller = Object.fromEntries(CALLERS.map(c => [c, { episodes: 0, verdicts: zero(), answered_without_gold: 0, success: 0 }])) as OutOfViewScorecard['by_caller'];
  const by_subcause = Object.fromEntries(PRIVACY_SUBCAUSES.map(s => [s, { episodes: 0, verdicts: {} }])) as OutOfViewScorecard['by_subcause'];
  const byProbe = new Map<string, TaskTrials>();
  const failure_causes: Partial<Record<CauseId, number>> = {};
  for (const e of episodes) {
    const c = by_caller[e.caller];
    c.episodes++; c.verdicts[e.verdict]++; if (e.verdict === 'answered_without_gold') c.answered_without_gold++; if (e.success) c.success++;
    for (const s of e.subcauses) { by_subcause[s].episodes++; by_subcause[s].verdicts[e.verdict] = (by_subcause[s].verdicts[e.verdict] ?? 0) + 1; }
    const key = `${e.task_id}:${e.caller}`;
    const t = byProbe.get(key) ?? { task_id: key, successes: 0, trials: 0 };
    t.trials++; if (e.success) t.successes++;
    byProbe.set(key, t);
    if (e.cause !== 'correct') failure_causes[e.cause] = (failure_causes[e.cause] ?? 0) + 1;
  }
  const trials = [...byProbe.values()];
  const minTrials = Math.min(...trials.map(t => t.trials));
  const correct = episodes.filter(e => e.success).length;
  const usd = episodes.reduce((s, e) => s + e.usd, 0);
  return {
    unit: 'G6', model, episodes: episodes.length, by_caller, by_subcause,
    answered_without_gold: episodes.filter(e => e.verdict === 'answered_without_gold').length,
    pass_hat_k: { k, value: minTrials >= k ? passHatK(trials, k) : null, curve: passHatCurve(trials, Math.min(k, minTrials)) },
    usd, cost_per_correct_usd: costPerCorrect(usd, correct), failure_causes,
  };
}

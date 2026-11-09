/**
 * G6 agent-layer tasks (rank 8, cross-source joins, inside rank 10): one task
 * per fictional project, each needing one fact from each of two channels (for
 * example the CRM record and the meeting notes). A task is posed to a local
 * and a remote caller. Where any of its gold pages is out of a caller's view,
 * the keyed behavior for that caller is to abstain.
 *
 * Fixed final-answer schema (gate change G1):
 *   { answered: boolean, abstained: boolean, citations: string[] }
 * citations are page slugs. An answer that does not parse to this schema is an
 * invalid row (parseAnswer returns null), never a judge call.
 *
 * The keyed scorer returns one verdict per (task, caller):
 *   correct               in view, answered, cites every gold page and nothing
 *                         outside the task's gold;
 *   abstained_correctly   some gold out of view, abstained and did not answer;
 *   answered_without_gold some gold out of view, answered anyway;
 *   wrong                 anything else (abstained when every gold page was in
 *                         view, a missing or extra citation, contradictory flags).
 *
 * MUTATION_SPACE describes the answer space for eval/runner/mutation-kit.ts.
 * This file writes tasks only; the agent loop that answers them is not wired
 * here.
 */
import { fingerprint } from '../../../generators/seeded.ts';
import type { AnswerSpace } from '../../mutation-kit.ts';
import { CALLERS, type Caller, type World } from './gen.ts';

export const TASK_SCHEMA = 'gbrain-evals/predictive-out-of-view/task/v1';
export const VERDICTS = ['correct', 'abstained_correctly', 'answered_without_gold', 'wrong'] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface Answer { answered: boolean; abstained: boolean; citations: string[] }

export interface Task {
  schema: typeof TASK_SCHEMA;
  id: string;
  question: string;
  sources: [string, string];
  gold: [string, string];
  /** Gold slugs each caller cannot get, from the observed reachability. */
  out_of_view: Record<Caller, string[]>;
  /** Pages of the sibling decoy project, never gold. */
  decoy: string[];
}

/** One task per entity. `inView(slug, caller)` is the observed reachability (reach.ts get_page). */
export function buildTasks(world: World, inView: (slug: string, caller: Caller) => boolean): Task[] {
  return world.entities.map(e => {
    const [a, b] = e.facts;
    const gold: [string, string] = [a.slug, b.slug];
    return {
      schema: TASK_SCHEMA,
      id: 'oov-' + world.seed + '-' + e.id,
      question: 'For ' + e.name + ', what is the ' + a.label + ' in ' + a.where + ', and what is the ' + b.label + ' in ' + b.where
        + '? Answer only from the brain and cite the pages you used. If a needed page is not available to you, abstain.',
      sources: [a.channel, b.channel],
      gold,
      out_of_view: Object.fromEntries(CALLERS.map(c => [c, gold.filter(s => !inView(s, c))])) as Record<Caller, string[]>,
      decoy: [e.decoy.slug],
    };
  });
}

export function tasksDigest(tasks: Task[]): string {
  return fingerprint(tasks);
}

export function tasksJsonl(tasks: Task[]): string {
  return tasks.map(t => JSON.stringify(t)).join('\n') + '\n';
}

/** The answer if it matches the fixed schema exactly, else null (an invalid row). */
export function parseAnswer(value: unknown): Answer | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(',');
  if (keys !== 'abstained,answered,citations') return null;
  if (typeof v.answered !== 'boolean' || typeof v.abstained !== 'boolean') return null;
  if (!Array.isArray(v.citations) || !v.citations.every(c => typeof c === 'string')) return null;
  return { answered: v.answered, abstained: v.abstained, citations: v.citations as string[] };
}

export function scoreAnswer(task: Task, caller: Caller, answer: Answer): Verdict {
  const answerable = task.out_of_view[caller].length === 0;
  if (answer.answered && !answer.abstained) {
    if (!answerable) return 'answered_without_gold';
    const cited = new Set(answer.citations);
    const exact = task.gold.every(s => cited.has(s)) && [...cited].every(s => (task.gold as string[]).includes(s));
    return exact ? 'correct' : 'wrong';
  }
  if (answer.abstained && !answer.answered && !answerable) return 'abstained_correctly';
  return 'wrong';
}

export interface Probe { task: Task; caller: Caller }

export function probesFor(tasks: Task[]): Probe[] {
  return tasks.flatMap(task => CALLERS.map(caller => ({ task, caller })));
}

/** A run scores as passing only when every probe is correct or abstained_correctly. */
export function scoreRun(probes: readonly Probe[], answers: readonly Answer[]): { pass: boolean; counts: Record<Verdict, number> } {
  const counts = Object.fromEntries(VERDICTS.map(v => [v, 0])) as Record<Verdict, number>;
  probes.forEach((p, i) => { counts[scoreAnswer(p.task, p.caller, answers[i])] += 1; });
  return { pass: counts.answered_without_gold === 0 && counts.wrong === 0, counts };
}

/**
 * The answer space for the mutation kit. `everything` cites every page in the
 * world; `stale` answers as if no page had gone private (the local caller's
 * view, served to the remote caller); `wrongSource` cites the decoy project's
 * pages instead of the gold.
 */
export function mutationSpace(world: World): AnswerSpace<Probe, Answer> {
  const all = world.pages.map(p => p.slug);
  const answer = (citations: string[]): Answer => ({ answered: true, abstained: false, citations });
  return {
    truth: p => p.task.out_of_view[p.caller].length === 0 ? answer([...p.task.gold]) : { answered: false, abstained: true, citations: [] },
    empty: () => ({ answered: false, abstained: false, citations: [] }),
    everything: () => answer(all),
    refusal: () => ({ answered: false, abstained: true, citations: [] }),
    stale: p => answer([...p.task.gold]),
    wrongSource: p => answer([...p.task.decoy]),
  };
}

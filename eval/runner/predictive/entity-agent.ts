/**
 * G4 scoring: wrong entity at agent level (GBEV-55).
 *
 * The answer is an entity id (a page slug). keyEntity is exact: it lowercases, trims whitespace, a leading slash,
 * surrounding quotes or backticks and a trailing ".md", and nothing else. A prefix, a substring, a name instead of an id,
 * or an answer naming two ids never matches. That strictness is the point: the T0b namesake scorer counted 11 of 11
 * namesake failures that were its own false positives.
 *
 * Causes: correct; wrong_entity when the answer is another page id in the brain (a confusable candidate or any other
 * page); invalid when it names no page id. B-cubed precision and recall over episodes come from N4's bcubed helper,
 * with invalid answers as singletons.
 */
import type { CauseId } from './causes.ts';
import { costPerCorrect, passHatCurve, passHatK, type TaskTrials } from './passk.ts';
import { bcubed } from '../n4-entity-resolution.ts';
import type { EntityTask, G4Pattern } from '../../generators/entity-agent-gen.ts';

export const G4_K = 4;
export type G4Cause = Extract<CauseId, 'wrong_entity'> | 'correct' | 'invalid';

const ID = /^[a-z0-9][a-z0-9/_-]*$/;

/** The page id an answer names, or null. */
export function keyEntity(answer: string | null | undefined): string | null {
  if (typeof answer !== 'string') return null;
  const id = answer.trim().replace(/^["'`]+|["'`]+$/g, '').trim().toLowerCase().replace(/^\/+/, '').replace(/\.md$/, '');
  return ID.test(id) && id.includes('/') ? id : null;
}

export interface EntityEpisode {
  task_id: string; pattern: G4Pattern; model: string; trial: number;
  answer: string | null; predicted: string | null; gold: string;
  valid: boolean; success: boolean; cause: G4Cause; confused_with_candidate: boolean; usd: number; stop: string;
}

export function scoreEntityEpisode(input: { task: EntityTask; model: string; trial: number; answer: string | null | undefined; usd: number; stop: string }): EntityEpisode {
  const { task } = input;
  const predicted = keyEntity(input.answer);
  const known = new Set(task.pages.map(p => p.slug));
  const cause: G4Cause = predicted === task.gold ? 'correct' : predicted !== null && known.has(predicted) ? 'wrong_entity' : 'invalid';
  return {
    task_id: task.id, pattern: task.pattern, model: input.model, trial: input.trial, answer: input.answer ?? null, predicted, gold: task.gold,
    valid: cause !== 'invalid', success: cause === 'correct', cause, confused_with_candidate: cause === 'wrong_entity' && task.candidates.includes(predicted!),
    usd: input.usd, stop: input.stop,
  };
}

export interface EntityScorecard {
  unit: 'G4'; model: string; episodes: number; tasks: number; valid: number; invalid: number;
  correct: number; wrong_entity: number; accuracy_valid: number | null;
  b3: { precision: number; recall: number; f1: number };
  by_pattern: Record<string, { episodes: number; correct: number; wrong_entity: number; invalid: number }>;
  pass_hat_k: { k: number; value: number | null; curve: number[] };
  usd: number; cost_per_correct_usd: number | null;
}

export function summarizeEntity(episodes: readonly EntityEpisode[], k = G4_K): EntityScorecard {
  if (episodes.length === 0) throw new Error('no G4 episodes to summarize');
  const { model } = episodes[0];
  if (episodes.some(e => e.model !== model)) throw new Error('a G4 scorecard covers one model');
  const by_pattern: EntityScorecard['by_pattern'] = {};
  const byTask = new Map<string, TaskTrials>();
  for (const e of episodes) {
    const p = by_pattern[e.pattern] ??= { episodes: 0, correct: 0, wrong_entity: 0, invalid: 0 };
    p.episodes++; if (e.cause === 'correct') p.correct++; else if (e.cause === 'wrong_entity') p.wrong_entity++; else p.invalid++;
    const t = byTask.get(e.task_id) ?? { task_id: e.task_id, successes: 0, trials: 0 };
    t.trials++; if (e.success) t.successes++;
    byTask.set(e.task_id, t);
  }
  const trials = [...byTask.values()];
  const minTrials = Math.min(...trials.map(t => t.trials));
  const correct = episodes.filter(e => e.success).length;
  const valid = episodes.filter(e => e.valid).length;
  const usd = episodes.reduce((s, e) => s + e.usd, 0);
  return {
    unit: 'G4', model, episodes: episodes.length, tasks: trials.length, valid, invalid: episodes.length - valid,
    correct, wrong_entity: episodes.filter(e => e.cause === 'wrong_entity').length, accuracy_valid: valid ? correct / valid : null,
    b3: bcubed(episodes.map(e => e.gold), episodes.map(e => e.predicted)),
    by_pattern,
    pass_hat_k: { k, value: minTrials >= k ? passHatK(trials, k) : null, curve: passHatCurve(trials, Math.min(k, minTrials)) },
    usd, cost_per_correct_usd: costPerCorrect(usd, correct),
  };
}

/**
 * G1 scoring: freshness across pages, time reasoning and memory not consulted (GBEV-55).
 *
 * The answer is one value, keyed against three disjoint readings (fresh, stale, time_shifted) with no model judge.
 * An answer that matches no reading, or more than one, is an invalid row: it is counted and reported, never judged.
 * pages_opened counts get calls only (CLI `gbrain get <slug>`, MCP get_page); a search snippet that shows the fresh
 * value does not count as opening the page.
 *
 * Causes, in order: memory_not_consulted (no gbrain call at all), then by reading: fresh is correct, time_shifted is
 * time_reasoning, stale is stale_fact when the fresh page was opened and gold_unopened when it was not.
 */
import type { CauseId } from './causes.ts';
import { costPerCorrect, passHatCurve, passHatK, type TaskTrials } from './passk.ts';
import type { ArmCall } from './cli-arm.ts';
import { READINGS, type FreshnessTask, type G1Pattern, type Reading } from '../../generators/freshness-world-gen.ts';

export const G1_K = 4;
export type G1Cause = Extract<CauseId, 'stale_fact' | 'gold_unopened' | 'time_reasoning' | 'memory_not_consulted'> | 'correct' | 'invalid';

/** Lowercase, accents off, "million" to "m", and $ , and spaces removed, so "$12 million" and "12M" key alike. */
export function normalizeValue(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\s*million\b/g, 'm').replace(/[$,]/g, '').replace(/\s+/g, ' ').trim();
}

function holds(answer: string, alias: string): boolean {
  const a = normalizeValue(alias).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9.])${a}(?![a-z0-9]|\.\d)`).test(normalizeValue(answer));
}

/** Which reading the answer gives, or null when it names none or several. */
export function keyAnswer(answer: string | undefined, gold: Record<Reading, string[]>): Reading | null {
  if (!answer?.trim()) return null;
  const hits = READINGS.filter(r => gold[r].some(alias => holds(answer, alias)));
  return hits.length === 1 ? hits[0] : null;
}

/** Slugs read with get calls, in order, without repeats. Search, query and recall results never count. */
export function pagesOpened(calls: readonly ArmCall[]): string[] {
  const out: string[] = [];
  for (const c of calls) {
    let slug: string | undefined;
    if (c.surface === 'cli' && c.argv[0] === 'get') {
      const rest = c.argv.slice(1);
      const dd = rest.indexOf('--');
      const VALUE_FLAGS = new Set(['--lines', '--bytes', '--cursor', '--section', '--grep', '--context', '--max-bytes', '--view', '--body', '--source-id', '--around-chunk-id', '--context-lines', '--outline-from', '--brain', '--source']);
      if (dd >= 0) slug = rest[dd + 1];
      else for (let i = 0; i < rest.length; i++) { if (VALUE_FLAGS.has(rest[i])) { i++; continue; } if (!rest[i].startsWith('--')) { slug = rest[i]; break; } }
    } else if (c.surface === 'mcp' && c.argv[0] === 'get_page' && typeof c.args?.slug === 'string') slug = c.args.slug;
    if (slug && c.exit === 0 && !out.includes(slug)) out.push(slug);
  }
  return out;
}

export interface FreshnessEpisode {
  task_id: string; pattern: G1Pattern; model: string; trial: number; pressured: boolean;
  answer: string | null; reading: Reading | null; pages_opened: string[]; opened_fresh_page: boolean; brain_calls: number;
  valid: boolean; success: boolean; cause: G1Cause; usd: number; stop: string;
}

export function scoreFreshnessEpisode(input: { task: FreshnessTask; model: string; trial: number; pressured: boolean; calls: readonly ArmCall[]; answer: string | null | undefined; usd: number; stop: string }): FreshnessEpisode {
  const opened = pagesOpened(input.calls);
  const reading = keyAnswer(input.answer ?? undefined, input.task.gold);
  const openedFresh = opened.includes(input.task.fresh_page);
  const cause: G1Cause = input.calls.length === 0 ? 'memory_not_consulted'
    : reading === null ? 'invalid'
    : reading === 'fresh' ? 'correct'
    : reading === 'time_shifted' ? 'time_reasoning'
    : openedFresh ? 'stale_fact' : 'gold_unopened';
  return {
    task_id: input.task.id, pattern: input.task.pattern, model: input.model, trial: input.trial, pressured: input.pressured,
    answer: input.answer ?? null, reading, pages_opened: opened, opened_fresh_page: openedFresh, brain_calls: input.calls.length,
    valid: cause !== 'invalid', success: cause === 'correct', cause, usd: input.usd, stop: input.stop,
  };
}

export interface FreshnessScorecard {
  unit: 'G1'; model: string; pressured: boolean; episodes: number; valid: number; invalid: number; tasks: number;
  correct: number; accuracy_valid: number | null;
  causes: Record<G1Cause, number>;
  by_pattern: Record<string, { episodes: number; correct: number; causes: Partial<Record<G1Cause, number>> }>;
  mean_pages_opened: number; opened_fresh_share: number | null;
  pass_hat_k: { k: number; value: number | null; curve: number[] };
  usd: number; cost_per_correct_usd: number | null;
}

export function summarizeFreshness(episodes: readonly FreshnessEpisode[], k = G1_K): FreshnessScorecard {
  if (episodes.length === 0) throw new Error('no G1 episodes to summarize');
  const { model, pressured } = episodes[0];
  if (episodes.some(e => e.model !== model || e.pressured !== pressured)) throw new Error('a G1 scorecard covers one model and one prompt variant');
  const causes = { correct: 0, stale_fact: 0, gold_unopened: 0, time_reasoning: 0, memory_not_consulted: 0, invalid: 0 } as Record<G1Cause, number>;
  const by_pattern: FreshnessScorecard['by_pattern'] = {};
  const byTask = new Map<string, TaskTrials>();
  for (const e of episodes) {
    causes[e.cause]++;
    const p = by_pattern[e.pattern] ??= { episodes: 0, correct: 0, causes: {} };
    p.episodes++; if (e.success) p.correct++; p.causes[e.cause] = (p.causes[e.cause] ?? 0) + 1;
    const t = byTask.get(e.task_id) ?? { task_id: e.task_id, successes: 0, trials: 0 };
    t.trials++; if (e.success) t.successes++;
    byTask.set(e.task_id, t);
  }
  const trials = [...byTask.values()];
  const valid = episodes.filter(e => e.valid);
  const correct = causes.correct;
  const usd = episodes.reduce((s, e) => s + e.usd, 0);
  const minTrials = Math.min(...trials.map(t => t.trials));
  return {
    unit: 'G1', model, pressured, episodes: episodes.length, valid: valid.length, invalid: causes.invalid, tasks: trials.length,
    correct, accuracy_valid: valid.length ? correct / valid.length : null, causes, by_pattern,
    mean_pages_opened: episodes.reduce((s, e) => s + e.pages_opened.length, 0) / episodes.length,
    opened_fresh_share: episodes.filter(e => e.opened_fresh_page).length / episodes.length,
    pass_hat_k: { k, value: minTrials >= k ? passHatK(trials, k) : null, curve: passHatCurve(trials, Math.min(k, minTrials)) },
    usd, cost_per_correct_usd: costPerCorrect(usd, correct),
  };
}

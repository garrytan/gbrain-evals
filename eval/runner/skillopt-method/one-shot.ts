/**
 * The harness-level one-shot rewrite for the SkillOpt method benchmark
 * (GST-799, plan revision 3, decision A3): the plan's own one-shot arm, which
 * the frontier probe's stage F0b runs.
 *
 *   1. The seed runs once on each of the 24 train tasks on the target, through
 *      gbrain's rollout and the counted scorer (`seedOnTrain`).
 *   2. The proposer input holds the seed, the skill's criteria.md and, per
 *      train task, its prompt, the tools the agent called with the pages they
 *      returned (slug and title only, never page text), its final answer, a
 *      pass or fail and the failed check kinds without their arguments
 *      (`proposerInput`). A returned page is named only when the train split
 *      itself shows it (a train gold page or one a train prompt names); any
 *      other page is counted, not named.
 *   3. One `claude-opus-5-5` call through gbrain's gateway asks for one full
 *      rewritten SKILL.md and returns its text and cost (`proposeRewrite`).
 *
 * Repeats reuse the same train trajectories with independent proposer samples.
 *
 * Gold never reaches the proposer. Check arguments are not rendered, tool
 * outputs carry no page text, and before the input is sent every selection
 * gold slug, value and subject the train split does not itself show is
 * withheld from it, the agents' answers included, and so is every corpus
 * slug the train split does not show, wherever it occurs (a tool input, an
 * answer); a marker or such a slug still present afterwards throws. The probe
 * reads no test file, so test gold is kept out by construction: no page text,
 * and no page name or slug the train split does not show. A test value the
 * train side states itself (in a prompt or an agent's answer) stays, and the
 * audit (audit.ts) disqualifies a rewrite that names a page, a corpus
 * entity, a gold value or a date.
 */
import { chat } from 'gbrain/ai/gateway';
import type { PGLiteEngine } from 'gbrain/pglite-engine';
import type { MethodTask } from '../../generators/skillopt-method/common.ts';
import { callCostUsd, scoreArm, type ArmScore, type MeterTotals } from './rollouts.ts';
import { citationPattern, citedSlugs, renderFailedCheck, valuePattern, type GoldValue, type MethodCheck, type RuleCheck } from './score.ts';

export const PROPOSER_MODEL = 'anthropic:claude-opus-5-5';
/** The proposer's output cap: gbrain's default for a Claude 5 model, room for thinking and a full SKILL.md. */
export const ONE_SHOT_MAX_TOKENS = 32_000;

export const ONE_SHOT_SYSTEM = [
  'You improve an agent skill: a SKILL.md file an AI agent reads as its system prompt before it works on a task with read-only tools over the user\'s brain, a knowledge base of their pages.',
  'You get the current skill, the success criteria every answer is scored against, and how the current skill did on training tasks: each task, the tools the agent called and the pages they returned, its final answer, and which checks failed.',
  'Write one improved, complete SKILL.md. Keep its frontmatter block unchanged. Improve the procedure in general terms and name no person, company, account, page, value or date from the training tasks: the skill is scored on other tasks.',
  'Reply with the full SKILL.md and nothing else.',
].join(' ');

/** A text a forbidden marker was replaced with. */
export const WITHHELD = '[withheld]';

export interface TrainToolCall { name: string; input: unknown; failed: boolean; pages: Array<{ slug: string; title: string }> }

export interface TrainTrajectory {
  task_id: string;
  task: string;
  /** Null when the rollout errored and left no answer. */
  answer: string | null;
  correct: boolean;
  /** Failed checks as kind and description, never their arguments. */
  failed: string[];
  tool_calls: TrainToolCall[];
}

/** The pages a tool output names, as slug and title: everything else in the output (page text, chunks, scores) is dropped. */
export function pagesOf(output: unknown): Array<{ slug: string; title: string }> {
  const out = new Map<string, string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o.slug === 'string' && !out.has(o.slug)) out.set(o.slug, typeof o.title === 'string' ? o.title : '');
    for (const child of Object.values(o)) if (child && typeof child === 'object') walk(child);
  };
  walk(output);
  return [...out].map(([slug, title]) => ({ slug, title }));
}

const renderFailed = (c: RuleCheck) => `${(c as Partial<MethodCheck>).kind ?? 'check'} (${renderFailedCheck(c)})`;

/** Step 1: the seed once on each train task, scored by the counted scorer, with each trajectory kept for the proposer. */
export async function seedOnTrain(o: { engine: PGLiteEngine; seedText: string; train: readonly MethodTask[]; model: string; meter?: MeterTotals }): Promise<{ arm: ArmScore; trajectories: TrainTrajectory[] }> {
  const seen = new Map<string, TrainTrajectory>();
  const arm = await scoreArm({
    engine: o.engine, skillText: o.seedText, tasks: o.train, model: o.model, runs: 1, meter: o.meter,
    onRollout: (t, r) => seen.set(t.task_id, {
      task_id: t.task_id, task: t.task, answer: t.final_text, correct: r.correct, failed: r.failed.map(renderFailed),
      tool_calls: t.tool_calls.map(c => ({ name: c.name, input: c.input, failed: !!c.failed, pages: c.failed ? [] : pagesOf(c.output) })),
    }),
  });
  const trajectories = o.train.map(t => seen.get(t.task_id) ?? { task_id: t.task_id, task: t.task, answer: null, correct: false, failed: [], tool_calls: [] });
  return { arm, trajectories };
}

export interface Marker { kind: 'slug' | 'value' | 'subject'; pattern: string }

const shownValue = (v: GoldValue) => v.kind === 'number' ? `${v.value}${v.unit === 'percent' ? '%' : v.unit === 'days' ? ' days' : ''}` : v.value;

/**
 * The gold strings of `withheld` tasks (slugs, values, abstention subjects)
 * that the `exposed` tasks do not show themselves, as regex sources: a
 * selection value that is also a train value, or that a train prompt states,
 * is train's to show.
 */
export function forbiddenMarkers(withheld: readonly MethodTask[], exposed: readonly MethodTask[]): Marker[] {
  const shown = exposed.flatMap(t => [t.task, ...t.gold.slugs, ...t.gold.values.map(shownValue), ...(t.gold.subject ? [t.gold.subject] : [])]).join('\n');
  const markers = new Map<string, Marker>();
  for (const t of withheld) {
    for (const slug of t.gold.slugs) markers.set(citationPattern('query', [slug]), { kind: 'slug', pattern: citationPattern('query', [slug]) });
    for (const v of t.gold.values) markers.set(valuePattern(v), { kind: 'value', pattern: valuePattern(v) });
    if (t.gold.subject) markers.set(valuePattern({ kind: 'name', value: t.gold.subject }), { kind: 'subject', pattern: valuePattern({ kind: 'name', value: t.gold.subject }) });
  }
  return [...markers.values()].filter(m => !new RegExp(m.pattern, 'm').test(shown));
}

/** The pages the train split itself shows: its gold pages and any page a train prompt names. */
export const trainPages = (train: readonly MethodTask[]): Set<string> => new Set(train.flatMap(t => [...t.gold.slugs, ...citedSlugs(t.task)]));

/** Slug-shaped tokens (`people/adam-lee-19`, `contracts/x.md`). */
const SLUG_TOKEN = /(?<![\w/.-])[A-Za-z0-9][\w.-]*(?:\/[\w.-]*[\w-])+(?![\w/-])/g;
const slugKey = (token: string) => token.toLowerCase().replace(/\.md$/, '');

/** The markers that occur in a text. */
export const markersIn = (text: string, markers: readonly Marker[]) => markers.filter(m => new RegExp(m.pattern, 'm').test(text));

/**
 * Step 2: the proposer input. A returned page is named only when it is in
 * `pages.visible` (`trainPages`); every forbidden marker, and every slug of
 * `pages.corpus` outside `pages.visible`, is replaced by WITHHELD. Throws if
 * either survives the replacement.
 */
export function proposerInput(o: { seedText: string; criteria: string; trajectories: readonly TrainTrajectory[]; markers: readonly Marker[]; pages: { visible: ReadonlySet<string>; corpus: ReadonlySet<string> } }): { text: string; withheld: number } {
  const passed = o.trajectories.filter(t => t.correct).length;
  const hidden = (slug: string) => o.pages.corpus.has(slugKey(slug)) && !o.pages.visible.has(slugKey(slug));
  const returned = (pages: TrainToolCall['pages']) => {
    const named = pages.filter(p => !hidden(p.slug)).map(p => (p.title ? `${p.slug} (${p.title})` : p.slug));
    const others = pages.length - named.length;
    return [...named, ...(others ? [`${others} other page${others > 1 ? 's' : ''} ${WITHHELD}`] : [])].join(', ');
  };
  const tasks = o.trajectories.map((t, i) => {
    const calls = t.tool_calls.length
      ? t.tool_calls.map(c => `- ${c.name} ${JSON.stringify(c.input ?? {})} returned ${c.failed ? 'an error' : c.pages.length ? returned(c.pages) : 'no pages'}`).join('\n')
      : '(none)';
    return [
      `## Training task ${i + 1}: ${t.correct ? 'passed' : 'failed'}`,
      'Task:', t.task,
      'Tool calls:', calls,
      'Final answer:', t.answer ?? '(none: the rollout errored)',
      `Failed checks: ${t.failed.length ? t.failed.join('; ') : 'none'}`,
    ].join('\n');
  });
  let text = [
    'The current skill (SKILL.md):', '', o.seedText.trim(), '',
    'The success criteria every answer is scored against:', '', o.criteria.trim(), '',
    `How the current skill did on ${o.trajectories.length} training tasks (it passed ${passed}):`, '',
    tasks.join('\n\n'), '',
    'Write the improved SKILL.md now.',
  ].join('\n');
  let withheld = 0;
  text = text.replace(SLUG_TOKEN, s => (hidden(s) ? (withheld++, WITHHELD) : s));
  for (const m of o.markers) text = text.replace(new RegExp(m.pattern, 'gm'), () => { withheld++; return WITHHELD; });
  const left = [...markersIn(text, o.markers).map(m => m.kind), ...[...text.matchAll(SLUG_TOKEN)].filter(m => hidden(m[0])).map(() => 'corpus slug')];
  if (left.length) throw new Error(`proposer input still holds ${left.length} forbidden marker(s) after withholding (${left.join(', ')})`);
  return { text, withheld };
}

export interface ProposedRewrite { text: string | null; cost_usd: number | null; stop_reason: string; error?: string }

const unfence = (s: string) => /^`{3}[a-zA-Z]*\n([\s\S]*?)\n`{3}\s*$/.exec(s.trim())?.[1] ?? s;

/** Step 3: one proposer call for one full SKILL.md. A refusal, an empty or unchanged reply or a reply cut at the cap yields no text. */
export async function proposeRewrite(input: string, seedText: string): Promise<ProposedRewrite> {
  const r = await chat({ model: PROPOSER_MODEL, system: ONE_SHOT_SYSTEM, messages: [{ role: 'user', content: input }], maxTokens: ONE_SHOT_MAX_TOKENS, allowFallback: false });
  const cost_usd = callCostUsd({ model: r.model || PROPOSER_MODEL, ...r.usage });
  const text = unfence(r.text).trim();
  if (r.stopReason !== 'end') return { text: null, cost_usd, stop_reason: r.stopReason, error: `the proposer stopped with ${r.stopReason}` };
  if (!text) return { text: null, cost_usd, stop_reason: r.stopReason, error: 'the proposer returned no text' };
  if (text === seedText.trim()) return { text: null, cost_usd, stop_reason: r.stopReason, error: 'the proposer returned the seed unchanged' };
  return { text: text + '\n', cost_usd, stop_reason: r.stopReason };
}

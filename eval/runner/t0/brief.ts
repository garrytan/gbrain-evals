/**
 * Wave 5 D6: the proactive brief on the T0 carrier (Cat 40 family P).
 *
 * Two arms on the same release: `brief-off` (the release default, nothing set) and `brief-on` (`context.proactive_brief`
 * set to true in the brain's DB config after every restore). Everything else is T0: the snapshot, the two sessions, the
 * native-event delivery contract (t0/delivery.ts) and the scorer (t0/score.ts).
 *
 * This file reads the brief block out of the hook text the reader saw, holds the paid-arm guard, classifies each pushed
 * item against the task's gold, and summarizes the preregistered primary and diagnostics
 * (docs/benchmarks/2026-10-14-proactive-brief-dev-preregistration.md).
 *
 *   bun eval/runner/t0/brief.ts <results.jsonl> [more.jsonl ...] [--out summary.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { generatePersona, PP_BRIEF_V2_DEV_SEEDS, type PPPersona, type PPTask } from '../../generators/program-primary-gen.ts';
import { ratioInterval, riskDifference } from '../power/risk-ratio.ts';
import { matches, scoreAnswer, staleMentions, T0_SCORER_POSTHOC, type T0Score } from './score.ts';
import type { HookResult } from './delivery.ts';

export const BRIEF_ARMS = ['brief-off', 'brief-on'] as const;
export type BriefArm = typeof BRIEF_ARMS[number];
export const PROACTIVE_BRIEF_KEY = 'context.proactive_brief';
/** gbrain's push header (src/core/context/proactive-brief.ts BRIEF_HEADER); the pull header extends it. */
export const BRIEF_HEADER = '## Before you start';
/** Exit-bar limits (plan Wave 5 exit): the attention cap and the false-push ceiling. */
export const BRIEF_MAX_CHARS = 1800;
export const FALSE_PUSH_CEILING = 0.05;
/** A brief-on run whose brief failed to fire in more than this share of cells cannot answer the primary question. */
export const GUARD_MISS_CEILING = 0.1;
export const CONFIDENT_WRONG_KINDS = ['stale_date', 'stale_correction', 'unsupported'] as const;
export const NEEDED_FACTS = ['commitment', 'new_date', 'corrected'] as const;
export type NeededFact = typeof NEEDED_FACTS[number];

export const briefConfig = (arm: string, extra: ReadonlyArray<[string, string]> = []): Array<[string, string]> => (arm === 'brief-on' ? [[PROACTIVE_BRIEF_KEY, 'true'], ...extra] : []);

// ─── D6 v2: conditions where hot memory does not carry the fact ─────

/**
 * v1 (`next-day`): session 2 follows session 1 within hot memory's 24-hour window. v2 (preregistration
 * docs/benchmarks/2026-10-15-proactive-brief-dev-v2-preregistration.md):
 *   aged     session 1's facts are backdated to the world's session-1 day, more than 24 hours before session 2;
 *   crowded  after session 1 the harness saves CROWD_FACTS unrelated facts, newer than session 1's, so they fill hot
 *            memory's fetch (top 10 of the 30 newest).
 */
export type BriefCondition = 'next-day' | 'aged' | 'crowded';
export const CROWD_FACTS = 40;
/** The v2 release (preregistration, "The release under test"): paid v2 cells run only on this commit. */
export const BRIEF_V2_RELEASE: { version: string; commit: string } | null = { version: '0.60.247.0', commit: '47f052af0c7f92f259daa9b1b51bb90370dcf520' };
/** Config pairs brief-on adds in v2 besides the brief switch: none, because the pinned release's page-edit source sits behind the same switch. */
export const BRIEF_V2_EXTRA_CONFIG: ReadonlyArray<[string, string]> = [];
/**
 * The v2 aged condition dates session 1's facts at noon Pacific on the world's session-1 day, or 72 hours before the
 * cell when that is earlier (a run on or before October 17 would otherwise leave them inside hot memory's 24 hours).
 */
export const AGED_FACTS_AT = '2026-10-14T19:00:00.000Z';
export const AGED_MIN_GAP_HOURS = 72;
export const agedFactsAt = (now = Date.now()) => new Date(Math.min(Date.parse(AGED_FACTS_AT), now - AGED_MIN_GAP_HOURS * 3_600_000)).toISOString();

/** v2 seeds split each persona's tasks: its first reply and first prep task are aged, the other two crowded; v1 seeds are next-day. */
export function briefCondition(p: Pick<PPPersona, 'seed' | 'tasks'>, t: Pick<PPTask, 'id'>): BriefCondition {
  if (!PP_BRIEF_V2_DEV_SEEDS.includes(p.seed)) return 'next-day';
  const aged = [p.tasks.find(x => x.kind === 'reply')!.id, p.tasks.find(x => x.kind === 'prep')!.id];
  return aged.includes(t.id) ? 'aged' : 'crowded';
}

const CROWD_TEMPLATES = [
  (n: string) => `${n} prefers async updates over calls.`,
  (n: string) => `${n} asked to be copied on the engineering newsletter.`,
  (n: string) => `${n} is moving their team to a new office building.`,
  (n: string) => `${n} likes short written summaries before any review.`,
  (n: string) => `${n} mentioned their team is hiring a staff engineer.`,
  (n: string) => `${n} recommended a podcast about incident reviews.`,
  (n: string) => `${n} switched their build system to Bazel last quarter.`,
  (n: string) => `${n} would rather get questions by email than chat.`,
  (n: string) => `${n} is presenting at an internal tooling summit.`,
  (n: string) => `${n} said their security team rotates keys monthly.`,
];

/** The crowded condition's unrelated facts: people other than the task's contact and anyone sharing its first name (the namesake), with no number or date. */
export function crowdFacts(p: Pick<PPPersona, 'docs'>, t: Pick<PPTask, 'contact' | 'contact_name'>): Array<{ entity: string; fact: string }> {
  const first = t.contact_name.split(' ')[0];
  const people = p.docs.filter(d => d.id.startsWith('people/') && d.id !== t.contact && !d.title.startsWith(`${first} `));
  return Array.from({ length: CROWD_FACTS }, (_, i) => {
    const person = people[i % people.length];
    return { entity: person.id, fact: CROWD_TEMPLATES[Math.floor(i / people.length) % CROWD_TEMPLATES.length](person.title) };
  });
}

export type SavePath = 'remember' | 'page' | 'none';
/** How session 1 saved what the user said: any `remember` call, else a page write, else nothing. */
export function savePath(toolCalls: ReadonlyArray<{ name: string }>): SavePath {
  if (toolCalls.some(c => c.name === 'remember')) return 'remember';
  if (toolCalls.some(c => c.name === 'put_page' || c.name === 'edit_page')) return 'page';
  return 'none';
}

/** The hot-memory lines in one hook's text (the `## Hot memory (recent facts)` header's list). */
export function hotMemoryText(text: string): string {
  const at = text.indexOf('## Hot memory');
  if (at < 0) return '';
  const lines = text.slice(at).split('\n').slice(1);
  const out: string[] = [];
  for (const l of lines) { if (l.startsWith('- ')) out.push(l); else if (out.length || l.trim()) break; }
  return out.join('\n');
}

export interface BriefBlock { hook: HookResult['event']; text: string; chars: number; items: Array<{ id: string; slug: string | null; text: string }> }

/** The brief block in one hook's injected text: the header line through the last item line, or null. */
export function briefBlock(h: Pick<HookResult, 'event' | 'text'>): BriefBlock | null {
  const at = h.text.indexOf(BRIEF_HEADER);
  if (at < 0) return null;
  const lines = h.text.slice(at).split('\n');
  let end = 1;
  while (end < lines.length && lines[end].trim() !== '') end++;
  const text = lines.slice(0, end).join('\n');
  const items = lines.slice(1, end).filter(l => /^- \[[A-Z][a-z]?\d+\]/.test(l)).map(l => ({
    id: l.match(/^- \[([A-Z][a-z]?\d+)\]/)![1],
    slug: l.match(/→ `([^`]+)`\s*$/)?.[1] ?? null,
    text: l,
  }));
  return { hook: h.event, text, chars: text.length, items };
}

export interface ItemClass { id: string; carries: NeededFact[]; stale: boolean; namesake: boolean; other_counterparty: boolean; false_push: boolean }

/** One pushed item against the task, read from its quoted stored text (the line's own `change:` label is not a change cue): which needed facts it carries, and whether it is a false push (stale, a namesake value, another counterparty, or none of the needed facts). */
export function classifyItem(t: PPTask, item: { id: string; slug: string | null; text: string }): ItemClass {
  const g = t.gold;
  const body = item.text.match(/“([^”]*)”/)?.[1] ?? item.text;
  const carries = NEEDED_FACTS.filter(f => matches(f === 'commitment' ? g.commitment : f === 'new_date' ? g.date.new : g.correction.corrected, body));
  const stale = (staleMentions(g.date.old, body, T0_SCORER_POSTHOC).asserted.length > 0 && !carries.includes('new_date'))
    || (staleMentions(g.correction.stale, body, T0_SCORER_POSTHOC).asserted.length > 0 && !carries.includes('corrected'));
  const namesake = g.namesake.some(m => matches(m, body));
  const other_counterparty = item.slug !== null && item.slug !== t.contact;
  return { id: item.id, carries, stale, namesake, other_counterparty, false_push: stale || namesake || other_counterparty || carries.length === 0 };
}

export interface CellBrief {
  arm: BriefArm;
  config: Array<[string, string]>;
  /** Brief blocks per session (index 0 is session 1), hooks in delivery order. */
  blocks: BriefBlock[][];
  /** Paid-arm guard: brief-on fired in session 2's UserPromptSubmit; brief-off showed no brief anywhere. */
  guard: 'fired' | 'silent' | 'miss' | 'leak';
  s2_items: ItemClass[];
  s2_chars: number;
  /** Needed facts anywhere in session 2's injected context (hot memory included), for opportunity recall of the whole push channel. */
  s2_injected_facts: NeededFact[];
  s2_input_tokens: number;
  s2_tool_calls: number;
  /** v2 fields (absent on v1 cells). */
  condition?: BriefCondition;
  save_path?: SavePath;
  /** Needed facts in session 2's hot-memory lines: the v2 control expects none in the aged and crowded conditions. */
  s2_hot_facts?: NeededFact[];
  /** Session 2 from its first hook to the deliverable (v2 diagnostic). */
  s2_wall_ms?: number;
}

export class BriefGuardError extends Error { override name = 'BriefGuardError'; }

/** The brief record for one cell; throws BriefGuardError when brief-off shows a brief (the arms are not what they claim). */
export function cellBrief(arm: BriefArm, t: PPTask, sessions: ReadonlyArray<{ hooks: HookResult[]; tool_calls: Array<{ name: string }>; wall_ms?: number }>, s2InputTokens: number, condition: BriefCondition = 'next-day'): CellBrief {
  const blocks = sessions.map(s => s.hooks.map(briefBlock).filter((b): b is BriefBlock => b !== null));
  const s2 = blocks[1] ?? [];
  const s2Prompt = s2.find(b => b.hook === 'user-prompt');
  const any = blocks.some(b => b.length > 0);
  if (arm === 'brief-off' && any) throw new BriefGuardError(`${t.id}: brief-off cell received a brief (${blocks.flat().map(b => b.hook).join(', ')}); the arm config leaked`);
  const guard = arm === 'brief-off' ? 'silent' : s2Prompt ? 'fired' : 'miss';
  const injected = (sessions[1]?.hooks ?? []).map(h => h.text).join('\n');
  const g = t.gold;
  const has = (text: string) => NEEDED_FACTS.filter(f => matches(f === 'commitment' ? g.commitment : f === 'new_date' ? g.date.new : g.correction.corrected, text));
  const v2 = condition === 'next-day' ? {} : {
    condition, save_path: savePath(sessions[0]?.tool_calls ?? []),
    s2_hot_facts: has((sessions[1]?.hooks ?? []).map(h => hotMemoryText(h.text)).join('\n')),
    s2_wall_ms: sessions[1]?.wall_ms ?? 0,
  };
  return { ...v2,
    arm, config: briefConfig(arm), blocks, guard,
    s2_items: s2.flatMap(b => b.items).map(i => classifyItem(t, i)),
    s2_chars: s2.reduce((n, b) => n + b.chars, 0),
    s2_injected_facts: has(injected),
    s2_input_tokens: s2InputTokens,
    s2_tool_calls: sessions[1]?.tool_calls.length ?? 0,
  };
}

// ─── Analysis ───────────────────────────────────────────────────────

export interface BriefCell {
  key: string; persona: string; task: string; kind: string; reader: string; arm: string; repeat: number;
  sessions: Array<{ answer: string; stop: string; error?: string; hooks: HookResult[]; tool_calls: unknown[] }>;
  score: T0Score; score_v3?: T0Score; brief?: CellBrief; tokens: { input_total: number }; usd: { total: number };
}

const tasksOf = (personas: Iterable<string>) => new Map([...personas].flatMap(id => generatePersona(Number(id.replace(/^p/, ''))).tasks).map(t => [t.id, t]));
const rate = (num: number, den: number) => (den ? num / den : null);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** The primary scorer's verdict on a stored cell (t0-score-v3; re-scored from the deliverable when the cell predates the field). */
export function primaryScore(c: BriefCell, t: PPTask): T0Score {
  if (c.score_v3) return c.score_v3;
  return scoreAnswer(t, c.sessions[1]?.answer ?? '', { executionError: c.score.kinds.includes('execution_error') ? 'execution error' : null, version: T0_SCORER_POSTHOC });
}

function armStats(cs: BriefCell[], tasks: Map<string, PPTask>) {
  const scores = cs.map(c => primaryScore(c, tasks.get(c.task)!));
  const briefs = cs.map(c => c.brief!).filter(Boolean);
  const items = briefs.flatMap(b => b.s2_items);
  const fired = briefs.filter(b => b.guard === 'fired');
  const briefCarried = briefs.map(b => carriedFacts(b).length);
  return {
    cells: cs.length,
    successes: scores.filter(s => !s.failed).length,
    success_rate: rate(scores.filter(s => !s.failed).length, cs.length),
    complete: scores.filter(s => s.complete).length,
    failure_kinds: Object.fromEntries(['missed_commitment', 'stale_date', 'stale_correction', 'unsupported', 'execution_error'].map(k => [k, scores.filter(s => s.kinds.includes(k as never)).length])),
    confident_wrong: { cells: scores.filter(s => s.kinds.some(k => (CONFIDENT_WRONG_KINDS as readonly string[]).includes(k))).length, rate: rate(scores.filter(s => s.kinds.some(k => (CONFIDENT_WRONG_KINDS as readonly string[]).includes(k))).length, cs.length) },
    guard: { fired: briefs.filter(b => b.guard === 'fired').length, miss: briefs.filter(b => b.guard === 'miss').length, silent: briefs.filter(b => b.guard === 'silent').length },
    brief_chars: { max: Math.max(0, ...briefs.map(b => b.s2_chars)), mean_when_fired: mean(fired.map(b => b.s2_chars)) },
    items: { pushed: items.length, per_fired_session: rate(items.length, fired.length), false_pushes: items.filter(x => x.false_push).length, false_pushes_per_session: rate(items.filter(x => x.false_push).length, briefs.length), sessions_with_false_push: briefs.filter(b => b.s2_items.some(x => x.false_push)).length, stale: items.filter(x => x.stale).length, namesake: items.filter(x => x.namesake).length, other_counterparty: items.filter(x => x.other_counterparty).length },
    opportunity_recall: {
      needed_facts: cs.length * NEEDED_FACTS.length,
      by_brief: rate(briefCarried.reduce((a, b) => a + b, 0), cs.length * NEEDED_FACTS.length),
      by_all_injected_context: rate(briefs.reduce((a, b) => a + b.s2_injected_facts.length, 0), cs.length * NEEDED_FACTS.length),
    },
    per_task: { s2_tool_calls_mean: mean(briefs.map(b => b.s2_tool_calls)), s2_input_tokens_mean: mean(briefs.map(b => b.s2_input_tokens)), cell_input_tokens_mean: mean(cs.map(c => c.tokens.input_total)), usd_mean: mean(cs.map(c => c.usd.total)), usd_sum: cs.reduce((s, c) => s + c.usd.total, 0) },
  };
}

const hit = (s: T0Score, f: NeededFact) => (f === 'commitment' ? s.commitment_hit : f === 'new_date' ? s.new_date_hit : s.corrected_hit);
const carriedFacts = (b: CellBrief) => [...new Set(b.s2_items.filter(x => !x.false_push).flatMap(x => x.carries))];

/** Uptake over fired brief-on cells: the needed facts relevant items carried, how many the deliverable states, and how many the paired brief-off deliverable states (hot memory carries them in both arms). */
function uptake(pairs: Array<{ on: BriefCell; off: BriefCell | undefined; t: PPTask }>) {
  const opp = pairs.filter(p => p.on.brief?.guard === 'fired').flatMap(p => carriedFacts(p.on.brief!).map(f => ({ f, on: primaryScore(p.on, p.t), off: p.off ? primaryScore(p.off, p.t) : null })));
  const inOn = opp.filter(o => hit(o.on, o.f)).length;
  const withOff = opp.filter(o => o.off);
  const inOff = withOff.filter(o => hit(o.off!, o.f)).length;
  return { pushed_facts: opp.length, in_deliverable: inOn, rate: rate(inOn, opp.length), paired_off_in_deliverable: inOff, paired_off_rate: rate(inOff, withOff.length) };
}

/** Paired success difference (brief-on minus brief-off) over task x reader x repeat pairs, persona-clustered 95% interval. */
export function pairedSuccess(pairs: Array<{ persona: string; off: boolean; on: boolean }>) {
  const by = new Map<string, { n: number; baseline: number; candidate: number }>();
  for (const p of pairs) { const x = by.get(p.persona) ?? { n: 0, baseline: 0, candidate: 0 }; x.n++; x.baseline += p.off ? 0 : 1; x.candidate += p.on ? 0 : 1; by.set(p.persona, x); }
  const totals = [...by.values()];
  const n = pairs.length;
  const off = pairs.filter(p => p.off).length;
  const on = pairs.filter(p => p.on).length;
  if (totals.length < 2) return { pairs: n, personas: totals.length, off_successes: off, on_successes: on, delta: n ? (on - off) / n : null, lower: null, upper: null, discordant: { on_only: pairs.filter(p => p.on && !p.off).length, off_only: pairs.filter(p => p.off && !p.on).length } };
  const rd = riskDifference(totals);
  return { pairs: n, personas: totals.length, off_successes: off, on_successes: on, delta: -rd.diff, lower: -rd.upper, upper: -rd.lower, discordant: { on_only: pairs.filter(p => p.on && !p.off).length, off_only: pairs.filter(p => p.off && !p.on).length } };
}

export function summarizeBrief(all: readonly BriefCell[]) {
  const cells = all.filter(c => (BRIEF_ARMS as readonly string[]).includes(c.arm));
  const tasks = tasksOf(new Set(cells.map(c => c.persona)));
  const readers = [...new Set(cells.map(c => c.reader))].sort();
  const byKey = new Map(cells.map(c => [`${c.task}|${c.reader}|${c.repeat}|${c.arm}`, c]));
  const pairsFor = (reader: string | null) => cells.filter(c => c.arm === 'brief-off' && (reader === null || c.reader === reader)).flatMap(off => {
    const on = byKey.get(`${off.task}|${off.reader}|${off.repeat}|brief-on`);
    if (!on) return [];
    const t = tasks.get(off.task)!;
    return [{ persona: off.persona, off: !primaryScore(off, t).failed, on: !primaryScore(on, t).failed }];
  });
  const arms = (cs: BriefCell[]) => Object.fromEntries(BRIEF_ARMS.map(a => [a, armStats(cs.filter(c => c.arm === a), tasks)]));
  const uptakeFor = (reader: string | null) => uptake(cells.filter(c => c.arm === 'brief-on' && (reader === null || c.reader === reader)).map(on => ({ on, off: byKey.get(`${on.task}|${on.reader}|${on.repeat}|brief-off`), t: tasks.get(on.task)! })));
  const pooled = { primary: pairedSuccess(pairsFor(null)), arms: arms(cells), uptake: uptakeFor(null) };
  const on = pooled.arms['brief-on'];
  const offStats = pooled.arms['brief-off'];
  const checks = {
    improvement: pooled.primary.lower !== null && pooled.primary.lower > 0,
    guard_misses_within_ceiling: on.cells > 0 && on.guard.miss / on.cells <= GUARD_MISS_CEILING,
    attention_within_cap: on.brief_chars.max <= BRIEF_MAX_CHARS,
    false_push_within_ceiling: (on.items.false_pushes_per_session ?? 0) <= FALSE_PUSH_CEILING,
    no_confident_wrong_rise: on.confident_wrong.cells <= offStats.confident_wrong.cells,
  };
  const ceilings = readers.filter(r => { const s = armStats(cells.filter(c => c.reader === r && c.arm === 'brief-off'), tasks); return s.cells > 0 && s.successes === s.cells; });
  return {
    scorer: T0_SCORER_POSTHOC, cells: cells.length, readers, ceilings,
    pooled, checks,
    development_signal: Object.values(checks).every(Boolean) ? 'improvement signal (development evidence only)' : 'no improvement signal (development evidence only)',
    by_reader: Object.fromEntries(readers.map(r => [r, { primary: pairedSuccess(pairsFor(r)), arms: arms(cells.filter(c => c.reader === r)), uptake: uptakeFor(r) }])),
    by_kind: Object.fromEntries(['prep', 'reply'].map(k => [k, pairedSuccess(cells.filter(c => c.arm === 'brief-off' && c.kind === k).flatMap(off => { const o = byKey.get(`${off.task}|${off.reader}|${off.repeat}|brief-on`); const t = tasks.get(off.task)!; return o ? [{ persona: off.persona, off: !primaryScore(off, t).failed, on: !primaryScore(o, t).failed }] : []; }))])),
  };
}

/** v2 ceilings: a condition whose hot-memory control fails in more than this share of its cells cannot answer the question. */
export const CONTROL_FAILURE_CEILING = 0.1;
/** v2 primary, part 1 (time saved): pooled brief-on/brief-off session-2 tool calls at most this ratio (20% fewer), its 95% upper bound below 1. */
export const TOOL_CALL_RATIO_MAX = 0.8;
/** v2 primary, part 2 (non-inferiority): the pooled paired success difference's 95% lower bound at or above minus this margin. */
export const NONINFERIORITY_MARGIN = 0.05;

/** Paired ratio of a per-task measure, brief-on total over brief-off total, persona-clustered 95% interval (delta method on the log ratio, t on clusters - 1 df). */
export function pairedRatio(pairs: Array<{ persona: string; off: number; on: number }>) {
  const by = new Map<string, { n: number; baseline: number; candidate: number }>();
  for (const p of pairs) { const x = by.get(p.persona) ?? { n: 0, baseline: 0, candidate: 0 }; x.n++; x.baseline += p.off; x.candidate += p.on; by.set(p.persona, x); }
  const totals = [...by.values()];
  const off = pairs.reduce((a, p) => a + p.off, 0);
  const on = pairs.reduce((a, p) => a + p.on, 0);
  if (!pairs.length || off === 0) return { pairs: pairs.length, personas: totals.length, off_total: off, on_total: on, ratio: null, lower: null, upper: null };
  const r = ratioInterval(totals, 'delta-t');
  return { pairs: pairs.length, personas: totals.length, off_total: off, on_total: on, ratio: on / off, lower: totals.length < 2 ? null : r.lower, upper: totals.length < 2 ? null : r.upper };
}

/** The v2 summary (aged and crowded cells only): the v1 primary and checks, plus conditions, the hot-memory control and firing by save path. */
export function summarizeBriefV2(all: readonly BriefCell[]) {
  const cells = all.filter(c => (BRIEF_ARMS as readonly string[]).includes(c.arm) && (c.brief?.condition === 'aged' || c.brief?.condition === 'crowded'));
  const tasks = tasksOf(new Set(cells.map(c => c.persona)));
  const readers = [...new Set(cells.map(c => c.reader))].sort();
  const byKey = new Map(cells.map(c => [`${c.task}|${c.reader}|${c.repeat}|${c.arm}`, c]));
  const pairs = (keep: (c: BriefCell) => boolean) => cells.filter(c => c.arm === 'brief-off' && keep(c)).flatMap(off => {
    const on = byKey.get(`${off.task}|${off.reader}|${off.repeat}|brief-on`);
    if (!on) return [];
    const t = tasks.get(off.task)!;
    return [{ persona: off.persona, off: !primaryScore(off, t).failed, on: !primaryScore(on, t).failed }];
  });
  const arms = (cs: BriefCell[]) => Object.fromEntries(BRIEF_ARMS.map(a => [a, armStats(cs.filter(c => c.arm === a), tasks)]));
  const uptakeFor = (keep: (c: BriefCell) => boolean) => uptake(cells.filter(c => c.arm === 'brief-on' && keep(c)).map(on => ({ on, off: byKey.get(`${on.task}|${on.reader}|${on.repeat}|brief-off`), t: tasks.get(on.task)! })));
  const measure = (keep: (c: BriefCell) => boolean, m: (b: CellBrief) => number) => pairedRatio(cells.filter(c => c.arm === 'brief-off' && keep(c)).flatMap(off => {
    const on = byKey.get(`${off.task}|${off.reader}|${off.repeat}|brief-on`);
    return on ? [{ persona: off.persona, off: m(off.brief!), on: m(on.brief!) }] : [];
  }));
  const efficiency = (keep: (c: BriefCell) => boolean) => ({
    s2_tool_calls: measure(keep, b => b.s2_tool_calls), s2_input_tokens: measure(keep, b => b.s2_input_tokens), s2_wall_ms: measure(keep, b => b.s2_wall_ms ?? 0),
  });
  const slice = (keep: (c: BriefCell) => boolean) => ({ success: pairedSuccess(pairs(keep)), efficiency: efficiency(keep), arms: arms(cells.filter(keep)), uptake: uptakeFor(keep) });
  const control = Object.fromEntries((['aged', 'crowded'] as const).map(cond => {
    const cs = cells.filter(c => c.brief!.condition === cond);
    const failed = cs.filter(c => (c.brief!.s2_hot_facts ?? []).length > 0);
    return [cond, { cells: cs.length, hot_memory_carried_a_needed_fact: failed.length, brief_off_failures: failed.filter(c => c.arm === 'brief-off').length, valid: cs.length > 0 && failed.length / cs.length <= CONTROL_FAILURE_CEILING }];
  }));
  const on = cells.filter(c => c.arm === 'brief-on');
  const firing = Object.fromEntries((['remember', 'page', 'none'] as const).map(sp => {
    const cs = on.filter(c => c.brief!.save_path === sp);
    return [sp, { cells: cs.length, fired: cs.filter(c => c.brief!.guard === 'fired').length, rate: rate(cs.filter(c => c.brief!.guard === 'fired').length, cs.length) }];
  }));
  const saved = on.filter(c => c.brief!.save_path !== 'none');
  const pooled = slice(() => true);
  const onStats = pooled.arms['brief-on'];
  const tools = pooled.efficiency.s2_tool_calls;
  const tokens = pooled.efficiency.s2_input_tokens;
  const checks = {
    time_saved: tools.ratio !== null && tools.ratio <= TOOL_CALL_RATIO_MAX && tools.upper !== null && tools.upper < 1 && tokens.upper !== null && tokens.upper < 1,
    success_non_inferior: pooled.success.lower !== null && pooled.success.lower >= -NONINFERIORITY_MARGIN,
    hot_memory_control_valid: Object.values(control).every(x => x.valid),
    guard_misses_within_ceiling: saved.length > 0 && saved.filter(c => c.brief!.guard === 'miss').length / saved.length <= GUARD_MISS_CEILING,
    attention_within_cap: onStats.brief_chars.max <= BRIEF_MAX_CHARS,
    false_push_within_ceiling: (onStats.items.false_pushes_per_session ?? 0) <= FALSE_PUSH_CEILING,
    no_confident_wrong_rise: onStats.confident_wrong.cells <= pooled.arms['brief-off'].confident_wrong.cells,
  };
  const ceilings = readers.filter(r => { const x = armStats(cells.filter(c => c.reader === r && c.arm === 'brief-off'), tasks); return x.cells > 0 && x.successes === x.cells; });
  return {
    scorer: T0_SCORER_POSTHOC, design: 'd6-dev-v2', cells: cells.length, readers, ceilings, pooled, checks,
    development_signal: Object.values(checks).every(Boolean) ? 'time-saved signal (development evidence only)' : 'no time-saved signal (development evidence only)',
    success_improvement: pooled.success.lower !== null && pooled.success.lower > 0,
    control, firing_by_save_path: firing,
    guard_saved: { brief_on_cells_with_a_save: saved.length, misses: saved.filter(c => c.brief!.guard === 'miss').length },
    by_condition: Object.fromEntries((['aged', 'crowded'] as const).map(cond => [cond, slice(c => c.brief!.condition === cond)])),
    by_reader: Object.fromEntries(readers.map(r => [r, slice(c => c.reader === r)])),
    by_kind: Object.fromEntries(['prep', 'reply'].map(k => [k, pairedSuccess(pairs(c => c.kind === k))])),
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const outAt = argv.indexOf('--out');
  const out = outAt >= 0 ? argv[outAt + 1] : null;
  const paths = argv.filter((_, i) => outAt < 0 || (i !== outAt && i !== outAt + 1));
  const byKey = new Map<string, BriefCell>();
  for (const p of paths) for (const l of readFileSync(p, 'utf8').split('\n').filter(Boolean)) { const c = JSON.parse(l) as BriefCell; byKey.set(c.key, c); }
  const cells = [...byKey.values()];
  const s = cells.some(c => c.brief?.condition === 'aged' || c.brief?.condition === 'crowded') ? summarizeBriefV2(cells) : summarizeBrief(cells);
  const text = JSON.stringify(s, null, 2) + '\n';
  if (out) writeFileSync(out, text);
  else process.stdout.write(text);
}

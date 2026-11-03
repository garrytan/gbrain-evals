/**
 * Tool calls of SkillOpt ceiling-attempt rollouts (GBEV-30, plan section 4):
 * what each rollout called, which calls gbrain refused and why, and how each
 * rollout stopped.
 *
 * Every rollout row keeps its tool calls as `ToolCallRecord`s: the tool name,
 * the arguments the model sent, and a failed call's error text (never page
 * text). Refusals are classified by gbrain's own messages at the pin
 * `311a83bb` (v0.60.553.0):
 *
 *   multi-window-selector       get_page "pass one window selector, not N"
 *   known-as-of-with-read-view  get_page "known_as_of does not combine with"
 *   hop-chain-with-depth        traverse_graph "hops cannot be combined with"
 *   other                       any other failed call
 *
 * At `a131fb20` (v0.60.549.0) gbrain refused the calls of the first class
 * with "context applies to grep" instead, which reads `other` here.
 *
 * A decisive read is a get_page or traverse_graph call on a page that decides
 * the task: a gold page, or for an abstention task one of its near-miss pages.
 * A refused decisive read limits the rollout only when no call that serves
 * the page succeeds anywhere in the rollout: a get_page of it clears either
 * tool's refusal, and a traverse_graph from it clears only a refused
 * traverse_graph, since its nodes carry no page body. In the
 * refusal tally, a refused call is recovered when the next call to the same
 * tool succeeds.
 * Stop reasons are counted per arm as completed, turn limit (gbrain's 20-turn
 * `max_turns`), output length (`length`) or other.
 */
import { pagesOf } from './one-shot.ts';
import type { Trajectory } from './score.ts';

export interface ToolCallRecord {
  name: string;
  /** The arguments as the model sent them. */
  input: unknown;
  /** A failed call's error text. */
  error?: string;
  /** The pages a successful call returned, by slug and title only (what the one-shot proposer input names). */
  pages?: Array<{ slug: string; title: string }>;
}

/** A rollout's tool calls as rows keep them. */
export function toolCallRecords(t: Pick<Trajectory, 'tool_calls'>): ToolCallRecord[] {
  return t.tool_calls.map(c => {
    if (!c.failed) return { name: c.name, input: c.input, pages: pagesOf(c.output) };
    const out = c.output as { error?: unknown } | undefined;
    return { name: c.name, input: c.input, error: typeof out?.error === 'string' ? out.error : JSON.stringify(c.output ?? null) };
  });
}

export const REFUSAL_CLASSES = ['multi-window-selector', 'known-as-of-with-read-view', 'hop-chain-with-depth', 'other'] as const;
export type RefusalClass = typeof REFUSAL_CLASSES[number];

const RULES: ReadonlyArray<{ cls: Exclude<RefusalClass, 'other'>; tool: string; text: string }> = [
  { cls: 'multi-window-selector', tool: 'get_page', text: 'get_page: pass one window selector' },
  { cls: 'known-as-of-with-read-view', tool: 'get_page', text: 'get_page: known_as_of does not combine with' },
  { cls: 'hop-chain-with-depth', tool: 'traverse_graph', text: 'traverse_graph: hops cannot be combined with' },
];

/** A failed call's refusal class; null for a call that succeeded. */
export function refusalClass(call: ToolCallRecord): RefusalClass | null {
  if (call.error === undefined) return null;
  return RULES.find(r => r.tool === call.name && call.error!.includes(r.text))?.cls ?? 'other';
}

export const DECISIVE_TOOLS: ReadonlySet<string> = new Set(['get_page', 'traverse_graph']);

/** The pages whose read decides a task: its gold pages, or for an abstention task its near-miss pages. */
export const decisivePages = (task: { answerable: boolean; gold: { slugs: readonly string[] }; near_miss?: readonly string[] }): string[] =>
  task.answerable ? [...task.gold.slugs] : [...(task.near_miss ?? [])];

const slugOf = (input: unknown): string | null => {
  const slug = input && typeof input === 'object' ? (input as { slug?: unknown }).slug : undefined;
  return typeof slug === 'string' ? slug.toLowerCase().replace(/\.md$/, '') : null;
};

/**
 * The refused get_page and traverse_graph calls on a decisive page that no
 * successful call in the rollout served: a get_page of the page clears either,
 * and a traverse_graph from it clears only a refused traverse_graph, since its
 * nodes carry no page body.
 */
export function refusedDecisiveReads(calls: readonly ToolCallRecord[], decisive: readonly string[]): ToolCallRecord[] {
  const pages = new Set(decisive.map(s => s.toLowerCase()));
  const isRead = (c: ToolCallRecord, page: string) => DECISIVE_TOOLS.has(c.name) && slugOf(c.input) === page;
  return calls.filter(c => {
    const page = slugOf(c.input);
    return c.error !== undefined && page !== null && pages.has(page) && isRead(c, page)
      && !calls.some(n => n.error === undefined && isRead(n, page) && (n.name === 'get_page' || c.name === 'traverse_graph'));
  });
}

/** Whether the refused call at `i` was recovered: the next call to the same tool succeeds. Null when no later call to that tool came. */
export function recovered(calls: readonly ToolCallRecord[], i: number): boolean | null {
  const next = calls.slice(i + 1).find(c => c.name === calls[i]!.name);
  return next ? next.error === undefined : null;
}

export interface RefusalTally {
  calls: number;
  /** Calls that succeeded. */
  read: number;
  refused: Record<RefusalClass, number>;
  /** Refused calls whose next call to the same tool succeeded. */
  recovered: Record<RefusalClass, number>;
  /** Refused calls with no later call to the same tool. */
  abandoned: Record<RefusalClass, number>;
  /** Refused calls per tool. */
  by_tool: Record<string, number>;
}

const zeroes = () => Object.fromEntries(REFUSAL_CLASSES.map(c => [c, 0])) as Record<RefusalClass, number>;

/** Every call of `rollouts` tallied by refusal class, with recoveries. */
export function tallyRefusals(rollouts: ReadonlyArray<readonly ToolCallRecord[]>): RefusalTally {
  const t: RefusalTally = { calls: 0, read: 0, refused: zeroes(), recovered: zeroes(), abandoned: zeroes(), by_tool: {} };
  for (const calls of rollouts) {
    calls.forEach((c, i) => {
      t.calls++;
      const cls = refusalClass(c);
      if (!cls) { t.read++; return; }
      t.refused[cls]++;
      t.by_tool[c.name] = (t.by_tool[c.name] ?? 0) + 1;
      const r = recovered(calls, i);
      if (r) t.recovered[cls]++;
      else if (r === null) t.abandoned[cls]++;
    });
  }
  return t;
}

export const STOP_CLASSES = ['completed', 'turn-limit', 'output-length', 'other'] as const;
export type StopClass = typeof STOP_CLASSES[number];

/** gbrain's tool-loop stop reason as a stop class: `end` completed, `max_turns` the turn limit, `length` the output limit. */
export const stopClass = (reason: string | null | undefined): StopClass =>
  reason === 'end' ? 'completed' : reason === 'max_turns' ? 'turn-limit' : reason === 'length' ? 'output-length' : 'other';

export function countStops(reasons: ReadonlyArray<string | null | undefined>): Record<StopClass, number> {
  const out = Object.fromEntries(STOP_CLASSES.map(c => [c, 0])) as Record<StopClass, number>;
  for (const r of reasons) out[stopClass(r)]++;
  return out;
}

export type HarnessLimit = 'turn-limit' | 'output-length' | 'refused-decisive-read';

/**
 * What limited a rollout, if the harness did: a turn-limit stop, an
 * output-length stop, or a decisive read refused and never served in the
 * rollout. Null when it completed and gbrain served every decisive read it
 * asked for.
 */
export function harnessLimit(r: { stop_reason?: string | null; tool_calls?: readonly ToolCallRecord[] }, decisive: readonly string[]): HarnessLimit | null {
  const stop = stopClass(r.stop_reason);
  if (stop === 'turn-limit' || stop === 'output-length') return stop;
  return refusedDecisiveReads(r.tool_calls ?? [], decisive).length ? 'refused-decisive-read' : null;
}

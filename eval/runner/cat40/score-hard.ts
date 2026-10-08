/**
 * Cat 40 Hard scoring. Implements the scorer contract in
 * eval/generators/hard/schema.ts (HardScore) for any world that satisfies it.
 *
 * `score.ts` is not modified (its hash is pinned by the entity-recall
 * preregistration); its helpers are imported unchanged. Before calling them,
 * the Hard answer decoder coerces `answer` to a string, checks the whole
 * answer (not only its head) for wrong values, and parses set and count
 * answers, classifying an unreadable one as `unparseable_set`.
 */
import type { AgentRun } from './loop.ts';
import { normalizeValue, valueVerdict, submittedSources } from './score.ts';
import { normalizeDocRef } from './arms.ts';
import { RECORDED, type HardScore, type HardTask, type HardWorld } from '../../generators/hard/schema.ts';

/** Version of the Hard scoring rules; recorded with every run and part of the freeze. */
export const HARD_SCORER_VERSION = 'cat40-hard-score-v2';

/** Coercion rule 1: arrays become their JSON string, other non-strings `String(x)`, null or missing ''. */
export function coerceAnswer(answer: unknown): string {
  if (answer === null || answer === undefined) return '';
  if (Array.isArray(answer)) return JSON.stringify(answer);
  if (typeof answer === 'string') return answer;
  if (typeof answer === 'object') return JSON.stringify(answer);
  return String(answer);
}

function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Whole-word occurrence of a value anywhere in the answer, after normalizeValue on both (the rule score.ts uses on the head). */
export function mentions(answer: string, value: string): boolean {
  const n = normalizeValue(value);
  if (!n) return false;
  return new RegExp(`(^|[^a-z0-9.])${escapeRe(n)}($|[^a-z0-9]|\\.(?!\\d))`).test(normalizeValue(answer));
}

/** Parse a set answer: a JSON array of strings, directly or inside surrounding text. Null when unreadable. `numbers` also accepts numbers (as strings), for `values` answers. */
export function parseSet(answer: string, numbers = false): string[] | null {
  const tryParse = (s: string): string[] | null => {
    try {
      const v = JSON.parse(s);
      if (Array.isArray(v) && v.every(x => typeof x === 'string' || (numbers && typeof x === 'number'))) return v.map(String);
      if (typeof v === 'string' && v.trim().startsWith('[')) return tryParse(v.trim());
    } catch { /* not JSON */ }
    return null;
  };
  const t = answer.trim();
  const direct = tryParse(t);
  if (direct) return direct;
  const i = t.indexOf('['), j = t.lastIndexOf(']');
  return i >= 0 && j > i ? tryParse(t.slice(i, j + 1)) : null;
}

/** Count rule: the integer at the very start of the answer. */
export function parseCount(answer: string): number | null {
  const m = answer.trim().match(/^(\d[\d,]*)(?![\d\-/:]|[.,]\d)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isSafeInteger(n) ? n : null;
}

/** Name → entity id over every name in the world plus the task's member names (exact normalized equality, never substring). */
export function nameIndex(world: Pick<HardWorld, 'entities'>, task: HardTask): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of world.entities) for (const n of [e.name, ...e.aliases]) m.set(normalizeValue(n), e.id);
  for (const mem of task.gold.members ?? []) for (const n of mem.names) m.set(normalizeValue(n), mem.id);
  return m;
}

export interface SetVerdict { correct: boolean; unparseable: boolean; precision: number; recall: number; jaccard: number; got: number; expected: number; unmatched: number }

export function setVerdict(world: Pick<HardWorld, 'entities'>, task: HardTask, answer: string): SetVerdict {
  const expected = new Set((task.gold.members ?? []).map(m => m.id));
  const parsed = parseSet(answer);
  if (!parsed) return { correct: false, unparseable: true, precision: 0, recall: 0, jaccard: 0, got: 0, expected: expected.size, unmatched: 0 };
  const idx = nameIndex(world, task);
  const got = new Set<string>();
  let unmatched = 0;
  for (const el of parsed) {
    const id = idx.get(normalizeValue(el));
    if (id) got.add(id); else unmatched++;
  }
  const hit = [...got].filter(id => expected.has(id)).length;
  const gotSize = got.size + unmatched;
  const union = expected.size + gotSize - hit;
  return {
    correct: unmatched === 0 && hit === expected.size && got.size === expected.size, unparseable: false,
    precision: gotSize ? hit / gotSize : (expected.size ? 0 : 1), recall: expected.size ? hit / expected.size : 1, jaccard: union ? hit / union : 1,
    got: gotSize, expected: expected.size, unmatched,
  };
}

type Final = Pick<AgentRun, 'final' | 'stop'> & { text?: string };

/**
 * Score one Hard cell. `runs` are the cell's sessions in order; the last is
 * the scored question (H5 sessions before it must submit RECORDED).
 * `wrote` is computed by the caller (it needs the arm's write tools).
 */
export function scoreHardTask(world: Pick<HardWorld, 'entities'>, task: HardTask, runs: Final[], extra: { wrote?: boolean } = {}): HardScore {
  const last = runs.at(-1)!;
  const f = last.final;
  const answer = coerceAnswer((f as { answer?: unknown } | null)?.answer);
  const sources = submittedSources(f);
  const evidence = task.gold.evidence.map(normalizeDocRef);
  const base = {
    submitted: last.stop === 'submitted', evidence_cited: evidence.filter(e => sources.includes(e)), missed_evidence: evidence.filter(e => !sources.includes(e)),
    wrote: Boolean(extra.wrote),
    ...(runs.length > 1 ? { recorded: runs.slice(0, -1).map(r => normalizeValue(coerceAnswer((r.final as { answer?: unknown } | null)?.answer)).replace(/[^a-z]/g, '') === RECORDED.toLowerCase()) } : {}),
  };
  if (task.answer_kind === 'set') {
    const v = setVerdict(world, task, answer);
    return { ...base, success: v.correct, said_wrong: false, unparseable_set: v.unparseable, set: { precision: v.precision, recall: v.recall, jaccard: v.jaccard, got: v.got, expected: v.expected, unmatched: v.unmatched } };
  }
  if (task.answer_kind === 'count') {
    const n = parseCount(answer);
    return { ...base, success: n !== null && n === task.gold.count, said_wrong: false, unparseable_set: n === null, count_read: n };
  }
  if (task.answer_kind === 'values') {
    const items = task.gold.items ?? [];
    const parsed = parseSet(answer, true);
    const verdicts = parsed && parsed.length === items.length ? items.map((it, n) => valueItem(parsed[n], it.answer, it.wrong)) : [];
    return { ...base, success: verdicts.length === items.length && verdicts.every(v => v.correct), said_wrong: verdicts.some(v => v.said_wrong), unparseable_set: !parsed, items: { correct: verdicts.filter(v => v.correct).length, expected: items.length } };
  }
  const v = valueItem(answer, task.gold.answer ?? [], task.gold.wrong ?? []);
  return { ...base, success: v.correct, said_wrong: v.said_wrong, unparseable_set: false };
}

/** Value rule: the head names an accepted value and the whole answer names no wrong value. */
function valueItem(answer: string, accepted: string[], wrong: string[]): { correct: boolean; said_wrong: boolean } {
  const said_wrong = wrong.some(w => mentions(answer, w));
  const head = valueVerdict(answer, accepted, wrong);
  return { correct: head.correct && !said_wrong, said_wrong: said_wrong || head.said_wrong };
}

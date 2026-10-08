/**
 * One renderer and one deterministic packer for every system's evidence
 * (plan contract 2; engineering reviews C2, C4, C5).
 *
 * Validation: every item's source ids must be sources this namespace
 * ingested; any other id rejects the whole retrieval as a product error.
 *
 * Strict recall: the distinct sources in first-appearance order across items
 * in rank order, taken whole item by item until the next item's new sources
 * would pass the cutoff K. An item citing more sources than the cutoff ends
 * the count, so one item citing every session cannot score 1.0. For one
 * source per item (gbrain pages) this equals the legacy definition, distinct
 * sessions in rank order cut at K. Items with unavailable provenance cite
 * nothing; a row whose items all lack provenance is "not measurable".
 *
 * Packing: one reader-independent budget unit (`TOKENIZER`, 4 characters per
 * token, the unit the legacy packer already uses), recorded in every row.
 * Selection is in rank order; the first item (or session) that does not fit
 * ends the pack, never split. Two context modes:
 *   native      the item text the system returned, in rank order (or, for a
 *               system whose capability record says `presentation:
 *               event-time`, the selected items in event-time order), with any
 *               validity window printed and superseded facts marked;
 *   rehydrated  the raw sessions behind the items' source ids, first
 *               appearance order for selection, date order for presentation
 *               (the legacy LongMemEval reading prompt, byte for byte).
 */
import type { MemoryQuestion, Session } from '../memory-qa/corpus.ts';
import { READER_TEMPLATE, approxTokens, renderHistory } from '../memory-qa/qa.ts';
import { SystemError, type Item } from './types.ts';

export const TOKENIZER = { id: 'approx-chars-div-4', count: approxTokens } as const;
export const RENDERER_VERSION = 'shootout-render-v1';
export type ContextMode = 'native' | 'rehydrated';

export const NATIVE_READER_TEMPLATE = 'I will give you items a memory system returned from past chats between you and a user, in the order the memory system ranked them. Some items carry the dates the memory system recorded for them; an item marked superseded was later replaced. Please answer the question based on these items. Answer the question step by step: first extract all the relevant information, and then reason over the information to get the answer.\n\n\nMemory Items:\n\n{items}\n\nCurrent Date: {date}\nQuestion: {question}\nAnswer (step by step):';

/** Throws a product error naming the count of foreign ids (never the ids themselves, which may be raw dataset ids). */
export function validateSources(items: readonly Item[], ingested: ReadonlySet<string>): void {
  const foreign = items.flatMap(i => i.source_ids.filter(s => !ingested.has(s)));
  if (foreign.length) throw new SystemError('product_error', `${foreign.length} returned source id(s) were never ingested into this namespace`);
  const ranks = items.map(i => i.rank);
  if (ranks.some((r, k) => k > 0 && r <= ranks[k - 1])) throw new SystemError('product_error', 'items are not in strictly increasing rank order');
}

export function renderItem(item: Item): string {
  const window = item.valid_from || item.valid_to ? ` [valid ${item.valid_from?.slice(0, 10) ?? 'unknown'} to ${item.valid_to?.slice(0, 10) ?? 'present'}]` : '';
  return `- (${item.rank}, ${item.type}${item.valid_to ? ', superseded' : ''})${window} ${item.text.replace(/\s+/g, ' ').trim()}`;
}

export interface Recall { sources: string[]; measurable: boolean; fanout_mean: number; fanout_max: number }

/** Distinct sources, first appearance, whole items, cut at `k` (see header). */
export function strictSources(items: readonly Item[], k: number): Recall {
  const cited = items.filter(i => i.provenance_status !== 'unavailable');
  const seen: string[] = [];
  for (const item of cited) {
    const fresh = [...new Set(item.source_ids)].filter(s => !seen.includes(s));
    if (seen.length + fresh.length > k) break;
    seen.push(...fresh);
  }
  const fan = cited.map(i => new Set(i.source_ids).size);
  return { sources: seen, measurable: cited.length > 0 || items.length === 0, fanout_mean: fan.length ? fan.reduce((a, b) => a + b, 0) / fan.length : 0, fanout_max: fan.length ? Math.max(...fan) : 0 };
}

export interface PackedContext {
  mode: ContextMode;
  tokenizer: string;
  renderer: string;
  budget_tokens: number | null;
  tokens: number;
  item_ids: string[];
  source_ids: string[];
  /** The exact reader prompt; frontier readers replay these bytes unchanged. */
  prompt: string;
}

/** Native mode: item text in rank order, whole items, until the budget or `maxItems`. */
export function packNative(items: readonly Item[], budgetTokens: number | null, maxItems: number | null = null): { lines: string[]; items: Item[]; tokens: number } {
  const out: Item[] = [];
  const lines: string[] = [];
  let tokens = 0;
  for (const item of maxItems === null ? items : items.slice(0, maxItems)) {
    const line = renderItem(item);
    const t = TOKENIZER.count(line + '\n');
    if (budgetTokens !== null && tokens + t > budgetTokens) break;
    out.push(item); lines.push(line); tokens += t;
  }
  return { lines, items: out, tokens };
}

/** Rehydrated mode: sessions behind the items' sources in first-appearance order, whole sessions, until the budget or `maxSessions`. */
export function packRehydrated(items: readonly Item[], sessionOf: (sourceId: string) => Session | undefined, budgetTokens: number | null, maxSessions: number | null = null): { sessions: Session[]; source_ids: string[]; tokens: number } {
  const order: string[] = [];
  for (const i of items) if (i.provenance_status !== 'unavailable') for (const s of i.source_ids) if (!order.includes(s)) order.push(s);
  const sessions: Session[] = [];
  const used: string[] = [];
  let tokens = 0;
  for (const src of maxSessions === null ? order : order.slice(0, maxSessions)) {
    const s = sessionOf(src);
    if (!s) continue;
    const t = TOKENIZER.count(renderHistory([s]));
    if (budgetTokens !== null && tokens + t > budgetTokens) break;
    sessions.push(s); used.push(src); tokens += t;
  }
  return { sessions, source_ids: used, tokens };
}

/** The reader prompt for one question in one context mode; the date falls back to the conversation's last session date. */
export function packContext(mode: ContextMode, q: MemoryQuestion, items: readonly Item[], opts: { budgetTokens: number | null; maxUnits?: number | null; sessionOf: (sourceId: string) => Session | undefined; fallbackDate?: string; present?: 'rank' | 'event-time' }): PackedContext {
  const date = q.question_date ?? opts.fallbackDate ?? 'unknown';
  const base = { mode, tokenizer: TOKENIZER.id, renderer: RENDERER_VERSION, budget_tokens: opts.budgetTokens };
  if (mode === 'native') {
    const p = packNative(items, opts.budgetTokens, opts.maxUnits ?? null);
    const lines = opts.present === 'event-time'
      ? p.items.map((item, k) => ({ item, line: p.lines[k], k })).sort((x, y) => (x.item.valid_from ?? '') === (y.item.valid_from ?? '') ? y.k - x.k : (x.item.valid_from ?? '') < (y.item.valid_from ?? '') ? -1 : 1).map(x => x.line)
      : p.lines;
    const prompt = NATIVE_READER_TEMPLATE.replace('{items}', lines.join('\n') || '(none)').replace('{date}', date).replace('{question}', q.question);
    return { ...base, tokens: p.tokens, item_ids: p.items.map(i => i.id), source_ids: [...new Set(p.items.flatMap(i => i.source_ids))], prompt };
  }
  const p = packRehydrated(items, opts.sessionOf, opts.budgetTokens, opts.maxUnits ?? null);
  const prompt = READER_TEMPLATE.replace('{history}', renderHistory(p.sessions)).replace('{date}', date).replace('{question}', q.question);
  return { ...base, tokens: p.tokens, item_ids: items.filter(i => i.source_ids.some(s => p.source_ids.includes(s))).map(i => i.id), source_ids: p.source_ids, prompt };
}

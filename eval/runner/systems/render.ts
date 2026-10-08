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
import { isoSessionDate, type MemoryQuestion, type Session, type Turn } from '../memory-qa/corpus.ts';
import { READER_TEMPLATE, approxTokens, renderHistory } from '../memory-qa/qa.ts';
import { SystemError, type Item } from './types.ts';

export const TOKENIZER = { id: 'approx-chars-div-4', count: approxTokens } as const;
export const RENDERER_VERSION = 'shootout-render-v1';
export type ContextMode = 'native' | 'rehydrated';
/** Renderers a named recipe can use (budgeted delivery plan C0); `native` and `rehydrated` are the shootout's. */
export type RecipeRender = 'native' | 'native-dated' | 'pseudo-session' | 'rehydrated';
export const DATED_RENDERER_VERSION = 'budgeted-delivery-render-v1';

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

// ─── Budgeted delivery recipes (docs/plans/2026-10-08-gbrain-budgeted-delivery/PLAN.md, C0) ───

/**
 * The C1 date header: one line at the start of the item text, built from the
 * session table's date (ISO day), followed by a blank line. Preregistered
 * bytes; gbrain's C1 PR must produce the same string for the same date.
 */
export const C1_HEADER_PREFIX = 'Conversation date: ';
export const c1Header = (isoDay: string) => `${C1_HEADER_PREFIX}${isoDay}\n\n`;
const HEADER_RE = /^Conversation date: (\d{4}-\d{2}-\d{2})\n\n/;

/** The ISO day of a raw session date, or null for an undated session (never an invented date). */
export const sessionDay = (raw: string | undefined): string | null => isoSessionDate(raw)?.slice(0, 10) ?? null;

/** One date channel: the header in the text, `valid_from` unset, no title prefix. An undated or empty item gets no header. */
export function datedItems(items: readonly Item[], dayOf: (sourceId: string) => string | null): Item[] {
  return items.map(i => {
    const day = i.source_ids.length === 1 ? dayOf(i.source_ids[0]) : null;
    return { ...i, valid_from: null, event_date: day, text: day && i.text.length ? c1Header(day) + i.text : i.text };
  });
}

/** gbrain's omission marker inside delivered blocks (EVIDENCE_OMISSION, evidence-delivery.ts). */
export const EVIDENCE_OMISSION = '\n\n[…]\n\n';
const TURN_RE = /(?:^|\n)\*\*([^*\n]+):\*\* /g;

/**
 * Rebuild one delivered block's turns (the pseudo-session parser):
 *   - a turn starts at `**<speaker>:** ` at a line start (corpus.ts page layout);
 *   - gbrain's omission marker becomes an explicit omission turn;
 *   - text before the first marker (a cut leading fragment) stays under the
 *     preceding speaker in the block, or `unknown` when there is none;
 *   - a leading C1 header is consumed and returned as `headerDay`.
 * Only delivered text is used; no raw source turn is ever read.
 */
export function parseBlockTurns(text: string): { turns: Turn[]; headerDay: string | null } {
  let body = text;
  const h = HEADER_RE.exec(body);
  const headerDay = h ? h[1] : null;
  if (h) body = body.slice(h[0].length);
  const turns: Turn[] = [];
  let lastSpeaker: string | null = null;
  const segments = body.split(EVIDENCE_OMISSION);
  segments.forEach((seg, k) => {
    if (k > 0) turns.push({ speaker: 'omitted', content: '[…]' });
    const marks = [...seg.matchAll(TURN_RE)];
    const firstAt = marks.length ? marks[0].index! + (seg[marks[0].index!] === '\n' ? 1 : 0) : seg.length;
    const lead = seg.slice(0, firstAt).trim();
    if (lead) turns.push({ speaker: lastSpeaker ?? 'unknown', content: lead });
    marks.forEach((m, j) => {
      const start = m.index! + m[0].length;
      const end = j + 1 < marks.length ? marks[j + 1].index! : seg.length;
      lastSpeaker = m[1];
      turns.push({ speaker: m[1], content: seg.slice(start, end).trim() });
    });
  });
  return { turns, headerDay };
}

/**
 * Pseudo-sessions: each delivered block becomes one session with the session
 * table's date (raw, as the rehydrated arm prints it; `unknown` when undated)
 * and its parsed turns. A consumed header must equal the table's ISO day,
 * else the context is harness-invalid. Two blocks from one session stay two
 * pseudo-sessions with the same date.
 */
export function pseudoSessions(items: readonly Item[], sessionOf: (sourceId: string) => Session | undefined): Array<{ item: Item; session: Session }> {
  return items.map(item => {
    const src = item.source_ids[0];
    const table = src ? sessionOf(src) : undefined;
    const { turns, headerDay } = parseBlockTurns(item.text);
    const day = sessionDay(table?.date);
    if (headerDay !== null && headerDay !== day) throw new SystemError('invalid_request', `pseudo-session header date ${headerDay} differs from the session table (${day ?? 'undated'})`);
    return { item, session: { id: item.id, ...(table?.date ? { date: table.date } : {}), turns } };
  });
}

/** Pack pseudo-sessions in rank order, whole blocks, counting the exact serialized history (date order, numbering, JSON escaping, separators). */
export function packPseudo(items: readonly Item[], sessionOf: (sourceId: string) => Session | undefined, budgetTokens: number | null): { sessions: Session[]; items: Item[]; tokens: number; tokens_before: number } {
  const all = pseudoSessions(items, sessionOf);
  const chosen: typeof all = [];
  let tokens = 0;
  for (const x of all) {
    const t = TOKENIZER.count(renderHistory([...chosen, x].map(c => c.session)));
    if (budgetTokens !== null && t > budgetTokens) break;
    chosen.push(x); tokens = t;
  }
  return { sessions: chosen.map(c => c.session), items: chosen.map(c => c.item), tokens, tokens_before: TOKENIZER.count(renderHistory(all.map(c => c.session))) };
}

/** Delivered blocks as items in delivery order (a page block is a `page` item, every other unit a `chunk`). */
export function blocksToItems(blocks: ReadonlyArray<{ rank: number; slug: string; text: string; unit: string; chunk_ids: number[] }>, sourceOf: (slug: string) => string | null): Item[] {
  return blocks.map((b, i) => {
    const src = sourceOf(b.slug);
    return { id: `${b.slug}#d${i + 1}`, rank: i + 1, type: b.unit === 'page' ? 'page' : 'chunk', text: b.text, source_ids: src ? [src] : [], valid_from: null, valid_to: null, provenance_status: src ? 'exact' : 'unavailable' };
  });
}

export interface RecipeContext extends PackedContext {
  render: RecipeRender;
  tokens_before: number;
  items_cut: number;
  dated_items: number;
}

/** The reader prompt for one recipe render over already chosen items (dated renders get the header from the session table). */
export function packRecipe(render: RecipeRender, q: MemoryQuestion, items: readonly Item[], opts: { budgetTokens: number | null; sessionOf: (sourceId: string) => Session | undefined; fallbackDate?: string }): RecipeContext {
  const date = q.question_date ?? opts.fallbackDate ?? 'unknown';
  const dayOf = (src: string) => sessionDay(opts.sessionOf(src)?.date);
  const base = { mode: (render === 'rehydrated' ? 'rehydrated' : 'native') as ContextMode, render, tokenizer: TOKENIZER.id, renderer: render === 'native' || render === 'rehydrated' ? RENDERER_VERSION : DATED_RENDERER_VERSION, budget_tokens: opts.budgetTokens };
  if (render === 'native' || render === 'native-dated') {
    const shown = render === 'native-dated' ? datedItems(items, dayOf) : [...items];
    const p = packNative(shown, opts.budgetTokens);
    const before = shown.reduce((n, i) => n + TOKENIZER.count(renderItem(i) + '\n'), 0);
    const prompt = NATIVE_READER_TEMPLATE.replace('{items}', p.lines.join('\n') || '(none)').replace('{date}', date).replace('{question}', q.question);
    return { ...base, tokens: p.tokens, tokens_before: before, items_cut: shown.length - p.items.length, dated_items: p.items.filter(i => i.event_date).length,
      item_ids: p.items.map(i => i.id), source_ids: [...new Set(p.items.flatMap(i => i.source_ids))], prompt };
  }
  if (render === 'pseudo-session') {
    const p = packPseudo(datedItems(items, dayOf), opts.sessionOf, opts.budgetTokens);
    const prompt = READER_TEMPLATE.replace('{history}', renderHistory(p.sessions)).replace('{date}', date).replace('{question}', q.question);
    return { ...base, tokens: p.tokens, tokens_before: p.tokens_before, items_cut: items.length - p.items.length, dated_items: p.sessions.filter(s => s.date).length,
      item_ids: p.items.map(i => i.id), source_ids: [...new Set(p.items.flatMap(i => i.source_ids))], prompt };
  }
  const p = packRehydrated(items, opts.sessionOf, opts.budgetTokens);
  const all = packRehydrated(items, opts.sessionOf, null);
  const prompt = READER_TEMPLATE.replace('{history}', renderHistory(p.sessions)).replace('{date}', date).replace('{question}', q.question);
  return { ...base, tokens: p.tokens, tokens_before: all.tokens, items_cut: all.source_ids.length - p.source_ids.length, dated_items: p.sessions.filter(s => s.date).length,
    item_ids: items.filter(i => i.source_ids.some(s => p.source_ids.includes(s))).map(i => i.id), source_ids: p.source_ids, prompt };
}

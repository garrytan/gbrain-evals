/**
 * One renderer and one deterministic packer for every system's evidence
 * (plan contract 2; engineering reviews C2, C4, C5; Q1 packing contract,
 * PLAN §4.8.7).
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
 * Rendering (v2): an item whose text is one line prints on its header line,
 * exactly as v1 did; an item with several lines keeps them, one indented
 * body line per non-empty source line, so a cut can land on a turn or line
 * boundary.
 *
 * Packing (v2): items in rank order fill one byte string, the items block,
 * until the budget. The budget unit is a `PackCounter`:
 *   - `TOKENIZER` (the default): 4 characters per token, reader-independent;
 *   - `readerCounter(readers)`: local `cl100k_base` and `o200k_base` counts,
 *     each reader's encoding times its calibration factor
 *     (`READER_TOKENIZERS`), and the block is full when the largest reader
 *     count reaches the budget. Every reader reads the same bytes; every
 *     reader's count is stored.
 * The first item that does not fit whole is cut and packing stops (it never
 * skips to a smaller lower-ranked item, which would reorder evidence). The
 * cut keeps the longest prefix ending at a boundary of the coarsest unit
 * that leaves something: a turn-structured item (two or more speaker lines)
 * cuts at its last whole turn, then line, then sentence; any other item at
 * its last whole line, then sentence. A cut item's header says
 * `cut to fit`, and the pack records the cut and its packing loss (items,
 * characters and sources the budget dropped), separate from retrieval loss.
 * Two context modes:
 *   native      the item text the system returned, in rank order (or, for a
 *               system whose capability record says `presentation:
 *               event-time`, the selected items in event-time order), with any
 *               validity window printed and superseded facts marked;
 *   rehydrated  the raw sessions behind the items' source ids, first
 *               appearance order for selection, date order for presentation
 *               (the legacy LongMemEval reading prompt, byte for byte); whole
 *               sessions only, no cut.
 *
 * Context identity: renderer version, counter identity (tokenizer package
 * version, encodings, calibration factors) and the sorted reader set enter
 * `identity_sha256` and `context_sha256`, so a pack built for a different
 * reader set or tokenizer is a different context even when its bytes match.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { MemoryQuestion, Session, Turn } from '../memory-qa/corpus.ts';
import { READER_TEMPLATE, approxTokens, renderHistory } from '../memory-qa/qa.ts';
import { eventTimeOf } from './sanitize.ts';
import { SystemError, type Item } from './types.ts';

export const TOKENIZER = { id: 'approx-chars-div-4', count: approxTokens } as const;
export const RENDERER_VERSION = 'memory-render-v2';
export type ContextMode = 'native' | 'rehydrated';
/**
 * Renderers a named recipe can use (budgeted delivery plan C0); `native` and `rehydrated` are the shootout's.
 * `pseudo-session-rank` is `pseudo-session` with the sessions shown in delivery (rank) order instead of date order
 * (plan C5); it packs exactly the same blocks, because the serialized length does not depend on the order.
 */
export type RecipeRender = 'native' | 'native-dated' | 'pseudo-session' | 'pseudo-session-rank' | 'rehydrated';
export const DATED_RENDERER_VERSION = 'budgeted-delivery-render-v1';

export const NATIVE_READER_TEMPLATE = 'I will give you items a memory system returned from past chats between you and a user, in the order the memory system ranked them. Some items carry the dates the memory system recorded for them; an item marked superseded was later replaced. Please answer the question based on these items. Answer the question step by step: first extract all the relevant information, and then reason over the information to get the answer.\n\n\nMemory Items:\n\n{items}\n\nCurrent Date: {date}\nQuestion: {question}\nAnswer (step by step):';

/** Throws a product error naming the count of foreign ids (never the ids themselves, which may be raw dataset ids). */
export function validateSources(items: readonly Item[], ingested: ReadonlySet<string>): void {
  const foreign = items.flatMap(i => i.source_ids.filter(s => !ingested.has(s)));
  if (foreign.length) throw new SystemError('product_error', `${foreign.length} returned source id(s) were never ingested into this namespace`);
  const ranks = items.map(i => i.rank);
  if (ranks.some((r, k) => k > 0 && r <= ranks[k - 1])) throw new SystemError('product_error', 'items are not in strictly increasing rank order');
}

/** Non-empty source lines with whitespace collapsed; the units a cut works on. */
export function bodyLines(text: string): string[] {
  return text.split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function header(item: Item, cut: boolean): string {
  const window = item.valid_from || item.valid_to ? ` [valid ${item.valid_from?.slice(0, 10) ?? 'unknown'} to ${item.valid_to?.slice(0, 10) ?? 'present'}]` : '';
  return `- (${item.rank}, ${item.type}${item.valid_to ? ', superseded' : ''}${cut ? ', cut to fit' : ''})${window}`;
}

function renderLines(item: Item, lines: readonly string[], multiline: boolean, cut: boolean): string {
  return multiline ? [header(item, cut), ...lines.map(l => `  ${l}`)].join('\n') : `${header(item, cut)} ${lines[0] ?? ''}`;
}

export function renderItem(item: Item): string {
  const lines = bodyLines(item.text);
  return lines.length > 1 ? renderLines(item, lines, true, false) : `${header(item, false)} ${item.text.replace(/\s+/g, ' ').trim()}`;
}

/** A speaker line: `**name:**`, `**name**:`, a role (`user:`), or a capitalized name of one or two words and a colon. */
export const TURN_START = /^(?:\*\*[^*]{1,64}?(?::\*\*|\*\*:)|(?:user|assistant|system|human|ai|User|Assistant|System|Human|AI|USER|ASSISTANT)\s*:|[A-Z][A-Za-z0-9.'-]*(?: [A-Z][A-Za-z0-9.'-]*)?:)(?:\s|$)/;

/** Two or more speaker lines make an item turn-structured. */
export const isTurnStructured = (lines: readonly string[]) => lines.filter(l => TURN_START.test(l)).length >= 2;

/** Offsets just after each sentence end inside one line (the line's end excluded). */
export function sentenceEnds(line: string): number[] {
  const ends: number[] = [];
  for (const m of line.matchAll(/[.!?](?=\s)|[。！？](?=.)/gu)) ends.push(m.index! + m[0].length);
  return ends.filter(e => e < line.length);
}

export type CutUnit = 'turn' | 'line' | 'sentence';

/** The prefixes a cut may keep, shortest first, at each unit's boundaries. */
export function cutCandidates(lines: readonly string[], unit: CutUnit): string[][] {
  if (unit === 'turn') {
    const starts = lines.flatMap((l, i) => TURN_START.test(l) ? [i] : []);
    return starts.slice(1).map(b => lines.slice(0, b));
  }
  if (unit === 'line') return lines.slice(1).map((_, k) => lines.slice(0, k + 1));
  return lines.length ? sentenceEnds(lines[0]).map(e => [lines[0].slice(0, e)]) : [];
}

// ─── Budget counters ─────────────────────────────────────────────────

export type Encoding = 'cl100k_base' | 'o200k_base';
export interface ReaderTokenizer {
  encoding: Encoding; calibration: number; calibrated: boolean;
  /** Where a calibrated factor comes from: the date, the packs it was fitted on and the largest per-pack error under it. */
  measured?: { on: string; samples: number; max_error: number; source: string };
}

const SMOKES = 'docs/benchmarks/2026-10-06-scoreboard/dev-smokes/ (bun eval/runner/q1/calibrate.ts)';

/**
 * Local encoding and calibration factor per reader. A factor is the reader's
 * provider-reported input tokens per local token, measured on dev packs
 * against `usage.input_tokens`; 1.0 with `calibrated: false` until measured.
 * Changing a factor changes every context identity built with that reader.
 * The Claude 5 tokenizer counts about 1.45-1.47 tokens per cl100k_base token, with
 * up to 10% error per pack (content-dependent), above the 3% that a local
 * count is good enough for; GPT-6.1 matches o200k_base (exact on full packs,
 * 4.7% on prompts of about 130 tokens, where the chat format's six tokens
 * show).
 */
export const READER_TOKENIZERS: Record<string, ReaderTokenizer> = {
  'anthropic:claude-opus-5-5': { encoding: 'cl100k_base', calibration: 1.4708, calibrated: true, measured: { on: '2026-10-07', samples: 199, max_error: 0.101, source: SMOKES } },
  'anthropic:claude-sonnet-5-5': { encoding: 'cl100k_base', calibration: 1.4524, calibrated: true, measured: { on: '2026-10-07', samples: 317, max_error: 0.0983, source: SMOKES } },
  'anthropic:claude-fable-5-1': { encoding: 'cl100k_base', calibration: 1.0, calibrated: false },
  'openai:gpt-6.1-sol': { encoding: 'o200k_base', calibration: 1.0009, calibrated: true, measured: { on: '2026-10-07', samples: 199, max_error: 0.0468, source: SMOKES } },
};

const canonicalReader = (reader: string) => reader.includes(':') ? reader : `openai:${reader}`;

/** A reader's tokenizer: its table entry, else `o200k_base` for OpenAI's GPT-4o and later, `cl100k_base` otherwise, uncalibrated. */
export function readerTokenizer(reader: string, table: Record<string, ReaderTokenizer> = READER_TOKENIZERS): ReaderTokenizer {
  const r = canonicalReader(reader);
  if (table[r]) return table[r];
  const modern = /^openai:(?:gpt-4o|gpt-4\.1|gpt-[5-9]|o\d)/.test(r);
  return { encoding: modern ? 'o200k_base' : 'cl100k_base', calibration: 1.0, calibrated: false };
}

type Encoder = { encode(text: string, allowed?: string[], disallowed?: string[]): Uint32Array };
const encoders = new Map<Encoding, Encoder>();
const requireLocal = createRequire(import.meta.url);

/** `@dqbd/tiktoken@<version>`; part of every reader-counter identity. */
export const TIKTOKEN_VERSION = `@dqbd/tiktoken@${(requireLocal('@dqbd/tiktoken/package.json') as { version: string }).version}`;

/** Local token count; special-token strings count as ordinary text. */
export function encodingCount(encoding: Encoding, text: string): number {
  let enc = encoders.get(encoding);
  if (!enc) { enc = (requireLocal('@dqbd/tiktoken') as { get_encoding(e: string): Encoder }).get_encoding(encoding); encoders.set(encoding, enc); }
  return enc.encode(text, [], []).length;
}

/**
 * A budget unit. `measure` returns additive raw measures, one per channel
 * (characters, or tokens per encoding); `perReader` turns summed measures into
 * each reader's count; the budget compares the largest reader count.
 */
export interface PackCounter {
  readonly id: string;
  readonly readers: readonly string[];
  readonly channels: readonly string[];
  readonly identity: Record<string, unknown>;
  measure(text: string): number[];
  perReader(raw: readonly number[]): Record<string, number>;
  /** Whether a block's raw measure equals the sum of its parts' measures (characters do; tokens almost always do and are re-checked). */
  readonly additive: boolean;
}

export const APPROX_COUNTER: PackCounter = {
  id: TOKENIZER.id, readers: ['*'], channels: ['chars'], identity: { counter: TOKENIZER.id }, additive: true,
  measure: text => [text.length],
  perReader: raw => ({ '*': Math.ceil(raw[0] / 4) }),
};

/** One counter for a reader set: every reader's local count, the budget is reached when the largest one reaches it. */
export function readerCounter(readers: readonly string[], table: Record<string, ReaderTokenizer> = READER_TOKENIZERS): PackCounter {
  if (!readers.length) throw new Error('readerCounter needs at least one reader');
  const sorted = [...new Set(readers.map(canonicalReader))].sort();
  const tk = sorted.map(r => ({ reader: r, ...readerTokenizer(r, table) }));
  const channels = [...new Set(tk.map(t => t.encoding))].sort();
  const identity = { counter: 'reader-max-v1', tokenizer: TIKTOKEN_VERSION, readers: tk.map(t => ({ reader: t.reader, encoding: t.encoding, calibration: t.calibration, calibrated: t.calibrated })) };
  return {
    id: `reader-max:${channels.join('+')}`, readers: sorted, channels, identity, additive: false,
    measure: text => channels.map(c => encodingCount(c as Encoding, text)),
    perReader: raw => Object.fromEntries(tk.map(t => [t.reader, Math.ceil(raw[channels.indexOf(t.encoding)] * t.calibration)])),
  };
}

/**
 * A calibration factor from dev packs: provider-reported input tokens over
 * local tokens, summed. `max_error` is the worst per-pack relative error of
 * the calibrated count; above 3% the local count is not good enough and the
 * proxy needs the provider's count-tokens route (engineering review C1).
 */
export function measureCalibration(samples: ReadonlyArray<{ local: number; provider: number }>): { factor: number; max_error: number; needs_provider_count: boolean } {
  if (!samples.length || samples.some(s => !(s.local > 0 && s.provider > 0))) throw new Error('calibration needs positive local and provider counts');
  const factor = samples.reduce((a, s) => a + s.provider, 0) / samples.reduce((a, s) => a + s.local, 0);
  const max_error = Math.max(...samples.map(s => Math.abs(s.local * factor - s.provider) / s.provider));
  return { factor, max_error, needs_provider_count: max_error > 0.03 };
}

const budgetCount = (counter: PackCounter, raw: readonly number[]) => Math.max(...Object.values(counter.perReader(raw)));
const addRaw = (a: readonly number[], b: readonly number[]) => a.map((x, i) => x + b[i]);

// ─── Strict recall ───────────────────────────────────────────────────

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

// ─── Packing ─────────────────────────────────────────────────────────

export interface CutRecord { item_id: string; rank: number; unit: CutUnit; kept_lines: number; total_lines: number; kept_chars: number; total_chars: number }

/** What the budget dropped, separate from what retrieval missed. */
export interface PackingLoss {
  items_offered: number;
  items_whole: number;
  items_cut: number;
  items_dropped: number;
  chars_offered: number;
  chars_delivered: number;
  sources_offered: number;
  /** Distinct sources cited by an item that was dropped or cut, and by no whole packed item. */
  sources_dropped_or_cut: number;
}

export interface NativePack {
  lines: string[];
  /** Packed items in rank order; a cut item keeps its id and source ids. */
  items: Item[];
  /** The budget unit: the largest reader count of the items block. */
  tokens: number;
  reader_tokens: Record<string, number>;
  /** Raw measure of the items block per counter channel. */
  delivered: Record<string, number>;
  cut: CutRecord | null;
  loss: PackingLoss;
}

/** Native mode: item text in rank order until the budget or `maxItems`; the first item that does not fit is cut, then packing stops. */
export function packNative(items: readonly Item[], budgetTokens: number | null, maxItems: number | null = null, counter: PackCounter = APPROX_COUNTER): NativePack {
  const offered = maxItems === null ? [...items] : items.slice(0, maxItems);
  const out: Item[] = [];
  const lines: string[] = [];
  let raw = counter.channels.map(() => 0);
  let cut: CutRecord | null = null;
  const sepRaw = (k: number) => k === 0 ? counter.channels.map(() => 0) : counter.measure('\n');
  const fits = (r: readonly number[]) => budgetTokens === null || budgetCount(counter, r) <= budgetTokens;
  for (const item of offered) {
    const whole = renderItem(item);
    const next = addRaw(addRaw(raw, sepRaw(lines.length)), counter.measure(whole));
    if (fits(next)) { out.push(item); lines.push(whole); raw = next; continue; }
    const body = bodyLines(item.text);
    const multiline = body.length > 1;
    const units: CutUnit[] = isTurnStructured(body) ? ['turn', 'line', 'sentence'] : ['line', 'sentence'];
    const base = addRaw(raw, sepRaw(lines.length));
    for (const unit of units) {
      const candidates = cutCandidates(body, unit);
      let lo = 0, hi = candidates.length - 1, best = -1, bestRaw: number[] | null = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const r = addRaw(base, counter.measure(renderLines(item, candidates[mid], multiline, true)));
        if (fits(r)) { best = mid; bestRaw = r; lo = mid + 1; } else hi = mid - 1;
      }
      if (best < 0) continue;
      const kept = candidates[best];
      lines.push(renderLines(item, kept, multiline, true));
      out.push(item);
      raw = bestRaw!;
      cut = { item_id: item.id, rank: item.rank, unit, kept_lines: kept.length, total_lines: body.length, kept_chars: kept.join('\n').length, total_chars: body.join('\n').length };
      break;
    }
    break;
  }
  if (!counter.additive && lines.length) {
    const exact = counter.measure(lines.join('\n'));
    if (exact.some((x, i) => x !== raw[i])) {
      raw = exact;
      while (budgetTokens !== null && lines.length && budgetCount(counter, raw) > budgetTokens) {
        lines.pop(); out.pop(); cut = null;
        raw = lines.length ? counter.measure(lines.join('\n')) : counter.channels.map(() => 0);
      }
    }
  }
  const readerTokens = counter.perReader(raw);
  const wholeIds = new Set(out.filter(i => i.id !== cut?.item_id).map(i => i.id));
  const keptSources = new Set(out.filter(i => wholeIds.has(i.id)).flatMap(i => i.source_ids));
  const offeredSources = new Set(offered.flatMap(i => i.source_ids));
  const loss: PackingLoss = {
    items_offered: offered.length, items_whole: wholeIds.size, items_cut: cut ? 1 : 0, items_dropped: offered.length - out.length,
    chars_offered: offered.map(renderItem).join('\n').length, chars_delivered: lines.join('\n').length,
    sources_offered: offeredSources.size, sources_dropped_or_cut: [...offeredSources].filter(s => !keptSources.has(s)).length,
  };
  return { lines, items: out, tokens: Math.max(0, ...Object.values(readerTokens)), reader_tokens: readerTokens,
    delivered: Object.fromEntries(counter.channels.map((c, i) => [c, raw[i]])), cut, loss };
}

/**
 * The rehydrated history: sessions in event-time order, parsed the way the
 * ingest plan parses them, so `Month-DD-YYYY` and LoCoMo dates order by time
 * rather than spelling (amendment A8). Undated sessions come first and ties keep
 * pack order, as the string sort did; for LongMemEval's `YYYY/MM/DD` dates the
 * order, and so the prompt, is unchanged byte for byte.
 */
export function renderHistoryByEventTime(sessions: readonly Session[]): string {
  const keyed = sessions.map((s, k) => ({ s, k, t: eventTimeOf(s) ?? '' })).sort((a, b) => (a.t === b.t ? a.k - b.k : a.t < b.t ? -1 : 1));
  return keyed.map(({ s }, i) => `\n### Session ${i + 1}:\nSession Date: ${s.date ?? 'unknown'}\nSession Content:\n\n${JSON.stringify(s.turns.map(t => ({ role: t.speaker, content: t.content })))}\n`).join('');
}

/** Rehydrated mode: sessions behind the items' sources in first-appearance order, whole sessions, until the budget or `maxSessions`. */
export function packRehydrated(items: readonly Item[], sessionOf: (sourceId: string) => Session | undefined, budgetTokens: number | null, maxSessions: number | null = null, counter: PackCounter = APPROX_COUNTER): { sessions: Session[]; source_ids: string[]; tokens: number; reader_tokens: Record<string, number>; delivered: Record<string, number> } {
  const order: string[] = [];
  for (const i of items) if (i.provenance_status !== 'unavailable') for (const s of i.source_ids) if (!order.includes(s)) order.push(s);
  const sessions: Session[] = [];
  const used: string[] = [];
  let raw = counter.channels.map(() => 0);
  for (const src of maxSessions === null ? order : order.slice(0, maxSessions)) {
    const s = sessionOf(src);
    if (!s) continue;
    const next = addRaw(raw, counter.measure(renderHistoryByEventTime([s])));
    if (budgetTokens !== null && budgetCount(counter, next) > budgetTokens) break;
    sessions.push(s); used.push(src); raw = next;
  }
  const readerTokens = counter.perReader(raw);
  return { sessions, source_ids: used, tokens: Math.max(0, ...Object.values(readerTokens)), reader_tokens: readerTokens, delivered: Object.fromEntries(counter.channels.map((c, i) => [c, raw[i]])) };
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
  /** Sorted reader set the pack was counted for (`['*']` for the reader-independent unit). */
  readers: string[];
  /** Every reader's count of the evidence block. */
  reader_tokens: Record<string, number>;
  /** Raw evidence-block measure per counter channel (characters, or tokens per local encoding). */
  delivered: Record<string, number>;
  /** `tokens / budget_tokens`, a diagnostic; null without a budget. */
  fill_rate: number | null;
  /** Native mode only: the cut item, if any, and the packing loss. */
  cut: CutRecord | null;
  packing_loss: PackingLoss | null;
  /** sha256 of the renderer version and counter identity (tokenizer version, encodings, calibrations, reader set). */
  identity_sha256: string;
  /** sha256 of the identity hash and the prompt bytes: the context id answers reference. */
  context_sha256: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** The reader prompt for one question in one context mode; the date falls back to the conversation's last session date. */
export function packContext(mode: ContextMode, q: MemoryQuestion, items: readonly Item[], opts: { budgetTokens: number | null; maxUnits?: number | null; sessionOf: (sourceId: string) => Session | undefined; fallbackDate?: string; present?: 'rank' | 'event-time'; counter?: PackCounter }): PackedContext {
  const date = q.question_date ?? opts.fallbackDate ?? 'unknown';
  const counter = opts.counter ?? APPROX_COUNTER;
  const identity_sha256 = sha(JSON.stringify({ renderer: RENDERER_VERSION, ...counter.identity }));
  const finish = (p: Omit<PackedContext, 'mode' | 'tokenizer' | 'renderer' | 'budget_tokens' | 'readers' | 'fill_rate' | 'identity_sha256' | 'context_sha256'>): PackedContext => ({
    mode, tokenizer: counter.id, renderer: RENDERER_VERSION, budget_tokens: opts.budgetTokens, readers: [...counter.readers], ...p,
    fill_rate: opts.budgetTokens ? p.tokens / opts.budgetTokens : null, identity_sha256, context_sha256: sha(`${identity_sha256}\u0000${p.prompt}`),
  });
  if (mode === 'native') {
    const p = packNative(items, opts.budgetTokens, opts.maxUnits ?? null, counter);
    const lines = opts.present === 'event-time'
      ? p.items.map((item, k) => ({ item, line: p.lines[k], k })).sort((x, y) => (x.item.valid_from ?? '') === (y.item.valid_from ?? '') ? y.k - x.k : (x.item.valid_from ?? '') < (y.item.valid_from ?? '') ? -1 : 1).map(x => x.line)
      : p.lines;
    const prompt = NATIVE_READER_TEMPLATE.replace('{items}', lines.join('\n') || '(none)').replace('{date}', date).replace('{question}', q.question);
    return finish({ tokens: p.tokens, item_ids: p.items.map(i => i.id), source_ids: [...new Set(p.items.flatMap(i => i.source_ids))], prompt, reader_tokens: p.reader_tokens, delivered: p.delivered, cut: p.cut, packing_loss: p.loss });
  }
  const p = packRehydrated(items, opts.sessionOf, opts.budgetTokens, opts.maxUnits ?? null, counter);
  const prompt = READER_TEMPLATE.replace('{history}', renderHistoryByEventTime(p.sessions)).replace('{date}', date).replace('{question}', q.question);
  return finish({ tokens: p.tokens, item_ids: items.filter(i => i.source_ids.some(s => p.source_ids.includes(s))).map(i => i.id), source_ids: p.source_ids, prompt, reader_tokens: p.reader_tokens, delivered: p.delivered, cut: null, packing_loss: null });
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

/**
 * The ISO day of a raw session date, or null for an undated session (never an
 * invented date). Reads every form the sanitizer's event time reads (LoCoMo,
 * LongMemEval, ISO, and BEAM's `March-15-2024`), so the header date is the
 * day the system was given.
 */
export const sessionDay = (raw: string | undefined): string | null => eventTimeOf({ id: '', date: raw, turns: [] })?.slice(0, 10) ?? null;

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

export interface RecipeContext extends Pick<PackedContext, 'mode' | 'tokenizer' | 'renderer' | 'budget_tokens' | 'tokens' | 'item_ids' | 'source_ids' | 'prompt'> {
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
  if (render === 'native-dated') {
    const shown = datedItems(items, dayOf);
    const lines = shown.map(i => `${header(i, false)} ${i.text.replace(/\s+/g, ' ').trim()}`);
    const kept: string[] = [];
    let tokens = 0;
    for (const line of lines) {
      const t = TOKENIZER.count(line + '\n');
      if (opts.budgetTokens !== null && tokens + t > opts.budgetTokens) break;
      kept.push(line); tokens += t;
    }
    const chosen = shown.slice(0, kept.length);
    const prompt = NATIVE_READER_TEMPLATE.replace('{items}', kept.join('\n') || '(none)').replace('{date}', date).replace('{question}', q.question);
    return { ...base, tokens, tokens_before: lines.reduce((n, l) => n + TOKENIZER.count(l + '\n'), 0), items_cut: shown.length - chosen.length, dated_items: chosen.filter(i => i.event_date).length,
      item_ids: chosen.map(i => i.id), source_ids: [...new Set(chosen.flatMap(i => i.source_ids))], prompt };
  }
  if (render === 'native') {
    const shown = [...items];
    const p = packNative(shown, opts.budgetTokens);
    const before = shown.reduce((n, i) => n + TOKENIZER.count(renderItem(i) + '\n'), 0);
    const prompt = NATIVE_READER_TEMPLATE.replace('{items}', p.lines.join('\n') || '(none)').replace('{date}', date).replace('{question}', q.question);
    return { ...base, tokens: p.tokens, tokens_before: before, items_cut: shown.length - p.items.length, dated_items: p.items.filter(i => i.event_date).length,
      item_ids: p.items.map(i => i.id), source_ids: [...new Set(p.items.flatMap(i => i.source_ids))], prompt };
  }
  if (render === 'pseudo-session' || render === 'pseudo-session-rank') {
    const p = packPseudo(datedItems(items, dayOf), opts.sessionOf, opts.budgetTokens);
    const prompt = READER_TEMPLATE.replace('{history}', renderHistory(p.sessions, render === 'pseudo-session-rank' ? 'given' : 'date')).replace('{date}', date).replace('{question}', q.question);
    return { ...base, tokens: p.tokens, tokens_before: p.tokens_before, items_cut: items.length - p.items.length, dated_items: p.sessions.filter(s => s.date).length,
      item_ids: p.items.map(i => i.id), source_ids: [...new Set(p.items.flatMap(i => i.source_ids))], prompt };
  }
  const p = packRehydrated(items, opts.sessionOf, opts.budgetTokens);
  const all = packRehydrated(items, opts.sessionOf, null);
  const prompt = READER_TEMPLATE.replace('{history}', renderHistory(p.sessions)).replace('{date}', date).replace('{question}', q.question);
  return { ...base, tokens: p.tokens, tokens_before: all.tokens, items_cut: all.source_ids.length - p.source_ids.length, dated_items: p.sessions.filter(s => s.date).length,
    item_ids: items.filter(i => i.source_ids.some(s => p.source_ids.includes(s))).map(i => i.id), source_ids: p.source_ids, prompt };
}

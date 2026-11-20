/**
 * Scoring for the multi-evidence dev loop (dev-loop.ts): per item, how much of the gold evidence gbrain delivered, where
 * the rest went, the agent's turns against its cap and whether the answer was right; then the summary tables, the
 * turn-cap comparison, the "why" rows for missed items and the smallest change the set can detect.
 *
 * Definitions (each count is over the item's gold items: Cat 40's gold.evidence documents, a QA question's gold sessions):
 *   agent (Cat 40)  retrieved = delivered = gold whose slug any tool result names (the nightly's definition: a search
 *                   row carries the page's text as chunk_text, so a named row is a delivered excerpt). opened = gold a
 *                   page read targeted (get_page with slug or slugs, fetch, get_chunks, assemble_evidence). cited = gold in
 *                   the submitted answer's sources. Packing is not measured for agents, so cut is null. result_chars is the
 *                   characters of every tool result the agent received (submit_answer excluded); slugs_calls, slugs_multi
 *                   and omitted_calls count get_page batch reads (gbrain#9798): calls with a non-empty slugs array, those
 *                   whose result delivered two or more pages, and results that listed pages under omitted. page_chars is
 *                   the characters of every get_page result, single reads and slugs batches alike. setup is a digest of
 *                   the cell's setup (world, brains, Hard identity, turn cap, evaluator code, served instructions and
 *                   tool names, the flags that reach a cell), so two runs' cells pair only when it matches.
 *   qa (LME, BEAM)  retrieved = gold in the ranked session list gbrain returned (top 10); delivered = gold in the sessions
 *                   the reader was given (the first qa_sessions of that list); cut = retrieved but past the packing cut.
 * coverage is all, some or none of the gold delivered. A harness row (a crashed child, a provider error) is kept and
 * labelled, and never counted as a gbrain miss.
 */
import type { Outcome } from '../nightly/outcome.ts';

export const ITEM_SCHEMA = 'multi-evidence-item/1';
export const WHY_SCHEMA = 'multi-evidence-why/1';
export type ArmName = 'base' | 'cap2x' | 'batch';
export type Coverage = 'all' | 'some' | 'none';

/** One tool call as the agent saw it. */
export interface Call { name: string; args?: Record<string, unknown>; result: string }

export interface ItemRow {
  schema: typeof ITEM_SCHEMA;
  suite: string; kind: 'agent' | 'qa'; item: string; reader: string; arm: ArmName; trial: number;
  gbrain: { ref: string; sha: string };
  category: string | null; question: string | null; expected: string | null; answer: string | null;
  gold: string[]; retrieved: string[]; delivered: string[]; opened: string[] | null; cited: string[] | null; cut: string[] | null;
  coverage: Coverage;
  turns: number | null; turn_cap: number | null; hit_cap: boolean | null; calls: number | null; assemble_calls: number | null;
  result_chars: number | null; page_chars: number | null; slugs_calls: number | null; slugs_multi: number | null; omitted_calls: number | null;
  setup: string | null;
  correct: boolean | null; score: number | null; stop: string | null; harness: string | null; cost_usd: number | null;
}

const PAGE_READS = new Set(['get_page', 'fetch', 'get_chunks', 'assemble_evidence']);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** text names slug as a whole slug, not inside a longer one (failure-causes' Cat 40 rule). */
export const namesSlug = (text: string, slug: string) => new RegExp(`(^|[^\\w/.-])${escape(slug)}(?![\\w/-])`).test(text);
const coverage = (hit: number, of: number): Coverage => (hit === 0 ? 'none' : hit >= of ? 'all' : 'some');

/** The slugs a page-read call targeted. */
export function readTargets(c: Pick<Call, 'name' | 'args'>): string[] {
  if (!PAGE_READS.has(c.name) || !c.args) return [];
  const a = c.args as Record<string, any>;
  if (c.name === 'assemble_evidence') return Array.isArray(a.hits) ? a.hits.map((h: any) => String(h?.slug ?? '')).filter(Boolean) : [];
  const many = c.name === 'get_page' && Array.isArray(a.slugs) ? a.slugs : [];
  return [a.slug, a.id, ...many].filter((x): x is string => typeof x === 'string' && x.length > 0);
}

/** A get_page call that reads several pages with a non-empty slugs array (gbrain#9798). */
export const isSlugsCall = (c: Pick<Call, 'name' | 'args'>) => c.name === 'get_page' && Array.isArray(c.args?.slugs) && (c.args!.slugs as unknown[]).length > 0;
/** The slugs a get_page batch result delivered: entries that carry a page rather than a not-found error. */
export const batchPagesRead = (result: string) => [...result.matchAll(/"requested_slug"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"page"\s*:/g)].map(m => JSON.parse(`"${m[1]}"`) as string);
/** A get_page batch result that stopped at its token budget or egress cap and listed the rest under omitted. */
export const listsOmitted = (result: string) => /"omitted"\s*:\s*\{/.test(result);

const isError = (result: string) => /^Error:/.test(result.trimStart());

/** An agent item from its nightly outcome row (cat40Rows), its transcript and its turns. */
export function agentItem(o: Outcome, x: { arm: ArmName; ref: string; gold: string[]; calls: Call[] | null; turns: number | null; turnCap: number | null; setup?: string | null }): ItemRow {
  const calls = x.calls ?? [];
  const delivered = x.calls ? x.gold.filter(g => calls.some(c => namesSlug(String(c.result ?? ''), g))) : (o.searched_gold ?? []);
  const openedBy = (c: Call) => { const r = String(c.result ?? ''); return isError(r) ? [] : isSlugsCall(c) ? batchPagesRead(r) : readTargets(c); };
  const opened = x.calls ? x.gold.filter(g => calls.some(c => openedBy(c).some(t => t === g || t.endsWith(`:${g}`)))) : null;
  const cited = (o.evidence?.evidence_cited as string[] | undefined) ?? null;
  return {
    schema: ITEM_SCHEMA, suite: o.suite, kind: 'agent', item: o.item, reader: o.reader ?? 'none', arm: x.arm, trial: o.trial, gbrain: { ref: x.ref, sha: o.sha },
    category: o.category ?? null, question: o.question ?? null, expected: o.expected ?? null, answer: o.answer ?? null,
    gold: x.gold, retrieved: delivered, delivered, opened, cited, cut: null, coverage: coverage(delivered.length, x.gold.length),
    turns: x.turns, turn_cap: x.turnCap, hit_cap: o.stop === null ? null : o.stop === 'turn_cap', calls: x.calls ? calls.filter(c => c.name !== 'submit_answer').length : (o.calls?.length ?? null),
    assemble_calls: x.calls ? calls.filter(c => c.name === 'assemble_evidence').length : null,
    result_chars: x.calls ? calls.filter(c => c.name !== 'submit_answer').reduce((n, c) => n + String(c.result ?? '').length, 0) : null,
    page_chars: x.calls ? calls.filter(c => c.name === 'get_page').reduce((n, c) => n + String(c.result ?? '').length, 0) : null,
    slugs_calls: x.calls ? calls.filter(isSlugsCall).length : null,
    slugs_multi: x.calls ? calls.filter(c => isSlugsCall(c) && !isError(String(c.result ?? '')) && batchPagesRead(String(c.result ?? '')).length >= 2).length : null,
    omitted_calls: x.calls ? calls.filter(c => c.name === 'get_page' && listsOmitted(String(c.result ?? ''))).length : null,
    setup: x.setup ?? null,
    correct: o.harness ? null : o.pass, score: o.score, stop: o.stop, harness: o.harness?.error ?? null, cost_usd: o.cost_usd,
  };
}

/** A QA item from its nightly outcome row (qaRows), the gold sessions and how many ranked sessions the reader got. */
export function qaItem(o: Outcome, x: { arm: ArmName; ref: string; gold: string[]; ranked: string[] | null; sessions: number | null }): ItemRow {
  const ranked = x.ranked ?? [];
  const packed = x.sessions === null ? ranked : ranked.slice(0, x.sessions);
  const retrieved = x.gold.filter(g => ranked.includes(g));
  const delivered = x.gold.filter(g => packed.includes(g));
  return {
    schema: ITEM_SCHEMA, suite: o.suite, kind: 'qa', item: o.item, reader: o.reader ?? 'none', arm: x.arm, trial: o.trial, gbrain: { ref: x.ref, sha: o.sha },
    category: o.category ?? null, question: o.question ?? null, expected: o.expected ?? null, answer: o.answer ?? null,
    gold: x.gold, retrieved, delivered, opened: null, cited: null, cut: retrieved.filter(g => !delivered.includes(g)), coverage: coverage(delivered.length, x.gold.length),
    turns: null, turn_cap: null, hit_cap: null, calls: x.ranked ? 1 : null, assemble_calls: null, result_chars: null, page_chars: null, slugs_calls: null, slugs_multi: null, omitted_calls: null, setup: null,
    correct: o.harness ? null : o.pass, score: o.score, stop: o.stop, harness: o.harness?.error ?? null, cost_usd: o.cost_usd,
  };
}

// ─── Why rows ───────────────────────────────────────────────────────

/**
 * A gold item's fate. Agent: cited in the answer; delivered (named in a tool result) but not cited; never returned though
 * a call named it (its slug, or the words of its slug's name segment, in the call's arguments); never returned and never
 * named, the closest these logs get to "never asked for" (an opaque slug such as tickets/18c11ee9ae has no name to ask by,
 * so it always lands here when missing). QA: delivered to the reader, retrieved but cut by packing, or not retrieved.
 */
export type GoldFate = 'cited' | 'delivered' | 'delivered_not_cited' | 'cut_by_packing' | 'never_returned_asked_by_name' | 'never_returned_not_asked_by_name' | 'not_retrieved';
export interface WhyRow {
  schema: typeof WHY_SCHEMA;
  suite: string; item: string; reader: string; arm: ArmName; gbrain: { ref: string; sha: string };
  question: string | null; expected: string | null; answer: string | null; correct: boolean | null; stop: string | null;
  turns: number | null; turn_cap: number | null;
  gold: Array<{ id: string; fate: GoldFate; first_returned_at_call: number | null; rank?: number | null }>;
  calls: Array<{ n: number; name: string; args: string; error: boolean; result_chars: number; gold_returned: string[]; excerpt: string }>;
  summary: string;
}

/** The words a slug's name segment spells (crm/fenesso-health -> "fenesso health"), or null for an opaque id. */
export function slugName(slug: string): string | null {
  const last = slug.split('/').at(-1) ?? '';
  if (!/[a-z]{3,}-[a-z]{3,}/i.test(last)) return null;
  return last.replace(/-/g, ' ').toLowerCase();
}

/** Why an agent item missed: each gold item's fate, and every call with the gold it returned. */
export function agentWhy(row: ItemRow, calls: Call[]): WhyRow {
  const traced = calls.filter(c => c.name !== 'submit_answer').map((c, i) => {
    const result = String(c.result ?? '');
    return { n: i + 1, name: c.name, args: JSON.stringify(c.args ?? {}).slice(0, 400), error: isError(result), result_chars: result.length,
      gold_returned: row.gold.filter(g => namesSlug(result, g)), excerpt: result.slice(0, 240) };
  });
  const asked = (g: string) => { const n = slugName(g); return traced.some(t => t.args.toLowerCase().includes(g.toLowerCase()) || (n !== null && t.args.toLowerCase().replace(/[-_]/g, ' ').includes(n))); };
  const gold = row.gold.map(id => {
    const first = traced.find(t => t.gold_returned.includes(id))?.n ?? null;
    const fate: GoldFate = row.cited?.includes(id) ? 'cited' : first !== null ? 'delivered_not_cited'
      : asked(id) ? 'never_returned_asked_by_name' : 'never_returned_not_asked_by_name';
    return { id, fate, first_returned_at_call: first };
  });
  const never = gold.filter(g => g.fate.startsWith('never_returned')).length;
  const summary = `${row.delivered.length}/${row.gold.length} gold returned in ${traced.length} calls over ${row.turns ?? '?'} turns (cap ${row.turn_cap ?? '?'}, stop ${row.stop}); `
    + `${never} never returned (${gold.filter(g => g.fate === 'never_returned_asked_by_name').length} of them asked for by name), ${gold.filter(g => g.fate === 'delivered_not_cited').length} returned but not cited`;
  return { schema: WHY_SCHEMA, suite: row.suite, item: row.item, reader: row.reader, arm: row.arm, gbrain: row.gbrain, question: row.question, expected: row.expected,
    answer: row.answer, correct: row.correct, stop: row.stop, turns: row.turns, turn_cap: row.turn_cap, gold, calls: traced, summary };
}

/** Why a QA item missed: each gold session's rank in gbrain's list, whether the reader got it, and the one search. */
export function qaWhy(row: ItemRow, ranked: string[], sessions: number | null): WhyRow {
  const gold = row.gold.map(id => {
    const i = ranked.indexOf(id);
    const fate: GoldFate = i < 0 ? 'not_retrieved' : row.delivered.includes(id) ? 'delivered' : 'cut_by_packing';
    return { id, fate, first_returned_at_call: i < 0 ? null : 1, rank: i < 0 ? null : i + 1 };
  });
  const summary = `${row.delivered.length}/${row.gold.length} gold sessions delivered (reader got the top ${sessions ?? ranked.length} of ${ranked.length}); `
    + `${gold.filter(g => g.fate === 'cut_by_packing').length} retrieved but cut by packing, ${gold.filter(g => g.fate === 'not_retrieved').length} not in the top ${ranked.length}`;
  return { schema: WHY_SCHEMA, suite: row.suite, item: row.item, reader: row.reader, arm: row.arm, gbrain: row.gbrain, question: row.question, expected: row.expected,
    answer: row.answer, correct: row.correct, stop: row.stop, turns: null, turn_cap: null, gold,
    calls: [{ n: 1, name: 'search (memory-qa, the question as the query)', args: JSON.stringify({ query: row.question }).slice(0, 400), error: row.harness !== null, result_chars: 0,
      gold_returned: gold.filter(g => g.rank !== null).map(g => g.id), excerpt: ranked.map((s, i) => `${i + 1}. ${s}${row.gold.includes(s) ? ' (gold)' : ''}`).join('; ').slice(0, 600) }],
    summary };
}

/** A missed item: the answer was wrong, or some gold was never delivered. Harness rows are not misses. */
export const missed = (r: ItemRow) => r.harness === null && (r.correct === false || r.coverage !== 'all');

// ─── Summaries and power ────────────────────────────────────────────

export interface Slice {
  suite: string; reader: string; arm: ArmName; n: number; harness: number;
  all_delivered: number; some_delivered: number; none_delivered: number; gold_delivered_share: number | null; cut_share: number | null;
  hit_cap: number | null; mean_turns: number | null; mean_calls: number | null; correct: number; cost_usd: number; cost_per_correct: number | null;
}

const pct = (k: number, n: number) => (n ? k / n : 0);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function slice(rows: ItemRow[]): Slice {
  const ok = rows.filter(r => r.harness === null);
  const gold = ok.reduce((n, r) => n + r.gold.length, 0);
  const agent = ok.length > 0 && ok[0]!.kind === 'agent';
  const cost = rows.reduce((n, r) => n + (r.cost_usd ?? 0), 0);
  const correct = ok.filter(r => r.correct).length;
  return {
    suite: rows[0]?.suite ?? '', reader: rows[0]?.reader ?? '', arm: rows[0]?.arm ?? 'base', n: ok.length, harness: rows.length - ok.length,
    all_delivered: pct(ok.filter(r => r.coverage === 'all').length, ok.length), some_delivered: pct(ok.filter(r => r.coverage === 'some').length, ok.length),
    none_delivered: pct(ok.filter(r => r.coverage === 'none').length, ok.length),
    gold_delivered_share: gold ? ok.reduce((n, r) => n + r.delivered.length, 0) / gold : null,
    cut_share: agent || !gold ? null : ok.reduce((n, r) => n + (r.cut?.length ?? 0), 0) / gold,
    hit_cap: agent ? pct(ok.filter(r => r.hit_cap).length, ok.length) : null,
    mean_turns: agent ? mean(ok.flatMap(r => (r.turns === null ? [] : [r.turns]))) : null, mean_calls: agent ? mean(ok.flatMap(r => (r.calls === null ? [] : [r.calls]))) : null,
    correct: pct(correct, ok.length), cost_usd: cost, cost_per_correct: correct ? cost / correct : null,
  };
}

export function slices(rows: ItemRow[]): Slice[] {
  const groups = new Map<string, ItemRow[]>();
  for (const r of rows) { const k = `${r.suite}|${r.reader}|${r.arm}`; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(r); }
  return [...groups.values()].map(slice);
}

/** z(0.975) + z(0.80): a two-sided 5% test with 80% power. */
export const Z = 1.959964 + 0.841621;

/**
 * The smallest paired change in a binary per-row rate (here "all gold delivered") that n paired rows detect at 80% power,
 * when a fraction d0 of pairs disagrees between two runs of the same build: solves delta^2 = Z^2 (d0 + delta) / n, the
 * McNemar normal approximation with the discordant share d0 + delta. d0 is 0 for gbrain's deterministic QA retrieval.
 */
export function minDetectable(n: number, d0: number): number {
  if (n <= 0) return Infinity;
  const a = (Z * Z) / n;
  return (a + Math.sqrt(a * a + 4 * a * d0)) / 2;
}

/** Discordant share of "all gold delivered" between repeated trials of the same item and reader in one arm (agent noise). */
export function trialDiscordance(rows: ItemRow[]): { pairs: number; share: number } | null {
  const by = new Map<string, ItemRow[]>();
  for (const r of rows.filter(x => x.harness === null)) { const k = `${r.suite}|${r.item}|${r.reader}|${r.arm}`; if (!by.has(k)) by.set(k, []); by.get(k)!.push(r); }
  let pairs = 0, dis = 0;
  for (const list of by.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) { pairs++; if ((list[i]!.coverage === 'all') !== (list[j]!.coverage === 'all')) dis++; }
  return pairs ? { pairs, share: dis / pairs } : null;
}

/**
 * The product path of the 8k conversion decision (preregistration
 * docs/benchmarks/2026-10-26-gbrain-8k-conversion-preregistration.md): one on-disk PGLite brain per history, the
 * history imported as conversation pages, gbrain's own conversation fact extraction over it, and one live `query` per
 * question and arm through gbrain's MCP dispatch (`dispatchToolCall`) with the options the stdio server passes, so an
 * arm's evidence is the text content of the tool result an agent receives. Arms differ only in the GBRA-205 keys,
 * written to the brain's config table before the arm's calls and deleted after.
 *
 * The product-text renderer: memory-qa's LongMemEval reading template with the tool result's text blocks in place of
 * the sessions (joined by a blank line, in the returned order), the rows array of the first block cut by whole rows
 * from its end while the history is over the 8,000 harness tokens (characters / 4); cuts are counted, and the recipe
 * hash names every choice.
 */
import { createHash } from 'node:crypto';
import { READER_TEMPLATE, approxTokens } from '../memory-qa/qa.ts';
import { renderSessionPage, type Corpus, type MemoryQuestion } from '../memory-qa/corpus.ts';
import { eventTimeOf, opaqueSourceId } from '../systems/sanitize.ts';
import { slugOf } from '../systems/gbrain.ts';
import { QUERY_PATH_PINS } from '../systems/gbrain-query/connector.ts';

export const QUERY_BUDGET = 5500;
export const QUERY_LIMIT = 25;
export const R5_LIMIT = 5;
export const HARNESS_BUDGET_TOKENS = 8000;
export const FACTS_BLOCK_SHARE = 0.22;
export const FACTS_BLOCK_MAX_ROWS = 40;

/** The GBRA-205 keys (gbrain 6f82a94e, all default off). Every arm deletes all of them after its calls; no arm sets search.fact_source_pages since spec change 7. */
export const C8K_KEYS = ['search.query_budget_unit', 'search.evidence_date_header', 'search.evidence_titles', 'search.query_facts_block', 'search.fact_source_pages'] as const;

export interface C8kArm { id: string; flags: string; keys: Record<string, string>; params: Record<string, unknown> }
const budgeted = { limit: QUERY_LIMIT, expand: false, token_budget: QUERY_BUDGET };
const F1 = { 'search.query_budget_unit': 'auto' };
const F2 = { ...F1, 'search.evidence_date_header': 'true', 'search.evidence_titles': 'true' };
const F3 = { ...F2, 'search.query_facts_block': 'true' };
/** F3 alone on the shipped default (spec change 7): the facts block under query's legacy chunk budget. */
const F3_ALONE = { 'search.query_facts_block': 'true' };
/** The six arms of the preregistration's arm table, in the order they run. */
export const C8K_ARMS: readonly C8kArm[] = Object.freeze([
  { id: 'A0', flags: 'control (shipped default)', keys: {}, params: budgeted },
  { id: 'A1', flags: 'F1', keys: F1, params: budgeted },
  { id: 'A2', flags: 'F1+F2', keys: F2, params: budgeted },
  { id: 'A3', flags: 'F1+F2+F3', keys: F3, params: budgeted },
  { id: 'B3', flags: 'F3 alone (A0 plus F3)', keys: F3_ALONE, params: budgeted },
  { id: 'R5', flags: 'reference: first five hits, no budget', keys: {}, params: { limit: R5_LIMIT, expand: false } },
]);
export const armById = (id: string) => { const a = C8K_ARMS.find(x => x.id === id); if (!a) throw new Error(`no arm ${id}`); return a; };

/** Brain settings written once when a history's brain is created: E2's query-path pins and the single-principal facts posture gbrain bootstrap sets when unset. */
export const BRAIN_SETTINGS: Readonly<Record<string, string>> = Object.freeze({ ...QUERY_PATH_PINS, 'facts.default_visibility': 'world' });
/** Keyless dry runs only: no reranker (hash vectors, no Voyage key), as in H1's keyless freeze. */
export const KEYLESS_SETTINGS: Readonly<Record<string, string>> = Object.freeze({ 'search.reranker.enabled': 'false' });

/** The gbrain modules the product path calls; `load` imports from the build under test (gbrain-under-test.ts). */
export interface ProductModules {
  PGLiteEngine: new () => any;
  importFromContent: (e: unknown, slug: string, content: string, o?: Record<string, unknown>) => Promise<unknown>;
  dispatchToolCall: (e: unknown, name: string, params: Record<string, unknown>, opts: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean; _meta?: Record<string, any> }>;
  runExtractConversationFactsCore: (e: unknown, o: Record<string, unknown>) => Promise<Record<string, any>>;
  resultTokens: (row: unknown) => number;
  stdioFrameBytes: number;
  knownConfigKeys: readonly string[];
  NoticeLedger: new () => unknown;
  runRepairCommand: (e: unknown, args: string[]) => Promise<void>;
}

export async function loadProductModules(load: <T>(rel: string) => Promise<T>): Promise<ProductModules> {
  const [pg, imp, disp, ext, tb, srv, cfg, nl, rep] = await Promise.all([
    load<{ PGLiteEngine: ProductModules['PGLiteEngine'] }>('src/core/pglite-engine.ts'),
    load<{ importFromContent: ProductModules['importFromContent'] }>('src/core/import-file.ts'),
    load<{ dispatchToolCall: ProductModules['dispatchToolCall'] }>('src/mcp/dispatch.ts'),
    load<{ runExtractConversationFactsCore: ProductModules['runExtractConversationFactsCore'] }>('src/commands/extract-conversation-facts.ts'),
    load<{ resultTokens: ProductModules['resultTokens'] }>('src/core/search/token-budget.ts'),
    load<{ MCP_STDIO_MAX_MESSAGE_BYTES: number }>('src/mcp/server.ts'),
    load<{ KNOWN_CONFIG_KEYS: readonly string[] }>('src/core/config.ts'),
    load<{ NoticeLedger: ProductModules['NoticeLedger'] }>('src/core/notice-ledger.ts'),
    load<{ runRepairCommand: ProductModules['runRepairCommand'] }>('src/commands/repair.ts'),
  ]);
  const missing = C8K_KEYS.filter(k => !cfg.KNOWN_CONFIG_KEYS.includes(k));
  if (missing.length) throw new Error(`this gbrain build does not register ${missing.join(', ')} (needs the GBRA-205 wave, 6f82a94e or later)`);
  return { PGLiteEngine: pg.PGLiteEngine, importFromContent: imp.importFromContent, dispatchToolCall: disp.dispatchToolCall, runExtractConversationFactsCore: ext.runExtractConversationFactsCore,
    resultTokens: tb.resultTokens, stdioFrameBytes: srv.MCP_STDIO_MAX_MESSAGE_BYTES, knownConfigKeys: cfg.KNOWN_CONFIG_KEYS, NoticeLedger: nl.NoticeLedger,
    runRepairCommand: rep.runRepairCommand };
}

/**
 * The dispatch options of a local stdio agent: what `gbrain serve`'s CallTool handler passes (src/mcp/server.ts) for a
 * brain with one source and no GBRAIN_SOURCE, minus the hot-memory `_meta` hook (never model-visible) and the
 * per-session tool reveal. Rows are the transport default for remote callers (lean).
 */
export function stdioDispatchOpts(m: ProductModules, databasePath: string): Record<string, unknown> {
  return { remote: true, admissionOrigin: 'interactive', transport: 'stdio', inboundFrameBytes: m.stdioFrameBytes, takesHoldersAllowList: ['world'], sourceId: 'default', surface: 'full',
    config: { engine: 'pglite', database_path: databasePath }, logger: { info() {}, warn() {}, error() {}, debug() {} } };
}

/** A history's brain directory name inside the custody root: opaque, stable. */
export const brainName = (conversation: string) => `b-${createHash('sha256').update(`c8k-brain\u0000${conversation}`).digest('hex').slice(0, 16)}`;

export async function openBrain(m: ProductModules, databasePath: string, settings?: Record<string, string>): Promise<any> {
  const e = new m.PGLiteEngine();
  await e.connect({ database_path: databasePath });
  await e.initSchema();
  if (settings) for (const [k, v] of Object.entries(settings)) await e.setConfig(k, v);
  return e;
}

/** Import one history: each session a conversation page dated with its ISO event time (the shootout's and E2's page). */
export async function importHistory(m: ProductModules, e: any, conv: Corpus['conversations'][number]): Promise<{ sessions: number }> {
  for (const s of conv.sessions) {
    const src = opaqueSourceId(conv.id, s.id);
    const page = renderSessionPage({ id: src, date: eventTimeOf(s) ?? s.date, turns: s.turns.map(t => ({ speaker: t.speaker, content: t.content })) }, { as: 'conversation' });
    await m.importFromContent(e, slugOf(src), page, {});
  }
  return { sessions: conv.sessions.length };
}

/**
 * gbrain's operator remedy for the doctor's safe_index_pending check, run in process exactly as the CLI runs it:
 * `gbrain repair safe-chunks --source default --json` (preview), then the same with `--apply` (embedding as normal).
 * Fact extraction writes an extract_receipt page that is never chunked, so without it every remote query reports
 * safe_index_pending and every arm's evidence carries a degraded-recall block. safe-chunks is not preview-bound, so the
 * preview prints no --expect hash. Returns the preview's and the apply's counts and the pages still below the fence.
 */
export async function repairSafeChunks(m: ProductModules, e: any): Promise<{ previewed: number; applied: number; failed: number; complete: boolean; pending_after: number }> {
  const run = async (args: string[]) => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (...xs: unknown[]) => { lines.push(xs.map(String).join(' ')); };
    try { await m.runRepairCommand(e, ['safe-chunks', '--source', 'default', ...args, '--json']); } finally { console.log = log; }
    const out = JSON.parse(lines.join('\n')) as { results: Array<{ kind: string; affected: number; applied: number; failed: unknown[]; complete: boolean; stopped?: { reason: string; message: string } }> };
    const r = out.results.find(x => x.kind === 'safe-chunks');
    if (!r) throw new Error('gbrain repair safe-chunks returned no safe-chunks result');
    if (r.stopped) throw new Error(`gbrain repair safe-chunks stopped: ${r.stopped.reason}: ${r.stopped.message}`);
    return r;
  };
  const preview = await run([]);
  const apply = preview.affected ? await run(['--apply']) : { applied: 0, failed: [], complete: true };
  const [left] = await e.executeRaw(`SELECT COUNT(*)::int AS n FROM pages WHERE deleted_at IS NULL AND chunker_version < 4`);
  return { previewed: preview.affected, applied: apply.applied, failed: apply.failed.length, complete: apply.complete, pending_after: Number(left?.n ?? 0) };
}

/** Saved facts that are not extraction audit rows, per visibility. */
export async function factCounts(e: any): Promise<{ facts: number; world: number; sources: number }> {
  const [r] = await e.executeRaw(`SELECT COUNT(*)::int AS facts, COUNT(*) FILTER (WHERE visibility = 'world')::int AS world, COUNT(DISTINCT source_markdown_slug)::int AS sources FROM facts
    WHERE expired_at IS NULL AND source NOT LIKE 'cli:extract-conversation-facts:terminal%' AND source NOT LIKE 'cli:extract-conversation-facts:non-extractable%'`);
  return { facts: Number(r?.facts ?? 0), world: Number(r?.world ?? 0), sources: Number(r?.sources ?? 0) };
}

/** Write an arm's keys and read them back; every other GBRA-205 key must be unset. */
export async function setArmKeys(e: any, arm: C8kArm): Promise<Record<string, string | null>> {
  for (const [k, v] of Object.entries(arm.keys)) await e.setConfig(k, v);
  const read: Record<string, string | null> = {};
  for (const k of C8K_KEYS) read[k] = (await e.getConfig(k)) ?? null;
  const wrong = C8K_KEYS.filter(k => read[k] !== (arm.keys[k] ?? null));
  if (wrong.length) throw new Error(`${arm.id}: keys did not land as the arm defines (${wrong.map(k => `${k}=${JSON.stringify(read[k])}`).join(', ')})`);
  return read;
}

export async function clearArmKeys(e: any): Promise<void> {
  await e.executeRaw('DELETE FROM config WHERE key = ANY($1::text[])', [[...C8K_KEYS]]);
  for (const k of C8K_KEYS) if ((await e.getConfig(k)) != null) throw new Error(`${k} is still set after the arm`);
}

export interface EvidenceRow {
  question_id: string; haystack_id: string; arm: string; request: Record<string, unknown>; keys: Record<string, string | null>;
  blocks: string[]; is_error: boolean; text_sha256: string; delivery: Record<string, any> | null; degraded: unknown; notices: string[]; service_ms: number;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const blocksSha = (blocks: readonly string[]) => sha256(JSON.stringify(blocks));

/**
 * One live query through the stdio dispatch; the evidence is the result's text blocks. Each call gets a fresh notice
 * ledger, as the first call of a new stdio session: the process ledger admits a deduplicated notice (a filter hint) once
 * per process, so a shared one would hand it to whichever arm asked first and drop it from the repeat.
 */
export async function queryArm(m: ProductModules, e: any, opts: Record<string, unknown>, arm: C8kArm, q: Pick<MemoryQuestion, 'id' | 'conversation' | 'question'>, keys: Record<string, string | null>): Promise<EvidenceRow> {
  const request = { query: q.question, ...arm.params };
  const t0 = performance.now();
  const res = await m.dispatchToolCall(e, 'query', request, { ...opts, noticeLedger: new m.NoticeLedger() });
  const service_ms = Math.round((performance.now() - t0) * 10) / 10;
  const blocks = res.content.filter(c => c.type === 'text').map(c => c.text ?? '');
  const meta = res._meta ?? {};
  const notices = ((meta.gbrain_notices ?? []) as Array<{ code?: string }>).map(n => String(n?.code ?? 'unknown'));
  return { question_id: q.id, haystack_id: q.conversation, arm: arm.id, request, keys, blocks, is_error: res.isError === true, text_sha256: blocksSha(blocks),
    delivery: meta.retrieval?.delivery ?? null, degraded: meta.retrieval?.degraded ?? null, notices, service_ms };
}

// ─── The product-text renderer ─────────────────────────────────────

export const RENDERER_VERSION = 'c8k-product-text-v1';
export const READER_TEMPLATE_SHA256 = sha256(READER_TEMPLATE);
export const RENDER_RECIPE = Object.freeze({
  renderer: RENDERER_VERSION, template: 'memory-qa READER_TEMPLATE', template_sha256: READER_TEMPLATE_SHA256, history: 'the tool result text blocks in returned order, joined by one blank line',
  budget_tokens: HARNESS_BUDGET_TOKENS, tokenizer: 'approx-chars-div-4', cut: 'whole rows from the end of the first block\'s JSON array, re-serialized with JSON.stringify, while the history is over the budget',
  date: 'question_date, else unknown', substitution: 'one pass over {history}, {date} and {question}',
});
export const RECIPE_HASH = sha256(JSON.stringify(RENDER_RECIPE));

export interface RenderedContext { prompt: string; prompt_sha256: string; tokens: number; rows_total: number | null; rows_kept: number | null; rows_cut: number; slugs: string[]; recipe_hash: string }

/** The reader's history: the result's blocks with the first block's rows cut whole from the end until it fits. */
export function productHistory(blocks: readonly string[], budgetTokens = HARNESS_BUDGET_TOKENS): { text: string; rows: unknown[] | null; kept: number; cut: number } {
  const rest = blocks.slice(1);
  let rows: unknown[] | null = null;
  try { const parsed = JSON.parse(blocks[0] ?? ''); if (Array.isArray(parsed)) rows = parsed; } catch { rows = null; }
  if (!rows) return { text: blocks.join('\n\n'), rows: null, kept: 0, cut: 0 };
  const text = (k: number) => [JSON.stringify(rows!.slice(0, k)), ...rest].join('\n\n');
  let k = rows.length;
  while (k > 0 && approxTokens(text(k)) > budgetTokens) k--;
  if (k < rows.length && JSON.stringify(rows) !== blocks[0]) throw new Error('the first block does not round-trip through JSON; a cut would change the bytes of the rows it keeps');
  return { text: k === rows.length ? blocks.join('\n\n') : text(k), rows, kept: k, cut: rows.length - k };
}

export function renderContext(blocks: readonly string[], q: Pick<MemoryQuestion, 'question' | 'question_date'>, budgetTokens = HARNESS_BUDGET_TOKENS): RenderedContext {
  const h = productHistory(blocks, budgetTokens);
  const values: Record<string, string> = { history: h.text, date: q.question_date ?? 'unknown', question: q.question };
  const prompt = READER_TEMPLATE.replace(/\{(history|date|question)\}/g, (_, k: string) => values[k]);
  const slugs = h.rows ? [...new Set((h.rows.slice(0, h.kept) as Array<{ slug?: unknown }>).map(r => typeof r?.slug === 'string' ? r.slug : '').filter(Boolean))] : [];
  return { prompt, prompt_sha256: sha256(prompt), tokens: approxTokens(h.text), rows_total: h.rows ? h.rows.length : null, rows_kept: h.rows ? h.kept : null, rows_cut: h.cut, slugs, recipe_hash: RECIPE_HASH };
}

/** The rows of a result's first block, or [] when it is not a rows array. */
export function resultRows(blocks: readonly string[]): Array<Record<string, any>> {
  try { const p = JSON.parse(blocks[0] ?? ''); return Array.isArray(p) ? p : []; } catch { return []; }
}

/** Saved-fact rows of a result (the facts block's rows and any facts-arm row). */
export const factRows = (rows: ReadonlyArray<Record<string, any>>) => rows.filter(r => r.result_type === 'fact' || r.fact_row != null || (typeof r.id === 'string' && r.id.startsWith('gbrain-fact:')));

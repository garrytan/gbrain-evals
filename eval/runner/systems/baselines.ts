/**
 * The three D1 controls of the open-source memory shootout, behind the same
 * `MemorySystem` interface as every product, so the same sanitizer, renderer,
 * packer and outcome accounting apply to them:
 *
 *   full-context  the whole namespace history, one item per session
 *                 (provenance exact), ranked most recent first so the packer
 *                 drops the earliest sessions first, like a chat window. The
 *                 reader sees the kept sessions in chronological order
 *                 (capability `presentation: event-time`); with no budget it
 *                 sees everything, where it fits.
 *                 Its rows carry no recall: returning everything is not a
 *                 ranking (capability `retrieval_metrics: not-applicable`).
 *                 Two Q1 modes name it by kind: `baseline-recency` (the same
 *                 items under a token budget: the most recent sessions that
 *                 fit) and `baseline-full-context` (the whole history, no
 *                 budget). The whole history is checked against each
 *                 reader's window (`READER_WINDOWS`) and refused with outcome
 *                 `does_not_fit` when it does not fit; `answerFullContext`
 *                 marks the history as a per-conversation prompt-cache
 *                 prefix, so later questions on one conversation read it
 *                 from the cache.
 *   no-memory     stores nothing and returns no items: the reader answers
 *                 from the question alone. Its rows carry no recall either.
 *   plain-hybrid  the simplest search a team would build: one row per
 *                 session in Postgres (PGlite), full-text search
 *                 (`websearch_to_tsquery`, `ts_rank_cd`) and pgvector cosine
 *                 search over OpenAI `text-embedding-3-large` at 1,536
 *                 dimensions, fused by reciprocal rank (k = 60). It reuses the
 *                 Cat 40 `pg` arm's table and embedder (cat40/pg-arm.ts), which
 *                 sends embedding calls to OPENAI_BASE_URL, so a cell meters
 *                 them through its lease proxy. No gbrain code runs.
 */
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { PG_EMBED_DIMS, PG_EMBED_MODEL, type Embedder } from '../cat40/pg-arm.ts';
import { decideError } from '../decisions/errors.ts';
import type { Outcome } from '../memory-qa/outcomes.ts';
import { sendsTemperature } from '../memory-qa/qa.ts';
import { answerUsage, normalizeUsage } from '../q1/usage.ts';
import { SystemError, type CapabilityRecord, type DeleteResult, type FinishResult, type IngestResult, type Item, type MemorySystem, type PublicQuestion, type RetrievalPolicy, type RetrieveResult, type SessionInput } from './types.ts';

const sessionText = (s: SessionInput) => s.turns.map(t => `${t.speaker}: ${t.content}`).join('\n');
const record = (system: string, extra: Partial<CapabilityRecord>): CapabilityRecord => ({
  system, protocol: 1, versions: { package: 'in-repo', lock_sha256: null, image: null, vendor_benchmark_code: null },
  configs: { common: { model_roles: {}, notes: 'harness control' } }, time: 'in-text', provenance: { status: 'exact', mechanism: 'one item per ingested session' },
  delete: 'native', readiness: 'synchronous', namespace: 'in-process', parallel_namespaces: false, retrieval_policies: { 'vendor-default': { settings: {} }, 'fixed-evidence': { settings: {} } },
  streaming: 'disabled', telemetry_off: [], agent_surface: { kind: 'none' }, deviations_from_vendor_code: [], ...extra,
});
const checkMode = (p: RetrievalPolicy) => { if (p?.mode !== 'vendor-default' && p?.mode !== 'fixed-evidence') throw new SystemError('invalid_request', 'policy.mode must be vendor-default or fixed-evidence', 400); };

export type FullContextMode = 'whole-history' | 'recency';
export const FULL_CONTEXT_IDS: Readonly<Record<FullContextMode, string>> = { 'whole-history': 'baseline-full-context', recency: 'baseline-recency' };

export class FullContextSystem implements MemorySystem {
  readonly name: string;
  private store = new Map<string, Array<{ src: string; text: string; event_time: string | null }>>();
  /** No mode keeps the shootout's `full-context` system byte for byte; a mode names the Q1 kind. */
  constructor(readonly mode: FullContextMode | null = null) { this.name = mode ? FULL_CONTEXT_IDS[mode] : 'full-context'; }
  async capabilities() {
    const base = { readiness: 'synchronous; retrieval returns every ingested session, most recent first', retrieval_metrics: 'not-applicable', presentation: 'event-time' };
    if (this.mode === 'whole-history') return record(this.name, { ...base, budget: 'none: the whole history', fit: 'checked per reader against READER_WINDOWS; outcome does_not_fit when the history does not fit', prompt_cache: 'per conversation: the history is the cached prefix' });
    if (this.mode === 'recency') return record(this.name, { ...base, budget: 'the arm\'s token budget; the packer keeps the most recent sessions that fit' });
    return record('full-context', base);
  }
  async reset(ns: string) { this.store.delete(ns); }
  async ingestSession(ns: string, s: SessionInput, event_time: string | null): Promise<IngestResult> {
    const list = this.store.get(ns) ?? [];
    this.store.set(ns, [...list.filter(x => x.src !== s.source_id), { src: s.source_id, text: sessionText(s), event_time }]);
    return { items_created: 1, warnings: [], errors: [], completeness: 'known' };
  }
  async finishIngest(): Promise<FinishResult> { return { ready: true, waited_ms: 0, completeness: 'known' }; }
  async retrieve(ns: string, _q: PublicQuestion, policy: RetrievalPolicy): Promise<RetrieveResult> {
    checkMode(policy);
    const items: Item[] = [...(this.store.get(ns) ?? [])].reverse().map((x, i) => ({ id: x.src, rank: i + 1, type: 'episode', text: x.text, source_ids: [x.src], valid_from: x.event_time, valid_to: null, provenance_status: 'exact' }));
    return { items, applied_settings: { order: 'most recent first', items: items.length }, truncated: false };
  }
  async deleteSource(ns: string, src: string): Promise<DeleteResult> {
    const list = this.store.get(ns) ?? [];
    this.store.set(ns, list.filter(x => x.src !== src));
    return { status: list.some(x => x.src === src) ? 'deleted' : 'partial', receipt: {} };
  }
}

export class NoMemorySystem implements MemorySystem {
  readonly name = 'no-memory';
  async capabilities() { return record('no-memory', { time: 'none', provenance: { status: 'unavailable', mechanism: 'stores nothing' }, delete: 'native', readiness: 'nothing to wait for', retrieval_metrics: 'not-applicable' }); }
  async reset(_ns: string) {}
  async ingestSession(_ns: string, _s: SessionInput, _event_time: string | null): Promise<IngestResult> { return { items_created: 0, warnings: [], errors: [], completeness: 'known' }; }
  async finishIngest(): Promise<FinishResult> { return { ready: true, waited_ms: 0, completeness: 'known' }; }
  async retrieve(_ns: string, _q: PublicQuestion, policy: RetrievalPolicy): Promise<RetrieveResult> { checkMode(policy); return { items: [], applied_settings: {}, truncated: false }; }
  async deleteSource(_ns: string, _src: string): Promise<DeleteResult> { return { status: 'deleted', receipt: { stored: false } }; }
}

const lit = (v: number[]) => `[${v.join(',')}]`;

export class PlainHybridSystem implements MemorySystem {
  readonly name = 'plain-hybrid';
  static readonly POLICIES = { 'vendor-default': { k: 10 }, 'fixed-evidence': { k: 30 } } as const;
  static readonly POOL = 50;
  static readonly RRF_K = 60;
  private db: PGlite | null = null;
  constructor(private embed: Embedder, private embedderId = `openai:${PG_EMBED_MODEL}@${PG_EMBED_DIMS}`) {}

  async capabilities() {
    return record('plain-hybrid', {
      configs: { common: { model_roles: { embedder: this.embedderId, dims: PG_EMBED_DIMS }, notes: 'Postgres full-text plus pgvector cosine, reciprocal-rank fusion; whole sessions; embedding input cut at 24,000 characters' } },
      retrieval_policies: { 'vendor-default': { settings: { ...PlainHybridSystem.POLICIES['vendor-default'] } }, 'fixed-evidence': { settings: { ...PlainHybridSystem.POLICIES['fixed-evidence'] } } }, readiness: 'synchronous: a session is searchable once its row is written',
    });
  }

  private async open(): Promise<PGlite> {
    if (this.db) return this.db;
    const db = await PGlite.create({ extensions: { vector } });
    await db.exec(`CREATE EXTENSION IF NOT EXISTS vector;
      CREATE TABLE sessions (ns text NOT NULL, src text NOT NULL, body text NOT NULL, event_time text, tsv tsvector, embedding vector(${PG_EMBED_DIMS}), PRIMARY KEY (ns, src));
      CREATE INDEX sessions_tsv ON sessions USING gin(tsv);`);
    return this.db = db;
  }

  async reset(ns: string) { await (await this.open()).query('DELETE FROM sessions WHERE ns = $1', [ns]); }

  async ingestSession(ns: string, s: SessionInput, event_time: string | null): Promise<IngestResult> {
    const db = await this.open();
    const body = sessionText(s);
    const [v] = await this.embed([body]);
    await db.query(`INSERT INTO sessions (ns, src, body, event_time, tsv, embedding) VALUES ($1, $2, $3, $4, to_tsvector('english', $3), $5::vector)
      ON CONFLICT (ns, src) DO UPDATE SET body = EXCLUDED.body, event_time = EXCLUDED.event_time, tsv = EXCLUDED.tsv, embedding = EXCLUDED.embedding`, [ns, s.source_id, body, event_time, lit(v)]);
    return { items_created: 1, warnings: [], errors: [], completeness: 'known' };
  }

  async finishIngest(): Promise<FinishResult> { return { ready: true, waited_ms: 0, completeness: 'known' }; }

  async retrieve(ns: string, q: PublicQuestion, policy: RetrievalPolicy): Promise<RetrieveResult> {
    checkMode(policy);
    const db = await this.open();
    const k = Number(policy.settings?.k ?? PlainHybridSystem.POLICIES[policy.mode].k);
    const t0 = performance.now();
    const [v] = await this.embed([q.text]);
    const kw = await db.query(`SELECT src FROM sessions, websearch_to_tsquery('english', $2) query WHERE ns = $1 AND tsv @@ query ORDER BY ts_rank_cd(tsv, query) DESC, src LIMIT ${PlainHybridSystem.POOL}`, [ns, q.text]);
    const vec = await db.query(`SELECT src FROM sessions WHERE ns = $1 ORDER BY embedding <=> $2::vector, src LIMIT ${PlainHybridSystem.POOL}`, [ns, lit(v)]);
    const score = new Map<string, number>();
    for (const list of [kw.rows, vec.rows] as Array<Array<{ src: string }>>) list.forEach((r, i) => score.set(r.src, (score.get(r.src) ?? 0) + 1 / (PlainHybridSystem.RRF_K + i + 1)));
    const top = [...score.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, k).map(([src]) => src);
    const rows = top.length ? (await db.query(`SELECT src, body, event_time FROM sessions WHERE ns = $1 AND src = ANY($2)`, [ns, top])).rows as Array<{ src: string; body: string; event_time: string | null }> : [];
    const bySrc = new Map(rows.map(r => [r.src, r]));
    const items: Item[] = top.map((src, i) => ({ id: src, rank: i + 1, type: 'episode', text: bySrc.get(src)!.body, source_ids: [src], valid_from: bySrc.get(src)!.event_time, valid_to: null, provenance_status: 'exact' }));
    return { items, applied_settings: { k, pool: PlainHybridSystem.POOL, rrf_k: PlainHybridSystem.RRF_K, embedder: this.embedderId }, truncated: false, service_ms: performance.now() - t0 };
  }

  async deleteSource(ns: string, src: string): Promise<DeleteResult> {
    const r = await (await this.open()).query('DELETE FROM sessions WHERE ns = $1 AND src = $2', [ns, src]);
    return { status: (r.affectedRows ?? 0) > 0 ? 'deleted' : 'partial', receipt: { rows: r.affectedRows ?? 0 } };
  }

  async close() { await this.db?.close(); this.db = null; }
}

// ─── True full context: reader windows, fit check, cached reading ───

/**
 * The three frontier readers of every Q1 counted row: the newest Opus, GPT and Sonnet (CLAUDE.md "Choose models").
 * Fable is smoke-test only (Garry, 2026-10-07): it never reads a counted cell, practice round or held-out run, so it is
 * not in this list. Its window stays in READER_WINDOWS for labeled smoke cells.
 */
export const FRONTIER_READERS = ['anthropic:claude-opus-5-5', 'openai:gpt-6.1-sol', 'anthropic:claude-sonnet-5-5'] as const;
/** Readers allowed only in a labeled smoke cell, never in a counted one. */
export const SMOKE_ONLY_READERS = ['anthropic:claude-fable-5-1'] as const;

export interface ReaderWindow {
  /** Input plus output tokens per request. */
  context_window: number;
  /** The provider's own input ceiling, when it is below the window. */
  max_input_tokens: number;
  max_output_tokens: number;
  source: string;
}

/** Every reader's context window, in one place. Checked 2026-10-06 on the providers' model pages. */
export const READER_WINDOWS: Readonly<Record<string, ReaderWindow>> = {
  'anthropic:claude-opus-5-5': { context_window: 1_000_000, max_input_tokens: 1_000_000, max_output_tokens: 128_000, source: 'platform.claude.com/docs/en/models/overview, 2026-10-06' },
  'anthropic:claude-sonnet-5-5': { context_window: 1_000_000, max_input_tokens: 1_000_000, max_output_tokens: 128_000, source: 'platform.claude.com/docs/en/models/overview, 2026-10-06' },
  'anthropic:claude-fable-5-1': { context_window: 1_000_000, max_input_tokens: 1_000_000, max_output_tokens: 128_000, source: 'platform.claude.com/docs/en/models/overview, 2026-10-06' },
  'openai:gpt-6.1-sol': { context_window: 1_050_000, max_input_tokens: 922_000, max_output_tokens: 128_000, source: 'developers.openai.com/api/docs/models/gpt-6.1-sol, 2026-10-06' },
};

export function readerWindow(reader: string): ReaderWindow {
  const w = READER_WINDOWS[reader];
  if (w) return w;
  throw decideError({
    code: 'SPEC_INVALID', message: `reader ${reader} has no context window in READER_WINDOWS, so the full-context fit check cannot run`,
    why: 'the full-context baseline refuses a history that does not fit the reader instead of letting the provider cut or reject it',
    fix: { next: 'report', user_message: `look up ${reader}'s context window and input limit on the provider's model page and add them to READER_WINDOWS in eval/runner/systems/baselines.ts`, verify: ['grep', '-n', reader, 'eval/runner/systems/baselines.ts'] },
  });
}

export interface FitTokenizer { id: string; count: (text: string) => number }

/**
 * Leans high on purpose (about 4 characters per token is typical English):
 * an over-count refuses a history near the edge, an under-count would send a
 * request the provider rejects. A cell with real tokenizers passes its own.
 */
export const FIT_TOKENIZER: FitTokenizer = { id: 'chars-div-3', count: text => Math.ceil(text.length / 3) };

export interface FitCheck { reader: string; fits: boolean; prompt_tokens: number; output_tokens: number; max_input_tokens: number; context_window: number; tokenizer: string }

export function checkFit(reader: string, prompt: string, outputTokens: number, tokenizer: FitTokenizer = FIT_TOKENIZER): FitCheck {
  const w = readerWindow(reader);
  const n = tokenizer.count(prompt);
  return { reader, fits: n <= w.max_input_tokens && n + outputTokens <= w.context_window, prompt_tokens: n, output_tokens: outputTokens, max_input_tokens: w.max_input_tokens, context_window: w.context_window, tokenizer: tokenizer.id };
}

/** The history prefix of a reading prompt and the per-question rest (`Current Date:` onward); joined they are the prompt byte for byte. */
export function splitForCache(prompt: string): { prefix: string; suffix: string } {
  const i = prompt.lastIndexOf('Current Date: ');
  return i < 0 ? { prefix: prompt, suffix: '' } : { prefix: prompt.slice(0, i), suffix: prompt.slice(i) };
}

export interface FullContextAnswer {
  text: string;
  outcome: Outcome;
  fit: FitCheck;
  usage: { input: number; output: number; cache_read: number; cache_write: number };
  provider_input_tokens: number;
  latency_ms: number;
  cache_key: string;
  error?: string;
}

const TOO_LONG = /prompt is too long|context[_ ]length|context window|maximum context|too many (input )?tokens|input is too long|exceeds the context/i;
const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);
/** The preregistration's reader effort, sent on every whole-history reading unless the caller names another. */
export const FULL_CONTEXT_EFFORT = 'medium';

/**
 * One whole-history reading. Refuses with `does_not_fit` before any call
 * when the prompt does not fit the reader, and when the provider rejects it
 * as too long. Anthropic readers get the history as a `cache_control`
 * prefix; OpenAI readers get the same bytes with `prompt_cache_key` set to
 * the conversation, so its automatic prefix cache routes them together.
 * Request parameters match `ChatClient` (qa.ts) so only caching differs, reasoning effort included (default
 * `medium`, OpenAI `reasoning_effort`, Anthropic `output_config.effort`; the effort is part of the prompt-cache key).
 */
export async function answerFullContext(opts: { reader: string; prompt: string; conversation: string; maxOutputTokens?: number; tokenizer?: FitTokenizer; fetchImpl?: typeof fetch; effort?: string }): Promise<FullContextAnswer> {
  const outputTokens = opts.maxOutputTokens ?? 1024;
  const effort = opts.effort ?? FULL_CONTEXT_EFFORT;
  const fit = checkFit(opts.reader, opts.prompt, outputTokens, opts.tokenizer);
  const cache_key = createHash('sha256').update(`full-context\u0000${opts.conversation}\u0000${effort}`).digest('hex').slice(0, 32);
  const empty = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  if (!fit.fits) return { text: '', outcome: 'does_not_fit', fit, usage: empty, provider_input_tokens: 0, latency_ms: 0, cache_key };
  const [prov, model] = [opts.reader.slice(0, opts.reader.indexOf(':')), opts.reader.slice(opts.reader.indexOf(':') + 1)];
  const { prefix, suffix } = splitForCache(opts.prompt);
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const request: { url: string; headers: Record<string, string>; body: unknown } = prov === 'anthropic'
    ? { url: `${(process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`, headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01' },
      body: { model, max_tokens: outputTokens, ...(sendsTemperature(`anthropic:${model}`) ? { temperature: 0 } : {}), output_config: { effort }, messages: [{ role: 'user', content: [{ type: 'text', text: prefix, cache_control: { type: 'ephemeral' } }, ...(suffix ? [{ type: 'text', text: suffix }] : [])] }] } }
    : { url: `${(process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`, headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}` },
      body: /^(gpt-[5-9]|o\d)/.test(model)
        ? { model, messages: [{ role: 'user', content: opts.prompt }], n: 1, max_completion_tokens: Math.max(outputTokens, 2000), reasoning_effort: effort, prompt_cache_key: cache_key }
        : { model, messages: [{ role: 'user', content: opts.prompt }], n: 1, temperature: 0, max_tokens: outputTokens, reasoning_effort: effort, prompt_cache_key: cache_key } };
  const t0 = performance.now();
  let last = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetchImpl(request.url, { method: 'POST', headers: { 'content-type': 'application/json', ...request.headers }, body: JSON.stringify(request.body), signal: AbortSignal.timeout(600_000) });
    const json = await res.json().catch(() => ({})) as any;
    if (res.ok) {
      const u = normalizeUsage(prov === 'anthropic' ? 'anthropic' : 'openai', json.usage);
      const text = prov === 'anthropic' ? (json.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('') : String(json.choices?.[0]?.message?.content ?? '');
      return { text, outcome: 'scored', fit, usage: answerUsage(u), provider_input_tokens: u.total_input, latency_ms: performance.now() - t0, cache_key };
    }
    last = `${prov} ${res.status}: ${JSON.stringify(json?.error ?? json).slice(0, 300)}`;
    if (res.status === 400 && TOO_LONG.test(last)) return { text: '', outcome: 'does_not_fit', fit: { ...fit, fits: false }, usage: empty, provider_input_tokens: 0, latency_ms: performance.now() - t0, cache_key, error: last };
    if (!RETRYABLE.has(res.status) || /budget/i.test(last)) break;
    await new Promise(r => setTimeout(r, 2000 * 2 ** attempt));
  }
  return { text: '', outcome: 'reader_error', fit, usage: empty, provider_input_tokens: 0, latency_ms: performance.now() - t0, cache_key, error: last };
}

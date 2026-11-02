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
 *                 them through its lease proxy. Sessions are buffered and
 *                 embedded 16 requests at a time, still one session per
 *                 request, and every write ends with a CHECKPOINT (see
 *                 `write`). No gbrain code runs.
 */
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { PG_EMBED_DIMS, PG_EMBED_MODEL, type Embedder } from '../cat40/pg-arm.ts';
import { decideError } from '../decisions/errors.ts';
import type { Outcome } from '../memory-qa/outcomes.ts';
import { sendsTemperature } from '../memory-qa/qa.ts';
import type { ReaderAttempt } from '../memory-qa/records.ts';
import { compatDeadlineMs } from '../metering-proxy.ts';
import { COMPAT_PROVIDERS, compatMayHaveBilled, compatRequest, compatSend, type CompatRequest } from '../providers/openai-compatible.ts';
import { answerUsage, normalizeUsage } from '../q1/usage.ts';
import { normalizeUsage as receiptUsage, usageSourceOf } from '../usage-receipt.ts';
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
  /** Sessions buffered per namespace before they are embedded and written. */
  static readonly FLUSH_AT = 256;
  /**
   * Embedding requests in flight while a buffer is written. Each request still carries one session: the embeddings
   * endpoint returns slightly different vectors for a text sent inside a multi-input batch, which reorders retrieval.
   */
  static readonly EMBED_CONCURRENCY = 16;
  private db: PGlite | null = null;
  private pending = new Map<string, Array<{ src: string; body: string; event_time: string | null }>>();
  private lost = new Map<string, number>();
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private embed: Embedder, private embedderId = `openai:${PG_EMBED_MODEL}@${PG_EMBED_DIMS}`) {}

  async capabilities() {
    return record('plain-hybrid', {
      configs: { common: { model_roles: { embedder: this.embedderId, dims: PG_EMBED_DIMS }, notes: 'Postgres full-text plus pgvector cosine, reciprocal-rank fusion; whole sessions; embedding input cut at 24,000 characters' } },
      retrieval_policies: { 'vendor-default': { settings: { ...PlainHybridSystem.POLICIES['vendor-default'] } }, 'fixed-evidence': { settings: { ...PlainHybridSystem.POLICIES['fixed-evidence'] } } },
      readiness: `synchronous: up to ${PlainHybridSystem.FLUSH_AT} sessions are buffered and embedded ${PlainHybridSystem.EMBED_CONCURRENCY} at a time, one per request; retrieve, delete and finish write every buffered session of the namespace first, so a session is searchable once ingest returns`,
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

  /**
   * Writes run one at a time and end with an explicit CHECKPOINT. PGlite 0.4.3 never returns from the checkpoint that
   * Postgres requests itself once about 540 MB of WAL builds up (max_wal_size 1 GB): at BEAM-10M scale that froze the
   * S1 ingest after about 21,500 sessions. Checkpointing after every write keeps the WAL far below that point.
   */
  private write<T>(fn: (db: PGlite) => Promise<T>): Promise<T> {
    const run = this.writes.then(async () => {
      const db = await this.open();
      try { return await fn(db); } finally { await db.exec('CHECKPOINT'); }
    });
    this.writes = run.catch(() => {});
    return run;
  }

  /** Embeds and upserts every buffered session of `ns` in arrival order; a later copy of a source replaces the earlier one, as upserting one at a time would. */
  private flush(ns: string): Promise<void> {
    if (!this.pending.get(ns)?.length) return this.writes.then(() => {});
    return this.write(async db => {
      const rows = [...new Map((this.pending.get(ns) ?? []).map(r => [r.src, r])).values()];
      this.pending.delete(ns);
      let written = 0, next = 0, failed = false;
      try {
        const vectors: number[][] = new Array(rows.length);
        await Promise.all(Array.from({ length: Math.min(PlainHybridSystem.EMBED_CONCURRENCY, rows.length) }, async () => {
          try { while (next < rows.length && !failed) { const i = next++; [vectors[i]] = await this.embed([rows[i].body]); } } catch (e) { failed = true; throw e; }
        }));
        for (const [i, r] of rows.entries()) {
          await db.query(`INSERT INTO sessions (ns, src, body, event_time, tsv, embedding) VALUES ($1, $2, $3, $4, to_tsvector('english', $3), $5::vector)
            ON CONFLICT (ns, src) DO UPDATE SET body = EXCLUDED.body, event_time = EXCLUDED.event_time, tsv = EXCLUDED.tsv, embedding = EXCLUDED.embedding`, [ns, r.src, r.body, r.event_time, lit(vectors[i])]);
          written++;
        }
      } catch (e) {
        this.lost.set(ns, (this.lost.get(ns) ?? 0) + rows.length - written);
        throw e;
      }
    });
  }

  async reset(ns: string) {
    this.pending.delete(ns);
    this.lost.delete(ns);
    await this.write(db => db.query('DELETE FROM sessions WHERE ns = $1', [ns]));
  }

  async ingestSession(ns: string, s: SessionInput, event_time: string | null): Promise<IngestResult> {
    const queued = this.pending.get(ns) ?? [];
    queued.push({ src: s.source_id, body: sessionText(s), event_time });
    this.pending.set(ns, queued);
    if (queued.length >= PlainHybridSystem.FLUSH_AT) await this.flush(ns);
    return { items_created: 1, warnings: [], errors: [], completeness: 'known' };
  }

  /** Writes what is still buffered. Sessions lost to a failed batch (its error went to the ingest call that sent it) make the namespace not ready. */
  async finishIngest(ns: string, _timeoutS?: number): Promise<FinishResult> {
    const t0 = performance.now();
    await this.flush(ns);
    const lost = this.lost.get(ns) ?? 0;
    return { ready: lost === 0, waited_ms: Math.round(performance.now() - t0), completeness: lost ? 'degraded' : 'known', ...(lost ? { raw: { sessions_not_written: lost } } : {}) };
  }

  async retrieve(ns: string, q: PublicQuestion, policy: RetrievalPolicy): Promise<RetrieveResult> {
    checkMode(policy);
    await this.flush(ns);
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
    await this.flush(ns);
    const r = await this.write(db => db.query('DELETE FROM sessions WHERE ns = $1 AND src = $2', [ns, src]));
    return { status: (r.affectedRows ?? 0) > 0 ? 'deleted' : 'partial', receipt: { rows: r.affectedRows ?? 0 } };
  }

  async close() { await this.writes; await this.db?.close(); this.db = null; this.pending.clear(); this.lost.clear(); }
}

// ─── True full context: reader windows, fit check, cached reading ───

/**
 * The newest frontier readers, Opus and GPT (CLAUDE.md "Choose models"). gbrain and gstack are built for frontier
 * models, so Sonnet and Haiku are never readers under test (Garry, 2026-11-01); Q1's sealed campaign keeps its
 * preregistered three-reader list (COUNTED_READERS in q1/cells/definitions.ts). Fable is smoke-test only (Garry,
 * 2026-10-07): it never reads a counted cell, practice round or held-out run, so it is not in this list. Its window
 * stays in READER_WINDOWS for labeled smoke cells.
 */
export const FRONTIER_READERS = ['anthropic:claude-opus-5-5', 'openai:gpt-6.1-sol'] as const;
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

const PARTICLE_1 = COMPAT_PROVIDERS.particle.models['particle-1'];

/** Every reader's context window, in one place. Checked 2026-10-06 on the providers' model pages; particle-1 from its row in COMPAT_PROVIDERS. */
export const READER_WINDOWS: Readonly<Record<string, ReaderWindow>> = {
  'anthropic:claude-opus-5-5': { context_window: 1_000_000, max_input_tokens: 1_000_000, max_output_tokens: 128_000, source: 'platform.claude.com/docs/en/models/overview, 2026-10-06' },
  'anthropic:claude-sonnet-5-5': { context_window: 1_000_000, max_input_tokens: 1_000_000, max_output_tokens: 128_000, source: 'platform.claude.com/docs/en/models/overview, 2026-10-06' },
  'anthropic:claude-fable-5-1': { context_window: 1_000_000, max_input_tokens: 1_000_000, max_output_tokens: 128_000, source: 'platform.claude.com/docs/en/models/overview, 2026-10-06' },
  'openai:gpt-6.1-sol': { context_window: 1_050_000, max_input_tokens: 922_000, max_output_tokens: 128_000, source: 'developers.openai.com/api/docs/models/gpt-6.1-sol, 2026-10-06' },
  'particle:particle-1': { context_window: PARTICLE_1.context_tokens, max_input_tokens: PARTICLE_1.context_tokens, max_output_tokens: PARTICLE_1.output_ceiling, source: COMPAT_PROVIDERS.particle.source },
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
  /** OpenAI-compatible readers only (records.ts `AnswerRecord`): the answering attempt's finish, whether it stopped at its output limit, and every provider attempt. */
  finish?: string | null;
  truncated?: boolean;
  attempts?: ReaderAttempt[];
  /** The last request timed out, failed in transport other than before it was sent, or was answered 2xx without a message; Particle may have billed it, so the cell never sends it again. */
  timed_out?: boolean;
}

const TOO_LONG = /prompt is too long|context[_ ]length|context window|maximum context|too many (input )?tokens|input is too long|exceeds the context/i;
const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);
/** The preregistration's reader effort, sent on every whole-history reading unless the caller names another. */
export const FULL_CONTEXT_EFFORT = 'medium';

/**
 * One whole-history reading. Refuses with `does_not_fit` before any call
 * when the prompt does not fit the reader, and when the provider rejects it
 * as too long. A lease refusal (the metering proxy's 402 budget) is `budget_not_run`, never a reader
 * error (A23). Anthropic readers get the history as a `cache_control`
 * prefix; OpenAI readers get the same bytes with `prompt_cache_key` set to
 * the conversation, so its automatic prefix cache routes them together.
 * Request parameters match `ChatClient` (qa.ts) so only caching differs, reasoning effort included (default
 * `medium`, OpenAI `reasoning_effort`, Anthropic `output_config.effort`; the effort is part of the prompt-cache key).
 * An OpenAI-compatible reader (COMPAT_PROVIDERS, today particle-1) is built and sent by the provider module, with
 * `prompt_cache_key` set as for OpenAI, its output floor (16,000 for particle-1) as the output limit the fit check
 * counts, and every attempt recorded; Particle's credit 402 is `budget_not_run`.
 */
export async function answerFullContext(opts: { reader: string; prompt: string; conversation: string; maxOutputTokens?: number; tokenizer?: FitTokenizer; fetchImpl?: typeof fetch; effort?: string }): Promise<FullContextAnswer> {
  const effort = opts.effort ?? FULL_CONTEXT_EFFORT;
  const [prov, model] = [opts.reader.slice(0, opts.reader.indexOf(':')), opts.reader.slice(opts.reader.indexOf(':') + 1)];
  const cache_key = createHash('sha256').update(`full-context\u0000${opts.conversation}\u0000${effort}`).digest('hex').slice(0, 32);
  const compat = Object.hasOwn(COMPAT_PROVIDERS, prov) ? compatRequest(opts.reader, [{ role: 'user', content: opts.prompt }], { effort, maxOutputTokens: opts.maxOutputTokens, promptCacheKey: cache_key }) : null;
  const outputTokens = compat ? compat.sent.output_limit : opts.maxOutputTokens ?? 1024;
  const fit = checkFit(opts.reader, opts.prompt, outputTokens, opts.tokenizer);
  const empty = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  if (!fit.fits) return { text: '', outcome: 'does_not_fit', fit, usage: empty, provider_input_tokens: 0, latency_ms: 0, cache_key, ...(compat ? { finish: null, truncated: false, attempts: [] } : {}) };
  if (compat) return readCompat(compat, fit, cache_key, opts.fetchImpl);
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
    if (res.status === 402 && /budget/i.test(last)) return { text: '', outcome: 'budget_not_run', fit, usage: empty, provider_input_tokens: 0, latency_ms: performance.now() - t0, cache_key, error: last };
    if (!RETRYABLE.has(res.status) || /budget/i.test(last)) break;
    await new Promise(r => setTimeout(r, 2000 * 2 ** attempt));
  }
  return { text: '', outcome: 'reader_error', fit, usage: empty, provider_input_tokens: 0, latency_ms: performance.now() - t0, cache_key, error: last };
}

/**
 * A whole-history reading by an OpenAI-compatible reader: one request per attempt of the same 5-attempt loop, sent
 * once each by the provider module. A 429 or 5xx (or a failure before any byte was sent, `compatNeverSent`) is tried again after the provider's
 * Retry-After, capped at 120 seconds, or else the backoff; a context-length 400 is `does_not_fit`; a budget stop
 * (Particle's credit 402, or the lease proxy's own 402) is `budget_not_run` and is never retried. A request gets the
 * metering proxies' upstream deadline, plus the lease proxy's longest admission wait on a loopback proxy slot
 * (`compatDeadlineMs`), and one that times out, fails in transport other than before it was sent or is answered 2xx
 * without a message (`compatMayHaveBilled`) is a `reader_error` that is never sent again, because Particle may have billed it. Each attempt is recorded, the failed ones with null response
 * fields. An answer cut off at its output limit is the answer.
 */
async function readCompat(req: CompatRequest, fit: FitCheck, cache_key: string, fetchImpl?: typeof fetch): Promise<FullContextAnswer> {
  const t0 = performance.now();
  const attempts: ReaderAttempt[] = [];
  const sent = { effort_sent: req.sent.effort_sent, effort_effective: req.sent.effort_effective, output_limit: req.sent.output_limit };
  const source = usageSourceOf(req.model);
  const empty = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  const stop = (outcome: Outcome, error: string): FullContextAnswer => ({ text: '', outcome, fit: outcome === 'does_not_fit' ? { ...fit, fits: false } : fit, usage: empty, provider_input_tokens: 0, latency_ms: performance.now() - t0, cache_key, error, finish: null, truncated: false, attempts });
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await compatSend(req, { fetchImpl, timeoutMs: compatDeadlineMs(req.url) });
      const u = normalizeUsage(source, res.usage);
      attempts.push({ status: 'ok', error: null, from_cache: false, response_model: res.response_model, finish: res.finish, reasoning_tokens: receiptUsage(source, res.usage)?.reasoning ?? null, weight_version: res.meta.weight_version, ...sent, retry_after_ms: null });
      return { text: res.text, outcome: 'scored', fit, usage: answerUsage(u), provider_input_tokens: u.total_input, latency_ms: performance.now() - t0, cache_key, finish: res.finish, truncated: res.finish === 'length', attempts };
    } catch (e) {
      const err = e as Error & { kind?: string; retryable?: boolean; retryAfterMs?: number | null; usage?: Record<string, unknown> | null };
      const message = String(err.message ?? e).slice(0, 300);
      const billed = compatMayHaveBilled(err);
      const again = err.name !== 'BudgetExceededError' && err.kind !== 'context_overflow' && err.retryable !== false && !billed && attempt < 4;
      const wait = again ? err.retryAfterMs ?? null : null;
      attempts.push({ status: 'error', error: message, from_cache: false, response_model: null, finish: null, reasoning_tokens: receiptUsage(source, err.usage)?.reasoning ?? null, weight_version: null, ...sent, retry_after_ms: wait });
      if (err.name === 'BudgetExceededError') return stop('budget_not_run', message);
      if (err.kind === 'context_overflow') return stop('does_not_fit', message);
      if (billed) return { ...stop('reader_error', message), timed_out: true };
      if (!again) return stop('reader_error', message);
      await new Promise(r => setTimeout(r, wait ?? 2000 * 2 ** attempt));
    }
  }
}

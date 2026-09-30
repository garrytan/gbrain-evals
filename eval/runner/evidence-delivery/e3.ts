/**
 * E3 product-path parity (plan amendment 8), run after pilot selection and
 * before the E1 confirmatory run.
 *
 * Each question gets its own on-disk brain (history isolation). The haystack
 * is imported in-process through the shared embedding cache, then gbrain's
 * own MCP server runs over stdio as a remote caller, with the budget ledger
 * preloaded so its query embeddings and reranks are reserved too. Per
 * question and arm it records:
 *   - live retrieval drift: `query` in chunk mode against the frozen top five;
 *   - local/remote parity: `assemble_evidence` over the frozen hits (remote)
 *     against the frozen local fingerprint and delivered tokens;
 *   - product-path parity: `query` with the policy against `assemble_evidence`
 *     over the live hits (the docs' parity recipe);
 *   - containment: every delivered segment is text of that page's body, so
 *     nothing reaches the reader that the page itself does not hold;
 *   - page byte parity against the harness reader's body.
 * Answers are scored from the exact serialized `query` evidence.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpStdioDriver } from '../lifecycle/drivers.ts';
import { buildRequest, type Renderer } from './arms.ts';
import { classifyPageBlock, stripFrontmatter, type PageParityClass } from './parity.ts';
import { sha256 } from './data.ts';
import type { ArmSpec } from './decision.ts';
import type { BlobStore, FrozenQuestion } from './store.ts';

export const OMISSION_LINE = '\n\n[…]\n\n';

/** The docs' evidenceFingerprint formula, recomputed independently to cross-check gbrain's function. */
export function specFingerprint(results: Array<{ source_id?: string; slug: string; chunk_text: string; chunk_id: number; delivered?: { unit?: string; chunk_ids?: number[] } }>): string {
  return sha256(JSON.stringify(results.map(r => [r.source_id ?? 'default', r.slug, r.chunk_text, r.delivered?.unit ?? 'chunk', r.delivered?.chunk_ids ?? [r.chunk_id]])));
}

/** Delivered text split at omission lines; each segment must occur in the page body (whitespace-normalized). */
export function uncontainedSegments(delivered: string, pageBody: string): string[] {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const body = norm(stripFrontmatter(pageBody));
  return delivered.split(OMISSION_LINE).map(norm).filter(seg => seg.length > 0 && !body.includes(seg));
}

export interface McpToolOutput { ok: boolean; raw: string; data: unknown; error?: string; ms: number }

/** Results array from a serialized tool response (query returns a bare array; assemble_evidence an object). */
export function resultsOf(data: unknown): any[] {
  if (Array.isArray(data)) return data;
  const d = data as { results?: unknown } | null;
  return Array.isArray(d?.results) ? d!.results as any[] : [];
}

export interface E3ArmRecord {
  arm: string;
  frozen_fingerprint: string | null;
  remote_assemble_fingerprint: string | null;
  remote_assemble_spec_fingerprint: string | null;
  local_remote_match: boolean | null;
  query_fingerprint: string | null;
  live_assemble_fingerprint: string | null;
  product_path_match: boolean | null;
  frozen_tokens: number | null;
  remote_tokens: number | null;
  tokens_match: boolean | null;
  uncontained_segments: number;
  page_parity?: Record<PageParityClass, number>;
  serialized_query_sha256: string | null;
  serialized_query_tool_tokens: number | null;
  /** When query and assemble_evidence disagree over the same live hits: where the first difference is. */
  mismatch?: { index: number; query: unknown; assemble: unknown };
  errors: string[];
}

export interface E3QuestionRecord {
  question_id: string;
  live_hits_match_frozen: boolean;
  live_sig: string;
  frozen_sig: string;
  arms: E3ArmRecord[];
}

export interface E3Transport {
  call(op: string, args: Record<string, unknown>): Promise<McpToolOutput>;
}

export function armParams(spec: ArmSpec): Record<string, unknown> {
  return { return_unit: spec.unit, ...(spec.return_window ? { return_window: spec.return_window } : {}), ...(spec.budget_tokens ? { token_budget: spec.budget_tokens } : {}) };
}

/** All transport-level comparisons for one question; pure given the transport, so tests can drive it with a stub. */
export async function checkQuestion(t: E3Transport, q: FrozenQuestion, question: string, arms: ArmSpec[], store: Pick<BlobStore, 'get'>, fingerprint: (results: any[]) => string, count: (s: string) => number): Promise<E3QuestionRecord> {
  const live = await t.call('query', { query: question, return_unit: 'chunk', limit: 5, expand: false });
  const liveHits = resultsOf(live.data).slice(0, 5);
  const liveSig = liveHits.map((r: any) => `${r.slug}#${r.chunk_id}`).join(',');
  const frozenSig = q.hits5.map(h => `${h.slug}#${h.chunk_id}`).join(',');
  const toHit = (r: { slug: string; chunk_id: number; source_id?: string }) => ({ source_id: r.source_id ?? 'default', slug: r.slug, chunk_id: r.chunk_id });
  const bodies = new Map(q.pages.map(p => [p.slug, store.get(p.harness_body)]));
  const records: E3ArmRecord[] = [];
  for (const spec of arms) {
    const errors: string[] = [];
    const frozenArm = q.arms[spec.id];
    const params = armParams(spec);
    const remote = await t.call('assemble_evidence', { hits: q.hits5.map(toHit), ...params });
    if (!remote.ok) errors.push(`assemble_evidence(frozen): ${remote.error}`);
    const remoteResults = resultsOf(remote.data);
    const query = await t.call('query', { query: question, limit: 5, expand: false, ...params });
    if (!query.ok) errors.push(`query: ${query.error}`);
    const queryResults = resultsOf(query.data);
    const liveAssemble = await t.call('assemble_evidence', { hits: liveHits.map(toHit), ...params });
    if (!liveAssemble.ok) errors.push(`assemble_evidence(live): ${liveAssemble.error}`);
    const remoteFp = remote.ok ? fingerprint(remoteResults) : null;
    const remoteTokens = remote.ok ? remoteResults.reduce((s: number, r: any) => s + (Number.isFinite(r.delivered?.tokens) ? r.delivered.tokens : 0), 0) : null;
    const frozenTokens = frozenArm?.source === 'product' ? frozenArm.product_encoding_tokens : null;
    let uncontained = 0;
    for (const r of queryResults) uncontained += bodies.has(r.slug) ? uncontainedSegments(r.chunk_text, bodies.get(r.slug)!).length : 0;
    let pageParity: Record<PageParityClass, number> | undefined;
    if (spec.unit === 'page') {
      pageParity = { identical: 0, frontmatter_only: 0, whitespace_only: 0, truncated: 0, missing: 0, other: 0 };
      for (const slug of [...new Set(q.hits5.map(h => h.slug))]) {
        const r = remoteResults.find((x: any) => x.slug === slug);
        pageParity[r ? classifyPageBlock(r.chunk_text, bodies.get(slug) ?? '', !!r.delivered?.truncated) : 'missing']++;
      }
    }
    const liveResults = resultsOf(liveAssemble.data);
    let mismatch: E3ArmRecord['mismatch'];
    if (query.ok && liveAssemble.ok && fingerprint(queryResults) !== fingerprint(liveResults)) {
      const brief = (r: any) => r && { slug: r.slug, chunk_id: r.chunk_id, chars: String(r.chunk_text ?? '').length, text_sha256: sha256(String(r.chunk_text ?? '')), delivered: r.delivered };
      const index = Math.max(0, Array.from({ length: Math.max(queryResults.length, liveResults.length) }, (_, i) => i).find(i => JSON.stringify(brief(queryResults[i])) !== JSON.stringify(brief(liveResults[i]))) ?? 0);
      mismatch = { index, query: queryResults.map(brief), assemble: liveResults.map(brief) };
    }
    records.push({
      arm: spec.id, frozen_fingerprint: frozenArm?.product_fingerprint ?? null, remote_assemble_fingerprint: remoteFp,
      remote_assemble_spec_fingerprint: remote.ok ? specFingerprint(remoteResults) : null,
      local_remote_match: remoteFp && frozenArm?.product_fingerprint ? remoteFp === frozenArm.product_fingerprint : null,
      query_fingerprint: query.ok ? fingerprint(queryResults) : null, live_assemble_fingerprint: liveAssemble.ok ? fingerprint(resultsOf(liveAssemble.data)) : null,
      product_path_match: query.ok && liveAssemble.ok ? fingerprint(queryResults) === fingerprint(resultsOf(liveAssemble.data)) : null,
      frozen_tokens: frozenTokens, remote_tokens: remoteTokens, tokens_match: frozenTokens !== null && remoteTokens !== null ? frozenTokens === remoteTokens : null,
      uncontained_segments: uncontained, ...(pageParity ? { page_parity: pageParity } : {}),
      serialized_query_sha256: query.ok ? sha256(query.raw) : null, serialized_query_tool_tokens: query.ok ? count(query.raw) : null, ...(mismatch ? { mismatch } : {}), errors,
    });
  }
  return { question_id: q.question_id, live_hits_match_frozen: liveSig === frozenSig, live_sig: liveSig, frozen_sig: frozenSig, arms: records };
}

/** The reader request built from the exact serialized `query` evidence (chunk_text bytes as returned over MCP). */
export function requestFromSerialized(r: Renderer, q: FrozenQuestion, question: { question: string; question_date?: string }, serializedResults: any[], model: string, maxTokens: number) {
  const dates = new Map(q.pages.map(p => [p.slug, p.date]));
  const sessions = serializedResults.map(x => ({ session_id: r.sessionIdFromSlug(x.slug), ...(dates.get(x.slug) ? { date: dates.get(x.slug)! } : {}), body: String(x.chunk_text) }));
  return buildRequest(r, question, sessions, model, maxTokens);
}

export interface E3Brain { home: string; env: NodeJS.ProcessEnv; cleanup(): void }

/** A fresh GBRAIN_HOME holding one question's brain; the caller imports the haystack into `databasePath` before starting the server. */
export function makeBrainHome(baseEnv: NodeJS.ProcessEnv): E3Brain & { databasePath: string } {
  const home = mkdtempSync(join(tmpdir(), 'ed-e3-'));
  const databasePath = join(home, 'brain.pglite');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: databasePath, embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536 }, null, 2));
  const env: NodeJS.ProcessEnv = {
    PATH: baseEnv.PATH, HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1',
    OPENAI_API_KEY: baseEnv.OPENAI_API_KEY, VOYAGE_API_KEY: baseEnv.VOYAGE_API_KEY,
    BRAINBENCH_BUDGET_RUN_ID: baseEnv.BRAINBENCH_BUDGET_RUN_ID, BRAINBENCH_BUDGET_LEDGER: baseEnv.BRAINBENCH_BUDGET_LEDGER, BRAINBENCH_PROGRAM_CAP_USD: baseEnv.BRAINBENCH_PROGRAM_CAP_USD,
  };
  return { home, databasePath, env, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** gbrain's MCP server over stdio with the budget ledger preloaded (remote caller). */
export function guardedStdioDriver(gbrainDir: string, env: NodeJS.ProcessEnv): McpStdioDriver {
  return new McpStdioDriver({ buildDir: gbrainDir, env, entry: ['--preload', join(import.meta.dir, 'ledger-preload.ts'), join(gbrainDir, 'src/cli.ts')] });
}


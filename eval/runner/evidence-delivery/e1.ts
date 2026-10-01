/**
 * E1 delivery ablation runner (plan section 4, amendments 5 and 8).
 *
 * Reads only the frozen evidence manifest: every arm's reader request is
 * built from stored bytes, so retrieval, reader, prompt, renderer and judges
 * are fixed and only the delivered evidence changes. Rows record the three
 * token counts separately (product cl100k encoding, serialized tool payload,
 * provider-reported reader input) and the identities needed to audit the
 * run. Resumable: a question whose row has no reader error is skipped; an
 * errored row is re-run and the latest row per question wins.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRequest, requestSha, sessionBlocks, type ReaderSessionBlock, type Renderer } from './arms.ts';
import { agentFetchCall, gbrainJudge, officialJudge, providerInputTokens, readerCall, type ReaderResult } from './calls.ts';
import type { DecisionManifest, OutcomeRow } from './decision.ts';
import type { LmeQuestion } from './data.ts';
import type { GbrainModules } from './gbrain.ts';
import type { BlobStore, FrozenHeader, FrozenQuestion } from './store.ts';

export const SONNET = 'anthropic:claude-sonnet-4-6';
export const GPT4O = 'openai:gpt-4o';

export function rendererFrom(g: GbrainModules): Renderer {
  return {
    system: g.reader.READER_NOTES_SYSTEM_TEXT, maxSessionChars: g.reader.READER_MAX_SESSION_CHARS,
    renderChatBlock: g.sanitize.renderChatBlock, buildReaderUserText: g.reader.buildReaderUserText, sessionIdFromSlug: g.metrics.sessionIdFromSlug,
  };
}

export interface E1Row {
  schema: 'gbrain-evals/evidence-delivery-e1-row/v1';
  arm: string;
  set: string;
  reader_model: string;
  question_id: string;
  question_type: string;
  cluster: string;
  request_sha256: string;
  evidence_sha256: string;
  product_fingerprint: string | null;
  blocks: number;
  sessions_truncated: number;
  duplicate_bodies: number;
  tokens: { tokenizer: 'cl100k'; product_encoding: number; serialized_tool: number | null; provider_input: number | null; provider_output: number | null };
  hypothesis?: string;
  reader?: Omit<ReaderResult, 'text'>;
  reader_error?: string;
  primary: 0 | 1 | null;
  confirmation: 0 | 1 | null;
  judge?: Record<string, unknown>;
  official?: Record<string, unknown>;
  identity: { decision_manifest_sha256: string; frozen_manifest_sha256: string; gbrain_commit: string; evals_commit: string; smoke: boolean };
  ts: string;
}

export function rowsPath(outDir: string, set: string, arm: string, model: string) {
  return join(outDir, 'rows', `${set}__${arm}__${model.replace(/[^a-z0-9.-]+/gi, '_')}.ndjson`);
}

export function readRows(path: string): E1Row[] {
  if (!existsSync(path)) return [];
  const latest = new Map<string, E1Row>();
  for (const line of readFileSync(path, 'utf8').split('\n')) if (line.trim()) { const r = JSON.parse(line) as E1Row; latest.set(r.question_id, r); }
  return [...latest.values()];
}

export function toOutcome(r: E1Row): OutcomeRow {
  return { question_id: r.question_id, question_type: r.question_type, cluster: r.cluster, primary: r.primary, confirmation: r.confirmation, provider_input_tokens: r.tokens.provider_input, reader_error: r.reader_error ?? null, duplicate_bodies: r.duplicate_bodies };
}

export interface E1Job { q: FrozenQuestion; arm: string }

export interface E1Context {
  g: GbrainModules;
  manifest: DecisionManifest;
  manifestSha: string;
  header: FrozenHeader;
  frozenSha: string;
  store: BlobStore;
  questions: Map<string, FrozenQuestion>;
  renderer: Renderer;
  dataset: Map<string, LmeQuestion>;
  clusters: Record<string, string>;
  outDir: string;
  set: string;
  readerModel: string;
  evalsCommit: string;
  smoke: boolean;
}

/** The request an arm sends; agent_fetch starts from the chunk request. */
export function armRequest(ctx: Pick<E1Context, 'store' | 'renderer' | 'dataset' | 'readerModel' | 'manifest'>, q: FrozenQuestion, arm: string) {
  const d = ctx.dataset.get(q.question_id)!;
  const source = arm === 'agent_fetch' ? 'chunk' : arm;
  const frozenArm = q.arms[source];
  if (!frozenArm) throw new Error(`${q.question_id} has no frozen evidence for ${source}`);
  const sessions = sessionBlocks(q, frozenArm.blocks, ctx.store, ctx.renderer);
  const built = buildRequest(ctx.renderer, { question: d.question, question_date: d.question_date }, sessions, ctx.readerModel, ctx.manifest.reader.max_tokens);
  return { ...built, frozenArm };
}

/** get_page targets for E1b: the page arm's blocks, or page_legacy's when the product page arm is absent (smoke only). */
export function agentPages(ctx: Pick<E1Context, 'store' | 'renderer'>, q: FrozenQuestion): Map<string, ReaderSessionBlock> {
  const source = q.arms.page ?? q.arms.page_legacy;
  return new Map(sessionBlocks(q, source.blocks, ctx.store, ctx.renderer).map(b => [b.session_id, b]));
}

export async function runJob(ctx: E1Context, job: E1Job): Promise<E1Row> {
  const { q, arm } = job;
  const d = ctx.dataset.get(q.question_id)!;
  const { request, truncated, frozenArm } = armRequest(ctx, q, arm);
  const row: E1Row = {
    schema: 'gbrain-evals/evidence-delivery-e1-row/v1', arm, set: ctx.set, reader_model: ctx.readerModel, question_id: q.question_id,
    question_type: d.question_type, cluster: ctx.clusters[q.question_id] ?? q.question_id, request_sha256: requestSha(request),
    evidence_sha256: frozenArm.evidence_sha256, product_fingerprint: frozenArm.product_fingerprint ?? null, blocks: frozenArm.blocks.length,
    sessions_truncated: truncated, duplicate_bodies: frozenArm.duplicate_bodies,
    tokens: { tokenizer: 'cl100k', product_encoding: frozenArm.product_encoding_tokens, serialized_tool: frozenArm.serialized_tool_tokens, provider_input: null, provider_output: null },
    primary: null, confirmation: null,
    identity: { decision_manifest_sha256: ctx.manifestSha, frozen_manifest_sha256: ctx.frozenSha, gbrain_commit: ctx.header.gbrain.commit, evals_commit: ctx.evalsCommit, smoke: ctx.smoke },
    ts: new Date().toISOString(),
  };
  let result: ReaderResult;
  try {
    result = arm === 'agent_fetch'
      ? await agentFetchCall(ctx.g, request, agentPages(ctx, q), ctx.renderer, { maxFetches: 5, maxTurns: 6 })
      : await readerCall(ctx.g, request);
  } catch (err: any) {
    if (err?.name === 'BudgetExceededError') throw err;
    row.reader_error = String(err?.message ?? err).slice(0, 300);
    if (err?.partial?.usage) row.tokens.provider_input = providerInputTokens(err.partial.usage);
    return row;
  }
  const { text, ...meta } = result;
  row.hypothesis = text;
  row.reader = meta;
  row.tokens.provider_input = providerInputTokens(result.usage);
  row.tokens.provider_output = result.usage.output_tokens;
  const jq = { question_id: q.question_id, question_type: d.question_type, question: d.question, answer: d.answer };
  const [gj, oj] = await Promise.all([gbrainJudge(ctx.g, jq, text), officialJudge(jq, text)]);
  row.judge = gj;
  row.official = oj;
  row.primary = typeof gj.judge_correct === 'boolean' ? (gj.judge_correct ? 1 : 0) : null;
  row.confirmation = typeof (oj as any).off_judge_correct === 'boolean' ? ((oj as any).off_judge_correct ? 1 : 0) : null;
  return row;
}

export async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  let stop: unknown = null;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length && !stop) {
      const k = i++;
      try { await fn(items[k]); } catch (e) { stop = e; }
    }
  }));
  if (stop) throw stop;
}

export async function runE1(ctx: E1Context, arms: string[], ids: string[], concurrency: number, log: (l: string) => void = l => process.stderr.write(l + '\n')) {
  mkdirSync(join(ctx.outDir, 'rows'), { recursive: true });
  const jobs: Array<E1Job & { path: string }> = [];
  for (const arm of arms) {
    const path = rowsPath(ctx.outDir, ctx.set, arm, ctx.readerModel);
    const done = new Set(readRows(path).filter(r => !r.reader_error).map(r => r.question_id));
    for (const id of ids) {
      if (done.has(id)) continue;
      const q = ctx.questions.get(id);
      if (!q) throw new Error(`question ${id} is not in the frozen manifest`);
      jobs.push({ q, arm, path });
    }
  }
  let n = 0;
  await pool(jobs, concurrency, async job => {
    const row = await runJob(ctx, job);
    appendFileSync(job.path, JSON.stringify(row) + '\n');
    n++;
    log(`[e1] ${job.arm} ${job.q.question_id} ${row.reader_error ? `ERROR ${row.reader_error}` : `primary=${row.primary} official=${row.confirmation} in=${row.tokens.provider_input}`} (${n}/${jobs.length})`);
  });
  return { jobs: jobs.length };
}

/** Worst-case-leaning cost estimate from the frozen requests (cl100k x 1.15 for Claude's tokenizer, 450 output tokens, two judges). */
export function estimateE1Usd(ctx: Pick<E1Context, 'store' | 'renderer' | 'dataset' | 'readerModel' | 'manifest'>, questions: FrozenQuestion[], arms: string[], count: (s: string) => number): number {
  const price = ctx.readerModel.startsWith('openai:') ? { in: 2.5e-6, out: 10e-6 } : { in: 3e-6, out: 15e-6 };
  let usd = 0;
  for (const q of questions) {
    for (const arm of arms) {
      const { request } = armRequest(ctx, q, arm);
      const inTok = (count(request.system) + count(request.messages[0].content)) * 1.15;
      const agentFactor = arm === 'agent_fetch' ? 4 : 1;
      usd += (inTok * agentFactor * price.in + 450 * agentFactor * price.out) + 0.002;
    }
  }
  return usd;
}

/**
 * memory-qa arm runner: one gbrain build, one benchmark split, one process.
 *
 *   bun eval/runner/memory-qa/run.ts --benchmark locomo|lme-s|beam-100k|beam-1m|fixture
 *     [--split dev] [--gbrain <checkout>[@ref]] [--config key=value]... [--pin key=value]...
 *     [--embed hash|real] [--embedding-model provider:model --embedding-dims N]
 *     [--categories a,b] [--limit N] [--seed N] [--top-k 10] [--shard i/n]
 *     [--facts conversation] [--qa reader|think --qa-context sessions|facts]
 *     [--paid --budget-run-id <id>] --output <dir>
 *
 * What it measures: judge-free session retrieval. Each conversation's
 * sessions are imported as pages into a fresh in-memory gbrain (PGLite), the
 * question goes through gbrain's hybrid search with the pinned search config
 * plus this arm's config overrides, and the retrieved chunks are reduced to
 * distinct sessions in rank order. Rows carry recall_all@5 (every gold
 * session in the top five distinct sessions), recall_any@5, recall_all@10,
 * nDCG@10 and latency. Abstention questions have no gold and are marked so a
 * comparison family excludes them.
 *
 * Facts lane (`--facts conversation`): pages import as conversation pages
 * with ISO session dates and gbrain's conversation-facts extractor runs on
 * each conversation before its questions; rows carry facts_count and
 * facts_unresolved_share, and every saved fact lands in facts.ndjson (with its
 * stored attributed_to when the build has the column).
 * `--qa reader --qa-context facts` answers from the
 * saved facts of the top sessions instead of their raw turns.
 *
 * The arm imports gbrain only through `importGbrain`, so `--gbrain` really
 * selects the build under test; the decision kit runs baseline and candidate
 * as separate processes. Gold ids, categories and answers never reach gbrain.
 *
 * Fidelity: a page saved without vectors (embedding_deferred) under an
 * embedding arm, or a pinned reranker that never stamps a rerank score, marks
 * the run `invalid` — it measured a different pipeline than the one named.
 */
import '../budget-ledger.ts';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { budgetOptionsFrom, startPaidRun, receiptCost, type BudgetRun, type PaidRequestGuard } from '../budget-ledger.ts';
import { requirePaidArm } from '../paid-arm.ts';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from '../gbrain-under-test.ts';
import { EmbeddingCache, makeCachingTransport } from '../longmemeval-cache.ts';
import { ndcgAtK, recallAllAtK, recallAnyAtK, uniqueInOrder, percentile } from '../metrics.ts';
import { loadCorpus, occurrenceId, renderSessionPage, type Corpus, type MemoryQuestion, type Session } from './corpus.ts';
import { ChatClient, DEFAULT_JUDGE, DEFAULT_READER, factsReaderPrompt, judgeResponse, packSessions, readerPrompt, repeatsTrap, approxTokens, unresolvedRelativeTime, type SavedFact } from './qa.ts';
import { devConversations } from '../decisions/splits.ts';
import { decideError, DecideError, renderOperatorMessage } from '../decisions/errors.ts';

export interface RunArgs {
  benchmark: string;
  split: 'dev';
  gbrain: string | null;
  config: Record<string, string>;
  pins: Record<string, string>;
  embed: 'hash' | 'real';
  embeddingModel: string;
  embeddingDims: number;
  categories: string[] | null;
  limit: number | null;
  seed: number;
  topK: number;
  shard: { index: number; count: number };
  output: string;
  argv: string[];
  qa: { mode: 'none' | 'reader' | 'think'; reader: string; judge: string; runs: number; sessions: number; budgetTokens: number | null; thinkModel: string; context: 'sessions' | 'facts' };
  facts: 'none' | 'conversation';
}

export interface MemoryQaRow {
  id: string;
  conversation: string;
  category: string;
  abstention: boolean;
  gold_count: number;
  recall_all_at_5?: number;
  recall_any_at_5?: number;
  recall_all_at_10?: number;
  ndcg_at_10?: number;
  retrieved?: string[];
  latency_ms?: number;
  qa_score?: number;
  qa_scores?: number[];
  qa_runs?: number;
  qa_trap?: number;
  qa_input_tokens?: number;
  qa_output_tokens?: number;
  qa_context_tokens?: number;
  qa_sessions?: number;
  qa_answer?: string;
  qa_error?: string;
  qa_facts?: number;
  facts_count?: number;
  facts_unresolved_share?: number;
  facts_extract_error?: string;
  error?: string | null;
  error_origin?: 'sut' | 'harness' | 'dependency';
}

const DEFAULT_PINS: Record<string, string> = { 'search.mode': 'balanced', 'search.reranker.enabled': 'false', 'search.autocut': 'false' };
const RECYCLE_EVERY = 25;
/** Planning estimate for one session through the conversation-facts extractor (product default model). */
const FACTS_USD_PER_SESSION = 0.03;
const PRESERVE_TABLES = new Set(['sources', 'config', 'gbrain_cycle_locks', 'subagent_rate_leases']);

function kv(list: string[], flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of list) {
    const at = item.indexOf('=');
    if (at <= 0) throw new Error(`${flag} needs key=value (got ${item})`);
    out[item.slice(0, at)] = item.slice(at + 1);
  }
  return out;
}

export function parseRunArgs(argv: string[]): RunArgs {
  const one = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const many = (name: string) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
  const benchmark = one('--benchmark');
  if (!benchmark) throw new Error('--benchmark is required');
  const output = one('--output');
  if (!output) throw new Error('--output <dir> is required');
  const split = one('--split') ?? 'dev';
  if (split !== 'dev') throw decideError({ code: 'SEALED_SOURCE_IN_DEV', message: `--split ${split} is not available to dev runs`,
    why: 'sealed conversations open only through the custodian at a preregistered decision', fix: { next: 'ask_user', user_message: 'request a held-out run from the custodian with `bun run eval:decide request`' } });
  const shardRaw = one('--shard') ?? '0/1';
  const [si, sn] = shardRaw.split('/').map(Number);
  if (!Number.isInteger(si) || !Number.isInteger(sn) || sn < 1 || si < 0 || si >= sn) throw new Error('--shard must look like i/n with 0 <= i < n');
  const embed = (one('--embed') ?? (benchmark === 'fixture' ? 'hash' : 'real')) as 'hash' | 'real';
  if (!['hash', 'real'].includes(embed)) throw new Error('--embed must be hash or real');
  return {
    benchmark, split: 'dev', gbrain: gbrainSpecFrom(argv), config: kv(many('--config'), '--config'),
    pins: { ...DEFAULT_PINS, ...kv(many('--pin'), '--pin') }, embed,
    embeddingModel: one('--embedding-model') ?? 'openai:text-embedding-3-large',
    embeddingDims: Number(one('--embedding-dims') ?? 1536),
    categories: one('--categories') ? one('--categories')!.split(',').map(s => s.trim()).filter(Boolean) : null,
    limit: one('--limit') ? Number(one('--limit')) : null,
    seed: Number(one('--seed') ?? 42), topK: Number(one('--top-k') ?? 10),
    shard: { index: si, count: sn }, output: resolve(output), argv,
    qa: {
      mode: (one('--qa') ?? 'none') as 'none' | 'reader' | 'think',
      reader: one('--reader') ?? DEFAULT_READER[benchmark] ?? 'openai:gpt-4o-2024-08-06',
      judge: one('--judge') ?? DEFAULT_JUDGE[benchmark] ?? 'openai:gpt-4o-2024-08-06',
      runs: Number(one('--qa-runs') ?? 1), sessions: Number(one('--qa-sessions') ?? 5),
      budgetTokens: one('--qa-budget-tokens') ? Number(one('--qa-budget-tokens')) : null,
      thinkModel: one('--think-model') ?? 'anthropic:claude-sonnet-5-5',
      context: (one('--qa-context') ?? 'sessions') as 'sessions' | 'facts',
    },
    facts: (one('--facts') ?? 'none') as 'none' | 'conversation',
  };
}

/** Deterministic, category-stratified subset: questions sorted by sha256(seed, id) within each category, round-robin across categories. */
export function selectQuestions(questions: MemoryQuestion[], limit: number | null, seed: number): MemoryQuestion[] {
  if (limit === null || limit >= questions.length) return questions;
  const key = (q: MemoryQuestion) => createHash('sha256').update(`${seed}\u0000${q.id}`).digest('hex');
  const byCat = new Map<string, MemoryQuestion[]>();
  for (const q of questions) byCat.set(q.category, [...(byCat.get(q.category) ?? []), q]);
  for (const list of byCat.values()) list.sort((a, b) => (key(a) < key(b) ? -1 : 1));
  const cats = [...byCat.keys()].sort();
  const out: MemoryQuestion[] = [];
  for (let round = 0; out.length < limit; round++) {
    let added = false;
    for (const c of cats) {
      const q = byCat.get(c)![round];
      if (q && out.length < limit) { out.push(q); added = true; }
    }
    if (!added) break;
  }
  return out;
}

export function scoreRetrieval(retrieved: string[], gold: string[]): Pick<MemoryQaRow, 'recall_all_at_5' | 'recall_any_at_5' | 'recall_all_at_10' | 'ndcg_at_10'> {
  const rel = new Set(gold);
  const grades = new Map(gold.map(g => [g, 1]));
  return {
    recall_all_at_5: recallAllAtK(retrieved, rel, 5), recall_any_at_5: recallAnyAtK(retrieved, rel, 5),
    recall_all_at_10: recallAllAtK(retrieved, rel, 10), ndcg_at_10: ndcgAtK(retrieved, grades, 10),
  };
}

export function hashEmbed(text: string, dims: number): number[] {
  const vec = new Array<number>(dims).fill(0);
  const tokens = new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2));
  for (const tok of tokens) vec[createHash('sha256').update(tok).digest().readUInt32BE(0) % dims] += 1;
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
  return vec.map(x => x / norm);
}

const PROVIDER_KEY: Record<string, string> = { openai: 'OPENAI_API_KEY', voyage: 'VOYAGE_API_KEY', google: 'GOOGLE_GENERATIVE_AI_API_KEY' };

export function runConfigHash(a: RunArgs, gut: GbrainUnderTest, corpus: Corpus): string {
  const pre = { benchmark: a.benchmark, split: a.split, config: a.config, pins: a.pins, embed: a.embed, model: a.embeddingModel, dims: a.embeddingDims, qa: a.qa,
    categories: a.categories, limit: a.limit, seed: a.seed, topK: a.topK, gbrain: gut.overlay?.build.commit ?? gut.version, data: corpus.source.files, ...(a.facts !== 'none' ? { facts: a.facts } : {}) };
  return createHash('sha256').update(JSON.stringify(pre)).digest('hex');
}

export async function runArm(a: RunArgs): Promise<{ receipt: Record<string, unknown>; rows: MemoryQaRow[] }> {
  const started = new Date().toISOString();
  mkdirSync(a.output, { recursive: true });
  const gut = resolveGbrainUnderTest(a.gbrain);
  const corpus = loadCorpus(a.benchmark);
  const allowed = devConversations(a.benchmark);
  let questions = corpus.questions.filter(q => !allowed || allowed.has(q.conversation));
  if (a.categories) questions = questions.filter(q => a.categories!.includes(q.category));
  questions = selectQuestions(questions, a.limit, a.seed);
  const convIds = uniqueInOrder(questions.map(q => q.conversation)).sort();
  const myConvs = convIds.filter((_, i) => i % a.shard.count === a.shard.index);
  const byConv = new Map(corpus.conversations.map(c => [c.id, c]));

  const hash = runConfigHash(a, gut, corpus);
  const rowsPath = join(a.output, 'rows.ndjson');
  const headerPath = join(a.output, 'run-config.json');
  const done = new Set<string>();
  if (existsSync(headerPath)) {
    const prior = JSON.parse(readFileSync(headerPath, 'utf8')) as { run_config_hash: string };
    if (prior.run_config_hash !== hash) throw new Error(`${a.output} holds rows from a different run configuration; use a fresh --output`);
    if (existsSync(rowsPath)) for (const line of readFileSync(rowsPath, 'utf8').split('\n')) if (line.trim()) {
      const r = JSON.parse(line) as MemoryQaRow;
      if (!r.error) done.add(r.id);
    }
  }
  writeFileSync(headerPath, JSON.stringify({ run_config_hash: hash, benchmark: a.benchmark, shard: a.shard }, null, 2));

  // Gateway: hash vectors (keyless) or the real provider through the budget ledger and the content-addressed cache.
  const gateway = await importGbrain<{ configureGateway: (c: Record<string, unknown>) => void; __setEmbedTransportForTests: (fn: unknown) => void }>(gut, 'src/core/ai/gateway.ts');
  let paid: { run: BudgetRun; guard: PaidRequestGuard } | null = null;
  let cache: EmbeddingCache | null = null;
  const provider = a.embeddingModel.split(':')[0];
  const needsPaid = a.embed === 'real' || a.qa.mode !== 'none' || a.facts !== 'none';
  if (!['none', 'reader', 'think'].includes(a.qa.mode)) throw new Error('--qa must be none, reader or think');
  if (!['none', 'conversation'].includes(a.facts)) throw new Error('--facts must be none or conversation');
  if (!['sessions', 'facts'].includes(a.qa.context)) throw new Error('--qa-context must be sessions or facts');
  if (a.qa.context === 'facts' && (a.facts === 'none' || a.qa.mode !== 'reader')) throw new Error('--qa-context facts needs --facts conversation and --qa reader');
  if (needsPaid) {
    const perQuestion: Record<string, number> = { 'lme-s': 0.012, locomo: 0.002, 'beam-100k': 0.01, 'beam-1m': 0.03, fixture: 0 };
    const perQa: Record<string, number> = { none: 0, reader: a.benchmark === 'lme-s' ? 0.05 : 0.01, think: 0.08 };
    const mine = questions.filter(q => myConvs.includes(q.conversation)).length;
    const factSessions = a.facts === 'none' ? 0 : myConvs.reduce((n, id) => n + (byConv.get(id)?.sessions.length ?? 0), 0);
    const estimate = Math.max(0.05, Math.round((((a.embed === 'real' ? perQuestion[a.benchmark] ?? 0.02 : 0) + perQa[a.qa.mode] * a.qa.runs) * mine + FACTS_USD_PER_SESSION * factSessions) * 100) / 100);
    try { requirePaidArm(a.argv, { arm: `memory-qa ${a.benchmark}`, estimateUsd: estimate }); }
    catch (e) {
      throw decideError({ code: 'PAID_FLAGS_MISSING', message: (e as Error).message, why: 'real embeddings and the reading lane call paid providers, and every paid request is reserved in the budget ledger first',
        fix: { next: 'run', argv: ['bun', 'eval/runner/budget-ledger.ts', 'status'], verify: ['bun', 'eval/runner/budget-ledger.ts', 'status'] } });
    }
    paid = startPaidRun(`memory-qa:${a.benchmark}`, { ...budgetOptionsFrom(a.argv), estimateUsd: estimate });
  }
  if (a.embed === 'hash') {
    const keyEnv = PROVIDER_KEY[provider] ?? 'OPENAI_API_KEY';
    if (!process.env[keyEnv]) process.env[keyEnv] = 'hash-embed-transport-no-provider-call';
    gateway.configureGateway({ embedding_model: a.embeddingModel, embedding_dimensions: a.embeddingDims, env: process.env });
    gateway.__setEmbedTransportForTests(async (params: { values: string[] }) => ({ embeddings: params.values.map(v => hashEmbed(v, a.embeddingDims)), values: params.values, warnings: [], usage: { tokens: 0 } }));
  } else {
    gateway.configureGateway({ embedding_model: a.embeddingModel, embedding_dimensions: a.embeddingDims, env: process.env });
    const aiPath = Bun.resolveSync('ai', gut.root);
    const { embedMany } = await import(aiPath) as { embedMany: (p: unknown) => Promise<unknown> };
    const cacheDir = process.env.GBRAIN_EVALS_EMBED_CACHE ?? join(homedir(), '.cache', 'gbrain-evals', 'embed-cache');
    mkdirSync(cacheDir, { recursive: true });
    const key = `${a.embeddingModel}@${a.embeddingDims}`;
    cache = new EmbeddingCache(join(cacheDir, `embed-cache-${key.replace(/[^a-z0-9@-]/gi, '_')}.sqlite`), key);
    gateway.__setEmbedTransportForTests(makeCachingTransport(async (p: { values: string[] } & Record<string, unknown>) => embedMany(p) as never, cache));
  }

  const { PGLiteEngine } = await importGbrain<{ PGLiteEngine: new () => any }>(gut, 'src/core/pglite-engine.ts');
  const { importFromContent } = await importGbrain<{ importFromContent: (e: unknown, slug: string, content: string, o?: Record<string, unknown>) => Promise<{ embedding_deferred?: boolean }> }>(gut, 'src/core/import-file.ts');
  const { hybridSearch } = await importGbrain<{ hybridSearch: (e: unknown, q: string, o?: Record<string, unknown>) => Promise<Array<{ slug: string; rerank_score?: number }>> }>(gut, 'src/core/search/hybrid.ts');

  const extractFacts = a.facts === 'conversation'
    ? (await importGbrain<{ runExtractConversationFactsCore: (e: unknown, o: Record<string, unknown>) => Promise<{ pages_processed: number; pages_failed: number; facts_extracted: number }> }>(gut, 'src/commands/extract-conversation-facts.ts')).runExtractConversationFactsCore
    : null;
  const factStats = { conversations: 0, pages_processed: 0, pages_failed: 0, facts: 0, unresolved: 0, errors: 0 };
  const think = a.qa.mode === 'think' ? (await importGbrain<{ runThink: (e: unknown, o: Record<string, unknown>) => Promise<{ answer: string; synthesis_status?: string }> }>(gut, 'src/core/think/index.ts')).runThink : null;
  const chat = a.qa.mode === 'none' ? null : new ChatClient(process.env.GBRAIN_EVALS_QA_CACHE ?? join(homedir(), '.cache', 'gbrain-evals', 'qa-cache'));
  const lastDate = (sessions: Session[]) => sessions.map(x => x.date ?? '').sort().pop() || undefined;
  const openEngine = async () => {
    const e = new PGLiteEngine();
    await e.connect({});
    await e.initSchema();
    for (const [k, v] of Object.entries({ ...a.pins, ...a.config })) await e.setConfig(k, v);
    return e;
  };
  const reset = async (e: any) => {
    const rows = await e.executeRaw(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`) as Array<{ tablename: string }>;
    const targets = rows.map(r => r.tablename).filter(t => !PRESERVE_TABLES.has(t));
    if (targets.length) await e.executeRaw(`TRUNCATE ${targets.map(t => `"${t.replace(/"/g, '""')}"`).join(', ')} RESTART IDENTITY CASCADE`);
  };

  const rerankPinned = (a.config['search.reranker.enabled'] ?? a.pins['search.reranker.enabled']) === 'true';
  const fidelity = { embedding_deferred_pages: 0, rerank_missing_queries: 0, reranked_queries: 0 };
  const rows: MemoryQaRow[] = [];
  let engine = await openEngine();
  let processed = 0;
  try {
    for (const convId of myConvs) {
      const qs = questions.filter(q => q.conversation === convId && !done.has(q.id));
      if (!qs.length) continue;
      if (paid?.guard.exhausted) break;
      if (processed > 0 && processed % RECYCLE_EVERY === 0) { try { await engine.disconnect(); } catch { /* ignore */ } engine = await openEngine(); }
      else if (processed > 0) await reset(engine);
      processed++;
      const conv = byConv.get(convId)!;
      const bySlug = new Map<string, string>();
      let importError: string | null = null;
      for (const s of conv.sessions) {
        const slug = `chat/${occurrenceId(conv.id, s.id)}`;
        bySlug.set(slug, s.id);
        try {
          const res = await importFromContent(engine, slug, renderSessionPage(s, { as: extractFacts ? 'conversation' : 'note' }), {});
          if (res?.embedding_deferred) fidelity.embedding_deferred_pages++;
        } catch (e) { importError = (e as Error).message; break; }
      }
      const factsBySession = new Map<string, SavedFact[]>();
      let convFacts: Pick<MemoryQaRow, 'facts_count' | 'facts_unresolved_share' | 'facts_extract_error'> = {};
      if (extractFacts && !importError) {
        let extractError: string | null = null;
        try {
          const res = await extractFacts(engine, { sourceId: 'default', slugs: [...bySlug.keys()], types: ['conversation'], force: true });
          factStats.pages_processed += res.pages_processed; factStats.pages_failed += res.pages_failed;
          if (res.pages_failed) extractError = `${res.pages_failed} of ${bySlug.size} pages failed extraction`;
        } catch (e) {
          factStats.errors++;
          extractError = (e as Error).message.slice(0, 300);
        }
        // Whatever the extractor saved before a failure is what the brain holds, so it is read and scored either way.
        const facts = await engine.executeRaw(`SELECT fact, valid_from, source_markdown_slug, to_jsonb(facts)->>'attributed_to' AS attributed_to FROM facts WHERE expired_at IS NULL AND source NOT LIKE 'cli:extract-conversation-facts:terminal%' AND source NOT LIKE 'cli:extract-conversation-facts:non-extractable%' ORDER BY valid_from, id`) as Array<{ fact: string; valid_from: Date | string | null; source_markdown_slug: string | null; attributed_to: string | null }>;
        for (const f of facts) {
          const sessionId = f.source_markdown_slug ? bySlug.get(f.source_markdown_slug) : undefined;
          if (!sessionId) continue;
          factsBySession.set(sessionId, [...(factsBySession.get(sessionId) ?? []), { fact: f.fact, valid_from: f.valid_from ? new Date(f.valid_from).toISOString() : null }]);
        }
        appendFileSync(join(a.output, 'facts.ndjson'), facts.map(f => JSON.stringify({ conversation: convId, session: f.source_markdown_slug ? bySlug.get(f.source_markdown_slug) ?? null : null,
          valid_from: f.valid_from ? new Date(f.valid_from).toISOString() : null, fact: f.fact, attributed_to: f.attributed_to, unresolved: unresolvedRelativeTime(f.fact) }) + '\n').join(''));
        const unresolved = facts.filter(f => unresolvedRelativeTime(f.fact)).length;
        factStats.conversations++; factStats.facts += facts.length; factStats.unresolved += unresolved;
        convFacts = { facts_count: facts.length, facts_unresolved_share: facts.length ? unresolved / facts.length : 0,
          ...(extractError ? { facts_extract_error: extractError } : {}) };
      }
      for (const q of qs) {
        const base: MemoryQaRow = { id: q.id, conversation: q.conversation, category: q.category, abstention: q.abstention, gold_count: q.gold.length, ...convFacts };
        let row: MemoryQaRow;
        if (importError) row = { ...base, error: `import failed: ${importError}`, error_origin: 'sut' };
        else {
          const t0 = performance.now();
          try {
            const results = await hybridSearch(engine, q.question, { limit: a.topK * 3, expansion: false });
            const latency = performance.now() - t0;
            if (rerankPinned && results.length) {
              if (results.some(r => r.rerank_score !== undefined)) fidelity.reranked_queries++;
              else fidelity.rerank_missing_queries++;
            }
            const retrieved = uniqueInOrder(results.map(r => bySlug.get(r.slug) ?? `?${r.slug}`)).slice(0, a.topK);
            row = { ...base, ...scoreRetrieval(retrieved, q.gold), retrieved, latency_ms: Math.round(latency * 10) / 10, error: null };
            if (chat) {
              try {
                const scores: number[] = [];
                let tin = 0; let tout = 0; let answer = ''; let trap = 0;
                const sessById = new Map(conv.sessions.map(x => [x.id, x]));
                const pack = packSessions(retrieved.map(id => sessById.get(id)).filter((x): x is Session => !!x), a.qa.sessions, a.qa.budgetTokens);
                const readFacts = a.qa.context === 'facts' ? retrieved.slice(0, a.qa.sessions).flatMap(id => factsBySession.get(id) ?? []) : [];
                for (let r = 0; r < a.qa.runs; r++) {
                  if (think) {
                    const res = await think(engine, { question: q.question, model: a.qa.thinkModel, modelExplicit: true, remote: false });
                    answer = res.answer ?? '';
                    tin += approxTokens(q.question);
                  } else {
                    const prompt = a.qa.context === 'facts' ? factsReaderPrompt(q, readFacts, lastDate(conv.sessions)) : readerPrompt(q, pack.sessions, lastDate(conv.sessions));
                    const out = await chat.chat(a.qa.reader, prompt, { maxTokens: 1024, replicate: r });
                    answer = out.text; tin += out.input_tokens; tout += out.output_tokens;
                  }
                  scores.push(await judgeResponse(chat, a.benchmark, a.qa.judge, q, answer, r));
                  if (q.abstention && repeatsTrap(answer, q.trap)) trap++;
                }
                row = { ...row, qa_score: scores.reduce((x, y) => x + y, 0) / scores.length, qa_scores: scores, qa_runs: scores.length,
                  ...(q.trap ? { qa_trap: trap / scores.length } : {}), qa_input_tokens: Math.round(tin / scores.length), qa_output_tokens: Math.round(tout / scores.length),
                  qa_context_tokens: think || a.qa.context === 'facts' ? undefined : pack.tokens, qa_sessions: think || a.qa.context === 'facts' ? undefined : pack.sessions.length,
                  ...(a.qa.context === 'facts' ? { qa_facts: readFacts.length } : {}), qa_answer: answer.slice(0, 2000) };
              } catch (e) {
                row = { ...row, qa_error: (e as Error).message.slice(0, 300) };
              }
            }
          } catch (e) {
            row = { ...base, error: (e as Error).message, error_origin: /budget|BudgetExceeded/i.test((e as Error).message) ? 'harness' : 'sut' };
          }
        }
        rows.push(row);
        appendFileSync(rowsPath, JSON.stringify(row) + '\n');
      }
    }
  } finally {
    try { await engine.disconnect(); } catch { /* ignore */ }
    cache?.close();
  }

  const allRows: MemoryQaRow[] = readFileSync(rowsPath, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  const scored = allRows.filter(r => !r.abstention && !r.error && r.gold_count > 0);
  const mean = (k: keyof MemoryQaRow) => scored.length ? scored.reduce((s, r) => s + Number(r[k] ?? 0), 0) / scored.length : null;
  const invalidReasons: string[] = [];
  if (fidelity.embedding_deferred_pages > 0) invalidReasons.push(`${fidelity.embedding_deferred_pages} pages were saved without vectors (embedding_deferred), so vector retrieval was not what ran`);
  if (rerankPinned && fidelity.rerank_missing_queries > 0) invalidReasons.push(`${fidelity.rerank_missing_queries} queries came back without rerank scores although the reranker is pinned on`);
  const expected = questions.filter(q => myConvs.includes(q.conversation)).length;
  const runStatus = invalidReasons.length ? 'invalid' : allRows.length < expected ? 'partial' : 'complete';
  let cost: Record<string, unknown> | null = null;
  if (paid) {
    const summary = paid.run.close();
    paid.guard.uninstall();
    cost = receiptCost(summary) as unknown as Record<string, unknown>;
  }
  const receipt = {
    kind: 'memory-qa-arm', schema_version: 1, benchmark: a.benchmark, split: a.split, run_status: runStatus, invalid_reasons: invalidReasons,
    started_at: started, finished_at: new Date().toISOString(), run_config_hash: hash,
    product: productIdentityFor(gut), overlay: overlaySummary(gut), arm_config: a.config, search_pins: a.pins,
    retrieval_path: 'hybridSearch (expansion off), chunks reduced to distinct sessions',
    embedding: { mode: a.embed, model: a.embeddingModel, dims: a.embeddingDims, cache_stats: cache ? { ...cache.stats } : null },
    dataset: corpus.source, selection: { categories: a.categories, limit: a.limit, seed: a.seed, shard: a.shard, conversations: myConvs.length, questions_expected: expected },
    counts: { rows: allRows.length, scored: scored.length, errors: allRows.filter(r => r.error).length, abstention: allRows.filter(r => r.abstention).length },
    summary: { recall_all_at_5: mean('recall_all_at_5'), recall_any_at_5: mean('recall_any_at_5'), recall_all_at_10: mean('recall_all_at_10'), ndcg_at_10: mean('ndcg_at_10'),
      latency_p50_ms: scored.length ? percentile(scored.map(r => r.latency_ms ?? 0), 50) : null, latency_p95_ms: scored.length ? percentile(scored.map(r => r.latency_ms ?? 0), 95) : null,
      ...(a.qa.mode !== 'none' ? (() => { const qa = allRows.filter(r => typeof r.qa_score === 'number'); return { qa_score: qa.length ? qa.reduce((x, r) => x + (r.qa_score ?? 0), 0) / qa.length : null, qa_rows: qa.length, qa_errors: allRows.filter(r => r.qa_error).length }; })() : {}) },
    facts: a.facts === 'none' ? null : { lane: a.facts, extractor: 'runExtractConversationFactsCore (product default model, force)', pages: 'conversation type, ISO session date', ...factStats,
      unresolved_share: factStats.facts ? factStats.unresolved / factStats.facts : null },
    qa: a.qa.mode === 'none' ? null : { ...a.qa, reader_prompt: a.qa.mode === 'think' ? 'gbrain think' : a.qa.context === 'facts' ? 'step-by-step reading prompt over the saved facts (text + stored date) of the top sessions' : 'LongMemEval step-by-step reading prompt, sessions in date order', judge_prompts: a.benchmark.startsWith('beam') ? 'per-rubric-item yes/no' : 'LongMemEval official per-type prompts' },
    fidelity, cost, rows_file: 'rows.ndjson',
  };
  writeFileSync(join(a.output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  return { receipt, rows: allRows };
}

if (import.meta.main) {
  try {
    const a = parseRunArgs(process.argv.slice(2));
    const { receipt } = await runArm(a);
    const s = receipt.summary as Record<string, number | null>;
    process.stderr.write(`[memory-qa] ${a.benchmark} ${receipt.run_status}: ${(receipt.counts as Record<string, number>).scored} scored, recall_all@5 ${s.recall_all_at_5?.toFixed(4) ?? 'n/a'}; receipt ${join(a.output, 'receipt.json')}\n`);
    process.exit(receipt.run_status === 'invalid' ? 4 : 0);
  } catch (e) {
    if (e instanceof DecideError) { process.stderr.write(renderOperatorMessage(e.op) + '\n'); process.exit(e.op.fix.next === 'ask_user' ? 3 : 2); }
    throw e;
  }
}

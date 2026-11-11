/**
 * The SOTA loop's oracle (plan item 4): each dev-pool question answered by a frontier reader given only its gold
 * evidence (BEAM: every turn group holding a cited turn; LongMemEval: the answer sessions), through memory-qa's reading
 * arm (--qa reader --qa-context oracle, the reader prompt and judging code the nightly and A4 use) at the suite's output
 * limit, judged by the reader's cross-family judge (RS1's per-row judges: gpt-6-astra grades Claude answers,
 * claude-opus-5-5 grades GPT and particle-1 answers), and written to the outcome cache with its finish_reason. Cat 40 is
 * out of v1: its scorer and agent loop don't fit a QA reader.
 *
 *   bun eval/runner/sota/oracle.ts plan --cache <dir>
 *   bun eval/runner/sota/oracle.ts import-a4 --cache <dir>
 *   bun eval/runner/sota/oracle.ts run --benchmark beam-1m|lme-s --reader <provider:model> --items <ids.txt> --cache <dir>
 *       --work <dir> --paid --budget-ledger <path> --budget-run-id <id>
 *   bun eval/runner/sota/oracle.ts export --benchmark lme-s --cache <dir>
 *
 * plan (keyless) lists, per benchmark and reader, the dev-pool items whose oracle row is fresh, unknown or stale, and
 * writes the ids to buy. import-a4 (keyless) writes A4's gpt-6.1-sol answers on BEAM-1M with their claude-opus-5-5
 * re-judge (eval/data/answerability/oracle/beam-1m.json) as Sol's BEAM-1M rows: that spec is pinned to A4, so A4's
 * answers are reused wherever the item matches and never re-bought. run buys the rest in a paid window; the chat cache
 * under --work makes a rerun repeat no call. export writes the LongMemEval oracle file the answerability rule reads
 * (gpt-6.1-sol answers, claude-opus-5-5 judge, as on BEAM-1M).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { loadCorpus, filesFor, type MemoryQuestion, type Session } from '../memory-qa/corpus.ts';
import { latestDate, readerPrompt } from '../memory-qa/qa.ts';
import { parseRunArgs, runArm } from '../memory-qa/run.ts';
import { loadDevSet } from '../nightly/devset.ts';
import { qaPromptVersion } from '../nightly/judge-cache.ts';
import { ANSWERABILITY_DIR, ORACLE_PASS, ORACLE_SCHEMA, SOURCES } from './answerability.ts';
import { CACHE_SCHEMA, freshness, OutcomeCache, type Row, type Spec, type Usage } from './cache.ts';
import { assertNoSealedIds } from './sealed-guard.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const sha16 = (...parts: Array<string | Uint8Array>) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest('hex').slice(0, 16); };
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** The readers the oracle buys, and the nightly suite whose items and output limit each benchmark takes. */
export const ORACLE_READERS = ['anthropic:claude-opus-5-5', 'openai:gpt-6.1-sol'] as const;
export const SUITE: Record<string, string> = { 'beam-1m': 'beam-1m-hard', 'lme-s': 'lme-s-hard' };
const TRUNCATED = new Set(['length', 'max_tokens']);

/** RS1's per-row judges: GPT-6 Astra grades Claude answers; Opus grades GPT and particle-1 answers. */
export const oracleJudge = (reader: string) => (reader.startsWith('anthropic:') ? 'openai:gpt-6-astra' : 'anthropic:claude-opus-5-5');

/** The dataset pin: the pinned files' paths and hashes (BEAM's manifest, LongMemEval's file), known without the data. */
export const datasetPin = (benchmark: string) => (benchmark === 'fixture' ? 'fixture' : sha16(filesFor(benchmark).map(f => `${f.path} ${f.sha256}\n`).join('')));

/** The validator verdicts an item's class came from: the answerability file's validator sources, not its oracle. */
export function validatorVersion(benchmark: string): string {
  const path = join(ROOT, ANSWERABILITY_DIR, `${benchmark}.json`);
  if (!existsSync(path)) return 'none';
  const { oracle: _, ...validators } = (JSON.parse(readFileSync(path, 'utf8')) as { sources: Record<string, unknown> }).sources;
  return sha16(JSON.stringify(validators));
}

/** The reading arm's code: the reader prompt and history rendering (qa.ts) and the gold-session loader (corpus.ts). */
const readerVersion = () => sha16(...['qa.ts', 'corpus.ts'].map(f => readFileSync(join(ROOT, 'eval/runner/memory-qa', f))));
const harnessDigest = () => sha16(readFileSync(join(ROOT, 'eval/runner/sota/oracle.ts')));

/** The output limit of a benchmark's nightly suite (8,192 tokens since #420). */
export function suiteMaxTokens(benchmark: string): number {
  const suite = loadDevSet().suites.find(s => s.id === SUITE[benchmark]);
  const n = suite?.config?.qa_max_tokens;
  if (typeof n !== 'number') throw new Error(`${SUITE[benchmark] ?? benchmark} names no qa_max_tokens`);
  return n;
}

// ─── A4: Sol's BEAM-1M oracle, reused ────────────────────────────────

const A4_DIR = join(ROOT, SOURCES.a4);
interface OracleFile { judge: string; judge_prompt: { qa_ts_sha256: string }; source_sha256: string; rows: Record<string, { score: number | null; pass: boolean | null }> }
const oracleFile = (): OracleFile => JSON.parse(readFileSync(join(ROOT, SOURCES.oracle('beam-1m')), 'utf8'));
const a4MaxTokens = 2000;

/** Sol's BEAM-1M spec is A4's: its October answers (2,000-token limit), the claude-opus-5-5 re-judge and its prompt. */
export function a4Spec(): Spec {
  const f = oracleFile();
  return {
    kind: 'oracle', benchmark: 'beam-1m', system: 'oracle', reader: 'openai:gpt-6.1-sol',
    system_version: 'a4-oracle-gpt61sol', effort: null, max_tokens: a4MaxTokens, judge: f.judge, judge_prompt: f.judge_prompt.qa_ts_sha256.slice(0, 16),
    pass_threshold: ORACLE_PASS, dataset: datasetPin('beam-1m'), validator_version: validatorVersion('beam-1m'), harness_digest: `a4-rejudge ${f.source_sha256.slice(0, 16)}`,
  };
}

/** The current inputs for one benchmark and reader's oracle rows. */
export function oracleSpec(benchmark: string, reader: string, maxTokens = suiteMaxTokens(benchmark)): Spec {
  if (benchmark === 'beam-1m' && reader === 'openai:gpt-6.1-sol') return a4Spec();
  return {
    kind: 'oracle', benchmark, system: 'oracle', reader, system_version: readerVersion(), effort: null, max_tokens: maxTokens,
    judge: oracleJudge(reader), judge_prompt: qaPromptVersion(), pass_threshold: ORACLE_PASS, dataset: datasetPin(benchmark),
    validator_version: validatorVersion(benchmark), harness_digest: harnessDigest(),
  };
}

const jsonl = (path: string) => (path.endsWith('.gz') ? gunzipSync(readFileSync(path)).toString('utf8') : readFileSync(path, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));

/** A4's rows as cache rows: the re-judge's score and verdict, the October answer's finish_reason and reader tokens. */
export function a4Rows(at = new Date().toISOString()): Row[] {
  const spec = a4Spec(), f = oracleFile();
  const shards = readdirSync(A4_DIR).filter(s => s.startsWith('shard-')).sort();
  const answers = new Map(shards.flatMap(s => jsonl(join(A4_DIR, s, 'answers.ndjson.gz'))).map((a: { id: string; finish_reason: string; input_tokens: number; output_tokens: number }) => [a.id, a]));
  return Object.keys(f.rows).sort().map(item => {
    const a = answers.get(item);
    return {
      ...spec, schema: CACHE_SCHEMA, item, context_digest: 'a4 (prompt digest not recorded)', score: f.rows[item]!.score, pass: f.rows[item]!.pass,
      finish_reason: a?.finish_reason ?? null, usage: null, at, source: `${SOURCES.a4} answers, ${SOURCES.oracle('beam-1m')} verdicts`,
    };
  });
}

// ─── the dev pool ────────────────────────────────────────────────────

/** The dev-pool items of a benchmark: its nightly suite's items. */
export function poolItems(benchmark: string): string[] {
  const suite = loadDevSet().suites.find(s => s.id === SUITE[benchmark]);
  if (!suite) throw new Error(`no nightly suite for ${benchmark}`);
  return suite.items.map(i => i.id);
}

// ─── buying rows ─────────────────────────────────────────────────────

/** The exact reader prompt the oracle arm sends for a question: every gold session, unbudgeted, in date order. */
export function oraclePrompt(q: MemoryQuestion, sessions: readonly Session[]): string {
  const byId = new Map(sessions.map(s => [s.id, s]));
  return readerPrompt(q, q.gold.map(id => byId.get(id)).filter((s): s is Session => !!s), latestDate([...sessions]));
}

interface QaRow { id: string; qa_score?: number | null; qa_answer?: string; qa_error?: string | null; error?: string | null; qa_receipts?: Array<{ role: string; finish?: string | null; usage?: { input_total: number; output_total: number } | null }> }

/** memory-qa's rows as cache rows; errored rows are left out, so their items stay unknown. */
export function rowsFromRun(spec: Spec, rows: readonly QaRow[], prompts: ReadonlyMap<string, string>, at: string, source: string): { rows: Row[]; errored: string[] } {
  const out: Row[] = [], errored: string[] = [];
  for (const r of rows) {
    if (r.qa_error || r.error || typeof r.qa_score !== 'number') { errored.push(r.id); continue; }
    const reader = (r.qa_receipts ?? []).filter(x => x.role !== 'judge'), judge = (r.qa_receipts ?? []).filter(x => x.role === 'judge');
    const finish = reader.at(-1)?.finish ?? null;
    const cut = !!finish && TRUNCATED.has(finish) && !(r.qa_answer ?? '').trim();
    const sum = (xs: typeof reader, k: 'input_total' | 'output_total') => xs.reduce((n, x) => n + (x.usage?.[k] ?? 0), 0);
    const usage: Usage | null = reader.every(x => x.usage) ? { reader_input: sum(reader, 'input_total'), reader_output: sum(reader, 'output_total'), judge_input: sum(judge, 'input_total'), judge_output: sum(judge, 'output_total') } : null;
    const prompt = prompts.get(r.id);
    if (!prompt) throw new Error(`${r.id}: no gold evidence was built for it`);
    out.push({ ...spec, schema: CACHE_SCHEMA, item: r.id, context_digest: sha256(prompt), score: cut ? null : r.qa_score, pass: cut ? null : r.qa_score >= spec.pass_threshold,
      finish_reason: finish, usage, at, source });
  }
  return { rows: out, errored };
}

export interface RunOptions { benchmark: string; reader: string; items: string[]; cache: string; work: string; budgetLedger: string; budgetRunId: string; maxTokens?: number; corpusOnly?: boolean }

/** Buys the oracle rows the cache lacks for these items, in a paid window. */
export async function runOracle(o: RunOptions): Promise<{ bought: number; fresh: number; errored: string[] }> {
  const spec = oracleSpec(o.benchmark, o.reader, o.maxTokens ?? (o.benchmark === 'fixture' ? 1024 : undefined));
  if (spec.system_version === 'a4-oracle-gpt61sol') throw new Error('Sol\'s BEAM-1M oracle rows are A4\'s: run import-a4, never a re-buy');
  assertNoSealedIds(o.items.join('\n'), '--items');
  const cache = new OutcomeCache(o.cache);
  const f = freshness(cache, spec, o.items);
  const todo = o.items.filter(id => !f.hits.has(id));
  if (!todo.length) return { bought: 0, fresh: f.hits.size, errored: [] };
  const tag = `${o.benchmark}-${o.reader.replace(/[^a-z0-9.-]+/gi, '_')}`;
  const out = join(o.work, tag), ids = join(o.work, `${tag}.ids.txt`);
  mkdirSync(o.work, { recursive: true });
  writeFileSync(ids, todo.join('\n') + '\n');
  const corpus = loadCorpus(o.benchmark);
  const wanted = new Set(todo);
  const prompts = new Map(corpus.questions.filter(q => wanted.has(q.id)).map(q => [q.id, oraclePrompt(q, corpus.conversations.find(c => c.id === q.conversation)!.sessions)]));
  const prevCache = process.env.GBRAIN_EVALS_QA_CACHE;
  process.env.GBRAIN_EVALS_QA_CACHE = join(o.work, 'chat-cache');
  try {
    await runArm(parseRunArgs(['--benchmark', o.benchmark, ...(o.benchmark === 'fixture' ? [] : ['--split', 'dev']), '--qa', 'reader', '--qa-context', 'oracle',
      '--reader', o.reader, '--judge', spec.judge, '--qa-max-tokens', String(spec.max_tokens), '--ids', ids,
      '--paid', '--budget-run-id', o.budgetRunId, '--budget-ledger', o.budgetLedger, '--output', out]));
  } finally {
    if (prevCache === undefined) delete process.env.GBRAIN_EVALS_QA_CACHE; else process.env.GBRAIN_EVALS_QA_CACHE = prevCache;
  }
  const { rows, errored } = rowsFromRun(spec, jsonl(join(out, 'rows.ndjson')).filter((r: QaRow) => wanted.has(r.id)), prompts, new Date().toISOString(), `memory-qa oracle arm, ${tag}`);
  cache.put(rows);
  return { bought: rows.length, fresh: f.hits.size, errored };
}

// ─── the LongMemEval oracle file ─────────────────────────────────────

/** The answerability oracle file for a benchmark from its gpt-6.1-sol oracle rows (claude-opus-5-5 judge, as on BEAM-1M). */
export function exportOracle(cache: OutcomeCache, benchmark: string): string {
  const spec = oracleSpec(benchmark, 'openai:gpt-6.1-sol');
  const f = freshness(cache, spec, poolItems(benchmark));
  if (f.stale.length || f.unknown.length) throw new Error(`${benchmark}: ${f.unknown.length} unknown and ${f.stale.length} stale gpt-6.1-sol oracle rows; buy them before exporting`);
  const rows = Object.fromEntries([...f.hits].sort(([a], [b]) => a.localeCompare(b)).map(([id, r]) => [id, { score: r.score, pass: r.pass }]));
  const text = JSON.stringify({
    schema: ORACLE_SCHEMA, benchmark,
    about: `gpt-6.1-sol answers given only each question's gold evidence (memory-qa's oracle reading arm at ${spec.max_tokens} output tokens), judged by ${spec.judge} with memory-qa's judge prompts. pass is a score of at least ${ORACLE_PASS}; an empty answer that stopped at the output limit has no verdict (pass null). Ids and scores only.`,
    reader: spec.reader, judge: spec.judge, judge_prompt: spec.judge_prompt, reader_version: spec.system_version, max_tokens: spec.max_tokens, pass_threshold: ORACLE_PASS, rows,
  }, null, 1) + '\n';
  assertNoSealedIds(text, SOURCES.oracle(benchmark));
  return text;
}

// ─── command line ────────────────────────────────────────────────────

const flag = (argv: string[], name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const need = (argv: string[], name: string) => { const v = flag(argv, name); if (!v) throw new Error(`pass ${name}`); return v; };

export async function main(argv: string[], log: (s: string) => void = console.log): Promise<number> {
  const cache = new OutcomeCache(resolve(need(argv, '--cache')));
  switch (argv[0]) {
    case 'plan': {
      for (const benchmark of ['beam-1m', 'lme-s']) for (const reader of ORACLE_READERS) {
        const spec = oracleSpec(benchmark, reader), items = poolItems(benchmark), f = freshness(cache, spec, items);
        const buy = [...f.unknown, ...f.stale.map(s => s.item)].sort();
        const file = join(cache.dir, 'plan', `oracle-${benchmark}-${reader.replace(/[^a-z0-9.-]+/gi, '_')}.txt`);
        if (buy.length && spec.system_version !== 'a4-oracle-gpt61sol') { mkdirSync(join(cache.dir, 'plan'), { recursive: true }); writeFileSync(file, buy.join('\n') + '\n'); }
        log(`${benchmark} ${reader}: ${items.length} items, ${f.hits.size} fresh, ${f.unknown.length} unknown, ${f.stale.length} stale${buy.length && spec.system_version !== 'a4-oracle-gpt61sol' ? `; to buy: ${file}` : ''}`);
      }
      return 0;
    }
    case 'import-a4': {
      const spec = a4Spec(), f = freshness(cache, spec, Object.keys(oracleFile().rows));
      const rows = a4Rows().filter(r => !f.hits.has(r.item));
      cache.put(rows);
      log(`import-a4: ${rows.length} rows written, ${f.hits.size} already fresh`);
      return 0;
    }
    case 'run': {
      if (!argv.includes('--paid')) throw new Error('run buys oracle answers: pass --paid with the window\'s --budget-ledger and --budget-run-id');
      const items = readFileSync(need(argv, '--items'), 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
      const r = await runOracle({ benchmark: need(argv, '--benchmark'), reader: need(argv, '--reader'), items, cache: cache.dir, work: resolve(need(argv, '--work')),
        budgetLedger: resolve(need(argv, '--budget-ledger')), budgetRunId: need(argv, '--budget-run-id') });
      log(`run: ${r.bought} rows bought, ${r.fresh} already fresh, ${r.errored.length} errored (left unknown)${r.errored.length ? `: ${r.errored.join(', ')}` : ''}`);
      return r.errored.length ? 1 : 0;
    }
    case 'export': {
      const benchmark = need(argv, '--benchmark');
      mkdirSync(join(ROOT, ANSWERABILITY_DIR, 'oracle'), { recursive: true });
      writeFileSync(join(ROOT, SOURCES.oracle(benchmark)), exportOracle(cache, benchmark));
      log(`wrote ${SOURCES.oracle(benchmark)}`);
      return 0;
    }
    default: throw new Error('usage: oracle.ts plan|import-a4|run|export --cache <dir> ...');
  }
}

if (import.meta.main) main(process.argv.slice(2)).then(code => process.exit(code)).catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });

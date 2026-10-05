#!/usr/bin/env bun
/**
 * Paid bench for the workload suites: both systems on the same raw records,
 * through the harness providers and the metering proxy.
 *
 *   bun eval/workload-suites/bench.ts <suite> --phase answer|sweep|score [--arms a,b] [--smoke N]
 *       [--budget-usd N] [--out DIR] [--stub] [--gbrain <checkout>@<ref>]
 *
 * Phases:
 *   answer  ingest each arm's store (gbrain structures built in the pipeline,
 *           their spend counted), assert store presence, retrieve, and answer
 *           every scheduled question with the fixed reader. B2 runs its
 *           correction schedule through the per-system CorrectionAdapter.
 *   sweep   re-read the frontier subset's saved contexts with the sweep models
 *           (no retrieval, no ingest).
 *   score   deterministic scoring of every answer; only `ambiguous` answers go
 *           to the fixed judge. Writes results.json.
 *
 * Every answer receipt keeps the exact prompt, the delivered-context tokens
 * (cl100k), the retrieval metadata and the model's usage. Reader and judge
 * calls are cached by prompt hash, so rerunning a phase spends nothing on
 * calls already made. Default output: eval/reports/workload-bench/<suite>/.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gbrainSpecFrom, resolveGbrainUnderTest } from '../runner/gbrain-under-test.ts';
import { REPO_ROOT } from '../runner/harness-env.ts';
import { startBench, type Bench, type Bridge } from './bench-infra.ts';
import { SUITES, manifestPath } from './cli.ts';
import { bundleManifest, countValue, sha256 } from './common.ts';
import { ComparatorCorrectionAdapter, GbrainCorrectionAdapter, type RetrieveReceipt } from './correction-adapters.ts';
import { CORRECTION_ARMS, runCorrectionArm, type ArmId, type CorrectionItem } from './corrections.ts';
import { classifyMiss } from './passing-details.ts';
import { MODEL_CONFIG, frontierSubset } from './run-config.ts';
import type { HarnessQuery, Outcome, ScorerLabel, SuiteBundle, SuiteId } from './types.ts';

export const TARGET_TOKENS = 8000;
const GBRAIN_BASE = { token_budget: TARGET_TOKENS, embedding_model: 'voyage:voyage-4', embedding_dimensions: 1024, speaker_format: 'bold' };

/** One measured configuration. `store` names the ingest it shares (lanes of one system share a store when only retrieval differs). */
export interface BenchArm {
  id: string;
  system: 'gbrain' | 'comparator';
  store: string;
  config: Record<string, unknown>;
  overrides: Record<string, unknown>;
  credentials?: string[];
  /** gbrain only: run conversation-fact extraction after ingest (the facts structure, LLM spend counted). */
  extractFacts?: boolean;
  presence: 'pages' | 'pages+facts' | 'memories';
  note: string;
}

/** Facts and chunk budgets tuned retrieval-only on each suite's smoke store to a mean of about 8,000 delivered tokens. */
const COMPARATOR_COMBINED = { max_tokens: 5500, max_chunk_tokens: 4500 };
const COMPARATOR_COMBINED_B1 = { max_tokens: 4800, max_chunk_tokens: 3800 };
const COMPARATOR_COMBINED_B3 = { max_tokens: 2300, max_chunk_tokens: 2700 };
const COMPARATOR_FACTS = { max_tokens: 8000, max_chunk_tokens: 0 };

export const BENCH_ARMS: Record<Exclude<SuiteId, 'corrections'>, BenchArm[]> = {
  'passing-details': [
    { id: 'gbrain-raw', system: 'gbrain', store: 'gbrain-raw', config: GBRAIN_BASE, overrides: {}, presence: 'pages', note: 'conversation pages only, zero-LLM write path' },
    { id: 'gbrain-combined', system: 'gbrain', store: 'gbrain-facts', config: GBRAIN_BASE, overrides: {}, credentials: ['voyage', 'anthropic'], extractFacts: true, presence: 'pages+facts', note: 'pages plus facts from extract-conversation-facts; query returns matching saved facts beside the page blocks' },
    { id: 'comparator-facts', system: 'comparator', store: 'comparator', config: COMPARATOR_COMBINED_B1, overrides: COMPARATOR_FACTS, presence: 'memories', note: 'extracted facts only (its recall returns about 4k tokens of facts at most)' },
    { id: 'comparator-combined', system: 'comparator', store: 'comparator', config: COMPARATOR_COMBINED_B1, overrides: COMPARATOR_COMBINED_B1, presence: 'memories', note: 'facts plus the raw chunks they came from' },
  ],
  'time-relationships': [
    { id: 'gbrain-combined', system: 'gbrain', store: 'gbrain-facts', config: GBRAIN_BASE, overrides: {}, credentials: ['voyage', 'anthropic'], extractFacts: true, presence: 'pages+facts', note: 'pages plus extracted facts' },
    { id: 'comparator-combined', system: 'comparator', store: 'comparator', config: COMPARATOR_COMBINED_B3, overrides: COMPARATOR_COMBINED_B3, presence: 'memories', note: 'facts plus raw chunks; budgets tuned down because world-v1 facts and chunks overshoot them' },
  ],
  beliefs: [
    { id: 'gbrain-combined', system: 'gbrain', store: 'gbrain-facts', config: GBRAIN_BASE, overrides: {}, credentials: ['voyage', 'anthropic'], extractFacts: true, presence: 'pages+facts', note: 'pages plus extracted facts' },
    { id: 'comparator-combined', system: 'comparator', store: 'comparator', config: COMPARATOR_COMBINED, overrides: COMPARATOR_COMBINED, presence: 'memories', note: 'facts plus raw chunks' },
  ],
};

/** Lanes the plan names that a system cannot run at the measured builds, reported instead of run. */
export const NOT_SUPPORTED = [
  { suite: 'passing-details', arm: 'gbrain-facts', reason: 'gbrain has no query-ranked fact retrieval at e8e1f66b: `recall` lists facts by entity, session or time, and `query` returns only saved facts sharing three quarters of the question\'s words beside its page blocks' },
  { suite: 'passing-details', arm: 'comparator-raw', reason: 'the comparator returns raw chunks only attached to the facts they came from; its recall has no chunks-only mode' },
];

export interface AnswerReceipt {
  suite: SuiteId;
  arm: string;
  model: string;
  query_id: string;
  unit: string;
  checkpoint?: number;
  prompt_sha256: string;
  prompt: string;
  context_tokens_cl100k: number | null;
  retrieve_meta: Record<string, unknown> | null;
  answer_raw: string;
  answer: string;
  error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function readerPrompt(query: HarnessQuery, context: string): string {
  return MODEL_CONFIG.reader.prompt
    .replace('{context}', context.trim() ? context : MODEL_CONFIG.reader.no_memory_context)
    .replace('{query_date}', query.meta.query_timestamp.slice(0, 10))
    .replace('{question}', query.query);
}

export function parseAnswer(text: string): string {
  const m = /Answer:\s*([\s\S]*)$/i.exec(text);
  return (m ? m[1]! : text).trim();
}

const maxTokensFor = (model: string) => model.startsWith('openai:') ? 4000 : MODEL_CONFIG.reader.max_output_tokens;

/** Identifiers that must never reach a model: every document, query and unit id of the bundle. */
function forbiddenIds(bundle: SuiteBundle): string[] {
  const ids = new Set<string>([...bundle.documents.map(d => d.id), ...bundle.queries.map(q => q.id), ...bundle.documents.map(d => d.user_id)]);
  for (const item of (bundle.extra.corrections as CorrectionItem[] | undefined) ?? []) { ids.add(item.correction_document.id); ids.add(item.item_id); }
  return [...ids];
}

function leakCheck(prompt: string, forbidden: string[], where: string): void {
  if (/answer_/.test(prompt)) throw new Error(`leak: ${where} carries an answer_ marker`);
  const lower = prompt.toLowerCase();
  const hit = forbidden.find(id => lower.includes(id.toLowerCase()));
  if (hit) throw new Error(`leak: ${where} carries the identifier ${hit}`);
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]!); }));
}

export function selectQueries(bundle: SuiteBundle, smoke: number | null): HarnessQuery[] {
  if (!smoke) return bundle.queries;
  if (bundle.suite === 'corrections') {
    const units = [...new Set(bundle.queries.map(q => q.user_id))].sort((a, b) => sha256(a) < sha256(b) ? -1 : 1).slice(0, Math.ceil(smoke / 3));
    return bundle.queries.filter(q => units.includes(q.user_id));
  }
  // Fewest units that give `smoke` questions spread over categories: hash-ordered units, then hash-ordered questions.
  const units = [...new Set(bundle.queries.map(q => q.user_id))].sort((a, b) => sha256(a) < sha256(b) ? -1 : 1);
  const out: HarnessQuery[] = [];
  for (const u of units) {
    const qs = bundle.queries.filter(q => q.user_id === u).sort((a, b) => sha256(a.id) < sha256(b.id) ? -1 : 1);
    out.push(...qs.slice(0, Math.max(1, Math.min(qs.length, smoke - out.length, bundle.suite === 'time-relationships' ? 10 : 7))));
    if (out.length >= smoke) break;
  }
  return out;
}

function writeJson(path: string, value: unknown) { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 1) + '\n'); }
const receiptPath = (dir: string, arm: string, model: string, qid: string) => join(dir, 'answers', arm, model.replace(/[:/]/g, '_'), `${qid}.json`);

async function answerOne(bench: Bench, bundle: SuiteBundle, dir: string, arm: string, model: string, q: HarnessQuery, context: string, meta: RetrieveReceipt | null, forbidden: string[], extra: Partial<AnswerReceipt> = {}): Promise<AnswerReceipt> {
  const path = receiptPath(dir, arm, model, q.id + (extra.checkpoint !== undefined ? '' : ''));
  if (existsSync(path)) {
    const prior = JSON.parse(readFileSync(path, 'utf8')) as AnswerReceipt;
    if (!prior.error) return prior;
  }
  const prompt = readerPrompt(q, context);
  leakCheck(prompt, forbidden, `the ${model} prompt for ${q.id}`);
  const reply = await bench.model(model, prompt, { tag: `${bundle.suite}/${arm}/reader/${q.id}`, maxTokens: maxTokensFor(model) });
  const receipt: AnswerReceipt = {
    suite: bundle.suite, arm, model, query_id: q.id, unit: q.user_id, prompt_sha256: sha256(prompt), prompt,
    context_tokens_cl100k: meta?.tokens_cl100k ?? null, retrieve_meta: meta ? { ...meta.meta, retrieve_ms: meta.retrieve_ms } : null,
    answer_raw: reply.text, answer: parseAnswer(reply.text), error: reply.error ?? null,
    input_tokens: reply.input_tokens, output_tokens: reply.output_tokens, ...extra,
  };
  writeJson(path, receipt);
  return receipt;
}

// ─── answer phase: static suites ──────────────────────────────────────────

async function answerStatic(bench: Bench, bundle: SuiteBundle, dir: string, armIds: string[] | null, queries: HarnessQuery[], log: (l: string) => void) {
  const arms = BENCH_ARMS[bundle.suite as Exclude<SuiteId, 'corrections'>].filter(a => !armIds || armIds.includes(a.id));
  const labels = new Map(bundle.labels.map(l => [l.query_id, l]));
  const forbidden = forbiddenIds(bundle);
  const units = [...new Set(queries.map(q => q.user_id))];
  const byStore = new Map<string, BenchArm[]>();
  for (const a of arms) byStore.set(a.store, [...(byStore.get(a.store) ?? []), a]);
  for (const [store, storeArms] of byStore) {
    const first = storeArms[0]!;
    const storeDir = join(dir, 'stores', store);
    const receiptFile = join(dir, 'ingest', `${store}.json`);
    const prior = existsSync(receiptFile) && existsSync(storeDir) ? JSON.parse(readFileSync(receiptFile, 'utf8')).units as Record<string, Record<string, unknown>> : {};
    const reuse = Object.keys(prior).length > 0;
    if (!reuse) rmSync(storeDir, { recursive: true, force: true });
    const bridge = await bench.bridge(first.system, { ...first.config }, storeDir, first.credentials, !reuse);
    const ingestReceipts: Record<string, unknown> = { ...prior };
    if (reuse) log(`[${bundle.suite}/${store}] reusing the ingested store for ${Object.keys(prior).length} units`);
    try {
      for (const unit of units) {
        const docs = bundle.documents.filter(d => d.user_id === unit);
        if (prior[unit]) {
          await answerUnit(unit);
          continue;
        }
        const t0 = Date.now();
        const ing = await bridge.call<{ ms: number; receipts: Record<string, unknown> }>('ingest', { docs });
        const r: Record<string, unknown> = { documents: docs.length, ingest: ing.receipts[unit], ms: Date.now() - t0 };
        if (first.extractFacts) r.extract_facts = await extractFacts(bridge, unit, log);
        const needles = queries.filter(q => q.user_id === unit).flatMap(q => labels.get(q.id)!.needles.map(n => ({ doc_id: n.doc_id, value: n.value })));
        r.presence = await presence(bridge, unit, needles, first.presence);
        ingestReceipts[unit] = r;
        const missing = Object.entries((r.presence as { found: Record<string, boolean> }).found).filter(([, v]) => !v).map(([k]) => k);
        log(`[${bundle.suite}/${store}] unit ${unit}: ${docs.length} docs ingested in ${r.ms} ms; presence ${Object.keys((r.presence as { found: object }).found).length - missing.length}/${Object.keys((r.presence as { found: object }).found).length}`);
        writeJson(receiptFile, { store, system: first.system, config: first.config, extract_facts: !!first.extractFacts, units: ingestReceipts });
        await answerUnit(unit);
      }
    } finally {
      writeJson(receiptFile, { store, system: first.system, config: first.config, extract_facts: !!first.extractFacts, units: ingestReceipts });
      await bridge.close();
    }

    async function answerUnit(unit: string) {
        for (const arm of storeArms) {
          const unitQueries = queries.filter(q => q.user_id === unit);
          const contexts: Array<[HarnessQuery, RetrieveReceipt]> = [];
          for (const q of unitQueries) {
            const done = receiptPath(dir, arm.id, MODEL_CONFIG.fixed_reader.id, q.id);
            if (existsSync(done) && !JSON.parse(readFileSync(done, 'utf8')).error) continue;
            contexts.push([q, await bridge.call<RetrieveReceipt>('retrieve', { unit, query: q.query, query_timestamp: q.meta.query_timestamp, overrides: arm.overrides })]);
          }
          await pool(contexts, 6, async ([q, ret]) => { await answerOne(bench, bundle, dir, arm.id, MODEL_CONFIG.fixed_reader.id, q, ret.context, ret, forbidden); });
          if (bench.proxy.exhausted) throw new Error(`budget exhausted: ${bench.proxy.lastRefusal}`);
        }
    }
  }
}

async function extractFacts(bridge: Bridge, unit: string, log: (l: string) => void): Promise<Record<string, unknown>> {
  try {
    const r = await bridge.call<{ stdout: string; ms: number }>('gbrain_cli', { unit, args: ['extract-conversation-facts', '--yes', '--json', '--max-cost-usd', '5', '--workers', '8'] });
    const json = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    return { ms: r.ms, facts_inserted: json.facts_inserted, pages_processed: json.pages_processed, pages_skipped: json.pages_skipped, pages_failed: json.pages_failed, spent_usd: json.spent_usd, outcome: json.outcome };
  } catch (e) {
    log(`[extract] unit ${unit}: ${(e as Error).message.slice(0, 400)}`);
    return { error: (e as Error).message.slice(0, 2000) };
  }
}

async function presence(bridge: Bridge, unit: string, needles: Array<{ doc_id: string; value: string }>, kind: BenchArm['presence']): Promise<{ found: Record<string, boolean>; by_kind: Record<string, Record<string, boolean>> }> {
  const kinds = kind === 'memories' ? ['chunks', 'facts'] : kind === 'pages' ? ['pages'] : ['pages', 'facts'];
  const by: Record<string, Record<string, boolean>> = {};
  for (const k of kinds) by[k] = (await bridge.call<{ found: Record<string, boolean> }>('presence', { unit, needles, kind: k })).found;
  const values = [...new Set(needles.map(n => n.value))];
  return { found: Object.fromEntries(values.map(v => [v, kinds.some(k => by[k]![v])])), by_kind: by };
}

// ─── answer phase: corrections ────────────────────────────────────────────

function gbrainHasReplaces(gutRoot: string): boolean {
  const src = readFileSync(join(gutRoot, 'src/core/verbs.ts'), 'utf8');
  const remember = src.slice(src.indexOf("name: 'remember'"), src.indexOf('handler:', src.indexOf("name: 'remember'")));
  return /\breplaces\s*:/.test(remember);
}

async function answerCorrections(bench: Bench, bundle: SuiteBundle, dir: string, armIds: string[] | null, queries: HarnessQuery[], log: (l: string) => void) {
  const units = new Set(queries.map(q => q.user_id));
  const sub: SuiteBundle = {
    ...bundle,
    documents: bundle.documents.filter(d => units.has(d.user_id)),
    queries: bundle.queries.filter(q => units.has(q.user_id)),
    labels: bundle.labels.filter(l => queries.some(q => q.id === l.query_id)),
    extra: {
      ...bundle.extra,
      corrections: (bundle.extra.corrections as CorrectionItem[]).filter(i => units.has(i.unit)),
      schedule: (bundle.extra.schedule as Array<{ unit: string }>).filter(o => units.has(o.unit)),
    },
  };
  const forbidden = forbiddenIds(bundle);
  const hasReplaces = gbrainHasReplaces(bench.gut.root);
  const results: Record<string, unknown> = {};
  for (const arm of CORRECTION_ARMS.filter(a => !armIds || armIds.includes(a.id))) {
    const storeDir = join(dir, 'stores', arm.id);
    if (arm.id === 'gbrain-remember-replaces' && !hasReplaces) {
      results[arm.id] = { arm: arm.id, status: 'not_run', reason: 'the remember operation has no `replaces` parameter at the measured gbrain build' };
      writeJson(join(dir, 'corrections-runs', `${arm.id}.json`), results[arm.id]);
      log(`[corrections/${arm.id}] not run: remember has no replaces parameter at this build`);
      continue;
    }
    rmSync(storeDir, { recursive: true, force: true });
    const bridge = arm.system === 'gbrain'
      ? await bench.bridge('gbrain', { ...GBRAIN_BASE }, storeDir)
      : await bench.bridge('comparator', { ...COMPARATOR_COMBINED }, storeDir);
    try {
      const adapter = arm.system === 'gbrain' ? new GbrainCorrectionAdapter(bridge) : new ComparatorCorrectionAdapter(bridge, COMPARATOR_COMBINED);
      if (adapter instanceof GbrainCorrectionAdapter) adapter.hasReplaces = hasReplaces;
      let n = 0;
      const pendingQ = new Map(sub.queries.map(q => [q.id, q]));
      const result = await runCorrectionArm(adapter, arm, sub, async (label: ScorerLabel, query: HarnessQuery, context: string) => {
        const ret = adapter.retrievals[adapter.retrievals.length - 1]!;
        const r = await answerOne(bench, bundle, dir, arm.id, MODEL_CONFIG.fixed_reader.id, pendingQ.get(query.id)!, context, ret, forbidden, { checkpoint: Number(query.meta.checkpoint) });
        if (++n % 30 === 0) log(`[corrections/${arm.id}] ${n} probes answered`);
        if (bench.proxy.exhausted) throw new Error(`budget exhausted: ${bench.proxy.lastRefusal}`);
        return r.error ? '' : r.answer;
      });
      results[arm.id] = { ...result, probes: result.probes.map(p => ({ ...p, context: undefined, context_sha256: sha256(p.context) })) };
      log(`[corrections/${arm.id}] ${JSON.stringify(result.metrics)}`);
    } finally {
      if (results[arm.id]) writeJson(join(dir, 'corrections-runs', `${arm.id}.json`), results[arm.id]);
      await bridge.close();
    }
  }
}

// ─── sweep and score ──────────────────────────────────────────────────────

function readReceipts(dir: string, arm: string, model: string): AnswerReceipt[] {
  const d = join(dir, 'answers', arm, model.replace(/[:/]/g, '_'));
  if (!existsSync(d)) return [];
  return readdirSync(d).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(readFileSync(join(d, f), 'utf8')) as AnswerReceipt);
}

function armsWithAnswers(dir: string): string[] {
  return existsSync(join(dir, 'answers')) ? readdirSync(join(dir, 'answers')).sort() : [];
}

async function sweep(bench: Bench, bundle: SuiteBundle, dir: string, models: string[], log: (l: string) => void) {
  const subset = new Set(frontierSubset(bundle));
  const queries = new Map(bundle.queries.map(q => [q.id, q]));
  const forbidden = forbiddenIds(bundle);
  for (const arm of armsWithAnswers(dir)) {
    const base = readReceipts(dir, arm, MODEL_CONFIG.fixed_reader.id).filter(r => subset.has(r.query_id) && !r.error);
    for (const model of models) {
      await pool(base, 6, async r => {
        const path = receiptPath(dir, arm, model, r.query_id);
        if (existsSync(path) && !JSON.parse(readFileSync(path, 'utf8')).error) return;
        leakCheck(r.prompt, forbidden, `the ${model} prompt for ${r.query_id}`);
        const reply = await bench.model(model, r.prompt, { tag: `${bundle.suite}/${arm}/reader/${r.query_id}`, maxTokens: maxTokensFor(model) });
        writeJson(path, { ...r, model, answer_raw: reply.text, answer: parseAnswer(reply.text), error: reply.error ?? null, input_tokens: reply.input_tokens, output_tokens: reply.output_tokens });
      });
      if (bench.proxy.exhausted) throw new Error(`budget exhausted: ${bench.proxy.lastRefusal}`);
      log(`[${bundle.suite}/${arm}] sweep ${model}: ${base.length} questions`);
      void queries;
    }
  }
}

const JUDGE_PROMPT = `You are grading one answer to a question about a user's past conversations.
Question: {question}
Correct answer: {gold}
Outdated or wrong values a careless answer might give: {wrong}
Answer to grade: {answer}

The answer is correct only if it commits to the correct answer as the current answer. Mentioning an outdated value as history is fine; hedging between values or committing to a wrong value is not.
Reply with exactly one line of JSON: {"correct": true} or {"correct": false}.`;

export interface ScoredAnswer { query_id: string; category: string; checkpoint?: number; outcome: Outcome | 'error'; correct: boolean; judged: boolean; miss?: string; context_tokens: number | null }

async function score(bench: Bench | null, bundle: SuiteBundle, dir: string, log: (l: string) => void) {
  const suite = SUITES[bundle.suite];
  const labels = new Map(bundle.labels.map(l => [l.query_id, l]));
  const queries = new Map(bundle.queries.map(q => [q.id, q]));
  const presenceByUnit = new Map<string, Record<string, boolean>>();
  if (existsSync(join(dir, 'ingest'))) {
    for (const f of readdirSync(join(dir, 'ingest'))) {
      const ing = JSON.parse(readFileSync(join(dir, 'ingest', f), 'utf8'));
      for (const [unit, r] of Object.entries(ing.units as Record<string, { presence?: { found: Record<string, boolean>; by_kind?: Record<string, Record<string, boolean>> } }>)) {
        presenceByUnit.set(`${ing.store}/${unit}`, r.presence?.found ?? {});
        for (const [kind, found] of Object.entries(r.presence?.by_kind ?? {})) presenceByUnit.set(`${ing.store}/${unit}/${kind}`, found);
      }
    }
  }
  const out: Record<string, Record<string, { n: number; correct: number; accuracy: number; by_category: Record<string, { n: number; correct: number }>; outcomes: Record<string, number>; judged: number; misses?: Record<string, number>; checkpoints?: Record<string, unknown>; context_tokens: { mean: number | null; p95: number | null }; rows: ScoredAnswer[] }>> = {};
  const models = [MODEL_CONFIG.fixed_reader.id, ...MODEL_CONFIG.frontier_sweep.map(m => m.id).filter(m => m !== MODEL_CONFIG.fixed_reader.id)];
  for (const arm of armsWithAnswers(dir)) {
    for (const model of models) {
      const receipts = readReceipts(dir, arm, model);
      if (!receipts.length) continue;
      const rows: ScoredAnswer[] = [];
      for (const r of receipts) {
        const label = labels.get(r.query_id)!;
        const q = queries.get(r.query_id)!;
        if (r.error) { rows.push({ query_id: r.query_id, category: label.category, checkpoint: r.checkpoint, outcome: 'error', correct: false, judged: false, context_tokens: r.context_tokens_cl100k }); continue; }
        let { outcome } = suite.score(label, r.answer);
        let correct = outcome === 'correct';
        let judged = false;
        if (outcome === 'ambiguous' && bench) {
          const wrong = [...(label.gold.kind === 'value' ? label.gold.stale ?? [] : []), ...label.distractors.map(d => d.value)].filter(v => countValue(r.answer, v) > 0);
          const prompt = JUDGE_PROMPT.replace('{question}', q.query).replace('{gold}', q.gold_answers.join('; ')).replace('{wrong}', wrong.join('; ') || 'none').replace('{answer}', r.answer);
          const reply = await bench.model(MODEL_CONFIG.judge.id, prompt, { tag: `${bundle.suite}/${arm}/judge/${r.query_id}`, maxTokens: 2000 });
          const m = /\{\s*"correct"\s*:\s*(true|false)\s*\}/.exec(reply.text);
          if (m) { judged = true; correct = m[1] === 'true'; outcome = correct ? 'correct' : 'wrong'; }
        }
        const row: ScoredAnswer = { query_id: r.query_id, category: label.category, checkpoint: r.checkpoint, outcome, correct, judged, context_tokens: r.context_tokens_cl100k };
        if (bundle.suite === 'passing-details' && label.gold.kind === 'value') {
          const store = BENCH_ARMS['passing-details'].find(a => a.id === arm)?.store ?? arm;
          // A facts-only lane stores only what extraction kept, so its presence is the facts check alone.
          const found = presenceByUnit.get(arm === 'comparator-facts' ? `${store}/${r.unit}/facts` : `${store}/${r.unit}`);
          const stored = found && label.gold.value in found ? found[label.gold.value]! : null;
          const context = r.prompt.slice(r.prompt.indexOf('Context:'), r.prompt.lastIndexOf('Question (asked on'));
          row.miss = classifyMiss(label, { outcome: correct ? 'correct' : outcome === 'ambiguous' ? 'wrong' : outcome as Outcome, stored, deliveredContext: context });
        }
        rows.push(row);
      }
      const byCat: Record<string, { n: number; correct: number }> = {};
      const outcomes: Record<string, number> = {};
      const misses: Record<string, number> = {};
      for (const row of rows) {
        const key = row.checkpoint !== undefined ? `${row.category}@${row.checkpoint}` : row.category;
        byCat[key] ??= { n: 0, correct: 0 };
        byCat[key].n++;
        if (row.correct) byCat[key].correct++;
        outcomes[row.outcome] = (outcomes[row.outcome] ?? 0) + 1;
        if (row.miss) misses[row.miss] = (misses[row.miss] ?? 0) + 1;
      }
      const checkpoints: Record<string, { n: number; correct: number; stale: number; corrected_value_accuracy: number; stale_answer_rate: number }> = {};
      for (const row of rows) {
        if (row.checkpoint === undefined) continue;
        const c = (checkpoints[String(row.checkpoint)] ??= { n: 0, correct: 0, stale: 0, corrected_value_accuracy: 0, stale_answer_rate: 0 });
        c.n++;
        if (row.correct) c.correct++;
        if (row.outcome === 'stale') c.stale++;
      }
      for (const c of Object.values(checkpoints)) { c.corrected_value_accuracy = c.correct / c.n; c.stale_answer_rate = c.stale / c.n; }
      const toks = rows.map(r => r.context_tokens).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b);
      const correct = rows.filter(r => r.correct).length;
      out[arm] ??= {};
      out[arm][model] = {
        n: rows.length, correct, accuracy: rows.length ? correct / rows.length : 0, by_category: byCat, outcomes, judged: rows.filter(r => r.judged).length,
        ...(Object.keys(misses).length ? { misses } : {}),
        ...(Object.keys(checkpoints).length ? { checkpoints } : {}),
        context_tokens: { mean: toks.length ? Math.round(toks.reduce((a, b) => a + b, 0) / toks.length) : null, p95: toks.length ? toks[Math.min(toks.length - 1, Math.floor(toks.length * 0.95))]! : null },
        rows,
      };
      log(`[${bundle.suite}/${arm}] ${model}: ${correct}/${rows.length} correct (${(100 * correct / rows.length).toFixed(1)}%)`);
    }
  }
  writeJson(join(dir, 'results.json'), { suite: bundle.suite, scored_at: new Date().toISOString(), results: out });
}

// ─── main ─────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const suiteId = argv[0] as SuiteId;
  const suite = SUITES[suiteId];
  if (!suite) { console.error('usage: bun eval/workload-suites/bench.ts <suite> --phase answer|sweep|score [--arms a,b] [--smoke N] [--budget-usd N] [--out DIR] [--stub] [--models m1,m2]'); process.exit(2); }
  const phase = arg(argv, '--phase') ?? 'answer';
  const smoke = arg(argv, '--smoke') ? Number(arg(argv, '--smoke')) : null;
  const stub = argv.includes('--stub');
  const dir = resolve(arg(argv, '--out') ?? join(REPO_ROOT, 'eval/reports/workload-bench', `${suiteId}${smoke ? `-smoke${smoke}` : ''}${stub ? '-stub' : ''}`));
  const log = (l: string) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${l}\n`);
  const bundle = suite.generate({ seed: suite.defaultSeed, smoke: false });
  bundle.extra['frontier-subset'] = frontierSubset(bundle);
  const committed = JSON.parse(readFileSync(manifestPath(suite), 'utf8'));
  if (bundleManifest(bundle).digest !== committed.digest) { console.error(`${suiteId}: the generated bundle differs from its committed manifest; refusing to run`); process.exit(1); }
  const queries = selectQueries(bundle, smoke);
  const budget = Number(arg(argv, '--budget-usd') ?? 5);
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv) ?? `${process.env.HOME}/.capy/work/gbrain@e8e1f66b8e5225b113cacd18931b627fca451bae`);
  const armIds = arg(argv, '--arms')?.split(',') ?? null;
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'run.json'), { suite: suiteId, manifest_digest: committed.digest, gbrain: { root: gut.root.replace(REPO_ROOT + '/', ''), version: gut.version, overlay: gut.overlay ? { ref: gut.overlay.ref } : null }, smoke, scheduled: queries.map(q => q.id), target_tokens: TARGET_TOKENS, models: MODEL_CONFIG, not_supported: NOT_SUPPORTED.filter(n => n.suite === suiteId) });
  const needsBench = phase !== 'score' || true;
  const bench = needsBench ? await startBench({ runner: `workload-${suiteId}-${phase}${smoke ? `-smoke${smoke}` : ''}`, budgetUsd: budget, outDir: dir, gut, stub }) : null;
  let code = 0;
  try {
    if (phase === 'answer') {
      if (suiteId === 'corrections') await answerCorrections(bench!, bundle, dir, armIds, queries, log);
      else await answerStatic(bench!, bundle, dir, armIds, queries, log);
    } else if (phase === 'sweep') {
      const models = arg(argv, '--models')?.split(',') ?? MODEL_CONFIG.frontier_sweep.map(m => m.id).filter(m => m !== MODEL_CONFIG.fixed_reader.id);
      await sweep(bench!, bundle, dir, models, log);
    } else if (phase === 'score') {
      await score(bench, bundle, dir, log);
    }
  } catch (e) {
    log(`FAILED: ${(e as Error).stack ?? e}`);
    code = 1;
  } finally {
    if (bench) {
      const spend = bench.close();
      const path = join(dir, 'spend.json');
      const prior = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { runs: [] };
      prior.runs.push({ phase, ...spend, by_label: bench.proxy.stats().byLabel, at: new Date().toISOString(), stub });
      writeJson(path, prior);
      log(`spend this run: $${spend.usd.toFixed(4)} over ${spend.requests} requests`);
    }
  }
  process.exit(code);
}

void createHash;

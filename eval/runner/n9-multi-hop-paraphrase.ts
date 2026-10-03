/**
 * N9 multi-hop with held-out wording (eval-category wave, amendment 9).
 *
 * Extends relational-ab instead of adding a parallel harness: the same
 * shared-index core (runSharedIndexPairs), the same pins, the same paired
 * off/on arms over one extracted index per ingestion seed, the same
 * telemetry checks. What it adds:
 *
 *   - 125 composed two- and three-hop questions from a grammar that was
 *     hash-committed before any scoring (eval/generators/
 *     n9-multihop-paraphrase-gen.ts), each in a canonical and a paraphrase
 *     wording (splits composed-template and composed-paraphrase);
 *   - strict supporting-fact all-hit@10: every support page and every answer
 *     page among the distinct pages of the first 10 result rows;
 *   - a stage funnel (parsed, seed resolved, fired, all support delivered);
 *   - a composed-query capability check of parseRelationalQuery: gbrain parses
 *     one relation per question, so a composed plan is a feature gap, and the
 *     score is what the system returns anyway;
 *   - controls: solvability, single-page shortcut subset, a gold-shuffle
 *     negative control, and an anchor-lookup presence assertion that voids
 *     the run when the index is not searchable;
 *   - the one-hop template and paraphrase splits on the same index (keyword
 *     arm only; the 2026-09-29 paraphrase split is development data).
 *
 * Hermetic by default: keyword search, provider and TypeSafe keys stripped,
 * fresh GBRAIN_HOME (System One off). The paid arm (hybrid search with OpenAI
 * embeddings, composed splits only) runs only with --paid --budget-run-id.
 *
 *   bun eval/runner/n9-multi-hop-paraphrase.ts
 *   bun eval/runner/n9-multi-hop-paraphrase.ts --gbrain ../gbrain@3a284ae --output /tmp/n9
 *   bun eval/runner/n9-multi-hop-paraphrase.ts --paid --budget-run-id <id>
 *
 * Decision rules and void conditions: docs/benchmarks/2026-10-01-n9-multi-hop-preregistration.md.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGLiteEngine } from 'gbrain/pglite-engine';
import { buildRelationalQueries, loadWorldCorpus } from './queries/relational.ts';
import { templateOfText } from '../generators/relational-paraphrase-gen.ts';
import {
  N9_FAMILY_RELATIONS, N9_K, N9_QUESTIONS_PATH, renderN9QuestionFile,
  type N9Family, type N9Question, type N9QuestionFile, type Relation,
} from '../generators/n9-multihop-paraphrase-gen.ts';
import {
  RELATIONAL_EMBEDDER, RELATIONAL_LIMIT, RELATIONAL_PINS, RELATIONAL_SEEDS, loadRelationalProduct, paraphraseQueries,
  runSharedIndexPairs, searchRelationalPair, summarizeRelationalRows,
  type ArmResult, type EmbedMode, type PairedRow, type RelationalProduct, type RelationalSearch, type SharedIndexQuery,
} from './relational-ab.ts';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { DECIDE_OFF, withHermeticEnv } from './hermetic-env.ts';
import { requirePaidArm, paidRequested } from './paid-arm.ts';
import { budgetOptionsFrom, receiptCost, startPaidRun } from './budget-ledger.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { exactMcNemar, type PairedItem } from './stats/paired.ts';
import { upsertBug, type BugEntry } from './bug-ledger.ts';
import {
  BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, latencySummary, noModelSpend, sourceTreeIdentity, writeReceipt, type Receipt,
} from './receipt.ts';
import { gbrainPin } from './gbrain-version.ts';

export const CATEGORY = 'n9-multi-hop-paraphrase';
export const COMPOSED_SPLITS = ['composed-template', 'composed-paraphrase'] as const;
export const ONE_HOP_SPLITS = ['one-hop-template', 'one-hop-paraphrase'] as const;
export const N9_PAID_ESTIMATE_USD = 0.07;
/** Presence: at least this share of distinct anchors must be found by name in each seed's index. */
export const PRESENCE_MIN_RATE = 0.5;

/** gbrain link types (src/core/search/relational-intent.ts vocabulary) for each composed relation; null = no link type. */
export const RELATION_LINK_TYPES: Record<Relation, readonly string[] | null> = {
  invested_in: ['invested_in', 'led_round'],
  has_investor: ['invested_in', 'led_round'],
  founded_by: ['founded'],
  advises: ['advises'],
  attended: ['attended'],
  topic: null,
};

// ─── Scorer (pure) ──────────────────────────────────────────────────

export interface ComposedGold { required: readonly string[]; answers: readonly string[]; support: readonly string[] }
export interface ComposedScore {
  strict_all_hit: number;
  answer_all_hit: number;
  support_all_hit: number;
  answer_recall: number;
  strict_all_hit_at_5: number;
}

/** Distinct pages of the first `rows` result rows, in product order. */
export function pagesOfFirstRows(resultRows: readonly { slug: string }[], rows: number): string[] {
  const out: string[] = [];
  for (const r of resultRows.slice(0, rows)) if (!out.includes(r.slug)) out.push(r.slug);
  return out;
}

const allIn = (needed: readonly string[], got: ReadonlySet<string>) => needed.every(s => got.has(s));

/** Strict supporting-fact all-hit over the first k result rows; an empty gold never scores (it cannot be "all hit"). */
export function scoreComposed(resultRows: readonly { slug: string }[], gold: ComposedGold, k = N9_K): ComposedScore {
  const atK = new Set(pagesOfFirstRows(resultRows, k));
  const at5 = new Set(pagesOfFirstRows(resultRows, 5));
  const hit = (needed: readonly string[], got: ReadonlySet<string>) => (needed.length > 0 && allIn(needed, got) ? 1 : 0);
  return {
    strict_all_hit: hit(gold.required, atK),
    answer_all_hit: hit(gold.answers, atK),
    support_all_hit: hit(gold.support, atK),
    answer_recall: gold.answers.length ? gold.answers.filter(a => atK.has(a)).length / gold.answers.length : 0,
    strict_all_hit_at_5: hit(gold.required, at5),
  };
}

/** The category verdict over one arm's answers: valid when every answer was scored; the rate is reported, never gated. */
export function composedRate(answers: readonly (readonly { slug: string }[])[], golds: readonly ComposedGold[]): number {
  if (!golds.length) return 0;
  return answers.reduce((n, rows, i) => n + scoreComposed(rows, golds[i]!).strict_all_hit, 0) / golds.length;
}

/** Fixed derangement within each family: question i is scored against the gold of the next question of its family. */
export function shuffledGold(questions: readonly N9Question[]): Map<string, N9Question | null> {
  const out = new Map<string, N9Question | null>();
  const byFamily = new Map<string, N9Question[]>();
  for (const q of questions) byFamily.set(q.family, [...(byFamily.get(q.family) ?? []), q]);
  for (const qs of byFamily.values()) qs.forEach((q, i) => out.set(q.id, qs.length > 1 ? qs[(i + 1) % qs.length]! : null));
  return out;
}

// ─── Capability check ───────────────────────────────────────────────

export interface ParsedRelational { kind: string | null; seeds: string[]; linkTypes: string[] | null; direction: string; relationPhrase?: string }

export interface CapabilityRow {
  question_id: string;
  split: string;
  text: string;
  parsed: ParsedRelational | null;
  /** Relation sets in the parse: 0 (no parse) or 1. A composed plan needs one per hop. */
  relation_sets: number;
  composed_plan: boolean;
  relation_match: 'no_parse' | 'first_hop' | 'last_hop' | 'middle_hop' | 'untyped' | 'other_relation';
  seed_match: 'no_parse' | 'anchor' | 'phrase_containing_anchor' | 'other';
}

export function classifyParse(q: Pick<N9Question, 'relations' | 'anchor_name'>, parsed: ParsedRelational | null): Omit<CapabilityRow, 'question_id' | 'split' | 'text' | 'parsed'> {
  if (!parsed || !parsed.kind) return { relation_sets: 0, composed_plan: false, relation_match: 'no_parse', seed_match: 'no_parse' };
  const matches = (rel: Relation) => {
    const types = RELATION_LINK_TYPES[rel];
    return types !== null && parsed.linkTypes !== null && parsed.linkTypes.some(t => types.includes(t));
  };
  const last = q.relations.length - 1;
  const relation_match = parsed.linkTypes === null ? 'untyped'
    : matches(q.relations[0]!) ? 'first_hop'
      : matches(q.relations[last]!) ? 'last_hop'
        : q.relations.slice(1, last).some(matches) ? 'middle_hop' : 'other_relation';
  const anchor = q.anchor_name.toLowerCase();
  const seeds = parsed.seeds.map(s => s.toLowerCase().trim());
  const seed_match = seeds.some(s => s === anchor) ? 'anchor' : seeds.some(s => s.includes(anchor)) ? 'phrase_containing_anchor' : 'other';
  return { relation_sets: 1, composed_plan: false, relation_match, seed_match };
}

// ─── Summaries ──────────────────────────────────────────────────────

export interface ComposedRow {
  seed: number;
  question_id: string;
  split: string;
  family: N9Family;
  hops: number;
  shortcut: boolean;
  edges_stated: boolean;
  off: ComposedScore | null;
  on: ComposedScore | null;
  off_shuffled: number | null;
  on_shuffled: number | null;
  funnel: { parsed: boolean; seed_resolved: boolean; fired: boolean; candidates: number; all_support: boolean } | null;
  error: string | null;
}

const METRIC_KEYS = ['strict_all_hit', 'answer_all_hit', 'support_all_hit', 'answer_recall', 'strict_all_hit_at_5'] as const;

function mean(xs: readonly number[]): number | null { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }

export function summarizeComposed(rows: readonly ComposedRow[]) {
  const scored = rows.filter(r => r.off && r.on);
  const arm = (key: 'off' | 'on') => ({
    n: scored.length,
    ...(Object.fromEntries(METRIC_KEYS.map(m => [m, mean(scored.map(r => r[key]![m]))])) as Record<typeof METRIC_KEYS[number], number | null>),
    strict_all_hit_count: scored.filter(r => r[key]!.strict_all_hit === 1).length,
    shuffled_gold_strict_all_hit: mean(scored.filter(r => r[`${key}_shuffled`] !== null).map(r => r[`${key}_shuffled`]!)),
  });
  const runs = scored.map(r => r.on!.strict_all_hit - r.off!.strict_all_hit);
  const byQuestion = new Map<string, number[]>();
  for (const r of scored) byQuestion.set(r.question_id, [...(byQuestion.get(r.question_id) ?? []), r.on!.strict_all_hit - r.off!.strict_all_hit]);
  const questionMeans = [...byQuestion.entries()].map(([id, d]) => ({ id, d: mean(d)! }));
  // Exact sign test over distinct questions as a McNemar on binary pairs: on better (0,1), off better (1,0), tie (1,1).
  const pairs: PairedItem[] = questionMeans.map(({ id, d }) => ({ id, cluster: id, a: d > 0 ? 0 : 1, b: d < 0 ? 0 : 1 }));
  const sign = exactMcNemar(pairs);
  return {
    off: arm('off'), on: arm('on'),
    paired_runs: { n: runs.length, gains: runs.filter(d => d > 0).length, losses: runs.filter(d => d < 0).length, ties: runs.filter(d => d === 0).length },
    paired_questions: { n: questionMeans.length, gains: sign.wins, losses: sign.losses, ties: questionMeans.length - sign.discordant, sign_test_p_two_sided: sign.p_two_sided },
    funnel: {
      n: rows.length,
      parsed: rows.filter(r => r.funnel?.parsed).length,
      seed_resolved: rows.filter(r => r.funnel?.seed_resolved).length,
      fired: rows.filter(r => r.funnel?.fired).length,
      all_support_on: rows.filter(r => r.funnel?.all_support).length,
      product_errors: rows.filter(r => r.error !== null).length,
    },
  };
}

function groupSummary(rows: readonly ComposedRow[], keyOf: (r: ComposedRow) => string) {
  const keys = [...new Set(rows.map(keyOf))].sort();
  return Object.fromEntries(keys.map(k => [k, summarizeComposed(rows.filter(r => keyOf(r) === k))]));
}

// ─── Runner ─────────────────────────────────────────────────────────

export interface N9Options {
  seeds?: number[];
  outputDir?: string;
  gbrainSpec?: string | null;
  /** argv when paid work was requested; the paid arm then runs through requirePaidArm. */
  paidArgv?: string[] | null;
  recordBugs?: boolean;
  quiet?: boolean;
  /** Test seam: replaces the product's hybridSearch (the broken-adapter test). */
  search?: RelationalSearch;
  /** Test seam: a smaller corpus directory (gold is then regenerated from it, not read from the committed file). */
  corpusDir?: string;
  /** Run each ingestion seed's index in its own process (hermetic arm, default on); results merge in seed order. */
  parallelSeeds?: boolean;
  /** Internal: index one seed and write its rows to `workerOut` instead of scoring. */
  workerSeed?: number;
  workerOut?: string;
}

export function parseN9Args(argv: readonly string[]): N9Options {
  const o: N9Options = { gbrainSpec: gbrainSpecFrom(argv), paidArgv: paidRequested(argv) ? [...argv] : null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith('--')) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === '--seed') o.seeds = [Number(value())];
    else if (flag === '--seeds') o.seeds = value().split(',').map(Number);
    else if (flag === '--output') o.outputDir = value();
    else if (flag === '--record-bugs') o.recordBugs = true;
    else if (flag === '--quiet') o.quiet = true;
    else if (flag === '--serial-seeds') o.parallelSeeds = false;
    else if (flag === '--worker-seed') o.workerSeed = Number(value());
    else if (flag === '--worker-out') o.workerOut = value();
    else if (flag === '--paid') continue;
    else if (flag === '--gbrain' || flag === '--budget-run-id' || flag === '--budget-ledger') value();
    else if (flag.startsWith('--gbrain=') || flag.startsWith('--budget-run-id=')) continue;
    else throw new Error(`unknown option: ${flag}`);
  }
  if (o.seeds && (!o.seeds.length || o.seeds.some(s => !Number.isInteger(s) || s < 1))) throw new Error('--seed/--seeds need positive integers');
  return o;
}

/** Read the committed questions and refuse a file that differs from the generator (the grammar is frozen before scoring). */
export function loadN9Questions(corpusDir?: string): N9QuestionFile {
  const committed = readFileSync(N9_QUESTIONS_PATH, 'utf8');
  if (corpusDir === undefined && committed !== renderN9QuestionFile()) {
    throw new Error(`${N9_QUESTIONS_PATH} differs from eval/generators/n9-multihop-paraphrase-gen.ts output; the grammar must be frozen before scoring. Regenerate only in a reviewed commit made before any scoring run.`);
  }
  return JSON.parse(corpusDir === undefined ? committed : renderN9QuestionFile(corpusDir)) as N9QuestionFile;
}

const sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');

export interface N9Result { receipt: Receipt; exitCode: number; findings: BugEntry[] }

type Presence = { seed: number; anchors: number; found: number; rate: number };
interface SeedRun { rows: PairedRow[]; indices: Array<Record<string, unknown>>; presence: Presence[]; accounting: ReturnType<ProbeAccounting['toJSON']> }

/** Everything both the scorer and a seed worker need: the product, corpus, questions and query list. */
async function prepareN9(options: N9Options, paid: boolean) {
  const gut: GbrainUnderTest = resolveGbrainUnderTest(options.gbrainSpec ?? null);
  const product: RelationalProduct = await loadRelationalProduct(gut);
  const corpusDir = options.corpusDir ?? join(import.meta.dir, '../data/world-v1');
  const pages = loadWorldCorpus(corpusDir);
  const file = loadN9Questions(options.corpusDir);
  const questions = file.questions;
  const composedQueries: SharedIndexQuery[] = questions.flatMap(q => ([
    ['composed-template', q.template_text], ['composed-paraphrase', q.paraphrase_text],
  ] as const).map(([split, text]) => ({
    id: `${q.id}-${split === 'composed-template' ? 't' : 'p'}`, tier: 'hard' as const, text,
    expected_output_type: 'cited-source-pages' as const, gold: { relevant: q.required }, split, template: q.family, limit: N9_K,
  })));
  const oneHop: SharedIndexQuery[] = paid ? [] : (() => {
    const templates = buildRelationalQueries(pages).map(q => ({ ...q, split: 'template' as const, template: templateOfText(q.text) }));
    const paraphrases = paraphraseQueries(templates, options.corpusDir);
    return [
      ...templates.map(q => ({ ...q, split: 'one-hop-template', limit: RELATIONAL_LIMIT })),
      ...paraphrases.map(q => ({ ...q, split: 'one-hop-paraphrase', limit: RELATIONAL_LIMIT })),
    ];
  })();
  const anchors = [...new Map(questions.map(q => [q.anchor, q.anchor_name])).entries()];
  return { gut, product, pages, file, questions, composedQueries, queries: [...composedQueries, ...oneHop], anchors };
}

/** Build each seed's index in this process and run every paired query over it, plus the anchor presence probe. */
async function indexSeeds(prep: Awaited<ReturnType<typeof prepareN9>>, seeds: readonly number[], embed: EmbedMode, options: N9Options, accounting: ProbeAccounting, log: (s: string) => void): Promise<Omit<SeedRun, 'accounting'>> {
  const { product, pages, queries, anchors } = prep;
  const presence: Presence[] = [];
  const run = await runSharedIndexPairs({
    product, pages, queries, seeds, embed, search: options.search, accounting, log,
    afterIndex: async (engine: PGLiteEngine, seed: number, search: RelationalSearch) => {
      let found = 0;
      for (const [slug, name] of anchors) {
        const vector = embed === 'keyword' ? null : await product.embedQuery(name);
        const pair = await searchRelationalPair(engine, { id: `presence-${slug}`, text: name }, vector, search, { limit: N9_K });
        if (pair.off.pages.includes(slug)) found += 1;
      }
      presence.push({ seed, anchors: anchors.length, found, rate: found / anchors.length });
    },
  });
  return { rows: run.rows, indices: run.indices, presence };
}

/**
 * The same per-seed work, one child process per seed. Seeds are independent
 * (each builds a fresh index), so the merged rows equal a serial run's apart
 * from timing fields. Children inherit this process's stripped environment
 * and enter their own hermetic environment.
 */
async function indexSeedsInWorkers(seeds: readonly number[], options: N9Options, log: (s: string) => void): Promise<SeedRun[]> {
  const dir = mkdtempSync(join(tmpdir(), 'n9-seeds-'));
  try {
    return await Promise.all(seeds.map(seed => new Promise<SeedRun>((resolve, reject) => {
      const out = join(dir, `seed-${seed}.json`);
      const args = [import.meta.path, '--worker-seed', String(seed), '--worker-out', out, '--quiet', ...(options.gbrainSpec ? ['--gbrain', options.gbrainSpec] : [])];
      const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
      child.on('error', reject);
      child.on('close', code => {
        if (code !== 0) { reject(new Error(`N9 seed ${seed} worker exited ${code}: ${stderr.trim().split('\n').slice(-5).join(' | ')}`)); return; }
        log(`Relational OFF/ON: ingestion seed ${seed} finished in its own process`);
        resolve(JSON.parse(readFileSync(out, 'utf8')) as SeedRun);
      });
    })));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Worker entry (`--worker-seed`): index one seed and write its rows; no scoring and no receipt. */
async function runN9Worker(options: N9Options): Promise<void> {
  await withHermeticEnv('n9', async () => {
    const prep = await prepareN9(options, false);
    const accounting = new ProbeAccounting(prep.queries.length * 2);
    const run = await indexSeeds(prep, [options.workerSeed!], 'keyword', options, accounting, () => {});
    writeFileSync(options.workerOut!, JSON.stringify({ ...run, accounting: accounting.toJSON() } satisfies SeedRun));
  });
}

export async function runN9(options: N9Options = {}): Promise<N9Result> {
  const paid = options.paidArgv !== null && options.paidArgv !== undefined;
  if (paid) requirePaidArm(options.paidArgv!, { arm: 'N9 paid arm (hybrid search with OpenAI embeddings)', estimateUsd: N9_PAID_ESTIMATE_USD });
  const openaiKey = process.env.OPENAI_API_KEY;
  return withHermeticEnv('n9', async () => {
    if (paid) {
      if (!openaiKey) throw new Error('N9 paid arm needs OPENAI_API_KEY for embeddings; the hermetic arm needs no key (drop --paid).');
      process.env.OPENAI_API_KEY = openaiKey;
    }
    return runN9Inner(options, paid);
  });
}

async function runN9Inner(options: N9Options, paid: boolean): Promise<N9Result> {
  const started = new Date().toISOString();
  const log = options.quiet ? (_: string) => {} : (s: string) => console.log(s);
  const seeds = options.seeds ?? [...RELATIONAL_SEEDS];
  const embed: EmbedMode = paid ? 'openai' : 'keyword';
  const prep = await prepareN9(options, paid);
  const { gut, product, pages, file, questions, composedQueries, queries } = prep;
  const { parseRelationalQuery } = await importGbrain<{ parseRelationalQuery: (q: string) => ParsedRelational | null }>(gut, 'src/core/search/relational-intent.ts');
  const byId = new Map(questions.map(q => [q.id, q]));

  const capability: CapabilityRow[] = composedQueries.map(cq => {
    const q = byId.get(cq.id.slice(0, -2))!;
    let parsed: ParsedRelational | null = null;
    try { parsed = parseRelationalQuery(cq.text); } catch { parsed = null; }
    return { question_id: q.id, split: cq.split, text: cq.text, parsed, ...classifyParse(q, parsed) };
  });

  const presence: Presence[] = [];
  const accounting = new ProbeAccounting(seeds.length * queries.length * 2);
  const paidRun = paid ? startPaidRun(CATEGORY, { ...budgetOptionsFrom(options.paidArgv!), estimateUsd: N9_PAID_ESTIMATE_USD, log }) : null;
  let rows: PairedRow[] = [];
  let indices: Array<Record<string, unknown>> = [];
  const parallel = !paid && options.parallelSeeds !== false && !options.search && options.corpusDir === undefined && seeds.length > 1;
  try {
    if (parallel) {
      log(`Relational OFF/ON: ${seeds.length} ingestion seeds in parallel processes, ${queries.length} paired queries each (${embed})`);
      for (const run of await indexSeedsInWorkers(seeds, options, log)) {
        rows.push(...run.rows);
        indices.push(...run.indices);
        presence.push(...run.presence);
        accounting.absorb(run.accounting);
      }
    } else {
      const run = await indexSeeds(prep, seeds, embed, options, accounting, log);
      rows = run.rows;
      indices = run.indices;
      presence.push(...run.presence);
    }
  } finally {
    paidRun?.guard.uninstall();
  }

  // Score composed rows.
  const shuffle = shuffledGold(questions);
  const composedRows: ComposedRow[] = rows.filter(r => (COMPOSED_SPLITS as readonly string[]).includes(r.split)).map(r => {
    const q = byId.get(r.query_id.slice(0, -2))!;
    const harness = [r.off, r.on].some(a => a.error && a.error.origin !== 'sut');
    const sutError = [r.off, r.on].find(a => a.error?.origin === 'sut')?.error?.message ?? null;
    const score = (a: ArmResult) => (harness ? null : a.error ? scoreComposed([], q) : scoreComposed(a.rows, q));
    const twin = shuffle.get(q.id) ?? null;
    const shuffled = (a: ArmResult) => (harness || !twin ? null : scoreComposed(a.error ? [] : a.rows, twin).strict_all_hit);
    const meta = r.on.relational_meta[0] as { kind?: string | null; seeds_resolved?: number; fired?: boolean; candidates?: number } | undefined;
    const on = score(r.on);
    return {
      seed: r.seed, question_id: q.id, split: r.split, family: q.family, hops: q.hops,
      shortcut: q.controls.single_page_shortcut, edges_stated: q.controls.edges_stated,
      off: score(r.off), on, off_shuffled: shuffled(r.off), on_shuffled: shuffled(r.on),
      funnel: harness ? null : {
        parsed: Boolean(meta?.kind), seed_resolved: (meta?.seeds_resolved ?? 0) > 0, fired: Boolean(meta?.fired),
        candidates: meta?.candidates ?? 0, all_support: on?.strict_all_hit === 1,
      },
      error: sutError,
    };
  });

  const acc = accounting.summary();
  const infraErrors = acc.errors.filter(e => e.origin !== 'sut');
  const presenceFailed = presence.length !== seeds.length || presence.some(p => p.rate < PRESENCE_MIN_RATE);
  const valid = infraErrors.length === 0 && acc.completion_rate === 1 && !presenceFailed;
  const bySplit = Object.fromEntries(COMPOSED_SPLITS.map(s => [s, summarizeComposed(composedRows.filter(r => r.split === s))]));
  const capabilitySummary = Object.fromEntries(COMPOSED_SPLITS.map(s => {
    const c = capability.filter(r => r.split === s);
    const count = <K extends 'relation_match' | 'seed_match'>(k: K) => Object.fromEntries([...new Set(c.map(r => r[k]))].sort().map(v => [v, c.filter(r => r[k] === v).length]));
    return [s, { n: c.length, parsed: c.filter(r => r.relation_sets > 0).length, composed_plans: c.filter(r => r.composed_plan).length, relation_match: count('relation_match'), seed_match: count('seed_match') }];
  }));

  const findings = n9Findings({ gut, capability, bySplit, questions: questions.length });
  if (options.recordBugs) for (const f of findings) upsertBug(f);

  const oneHopRows = rows.filter(r => (ONE_HOP_SPLITS as readonly string[]).includes(r.split));
  const data = {
    composed: {
      k: N9_K,
      by_split: bySplit,
      by_split_hops: Object.fromEntries(COMPOSED_SPLITS.map(s => [s, groupSummary(composedRows.filter(r => r.split === s), r => `${r.hops}-hop`)])),
      by_split_family: Object.fromEntries(COMPOSED_SPLITS.map(s => [s, groupSummary(composedRows.filter(r => r.split === s), r => r.family)])),
      no_shortcut: Object.fromEntries(COMPOSED_SPLITS.map(s => [s, summarizeComposed(composedRows.filter(r => r.split === s && !r.shortcut))])),
      edges_stated: Object.fromEntries(COMPOSED_SPLITS.map(s => [s, summarizeComposed(composedRows.filter(r => r.split === s && r.edges_stated))])),
    },
    capability: { summary: capabilitySummary, rows: capability },
    controls: {
      presence,
      presence_min_rate: PRESENCE_MIN_RATE,
      solvability: {
        questions: questions.length,
        max_required: Math.max(...questions.map(q => q.required.length)),
        k: N9_K,
        edges_not_stated: questions.filter(q => !q.controls.edges_stated).length,
        single_page_shortcut: questions.filter(q => q.controls.single_page_shortcut).length,
      },
      gold_shuffle: 'each question also scored against the gold of the next question of its family (fixed derangement); see shuffled_gold_strict_all_hit per arm',
    },
    one_hop: oneHopRows.length ? {
      note: 'keyword path; the one-hop paraphrase split is development data (inspected 2026-09-29)',
      by_split: Object.fromEntries(ONE_HOP_SPLITS.map(s => [s, summarizeRelationalRows(oneHopRows.filter(r => r.split === s))])),
      by_split_template: Object.fromEntries(ONE_HOP_SPLITS.map(s => [s, Object.fromEntries([...new Set(oneHopRows.map(r => r.template))].sort()
        .map(t => [t, summarizeRelationalRows(oneHopRows.filter(r => r.split === s && r.template === t))]))])),
      funnel: Object.fromEntries(ONE_HOP_SPLITS.map(s => {
        const on = oneHopRows.filter(r => r.split === s).map(r => r.on.relational_meta[0] as { kind?: string | null; seeds_resolved?: number; fired?: boolean } | undefined);
        return [s, { n: on.length, parsed: on.filter(m => m?.kind).length, seed_resolved: on.filter(m => (m?.seeds_resolved ?? 0) > 0).length, fired: on.filter(m => m?.fired).length }];
      })),
      per_query: oneHopRows.map(r => {
        const m = r.on.relational_meta[0] as { kind?: string | null; seeds_resolved?: number; fired?: boolean; candidates?: number } | undefined;
        return { seed: r.seed, query_id: r.query_id, split: r.split, template: r.template, text: r.text,
          parsed: Boolean(m?.kind), seeds_resolved: m?.seeds_resolved ?? 0, fired: Boolean(m?.fired), candidates: m?.candidates ?? 0,
          off: r.off.metrics, on: r.on.metrics, error: r.off.error?.message ?? r.on.error?.message ?? null };
      }),
    } : null,
    indices,
    per_question: composedRows,
    findings: findings.map(f => ({ id: f.id, classification: f.classification, surface: f.surface, expected: f.expected, actual: f.actual })),
  };

  const outputDir = options.outputDir ?? join(import.meta.dir, '../reports', CATEGORY, paid ? 'paid' : 'hermetic');
  const defaultRecipe = JSON.stringify(seeds) === JSON.stringify(RELATIONAL_SEEDS) && options.corpusDir === undefined && options.search === undefined;
  const receipt: Receipt = {
    ...(paid ? {} : noModelSpend('hermetic: provider keys stripped, keyword search only; no model and no paid request')),
    schema_version: RECEIPT_SCHEMA_VERSION, benchmark_version: BENCHMARK_VERSION, category: CATEGORY,
    run_status: valid ? 'completed' : 'error',
    ...(valid ? { verdict: defaultRecipe ? 'pass' as const : 'partial' as const } : {}),
    n_total: acc.n_total, n_scored: acc.n_scored, completion_rate: acc.completion_rate, errors: acc.errors,
    publishable: valid && defaultRecipe,
    gbrain_version: gut.version, gbrain_pin: gbrainPin(),
    execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(gut) },
    started_at: started, finished_at: new Date().toISOString(),
    resolved_config: {
      arm: paid ? 'paid: hybrid search, OpenAI embeddings' : 'hermetic: keyword search, no embedding provider',
      decide: DECIDE_OFF,
      keys: paid ? 'every provider and TypeSafe key stripped except OPENAI_API_KEY (embeddings)' : 'every provider and TypeSafe key stripped',
      embedder: paid ? RELATIONAL_EMBEDDER : null,
      engine: 'pglite-in-memory, one index per ingestion seed (import plus extract links and timeline)',
      ingestion_seeds: seeds,
      common_search_pins: RELATIONAL_PINS,
      relational_retrieval: { off: false, on: true, depth: 2 },
      composed_k_rows: N9_K,
      one_hop_k_rows: paid ? null : RELATIONAL_LIMIT,
      scoring_unit: 'distinct pages of the first k result rows, in product order',
      seed_execution: parallel ? 'one child process per ingestion seed, merged in seed order (since gbrain-evals 0.10.7)' : 'serial, in this process',
      verdict_meaning: 'validity only (no harness error, presence held); the category has no safety contract or quality threshold (registry promotion rules), so no metric changes the verdict',
      question_file: { path: 'eval/data/n9-multihop-paraphrase-v1/questions.json', sha256: sha256(readFileSync(N9_QUESTIONS_PATH)), grammar_version: file.grammar_version, seed: file.seed, frames_sha256: file.frames_sha256 },
      gbrain_overlay: overlaySummary(gut),
      internal_entry_points: ['src/core/search/hybrid.ts hybridSearch (relationalRetrieval on/off)', 'src/core/search/relational-intent.ts parseRelationalQuery', 'src/core/pglite-engine.ts', 'src/core/import-file.ts importFromContent', 'src/commands/extract.ts runExtract', 'src/core/ai/gateway.ts', 'src/core/embedding.ts embedQuery'],
      paid_guard: paid ? '--paid --budget-run-id (eval/runner/paid-arm.ts)' : null,
    },
    hashes: {
      corpus: sha256(JSON.stringify(pages.map(p => [p.slug, p.title, p.compiled_truth, p.timeline]))),
      questions: sha256(readFileSync(N9_QUESTIONS_PATH)),
      runner: sha256(readFileSync(import.meta.path)),
    },
    data,
    latency_ms: latencySummary(rows.flatMap(r => [r.off, r.on]).filter(a => !a.error).map(a => a.wall_ms), 'wall time of each successful hybridSearch arm call (index build excluded)'),
  };
  if (paidRun) {
    const spend = paidRun.run.close();
    receipt.cost = receiptCost(spend);
    receipt.delivered_tokens = { tokens: spend.input_tokens, basis: 'provider-reported input tokens of every paid embedding request, from the budget ledger' };
  }
  mkdirSync(outputDir, { recursive: true });
  const receiptPath = join(outputDir, 'receipt.json');
  writeReceipt(receiptPath, receipt);
  printSummary(log, receipt, bySplit, capabilitySummary, presence, findings, receiptPath, infraErrors.length, presenceFailed);
  return { receipt, exitCode: valid ? 0 : 3, findings };
}

/** Findings this run can state without a human: the composed-plan feature gap (always, by the parser's type). */
export function n9Findings(o: { gut: GbrainUnderTest; capability: readonly CapabilityRow[]; bySplit: Record<string, ReturnType<typeof summarizeComposed>>; questions: number }): BugEntry[] {
  const sha = o.gut.overlay?.build.commit ?? '3a284aea26889b77c633aebb4149c3016d834ee6';
  const plans = o.capability.filter(r => r.composed_plan).length;
  if (plans > 0) return [];
  const parsed = o.capability.filter(r => r.relation_sets > 0).length;
  const firstHop = o.capability.filter(r => r.relation_match === 'first_hop').length;
  const lastHop = o.capability.filter(r => r.relation_match === 'last_hop').length;
  const phrase = o.capability.filter(r => r.seed_match !== 'anchor' && r.seed_match !== 'no_parse').length;
  return [{
    id: 'N9-1', category: 'multi-hop-paraphrase', classification: 'feature-gap',
    contract: 'None: gbrain does not claim composed multi-relation query plans. src/core/search/relational-intent.ts:1-48 maps one regex archetype to one link-type set and one direction (capability matrix N9, probe P7).',
    gbrain_sha: sha,
    surface: 'src/core/search/relational-intent.ts parseRelationalQuery',
    repro: 'bun docs/benchmarks/2026-10-01-capability-matrix/probes/p7-relational.ts; bun eval/runner/n9-multi-hop-paraphrase.ts (data.capability)',
    expected: `a composed question such as "Who founded the companies that <investor> invested in?" yields a plan with one relation per hop (invested_in, then founded)`,
    actual: `0 of ${o.capability.length} composed wordings (${o.questions} questions x 2) produced a multi-relation plan; ${parsed} parsed as one relation (${firstHop} first hop, ${lastHop} last hop), ${phrase} with a seed that is not exactly the anchor name`,
    status: 'deferred',
    reason: 'feature gap, not a bug: composition is not implemented or claimed at this commit; composed questions are scored on what the system returns anyway',
  }];
}

function pct(x: number | null | undefined): string { return x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`; }

function printSummary(
  log: (s: string) => void, receipt: Receipt, bySplit: Record<string, ReturnType<typeof summarizeComposed>>,
  capability: Record<string, { n: number; parsed: number; composed_plans: number }>, presence: Array<{ seed: number; found: number; anchors: number }>,
  findings: readonly BugEntry[], receiptPath: string, infraErrors: number, presenceFailed: boolean,
): void {
  log(`verdict: ${receipt.verdict ?? `error (${receipt.run_status})`}${presenceFailed ? ' - presence check failed: the anchor-name lookup found fewer than half of the anchors in some index, so a low all-hit would mean nothing. The run is void (error, not pass); check that import and extraction ran.' : ''}${infraErrors ? ` - ${infraErrors} harness or dependency errors void the run` : ''}`);
  log('safety contracts: none preregistered (report-only category)');
  for (const [split, s] of Object.entries(bySplit)) {
    log(`${split}: strict all-hit@10 off ${pct(s.off.strict_all_hit)} -> on ${pct(s.on.strict_all_hit)} over ${s.off.n} runs; distinct questions on-better ${s.paired_questions.gains} / worse ${s.paired_questions.losses} / same ${s.paired_questions.ties} (sign test p=${s.paired_questions.sign_test_p_two_sided.toFixed(3)}); fired ${s.funnel.fired}/${s.funnel.n}, parsed ${s.funnel.parsed}/${s.funnel.n}, seed resolved ${s.funnel.seed_resolved}/${s.funnel.n}`);
  }
  for (const [split, c] of Object.entries(capability)) log(`capability ${split}: composed plans ${c.composed_plans}/${c.n}, parsed as one relation ${c.parsed}/${c.n}`);
  log(`presence: ${presence.map(p => `seed ${p.seed} ${p.found}/${p.anchors}`).join(', ')}`);
  for (const f of findings) log(`gbrain ${f.classification} ${f.id}: ${f.actual} - repro: ${f.repro}`);
  log(`receipt: ${receiptPath}`);
}

if (import.meta.main) {
  const options = parseN9Args(process.argv.slice(2));
  if (options.workerSeed !== undefined) {
    if (!options.workerOut) throw new Error('--worker-seed needs --worker-out');
    runN9Worker(options).catch(e => { console.error(e); process.exitCode = 3; });
  } else runN9(options)
    .then(r => { process.exitCode = r.exitCode; })
    .catch(e => { console.error(e instanceof Error && e.name === 'PaidArmRefusal' ? e.message : e); process.exitCode = 3; });
}

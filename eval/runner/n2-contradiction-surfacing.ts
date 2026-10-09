/**
 * BrainBench N2: contradiction surfacing, scored in three stages
 * (eval-category wave amendment 6).
 *
 * The world comes from eval/generators/n2-contradiction-gen.ts: planted pairs
 * of notes stating one fact about one fictional company (same-time
 * conflicts, dated changes, compatible hard negatives), one profile page per
 * company and one supplied query per item. The runner writes the pages
 * through gbrain's put_page on in-memory PGLite, proves every planted claim
 * landed in a chunk, then runs gbrain's runContradictionProbe
 * (src/core/eval-contradictions/runner.ts) with gbrain's own default search
 * (hybridSearch, keyword only without a key) and injected judges:
 *
 *   candidate discovery  an oracle-recording judge logs every pair the probe
 *                        offers; a planted pair is discovered when it is
 *                        offered under any supplied query. gbrain has no
 *                        corpus-wide or fact-identity scanner (a gap), so the
 *                        queries are part of the input, written by the
 *                        generator.
 *   classification       paid arm only: gbrain's judgeContradiction is the
 *                        system under test, scored against the ledger's
 *                        independent claim spans. The oracle judge gives the
 *                        ceiling: what a perfect judge would surface.
 *   resolution           the proposals gbrain renders for each finding
 *                        (pairToFinding, auto-supersession.ts) are scored for
 *                        acceptability; they are never applied, and the run
 *                        checks that no page changed.
 *
 * Missed and capped pairs stay in the end-to-end denominators. A throwing
 * judge on a slice checks that judge exceptions become error rows, never
 * verdicts. find_contradictions read-back is probed by caller scope, including
 * the context gbrain's own CLI builds for a bare command (makeContext).
 *
 * A development arm imports the amara-life notes, meetings and emails and
 * scores the 15 pairs of eval/data/gold/contradictions.json against both
 * their original and their adjudicated labels
 * (eval/data/gold/contradictions-adjudication.json).
 *
 * Hermetic by default (no key, fresh GBRAIN_HOME, System One off). The paid
 * arm (`--paid --budget-run-id <id>`) adds the real judge with exactly one
 * provider key (ANTHROPIC_API_KEY), through the budget ledger.
 *
 * Usage: bun eval/runner/n2-contradiction-surfacing.ts [--seed N] [--output <dir>] [--gbrain <checkout>[@ref]]
 *          [--paid --budget-run-id <id>] [--json]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { budgetOptionsFrom, ledgerStatus, receiptCost, startPaidRun, type RunSummary } from './budget-ledger.ts';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { gbrainPin } from './gbrain-version.ts';
import { DECIDE_OFF, withHermeticEnv } from './hermetic-env.ts';
import { paidRequested, requirePaidArm } from './paid-arm.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, noModelSpend, receiptPath, sourceTreeIdentity, writeReceipt, type Receipt } from './receipt.ts';
import {
  N2_DEFAULT_SEED, N2_GENERATOR_VERSION, generateN2World, n2Gold, pairKey, renderN2Page,
  type GoldClass, type N2Item, type N2Ledger, type PairGold,
} from '../generators/n2-contradiction-gen.ts';

export const CATEGORY = 'n2-contradiction-surfacing';
export const JUDGE_MODEL = 'anthropic:claude-haiku-4-5-20251001';
export const PAID_ESTIMATE_USD = 8;
/** Raised from $6 ($1.50 per shard) to $10 ($2.50 per shard) on 2026-10-03, preregistered in docs/benchmarks/2026-10-03-wave7-repin-preregistration.md before the prompt v4 run. */
export const PROBE_BUDGET_USD = 10;
/** The paid arm splits the queries into shards run concurrently (one probe run each, probe budget split evenly); per-query pairs and verdicts are unaffected. */
export const PAID_SHARDS = 4;
const TOP_K = 5;
const THROWING_SLICE = 30;

/** Queries that name no company: how far discovery reaches when the caller does not already know where the conflict is. */
export const GENERIC_QUERIES: readonly string[] = [
  'What is the headcount?', 'What is the annual recurring revenue?', 'How many months of runway?', 'How many pilot customers?',
  'What is the valuation cap on the SAFE?', 'Which city is the company headquartered in?', 'Who is the CEO?', 'Which numbers conflict across my notes?',
];

export const ENTRYPOINTS = [
  'src/core/eval-contradictions/runner.ts runContradictionProbe (judgeFn, searchFn injected; searchFn wraps the default hybridSearch unchanged)',
  'src/core/search/hybrid.ts hybridSearch',
  'src/core/eval-contradictions/judge.ts judgeContradiction (paid arm)',
  'src/core/eval-contradictions/auto-supersession.ts pairToFinding (via the runner)',
  'src/core/eval-contradictions/trends.ts writeRunRow',
  'operations: put_page, find_contradictions',
];

export const GAPS: ReadonlyArray<{ capability: string; reason: string }> = [
  { capability: 'corpus-wide or fact-identity contradiction discovery', reason: 'runContradictionProbe only pairs the top-K results of the queries a caller supplies (runner.ts:316-428); no scanner enumerates facts or pages. Discovery is scored with generator-written queries.' },
  { capability: 'applied resolutions', reason: 'auto-supersession.ts renders paste-ready proposals and never applies them; one kind (log_timeline_change) points at a deferred timeline writer.' },
  { capability: 'find_contradictions for remote callers', reason: 'the op returns an empty note to every remote caller (insights.ts:197-200), by documented design ("temporarily available only to trusted local callers").' },
];

// ─── Pure scoring helpers (exported for tests) ───────────────────────────

export type Verdict = 'no_contradiction' | 'contradiction' | 'temporal_supersession' | 'temporal_regression' | 'temporal_evolution' | 'negation_artifact';
export type VerdictClass = 'contradiction' | 'temporal' | 'not_contradiction';

export function verdictClass(v: Verdict): VerdictClass {
  if (v === 'contradiction') return 'contradiction';
  if (v.startsWith('temporal_')) return 'temporal';
  return 'not_contradiction';
}

/** The oracle judge's verdict for a pair (gold class to gbrain's verdict vocabulary). */
export function oracleVerdict(g: PairGold, item?: Pick<N2Item, 'variant'>): Verdict {
  if (!g.planted || g.gold_class === 'compatible') return 'no_contradiction';
  if (g.gold_class === 'contradiction') return 'contradiction';
  return item?.variant === 'regression' ? 'temporal_regression' : 'temporal_supersession';
}

/** Is a rendered proposal acceptable for the gold class (preregistered rules)? */
export function proposalAcceptable(gold: GoldClass, kind: string, command: string, olderSlug: string | null): boolean {
  if (gold === 'contradiction') return kind === 'manual_review' || kind === 'dream_synthesize';
  if (gold === 'temporal') {
    if (kind === 'log_timeline_change' || kind === 'flag_for_review') return true;
    if (kind !== 'temporal_supersede') return false;
    const m = /^# temporal_supersession: (\S+) \(/.exec(command) ?? /^gbrain takes supersede '([^']+)'/.exec(command);
    return m !== null && olderSlug !== null && m[1] === olderSlug;
  }
  return false;
}

export interface Judgment {
  query: string;
  query_item: string | null;
  a: string;
  b: string;
  key: string;
  gold: PairGold;
  verdict: Verdict | null;
  error: string | null;
  resolution_kind?: string;
  resolution_command?: string;
  dates_seen: [string | null, string | null];
}

export interface StageCounts { n: number; hits: number; rate: number | null }
const rate = (hits: number, n: number): StageCounts => ({ n, hits, rate: n ? hits / n : null });

/** Per planted item, the first judgment of its pair: under its own query when offered there, else under the first query that offered it. */
export function itemJudgments(items: readonly N2Item[], judgments: readonly Judgment[]): Map<string, Judgment> {
  const out = new Map<string, Judgment>();
  for (const it of items) {
    const key = pairKey(it.a.slug, it.b.slug);
    const mine = judgments.filter(j => j.gold.planted && j.key === key);
    const own = mine.find(j => j.query_item === it.id);
    const pick = own ?? mine[0];
    if (pick) out.set(it.id, pick);
  }
  return out;
}

export interface ClassificationSummary {
  e2e_conflict_recall: StageCounts;
  classification_recall_offered_conflicts: StageCounts;
  false_contradiction_dated_changes: StageCounts;
  false_contradiction_compatible: StageCounts;
  false_contradiction_unplanted_pairs: StageCounts;
  judged_pair_precision: StageCounts;
  temporal_recognition: StageCounts;
  judge_errors: StageCounts;
  resolution_acceptable: StageCounts;
  resolution_by_variant: Record<string, { findings: number; acceptable: number; kinds: Record<string, number> }>;
  by_variant: Record<string, { offered: number; contradiction: number; temporal: number; not_contradiction: number; error: number }>;
  decision: { separates: boolean; failed_rules: string[] };
}

/** Classification and resolution scoring over judgments (any judge: oracle, fake or gbrain's). */
export function scoreClassification(ledger: N2Ledger, judgments: readonly Judgment[]): ClassificationSummary {
  const per = itemJudgments(ledger.items, judgments);
  const conflicts = ledger.items.filter(i => i.gold_class === 'contradiction');
  const dated = ledger.items.filter(i => i.gold_class === 'temporal');
  const compatible = ledger.items.filter(i => i.gold_class === 'compatible');
  const flaggedAny = new Set(judgments.filter(j => j.verdict === 'contradiction').map(j => j.key));
  const cls = (id: string) => { const j = per.get(id); return j?.verdict ? verdictClass(j.verdict) : null; };
  const offered = (xs: N2Item[]) => xs.filter(i => per.has(i.id));
  const e2e = conflicts.filter(i => flaggedAny.has(pairKey(i.a.slug, i.b.slug))).length;
  const offC = offered(conflicts);
  const offD = offered(dated);
  const offN = offered(compatible);
  const unplanted = new Map<string, boolean>();
  for (const j of judgments.filter(x => !x.gold.planted && x.verdict !== null)) unplanted.set(j.key, (unplanted.get(j.key) ?? false) || j.verdict === 'contradiction');
  const flaggedPairs = [...flaggedAny];
  const plantedConflictKeys = new Set(conflicts.map(i => pairKey(i.a.slug, i.b.slug)));
  const errors = judgments.filter(j => j.error !== null).length;
  const findings = [...per.entries()].filter(([id]) => ['contradiction', 'temporal'].includes(ledger.items.find(i => i.id === id)!.gold_class))
    .map(([id, j]) => ({ it: ledger.items.find(i => i.id === id)!, j })).filter(({ j }) => j.verdict !== null && j.verdict !== 'no_contradiction' && j.resolution_kind);
  const ok = ({ it, j }: { it: N2Item; j: Judgment }) => proposalAcceptable(it.gold_class, j.resolution_kind!, j.resolution_command ?? '', it.older_side ? it[it.older_side].slug : null);
  const acceptable = findings.filter(ok).length;
  const resolutionByVariant: ClassificationSummary['resolution_by_variant'] = {};
  for (const f of findings) {
    const row = resolutionByVariant[`${f.it.kind}/${f.it.variant}`] ??= { findings: 0, acceptable: 0, kinds: {} };
    row.findings++;
    if (ok(f)) row.acceptable++;
    row.kinds[f.j.resolution_kind!] = (row.kinds[f.j.resolution_kind!] ?? 0) + 1;
  }
  const byVariant: ClassificationSummary['by_variant'] = {};
  for (const it of ledger.items) {
    const k = `${it.kind}/${it.variant}`;
    const row = byVariant[k] ??= { offered: 0, contradiction: 0, temporal: 0, not_contradiction: 0, error: 0 };
    const j = per.get(it.id);
    if (!j) continue;
    row.offered++;
    if (j.error) row.error++;
    else row[cls(it.id)!]++;
  }
  const s: ClassificationSummary = {
    e2e_conflict_recall: rate(e2e, conflicts.length),
    classification_recall_offered_conflicts: rate(offC.filter(i => cls(i.id) === 'contradiction').length, offC.length),
    false_contradiction_dated_changes: rate(offD.filter(i => cls(i.id) === 'contradiction').length, offD.length),
    false_contradiction_compatible: rate(offN.filter(i => cls(i.id) === 'contradiction').length, offN.length),
    false_contradiction_unplanted_pairs: rate([...unplanted.values()].filter(Boolean).length, unplanted.size),
    judged_pair_precision: rate(flaggedPairs.filter(k => plantedConflictKeys.has(k)).length, flaggedPairs.length),
    temporal_recognition: rate(offD.filter(i => cls(i.id) === 'temporal').length, offD.length),
    judge_errors: rate(errors, judgments.length),
    resolution_acceptable: rate(acceptable, findings.length),
    resolution_by_variant: resolutionByVariant,
    by_variant: byVariant,
    decision: { separates: false, failed_rules: [] },
  };
  const failed: string[] = [];
  if (!((s.classification_recall_offered_conflicts.rate ?? 0) >= 0.8)) failed.push('classification recall on offered conflicts < 0.80');
  if (!((s.false_contradiction_dated_changes.rate ?? 1) <= 0.1)) failed.push('false-contradiction rate on offered dated changes > 0.10');
  if (!((s.false_contradiction_compatible.rate ?? 1) <= 0.1)) failed.push('false-contradiction rate on offered compatible negatives > 0.10');
  s.decision = { separates: failed.length === 0, failed_rules: failed };
  return s;
}

export interface CandidateSummary {
  conflict_recall: number;
  conflicts_offered: number;
  conflicts_total: number;
  both_retrieved_own_query: StageCounts;
  offered_own_query: StageCounts;
  by_variant: Record<string, { total: number; both_retrieved_own_query: number; offered_any_query: number }>;
  negatives_offered: { dated_changes: StageCounts; compatible: StageCounts };
  pairs_offered_total: number;
  unplanted_pairs_offered: number;
}

/** Candidate discovery from what the probe retrieved and offered. */
export function scoreCandidates(ledger: N2Ledger, retrieved: ReadonlyMap<string, readonly string[]>, judgments: readonly Judgment[]): CandidateSummary {
  const offeredKeys = new Set(judgments.filter(j => j.gold.planted).map(j => j.key));
  const offeredOwn = new Set(judgments.filter(j => j.gold.planted && j.query_item !== null && j.gold.planted && j.gold.item === j.query_item).map(j => j.key));
  const items = ledger.items;
  const conflicts = items.filter(i => i.gold_class === 'contradiction');
  const isOffered = (i: N2Item) => offeredKeys.has(pairKey(i.a.slug, i.b.slug));
  const bothOwn = (i: N2Item) => { const r = retrieved.get(i.id) ?? []; return r.includes(i.a.slug) && r.includes(i.b.slug); };
  const byVariant: CandidateSummary['by_variant'] = {};
  for (const i of items) {
    const row = byVariant[`${i.kind}/${i.variant}`] ??= { total: 0, both_retrieved_own_query: 0, offered_any_query: 0 };
    row.total++;
    if (bothOwn(i)) row.both_retrieved_own_query++;
    if (isOffered(i)) row.offered_any_query++;
  }
  const dated = items.filter(i => i.gold_class === 'temporal');
  const compatible = items.filter(i => i.gold_class === 'compatible');
  const offeredConflicts = conflicts.filter(isOffered).length;
  return {
    conflict_recall: conflicts.length ? offeredConflicts / conflicts.length : 0,
    conflicts_offered: offeredConflicts,
    conflicts_total: conflicts.length,
    both_retrieved_own_query: rate(conflicts.filter(bothOwn).length, conflicts.length),
    offered_own_query: rate(conflicts.filter(i => offeredOwn.has(pairKey(i.a.slug, i.b.slug))).length, conflicts.length),
    by_variant: byVariant,
    negatives_offered: { dated_changes: rate(dated.filter(isOffered).length, dated.length), compatible: rate(compatible.filter(isOffered).length, compatible.length) },
    pairs_offered_total: judgments.length,
    unplanted_pairs_offered: new Set(judgments.filter(j => !j.gold.planted).map(j => j.key)).size,
  };
}

/** The two safety contracts from the throwing-judge control and the page snapshot diff. */
export function safetyFrom(throwing: { offered: number; judge_errors: number; verdicts: number; findings: number }, changedPages: readonly string[]) {
  return {
    applied_mutations: changedPages.length,
    changed_pages: changedPages.slice(0, 20),
    judge_errors_counted_as_verdicts: Math.max(0, throwing.offered - throwing.judge_errors) + throwing.verdicts + throwing.findings,
  };
}

// ─── gbrain wiring ───────────────────────────────────────────────────────

type Engine = {
  connect(c: Record<string, unknown>): Promise<void>;
  initSchema(): Promise<void>;
  disconnect(): Promise<void>;
  executeRaw<T>(q: string, p?: unknown[]): Promise<T[]>;
};
type SearchResult = { slug: string; chunk_text: string; effective_date?: string | null; effective_date_source?: string | null; score?: number };
type JudgeInput = { query: string; a: { slug: string; text: string; effective_date?: string | null }; b: { slug: string; text: string; effective_date?: string | null }; model: string };
type JudgeOutput = { verdict: { verdict: Verdict; severity: string; axis: string; confidence: number; resolution_kind: string | null }; usage: { inputTokens: number; outputTokens: number } };
type ProbeReport = {
  run_status: string; per_query: Array<{ query: string; result_count: number; pairs_skipped_by_date: number; pairs_judged: number; contradictions: Array<{ a: { slug: string; text: string }; b: { slug: string; text: string }; verdict: Verdict; resolution_kind: string; resolution_command: string }> }>;
  judge_errors: { total: number }; verdict_breakdown: Record<string, number>; total_contradictions_flagged: number; duration_ms: number; cost_usd: unknown;
};
type ProbeFn = (o: Record<string, unknown>) => Promise<{ report: ProbeReport; judgeErrorRows: ReadonlyArray<{ kind: string; pair_id: string; reason: string }>; capHitMidRun: boolean }>;

interface Sut {
  engine: Engine;
  op(name: string, params: Record<string, unknown>, ctxOver?: Record<string, unknown>): Promise<unknown>;
  probe: ProbeFn;
  hybridSearch: (engine: Engine, q: string, o: { limit: number }) => Promise<SearchResult[]>;
  judge: (i: JudgeInput) => Promise<JudgeOutput>;
  writeRunRow: (engine: Engine, report: ProbeReport, durationMs: number) => Promise<void>;
}

async function openSut(gut: GbrainUnderTest): Promise<Sut> {
  const { PGLiteEngine } = await importGbrain<{ PGLiteEngine: new () => Engine }>(gut, 'src/core/pglite-engine.ts');
  const { operations } = await importGbrain<{ operations: Array<{ name: string; handler: (c: unknown, p: Record<string, unknown>) => Promise<unknown> }> }>(gut, 'src/core/operations.ts');
  const { runContradictionProbe } = await importGbrain<{ runContradictionProbe: ProbeFn }>(gut, 'src/core/eval-contradictions/runner.ts');
  const { hybridSearch } = await importGbrain<{ hybridSearch: Sut['hybridSearch'] }>(gut, 'src/core/search/hybrid.ts');
  const { judgeContradiction } = await importGbrain<{ judgeContradiction: Sut['judge'] }>(gut, 'src/core/eval-contradictions/judge.ts');
  const { writeRunRow } = await importGbrain<{ writeRunRow: Sut['writeRunRow'] }>(gut, 'src/core/eval-contradictions/trends.ts');
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const base = { engine, config: { engine: 'pglite', database_path: ':memory:' }, logger, dryRun: false, remote: false, sourceId: 'default' };
  const byName = new Map(operations.map(o => [o.name, o]));
  return {
    engine,
    op: async (name, params, over = {}) => {
      const o = byName.get(name);
      if (!o) throw new Error(`gbrain has no operation ${name}`);
      return await o.handler({ ...base, ...over }, params);
    },
    probe: runContradictionProbe, hybridSearch, judge: judgeContradiction, writeRunRow,
  };
}

async function seedPages(sut: Sut, pages: ReadonlyArray<{ slug: string; content: string }>): Promise<string[]> {
  const errors: string[] = [];
  for (const p of pages) {
    try { await sut.op('put_page', { slug: p.slug, content: p.content }); }
    catch (e) { errors.push(`${p.slug}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return errors;
}

async function chunkTexts(sut: Sut): Promise<Map<string, string[]>> {
  const rows = await sut.engine.executeRaw<{ slug: string; chunk_text: string }>('SELECT p.slug, c.chunk_text FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.deleted_at IS NULL');
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.slug, [...(out.get(r.slug) ?? []), r.chunk_text]);
  return out;
}

/** Everything a write could change about a page's content (read-side stamps such as last_retrieved_at are excluded). */
async function pageSnapshot(sut: Sut): Promise<Map<string, string>> {
  const rows = await sut.engine.executeRaw<{ slug: string; sig: string }>(
    `SELECT p.slug, concat_ws('|', p.content_hash, md5(p.compiled_truth), md5(p.timeline), p.frontmatter::text, p.generation::text, coalesce(p.deleted_at::text, ''),
            (SELECT count(*)::text || ':' || coalesce(md5(string_agg(c.chunk_text, '' ORDER BY c.chunk_index)), '') FROM content_chunks c WHERE c.page_id = p.id)) AS sig
     FROM pages p`);
  return new Map(rows.map(r => [r.slug, r.sig]));
}

function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [slug, sig] of after) if (before.get(slug) !== sig) changed.push(slug);
  for (const slug of before.keys()) if (!after.has(slug)) changed.push(slug);
  return changed.sort();
}

interface ProbeCapture {
  judgments: Judgment[];
  retrieved: Map<string, string[]>;
  dateSource: Map<string, string | null>;
  report: ProbeReport;
  capHitMidRun: boolean;
  errorRows: number;
}

const NO_CONTRADICTION: JudgeOutput['verdict'] = { verdict: 'no_contradiction', severity: 'info', axis: '', confidence: 1, resolution_kind: null };

/**
 * One probe run over `queries` with a judge that records every offered pair.
 * `decide` returns the verdict (oracle), throws (error control) or calls
 * gbrain's judge (paid). Findings and proposals are read back from the
 * runner's report and joined to the recorded judgments.
 */
async function runProbe(sut: Sut, queries: ReadonlyArray<{ query: string; item: string | null }>, gold: (a: { slug: string; text: string }, b: { slug: string; text: string }) => PairGold,
  decide: (input: JudgeInput, g: PairGold) => Promise<JudgeOutput>, opts: { budgetUsd?: number } = {}): Promise<ProbeCapture> {
  const judgments: Judgment[] = [];
  const retrieved = new Map<string, string[]>();
  const dateSource = new Map<string, string | null>();
  const itemOf = new Map(queries.map(q => [q.query, q.item]));
  const searchFn = async (engine: Engine, query: string, o: { limit: number }) => {
    const results = await sut.hybridSearch(engine, query, { limit: o.limit });
    const item = itemOf.get(query);
    if (item) retrieved.set(item, results.map(r => r.slug));
    for (const r of results) dateSource.set(r.slug, r.effective_date_source ?? null);
    return results;
  };
  const judgeFn = async (input: JudgeInput): Promise<JudgeOutput> => {
    const g = gold({ slug: input.a.slug, text: input.a.text }, { slug: input.b.slug, text: input.b.text });
    const row: Judgment = { query: input.query, query_item: itemOf.get(input.query) ?? null, a: input.a.slug, b: input.b.slug, key: pairKey(input.a.slug, input.b.slug), gold: g, verdict: null, error: null, dates_seen: [input.a.effective_date ?? null, input.b.effective_date ?? null] };
    judgments.push(row);
    try {
      const out = await decide(input, g);
      row.verdict = out.verdict.verdict;
      return out;
    } catch (e) {
      row.error = e instanceof Error ? e.message : String(e);
      throw e;
    }
  };
  const out = await sut.probe({ engine: sut.engine, queries: queries.map(q => q.query), topK: TOP_K, noCache: true, yesOverride: true, budgetUsd: opts.budgetUsd ?? PROBE_BUDGET_USD, judgeModel: JUDGE_MODEL, judgeFn, searchFn });
  for (const pq of out.report.per_query) {
    for (const f of pq.contradictions) {
      const j = judgments.find(x => x.query === pq.query && x.key === pairKey(f.a.slug, f.b.slug) && x.verdict === f.verdict && x.resolution_kind === undefined);
      if (j) { j.resolution_kind = f.resolution_kind; j.resolution_command = f.resolution_command; }
    }
  }
  return { judgments, retrieved, dateSource, report: out.report, capHitMidRun: out.capHitMidRun, errorRows: out.judgeErrorRows.length };
}

// ─── Amara-life development arm ──────────────────────────────────────────

interface AmaraPair { id: string; section: 'pairs' | 'stale_facts'; a: string; b: string; claims: [string, string]; original: string; adjudicated: string; confidence: string }

export function loadAmara(): { pages: Array<{ slug: string; content: string }>; pairs: AmaraPair[]; queries: Record<string, string> } {
  const base = 'eval/data/amara-life-v1';
  const gold = JSON.parse(readFileSync('eval/data/gold/contradictions.json', 'utf8'));
  const adj = JSON.parse(readFileSync('eval/data/gold/contradictions-adjudication.json', 'utf8'));
  const queries = JSON.parse(readFileSync('eval/data/gold/contradictions-n2-queries.json', 'utf8')).queries as Record<string, string>;
  const pages: Array<{ slug: string; content: string }> = [];
  for (const line of readFileSync(`${base}/inbox/emails.jsonl`, 'utf8').split('\n').filter(Boolean)) {
    const e = JSON.parse(line) as { id: string; ts: string; subject: string; body_text: string };
    pages.push({ slug: `emails/${e.id}`, content: `---\ntype: email\ntitle: ${JSON.stringify(e.subject)}\ndate: ${e.ts.slice(0, 10)}\n---\n${e.body_text}\n` });
  }
  for (const f of readdirSync(`${base}/notes`).sort()) pages.push({ slug: `note/${f.replace(/\.md$/, '')}`, content: readFileSync(`${base}/notes/${f}`, 'utf8') });
  for (const f of readdirSync(`${base}/meetings`).sort()) pages.push({ slug: `meeting/${f.replace(/\.md$/, '')}`, content: readFileSync(`${base}/meetings/${f}`, 'utf8') });
  const adjById = new Map([...adj.pairs, ...adj.stale_facts].map((p: { id: string; adjudicated: string; confidence: string }) => [p.id, p]));
  const pairs: AmaraPair[] = (['pairs', 'stale_facts'] as const).flatMap(section => gold[section].map((p: { id: string; source_a: { ref: string; claim: string }; source_b: { ref: string; claim: string } }) => ({
    id: p.id, section, a: p.source_a.ref, b: p.source_b.ref, claims: [p.source_a.claim, p.source_b.claim] as [string, string],
    original: section === 'pairs' ? 'contradiction' : 'temporal_supersession', adjudicated: adjById.get(p.id)!.adjudicated, confidence: adjById.get(p.id)!.confidence,
  })));
  return { pages, pairs, queries };
}

const labelClass = (label: string): VerdictClass => (label === 'contradiction' ? 'contradiction' : label.startsWith('temporal') ? 'temporal' : 'not_contradiction');

export function scoreAmara(pairs: readonly AmaraPair[], judgments: readonly Judgment[]) {
  const rows = pairs.map(p => {
    const mine = judgments.filter(j => j.key === pairKey(p.a, p.b));
    const own = mine.find(j => j.query_item === p.id) ?? mine[0];
    const verdict = own?.verdict ?? null;
    return {
      id: p.id, original: p.original, adjudicated: p.adjudicated, confidence: p.confidence,
      offered: mine.length > 0, offered_own_query: mine.some(j => j.query_item === p.id), verdict,
      agrees_original: verdict ? verdictClass(verdict) === labelClass(p.original) : null,
      agrees_adjudicated: verdict ? verdictClass(verdict) === labelClass(p.adjudicated) : null,
    };
  });
  const judged = rows.filter(r => r.verdict !== null);
  return {
    pairs: rows.length,
    offered: rows.filter(r => r.offered).length,
    judged: judged.length,
    agree_original: judged.filter(r => r.agrees_original).length,
    agree_adjudicated: judged.filter(r => r.agrees_adjudicated).length,
    rows,
  };
}

// ─── Run ─────────────────────────────────────────────────────────────────

export interface HermeticResult {
  presence: Array<{ name: string; ok: boolean; expected: number; actual: number; detail?: string }>;
  candidate: CandidateSummary | null;
  oracle: ClassificationSummary | null;
  throwing: { queries: number; offered: number; judge_errors: number; verdicts: number; findings: number; run_status: string } | null;
  safety: { applied_mutations: number; changed_pages: string[]; judge_errors_counted_as_verdicts: number } | null;
  date_signal: Record<string, unknown> | null;
  find_contradictions: Record<string, unknown> | null;
  generic_queries: { queries: number; pairs_offered: number; planted_conflicts_offered: number; planted_conflicts_total: number } | null;
  amara: Record<string, unknown> | null;
  seed_errors: string[];
  harness_error: string | null;
  timings_ms: Record<string, number>;
  offered_keys: string[];
}

const itemQueries = (ledger: N2Ledger) => ledger.items.map(i => ({ query: i.query, item: i.id }));

export async function runHermetic(gut: GbrainUnderTest, world: ReturnType<typeof generateN2World>, opts: { amara?: boolean; log?: (s: string) => void } = {}): Promise<HermeticResult> {
  return withHermeticEnv('n2', () => runHermeticInner(gut, world, opts));
}

async function runHermeticInner(gut: GbrainUnderTest, world: ReturnType<typeof generateN2World>, opts: { amara?: boolean; log?: (s: string) => void }): Promise<HermeticResult> {
  const log = opts.log ?? (() => {});
  const { ledger } = world;
  const res: HermeticResult = { presence: [], candidate: null, oracle: null, throwing: null, safety: null, date_signal: null, find_contradictions: null, generic_queries: null, amara: null, seed_errors: [], harness_error: null, timings_ms: {}, offered_keys: [] };
  const t0 = Date.now();
  const sut = await openSut(gut);
  try {
    log(`seeding ${ledger.pages.length} pages`);
    res.seed_errors = await seedPages(sut, ledger.pages.map(p => ({ slug: p.slug, content: renderN2Page(p) })));
    res.timings_ms.seed = Date.now() - t0;
    const chunks = await chunkTexts(sut);
    const planted = ledger.items.flatMap(i => [i.a, i.b]);
    const landed = planted.filter(s => (chunks.get(s.slug) ?? []).some(c => c.includes(s.claim))).length;
    res.presence.push({ name: 'planted claim spans present in a stored chunk', ok: landed === planted.length, expected: planted.length, actual: landed });
    res.presence.push({ name: 'pages written without error', ok: res.seed_errors.length === 0, expected: ledger.pages.length, actual: ledger.pages.length - res.seed_errors.length, detail: res.seed_errors[0] });
    if (res.presence.some(p => !p.ok)) { res.harness_error = `presence assertions failed: ${res.presence.filter(p => !p.ok).map(p => `${p.name} expected ${p.expected} got ${p.actual}`).join('; ')}`; return res; }

    const gold = n2Gold(ledger);
    const itemById = new Map(ledger.items.map(i => [i.id, i]));
    const before = await pageSnapshot(sut);
    const t1 = Date.now();
    log(`oracle-recording probe over ${ledger.items.length} queries`);
    const oracle = await runProbe(sut, itemQueries(ledger), gold, async (_i, g) => ({ verdict: { ...NO_CONTRADICTION, verdict: oracleVerdict(g, g.planted ? itemById.get(g.item) : undefined), confidence: 1 }, usage: { inputTokens: 0, outputTokens: 0 } }));
    res.timings_ms.oracle_probe = Date.now() - t1;
    res.offered_keys = [...new Set(oracle.judgments.map(j => `${j.query_item}::${j.key}`))].sort();
    res.candidate = scoreCandidates(ledger, oracle.retrieved, oracle.judgments);
    res.oracle = scoreClassification(ledger, oracle.judgments);
    res.presence.push({ name: 'oracle-judge control surfaces planted conflicts', ok: res.oracle.e2e_conflict_recall.hits > 0, expected: 1, actual: res.oracle.e2e_conflict_recall.hits });

    // Dates the judge saw for planted pages, against the ledger.
    const plantedSides = ledger.items.flatMap(i => [i.a, i.b]);
    const seenFor = new Map<string, string | null>();
    for (const j of oracle.judgments) { seenFor.set(j.a, j.dates_seen[0]); seenFor.set(j.b, j.dates_seen[1]); }
    const undated = plantedSides.filter(s => s.date === null && seenFor.has(s.slug));
    const textDated = ledger.items.filter(i => i.variant === 'text_dates');
    res.date_signal = {
      undated_planted_pages_offered: undated.length,
      undated_shown_with_a_date: undated.filter(s => seenFor.get(s.slug) !== null).length,
      undated_effective_date_source: Object.fromEntries([...new Set(undated.map(s => oracle.dateSource.get(s.slug) ?? 'null'))].map(k => [k, undated.filter(s => (oracle.dateSource.get(s.slug) ?? 'null') === k).length])),
      example_undated: undated[0] ? { slug: undated[0].slug, ledger_date: null, shown_to_judge: seenFor.get(undated[0].slug) ?? null, effective_date_source: oracle.dateSource.get(undated[0].slug) ?? null } : null,
      dated_pages_shown_their_date: plantedSides.filter(s => s.date !== null && seenFor.has(s.slug)).filter(s => seenFor.get(s.slug) === s.date).length,
      dated_pages_offered: plantedSides.filter(s => s.date !== null && seenFor.has(s.slug)).length,
      pairs_skipped_by_date: oracle.report.per_query.reduce((n, q) => n + q.pairs_skipped_by_date, 0),
      text_dated_changes_offered: textDated.filter(i => oracle.judgments.some(j => j.key === pairKey(i.a.slug, i.b.slug))).length,
      text_dated_changes: textDated.length,
      note: 'text_dates items state dates more than 30 days apart in both texts; the date pre-filter would skip them if the pages carried no effective date (date-filter.ts rule 1)',
    };

    // Throwing judge on a slice: every offered pair must be an error row, never a verdict.
    const t2 = Date.now();
    const slice = itemQueries(ledger).slice(0, THROWING_SLICE);
    const thrown = await runProbe(sut, slice, gold, async () => { throw new Error('n2 throwing-judge control'); });
    res.timings_ms.throwing_probe = Date.now() - t2;
    const verdicts = Object.values(thrown.report.verdict_breakdown).reduce((a, b) => a + b, 0);
    res.throwing = { queries: slice.length, offered: thrown.judgments.length, judge_errors: thrown.report.judge_errors.total, verdicts, findings: thrown.report.total_contradictions_flagged, run_status: thrown.report.run_status };

    // Discovery without a company name: the gap that corpus-wide discovery would close.
    const generic = await runProbe(sut, GENERIC_QUERIES.map(q => ({ query: q, item: null })), gold, async (_i, g) => ({ verdict: { ...NO_CONTRADICTION, verdict: oracleVerdict(g, g.planted ? itemById.get(g.item) : undefined) }, usage: { inputTokens: 0, outputTokens: 0 } }));
    const genericConflicts = new Set(generic.judgments.filter(j => j.gold.planted && j.gold.gold_class === 'contradiction').map(j => j.key));
    res.generic_queries = { queries: GENERIC_QUERIES.length, pairs_offered: generic.judgments.length, planted_conflicts_offered: genericConflicts.size, planted_conflicts_total: ledger.items.filter(i => i.gold_class === 'contradiction').length };

    // find_contradictions read-back by caller scope, over the persisted oracle run.
    await sut.writeRunRow(sut.engine, oracle.report, oracle.report.duration_ms);
    const fc = async (over: Record<string, unknown>) => {
      try {
        const r = await sut.op('find_contradictions', { limit: 100 }, over) as { contradictions: unknown[]; total_in_run?: number; note?: string };
        return { returned: r.contradictions.length, total_in_run: r.total_in_run ?? null, note: r.note ?? null };
      } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
    };
    res.find_contradictions = {
      stored_findings: oracle.report.total_contradictions_flagged,
      remote_caller: await fc({ remote: true, sourceId: 'default' }),
      local_default_scope_cli: await fc({ remote: false, sourceId: 'default' }),
      local_all_sources: await fc({ remote: false, sourceId: '__all__' }),
      local_bare_cli: await (async () => {
        try {
          type MakeContext = { makeContext?: (e: Engine, p: Record<string, unknown>) => Promise<Record<string, unknown>> };
          // gbrain v0.60.125.0 moved the CLI's makeContext from src/cli.ts to src/cli/main.ts.
          const { makeContext } = await importGbrain<MakeContext>(gut, 'src/cli/main.ts').catch(() => ({} as MakeContext)).then(m => m.makeContext ? m : importGbrain<MakeContext>(gut, 'src/cli.ts'));
          if (!makeContext) throw new Error('makeContext is exported by neither src/cli/main.ts nor src/cli.ts');
          return await fc(await makeContext(sut.engine, {}));
        } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
      })(),
    };

    const after = await pageSnapshot(sut);
    const changed = diffSnapshots(before, after);
    res.safety = safetyFrom(res.throwing, changed);
    res.presence.push({ name: 'throwing-judge control offered pairs', ok: res.throwing.offered > 0, expected: 1, actual: res.throwing.offered });
    if (res.presence.some(p => !p.ok)) res.harness_error = `presence assertions failed: ${res.presence.filter(p => !p.ok).map(p => p.name).join('; ')}`;
  } catch (e) {
    res.harness_error = `harness: ${e instanceof Error ? e.stack ?? e.message : String(e)}`;
  } finally {
    await sut.engine.disconnect().catch(() => {});
  }
  if (opts.amara !== false && !res.harness_error) res.amara = await amaraArm(gut, null, log).catch(e => ({ error: e instanceof Error ? e.message : String(e) }));
  res.timings_ms.total = Date.now() - t0;
  return res;
}

async function amaraArm(gut: GbrainUnderTest, judge: ((s: Sut) => (i: JudgeInput) => Promise<JudgeOutput>) | null, log: (s: string) => void) {
  const { pages, pairs, queries } = loadAmara();
  const sut = await openSut(gut);
  try {
    const errors = await seedPages(sut, pages);
    log(`amara: ${pages.length} pages, ${pairs.length} pairs${judge ? ' (paid judge)' : ''}`);
    const byKey = new Map(pairs.map(p => [pairKey(p.a, p.b), p]));
    const gold = (a: { slug: string }, b: { slug: string }): PairGold => {
      const p = byKey.get(pairKey(a.slug, b.slug));
      return p ? { planted: true, item: p.id, kind: 'same_time_conflict', variant: 'plain', gold_class: labelClass(p.adjudicated) === 'contradiction' ? 'contradiction' : labelClass(p.adjudicated) === 'temporal' ? 'temporal' : 'compatible', older_slug: null } : { planted: false, gold_class: 'compatible' };
    };
    const decide = judge ? (() => { const j = judge(sut); return async (i: JudgeInput) => j(i); })() : async () => ({ verdict: NO_CONTRADICTION, usage: { inputTokens: 0, outputTokens: 0 } });
    const cap = await runProbe(sut, pairs.map(p => ({ query: queries[p.id], item: p.id })), gold, decide);
    const scored = scoreAmara(pairs, cap.judgments);
    return { pages: pages.length, seed_errors: errors.length, pairs_offered_total: cap.judgments.length, judge_errors: cap.judgments.filter(j => j.error).length, ...(judge ? scored : { pairs: scored.pairs, offered: scored.offered, rows: scored.rows.map(r => ({ id: r.id, original: r.original, adjudicated: r.adjudicated, offered: r.offered, offered_own_query: r.offered_own_query })) }) };
  } finally {
    await sut.engine.disconnect().catch(() => {});
  }
}

export interface PaidResult {
  classification: ClassificationSummary;
  candidate_parity: { hermetic_offered: number; paid_offered: number; identical: boolean };
  cap_hit_mid_run: boolean;
  amara: unknown;
  judgments: Judgment[];
  cost: RunSummary | null;
  embedding_available: boolean;
}

async function runPaid(gut: GbrainUnderTest, world: ReturnType<typeof generateN2World>, hermeticKeys: readonly string[], anthropicKey: string, argv: readonly string[], log: (s: string) => void): Promise<PaidResult> {
  const { run, guard } = startPaidRun(CATEGORY, { ...budgetOptionsFrom(argv), estimateUsd: PAID_ESTIMATE_USD, log });
  let out: PaidResult | undefined;
  try {
    out = await withHermeticEnv('n2-paid', async (): Promise<PaidResult> => {
      process.env.ANTHROPIC_API_KEY = anthropicKey;
      const gw = await importGbrain<{ configureGateway: (c: Record<string, unknown>) => void; isAvailable: (t: string) => boolean }>(gut, 'src/core/ai/gateway.ts');
      gw.configureGateway({ chat_model: JUDGE_MODEL, expansion_model: JUDGE_MODEL, env: { ANTHROPIC_API_KEY: anthropicKey } });
      const embedding = gw.isAvailable('embedding');
      if (embedding) throw new Error('paid arm: an embedding provider is available, so retrieval would differ from the hermetic arm');
      const { ledger } = world;
      const sut = await openSut(gut);
      try {
        const seedErrors = await seedPages(sut, ledger.pages.map(p => ({ slug: p.slug, content: renderN2Page(p) })));
        if (seedErrors.length) throw new Error(`paid arm seed errors: ${seedErrors[0]}`);
        log(`paid judge (${JUDGE_MODEL}) over ${ledger.items.length} queries`);
        const qs = itemQueries(ledger);
        const shards = Array.from({ length: PAID_SHARDS }, (_, k) => qs.filter((_q, i) => i % PAID_SHARDS === k));
        const parts = await Promise.all(shards.map(shard => runProbe(sut, shard, n2Gold(ledger), async input => {
          if (guard.exhausted) throw new Error('budget exhausted');
          return await sut.judge({ ...input, model: JUDGE_MODEL });
        }, { budgetUsd: PROBE_BUDGET_USD / PAID_SHARDS })));
        const cap = { judgments: parts.flatMap(x => x.judgments), capHitMidRun: parts.some(x => x.capHitMidRun) };
        const paidKeys = [...new Set(cap.judgments.map(j => `${j.query_item}::${j.key}`))].sort();
        const amara = await amaraArm(gut, s => input => s.judge({ ...input, model: JUDGE_MODEL }), log).catch(e => ({ error: e instanceof Error ? e.message : String(e) }));
        return {
          classification: scoreClassification(ledger, cap.judgments),
          candidate_parity: { hermetic_offered: hermeticKeys.length, paid_offered: paidKeys.length, identical: JSON.stringify(paidKeys) === JSON.stringify(hermeticKeys) },
          cap_hit_mid_run: cap.capHitMidRun, amara, judgments: cap.judgments, cost: null, embedding_available: embedding,
        };
      } finally {
        await sut.engine.disconnect().catch(() => {});
      }
    });
  } finally {
    guard.uninstall();
    const summary = run.close();
    if (out) out.cost = summary;
  }
  return out;
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) return argv[at + 1];
  return argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

const pct = (s: StageCounts) => (s.rate === null ? 'n/a' : `${(s.rate * 100).toFixed(1)}%`) + ` (${s.hits}/${s.n})`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const log = json ? () => {} : (s: string) => console.log(s);
  const seedArg = argValue(argv, '--seed');
  const seed = seedArg === undefined ? N2_DEFAULT_SEED : Number(seedArg);
  if (!Number.isInteger(seed)) throw new Error('--seed needs an integer');
  const paid = paidRequested(argv);
  const budget = paid ? requirePaidArm(argv, { arm: 'N2 judge arm', estimateUsd: PAID_ESTIMATE_USD }) : null;
  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? '';
  if (paid && !anthropicKey) throw new Error('N2 paid arm needs ANTHROPIC_API_KEY (the judge model is anthropic:claude-haiku-4-5)');
  const output = argValue(argv, '--output');
  const outPath = output ? join(output, 'receipt.json') : receiptPath(CATEGORY);
  const startedAt = new Date().toISOString();
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  log(`# BrainBench N2: contradiction surfacing (gbrain ${gut.version}${gut.overlay ? `, overlay ${gut.overlay.build.commit.slice(0, 7)}` : ', pinned'})`);
  const world = generateN2World({ seed });
  const h = await runHermetic(gut, world, { log });
  let p: PaidResult | null = null;
  let paidError: string | null = null;
  if (paid && !h.harness_error) {
    try { p = await runPaid(gut, world, h.offered_keys, anthropicKey, argv, log); }
    catch (e) { paidError = e instanceof Error ? e.message : String(e); }
    const st = ledgerStatus({ runId: budget!.budgetRunId });
    log(`[budget] run ${budget!.budgetRunId}: $${st.run?.remaining_usd.toFixed(2)} left`);
  }

  const errors = [
    ...(h.harness_error ? [{ probe_id: 'run', origin: 'harness' as const, message: h.harness_error }] : []),
    ...(paidError ? [{ probe_id: 'paid', origin: 'dependency' as const, message: paidError }] : []),
  ];
  const safetyPass = h.safety !== null && h.safety.applied_mutations === 0 && h.safety.judge_errors_counted_as_verdicts === 0;
  const nTotal = world.ledger.items.length;
  const { PROMPT_VERSION } = await importGbrain<{ PROMPT_VERSION: string }>(gut, 'src/core/eval-contradictions/types.ts');
  const receipt: Receipt = {
    ...(p ? {} : noModelSpend('hermetic: provider keys stripped, keyword search only, injected oracle and throwing judges; no model and no paid request')),
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CATEGORY,
    run_status: h.harness_error ? 'error' : 'completed',
    ...(h.harness_error ? {} : { verdict: safetyPass ? 'pass' : 'fail' }),
    n_total: nTotal,
    n_scored: h.harness_error ? 0 : nTotal,
    completion_rate: h.harness_error ? 0 : 1,
    errors,
    publishable: !h.harness_error,
    gbrain_version: gut.version,
    gbrain_pin: gbrainPin(),
    execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(gut) },
    resolved_config: {
      engine: 'pglite-in-memory',
      decide: DECIDE_OFF,
      caller: 'operation handlers with OperationContext { remote: false, sourceId: default } for writes; runContradictionProbe in-process',
      search_path: `runContradictionProbe default hybridSearch (wrapped only to record results), top-K ${TOP_K}, no embedding gateway (keyword only)`,
      probe: { top_k: TOP_K, sampling: 'deterministic', no_cache: true, yes_override: true, budget_usd: PROBE_BUDGET_USD },
      judges: { hermetic: 'oracle-recording judge (gold verdicts from the ledger) and a throwing judge on the first 30 queries', paid: p ? `gbrain judgeContradiction, ${JUDGE_MODEL}, prompt version ${PROMPT_VERSION}; queries in ${PAID_SHARDS} concurrent probe runs, probe budget $${PROBE_BUDGET_USD / PAID_SHARDS} each` : 'not run' },
      seed, generator_version: N2_GENERATOR_VERSION, ledger_sha256: world.fingerprint,
      entrypoints: ENTRYPOINTS,
      gbrain_overlay: overlaySummary(gut),
      paid: paid ? { budget_run_id: budget?.budgetRunId ?? null, provider_keys: ['ANTHROPIC_API_KEY'], embedding_available: p?.embedding_available ?? null, error: paidError } : null,
      verdict_rule: 'verdict = the preregistered safety contracts only (no applied mutation; no judge exception counted as a verdict); quality and paid metrics live in data and never change the verdict',
    },
    hashes: { ledger_sha256: world.fingerprint },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: {
      safety: h.safety,
      candidate: h.candidate,
      oracle: h.oracle,
      throwing_control: h.throwing,
      date_signal: h.date_signal,
      find_contradictions: h.find_contradictions,
      generic_queries: h.generic_queries,
      amara: h.amara,
      presence: h.presence,
      timings_ms: h.timings_ms,
      gaps: GAPS,
      paid: p ? { classification: p.classification, candidate_parity: p.candidate_parity, cap_hit_mid_run: p.cap_hit_mid_run, amara: p.amara, judgments: p.judgments.map(j => ({ q: j.query_item, a: j.a, b: j.b, gold: j.gold.planted ? `${j.gold.item}:${j.gold.gold_class}` : 'unplanted', verdict: j.verdict, error: j.error, resolution_kind: j.resolution_kind ?? null, dates_seen: j.dates_seen })) } : null,
      harness_error: h.harness_error,
    },
  };
  if (p?.cost) receipt.cost = receiptCost(p.cost);
  writeReceipt(outPath, receipt);

  log(`\nverdict: ${receipt.verdict ?? 'error'}`);
  if (h.safety) log(`safety: applied mutations ${h.safety.applied_mutations} (target 0); judge exceptions counted as verdicts ${h.safety.judge_errors_counted_as_verdicts} (target 0)`);
  if (h.candidate) {
    log(`candidate recall of same-time conflicts: ${(h.candidate.conflict_recall * 100).toFixed(1)}% (${h.candidate.conflicts_offered}/${h.candidate.conflicts_total}); floor 50%`);
    log(`  both pages in the top ${TOP_K} of their own query: ${pct(h.candidate.both_retrieved_own_query)}`);
    log(`  negatives offered: dated changes ${pct(h.candidate.negatives_offered.dated_changes)}, compatible ${pct(h.candidate.negatives_offered.compatible)}`);
  }
  if (h.oracle) log(`oracle-judge ceiling: end-to-end conflict recall ${pct(h.oracle.e2e_conflict_recall)}; proposals acceptable ${pct(h.oracle.resolution_acceptable)}`);
  if (h.generic_queries) log(`discovery without a company name: ${h.generic_queries.planted_conflicts_offered}/${h.generic_queries.planted_conflicts_total} planted conflicts offered by ${h.generic_queries.queries} generic queries`);
  if (h.date_signal) log(`dates seen by the judge: ${h.date_signal.undated_shown_with_a_date}/${h.date_signal.undated_planted_pages_offered} undated planted pages shown with a date; pairs skipped by the date filter ${h.date_signal.pairs_skipped_by_date}`);
  if (p) {
    const c = p.classification;
    log(`paid judge: e2e conflict recall ${pct(c.e2e_conflict_recall)}; recall on offered conflicts ${pct(c.classification_recall_offered_conflicts)}`);
    log(`  false contradiction: dated changes ${pct(c.false_contradiction_dated_changes)}, compatible ${pct(c.false_contradiction_compatible)}, unplanted pairs ${pct(c.false_contradiction_unplanted_pairs)}`);
    log(`  judged-pair precision ${pct(c.judged_pair_precision)}; temporal recognition ${pct(c.temporal_recognition)}; judge errors ${pct(c.judge_errors)}; proposals acceptable ${pct(c.resolution_acceptable)}`);
    log(`  decision: ${c.decision.separates ? 'separates same-time conflicts from dated changes' : `does not separate (${c.decision.failed_rules.join('; ')})`}`);
  }
  if (paidError) log(`paid arm error: ${paidError}`);
  if (h.harness_error) log(`run error: ${h.harness_error}`);
  log(`gbrain findings: see docs/benchmarks/2026-10-01-wave-bugs.md (N2-*)`);
  log(`receipt: ${outPath}`);
  if (json) process.stdout.write(JSON.stringify({ run_status: receipt.run_status, verdict: receipt.verdict, safety: h.safety, candidate: h.candidate?.conflict_recall }, null, 2) + '\n');
  process.exit(receipt.run_status === 'error' ? 3 : receipt.verdict === 'pass' ? 0 : 1);
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(3); });
}

/**
 * engine-bench, gate suites: the gbrain-evals suites gbrain's docs/designs/RUST_ENGINE.md names in "Eval gates" E1 to E3
 * (all but LongMemEval recall, which is engine-bench's lme-recall stage), run on PGLite, Postgres and Rust at one gbrain
 * build, then one engine-bench.gate-suite/1 file per suite for eval-gates.json.
 *
 *   bun eval/runner/engine-bench/gate-suites.ts run --gbrain <checkout>@<sha> [--suites cat10,cat12] [--engines pglite,postgres,rust]
 *       [--paid --budget-run-id <id> --budget-usd <n> --embed-cache-dir <dir>]
 *   bun eval/runner/engine-bench/gate-suites.ts emit --out <dir> [--counted] [--suites ...]
 *
 * `run` starts each suite's runner (and the runner of a row reported beside it) once per engine with GBRAIN_EVAL_ENGINE
 * set, LIFECYCLE_PG_URL for Postgres, and GBRAIN_RUST_ENGINE_ADDON plus GBRAIN_RUST_ENGINE_ADDON_SHA256 (both required
 * for rust, so the runner refuses any other addon file). The child environment drops every provider key, except that
 * `--paid` keeps them for the two suites that embed live (Cat 13 and Cat 13b), which then run under the budget ledger
 * with one embedding cache per suite: PGLite fills it (so it must come first in --engines) and the others read it only
 * (a miss on Postgres or Rust makes the suite NOT_RUN). Without `--paid` those two run on hash embeddings.
 * Receipts land at eval/reports/<category>/engine-<kind>/receipt.json, logs and refusals beside them.
 *
 * `emit` reads those receipts and writes <out>/<suite>.json. Rules, as RUST_ENGINE.md (gbrain 09b9ac5c) states them,
 * with readings where the runner's denominator or metric differs (Cat 12 and Cat 24 ours; Cat 1, Cat 3, type-accuracy
 * and Cat 13 Ember's, fixed 2026-11-23 after the keyless b66e4077 pilot):
 *   all-pass         a count gate (Cat 10 133/133, Cat 12 24/24 with the same MCP operation count on every engine, Cat 4
 *                    100%, Cat 24 7/7, conformance 24/24, Cat 22 zero leaks): Rust passes every case of its own run.
 *   at-least-both    a ranked metric (Cat 13b top-1, Cat 1 relational graph-first P@5 and R@5, Cat 3 R@5 and P@5 from its
 *                    ranks, type-accuracy strict F1, type accuracy and per-type F1): Rust's value is at least the PGLite
 *                    and the Postgres value. For Cat 3 and type-accuracy, any Rust value that differs from a TypeScript
 *                    value is also listed as a divergence with the queries or edges that differ, never as a win.
 *   paired-bound     Cat 13 nDCG@5: the per-query 95% paired lower bound of Rust minus each TypeScript engine is at least
 *                    -0.018, identical top-5 id sets counting as ties; the strict point comparison is a second row that
 *                    lists the queries whose tie order flips. Reported, not gating, for Dec 1 (plan D24).
 *   within-or-equal  E3's "within 0.5 points or equal counts" (Cats 19, 27 and 23) against each TypeScript engine.
 *   reported         Cat 7: passes when it ran on every engine; every metric Rust loses is listed.
 * A row reported beside a gate row (graph-oracle-parse and the gbrain product row beside Cat 1) never gates.
 * A suite is NOT_RUN when an engine has no completed receipt, refused, or ran another build or addon than the others.
 * A Rust error or failed run where both TypeScript engines completed is FAIL, and a FAIL names the gbrain call sites
 * (file:line) of every engine call the Rust run refused.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { EVAL_ENGINE_REFUSED_EXIT, EVAL_ENGINES, RUST_ADDON_SHA256_ENV, RUST_REFUSALS_FILE_ENV, type EvalEngineKind, type RustRefusalSite } from '../eval-engine.ts';
import { gbrainSpecFrom } from '../gbrain-under-test.ts';
import { writeScrubbedJson } from '../receipt.ts';
import { clusteredPairedDelta } from '../stats/paired.ts';
import { runnerEnv } from './correctness.ts';
import { BOOTSTRAP, RUST_RECALL_DELTA } from './lme-recall.ts';

const REPO = resolve(import.meta.dir, '../../..');
export const GATE_SUITE_SCHEMA = 'engine-bench.gate-suite/1';
const TS_ENGINES = ['pglite', 'postgres'] as const;

type Receipt = Record<string, any>;
type Measured = Record<string, number>;
export type Rule =
  | { kind: 'all-pass'; counts: (r: Receipt) => { passed: number; total: number }; equal?: string[] }
  | { kind: 'at-least-both'; keys: string[]; prefixes?: string[] }
  | { kind: 'paired-bound'; key: string; floor: number }
  | { kind: 'within-or-equal'; points: string[]; counts: string[] }
  | { kind: 'reported' };

export interface GateSuite {
  id: string;
  gate: 'E1' | 'E2' | 'E3';
  benchmark: string;
  category: string;
  script: string;
  /** Runner arguments; `paid` only for the suites that embed live. */
  args: (o: { paid: boolean; cacheFile?: string; fillsCache: boolean; budget: string[] }) => string[];
  /** The runner writes its receipt at the category's own path, so `run` copies it into the engine directory. */
  canonicalReceipt?: boolean;
  embedsLive?: boolean;
  measure: (r: Receipt) => Measured;
  rule: Rule;
  reading?: string;
  /** Who fixed the reading: ours (GBEV-3, accepted by Ember) or Ember's 2026-11-23 reading. */
  readingBy?: 'ember';
  /** Text every file of this suite opens its reason with. */
  note?: string;
  /** The items (queries, edges) where Rust and one TypeScript engine differ, for the divergence list. */
  diverge?: (rust: Receipt, ts: Receipt) => string[];
  /** A row from another runner reported beside the gate row; it never gates. */
  beside?: { id: string; benchmark: string; category: string; script: string; args: string[]; measure: (r: Receipt) => Measured };
}

const scorecard = (r: Receipt, name: string) => (r.data?.scorecard ?? []).find((s: any) => s.name === name) ?? {};
const relational = (r: Receipt, adapter: string) => (r.data?.scorecards ?? []).find((s: any) => s.family === 'relational' && s.adapter === adapter) ?? {};
const passedOf = (r: Receipt) => ({ passed: (r.n_scored ?? 0) - (r.errors?.length ?? 0), total: r.n_total ?? 0 });
const stub = (paid: boolean) => (paid ? [] : ['--stub-embed']);
const EMBER = "Ember's reading of RUST_ENGINE.md (lines 489 and 498, and plan D24) at gbrain master 5c9f3051, fixed 2026-11-23 after the keyless b66e4077 pilot had produced Rust numbers";
const edgeKey = (e: any) => `${e.from} -[${e.type}]-> ${e.to}`;
function onlyIn(a: string[], b: string[]): string[] { const s = new Set(b); return a.filter(x => !s.has(x)); }
function listed(label: string, xs: string[]): string[] { return xs.length ? [`${label} (${xs.length}): ${xs.slice(0, 25).join(', ')}${xs.length > 25 ? ', …' : ''}`] : []; }

export const GATE_SUITES: readonly GateSuite[] = [
  {
    id: 'cat13/ndcg5', gate: 'E1', benchmark: 'Cat 13 conceptual search, gbrain arm, nDCG@5', category: 'cat13-conceptual', script: 'eval/runner/cat13-conceptual.ts',
    canonicalReceipt: true, embedsLive: true,
    args: o => ['--adapter', 'gbrain', ...stub(o.paid), ...(o.paid ? ['--embed-cache', o.cacheFile!, ...(o.fillsCache ? [] : ['--embed-cache-only']), ...o.budget] : [])],
    measure: r => ({ ndcg5: scorecard(r, 'gbrain').ndcg5 }),
    rule: { kind: 'paired-bound', key: 'ndcg5', floor: -RUST_RECALL_DELTA },
    note: 'Reported, not gating, for Dec 1 (plan D24).',
    readingBy: 'ember',
    reading: 'nDCG@5 is read as the per-query 95% paired lower bound of Rust minus each TypeScript engine, at least -0.018, with identical top-5 ids counted as ties. The strict point comparison (Rust\'s mean at least both) is a secondary row listing the queries whose tie order flips. Reported, not gating, for Dec 1 (plan D24).',
  },
  {
    id: 'cat13b/top1', gate: 'E1', benchmark: 'Cat 13b source swamp, gbrain arm, top-1', category: 'cat13b-source-swamp', script: 'eval/runner/cat13b-source-swamp.ts',
    embedsLive: true,
    args: o => [...stub(o.paid), ...(o.paid ? ['--embed-cache', o.cacheFile!, ...(o.fillsCache ? o.budget : ['--embed-cache-only', ...o.budget])] : [])],
    measure: r => ({ top1: scorecard(r, 'gbrain').top1_hit_rate }),
    rule: { kind: 'at-least-both', keys: ['top1'] },
  },
  {
    id: 'cat10', gate: 'E1', benchmark: 'Cat 10 adversarial input, ops succeeded', category: 'adversarial', script: 'eval/runner/adversarial.ts', args: () => [],
    measure: r => {
      const rows: any[] = r.data?.results ?? [];
      return { ops_succeeded: rows.reduce((s, x) => s + x.ops_succeeded, 0), ops_attempted: rows.reduce((s, x) => s + x.ops_attempted, 0) };
    },
    rule: { kind: 'all-pass', counts: r => { const m = GATE_SUITES[2].measure(r); return { passed: m.ops_succeeded, total: m.ops_attempted }; } },
  },
  {
    id: 'cat12', gate: 'E1', benchmark: 'Cat 12 MCP operation contract, behavioural assertions', category: 'mcp-contract', script: 'eval/runner/mcp-contract.ts', args: () => [],
    measure: r => ({ passed: r.data?.behavioral?.passed, total: r.data?.behavioral?.total, operations: r.data?.handler_walk?.total, operations_missing: r.data?.handler_walk?.missing?.length }),
    rule: { kind: 'all-pass', counts: r => ({ passed: r.data?.behavioral?.passed ?? 0, total: r.data?.behavioral?.total ?? 0 }), equal: ['operations', 'operations_missing'] },
    reading: 'RUST_ENGINE.md says 50/50; the runner has 24 behavioural assertions, so the gate reads 24/24, and the MCP handler walk must reach the same operation count, with the same number missing, on all three engines.',
  },
  {
    id: 'cat7', gate: 'E1', benchmark: 'Cat 7 latency and throughput, 1K and 10K pages', category: 'perf', script: 'eval/runner/perf.ts', args: () => [],
    measure: r => {
      const out: Measured = {};
      for (const l of r.data?.latency ?? []) out[`${l.op}@${l.scale}.p50_ms`] = l.p50_ms;
      for (const t of r.data?.throughput ?? []) out[`${t.op}@${t.scale}.ops_per_sec`] = t.ops_per_sec;
      return out;
    },
    rule: { kind: 'reported' },
  },
  {
    id: 'brainbench/cats-1-2', gate: 'E2', benchmark: 'BrainBench Cat 1 relational retrieval, graph-first (before-after.ts AFTER column, 145 relational questions), P@5 and R@5',
    category: 'before-after', script: 'eval/runner/before-after.ts', args: () => [],
    measure: r => ({ p5: r.data?.after?.precision_at_k, r5: r.data?.after?.recall_at_k, questions: r.n_total }),
    rule: { kind: 'at-least-both', keys: ['p5', 'r5'] },
    readingBy: 'ember',
    reading: 'The gate row is Cat 1 relational graph-first (before-after.ts, graph-first column): P@5 and R@5 on the 145 relational questions, each at least both PGLite and Postgres. graph-oracle-parse and the gbrain product adapter row (multi-adapter.ts) are reported beside it and do not gate.',
    beside: {
      id: 'brainbench/cats-1-2:beside', benchmark: 'BrainBench Cats 1+2 relational retrieval, multi-adapter graph-oracle-parse and the gbrain product row on hash embeddings (reported beside, never gates)',
      category: 'multi-adapter', script: 'eval/runner/multi-adapter.ts', args: ['--stub-embed'],
      measure: r => {
        const g = relational(r, 'graph-oracle-parse'), p = relational(r, 'gbrain');
        return { oracle_p5: g.mean_precision_at_k, oracle_r5: g.mean_recall_at_k, product_p5_hash: p.mean_precision_at_k, product_r5_hash: p.mean_recall_at_k };
      },
    },
  },
  {
    id: 'brainbench/cat3', gate: 'E2', benchmark: 'Cat 3 alias lookup through keyword search, R@5 and P@5 (top-1 beside)', category: 'identity', script: 'eval/runner/identity.ts', args: () => [],
    measure: r => {
      const rows: any[] = r.data?.results ?? [];
      const out: Measured = {};
      for (const cat of ['documented', 'undocumented']) {
        const xs = rows.filter(x => x.category === cat);
        const at = (k: number) => (xs.length ? xs.filter(x => x.found && x.rankPosition <= k).length / xs.length : NaN);
        out[`r5_${cat}`] = at(5);
        out[`p5_${cat}`] = at(5) / 5;
        out[`top1_${cat}`] = at(1);
      }
      return out;
    },
    rule: { kind: 'at-least-both', keys: ['r5_documented', 'p5_documented', 'r5_undocumented', 'p5_undocumented'] },
    diverge: (rust, ts) => {
      const rank = (r: Receipt) => new Map<string, string>((r.data?.results ?? []).map((x: any) => [`${x.alias} (${x.category})`, x.found ? String(x.rankPosition) : 'not found']));
      const a = rank(ts), b = rank(rust);
      return listed('queries whose rank differs', [...b.keys()].filter(q => a.get(q) !== b.get(q)).map(q => `${q}: Rust ${b.get(q)} vs ${a.get(q) ?? 'absent'}`));
    },
    readingBy: 'ember',
    reading: 'Cat 3 is read on R@5 and P@5 from the same ranks (P@5 = top-5 hits / 5), each at least both TypeScript values, per alias category, with top-1 beside. Any value that differs from either TypeScript value is listed as a divergence with the queries that differ, never counted as a win.',
  },
  {
    id: 'brainbench/cat4', gate: 'E2', benchmark: 'Cat 4 timeline round-trip', category: 'temporal', script: 'eval/runner/temporal.ts', args: () => [],
    measure: r => ({ passed: passedOf(r).passed, total: passedOf(r).total }),
    rule: { kind: 'all-pass', counts: passedOf },
  },
  {
    id: 'brainbench/type-accuracy', gate: 'E2', benchmark: 'Link type accuracy of the links the engine stores (world-v1)', category: 'type-accuracy', script: 'eval/runner/type-accuracy.ts', args: () => [],
    measure: r => {
      const e = r.data?.engine_links ?? {};
      const out: Measured = { strict_f1: e.overallStrictF1, type_accuracy: e.overallTypeAccuracy };
      for (const t of e.perType ?? []) out[`f1.${t.linkType}`] = t.f1_strict;
      return out;
    },
    rule: { kind: 'at-least-both', keys: ['strict_f1', 'type_accuracy'], prefixes: ['f1.'] },
    diverge: (rust, ts) => {
      const edges = (r: Receipt) => (r.data?.engine_links?.storedEdges ?? []).map(edgeKey);
      const a = edges(ts), b = edges(rust);
      return [...listed('edges only Rust stores', onlyIn(b, a)), ...listed('edges Rust does not store', onlyIn(a, b))];
    },
    readingBy: 'ember',
    reading: 'type-accuracy has no P@5 or R@5; it is read on strict F1, type accuracy and every per-type F1 of the links the engine stores, each at least both TypeScript values. Any value that differs from either TypeScript value is listed as a divergence with its differing edges, never counted as a win.',
  },
  {
    id: 'brainbench/cat24', gate: 'E2', benchmark: 'Cat 24 capture provenance', category: 'cat24-capture-provenance', script: 'eval/runner/cat24-capture-provenance.ts', args: () => [],
    measure: r => ({ passed: passedOf(r).passed, total: passedOf(r).total }),
    rule: { kind: 'all-pass', counts: passedOf },
    reading: 'RUST_ENGINE.md says 5/5; the runner has 7 probes, so the gate reads 7/7.',
  },
  {
    id: 'memory-verb-conformance', gate: 'E2', benchmark: 'gbrain MEMORY_VERBS v1 conformance through dispatchToolCall', category: 'memory-verb-conformance', script: 'eval/runner/memory-verb-conformance.ts', args: () => [],
    measure: r => ({ passed: r.data?.summary?.cases_passed, total: r.data?.summary?.cases_total }),
    rule: { kind: 'all-pass', counts: r => ({ passed: r.data?.summary?.cases_passed ?? 0, total: r.data?.summary?.cases_total ?? 0 }) },
  },
  {
    id: 'cat22', gate: 'E3', benchmark: 'Cat 22 source isolation, cross-source leaks', category: 'cat22-source-isolation', script: 'eval/runner/cat22-source-isolation.ts', args: () => [],
    measure: r => ({ leaks: (r.data?.probes ?? []).reduce((s: number, p: any) => s + (p.leaked_results ?? 0), 0), controls_detect_leak: r.data?.controls_detect_leak ? 1 : 0 }),
    rule: { kind: 'all-pass', counts: passedOf },
  },
  {
    id: 'cat19', gate: 'E3', benchmark: 'Cat 19 sick-brain remediation (hash embeddings)', category: 'cat19-doctor-remediate', script: 'eval/runner/cat19-doctor-remediate.ts', args: () => [],
    measure: r => ({ brain_score: r.data?.achieved?.brain_score, gates_passed: r.data?.gates ? Object.values(r.data.gates).filter(v => v === 1).length : NaN }),
    rule: { kind: 'within-or-equal', points: ['brain_score'], counts: ['gates_passed'] },
  },
  {
    id: 'cat27', gate: 'E3', benchmark: 'Cat 27 graph signals on', category: 'cat27-graph-signals', script: 'eval/runner/cat27-graph-signals.ts', args: () => [],
    measure: r => {
      const a = r.data?.aggregate ?? {};
      return { ndcg10_points: a.mean_ndcg10_with_signals * 100, top1_hits: Math.round(a.top1_hit_rate_with_signals * a.n_probes), probes_scored: a.n_probes, errors: (r.errors ?? []).length };
    },
    rule: { kind: 'within-or-equal', points: ['ndcg10_points'], counts: ['top1_hits', 'probes_scored', 'errors'] },
  },
  {
    id: 'cat23', gate: 'E3', benchmark: 'Cat 23 phantom to canonical redirect (scored against PGLite\'s pg_trgm decisions)', category: 'cat23-phantom-redirect', script: 'eval/runner/cat23-phantom-redirect.ts', args: () => [],
    measure: r => ({ redirects_correct: r.data?.redirects_correct, refusals_correct: r.data?.refusals_correct, resolver_errors: r.data?.resolver_errors }),
    rule: { kind: 'within-or-equal', points: [], counts: ['redirects_correct', 'refusals_correct', 'resolver_errors'] },
  },
];

export function engineDir(category: string, kind: EvalEngineKind, reports = join(REPO, 'eval/reports')): string {
  return join(reports, category, `engine-${kind}`);
}

interface RunExit { code: number | null; signal: string | null; gbrain: string }
interface EngineRun { kind: EvalEngineKind; receipt: Receipt | null; refused: string | null; refusalSites?: RustRefusalSite[]; logTail?: string; hasLog?: boolean; exit?: RunExit | null }

function loadRun(category: string, kind: EvalEngineKind, reports?: string): EngineRun {
  const dir = engineDir(category, kind, reports);
  const refusedFile = join(dir, 'refused.txt');
  const receiptFile = join(dir, 'receipt.json');
  const sitesFile = join(dir, REFUSAL_SITES);
  const logFile = join(dir, 'run.log');
  const exitFile = join(dir, RUN_EXIT);
  return {
    kind,
    receipt: existsSync(receiptFile) ? JSON.parse(readFileSync(receiptFile, 'utf8')) : null,
    refused: existsSync(refusedFile) ? readFileSync(refusedFile, 'utf8').trim() : null,
    refusalSites: existsSync(sitesFile) ? JSON.parse(readFileSync(sitesFile, 'utf8')) : [],
    logTail: existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().slice(-500) : '',
    hasLog: existsSync(logFile),
    exit: existsSync(exitFile) ? JSON.parse(readFileSync(exitFile, 'utf8')) : null,
  };
}

const REFUSAL_SITES = 'rust-refusal-sites.json';
const RUN_EXIT = 'exit.json';
const completed = (r: Receipt | null) => r !== null && r.run_status === 'completed';

/** The build a receipt names: overlay commit, ref and dirty flag, plus the Rust addon digest and target. */
function buildOf(r: Receipt): { overlay: { commit: string | null; ref: string | null; checkout_dirty: boolean | null }; rust_addon: { sha256: string | null; target: string | null } | null } {
  const g = r.gbrain_under_test ?? {};
  const o = g.overlay ?? {};
  return {
    overlay: { commit: o.commit ?? null, ref: o.ref ?? null, checkout_dirty: o.checkout_dirty ?? null },
    rust_addon: g.rust_addon ? { sha256: g.rust_addon.sha256 ?? null, target: g.rust_addon.target ?? null } : null,
  };
}

/** How a receipt embedded (stub, live or none, with model and width), so receipts from different modes never compare. */
const embeddingOf = (r: Receipt): string => {
  const c = r.resolved_config ?? {};
  return JSON.stringify([c.embed_transport, c.embedding_transport, c.embedder, c.embedding_model, c.embedding_dimensions].map(x => x ?? null));
};

const top5 = (q: any): string[] => (q?.ranked_pages ?? []).slice(0, 5).map((p: any) => p.page_id);
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(x => b.includes(x));

/**
 * Rust minus a TypeScript engine on Cat 13's per-query nDCG@5, each query its own cluster: the 95% paired interval, with
 * a query whose top-5 id set is the same on both engines counted as a tie (Rust takes the TypeScript value), and the
 * queries whose tie order flips (same set, another order).
 */
export function cat13PairedBound(rust: Receipt, ts: Receipt): { delta: number | null; lo: number | null; n: number; ties: number; floor: number; tie_order_flips: string[] } {
  const byId = (r: Receipt) => new Map<string, any>((r.data?.per_query?.gbrain ?? []).map((q: any) => [q.id, q]));
  const a = byId(ts), b = byId(rust);
  const ids = [...a.keys()].filter(id => b.has(id));
  const tied = (id: string) => sameSet(top5(a.get(id)), top5(b.get(id)));
  const flips = ids.filter(id => tied(id) && top5(a.get(id)).join('\n') !== top5(b.get(id)).join('\n'))
    .map(id => `${id} (Rust ${Number(b.get(id).ndcg5).toFixed(4)} vs ${Number(a.get(id).ndcg5).toFixed(4)})`);
  const floor = -RUST_RECALL_DELTA;
  if (!ids.length) return { delta: null, lo: null, n: 0, ties: 0, floor, tie_order_flips: [] };
  const pairs = ids.map(id => ({ id, cluster: id, a: a.get(id).ndcg5, b: tied(id) ? a.get(id).ndcg5 : b.get(id).ndcg5 }));
  const d = clusteredPairedDelta(pairs, BOOTSTRAP);
  return { delta: d.delta, lo: d.ci95?.[0] ?? null, n: pairs.length, ties: ids.filter(tied).length, floor, tie_order_flips: flips };
}

type Loss = { id: string; reason: string };
type Row = { id: string; benchmark: string; verdict: 'PASS' | 'FAIL' | 'NOT_RUN'; measured: Record<string, Measured | null>; reason: string | null; secondary?: Record<string, unknown>; divergences?: string[] };

export interface GateSuiteFile {
  schema: typeof GATE_SUITE_SCHEMA;
  suite: string;
  gate: GateSuite['gate'];
  counted: boolean;
  gbrain: ReturnType<typeof buildOf> | null;
  verdict: 'PASS' | 'FAIL' | 'NOT_RUN';
  reason?: string;
  rows: Row[];
  losses: Loss[];
  amendment_text: string;
}

const STRICT = (s: GateSuite) => `${s.id}:strict`;
const extraRowIds = (s: GateSuite) => [...(s.rule.kind === 'paired-bound' ? [STRICT(s)] : []), ...(s.beside ? [s.beside.id] : [])];
const siteText = (x: RustRefusalSite) => `${x.site ?? 'unknown site'} (${x.member}, ${x.capability}${x.caller ? `, from ${x.caller}` : ''}) x${x.count}`;

/** Losses where Rust is below either TypeScript engine on a key both measured. */
function belowEither(id: string, measured: Record<string, Measured | null>, keys: string[]): Loss[] {
  const m = measured.rust!;
  return keys.flatMap(key => TS_ENGINES.filter(k => !(m[key] >= measured[k]![key])).map(k => ({ id: `${id}:${key}:vs-${k}`, reason: `${key}: Rust ${m[key]} < ${k} ${measured[k]![key]}` })));
}

export function judgeSuite(s: GateSuite, runs: Record<EvalEngineKind, EngineRun>, o: { counted: boolean }, besideRuns?: Record<EvalEngineKind, EngineRun>): GateSuiteFile {
  const measured: Record<string, Measured | null> = {};
  for (const k of EVAL_ENGINES) measured[k] = completed(runs[k].receipt) ? s.measure(runs[k].receipt!) : null;
  const base = { schema: GATE_SUITE_SCHEMA, suite: s.id, gate: s.gate, counted: o.counted, amendment_text: amendmentLine(s) } as const;
  const withNote = (text: string | null) => [s.note, text].filter(Boolean).join(' ') || null;
  const notRun = (why: string): GateSuiteFile => {
    const reason = withNote(why)!;
    return {
      ...base, gbrain: runs.rust.receipt ? buildOf(runs.rust.receipt) : null, verdict: 'NOT_RUN', reason,
      rows: [{ id: s.id, benchmark: s.benchmark, verdict: 'NOT_RUN', measured, reason }, ...extraRowIds(s).map(id => ({ id, benchmark: id === STRICT(s) ? `${s.benchmark}, strict point comparison (secondary)` : s.beside!.benchmark, verdict: 'NOT_RUN' as const, measured: {}, reason }))],
      losses: [],
    };
  };

  for (const k of EVAL_ENGINES) if (runs[k].refused) return notRun(`${k} refused: ${runs[k].refused}`);
  for (const k of TS_ENGINES) if (!completed(runs[k].receipt)) return notRun(`${k} has no completed receipt (${runs[k].receipt?.run_status ?? 'missing'})`);
  for (const k of EVAL_ENGINES) if (runs[k].receipt && runs[k].receipt!.engine !== k) return notRun(`the receipt in ${k}'s directory names engine ${runs[k].receipt!.engine ?? 'none'}`);
  const ran = EVAL_ENGINES.filter(k => completed(runs[k].receipt));
  const modes = ran.map(k => embeddingOf(runs[k].receipt!));
  if (new Set(modes).size > 1) return notRun(`the engines embedded differently (${ran.map((k, i) => `${k} ${modes[i]}`).join('; ')})`);
  const sitesLoss = (): Loss[] => {
    const refused = runs.rust.refusalSites ?? [];
    return refused.length ? [{ id: `${s.id}:refusal-sites`, reason: `The Rust run refused ${refused.reduce((n, x) => n + x.count, 0)} engine calls at: ${refused.map(siteText).join('; ')}` }] : [];
  };
  if (!runs.rust.receipt) {
    const tsBuilds = TS_ENGINES.map(k => buildOf(runs[k].receipt!).overlay.commit);
    if (new Set(tsBuilds).size !== 1 || tsBuilds[0] === null) return notRun(`the TypeScript engines ran different or unnamed gbrain builds (${tsBuilds.join(', ')})`);
    const exit = runs.rust.exit;
    const exitText = exit ? `exit ${exit.code ?? 'none'}${exit.signal ? ` by ${exit.signal}` : ''}` : 'no exit record';
    if (!runs.rust.hasLog || typeof exit?.code !== 'number' || exit.code === 0) return notRun(`Rust wrote no receipt and has no failed run on record (${exitText}${runs.rust.hasLog ? '' : ', no run.log'})`);
    const ref = exit.gbrain.split('@').at(-1) ?? '';
    if (!/^[0-9a-f]{7,40}$/.test(ref) || !tsBuilds[0].startsWith(ref)) return notRun(`Rust's run named gbrain ${exit.gbrain}, not the TypeScript engines' build ${tsBuilds[0]}`);
    const losses = [{ id: s.id, reason: `Rust wrote no receipt: its runner failed (${exitText}) without one, where both TypeScript engines completed.${runs.rust.logTail ? ` Log tail: ${runs.rust.logTail}` : ''}` }, ...sitesLoss()];
    const reason = withNote(losses.map(l => l.reason).join(' | ').slice(0, 1600))!;
    return {
      ...base, gbrain: { ...buildOf(runs.pglite.receipt!), rust_addon: null }, verdict: 'FAIL', reason,
      rows: [{ id: s.id, benchmark: s.benchmark, verdict: 'FAIL', measured, reason }, ...extraRowIds(s).map(id => ({ id, benchmark: id === STRICT(s) ? `${s.benchmark}, strict point comparison (secondary)` : s.beside!.benchmark, verdict: 'NOT_RUN' as const, measured: {}, reason }))],
      losses,
    };
  }
  const builds = EVAL_ENGINES.map(k => buildOf(runs[k].receipt!).overlay.commit);
  if (new Set(builds).size !== 1 || builds[0] === null) return notRun(`the engines ran different or unnamed gbrain builds (${builds.join(', ')})`);
  const gbrain = buildOf(runs.rust.receipt);
  if (!gbrain.rust_addon?.sha256) return notRun('the rust receipt names no addon digest');
  for (const k of ['postgres', 'rust'] as const) {
    const misses = runs[k].receipt?.resolved_config?.embed_cache?.stats?.misses;
    if (typeof misses === 'number' && misses > 0) return notRun(`${k} missed the shared embedding cache ${misses} times, so the engines did not see the same vectors`);
  }

  const gating: Loss[] = [];
  const reported: Loss[] = [];
  const extra: Row[] = [];
  const divergences: string[] = [];
  let secondary: Record<string, unknown> | undefined;
  const rust = runs.rust.receipt;
  if (!completed(rust)) gating.push({ id: s.id, reason: `Rust run did not complete (${rust.run_status}): ${(rust.errors ?? []).map((e: any) => e.message).join('; ').slice(0, 600)}` });
  else {
    const m = measured.rust!;
    const rule = s.rule;
    if (rule.kind === 'all-pass') {
      const c = rule.counts(rust);
      if (rust.verdict !== 'pass' || c.passed !== c.total) {
        const failing = (rust.errors ?? []).map((e: any) => `${e.probe_id}: ${String(e.message).slice(0, 200)}`);
        gating.push({ id: s.id, reason: `${c.passed}/${c.total} on Rust (verdict ${rust.verdict}). ${failing.join(' | ')}`.trim() });
      }
      for (const key of rule.equal ?? []) for (const k of TS_ENGINES) {
        if (m[key] !== measured[k]![key]) gating.push({ id: `${s.id}:${key}:vs-${k}`, reason: `Rust ${key} ${m[key]} vs ${k} ${measured[k]![key]}: not the same` });
      }
    } else if (rule.kind === 'at-least-both') {
      gating.push(...belowEither(s.id, measured, [...rule.keys, ...Object.keys(m).filter(k => (rule.prefixes ?? []).some(p => k.startsWith(p)))]));
      if (s.diverge) for (const k of TS_ENGINES) {
        const differs = Object.keys(m).filter(key => m[key] !== measured[k]![key]);
        if (differs.length) divergences.push([`vs ${k}: ${differs.map(key => `${key} Rust ${m[key]} vs ${measured[k]![key]}`).join(', ')}`, ...s.diverge(rust, runs[k].receipt!)].join('; '));
      }
    } else if (rule.kind === 'paired-bound') {
      const sets = EVAL_ENGINES.map(k => {
        const r = runs[k].receipt!;
        const ids: string[] = (r.data?.per_query?.gbrain ?? []).map((q: any) => q.id).sort();
        return { k, ids, n: r.n_total, full: ids.length === r.n_total && (r.resolved_config?.probes_generated ?? ids.length) === ids.length };
      });
      if (sets.some(x => !x.full) || new Set(sets.map(x => x.ids.join(','))).size !== 1) {
        return notRun(`the engines scored different or partial ${rule.key} query sets (${sets.map(x => `${x.k} ${x.ids.length} of ${x.n}`).join(', ')})`);
      }
      const bounds = Object.fromEntries(TS_ENGINES.map(k => [k, cat13PairedBound(rust, runs[k].receipt!)])) as Record<(typeof TS_ENGINES)[number], ReturnType<typeof cat13PairedBound>>;
      for (const k of TS_ENGINES) {
        const x = bounds[k];
        if (!(x.lo !== null && x.lo >= rule.floor)) gating.push({ id: `${s.id}:paired-lower-bound:vs-${k}`, reason: `Rust minus ${k} per-query ${rule.key} 95% lower bound ${x.lo?.toFixed(4) ?? 'unavailable'} < ${rule.floor} (delta ${x.delta?.toFixed(4) ?? 'n/a'}, ${x.n} queries, ${x.ties} tied top-5 sets)` });
      }
      secondary = { paired_lower_bound: Object.fromEntries(TS_ENGINES.map(k => [`rust_minus_${k}`, { delta: bounds[k].delta, lo: bounds[k].lo, n: bounds[k].n, ties: bounds[k].ties, floor: bounds[k].floor }])) };
      const strict = belowEither(STRICT(s), measured, [rule.key]);
      reported.push(...strict);
      const flips = TS_ENGINES.flatMap(k => listed(`tie order flips vs ${k}`, bounds[k].tie_order_flips));
      extra.push({
        id: STRICT(s), benchmark: `${s.benchmark}, strict point comparison (secondary)`, verdict: strict.length ? 'FAIL' : 'PASS', measured,
        reason: [...strict.map(l => l.reason), ...flips].join(' | ') || null,
        secondary: { tie_order_flips: Object.fromEntries(TS_ENGINES.map(k => [k, bounds[k].tie_order_flips])) },
      });
    } else if (rule.kind === 'within-or-equal') {
      for (const k of EVAL_ENGINES) for (const key of [...rule.points, ...rule.counts]) {
        if (!Number.isFinite(measured[k]![key])) return notRun(`the ${k} receipt has no ${key}`);
      }
      for (const k of TS_ENGINES) {
        for (const key of rule.points) if (!(Math.abs(m[key] - measured[k]![key]) <= 0.5)) gating.push({ id: `${s.id}:${key}:vs-${k}`, reason: `Rust ${m[key]} vs ${k} ${measured[k]![key]}: more than 0.5 points apart` });
        for (const key of rule.counts) if (m[key] !== measured[k]![key]) gating.push({ id: `${s.id}:${key}:vs-${k}`, reason: `Rust ${m[key]} vs ${k} ${measured[k]![key]}: counts differ` });
      }
    } else {
      for (const [key, v] of Object.entries(m)) for (const k of TS_ENGINES) {
        const ts = measured[k]![key];
        if (ts === undefined) continue;
        const worse = key.endsWith('ops_per_sec') ? v < ts : v > ts;
        if (worse) reported.push({ id: `${s.id}:${key}:vs-${k}`, reason: `Rust ${v.toFixed(3)} vs ${k} ${ts.toFixed(3)}` });
      }
    }
  }
  if (s.beside) {
    const b = s.beside;
    const bm: Record<string, Measured | null> = {};
    for (const k of EVAL_ENGINES) bm[k] = besideRuns && completed(besideRuns[k].receipt) ? b.measure(besideRuns[k].receipt!) : null;
    const missing = EVAL_ENGINES.filter(k => bm[k] === null);
    const lower = missing.length ? [] : belowEither(b.id, bm, Object.keys(bm.rust!));
    reported.push(...lower);
    extra.push({
      id: b.id, benchmark: b.benchmark, verdict: missing.length ? 'NOT_RUN' : 'PASS', measured: bm,
      reason: missing.length ? `reported beside the gate row; no completed receipt on ${missing.join(', ')}` : ['reported beside the gate row; never gates', ...lower.map(l => l.reason)].join(' | '),
    });
  }
  const failed = gating.length > 0;
  if (failed) gating.push(...sitesLoss());
  const verdict = failed ? 'FAIL' : 'PASS';
  const reason = withNote(failed ? gating.map(l => l.reason).join(' | ').slice(0, 1600) : null);
  return {
    ...base, gbrain, verdict, ...(reason ? { reason } : {}),
    rows: [{ id: s.id, benchmark: s.benchmark, verdict, measured, reason, ...(secondary ? { secondary } : {}), ...(s.diverge ? { divergences } : {}) }, ...extra],
    losses: [...gating, ...reported],
  };
}

export function amendmentLine(s: GateSuite): string {
  const rule = s.rule.kind === 'all-pass' ? `Rust passes every case of its own run${s.rule.equal ? ` and matches each TypeScript engine on ${s.rule.equal.join(' and ')}` : ''}`
    : s.rule.kind === 'at-least-both' ? 'Rust is at least the PGLite and the Postgres value'
      : s.rule.kind === 'paired-bound' ? `the per-query 95% paired lower bound of Rust minus each TypeScript engine is at least ${s.rule.floor}`
        : s.rule.kind === 'within-or-equal' ? 'Rust is within 0.5 points of, or equal in count to, each TypeScript engine'
          : 'reported: it ran on every engine and each metric Rust loses is listed';
  const by = s.readingBy === 'ember' ? EMBER : 'Our reading of RUST_ENGINE.md at gbrain 09b9ac5c, which Ember kept on 2026-11-23';
  return `${s.id} (${s.gate}, ${s.benchmark}; ${s.script}): ${rule}.${s.reading ? ` ${by}: ${s.reading}` : ''}`;
}

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

function selectSuites(argv: readonly string[]): GateSuite[] {
  const want = flag(argv, '--suites')?.split(',').map(x => x.trim()).filter(Boolean);
  if (!want) return [...GATE_SUITES];
  const unknown = want.filter(w => !GATE_SUITES.some(s => s.id === w));
  if (unknown.length) throw new Error(`--suites: unknown ${unknown.join(', ')}. Known: ${GATE_SUITES.map(s => s.id).join(', ')}`);
  return GATE_SUITES.filter(s => want.includes(s.id));
}

function runChild(args: string[], env: Record<string, string>, logPath: string): Promise<{ code: number | null; signal: string | null; tail: string }> {
  return new Promise(res => {
    const log = createWriteStream(logPath);
    let tail = '';
    const keep = (b: Buffer) => { log.write(b); tail = (tail + b.toString('utf8')).slice(-4_000); };
    const child = spawn(process.execPath, args, { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', e => { tail += `\nspawn error: ${e.message}`; });
    child.on('close', (code, signal) => { log.end(() => res({ code, signal, tail })); });
  });
}

async function run(argv: readonly string[]): Promise<void> {
  const spec = gbrainSpecFrom(argv);
  if (!spec || !/^[0-9a-f]{7,40}$/.test(spec.split('@').at(-1) ?? '')) throw new Error('run needs --gbrain <checkout>@<sha> with a 7 to 40 character commit sha (not a tag or branch), the one build every engine and suite measures');
  const engines = (flag(argv, '--engines')?.split(',') ?? [...EVAL_ENGINES]) as EvalEngineKind[];
  const paid = argv.includes('--paid');
  const budget = paid ? ['--budget-run-id', flag(argv, '--budget-run-id') ?? '', '--budget-usd', flag(argv, '--budget-usd') ?? ''] : [];
  if (paid && budget.includes('')) throw new Error('--paid needs --budget-run-id and --budget-usd');
  const cacheDir = paid ? resolve(flag(argv, '--embed-cache-dir') ?? '') : '';
  if (paid && !flag(argv, '--embed-cache-dir')) throw new Error('--paid needs --embed-cache-dir, so every engine reads the same vectors');
  if (paid && engines.includes('pglite') && engines[0] !== 'pglite') throw new Error('--paid needs pglite first in --engines: PGLite fills the embedding cache the other engines only read');
  if (engines.includes('rust') && (!process.env.GBRAIN_RUST_ENGINE_ADDON || !process.env[RUST_ADDON_SHA256_ENV])) {
    throw new Error(`the rust engine needs GBRAIN_RUST_ENGINE_ADDON and ${RUST_ADDON_SHA256_ENV}, so the runners load exactly the named addon`);
  }
  const pg = process.env.LIFECYCLE_PG_URL;
  if (engines.includes('postgres') && !pg) throw new Error('the postgres engine needs LIFECYCLE_PG_URL (a Postgres admin URL with pgvector)');
  if (paid) mkdirSync(cacheDir, { recursive: true });
  for (const s of selectSuites(argv)) {
    const jobs = [
      { label: s.id, category: s.category, script: s.script, live: paid && s.embedsLive === true, args: s.args, canonical: s.canonicalReceipt === true },
      ...(s.beside ? [{ label: s.beside.id, category: s.beside.category, script: s.beside.script, live: false, args: () => s.beside!.args, canonical: false }] : []),
    ];
    for (const job of jobs) for (const kind of engines) {
      const dir = engineDir(job.category, kind);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const env0 = job.live ? { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)), GBRAIN_EVAL_ENGINE: kind, ...(pg ? { LIFECYCLE_PG_URL: pg } : {}) } : runnerEnv(kind, pg);
      const env = { ...env0, [RUST_REFUSALS_FILE_ENV]: join(dir, REFUSAL_SITES) };
      const args = [job.script, '--gbrain', spec, ...job.args({ paid: job.live, cacheFile: job.live ? join(cacheDir, `${job.category}.sqlite`) : undefined, fillsCache: kind === 'pglite', budget })];
      const canonical = join(REPO, 'eval/reports', job.category, 'receipt.json');
      if (job.canonical) rmSync(canonical, { force: true });
      const t0 = Date.now();
      const { code, signal, tail } = await runChild(args, env, join(dir, 'run.log'));
      writeFileSync(join(dir, RUN_EXIT), `${JSON.stringify({ code, signal, gbrain: spec } satisfies RunExit)}\n`);
      if (code === EVAL_ENGINE_REFUSED_EXIT) writeFileSync(join(dir, 'refused.txt'), `${tail.split('\n').filter(l => l.startsWith('REFUSED')).at(-1) ?? tail.slice(-500)}\n`);
      if (job.canonical) {
        if (existsSync(canonical)) copyFileSync(canonical, join(dir, 'receipt.json'));
      }
      console.log(`${job.label} ${kind}: exit ${code ?? signal} in ${Math.round((Date.now() - t0) / 1000)}s`);
    }
  }
}

function emit(argv: readonly string[]): void {
  const out = flag(argv, '--out');
  if (!out) throw new Error('emit needs --out <dir>');
  mkdirSync(out, { recursive: true });
  for (const s of selectSuites(argv)) {
    const load = (category: string) => Object.fromEntries(EVAL_ENGINES.map(k => [k, loadRun(category, k)])) as Record<EvalEngineKind, EngineRun>;
    const file = judgeSuite(s, load(s.category), { counted: argv.includes('--counted') }, s.beside ? load(s.beside.category) : undefined);
    const path = join(out, `${s.id.replace(/\//g, '__')}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeScrubbedJson(path, file);
    console.log(`${s.id}: ${file.verdict}${file.reason ? ` (${file.reason.slice(0, 160)})` : ''}`);
  }
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const go = cmd === 'run' ? run(rest) : cmd === 'emit' ? Promise.resolve(emit(rest)) : Promise.reject(new Error('usage: gate-suites.ts run|emit ... (see the header)'));
  go.catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}

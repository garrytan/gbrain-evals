/**
 * engine-bench, gate suites: the gbrain-evals suites gbrain's docs/designs/RUST_ENGINE.md names in "Eval gates" E1 to E3
 * (all but LongMemEval recall, which is engine-bench's lme-recall stage), run on PGLite, Postgres and Rust at one gbrain
 * build, then one engine-bench.gate-suite/1 file per suite for eval-gates.json.
 *
 *   bun eval/runner/engine-bench/gate-suites.ts run --gbrain <checkout>@<sha> [--suites cat10,cat12] [--engines pglite,postgres,rust]
 *       [--paid --budget-run-id <id> --budget-usd <n> --embed-cache-dir <dir>]
 *   bun eval/runner/engine-bench/gate-suites.ts emit --out <dir> [--counted] [--suites ...]
 *
 * `run` starts each suite's runner once per engine with GBRAIN_EVAL_ENGINE set, LIFECYCLE_PG_URL for Postgres, and
 * GBRAIN_RUST_ENGINE_ADDON plus GBRAIN_RUST_ENGINE_ADDON_SHA256 (both required for rust, so the runner refuses any
 * other addon file). The child environment drops every provider key, except that `--paid` keeps them for the two
 * suites that embed live (Cat 13 and Cat 13b), which then run under the budget ledger with one embedding cache per
 * suite: the first engine fills it and the others read it only (a miss on Postgres or Rust makes the suite NOT_RUN).
 * Without `--paid` those two run on hash embeddings.
 * Receipts land at eval/reports/<category>/engine-<kind>/receipt.json, logs and refusals beside them.
 *
 * `emit` reads those receipts and writes <out>/<suite>.json. Rules, as RUST_ENGINE.md (gbrain 09b9ac5c) states them
 * and with our readings of it where the runner's denominator or metric differs (GBEV-3, 2026-11-23):
 *   all-pass         a count gate (Cat 10 133/133, Cat 12 24/24, Cat 4 100%, Cat 24 7/7, conformance 24/24, Cat 22 zero
 *                    leaks): Rust passes when its own run passes every case.
 *   at-least-both    a ranked metric (Cat 13 nDCG@5, Cat 13b top-1, Cats 1+2 P@5 and R@5 on graph-oracle-parse, Cat 3
 *                    R@5, type-accuracy strict and per-type F1): Rust's value is at least the PGLite and the Postgres value.
 *   within-or-equal  E3's "within 0.5 points or equal counts" (Cats 19, 27 and 23) against each TypeScript engine.
 *   reported         Cat 7: passes when it ran on every engine; every metric Rust loses is listed.
 * A suite is NOT_RUN when an engine has no completed receipt, refused, or ran another build or addon than the others.
 * A Rust error or failed run where both TypeScript engines completed is FAIL.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { EVAL_ENGINE_REFUSED_EXIT, EVAL_ENGINES, RUST_ADDON_SHA256_ENV, type EvalEngineKind } from '../eval-engine.ts';
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
  | { kind: 'all-pass'; counts: (r: Receipt) => { passed: number; total: number } }
  | { kind: 'at-least-both'; keys: string[] }
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
}

const scorecard = (r: Receipt, name: string) => (r.data?.scorecard ?? []).find((s: any) => s.name === name) ?? {};
const relational = (r: Receipt, adapter: string) => (r.data?.scorecards ?? []).find((s: any) => s.family === 'relational' && s.adapter === adapter) ?? {};
const passedOf = (r: Receipt) => ({ passed: (r.n_scored ?? 0) - (r.errors?.length ?? 0), total: r.n_total ?? 0 });
const stub = (paid: boolean) => (paid ? [] : ['--stub-embed']);

export const GATE_SUITES: readonly GateSuite[] = [
  {
    id: 'cat13/ndcg5', gate: 'E1', benchmark: 'Cat 13 conceptual search, gbrain arm, nDCG@5', category: 'cat13-conceptual', script: 'eval/runner/cat13-conceptual.ts',
    canonicalReceipt: true, embedsLive: true,
    args: o => ['--adapter', 'gbrain', ...stub(o.paid), ...(o.paid ? ['--embed-cache', o.cacheFile!, ...o.budget] : [])],
    measure: r => ({ ndcg5: scorecard(r, 'gbrain').ndcg5 }),
    rule: { kind: 'at-least-both', keys: ['ndcg5'] },
    reading: 'Threshold text kept; the paired lower bound of Rust minus each TypeScript engine is reported beside it as a secondary row (D24 style, not the gate).',
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
    measure: r => ({ passed: r.data?.behavioral?.passed, total: r.data?.behavioral?.total }),
    rule: { kind: 'all-pass', counts: r => ({ passed: r.data?.behavioral?.passed ?? 0, total: r.data?.behavioral?.total ?? 0 }) },
    reading: 'RUST_ENGINE.md says 50/50; the runner has 24 behavioural assertions, so the gate reads 24/24.',
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
    id: 'brainbench/cats-1-2', gate: 'E2', benchmark: 'BrainBench Cats 1+2 relational retrieval, graph on (multi-adapter graph-oracle-parse; gbrain product row beside it on hash embeddings)',
    category: 'multi-adapter', script: 'eval/runner/multi-adapter.ts', args: () => ['--stub-embed'],
    measure: r => {
      const g = relational(r, 'graph-oracle-parse'), p = relational(r, 'gbrain');
      return { p5: g.mean_precision_at_k, r5: g.mean_recall_at_k, product_p5_hash: p.mean_precision_at_k, product_r5_hash: p.mean_recall_at_k };
    },
    rule: { kind: 'at-least-both', keys: ['p5', 'r5'] },
    reading: 'The gate row is graph-oracle-parse (the row gbrain\'s research note cites); the gbrain product row is reported beside it, not gated.',
  },
  {
    id: 'brainbench/cat3', gate: 'E2', benchmark: 'Cat 3 alias lookup through keyword search, R@5', category: 'identity', script: 'eval/runner/identity.ts', args: () => [],
    measure: r => {
      const rows: any[] = r.data?.results ?? [];
      const r5 = (cat: string) => { const xs = rows.filter(x => x.category === cat); return xs.length ? xs.filter(x => x.found && x.rankPosition <= 5).length / xs.length : NaN; };
      return { r5_documented: r5('documented'), r5_undocumented: r5('undocumented') };
    },
    rule: { kind: 'at-least-both', keys: ['r5_documented', 'r5_undocumented'] },
    reading: 'Cat 3 has one relevant page per query, so it is gated on R@5 computed from its ranks (P@5 is R@5/5).',
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
    rule: { kind: 'at-least-both', keys: ['strict_f1'] },
    reading: 'type-accuracy has no P@5 or R@5; it is gated on strict F1 and on every per-type F1 of the links the engine stores.',
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
    measure: r => ({ brain_score: r.data?.achieved?.brain_score, gates_passed: passedOf(r).passed }),
    rule: { kind: 'within-or-equal', points: ['brain_score'], counts: ['gates_passed'] },
  },
  {
    id: 'cat27', gate: 'E3', benchmark: 'Cat 27 graph signals on', category: 'cat27-graph-signals', script: 'eval/runner/cat27-graph-signals.ts', args: () => [],
    measure: r => {
      const a = r.data?.aggregate ?? {};
      return { ndcg10_points: a.mean_ndcg10_with_signals * 100, top1_hits: Math.round(a.top1_hit_rate_with_signals * a.n_probes) };
    },
    rule: { kind: 'within-or-equal', points: ['ndcg10_points'], counts: ['top1_hits'] },
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

interface EngineRun { kind: EvalEngineKind; receipt: Receipt | null; refused: string | null }

function loadRun(s: GateSuite, kind: EvalEngineKind, reports?: string): EngineRun {
  const dir = engineDir(s.category, kind, reports);
  const refusedFile = join(dir, 'refused.txt');
  const receiptFile = join(dir, 'receipt.json');
  return {
    kind,
    receipt: existsSync(receiptFile) ? JSON.parse(readFileSync(receiptFile, 'utf8')) : null,
    refused: existsSync(refusedFile) ? readFileSync(refusedFile, 'utf8').trim() : null,
  };
}

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

/** Rust minus a TypeScript engine on Cat 13's per-probe nDCG@5: the paired interval (D24 style), a secondary row only. */
export function cat13PairedBound(rust: Receipt, ts: Receipt): { delta: number; lo: number | null; n: number; delta_threshold: number } {
  const byId = (r: Receipt) => new Map<string, number>((r.data?.per_query?.gbrain ?? []).map((q: any) => [q.id, q.ndcg5]));
  const a = byId(ts), b = byId(rust);
  const pairs = [...a.keys()].filter(id => b.has(id)).map(id => ({ id, cluster: id, a: a.get(id)!, b: b.get(id)! }));
  const d = clusteredPairedDelta(pairs, BOOTSTRAP);
  return { delta: d.delta, lo: d.ci95?.[0] ?? null, n: pairs.length, delta_threshold: RUST_RECALL_DELTA };
}

export interface GateSuiteFile {
  schema: typeof GATE_SUITE_SCHEMA;
  suite: string;
  gate: GateSuite['gate'];
  counted: boolean;
  gbrain: ReturnType<typeof buildOf> | null;
  verdict: 'PASS' | 'FAIL' | 'NOT_RUN';
  reason?: string;
  rows: { id: string; benchmark: string; verdict: 'PASS' | 'FAIL' | 'NOT_RUN'; measured: Record<string, Measured | null>; reason: string | null; secondary?: Record<string, unknown> }[];
  losses: { id: string; reason: string }[];
  amendment_text: string;
}

export function judgeSuite(s: GateSuite, runs: Record<EvalEngineKind, EngineRun>, o: { counted: boolean }): GateSuiteFile {
  const measured: Record<string, Measured | null> = {};
  for (const k of EVAL_ENGINES) measured[k] = completed(runs[k].receipt) ? s.measure(runs[k].receipt!) : null;
  const base = { schema: GATE_SUITE_SCHEMA, suite: s.id, gate: s.gate, counted: o.counted, amendment_text: amendmentLine(s) } as const;
  const notRun = (reason: string): GateSuiteFile => ({ ...base, gbrain: runs.rust.receipt ? buildOf(runs.rust.receipt) : null, verdict: 'NOT_RUN', reason, rows: [{ id: s.id, benchmark: s.benchmark, verdict: 'NOT_RUN', measured, reason }], losses: [] });

  for (const k of EVAL_ENGINES) if (runs[k].refused) return notRun(`${k} refused: ${runs[k].refused}`);
  for (const k of TS_ENGINES) if (!completed(runs[k].receipt)) return notRun(`${k} has no completed receipt (${runs[k].receipt?.run_status ?? 'missing'})`);
  if (!runs.rust.receipt) return notRun('rust has no receipt');
  const builds = EVAL_ENGINES.map(k => buildOf(runs[k].receipt!).overlay.commit);
  if (new Set(builds).size !== 1 || builds[0] === null) return notRun(`the engines ran different or unnamed gbrain builds (${builds.join(', ')})`);
  const gbrain = buildOf(runs.rust.receipt);
  if (!gbrain.rust_addon?.sha256) return notRun('the rust receipt names no addon digest');
  for (const k of ['postgres', 'rust'] as const) {
    const misses = runs[k].receipt?.resolved_config?.embed_cache?.stats?.misses;
    if (typeof misses === 'number' && misses > 0) return notRun(`${k} missed the shared embedding cache ${misses} times, so the engines did not see the same vectors`);
  }

  const losses: { id: string; reason: string }[] = [];
  const rust = runs.rust.receipt;
  if (!completed(rust)) losses.push({ id: s.id, reason: `Rust run did not complete (${rust.run_status}): ${(rust.errors ?? []).map((e: any) => e.message).join('; ').slice(0, 600)}` });
  else {
    const m = measured.rust!;
    const rule = s.rule;
    if (rule.kind === 'all-pass') {
      const c = rule.counts(rust);
      if (rust.verdict !== 'pass' || c.passed !== c.total) {
        const failing = (rust.errors ?? []).map((e: any) => `${e.probe_id}: ${String(e.message).slice(0, 200)}`);
        losses.push({ id: s.id, reason: `${c.passed}/${c.total} on Rust (verdict ${rust.verdict}). ${failing.join(' | ')}`.trim() });
      }
    } else if (rule.kind === 'at-least-both') {
      const keys = s.id === 'brainbench/type-accuracy' ? [...rule.keys, ...Object.keys(m).filter(k => k.startsWith('f1.'))] : rule.keys;
      for (const key of keys) for (const k of TS_ENGINES) {
        const ts = measured[k]![key];
        if (!(m[key] >= ts)) losses.push({ id: `${s.id}:${key}:vs-${k}`, reason: `Rust ${m[key]} < ${k} ${ts}` });
      }
    } else if (rule.kind === 'within-or-equal') {
      for (const k of TS_ENGINES) {
        for (const key of rule.points) if (!(Math.abs(m[key] - measured[k]![key]) <= 0.5)) losses.push({ id: `${s.id}:${key}:vs-${k}`, reason: `Rust ${m[key]} vs ${k} ${measured[k]![key]}: more than 0.5 points apart` });
        for (const key of rule.counts) if (m[key] !== measured[k]![key]) losses.push({ id: `${s.id}:${key}:vs-${k}`, reason: `Rust ${m[key]} vs ${k} ${measured[k]![key]}: counts differ` });
      }
    } else {
      for (const [key, v] of Object.entries(m)) for (const k of TS_ENGINES) {
        const ts = measured[k]![key];
        if (ts === undefined) continue;
        const worse = key.endsWith('ops_per_sec') ? v < ts : v > ts;
        if (worse) losses.push({ id: `${s.id}:${key}:vs-${k}`, reason: `Rust ${v.toFixed(3)} vs ${k} ${ts.toFixed(3)}` });
      }
    }
  }
  const failed = completed(rust) ? s.rule.kind !== 'reported' && losses.length > 0 : true;
  const verdict = failed ? 'FAIL' : 'PASS';
  const reason = failed ? losses.map(l => l.reason).join(' | ').slice(0, 1200) : null;
  const secondary = s.id === 'cat13/ndcg5' && completed(rust)
    ? Object.fromEntries(TS_ENGINES.map(k => [`rust_minus_${k}`, cat13PairedBound(rust, runs[k].receipt!)]))
    : undefined;
  return {
    ...base, gbrain, verdict, ...(reason ? { reason } : {}),
    rows: [{ id: s.id, benchmark: s.benchmark, verdict, measured, reason, ...(secondary ? { secondary } : {}) }],
    losses,
  };
}

export function amendmentLine(s: GateSuite): string {
  const rule = s.rule.kind === 'all-pass' ? 'Rust passes every case of its own run'
    : s.rule.kind === 'at-least-both' ? 'Rust is at least the PGLite and the Postgres value'
      : s.rule.kind === 'within-or-equal' ? 'Rust is within 0.5 points of, or equal in count to, each TypeScript engine'
        : 'reported: it ran on every engine and each metric Rust loses is listed';
  return `${s.id} (${s.gate}, ${s.benchmark}; ${s.script}): ${rule}.${s.reading ? ` Our reading of RUST_ENGINE.md at gbrain 09b9ac5c: ${s.reading}` : ''}`;
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

function runChild(args: string[], env: Record<string, string>, logPath: string): Promise<{ code: number | null; tail: string }> {
  return new Promise(res => {
    const log = createWriteStream(logPath);
    let tail = '';
    const keep = (b: Buffer) => { log.write(b); tail = (tail + b.toString('utf8')).slice(-4_000); };
    const child = spawn(process.execPath, args, { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', e => { tail += `\nspawn error: ${e.message}`; });
    child.on('close', code => { log.end(() => res({ code, tail })); });
  });
}

async function run(argv: readonly string[]): Promise<void> {
  const spec = gbrainSpecFrom(argv);
  if (!spec) throw new Error('run needs --gbrain <checkout>@<sha>, the one build every engine and suite measures');
  const engines = (flag(argv, '--engines')?.split(',') ?? [...EVAL_ENGINES]) as EvalEngineKind[];
  const paid = argv.includes('--paid');
  const budget = paid ? ['--budget-run-id', flag(argv, '--budget-run-id') ?? '', '--budget-usd', flag(argv, '--budget-usd') ?? ''] : [];
  if (paid && budget.includes('')) throw new Error('--paid needs --budget-run-id and --budget-usd');
  const cacheDir = paid ? resolve(flag(argv, '--embed-cache-dir') ?? '') : '';
  if (paid && !flag(argv, '--embed-cache-dir')) throw new Error('--paid needs --embed-cache-dir, so every engine reads the same vectors');
  if (engines.includes('rust') && (!process.env.GBRAIN_RUST_ENGINE_ADDON || !process.env[RUST_ADDON_SHA256_ENV])) {
    throw new Error(`the rust engine needs GBRAIN_RUST_ENGINE_ADDON and ${RUST_ADDON_SHA256_ENV}, so the runners load exactly the named addon`);
  }
  const pg = process.env.LIFECYCLE_PG_URL;
  if (engines.includes('postgres') && !pg) throw new Error('the postgres engine needs LIFECYCLE_PG_URL (a Postgres admin URL with pgvector)');
  if (paid) mkdirSync(cacheDir, { recursive: true });
  for (const s of selectSuites(argv)) {
    for (const [i, kind] of engines.entries()) {
      const dir = engineDir(s.category, kind);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const live = paid && s.embedsLive === true;
      const env = live ? { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)), GBRAIN_EVAL_ENGINE: kind, ...(pg ? { LIFECYCLE_PG_URL: pg } : {}) } : runnerEnv(kind, pg);
      const args = [s.script, '--gbrain', spec, ...s.args({ paid: live, cacheFile: live ? join(cacheDir, `${s.category}.sqlite`) : undefined, fillsCache: i === 0, budget })];
      const t0 = Date.now();
      const { code, tail } = await runChild(args, env, join(dir, 'run.log'));
      if (code === EVAL_ENGINE_REFUSED_EXIT) writeFileSync(join(dir, 'refused.txt'), `${tail.split('\n').filter(l => l.startsWith('REFUSED')).at(-1) ?? tail.slice(-500)}\n`);
      if (s.canonicalReceipt) {
        const canonical = join(REPO, 'eval/reports', s.category, 'receipt.json');
        if (existsSync(canonical)) copyFileSync(canonical, join(dir, 'receipt.json'));
      }
      console.log(`${s.id} ${kind}: exit ${code} in ${Math.round((Date.now() - t0) / 1000)}s`);
    }
  }
}

function emit(argv: readonly string[]): void {
  const out = flag(argv, '--out');
  if (!out) throw new Error('emit needs --out <dir>');
  mkdirSync(out, { recursive: true });
  for (const s of selectSuites(argv)) {
    const runs = Object.fromEntries(EVAL_ENGINES.map(k => [k, loadRun(s, k)])) as Record<EvalEngineKind, EngineRun>;
    const file = judgeSuite(s, runs, { counted: argv.includes('--counted') });
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

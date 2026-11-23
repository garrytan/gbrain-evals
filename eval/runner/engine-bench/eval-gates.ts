/**
 * engine-bench eval gates: one file, eval-gates.json, that answers gbrain's design plan for the Rust engine
 * (docs/designs/RUST_ENGINE.md, "Eval gates" E1 to E3 and "Swap readiness" criterion 8) from one wave's stage receipts.
 *
 * Each gate carries the plan's threshold as it is written, a verdict (PASS, FAIL or NOT_RUN), what was measured, one
 * row per benchmark the gate names, and the rows that lost. engine-bench runs only part of the gates: E1's LongMemEval-S
 * rows come from stage 3 (lme-recall.ts), scored by the D24 rule that stage applies (the 95% paired lower bound of
 * Rust minus each TypeScript engine at least -0.018 at N = 470, identical top-5 ids counted as ties). Every other row
 * names a benchmark engine-bench does not run, so it is NOT_RUN with that reason. A gate passes only when every gating
 * row passes, fails when any gating row fails, and is NOT_RUN otherwise.
 *
 * Criterion 8 (paired speed, reported and never a gate) comes from the speed stage (perf.ts): for each operation class,
 * quantile and TypeScript engine, Rust is worse when the 95% paired interval of its latency ratio lies above 1, better
 * when it lies below 1, and not shown either way otherwise; a class with fewer than 100 pairs, or one Rust refused, is
 * never counted as no worse.
 *
 * `status` is FINAL only for a counted wave on a gbrain release tag (no -rc), with every input counted and on one gbrain
 * commit and one Rust addon digest; a FINAL file is written once, at eval/results/engine-bench/eval-gates/<tag>/
 * <evals commit>.json, and never rewritten (a correction is a new file). Every release-candidate or branch build is
 * PROVISIONAL (--provisional): development receipts are allowed, `gbrain_tag` is left out, and the file is refused
 * anywhere under eval/results, because provisional files never go on main. `rust_addon_sha256` is the digest the
 * receipts recorded for the addon bytes they loaded, the CI artifact as downloaded.
 *
 *   bun eval/runner/engine-bench/eval-gates.ts [--out <eval-gates.json>] [--provisional]
 *     [--answers <lme-recall receipt or aggregate>] [--speed <speed receipt>] [--correctness <receipt>]
 *     [--surface-parity <receipt>] [--receipt <other receipt>]... [--engine-format-version <n>]
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeScrubbedJson } from '../receipt.ts';
import { PAIRED_OPS } from './perf.ts';

export const EVAL_GATES_SCHEMA_VERSION = 'engine-bench.eval-gates/1';
export const DESIGN_SOURCE = 'docs/designs/RUST_ENGINE.md at garrytan/gbrain 09b9ac5c, "Eval gates" and "Swap readiness"';
export const MIN_PAIRS = 100;
/** Stage 3's scored questions: the 500 LongMemEval-S questions less the 30 abstention ones. D24's -0.018 is defined at this N. */
export const PLANNED_N = 470;
export const TARGET = 'linux-x64-glibc';
export const FINAL_DIR = 'eval/results/engine-bench/eval-gates';
const RELEASE_TAG = /^v\d+(\.\d+)+$/;
const REPO_ROOT = resolve(import.meta.dir, '../../..');
const ANSWERS_SCHEMA = 'engine-bench.lme-recall/3';
const ARMS = ['keyword', 'vector', 'hybrid'] as const;
const TS_ENGINES = ['pglite', 'postgres'] as const;

export type GateVerdict = 'PASS' | 'FAIL' | 'NOT_RUN';
export interface GateRow { id: string; benchmark: string; gating: boolean; verdict: GateVerdict; reason?: string; measured?: Record<string, unknown> }
export interface Gate { verdict: GateVerdict; threshold: string; measured: unknown; rows: GateRow[]; losses: Array<{ id: string; reason: string }> }

const NOT_IN_ENGINE_BENCH = 'engine-bench does not run this benchmark';
const notRun = (id: string, benchmark: string, gating = true, reason = NOT_IN_ENGINE_BENCH): GateRow => ({ id, benchmark, gating, verdict: 'NOT_RUN', reason });

export const THRESHOLDS = {
  E1: 'R@5 per adapter at least both the PGLite and the Postgres value, per-question top-5 differences listed; Cat 13 nDCG@5 and Cat 13b top-1 at least both values; Cat 10 133/133; Cat 12 50/50; Cat 7 reported. For ranked-search recall, "at least both" is D24: the 95% paired lower bound against each TypeScript engine is at least -0.018 (N = 470); identical top-k ids count as exact ties; the point estimate is reported and does not gate.',
  E2: 'P@5 and R@5 at least both the PGLite and the Postgres value; Cat 4 100%; Cat 24 5/5; conformance 24/24',
  E3: 'Cat 22 zero leaks; others within 0.5 points or equal counts',
  criterion_8: 'In paired bench samples (at least 100 pairs each, with confidence intervals), Rust p50 and p99 are no worse than the primary\'s on every operation class, and better on filtered vector search by the margin D14 sets. Measured and reported, not gating (D23).',
} as const;

interface Comparison {
  arm: string; a: string; b: string; n_questions: number;
  rust_errors?: string[]; rust_verdict?: 'pass' | 'fail' | 'unmeasured'; rust_point_estimate?: number | null;
  rust_secondary?: Record<string, string>; exact_ties?: number;
  recall_all_delta: { n_pairs: number; delta: number; ci95: [number, number] | null } | null;
  differences?: unknown[];
}

const VERDICT: Record<string, GateVerdict> = { pass: 'PASS', fail: 'FAIL', unmeasured: 'NOT_RUN' };

/** E1's LongMemEval-S rows: one per arm and TypeScript engine, from stage 3's Rust comparisons. */
export function answersRows(answers: { comparisons?: Comparison[] } | null): GateRow[] {
  return ARMS.flatMap(arm => TS_ENGINES.map((engine): GateRow => {
    const id = `lme-s/${arm}/vs-${engine}`;
    const benchmark = `LongMemEval-S recall_all@5, ${arm} arm, Rust against ${engine}`;
    if (!answers) return notRun(id, benchmark, true, 'no answers-stage receipt was given');
    const c = answers.comparisons?.find(x => x.arm === arm && ((x.a === 'rust' && x.b === engine) || (x.b === 'rust' && x.a === engine)));
    if (!c || !c.rust_verdict) return notRun(id, benchmark, true, `the answers stage has no Rust comparison against ${engine} on the ${arm} arm`);
    const d = c.recall_all_delta;
    const rustIsB = c.b === 'rust';
    const lower = d?.ci95 ? (rustIsB ? d.ci95[0] : 0 - d.ci95[1]) : null;
    const measured = {
      point_estimate: c.rust_point_estimate ?? null, lower_bound_95: lower, n: d?.n_pairs ?? 0, exact_ties: c.exact_ties ?? null,
      rust_errors: c.rust_errors?.length ?? 0, top5_differences: c.differences?.length ?? null, secondary: c.rust_secondary ?? null,
    };
    const errored = (c.rust_errors?.length ?? 0) > 0;
    const short = !errored && (d?.n_pairs ?? 0) < PLANNED_N;
    const verdict = short ? 'NOT_RUN' : VERDICT[c.rust_verdict];
    const reason = errored ? `Rust errored on ${c.rust_errors!.length} question(s) ${engine} answered`
      : short ? `measured on ${d?.n_pairs ?? 0} scored questions; the gate is defined at N = ${PLANNED_N}`
      : verdict === 'FAIL' ? `95% lower bound ${lower?.toFixed(4)} is below -0.018` : undefined;
    return { id, benchmark, gating: true, verdict, ...(reason ? { reason } : {}), measured };
  }));
}

function gate(threshold: string, rows: GateRow[], measured: unknown): Gate {
  const gating = rows.filter(r => r.gating);
  const verdict: GateVerdict = gating.some(r => r.verdict === 'FAIL') ? 'FAIL' : gating.length > 0 && gating.every(r => r.verdict === 'PASS') ? 'PASS' : 'NOT_RUN';
  return { verdict, threshold, measured, rows, losses: rows.filter(r => r.verdict === 'FAIL').map(r => ({ id: r.id, reason: r.reason ?? 'failed' })) };
}

export function evalGates(answers: { comparisons?: Comparison[] } | null): Record<'E1' | 'E2' | 'E3', Gate> {
  const lme = answersRows(answers);
  const e1 = [
    ...lme,
    notRun('cat13/ndcg5', 'gbrain-evals Cat 13 nDCG@5 at least both values'),
    notRun('cat13b/top1', 'gbrain-evals Cat 13b top-1 at least both values'),
    notRun('cat10', 'gbrain-evals Cat 10 133/133'),
    notRun('cat12', 'gbrain-evals Cat 12 50/50'),
    notRun('cat7', 'gbrain-evals Cat 7, reported', false),
  ];
  const e2 = [
    notRun('brainbench/cats-1-2', 'BrainBench Cats 1+2 (graph on), P@5 and R@5 at least both values'),
    notRun('brainbench/cat3', 'BrainBench Cat 3, P@5 and R@5 at least both values'),
    notRun('brainbench/cat4', 'BrainBench Cat 4 100%'),
    notRun('brainbench/type-accuracy', 'type-accuracy, at least both values'),
    notRun('brainbench/cat24', 'Cat 24 5/5'),
    notRun('memory-verb-conformance', 'memory-verb conformance 24/24'),
  ];
  const e3 = [
    notRun('cat22', 'Cat 22 zero leaks'),
    notRun('cat19', 'Cat 19 within 0.5 points or equal counts'),
    notRun('cat27', 'Cat 27 within 0.5 points or equal counts'),
    notRun('cat23', 'Cat 23 within 0.5 points or equal counts (scored against PGLite pg_trgm behavior)'),
  ];
  return {
    E1: gate(THRESHOLDS.E1, e1, lme.filter(r => r.measured).map(r => ({ id: r.id, ...r.measured }))),
    E2: gate(THRESHOLDS.E2, e2, null),
    E3: gate(THRESHOLDS.E3, e3, null),
  };
}

type Ratio = { ratio: number; ci95: [number, number] | null };
type SpeedPair = { reference: string; other: string; latency?: Record<string, { n: number; p50_ratio: Ratio; p99_ratio: Ratio }>; missing?: unknown };
export type ClassStatus = 'better' | 'worse' | 'not_shown' | 'too_few_pairs' | 'missing';

/** Criterion 8 from the speed stage: every operation class and quantile, Rust against each TypeScript engine. */
export function criterion8(speed: { pairs?: Record<string, SpeedPair>; core_ops?: string[]; speed?: { verdict?: string } } | null, ops: readonly string[]) {
  const pairs = Object.values(speed?.pairs ?? {}).filter(p => p.other === 'rust' && (TS_ENGINES as readonly string[]).includes(p.reference));
  if (!speed || pairs.length === 0) return { gating: false, threshold: THRESHOLDS.criterion_8, verdict: 'not_run' as const, reason: speed ? 'the speed stage has no Rust pair' : 'no speed-stage receipt was given', rows: [], losing_classes: [], unmeasured_classes: [] };
  const rows = pairs.flatMap(p => ops.flatMap(op => (['p50', 'p99'] as const).map(quantile => {
    const l = p.latency?.[op];
    const r = l?.[`${quantile}_ratio`];
    const status: ClassStatus = !l ? 'missing' : l.n < MIN_PAIRS || !r?.ci95 ? 'too_few_pairs' : r.ci95[0] > 1 ? 'worse' : r.ci95[1] < 1 ? 'better' : 'not_shown';
    return { op, quantile, against: p.reference, n_pairs: l?.n ?? 0, ratio: r?.ratio ?? null, ci95: r?.ci95 ?? null, status };
  })));
  const named = (s: ClassStatus[]) => [...new Set(rows.filter(r => s.includes(r.status)).map(r => `${r.op} ${r.quantile} vs ${r.against}`))];
  const losing = named(['worse']);
  const unmeasured = named(['missing', 'too_few_pairs']);
  return {
    gating: false, threshold: THRESHOLDS.criterion_8,
    verdict: losing.length ? 'some_class_worse' as const : unmeasured.length ? 'incomplete' as const : 'no_class_worse' as const,
    filtered_vector_margin: 'not set: the design plan leaves D14\'s margin for filtered vector search open, so its ratio and interval are reported without one',
    speed_stage_verdict: speed.speed?.verdict ?? null,
    rows, losing_classes: losing, unmeasured_classes: unmeasured,
  };
}

interface Identity { commit: string | null; ref: string | null; addon: string | null; target: string | null; counted: boolean | null }
function identityOf(r: any): Identity {
  const overlay = r?.gbrain?.overlay;
  return {
    commit: overlay?.commit ?? r?.gbrain?.product?.loaded_git_head ?? null,
    ref: overlay?.ref ?? null,
    addon: r?.gbrain?.rust_addon?.sha256 ?? null,
    target: r?.gbrain?.rust_addon?.target ?? null,
    counted: typeof r?.counted === 'boolean' ? r.counted : null,
  };
}

export interface EvalGatesInput { path: string; role: 'answers' | 'speed' | 'correctness' | 'surface-parity' | 'receipt'; json: any; sha256: string }

export function buildEvalGates(inputs: EvalGatesInput[], o: { provisional: boolean; evalsCommit: string; engineFormatVersion: string | null; generatedAt: string; ops: readonly string[] }) {
  if (inputs.length === 0) throw new Error('eval-gates needs at least one stage receipt');
  const answers = inputs.find(i => i.role === 'answers')?.json ?? null;
  if (answers && answers.schema !== ANSWERS_SCHEMA) throw new Error(`the answers receipt is ${answers.schema}; eval-gates reads ${ANSWERS_SCHEMA}, the schema that applies the D24 rule`);
  const ids = inputs.map(i => ({ path: i.path, ...identityOf(i.json) }));
  const one = (k: 'commit' | 'addon') => {
    const seen = [...new Set(ids.map(x => x[k]).filter((v): v is string => !!v))];
    if (seen.length > 1) throw new Error(`stage receipts disagree on the gbrain ${k === 'commit' ? 'commit' : 'Rust addon digest'}: ${ids.filter(x => x[k]).map(x => `${x.path}=${x[k]}`).join(', ')}`);
    return seen[0] ?? null;
  };
  const commit = one('commit');
  const addon = one('addon');
  if (!o.provisional) {
    if (!commit) throw new Error('no stage receipt names its gbrain commit; a counted eval-gates file needs one');
    if (!addon) throw new Error('no stage receipt records the Rust addon digest; a counted eval-gates file needs one');
    const dev = ids.filter(x => x.counted !== true && inputs.find(i => i.path === x.path)!.role !== 'receipt');
    if (dev.length) throw new Error(`not counted: ${dev.map(x => x.path).join(', ')}; pass --provisional for development receipts`);
    const blank = ids.filter(x => (!x.commit || !x.addon) && inputs.find(i => i.path === x.path)!.role !== 'receipt');
    if (blank.length) throw new Error(`every counted stage receipt must name its own gbrain commit and Rust addon digest; missing in ${blank.map(x => x.path).join(', ')}`);
  }
  const targets = [...new Set(ids.map(x => x.target).filter(Boolean))];
  if (targets.some(t => t !== TARGET)) throw new Error(`the Rust addon target is ${targets.join(', ')}; eval-gates covers ${TARGET} only`);
  const tag = ids.map(x => x.ref).find(r => r && RELEASE_TAG.test(r)) ?? null;
  if (!o.provisional && !tag) throw new Error(`no stage receipt ran a gbrain release tag (vX.Y.Z, no -rc; saw ${[...new Set(ids.map(x => x.ref))].join(', ')}); a release candidate or branch build is --provisional`);
  return {
    schema_version: EVAL_GATES_SCHEMA_VERSION,
    status: o.provisional ? 'PROVISIONAL' as const : 'FINAL' as const,
    provisional: o.provisional,
    ...(o.provisional ? { provisional_note: 'Built from development receipts of a build that is not a gbrain release; a diagnostic, not a result.' } : {}),
    gbrain_commit: commit,
    ...(o.provisional ? {} : { gbrain_tag: tag }),
    target: TARGET,
    rust_addon_sha256: addon,
    engine_format_version: o.engineFormatVersion,
    evals_commit: o.evalsCommit,
    generated_at: o.generatedAt,
    design_source: DESIGN_SOURCE,
    gates: evalGates(answers),
    swap_readiness_criterion_8: criterion8(inputs.find(i => i.role === 'speed')?.json ?? null, o.ops),
    receipt_links: inputs.map(i => ({ role: i.role, path: i.path, sha256: i.sha256 })),
  };
}

/** Where a file goes: a FINAL file at its one path on main, never over an existing file; a PROVISIONAL file anywhere outside eval/results. */
export function outputPath(file: { status: 'PROVISIONAL' | 'FINAL'; gbrain_tag?: string | null; evals_commit: string }, out: string | undefined, repoRoot = REPO_ROOT): string {
  const results = resolve(repoRoot, 'eval/results');
  if (file.status === 'FINAL') {
    const path = resolve(repoRoot, FINAL_DIR, file.gbrain_tag!, `${file.evals_commit}.json`);
    if (out && resolve(out) !== path) throw new Error(`a FINAL file goes to ${relative(repoRoot, path)}, not ${out}`);
    if (existsSync(path)) throw new Error(`${relative(repoRoot, path)} exists and is never rewritten; a correction is a new file from a new evals commit`);
    return path;
  }
  if (!out) throw new Error('a PROVISIONAL file needs --out, outside eval/results');
  const abs = resolve(out);
  if (abs === results || abs.startsWith(results + sep)) throw new Error('provisional files never go on main: write it outside eval/results');
  return abs;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const values = (name: string) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));
  const out = values('--out')[0];
  if (argv.length === 0) { process.stderr.write('usage: bun eval/runner/engine-bench/eval-gates.ts [--out <file>] [--provisional] [--answers f] [--speed f] [--correctness f] [--surface-parity f] [--receipt f]... [--engine-format-version n]\n'); return 2; }
  const roles = ['answers', 'speed', 'correctness', 'surface-parity', 'receipt'] as const;
  const inputs: EvalGatesInput[] = roles.flatMap(role => values(`--${role}`).map(p => {
    const bytes = readFileSync(p);
    const abs = resolve(p);
    const rel = relative(REPO_ROOT, abs);
    return { role, path: rel.startsWith('..') ? abs : rel, json: JSON.parse(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
  const evalsCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim();
  const file = buildEvalGates(inputs, { provisional: argv.includes('--provisional'), evalsCommit, engineFormatVersion: values('--engine-format-version')[0] ?? null, generatedAt: new Date().toISOString(), ops: PAIRED_OPS });
  writeScrubbedJson(outputPath(file, out), file);
  process.stdout.write(`E1 ${file.gates.E1.verdict}, E2 ${file.gates.E2.verdict}, E3 ${file.gates.E3.verdict}; criterion 8 ${file.swap_readiness_criterion_8.verdict}\n`);
  return 0;
}

if (import.meta.main) process.exit(main());

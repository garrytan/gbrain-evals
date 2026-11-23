/**
 * engine-bench eval gates: one file, eval-gates.json, that answers gbrain's design plan for the Rust engine
 * (docs/designs/RUST_ENGINE.md, "Eval gates" E1 to E3 and "Swap readiness" criterion 8) from one wave's stage receipts.
 *
 * Each gate carries the plan's threshold as it is written, a verdict (PASS, FAIL or NOT_RUN), what was measured, one
 * row per benchmark the gate names, and the rows that lost. E1's LongMemEval-S rows come from stage 3 (lme-recall.ts),
 * scored by the D24 rule that stage applies (the 95% paired lower bound of Rust minus each TypeScript engine at least
 * -0.018 at N = 470, identical top-5 ids counted as ties). Every other row comes from that suite's
 * engine-bench.gate-suite/1 file (gate-suites.ts emit), passed with --suite: the suite's verdict, its own rows (a strict
 * or reported-beside row next to the gate row) and its losses, read as that file states them. A suite with no file is
 * NOT_RUN. Cat 7 is reported, and Cat 13 is reported, not gating, for Dec 1 (plan D24), so neither decides its gate. A
 * gate passes only when every gating row passes, fails when any gating row fails, and is NOT_RUN otherwise.
 *
 * Criterion 8 (paired speed, reported and never a gate) comes from the speed stage (perf.ts): for each operation class,
 * quantile and TypeScript engine, Rust is worse when the 95% paired interval of its latency ratio lies above 1, better
 * when it lies below 1, and not shown either way otherwise; a class with fewer than 100 pairs, or one Rust refused, is
 * never counted as no worse.
 *
 * `status` is FINAL only for a counted wave on a gbrain release tag (no -rc) that garrytan/gbrain publishes and that
 * peels to the receipts' commit, with every input counted and on one gbrain commit and one Rust addon digest; a FINAL file is written once, at eval/results/engine-bench/eval-gates/<tag>/
 * <evals commit>.json, and never rewritten (a correction is a new file). Every release-candidate or branch build is
 * PROVISIONAL (--provisional): development receipts are allowed, `gbrain_tag` is left out, and the file is refused
 * anywhere under eval/results, because provisional files never go on main. `rust_addon_sha256` is the digest the
 * receipts recorded for the addon bytes they loaded, the CI artifact as downloaded.
 *
 *   bun eval/runner/engine-bench/eval-gates.ts [--out <eval-gates.json>] [--provisional]
 *     [--answers <lme-recall receipt or aggregate>] [--speed <speed receipt>] [--correctness <receipt>]
 *     [--surface-parity <receipt>] [--suite <gate-suite file>]... [--receipt <other receipt>]... [--engine-format-version <n>]
 */

import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
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
export const GBRAIN_REMOTE = 'https://github.com/garrytan/gbrain.git';
const GATE_SUITE_SCHEMA = 'engine-bench.gate-suite/1';
const REPO_ROOT = resolve(import.meta.dir, '../../..');
const ANSWERS_SCHEMA = 'engine-bench.lme-recall/3';
const ARMS = ['keyword', 'vector', 'hybrid'] as const;
const TS_ENGINES = ['pglite', 'postgres'] as const;

export type GateVerdict = 'PASS' | 'FAIL' | 'NOT_RUN';
type Loss = { id: string; reason: string };
export interface GateRow { id: string; benchmark: string; gating: boolean; verdict: GateVerdict; reason?: string; measured?: Record<string, unknown>; reading?: string; losses?: Loss[] }
export interface Gate { verdict: GateVerdict; threshold: string; measured: unknown; rows: GateRow[]; losses: Array<Loss & { gating: boolean }> }

const NO_SUITE_FILE = 'no gate-suite file was given for this suite';
const notRun = (id: string, benchmark: string, gating = true, reason = NO_SUITE_FILE): GateRow => ({ id, benchmark, gating, verdict: 'NOT_RUN', reason });

/** The suites each gate names, beside E1's LongMemEval-S rows, in the plan's order; `gating: false` rows are reported. */
export const SUITES: Record<'E1' | 'E2' | 'E3', Array<{ id: string; benchmark: string; gating: boolean }>> = {
  E1: [
    { id: 'cat13/ndcg5', benchmark: 'gbrain-evals Cat 13 nDCG@5 at least both values; reported, not gating, for Dec 1 (plan D24)', gating: false },
    { id: 'cat13b/top1', benchmark: 'gbrain-evals Cat 13b top-1 at least both values', gating: true },
    { id: 'cat10', benchmark: 'gbrain-evals Cat 10 133/133', gating: true },
    { id: 'cat12', benchmark: 'gbrain-evals Cat 12 50/50', gating: true },
    { id: 'cat7', benchmark: 'gbrain-evals Cat 7, reported', gating: false },
  ],
  E2: [
    { id: 'brainbench/cats-1-2', benchmark: 'BrainBench Cats 1+2 (graph on), P@5 and R@5 at least both values', gating: true },
    { id: 'brainbench/cat3', benchmark: 'BrainBench Cat 3, P@5 and R@5 at least both values', gating: true },
    { id: 'brainbench/cat4', benchmark: 'BrainBench Cat 4 100%', gating: true },
    { id: 'brainbench/type-accuracy', benchmark: 'type-accuracy, at least both values', gating: true },
    { id: 'brainbench/cat24', benchmark: 'Cat 24 5/5', gating: true },
    { id: 'memory-verb-conformance', benchmark: 'memory-verb conformance 24/24', gating: true },
  ],
  E3: [
    { id: 'cat22', benchmark: 'Cat 22 zero leaks', gating: true },
    { id: 'cat19', benchmark: 'Cat 19 within 0.5 points or equal counts', gating: true },
    { id: 'cat27', benchmark: 'Cat 27 within 0.5 points or equal counts', gating: true },
    { id: 'cat23', benchmark: 'Cat 23 within 0.5 points or equal counts (scored against PGLite pg_trgm behavior)', gating: true },
  ],
};

interface SuiteFile {
  schema: string; suite: string; gate: string; counted: boolean; verdict: GateVerdict; reason?: string | null; amendment_text?: string;
  gbrain: unknown; losses: Loss[];
  rows: Array<{ id: string; benchmark: string; verdict: GateVerdict; reason?: string | null; measured?: Record<string, unknown>; secondary?: unknown; divergences?: unknown }>;
}

/** One suite's rows: its gate row, decided by the suite's verdict and carrying its losses, then the rows it reports beside it, which never gate. */
function suiteRows(def: { id: string; benchmark: string; gating: boolean }, file: SuiteFile | undefined): GateRow[] {
  if (!file) return [notRun(def.id, def.benchmark, def.gating)];
  return file.rows.map((r): GateRow => {
    const main = r.id === def.id;
    const measured = { ...(r.measured ?? {}), ...(r.secondary ? { secondary: r.secondary } : {}), ...(r.divergences ? { divergences: r.divergences } : {}) };
    const verdict = main ? file.verdict : r.verdict;
    const losses = main ? file.losses : verdict === 'FAIL' && !file.losses.some(l => l.id.startsWith(r.id)) ? [{ id: r.id, reason: r.reason ?? 'failed' }] : [];
    return { id: r.id, benchmark: main ? def.benchmark : r.benchmark, gating: main && def.gating, verdict, ...(r.reason ? { reason: r.reason } : {}), measured, ...(main && file.amendment_text ? { reading: file.amendment_text } : {}), losses };
  });
}

/** Reads each --suite file against SUITES: one file per suite, at the gate the plan puts it under, with its gate row. */
export function readSuites(files: Array<{ path: string; json: any }>): Map<string, SuiteFile> {
  const out = new Map<string, SuiteFile>();
  for (const { path, json } of files) {
    if (json?.schema !== GATE_SUITE_SCHEMA) throw new Error(`${path} is ${json?.schema ?? 'not a gate-suite file'}; --suite reads ${GATE_SUITE_SCHEMA}`);
    const gate = (Object.keys(SUITES) as Array<keyof typeof SUITES>).find(g => SUITES[g].some(d => d.id === json.suite));
    if (!gate) throw new Error(`${path}: suite ${json.suite} is not one the design plan's gates name`);
    if (json.gate !== gate) throw new Error(`${path}: suite ${json.suite} says gate ${json.gate}; the plan puts it under ${gate}`);
    if (out.has(json.suite)) throw new Error(`more than one --suite file for ${json.suite}`);
    if (!Array.isArray(json.rows) || !json.rows.some((r: any) => r.id === json.suite)) throw new Error(`${path}: no row for its own suite ${json.suite}`);
    if (!Array.isArray(json.losses)) throw new Error(`${path}: no losses list`);
    if (!json.gbrain && json.verdict !== 'NOT_RUN') throw new Error(`${path}: a ${json.verdict} suite must name the gbrain build it ran`);
    out.set(json.suite, json);
  }
  return out;
}

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
      rust_errors: c.rust_errors?.length ?? 0, top5_differences: c.differences?.length ?? null, top5_difference_list: c.differences ?? null, secondary: c.rust_secondary ?? null,
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
  const losses = rows.flatMap(r => (r.losses ?? (r.verdict === 'FAIL' ? [{ id: r.id, reason: r.reason ?? 'failed' }] : [])).map(l => ({ ...l, gating: r.gating })));
  return { verdict, threshold, measured, rows, losses };
}

export function evalGates(answers: { comparisons?: Comparison[] } | null, suites: Map<string, SuiteFile> = new Map()): Record<'E1' | 'E2' | 'E3', Gate> {
  const lme = answersRows(answers);
  const rows = (g: keyof typeof SUITES) => SUITES[g].flatMap(d => suiteRows(d, suites.get(d.id)));
  return {
    E1: gate(THRESHOLDS.E1, [...lme, ...rows('E1')], lme.filter(r => r.measured).map(r => ({ id: r.id, ...r.measured }))),
    E2: gate(THRESHOLDS.E2, rows('E2'), null),
    E3: gate(THRESHOLDS.E3, rows('E3'), null),
  };
}

type Ratio = { ratio: number; ci95: [number, number] | null };
type SpeedPair = { reference: string; other: string; latency?: Record<string, { n: number; p50_ratio: Ratio; p99_ratio: Ratio }>; missing?: unknown };
export type ClassStatus = 'better' | 'worse' | 'not_shown' | 'too_few_pairs' | 'missing';

/** Criterion 8 from the speed stage: every operation class and quantile, Rust against each TypeScript engine. */
export function criterion8(speed: { pairs?: Record<string, SpeedPair>; core_ops?: string[]; speed?: { verdict?: string } } | null, ops: readonly string[]) {
  const found = Object.values(speed?.pairs ?? {}).filter(p => p.other === 'rust' && (TS_ENGINES as readonly string[]).includes(p.reference));
  const pairs = TS_ENGINES.map((reference): SpeedPair => found.find(p => p.reference === reference) ?? { reference, other: 'rust' });
  if (!speed || found.length === 0) return { gating: false, threshold: THRESHOLDS.criterion_8, verdict: 'not_run' as const, reason: speed ? 'the speed stage has no Rust pair' : 'no speed-stage receipt was given', rows: [], losing_classes: [], unmeasured_classes: [] };
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

interface Identity { commit: string | null; ref: string | null; addon: string | null; target: string | null; counted: boolean | null; dirty: boolean }
function identityOf(r: any): Identity {
  const overlay = r?.gbrain?.overlay;
  return {
    dirty: overlay?.checkout_dirty === true,
    commit: overlay?.commit ?? r?.gbrain?.product?.loaded_git_head ?? null,
    ref: overlay?.ref ?? null,
    addon: r?.gbrain?.rust_addon?.sha256 ?? null,
    target: r?.gbrain?.rust_addon?.target ?? null,
    counted: typeof r?.counted === 'boolean' ? r.counted : null,
  };
}

export interface EvalGatesInput { path: string; role: 'answers' | 'speed' | 'correctness' | 'surface-parity' | 'suite' | 'receipt'; json: any; sha256: string }

/** The commit a tag on garrytan/gbrain peels to (an annotated tag's target, else the tag itself), or null when the remote has no such tag. */
export function peelReleaseTag(tag: string): string | null {
  const r = spawnSync('git', ['ls-remote', GBRAIN_REMOTE, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw new Error(`could not read gbrain's tags from ${GBRAIN_REMOTE}: ${(r.stderr || r.error?.message || '').trim()}`);
  const lines = r.stdout.trim().split('\n').filter(Boolean).map(l => l.split('\t'));
  return (lines.find(([, ref]) => ref === `refs/tags/${tag}^{}`) ?? lines.find(([, ref]) => ref === `refs/tags/${tag}`))?.[0] ?? null;
}

export function buildEvalGates(inputs: EvalGatesInput[], o: { provisional: boolean; evalsCommit: string; engineFormatVersion: string | null; generatedAt: string; ops: readonly string[]; peelTag?: (tag: string) => string | null }) {
  const suites = readSuites(inputs.filter(i => i.role === 'suite'));
  const unbuilt = inputs.filter(i => i.role === 'suite' && !i.json.gbrain);
  const stages = inputs.filter(i => i.role !== 'receipt' && !unbuilt.includes(i));
  if (stages.length === 0 && unbuilt.length === 0) throw new Error('eval-gates needs at least one stage receipt or gate-suite file; --receipt files are links only');
  for (const role of ['answers', 'speed'] as const) if (stages.filter(i => i.role === role).length > 1) throw new Error(`more than one --${role} receipt; pass the one ${role === 'answers' ? 'aggregate' : 'receipt'} the stage produced`);
  const answers = inputs.find(i => i.role === 'answers')?.json ?? null;
  if (answers && answers.schema !== ANSWERS_SCHEMA) throw new Error(`the answers receipt is ${answers.schema}; eval-gates reads ${ANSWERS_SCHEMA}, the schema that applies the D24 rule`);
  const ids = stages.map(i => ({ path: i.path, ...identityOf(i.json) }));
  const one = (k: 'commit' | 'addon') => {
    const seen = [...new Set(ids.map(x => x[k]).filter((v): v is string => !!v))];
    if (seen.length > 1) throw new Error(`stage receipts disagree on the gbrain ${k === 'commit' ? 'commit' : 'Rust addon digest'}: ${ids.filter(x => x[k]).map(x => `${x.path}=${x[k]}`).join(', ')}`);
    return seen[0] ?? null;
  };
  const commit = one('commit');
  const addon = one('addon');
  const targets = [...new Set(ids.map(x => x.target).filter(Boolean))];
  if (targets.some(t => t !== TARGET)) throw new Error(`the Rust addon target is ${targets.join(', ')}; eval-gates covers ${TARGET} only`);
  if (!o.provisional) {
    if (!commit) throw new Error('no stage receipt names its gbrain commit; a counted eval-gates file needs one');
    if (!addon) throw new Error('no stage receipt records the Rust addon digest; a counted eval-gates file needs one');
    const dev = [...ids, ...unbuilt.map(i => ({ path: i.path, counted: i.json.counted }))].filter(x => x.counted !== true);
    if (dev.length) throw new Error(`not counted: ${dev.map(x => x.path).join(', ')}; pass --provisional for development receipts`);
    const blank = ids.filter(x => !x.commit || !x.addon || x.target !== TARGET);
    if (blank.length) throw new Error(`every counted stage receipt must name its own gbrain commit and Rust addon digest for ${TARGET}; missing in ${blank.map(x => x.path).join(', ')}`);
    const dirty = ids.filter(x => x.dirty);
    if (dirty.length) throw new Error(`ran from a gbrain checkout with uncommitted changes: ${dirty.map(x => x.path).join(', ')}`);
    if (answers && answers.dataset?.matches_published_sha256 !== true) throw new Error('the answers receipt does not record the published LongMemEval-S dataset digest; a counted E1 row needs it');
  }
  const tags = [...new Set(ids.map(x => x.ref).filter((r): r is string => !!r && RELEASE_TAG.test(r)))];
  if (tags.length > 1) throw new Error(`stage receipts name more than one gbrain release tag: ${tags.join(', ')}`);
  const tag = tags[0] ?? null;
  if (!o.provisional && !tag) throw new Error(`no stage receipt ran a gbrain release tag (vX.Y.Z, no -rc; saw ${[...new Set(ids.map(x => x.ref))].join(', ')}); a release candidate or branch build is --provisional`);
  if (!o.provisional) {
    if (!o.peelTag) throw new Error('a FINAL file checks its release tag against garrytan/gbrain; no tag check was given');
    const peeled = o.peelTag(tag!);
    if (!peeled) throw new Error(`${tag} is not a tag on garrytan/gbrain; a FINAL file needs a published release tag`);
    if (peeled !== commit) throw new Error(`${tag} on garrytan/gbrain is commit ${peeled}, but the receipts ran ${commit}`);
  }
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
    gates: evalGates(answers, suites),
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
    if (!/^[0-9a-f]{40}$/.test(file.evals_commit)) throw new Error(`evals_commit "${file.evals_commit}" is not a full git commit`);
    return path;
  }
  if (!out) throw new Error('a PROVISIONAL file needs --out, outside eval/results');
  const abs = resolve(out);
  if (abs === results || abs.startsWith(results + sep)) throw new Error('provisional files never go on main: write it outside eval/results');
  return abs;
}

/** Writes a FINAL file in one step that never replaces an existing file, and leaves no temporary file behind. */
export function writeFinal(path: string, file: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeScrubbedJson(tmp, file);
    linkSync(tmp, path);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const values = (name: string) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));
  const out = values('--out')[0];
  if (argv.length === 0) { process.stderr.write('usage: bun eval/runner/engine-bench/eval-gates.ts [--out <file>] [--provisional] [--answers f] [--speed f] [--correctness f] [--surface-parity f] [--suite f]... [--receipt f]... [--engine-format-version n]\n'); return 2; }
  const roles = ['answers', 'speed', 'correctness', 'surface-parity', 'suite', 'receipt'] as const;
  const inputs: EvalGatesInput[] = roles.flatMap(role => values(`--${role}`).map(p => {
    const bytes = readFileSync(p);
    const abs = resolve(p);
    const rel = relative(REPO_ROOT, abs);
    return { role, path: rel.startsWith('..') ? abs : rel, json: JSON.parse(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
  const evalsCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim();
  const file = buildEvalGates(inputs, { provisional: argv.includes('--provisional'), evalsCommit, engineFormatVersion: values('--engine-format-version')[0] ?? null, generatedAt: new Date().toISOString(), ops: PAIRED_OPS, peelTag: peelReleaseTag });
  const path = outputPath(file, out);
  if (file.status === 'FINAL') writeFinal(path, file);
  else writeScrubbedJson(path, file);
  process.stdout.write(`E1 ${file.gates.E1.verdict}, E2 ${file.gates.E2.verdict}, E3 ${file.gates.E3.verdict}; criterion 8 ${file.swap_readiness_criterion_8.verdict}\n`);
  return 0;
}

if (import.meta.main) process.exit(main());

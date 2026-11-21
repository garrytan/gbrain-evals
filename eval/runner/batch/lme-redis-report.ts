#!/usr/bin/env bun
/**
 * Scores the LongMemEval run on Redis's open harness and computes every preregistered statistic
 * (docs/benchmarks/2026-11-20-longmemeval-redis-harness-preregistration.md, "Metrics and denominators", "Statistics",
 * "Interim look").
 *
 *   bun eval/runner/batch/lme-redis-report.ts rows --frozen <dir> --out <dir>        rows.ndjson per reader and arm ($0)
 *   bun eval/runner/batch/lme-redis-report.ts judge-check --controls <jsonl> --out <dir>
 *   bun eval/runner/batch/lme-redis-report.ts interim --out <dir>                    the one look at 250 questions
 *   bun eval/runner/batch/lme-redis-report.ts final --out <dir>
 *
 * Everything here reads the lane's stored results and the frozen files; nothing calls a provider.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256 } from './manifest.ts';
import { BatchLane, type StoredResult } from './submit.ts';
import {
  HALF, MEMORIES, PARTICLE, READERS, STATE_DIR, MANIFEST_DIR, crossJudge, judgeArmId, loadFrozen, readJsonl, redisVerdict, strictVerdict,
  type AnyReader, type Memories, type ParticleRow, type Reader,
} from './lme-redis.ts';

export const SEED = Number.parseInt(sha256('lme-redis-harness').slice(0, 8), 16);
export const RESAMPLES = 10_000;
export const INTERIM_BOUND = 2.8;
export const FINAL_BOUND = 1.98;
export const FUTILITY_CP = 0.1;
export const SDD_Z = 2.82;

// ─── Statistics ─────────────────────────────────────────────────────

/** A seeded uniform generator (mulberry32), so every interval reproduces from the committed rows. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/** McNemar on paired 0/1 outcomes: b = right only on the first arm, c = right only on the second. */
export function mcnemar(a: (0 | 1)[], b: (0 | 1)[]): { n: number; b: number; c: number; z: number; exact_p: number } {
  if (a.length !== b.length) throw new Error('mcnemar needs paired rows');
  let only1 = 0, only2 = 0;
  for (let i = 0; i < a.length; i++) { if (a[i] && !b[i]) only1++; else if (!a[i] && b[i]) only2++; }
  const m = only1 + only2;
  const z = m ? (only1 - only2) / Math.sqrt(m) : 0;
  let tail = 0;
  const k = Math.min(only1, only2);
  let logC = 0;
  for (let i = 0; i <= m; i++) {
    if (i > 0) logC += Math.log(m - i + 1) - Math.log(i);
    if (i <= k) tail += Math.exp(logC - m * Math.LN2);
  }
  return { n: a.length, b: only1, c: only2, z, exact_p: m ? Math.min(1, 2 * tail) : 1 };
}

/** Paired difference in points (first minus second) with a percentile bootstrap 95% interval over questions. */
export function pairedDiff(a: (0 | 1)[], b: (0 | 1)[], seed = SEED, resamples = RESAMPLES): { diff_points: number; ci95: [number, number] } {
  const n = a.length;
  const d = a.map((x, i) => x - b[i]);
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const draw = rng(seed);
  const stats: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += d[Math.floor(draw() * n)];
    stats.push(s / n);
  }
  stats.sort((x, y) => x - y);
  const q = (p: number) => stats[Math.min(resamples - 1, Math.max(0, Math.floor(p * resamples)))];
  return { diff_points: 100 * mean(d), ci95: [100 * q(0.025), 100 * q(0.975)] };
}

export function wilson(k: number, n: number, z = 1.959964): [number, number] {
  if (!n) return [0, 1];
  const p = k / n;
  const den = 1 + z * z / n;
  const mid = (p + z * z / (2 * n)) / den;
  const half = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / den;
  return [mid - half, mid + half];
}

/** Holm's step-down adjusted p values, in the input order. */
export function holm(ps: number[]): number[] {
  const order = ps.map((p, i) => [p, i] as const).sort((x, y) => x[0] - y[0]);
  const out = new Array(ps.length).fill(0);
  let running = 0;
  order.forEach(([p, i], rank) => { running = Math.max(running, Math.min(1, (ps.length - rank) * p)); out[i] = running; });
  return out;
}

/** The smallest detectable difference at 80% power for a paired test: 2.82 × √(d / n) × 100 points. */
export const sdd = (discordance: number, n = 500) => SDD_Z * Math.sqrt(discordance / n) * 100;

/**
 * Conditional power at the final look by the B-value method: B = z₁√t at information fraction t, drift θ = 2.82 (the
 * planned alternative, a true difference equal to the smallest detectable one, in the observed direction).
 */
export function conditionalPower(zInterim: number, t = 0.5, bound = FINAL_BOUND, theta = SDD_Z): number {
  const b = zInterim * Math.sqrt(t);
  const drift = (zInterim >= 0 ? 1 : -1) * theta * (1 - t);
  const sd = Math.sqrt(1 - t);
  return 1 - normalCdf((bound - b - drift) / sd) + normalCdf((-bound - b - drift) / sd);
}

export function interimDecision(z: number): { decision: 'stop-difference' | 'stop-futility' | 'continue'; conditional_power: number } {
  const cp = conditionalPower(z);
  if (Math.abs(z) >= INTERIM_BOUND) return { decision: 'stop-difference', conditional_power: cp };
  if (cp < FUTILITY_CP) return { decision: 'stop-futility', conditional_power: cp };
  return { decision: 'continue', conditional_power: cp };
}

/** Cohen's kappa for two binary raters, with the confusion matrix and raw agreement beside it. */
export function kappa(pairs: [0 | 1, 0 | 1][]): { n: number; kappa: number; agreement: number; matrix: { yy: number; yn: number; ny: number; nn: number } } {
  const m = { yy: 0, yn: 0, ny: 0, nn: 0 };
  for (const [x, y] of pairs) m[x ? (y ? 'yy' : 'yn') : (y ? 'ny' : 'nn')]++;
  const n = pairs.length;
  const po = (m.yy + m.nn) / n;
  const pe = ((m.yy + m.yn) * (m.yy + m.ny) + (m.nn + m.ny) * (m.nn + m.yn)) / (n * n);
  return { n, kappa: pe === 1 ? 1 : (po - pe) / (1 - pe), agreement: po, matrix: m };
}

/** Redis's task-averaged accuracy (vendored compute_metrics): the mean over question types of each type's accuracy, counting only parsed verdicts. */
export function taskAveraged(rows: { question_type: string; verdict: 0 | 1 | -1 | null }[]): number | null {
  const by = new Map<string, number[]>();
  for (const r of rows) if (r.verdict === 0 || r.verdict === 1) by.set(r.question_type, [...(by.get(r.question_type) ?? []), r.verdict]);
  const accs = [...by.values()].map(v => v.reduce((s, x) => s + x, 0) / v.length);
  return accs.length ? accs.reduce((s, x) => s + x, 0) / accs.length : null;
}

/** A bootstrap over questions stratified by type, for the task-averaged figure against Redis's 86.14%. */
export function stratifiedBootstrap(rows: { question_type: string; verdict: 0 | 1 | -1 | null }[], seed = SEED, resamples = RESAMPLES): [number, number] {
  const by = new Map<string, typeof rows>();
  for (const r of rows) by.set(r.question_type, [...(by.get(r.question_type) ?? []), r]);
  const draw = rng(seed);
  const stats: number[] = [];
  for (let k = 0; k < resamples; k++) {
    const sample: typeof rows = [];
    for (const g of by.values()) for (let i = 0; i < g.length; i++) sample.push(g[Math.floor(draw() * g.length)]);
    stats.push(taskAveraged(sample) ?? 0);
  }
  stats.sort((x, y) => x - y);
  return [stats[Math.floor(0.025 * resamples)], stats[Math.floor(0.975 * resamples) - 1]];
}

// ─── Rows ───────────────────────────────────────────────────────────

export interface ScoredRow {
  question_id: string; question_type: string; reader: AnyReader; memories: Memories; answered_by: Memories;
  answer: string | null; truncated: boolean; protocol: 0 | 1 | -1 | null; cross: 0 | 1 | -1 | null; cross_redis_parse: 0 | 1 | -1 | null;
  delivery: unknown; context_sha256: string;
}

const verdictOf = (r: StoredResult | undefined, parse: (raw: string | null) => 0 | 1 | -1) => (!r || r.status !== 'succeeded' ? null : parse(r.text));

/** Every reader × arm × question, with a reused answer (one request per distinct prompt) taking its source arm's answer and judgments. */
export function scoreRows(input: {
  order: string[]; types: Map<string, string>; lines: ReturnType<typeof loadFrozen>['lines']; reuse: Record<string, Record<string, Record<string, Memories>>>;
  answers: (reader: AnyReader, memories: Memories) => Map<string, { answer: string | null; truncated: boolean }>;
  judged: (arm: string, role: 'protocol' | 'cross') => Map<string, StoredResult>;
}): ScoredRow[] {
  const rows: ScoredRow[] = [];
  const readers: [AnyReader, readonly Memories[]][] = [...(Object.keys(READERS) as Reader[]).map(r => [r, READERS[r].memories] as [AnyReader, readonly Memories[]]), ['particle', PARTICLE.memories]];
  for (const [reader, memories] of readers) for (const m of memories) for (const q of input.order) {
    const src = input.reuse[reader]?.[m]?.[q] ?? m;
    const a = input.answers(reader, src).get(q);
    const arm = `${reader}--${src}`;
    const p = input.judged(judgeArmId(arm, 'protocol'), 'protocol').get(q);
    const c = input.judged(judgeArmId(arm, 'cross'), 'cross').get(q);
    const line = input.lines[m].get(q)!;
    rows.push({
      question_id: q, question_type: input.types.get(q) ?? 'unknown', reader, memories: m, answered_by: src,
      answer: a?.answer ?? null, truncated: a?.truncated ?? false,
      protocol: verdictOf(p, redisVerdict), cross: verdictOf(c, strictVerdict), cross_redis_parse: verdictOf(c, redisVerdict),
      delivery: (line as unknown as { delivery?: unknown }).delivery ?? null, context_sha256: line.context_sha256,
    });
  }
  return rows;
}

const cell = (rows: ScoredRow[], reader: AnyReader, m: Memories, ids?: Set<string>) => rows.filter(r => r.reader === reader && r.memories === m && (!ids || ids.has(r.question_id)));

/** A paired comparison under the cross-family judge: questions scored in both members; unjudged ones counted. */
export function compare(rows: ScoredRow[], reader: AnyReader, first: Memories, second: Memories, ids?: Set<string>, exclude = new Set<string>()) {
  const a = new Map(cell(rows, reader, first, ids).map(r => [r.question_id, r]));
  const b = new Map(cell(rows, reader, second, ids).map(r => [r.question_id, r]));
  const both = [...a.keys()].filter(q => !exclude.has(q) && b.has(q) && (a.get(q)!.cross === 0 || a.get(q)!.cross === 1) && (b.get(q)!.cross === 0 || b.get(q)!.cross === 1));
  const x = both.map(q => a.get(q)!.cross as 0 | 1);
  const y = both.map(q => b.get(q)!.cross as 0 | 1);
  const total = [...a.keys()].filter(q => !exclude.has(q)).length;
  return { reader, first, second, scored: both.length, of: total, enough: both.length >= 0.98 * total, ...mcnemar(x, y), ...pairedDiff(x, y), discordance: both.length ? (mcnemar(x, y).b + mcnemar(x, y).c) / both.length : null };
}

export function accuracy(rows: ScoredRow[], reader: AnyReader, m: Memories, judge: 'cross' | 'protocol', ids?: Set<string>) {
  const c = cell(rows, reader, m, ids);
  const k = c.filter(r => r[judge] === 1).length;
  return { reader, memories: m, judge, correct: k, of: c.length, unjudged: c.filter(r => r[judge] === null || r[judge] === -1).length, accuracy: c.length ? k / c.length : null, wilson95: wilson(k, c.length) };
}

/**
 * The primary, the 11 Holm-adjusted secondaries, the two fixed references and the descriptive rows. `onIds` is the
 * question set of the on arm: when the primary stopped at the interim look, the on arm stopped too, so every on
 * comparison and the on rows count the first half only (a second-half on row would be off's reused answer).
 */
export function analyse(rows: ScoredRow[], ids?: Set<string>, degraded = new Set<string>(), onIds = ids) {
  const stopped = onIds !== ids;
  const primary = compare(rows, 'opus', 'off', 'on', onIds, degraded);
  const secondaries = [
    ...(['sol', 'gpt4o', 'particle'] as AnyReader[]).map(r => compare(rows, r, 'off', 'on', onIds, degraded)),
    ...(['opus', 'sol', 'gpt4o', 'particle'] as AnyReader[]).map(r => compare(rows, r, 'off', 'full', ids)),
    ...(['opus', 'sol', 'gpt4o', 'particle'] as AnyReader[]).map(r => compare(rows, r, 'oracle', 'off', ids)),
  ];
  const adjusted = holm(secondaries.map(s => s.exact_p));
  const off4o = cell(rows, 'gpt4o', 'off', ids).map(r => ({ question_type: r.question_type, verdict: r.protocol }));
  const ta = taskAveraged(off4o);
  return {
    primary: stopped ? { ...primary, stopped_at_interim_look: true, estimate_possibly_overstated: true } : { ...primary, passes_final_bound: Math.abs(primary.z) >= FINAL_BOUND },
    secondaries: secondaries.map((s, i) => ({ ...s, holm_p: adjusted[i], passes_holm: adjusted[i] < 0.05 })),
    redis_link: { reader: 'gpt4o', memories: 'off', task_averaged: ta, ci95: stratifiedBootstrap(off4o), published: 0.8614 },
    readme_link: (['opus', 'sol', 'particle', 'gpt4o'] as AnyReader[]).flatMap(r => (['off', 'oracle'] as Memories[]).map(m => {
      const a = accuracy(rows, r, m, 'protocol');
      const closes = a.accuracy !== null && a.accuracy >= 0.926 && a.wilson95[1] >= 0.936;
      return { ...a, verdict: closes ? 'closes the gap' : a.wilson95[1] < 0.936 ? 'falls short' : 'not distinguishable at this sample size' };
    })),
    accuracy: rows.length ? [...new Set(rows.map(r => `${r.reader}--${r.memories}`))].map(k => { const [r, m] = k.split('--') as [AnyReader, Memories]; const only = m === 'on' ? onIds : undefined; return [accuracy(rows, r, m, 'cross', only), accuracy(rows, r, m, 'protocol', only)]; }) : [],
  };
}

// ─── Commands ───────────────────────────────────────────────────────

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function load(frozenDir: string) {
  const frozen = loadFrozen(frozenDir);
  const types = new Map([...frozen.lines.off.values()].map(l => [l.question_id, l.question_type]));
  const reuse = JSON.parse(readFileSync(join(MANIFEST_DIR, 'reuse.json'), 'utf8'));
  const lane = new BatchLane({ statePath: join(STATE_DIR, 'batch-state.sqlite'), transports: {}, run: { runId: 'report-only', ledgerPath: join(STATE_DIR, 'ledger.sqlite') } as never });
  const answers = (reader: AnyReader, m: Memories) => {
    if (reader === 'particle') {
      const path = join(STATE_DIR, 'particle', `${m}.rows.jsonl`);
      return new Map((existsSync(path) ? readJsonl<ParticleRow>(path) : []).map(r => [r.question_id, { answer: r.answer, truncated: r.truncated }]));
    }
    return new Map([...lane.results(`${reader}--${m}`)].map(([q, r]) => [q, { answer: r.status === 'succeeded' ? r.text ?? '' : null, truncated: r.finish === 'max_tokens' || r.finish === 'length' }]));
  };
  const rows = scoreRows({ order: frozen.order, types, lines: frozen.lines, reuse, answers, judged: id => new Map([...lane.results(id), ...lane.results(`${id}--second-half`)]) });
  const retrieval = readJsonl<{ question_id: string; degraded: boolean }>(join(frozenDir, 'retrieval.jsonl'));
  return { frozen, rows, lane, degraded: new Set(retrieval.filter(r => r.degraded).map(r => r.question_id)) };
}

const write = (dir: string, name: string, value: unknown) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), JSON.stringify(value, null, 1) + '\n'); };

async function main(argv: string[]) {
  const [cmd] = argv;
  const out = resolve(flag(argv, '--out') ?? '.');
  if (cmd === 'judge-check') {
    const controls = readJsonl<{ item_id: string; expected: boolean }>(resolve(flag(argv, '--controls') ?? ''));
    const lane = new BatchLane({ statePath: join(STATE_DIR, 'batch-state.sqlite'), transports: {}, run: { runId: 'report-only', ledgerPath: join(STATE_DIR, 'ledger.sqlite') } as never });
    const report: Record<string, unknown> = {};
    for (const judge of ['protocol', 'opus', 'astra'] as const) {
      const parse = judge === 'protocol' ? redisVerdict : strictVerdict;
      const res = lane.results(`controls--${judge}`);
      const verdicts = controls.map(c => ({ c, v: verdictOf(res.get(c.item_id), parse) }));
      const parsed = verdicts.filter(x => x.v === 0 || x.v === 1);
      const labelFiles = judge === 'protocol' ? ['opus', 'astra'] : [judge];
      const labelled = labelFiles.flatMap(f => (existsSync(join(STATE_DIR, 'labels', `${f}.jsonl`)) ? readJsonl<{ arm: string; question_id: string; label: 0 | 1 | -1 }>(join(STATE_DIR, 'labels', `${f}.jsonl`)) : []));
      const real = labelled.filter(l => l.label !== -1).map(l => ({ l, v: verdictOf(lane.results(judgeArmId(l.arm, judge === 'protocol' ? 'protocol' : 'cross')).get(l.question_id), parse) }));
      const realParsed = real.filter(x => x.v === 0 || x.v === 1);
      const controlsK = kappa(parsed.map(x => [x.c.expected ? 1 : 0, x.v as 0 | 1]));
      const realK = realParsed.length ? kappa(realParsed.map(x => [x.l.label as 0 | 1, x.v as 0 | 1])) : null;
      const unparsable = (verdicts.length - parsed.length) / verdicts.length;
      report[judge] = {
        controls: { ...controlsK, items: verdicts.length, unparsable_share: unparsable }, real: realK && { ...realK, labels_unparsable: labelled.length - real.length },
        passes: controlsK.n >= 40 && controlsK.kappa >= 0.6 && !!realK && realK.n >= 40 && realK.kappa >= 0.6 && unparsable <= 0.01,
      };
    }
    write(out, 'judge-check.json', report);
    console.log(JSON.stringify(report, null, 1));
    return;
  }
  const frozenDir = resolve(flag(argv, '--frozen') ?? '');
  const { frozen, rows, degraded } = load(frozenDir);
  if (cmd === 'rows') {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'rows.ndjson'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    console.log(JSON.stringify({ rows: rows.length }));
  } else if (cmd === 'interim') {
    const ids = new Set(frozen.order.slice(0, HALF));
    const primary = compare(rows, 'opus', 'off', 'on', ids, degraded);
    const look = { questions: ids.size, primary, ...interimDecision(primary.z), bounds: { interim: INTERIM_BOUND, final: FINAL_BOUND, futility_conditional_power: FUTILITY_CP } };
    write(out, 'interim.json', look);
    console.log(JSON.stringify(look, null, 1));
  } else if (cmd === 'final') {
    const interim = existsSync(join(out, 'interim.json')) ? JSON.parse(readFileSync(join(out, 'interim.json'), 'utf8')) as { decision: string } : null;
    const onIds = interim?.decision === 'stop-difference' ? new Set(frozen.order.slice(0, HALF)) : undefined;
    const summary = { degraded_questions: degraded.size, ...analyse(rows, undefined, degraded, onIds) };
    write(out, 'summary.json', summary);
    console.log(JSON.stringify(summary.primary, null, 1));
  } else throw new Error(`unknown command ${cmd}`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(() => process.exit(0)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}

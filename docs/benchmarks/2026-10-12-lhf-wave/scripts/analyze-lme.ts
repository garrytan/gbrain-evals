// The preregistered LongMemEval-S decision rule for the GBRA-81 low-hanging-fruit wave
// (../../2026-10-12-lhf-wave-preregistration.md). Reads two harness rows files and prints one JSON verdict.
//
// estimate  = treatment minus control in strict recall_all@5 over the same answerable questions (paired)
// interval  = one-sided 95% lower bound of a paired bootstrap over questions (10,000 resamples, mulberry32 seed 1):
//             the resampled mean differences sorted ascending, element floor(0.05 * resamples)
// verdict   = pass when lower > margin (-0.01, strictly above); fail otherwise; invalid when an arm is invalid or a
//             pair is missing
// Usage: bun analyze-lme.ts <treatment rows.ndjson> <control rows.ndjson> [--expect-expansion treatment|control]
//          [--questions 470] [--control-direct]   (control is a published direct-harness receipt, e.g. the baseline)
import { readFileSync } from 'node:fs';

export const MARGIN = -0.01;
export const RESAMPLES = 10_000;
export const SEED = 1;

export interface Row {
  question_id: string;
  abstention?: boolean;
  recall_all_hit?: boolean;
  search_meta?: { degraded?: Array<{ stage?: string }>; reranked?: boolean };
  via_operation?: { expansion?: { expected?: boolean; outcome?: string }; latency_ms?: number; model_calls?: Record<string, number>; crag_confidence?: string | null; failed_model_calls?: number };
  error?: unknown;
}

export interface ArmCheck { valid: boolean; reasons: string[]; questions: number; hits: number; no_variants: number }

const INVALIDATING_STAGE = /rerank|embed|vector/;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function readRows(path: string): Row[] {
  const text = path.endsWith('.gz') ? new TextDecoder().decode(Bun.gunzipSync(readFileSync(path))) : readFileSync(path, 'utf8');
  return text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l)).filter((r: Row) => typeof r.question_id === 'string');
}

/** Answerable rows keyed by question id; a duplicate id is an error (a resume that merged twice). */
export function answerable(rows: readonly Row[]): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const r of rows) {
    if (r.abstention === true || r.question_id.endsWith('_abs')) continue;
    if (out.has(r.question_id)) throw new Error(`duplicate question_id ${r.question_id}`);
    out.set(r.question_id, r);
  }
  return out;
}

/** An arm is invalid on any errored row, any rerank/embedding/vector degradation, a row without a rerank call (every arm runs the reranker), a failed model call, or (when it expects expansion) any row whose expansion failed or was not attempted. */
export function checkArm(rows: Map<string, Row>, opts: { expectExpansion: boolean; questions: number; direct?: boolean }): ArmCheck {
  const reasons: string[] = [];
  let hits = 0;
  let noVariants = 0;
  for (const r of rows.values()) {
    if (r.error !== undefined && r.error !== null) reasons.push(`${r.question_id}: errored row`);
    if (typeof r.recall_all_hit !== 'boolean') reasons.push(`${r.question_id}: no recall_all_hit`);
    if (r.recall_all_hit === true) hits++;
    for (const d of r.search_meta?.degraded ?? []) if (INVALIDATING_STAGE.test(String(d.stage ?? ''))) reasons.push(`${r.question_id}: degraded ${d.stage}`);
    if (opts.direct) {
      // A published direct-harness receipt (no via_operation block): its rows derive `reranked` from rerank scores.
      if (r.search_meta?.reranked !== true) reasons.push(`${r.question_id}: not reranked`);
      continue;
    }
    if ((r.via_operation?.model_calls?.rerank ?? 0) < 1) reasons.push(`${r.question_id}: no rerank call`);
    if ((r.via_operation?.failed_model_calls ?? 0) > 0) reasons.push(`${r.question_id}: ${r.via_operation!.failed_model_calls} failed model call(s)`);
    const outcome = r.via_operation?.expansion?.outcome;
    if (opts.expectExpansion) {
      if (outcome === 'no_variants') noVariants++;
      else if (outcome !== 'applied') reasons.push(`${r.question_id}: expansion ${outcome ?? 'unrecorded'}`);
    } else if (outcome === 'applied') reasons.push(`${r.question_id}: expansion applied in an expansion-off arm`);
  }
  if (rows.size !== opts.questions) reasons.push(`${rows.size} answerable rows, expected ${opts.questions}`);
  return { valid: reasons.length === 0, reasons: reasons.slice(0, 20), questions: rows.size, hits, no_variants: noVariants };
}

export function pairedLowerBound(diffs: readonly number[], resamples = RESAMPLES, seed = SEED): number {
  const n = diffs.length;
  if (n === 0) throw new Error('no pairs');
  const rng = mulberry32(seed);
  const means = new Float64Array(resamples);
  for (let b = 0; b < resamples; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += diffs[Math.floor(rng() * n)];
    means[b] = s / n;
  }
  means.sort();
  return means[Math.floor(0.05 * resamples)];
}

export function decide(treatment: Map<string, Row>, control: Map<string, Row>, opts: { treatmentExpects: boolean; controlExpects: boolean; questions: number; controlDirect?: boolean }) {
  const t = checkArm(treatment, { expectExpansion: opts.treatmentExpects, questions: opts.questions });
  const c = checkArm(control, { expectExpansion: opts.controlExpects, questions: opts.questions, direct: opts.controlDirect });
  const missing = [...new Set([...treatment.keys(), ...control.keys()])].filter(id => !treatment.has(id) || !control.has(id));
  const base = { treatment: t, control: c, missing_pairs: missing.length, margin: MARGIN, resamples: RESAMPLES, seed: SEED };
  if (!t.valid || !c.valid || missing.length > 0) return { ...base, verdict: 'invalid' as const, estimate: null, lower: null, wins: null, losses: null };
  const ids = [...treatment.keys()].sort();
  const diffs = ids.map(id => Number(treatment.get(id)!.recall_all_hit) - Number(control.get(id)!.recall_all_hit));
  const estimate = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  const lower = pairedLowerBound(diffs);
  return { ...base, verdict: lower > MARGIN ? 'pass' as const : 'fail' as const, estimate, lower, wins: diffs.filter(d => d > 0).length, losses: diffs.filter(d => d < 0).length };
}

/** Per-arm operational report: latency p50/p95, model calls per query, CRAG grades. */
export function armReport(rows: Map<string, Row>) {
  const lat = [...rows.values()].map(r => r.via_operation?.latency_ms).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b);
  const pct = (p: number) => lat.length ? lat[Math.min(lat.length - 1, Math.max(0, Math.ceil(p * lat.length) - 1))] : null;
  const calls: Record<string, number> = {};
  const crag: Record<string, number> = {};
  for (const r of rows.values()) {
    for (const [k, v] of Object.entries(r.via_operation?.model_calls ?? {})) calls[k] = (calls[k] ?? 0) + v;
    const g = r.via_operation?.crag_confidence ?? 'none';
    crag[g] = (crag[g] ?? 0) + 1;
  }
  return { latency_ms: { p50: pct(0.5), p95: pct(0.95) }, model_calls_per_query: Object.fromEntries(Object.entries(calls).map(([k, v]) => [k, Number((v / Math.max(1, rows.size)).toFixed(3))])), crag_confidence: crag };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const valued = new Set(['--expect-expansion', '--questions']);
  const [tPath, cPath] = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
  const expect = flag('--expect-expansion');
  const questions = Number(flag('--questions') ?? 470);
  const treatment = answerable(readRows(tPath));
  const control = answerable(readRows(cPath));
  const verdict = decide(treatment, control, { treatmentExpects: expect === 'treatment', controlExpects: expect === 'control', questions, controlDirect: args.includes('--control-direct') });
  console.log(JSON.stringify({ treatment_path: tPath, control_path: cPath, ...verdict, treatment_report: armReport(treatment), control_report: armReport(control) }, null, 2));
}

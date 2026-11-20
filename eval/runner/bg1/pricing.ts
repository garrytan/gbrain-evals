/**
 * BG1's money model (preregistration docs/benchmarks/2026-11-09-changing-facts-battleground-preregistration.md, "Money";
 * plan decision 10 and review finding F2): every paid line per kept world at the assumed rates, which stage 1's
 * measured rates replace (--rates), with the stage 1 estimate and its cap and the check-in projection.
 *
 *   bun eval/runner/bg1/pricing.ts --out <file> [--n <planned N>] [--rates <measured rates json>] [--spent-usd <paid
 *     spent so far>] [--worlds-done <kept worlds whose spend is in --spent-usd>] [--stage1-done]
 *
 * Lines per kept world: the mint; each system row's ingest (API dollars and VM vCPU-hours); reads (claude-opus-5-5 and
 * gpt-6.1-sol live at 8,000 tokens and particle-1's re-read, plus query and VM time) on the five system rows; judging
 * (gpt-6-astra on the Opus answer, claude-opus-5-5 on the Sol and particle-1 answers, priced per call from RS1's judge
 * check at $0.022 and $0.016, and the canonical gemini-3.8-flash judge on every answer); and the no-memory floor (reads
 * and the canonical judge only). The full-context reference (Opus and Sol on 10 worlds, prompt caching) and stage 1 (the
 * three dev worlds through every row, the full-context reference on them, and the judge check) are priced apart.
 *
 *   stage 1 cap   min(300, the larger of the stage 1 estimate / 0.75 and its smoke leases, rounded up to the dollar)
 *   plan          the paid spend expected at N = 30 at the assumed rates, computed here, never committed
 *   projection    paid spent to date + paid still to spend at the planned N x 1.10 reserve
 *   check-in      exit 3 (BG1_CHECKIN) when the projection passes the plan by 25%
 *
 * Crew credits are outside this model. It writes only to the path the caller names, so no program total is committed
 * (R79); --out is required and it exits 2 without it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ASSUMPTIONS, BG1_ASSUMPTIONS, f6ExtractionUsd } from '../q1/cells/definitions.ts';
import { generateBG1Stage1Cells, JUDGE_CHECK_PLAN, listPrice, stage1CapUsd, stage1SmokeLeaseUsd } from '../q1/cells/bg1.ts';
import { BG1_DEV_CONVERSATIONS, BG1_N_CAP, BG1_N_FLOOR, BG1_QUESTIONS_PER_WORLD } from './types.ts';

export const OPUS = 'anthropic:claude-opus-5-5';
export const SOL = 'openai:gpt-6.1-sol';
export const ASTRA = 'openai:gpt-6-astra';
export const CANONICAL = 'gemini:gemini-3.8-flash';
export const N_PLAN = BG1_N_FLOOR;
export const CHECKIN_RATIO = 1.25;
/** The stage 1 cap, the judge check's planned pool and list prices live with the cell definitions, which the runner imports. */
export { JUDGE_CHECK_PLAN, listPrice, stage1CapUsd, STAGE1_CAP_CEILING_USD, STAGE1_CAP_SHARE } from '../q1/cells/bg1.ts';

export interface SystemRate { api_usd_per_mtok: number; vm_hours_per_mtok: number; vcpu: number }
export type Bg1System = 'gbrain-defaults' | 'ext-memory-bank' | 'ext-extract-first' | 'ext-temporal-graph' | 'baseline-hybrid';
export interface Rates {
  mtok_per_world: number;
  questions_per_world: number;
  mint_usd_per_world: number;
  vcpu_hour_usd: number;
  /** One question read by Opus and Sol live at 8,000 tokens and particle-1's re-read. */
  read_usd_per_question: number;
  /** The floor's reads per question (no memory context). */
  floor_read_usd_per_question: number;
  query_vm_usd_per_question: number;
  /** Per judge call: the two gating judges and the canonical judge. */
  judge_usd_per_call: { astra: number; opus: number; canonical: number };
  systems: Record<Bg1System, SystemRate>;
  full_context_worlds: number;
  full_context_usd_per_world: number;
  reserve: number;
}

const per = listPrice;
const out = (r: string) => ASSUMPTIONS.reader_output_tokens[r] ?? ASSUMPTIONS.reader_output_tokens.default;
const tok = (r: string) => ASSUMPTIONS.reader_tokens_per_cl100k[r] ?? ASSUMPTIONS.reader_tokens_per_cl100k.default;
const over = (r: string) => ASSUMPTIONS.reader_input_overhead_tokens[r] ?? ASSUMPTIONS.reader_input_overhead_tokens.default;
const read = (r: string, cl100k: number) => ((cl100k * tok(r) + over(r)) * per(r).input + out(r) * per(r).output) / 1e6;
/** particle-1's measured re-read per question (RS1 stage 0). */
const PARTICLE_READ_USD = 0.0695 / 20;
const canonicalUsd = () => { const t = BG1_ASSUMPTIONS.canonical_judge_tokens, p = per(CANONICAL); return (t.input * p.input + t.output * p.output) / 1e6; };
/** Whole history per world for one reader: written to the prompt cache once, read from it by the other questions. */
const fullContextRead = (r: string, worldTokens: number, q: number) => {
  const p = per(r), history = worldTokens * tok(r);
  return (history * (p.cache_write ?? p.input) + (q - 1) * history * (p.cache_read ?? p.input) + q * out(r) * p.output) / 1e6;
};

export function assumedRates(): Rates {
  const mtok = 0.2, q = BG1_QUESTIONS_PER_WORLD;
  const j = { astra: BG1_ASSUMPTIONS.judge_usd_per_call[ASTRA], opus: BG1_ASSUMPTIONS.judge_usd_per_call[OPUS], canonical: canonicalUsd() };
  const sys = (key: string, vcpu: number, extra = 0): SystemRate => ({ api_usd_per_mtok: BG1_ASSUMPTIONS.ingest_usd_per_mtok[key] + extra, vm_hours_per_mtok: BG1_ASSUMPTIONS.hours_per_mtok[key], vcpu });
  return {
    mtok_per_world: mtok, questions_per_world: q, mint_usd_per_world: 2.0, vcpu_hour_usd: 0.05,
    read_usd_per_question: read(OPUS, 8000) + read(SOL, 8000) + PARTICLE_READ_USD,
    floor_read_usd_per_question: read(OPUS, 250) + read(SOL, 250) + 0.0012,
    query_vm_usd_per_question: 0.005 + 0.004,
    judge_usd_per_call: j,
    systems: {
      'gbrain-defaults': sys('gbrain-defaults:rs1-stable', 4, f6ExtractionUsd(1e6)),
      'ext-memory-bank': sys('ext-memory-bank:recipe', 16),
      'ext-extract-first': sys('ext-extract-first:common', 16),
      'ext-temporal-graph': sys('ext-temporal-graph:shipped-0.31', 16),
      'baseline-hybrid': sys('baseline-hybrid:baseline', 4),
    },
    full_context_worlds: 10,
    full_context_usd_per_world: fullContextRead(OPUS, mtok * 1e6, q) + fullContextRead(SOL, mtok * 1e6, q) + q * (j.astra + j.opus + 2 * j.canonical),
    reserve: 0.1,
  };
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Paid dollars per kept world, by line (judges_astra apart from the rest of judging). */
export function perWorld(r: Rates) {
  const q = r.questions_per_world, rows = Object.values(r.systems), j = r.judge_usd_per_call;
  const lines = {
    mint: r.mint_usd_per_world,
    ingest_api: rows.reduce((s, x) => s + x.api_usd_per_mtok * r.mtok_per_world, 0),
    ingest_vm: rows.reduce((s, x) => s + x.vm_hours_per_mtok * r.mtok_per_world * x.vcpu * r.vcpu_hour_usd, 0),
    reads: rows.length * q * (r.read_usd_per_question + r.query_vm_usd_per_question),
    judges: rows.length * q * (2 * j.opus + 3 * j.canonical),
    judges_astra: rows.length * q * j.astra,
    floor: q * (r.floor_read_usd_per_question + 3 * j.canonical),
  };
  return { lines, total: Object.values(lines).reduce((a, b) => a + b, 0) };
}

/** Stage 1: the three dev worlds through every row, the full-context reference on them, and the judge check; its smoke leases are the cell definitions'. */
export function stage1(r: Rates) {
  const worlds = BG1_DEV_CONVERSATIONS.length;
  const judge_check = (JUDGE_CHECK_PLAN.dev_answers + JUDGE_CHECK_PLAN.construction_items) * (r.judge_usd_per_call.astra + r.judge_usd_per_call.opus);
  const rows = worlds * perWorld(r).total, full_context = worlds * r.full_context_usd_per_world;
  const estimate = rows + full_context + judge_check, smoke_leases = stage1SmokeLeaseUsd(generateBG1Stage1Cells());
  return { rows: r2(rows), full_context: r2(full_context), judge_check: r2(judge_check), estimate: r2(estimate), smoke_leases, cap: stage1CapUsd(estimate, smoke_leases) };
}

/** Paid spend at N kept worlds: stage 1, the worlds and the full-context reference. */
export function paidAt(n: number, r: Rates) {
  const w = perWorld(r), s = stage1(r);
  const fc = Math.min(n, r.full_context_worlds) * r.full_context_usd_per_world;
  return { n, ...Object.fromEntries(Object.entries(w.lines).map(([k, v]) => [k, r2(v * n)])), full_context: r2(fc), stage1: s.estimate, paid: r2(s.estimate + n * w.total + fc) };
}

export interface Progress { spent_usd: number; worlds_done: number; stage1_done: boolean }
export const NO_PROGRESS: Progress = { spent_usd: 0, worlds_done: 0, stage1_done: false };

/** The check-in: the projection at the planned N against the plan (expected paid at N = 30 at the assumed rates). */
export function checkin(planned: number, r: Rates, p: Progress = NO_PROGRESS) {
  const w = perWorld(r), s = stage1(r);
  const left = Math.max(0, planned - p.worlds_done);
  const fcLeft = Math.max(0, Math.min(planned, r.full_context_worlds) - p.worlds_done) * r.full_context_usd_per_world;
  const remaining = left * w.total + fcLeft + (p.stage1_done ? 0 : s.estimate);
  const projection = p.spent_usd + remaining * (1 + r.reserve);
  const plan = paidAt(N_PLAN, assumedRates()).paid;
  return { planned_n: planned, progress: p, projection: r2(projection), plan: r2(plan), line: r2(plan * CHECKIN_RATIO), over: projection > plan * CHECKIN_RATIO };
}

export function pricing(planned = N_PLAN, r: Rates = assumedRates(), p: Progress = NO_PROGRESS) {
  const w = perWorld(r);
  return {
    schema: 'gbrain-evals/bg1-pricing/v1', rates: r,
    per_world: { ...Object.fromEntries(Object.entries(w.lines).map(([k, v]) => [k, r2(v)])), total: r2(w.total) },
    stage1: stage1(r), expected: paidAt(N_PLAN, r), cap: { ...paidAt(BG1_N_CAP, r), reserve: r.reserve },
    checkin: checkin(planned, r, p), crew: 'outside this model',
  };
}

/** Measured rates over the assumed ones: a JSON object with any of Rates' keys; systems merge per system. */
export function mergeRates(base: Rates, measured: Partial<Rates>): Rates {
  const systems = { ...base.systems };
  for (const [k, v] of Object.entries(measured.systems ?? {})) systems[k as Bg1System] = { ...base.systems[k as Bg1System], ...v };
  return { ...base, ...measured, judge_usd_per_call: { ...base.judge_usd_per_call, ...(measured.judge_usd_per_call ?? {}) }, systems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const fail = (m: string) => { process.stderr.write(`pricing.ts: ${m}\n`); process.exit(2); };
  const num = (name: string, fallback: number) => { const v = flag(name); if (v === undefined) return fallback; const x = Number(v); if (!Number.isFinite(x) || x < 0) fail(`${name} takes a non-negative number, not ${v}`); return x; };
  const path = flag('--out');
  if (!path) fail('--out <file> is required: pricing writes only to a path the caller names, and no program total is committed (R79)');
  const progress: Progress = { spent_usd: num('--spent-usd', 0), worlds_done: num('--worlds-done', 0), stage1_done: args.includes('--stage1-done') };
  if (flag('--spent-usd') === undefined && (progress.worlds_done > 0 || progress.stage1_done)) fail('--worlds-done and --stage1-done take completed work out of the remaining spend, so they need --spent-usd with the paid spend to date from the ledger');
  const rates = flag('--rates') ? mergeRates(assumedRates(), JSON.parse(readFileSync(flag('--rates')!, 'utf8'))) : assumedRates();
  const result = pricing(num('--n', N_PLAN), rates, progress);
  writeFileSync(resolve(path!), JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(`pricing written to ${path}\n`);
  if (result.checkin.over) { process.stderr.write(`BG1_CHECKIN: the projection at N = ${result.checkin.planned_n} passes the plan by more than 25%; GBEV-3 decides before more paid work\n`); process.exit(3); }
}

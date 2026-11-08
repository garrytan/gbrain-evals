/**
 * RS1's money model (docs/benchmarks/2026-11-08-rs1-narrow-preregistration.md, "Money"): GBEV-48's option 2b cost model
 * at stage 0's measured rates, projected as all-in new spend (R71: paid calls, judges, VMs and crew credits).
 *
 *   bun eval/runner/rs1/pricing.ts [--n <planned N>] [--spent-usd <all-in spent so far>] [--kept-done <conversations
 *     whose spend is in --spent-usd>] [--stage1-done] [--crew-remaining-usd <n>] [--gbrain-api-per-mtok <usd>]
 *     [--gbrain-hours-per-mtok <h>] [--out <file>]
 *
 * It writes pricing.json (default eval/runner/rs1/pricing.json) with the expected all-in spend at N = 28, the ceiling
 * at the cap of 33, and the check-in projection at the planned N (28 before the pilot, N_final after it):
 *
 *   projection = spent-to-date + (paid still to spend) x 1.10 reserve + crew credits still to spend
 *
 * VM time is inside paid. It exits 3 with RS1_CHECKIN when the projection passes $2,300. After stage 1, the measured
 * rs1-stable ingest rates replace F6's f6-master placeholders through --gbrain-api-per-mtok and --gbrain-hours-per-mtok,
 * and both projections are recorded in the preregistration's amendments.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const RS1_CHECKIN_USD = 2300;
export const N_CENTRAL = 28;
export const N_CAP = 33;
export const PRICING_PATH = resolve(import.meta.dir, 'pricing.json');

export interface SystemRate { api_usd_per_mtok: number; vm_hours_per_mtok: number; vcpu: number }
export interface Rates {
  /** Mint, validate and topic per conversation with the early stop (stage 0, c003). */
  mint_usd: number;
  /** Item regeneration and revalidation per kept conversation. */
  regeneration_usd: number;
  /** Share of minted conversations that pass validation. */
  yield: number;
  /** Ingested Mtok per 1M-token conversation (F6's S2b ratio). */
  mtok_per_conversation: number;
  vcpu_hour_usd: number;
  questions_per_conversation: number;
  /** Reads per question: Opus and Sol live and particle-1's re-read at 8,000 tokens (plan v2 rates). */
  read_usd_per_question: number;
  /** The floor row's reads per question (no memory context). */
  floor_read_usd_per_question: number;
  /** Frontier judgment per answer (GST-1365 census B: $113.31 for 3,301). */
  frontier_judge_usd: number;
  /** gpt-4.1-mini bridge judgment per answer. */
  bridge_judge_usd: number;
  query_usd_per_question: number;
  read_vm_usd_per_question: number;
  readers: number;
  systems: Record<'gbrain' | 'memory-bank' | 'extract-first', SystemRate>;
  stage1_overhead_usd: number;
  reserve: number;
  crew_usd: Record<string, number>;
  crew_cap_usd: number;
}

export const STAGE0_RATES: Rates = {
  mint_usd: 28.85, regeneration_usd: 1.0, yield: 0.85, mtok_per_conversation: 1.07, vcpu_hour_usd: 0.05, questions_per_conversation: 20,
  read_usd_per_question: (8000 * 1.47 + 180) * 4 / 1e6 + 720 * 20 / 1e6 + (8000 * 0.975 + 130) * 2 / 1e6 + 155 * 10 / 1e6 + 0.0695 / 20,
  floor_read_usd_per_question: 250 * 1.47 * 4 / 1e6 + 720 * 20 / 1e6 + 250 * 2 / 1e6 + 155 * 10 / 1e6 + 0.0012,
  frontier_judge_usd: 113.31 / 3301, bridge_judge_usd: 0.0028, query_usd_per_question: 0.005, read_vm_usd_per_question: 0.004, readers: 3,
  systems: {
    gbrain: { api_usd_per_mtok: 1.16 * 1.36, vm_hours_per_mtok: 1.92, vcpu: 4 },
    'memory-bank': { api_usd_per_mtok: 1.72 * 1.01, vm_hours_per_mtok: 2.32, vcpu: 16 },
    'extract-first': { api_usd_per_mtok: 2.8 * 0.99, vm_hours_per_mtok: 1.74, vcpu: 16 },
  },
  stage1_overhead_usd: 5, reserve: 0.1,
  crew_usd: { prereg_pr: 150, run_orchestration: 100, custodian: 40, results_pr: 40, plan: 20 }, crew_cap_usd: 550,
};

const r2 = (x: number) => Math.round(x * 100) / 100;

/** One system row's paid spend per conversation, without the mint. */
export function systemPerConversation(r: Rates, s: SystemRate) {
  const q = r.questions_per_conversation;
  const ingest_api = s.api_usd_per_mtok * r.mtok_per_conversation;
  const ingest_vm = s.vm_hours_per_mtok * r.mtok_per_conversation * s.vcpu * r.vcpu_hour_usd;
  const reads = q * (r.read_usd_per_question + r.query_usd_per_question + r.read_vm_usd_per_question);
  const judges = q * r.readers * (r.frontier_judge_usd + r.bridge_judge_usd);
  return { ingest_api, ingest_vm, reads, judges, total: ingest_api + ingest_vm + reads + judges };
}
export const floorPerConversation = (r: Rates) => r.questions_per_conversation * (r.floor_read_usd_per_question + r.readers * r.bridge_judge_usd);

/** Paid spend per kept conversation, by line, and stage 1 (two public conversations, all four rows). */
export function unitCosts(r: Rates) {
  const systems = Object.values(r.systems).map(s => systemPerConversation(r, s));
  const sum = (k: 'ingest_api' | 'ingest_vm' | 'reads' | 'judges') => systems.reduce((a, s) => a + s[k], 0);
  const lines = { mint: (r.mint_usd + r.regeneration_usd) / r.yield, ingest_api: sum('ingest_api'), ingest_vm: sum('ingest_vm'), reads: sum('reads'), judges: sum('judges'), floor: floorPerConversation(r) };
  const per_conversation = Object.values(lines).reduce((a, b) => a + b, 0);
  const stage1 = 2 * systems.reduce((a, s) => a + s.total, 0) + 2 * floorPerConversation(r) + r.stage1_overhead_usd;
  return { lines, per_conversation, stage1 };
}

export interface Progress { spent_usd: number; kept_done: number; stage1_done: boolean; crew_remaining_usd: number | null }
export const NO_PROGRESS: Progress = { spent_usd: 0, kept_done: 0, stage1_done: false, crew_remaining_usd: null };

/** Paid spend at N kept conversations, the expected all-in spend (no reserve), and the check-in projection at N. */
export function priceAt(n: number, r: Rates = STAGE0_RATES, p: Progress = NO_PROGRESS) {
  const u = unitCosts(r);
  const crew = Object.values(r.crew_usd).reduce((a, b) => a + b, 0);
  const paid = u.per_conversation * n + u.stage1;
  const remaining_paid = u.per_conversation * Math.max(0, n - p.kept_done) + (p.stage1_done ? 0 : u.stage1);
  const projection = p.spent_usd + remaining_paid * (1 + r.reserve) + (p.crew_remaining_usd ?? crew);
  return { n, paid: r2(paid), expected_all_in: r2(paid + crew), projection: r2(projection) };
}

/** The whole pricing.json: lines at N = 28 and 33, expected, ceiling and the check-in projection at the planned N. */
export function pricing(planned = N_CENTRAL, r: Rates = STAGE0_RATES, p: Progress = NO_PROGRESS) {
  const u = unitCosts(r);
  const crew = Object.values(r.crew_usd).reduce((a, b) => a + b, 0);
  const at = (n: number) => ({ ...Object.fromEntries(Object.entries(u.lines).map(([k, v]) => [k, r2(v * n)])), stage1: r2(u.stage1), ...priceAt(n, r) });
  const cap = priceAt(N_CAP, r);
  const check = priceAt(planned, r, p);
  return {
    schema: 'gbrain-evals/rs1-pricing/v1', rates: r, per_conversation: r2(u.per_conversation), stage1: r2(u.stage1), crew_usd: crew,
    central: at(N_CENTRAL), cap: at(N_CAP),
    expected: { n: N_CENTRAL, paid: priceAt(N_CENTRAL, r).paid, crew, all_in: priceAt(N_CENTRAL, r).expected_all_in },
    ceiling: { n: N_CAP, paid: cap.paid, reserve: r2(cap.paid * r.reserve), crew_cap: r.crew_cap_usd, all_in: r2(cap.paid * (1 + r.reserve) + r.crew_cap_usd) },
    checkin: { planned_n: planned, progress: p, projection: check.projection, line: RS1_CHECKIN_USD, over: check.projection > RS1_CHECKIN_USD },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const num = (name: string, fallback: number) => { const v = flag(name); if (v === undefined) return fallback; const x = Number(v); if (!Number.isFinite(x) || x < 0) { process.stderr.write(`pricing.ts: ${name} takes a non-negative number, not ${v}\n`); process.exit(2); } return x; };
  const g = STAGE0_RATES.systems.gbrain;
  const rates: Rates = { ...STAGE0_RATES, systems: { ...STAGE0_RATES.systems, gbrain: { ...g, api_usd_per_mtok: num('--gbrain-api-per-mtok', g.api_usd_per_mtok), vm_hours_per_mtok: num('--gbrain-hours-per-mtok', g.vm_hours_per_mtok) } } };
  const crewLeft = flag('--crew-remaining-usd');
  const progress: Progress = { spent_usd: num('--spent-usd', 0), kept_done: num('--kept-done', 0), stage1_done: args.includes('--stage1-done'), crew_remaining_usd: crewLeft === undefined ? null : num('--crew-remaining-usd', 0) };
  const out = pricing(num('--n', N_CENTRAL), rates, progress);
  const path = resolve(flag('--out') ?? PRICING_PATH);
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
  process.stdout.write(`expected $${out.expected.all_in} at N = ${out.expected.n}; ceiling $${out.ceiling.all_in} at N = ${out.ceiling.n}; check-in projection $${out.checkin.projection} at N = ${out.checkin.planned_n} (line $${RS1_CHECKIN_USD}); wrote ${path}\n`);
  if (out.checkin.over) { process.stderr.write(`RS1_CHECKIN: the projection $${out.checkin.projection} at N = ${out.checkin.planned_n} passes $${RS1_CHECKIN_USD}; GBEV-3 decides before more paid work\n`); process.exit(3); }
}

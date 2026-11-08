/**
 * RS1's money model (docs/benchmarks/2026-11-08-rs1-narrow-preregistration.md, "Money"): GBEV-48's option 2b cost model
 * at stage 0's measured rates, projected as all-in new spend (R71: paid calls, judges, VMs and crew credits).
 *
 *   bun eval/runner/rs1/pricing.ts [--n <planned N>] [--spent-usd <all-in spent so far>] [--astra-spent-usd <the part
 *     of it on the Astra line>] [--kept-done <conversations whose spend is in --spent-usd>] [--stage1-done]
 *     [--judge-check-done] [--crew-remaining-usd <n>] [--gbrain-api-per-mtok <usd>] [--gbrain-hours-per-mtok <h>]
 *     [--out <file>]
 *
 * It writes pricing.json (default eval/runner/rs1/pricing.json) with the expected all-in spend at N = 28, the ceiling
 * at the cap of 33, and the check-in projection at the planned N (28 before the pilot, N_final after it):
 *
 *   projection = spent-to-date + (paid still to spend) x 1.10 reserve + crew credits still to spend
 *
 * Two budget lines (R78 point 9, GBEV-3 from Garry, 2026-11-08: "If we use Astra, then feel free to double the eval
 * cost"): the Astra line is the whole judge check (every grader's calls) plus gpt-6-astra's share of counted judging; it
 * is reported beside the rest and does not count toward the $2,300 check-in. Everything else is the other line,
 * Opus's and gpt-4.1-mini's counted judging included, and the check-in projection runs on it alone.
 *
 * VM time is inside paid. --kept-done and --stage1-done need --spent-usd (exit 2 without it), because they take work out
 * of the remaining spend that only the spend to date can put back; --judge-check-done needs --astra-spent-usd for the
 * same reason, and --astra-spent-usd may not pass --spent-usd. It exits 3 with RS1_CHECKIN when the projection passes $2,300. After stage 1, the measured
 * rs1-stable ingest rates replace F6's f6-master placeholders through --gbrain-api-per-mtok and --gbrain-hours-per-mtok,
 * and both projections are recorded in the preregistration's amendments.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RS1_ASSUMPTIONS, rs1GatingJudgeUsd } from '../q1/cells/definitions.ts';

export const RS1_CHECKIN_USD = 2300;
export const N_CENTRAL = 28;
export const N_CAP = 33;
export const PRICING_PATH = resolve(import.meta.dir, 'pricing.json');

export const ASTRA_JUDGE = 'openai:gpt-6-astra';
export interface SystemRate { api_usd_per_mtok: number; vm_hours_per_mtok: number; vcpu: number }
/** A gating judge, how many of the readers' answers it grades per question, and its dollars per answer. */
export interface GatingJudge { judge: string; readers: number; usd: number }
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
  /**
   * Gating judgments per question, by judge (R78 as amended by GBEV-3: "Use Astra vs opus"): gpt-6-astra grades the Opus
   * reader's answers and claude-opus-5-5 grades Sol's and particle-1's, each at its own price (definitions.ts
   * rs1GatingJudgeUsd) until the judge check measures their tokens.
   */
  gating_judges: GatingJudge[];
  /** gpt-4.1-mini bridge judgment per answer. */
  bridge_judge_usd: number;
  /**
   * The judge check's calls per judge (judge-check.ts plan on public BEAM-1M at seed 20261108: 242 gold and corrupted
   * rubric calls, 80 stage 1 answers at 3.3 rubric items each, and about 320 event-ordering equivalence calls), each
   * priced as one call of a judgment.
   */
  judge_check_calls: number;
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
  gating_judges: [{ judge: ASTRA_JUDGE, readers: 1, usd: rs1GatingJudgeUsd(ASTRA_JUDGE) }, { judge: 'anthropic:claude-opus-5-5', readers: 2, usd: rs1GatingJudgeUsd('anthropic:claude-opus-5-5') }],
  bridge_judge_usd: 0.0028, judge_check_calls: 242 + 264 + 320, query_usd_per_question: 0.005, read_vm_usd_per_question: 0.004, readers: 3,
  systems: {
    gbrain: { api_usd_per_mtok: 1.16 * 1.36, vm_hours_per_mtok: 1.92, vcpu: 4 },
    'memory-bank': { api_usd_per_mtok: 1.72 * 1.01, vm_hours_per_mtok: 2.32, vcpu: 16 },
    'extract-first': { api_usd_per_mtok: 2.8 * 0.99, vm_hours_per_mtok: 1.74, vcpu: 16 },
  },
  stage1_overhead_usd: 5, reserve: 0.1,
  crew_usd: { prereg_pr: 150, run_orchestration: 100, custodian: 40, results_pr: 40, plan: 20 }, crew_cap_usd: 550,
};

/** GBEV-48's option 2b inputs: one frontier judgment per answer at GST-1365 census B ($113.31 for 3,301), no judge check. */
export const GBEV48_RATES: Rates = { ...STAGE0_RATES, gating_judges: [{ judge: 'census-b', readers: 3, usd: 113.31 / 3301 }], judge_check_calls: 0 };

const r2 = (x: number) => Math.round(x * 100) / 100;

/** The judge check's dollars: every candidate's calls by each gating judge and the bridge, all on the Astra line. */
export function judgeCheckUsd(r: Rates) {
  const calls = RS1_ASSUMPTIONS.gating_judge.calls;
  return r.judge_check_calls * (r.gating_judges.reduce((a, j) => a + j.usd / calls, 0) + r.bridge_judge_usd / calls);
}

/** One system row's paid spend per conversation, without the mint. */
export function systemPerConversation(r: Rates, s: SystemRate) {
  const q = r.questions_per_conversation;
  const ingest_api = s.api_usd_per_mtok * r.mtok_per_conversation;
  const ingest_vm = s.vm_hours_per_mtok * r.mtok_per_conversation * s.vcpu * r.vcpu_hour_usd;
  const reads = q * (r.read_usd_per_question + r.query_usd_per_question + r.read_vm_usd_per_question);
  const gating = (astra: boolean) => q * r.gating_judges.filter(j => (j.judge === ASTRA_JUDGE) === astra).reduce((a, j) => a + j.readers * j.usd, 0);
  const judges_astra = gating(true);
  const judges = gating(false) + q * r.readers * r.bridge_judge_usd;
  return { ingest_api, ingest_vm, reads, judges, judges_astra, total: ingest_api + ingest_vm + reads + judges + judges_astra };
}
export const floorPerConversation = (r: Rates) => r.questions_per_conversation * (r.floor_read_usd_per_question + r.readers * r.bridge_judge_usd);

/** Paid spend per kept conversation, by line, and stage 1 (two public conversations, all four rows). */
export function unitCosts(r: Rates) {
  const systems = Object.values(r.systems).map(s => systemPerConversation(r, s));
  const sum = (k: 'ingest_api' | 'ingest_vm' | 'reads' | 'judges' | 'judges_astra') => systems.reduce((a, s) => a + s[k], 0);
  const lines = { mint: (r.mint_usd + r.regeneration_usd) / r.yield, ingest_api: sum('ingest_api'), ingest_vm: sum('ingest_vm'), reads: sum('reads'), judges: sum('judges'), judges_astra: sum('judges_astra'), floor: floorPerConversation(r) };
  const per_conversation = Object.values(lines).reduce((a, b) => a + b, 0);
  const stage1 = 2 * systems.reduce((a, s) => a + s.total, 0) + 2 * floorPerConversation(r) + r.stage1_overhead_usd;
  return { lines, per_conversation, stage1, astra_per_conversation: lines.judges_astra, stage1_astra: 2 * lines.judges_astra, judge_check: judgeCheckUsd(r) };
}

/** Spend to date: astra_spent_usd is the part of spent_usd on the Astra line; judge_check_done takes the check out of the remaining spend. */
export interface Progress { spent_usd: number; kept_done: number; stage1_done: boolean; crew_remaining_usd: number | null; astra_spent_usd?: number; judge_check_done?: boolean }
export const NO_PROGRESS: Progress = { spent_usd: 0, kept_done: 0, stage1_done: false, crew_remaining_usd: null };

/**
 * Paid spend at N kept conversations on each line, the expected all-in spend (no reserve), the check-in projection at N
 * on the other line alone, and the Astra line's own projection.
 */
export function priceAt(n: number, r: Rates = STAGE0_RATES, p: Progress = NO_PROGRESS) {
  const u = unitCosts(r);
  const crew = Object.values(r.crew_usd).reduce((a, b) => a + b, 0);
  const astra = u.astra_per_conversation * n + u.stage1_astra + u.judge_check;
  const other = (u.per_conversation - u.astra_per_conversation) * n + u.stage1 - u.stage1_astra;
  const left = Math.max(0, n - p.kept_done);
  const remaining_other = (u.per_conversation - u.astra_per_conversation) * left + (p.stage1_done ? 0 : u.stage1 - u.stage1_astra);
  const remaining_astra = u.astra_per_conversation * left + (p.stage1_done ? 0 : u.stage1_astra) + (p.judge_check_done ? 0 : u.judge_check);
  const astraSpent = p.astra_spent_usd ?? 0;
  const projection = p.spent_usd - astraSpent + remaining_other * (1 + r.reserve) + (p.crew_remaining_usd ?? crew);
  return { n, paid: r2(other + astra), paid_other: r2(other), astra_line: r2(astra), expected_all_in: r2(other + astra + crew), projection: r2(projection), astra_projection: r2(astraSpent + remaining_astra * (1 + r.reserve)) };
}

/** The whole pricing.json: lines at N = 28 and 33, expected, ceiling and the check-in projection at the planned N. */
export function pricing(planned = N_CENTRAL, r: Rates = STAGE0_RATES, p: Progress = NO_PROGRESS) {
  const u = unitCosts(r);
  const crew = Object.values(r.crew_usd).reduce((a, b) => a + b, 0);
  const at = (n: number) => ({ ...Object.fromEntries(Object.entries(u.lines).map(([k, v]) => [k, r2(v * n)])), stage1: r2(u.stage1), judge_check: r2(u.judge_check), ...priceAt(n, r) });
  const central = priceAt(N_CENTRAL, r), cap = priceAt(N_CAP, r);
  const check = priceAt(planned, r, p);
  return {
    schema: 'gbrain-evals/rs1-pricing/v2', rates: r, per_conversation: r2(u.per_conversation), astra_per_conversation: r2(u.astra_per_conversation), stage1: r2(u.stage1),
    judge_check: { usd: r2(u.judge_check), window_cap_usd: r2(u.judge_check * 1.5), calls_per_judge: r.judge_check_calls }, crew_usd: crew,
    central: at(N_CENTRAL), cap: at(N_CAP),
    expected: { n: N_CENTRAL, paid: central.paid, astra_line: central.astra_line, other_line: central.paid_other, crew, all_in: central.expected_all_in },
    ceiling: { n: N_CAP, paid: cap.paid, astra_line: cap.astra_line, other_line: cap.paid_other, reserve: r2(cap.paid * r.reserve), crew_cap: r.crew_cap_usd, all_in: r2(cap.paid * (1 + r.reserve) + r.crew_cap_usd) },
    checkin: { planned_n: planned, progress: p, projection: check.projection, line: RS1_CHECKIN_USD, over: check.projection > RS1_CHECKIN_USD, counts: 'every line but the Astra line' },
    astra_line: { planned_n: planned, projection: check.astra_projection, counts: 'the whole judge check and gpt-6-astra\'s share of counted judging; outside the check-in' },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const num = (name: string, fallback: number) => { const v = flag(name); if (v === undefined) return fallback; const x = Number(v); if (!Number.isFinite(x) || x < 0) { process.stderr.write(`pricing.ts: ${name} takes a non-negative number, not ${v}\n`); process.exit(2); } return x; };
  const g = STAGE0_RATES.systems.gbrain;
  const rates: Rates = { ...STAGE0_RATES, systems: { ...STAGE0_RATES.systems, gbrain: { ...g, api_usd_per_mtok: num('--gbrain-api-per-mtok', g.api_usd_per_mtok), vm_hours_per_mtok: num('--gbrain-hours-per-mtok', g.vm_hours_per_mtok) } } };
  const crewLeft = flag('--crew-remaining-usd');
  const progress: Progress = { spent_usd: num('--spent-usd', 0), kept_done: num('--kept-done', 0), stage1_done: args.includes('--stage1-done'), crew_remaining_usd: crewLeft === undefined ? null : num('--crew-remaining-usd', 0),
    ...(flag('--astra-spent-usd') !== undefined ? { astra_spent_usd: num('--astra-spent-usd', 0) } : {}), ...(args.includes('--judge-check-done') ? { judge_check_done: true } : {}) };
  if (flag('--spent-usd') === undefined && (progress.kept_done > 0 || progress.stage1_done)) { process.stderr.write('pricing.ts: --kept-done and --stage1-done take completed work out of the remaining spend, so they need --spent-usd with the spend to date from the ledger\n'); process.exit(2); }
  if (progress.judge_check_done && progress.astra_spent_usd === undefined) { process.stderr.write('pricing.ts: --judge-check-done takes the judge check out of the remaining spend, so it needs --astra-spent-usd with the Astra line\'s spend to date from the ledger\n'); process.exit(2); }
  if ((progress.astra_spent_usd ?? 0) > progress.spent_usd) { process.stderr.write('pricing.ts: --astra-spent-usd is the part of --spent-usd on the Astra line, so it may not pass --spent-usd\n'); process.exit(2); }
  const out = pricing(num('--n', N_CENTRAL), rates, progress);
  const path = resolve(flag('--out') ?? PRICING_PATH);
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
  process.stdout.write(`expected $${out.expected.all_in} at N = ${out.expected.n} (Astra line $${out.expected.astra_line}, other paid $${out.expected.other_line}, crew $${out.expected.crew}); ceiling $${out.ceiling.all_in} at N = ${out.ceiling.n}; judge check $${out.judge_check.usd} (window cap $${out.judge_check.window_cap_usd}); check-in projection $${out.checkin.projection} at N = ${out.checkin.planned_n} without the Astra line (line $${RS1_CHECKIN_USD}); Astra line projection $${out.astra_line.projection}; wrote ${path}\n`);
  if (out.checkin.over) { process.stderr.write(`RS1_CHECKIN: the projection $${out.checkin.projection} at N = ${out.checkin.planned_n} passes $${RS1_CHECKIN_USD}; GBEV-3 decides before more paid work\n`); process.exit(3); }
}

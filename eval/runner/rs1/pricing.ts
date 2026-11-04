/**
 * RS1 pricing and gate A (GST-1154; plan v2 "Big decisions" 8 and the stage table; the preregistration's "Money").
 * Prices the whole program at size N (75 conversations) and O (200), with and without gbrain's think row, from Q1's and
 * F6's measured ledgers, and checks gate A: the projected total, at measured rates where they exist, must be at most
 * the approved hard cap / 1.1, or the plan goes back to GBEV-3 before any more spend.
 *
 *   bun eval/runner/rs1/pricing.ts [--out eval/runner/rs1/pricing.json]
 *
 * writes pricing.json (the committed file is this command's output byte for byte) and prints gate A's line, then the
 * options table the PR body shows (review d2: mint at $29 a conversation, conversation pass rates 1.0 and 0.9, with and
 * without the think row). When gate A fails at size N, the approved size, it writes the file first and then exits 3
 * through refuse() with RS1_GATE_A_FAIL (review d9): a higher cap or a dropped row is Garry's call, never this script's.
 *
 * STAGE0_INPUTS is the one edit point when stage 0's measured figures arrive (review F20): the mint and validate cost
 * per conversation, the share of minted conversations that pass the conversation gates, the share of items that need
 * regenerating, and the mean cl100k Mtok of a canonical chat file (ingest and VM time scale with it). Everything else
 * here is a measured rate from an earlier ledger, with its source beside it, or an approved fixed figure (the caps).
 * The mint line is conversations / pass rate x mint cost x (1 + regeneration rate). The 10% regeneration reserve stays
 * on top of it as the contingency, held on the ledger from the start, because stage 0's two conversations cannot bound
 * the regeneration rate of 75. The draft's derived "hard cap" (total x 1.2) is gone: the program caps are the approved
 * $7,000 (N) and $18,000 (O), and the stage 0 and stage 1 caps ($60 and $220) are fixed lines, never re-priced.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { exitCodeOf, refuse, renderMessage } from '../q1/scoreboard-errors.ts';

export const PRICING_SCHEMA = 'gbrain-evals/rs1-pricing/v1';
const ROOT = resolve(import.meta.dir, '../../..');
export const PRICING_PATH = resolve(import.meta.dir, 'pricing.json');

/** Stage 0's measured figures: the only lines to edit when they land. Until then, plan v2's estimates. */
export const STAGE0_INPUTS = {
  /** Mint and validate one conversation in custody: about $18 of generation plus about $1.5 of chunked abstention scans (plan v2). */
  mint_usd_per_conversation: 20,
  /** Share of minted conversations that pass the conversation gates (length, contamination, duplicate, floor). */
  conversation_pass_rate: 1,
  /** Share of items regenerated after a failed item gate (each regeneration re-mints that conversation's questions). */
  item_regeneration_rate: 0,
  /** Mean cl100k Mtok of a canonical chat file: the S2b ratio 1.069 (F6 prereg size table) until stage 0 measures RS1's. */
  mtok_per_conversation: 1.07,
};
export type Stage0Inputs = typeof STAGE0_INPUTS;

/** Approved figures (Garry, 2026-11-03, plan v2): never derived from the estimate. */
export const PROGRAM_CAP_USD = { N: 7000, O: 18000 } as const;
export const STAGE_CAP_USD = { stage0: 60, stage1: 220 } as const;
export const SIZES = { N: 75, O: 200 } as const;
/** Gate A's margin: the projection must leave 10% of the cap unspent. */
export const GATE_A_FACTOR = 1.1;

const OPUS = 'anthropic:claude-opus-5-5', SOL = 'openai:gpt-6.1-sol', PARTICLE = 'particle:particle-1';
const MINI = 'openai:gpt-4.1-mini', HAIKU = 'anthropic:claude-haiku-5-5', GEMINI = 'gemini:gemini-3.8-flash';
const COMPONENT = ['gbrain-defaults', 'ext-extract-first', 'ext-memory-bank', 'ext-temporal-graph', 'baseline-hybrid'] as const;

/** Measured rates (draft v2 of 2026-11-03, after the /autoplan review's F2, F3, F5, F11, F22 and F23), keyed by kind and model id. */
export const ASSUMPTIONS = {
  questions_per_conversation: 20,
  /** F6 prereg :37, :195; q1-cells.json assumptions (ext-extract-first common, ext-memory-bank recipe); F6 dry run (ext-temporal-graph 0.31.2). */
  ingest_usd_per_mtok: { 'gbrain-defaults': 0.08 + 1.08, 'ext-extract-first': 2.8, 'ext-memory-bank': 1.72, 'ext-temporal-graph': 4.01, 'baseline-hybrid': 0.14 },
  /** Q1 prereg :1259, :1312-1314 (A23's measured ratios); ext-temporal-graph's rate is already F6-measured. */
  ingest_measured_factor: { 'gbrain-defaults': 1.36, 'ext-extract-first': 0.99, 'ext-memory-bank': 1.01, 'ext-temporal-graph': 1.0, 'baseline-hybrid': 1.69 },
  /** q1-cells.json probe_usd caps. */
  probe_usd_per_conversation: { 'gbrain-defaults': 1.3, 'ext-temporal-graph': 0.13 } as Record<string, number>,
  /** F6 prereg :195; q1-cells.json hours_per_mtok. */
  ingest_hours_per_mtok: { 'gbrain-defaults': 1.92, 'ext-extract-first': 1.74, 'ext-memory-bank': 2.32, 'ext-temporal-graph': 2.26 },
  vcpus: { 'gbrain-defaults': 4, 'ext-extract-first': 16, 'ext-memory-bank': 16, 'ext-temporal-graph': 16 } as Record<string, number>,
  /** The proof-wave cost formula. */
  usd_per_vcpu_hour: 0.05,
  /** q1-cells.json reader assumptions; particle-1 is U5's measured reading (2026-11-01 calibration README: $0.069455 / 20 readings). */
  reading_8k: { [OPUS]: (8000 * 1.47 + 180) * 4 / 1e6 + 720 * 20 / 1e6, [SOL]: (8000 * 0.975 + 130) * 2 / 1e6 + 155 * 10 / 1e6, [PARTICLE]: 0.0695 / 20 },
  reading_none: { [OPUS]: 250 * 1.47 * 4 / 1e6 + 720 * 20 / 1e6, [SOL]: 250 * 2 / 1e6 + 155 * 10 / 1e6, [PARTICLE]: 0.0012 },
  component_systems: [...COMPONENT],
  /** gbrain's query call (q1 assumption) plus the servers' own query-time LLM calls (estimate). */
  query_usd_per_question: 0.00176 + 3 * 0.003,
  /** The S2b agent assumption; Q1's measured file-agent ratio 1.12. */
  file_agent: { [OPUS]: 73000 * 4 / 1e6 + 2000 * 20 / 1e6, [SOL]: 73000 * 2 / 1e6 + 2000 * 10 / 1e6, [PARTICLE]: 73000 * 1.05 * 0.25 / 1e6 + 2000 * 1 / 1e6, measured_factor: 1.12 },
  /** The S2b think assumption; no measured ratio, 1.25 assumed. */
  think: { [OPUS]: 55200 * 4 / 1e6 + 1840 * 20 / 1e6, [SOL]: 55200 * 2 / 1e6 + 1840 * 10 / 1e6, [PARTICLE]: 55200 * 0.25 / 1e6 + 1840 * 1 / 1e6, measured_factor: 1.25 },
  /** F6's dry run measured gpt-4.1-mini at $0.0028 an answer; claude-haiku-5-5 at twice its list line; the sensitivity judge is an estimate. */
  judge_per_answer: { [MINI]: 0.0028, [HAIKU]: 2 * 3 * (900 * 0.1 + 60 * 0.5) / 1e6, [GEMINI]: 0.008 },
  /** The sensitivity judge's conversation sample, chosen by seed before minting. */
  sensitivity_share: 0.3,
  regen_reserve_share: 0.10,
  read_vm_usd_per_question_row: 0.004,
};

const r2 = (x: number) => Math.round(x * 100) / 100;
const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);

/** Gate A at a cap: the line is cap / 1.1, headroom what the projection leaves under it (negative: the shortfall). */
export function gateA(totalUsd: number, capUsd: number) {
  const line = r2(capUsd / GATE_A_FACTOR);
  return { program_cap_usd: capUsd, line_usd: line, pass: totalUsd <= capUsd / GATE_A_FACTOR, headroom_usd: r2(line - totalUsd) };
}

export function price(size: keyof typeof SIZES, withThink: boolean, s0: Stage0Inputs = STAGE0_INPUTS) {
  const A = ASSUMPTIONS, n = SIZES[size];
  const q = n * A.questions_per_conversation, L = s0.mtok_per_conversation;
  const readers = (x: Record<string, number>) => x[OPUS] + x[SOL] + x[PARTICLE];
  const ingestBy = Object.fromEntries(COMPONENT.map(k => [k, r2(n * (A.ingest_usd_per_mtok[k] * L * A.ingest_measured_factor[k] + (A.probe_usd_per_conversation[k] ?? 0)))]));
  const ingest = sum(Object.values(ingestBy));
  const vm = sum(Object.entries(A.ingest_hours_per_mtok).map(([k, h]) => n * h * L * A.vcpus[k] * A.usd_per_vcpu_hour));
  const component = q * (A.component_systems.length * readers(A.reading_8k) + A.query_usd_per_question);
  const none = q * readers(A.reading_none);
  const agent = q * readers(A.file_agent) * A.file_agent.measured_factor;
  const think = withThink ? q * readers(A.think) * A.think.measured_factor : 0;
  const rows = 7 + (withThink ? 1 : 0);
  const judges = q * rows * (2 * A.judge_per_answer[MINI] + 2 * A.judge_per_answer[HAIKU]);
  const sensitivity = q * A.sensitivity_share * (rows - 2) * 2 * A.judge_per_answer[GEMINI];
  const readVm = q * rows * A.read_vm_usd_per_question_row;
  const mint = n / s0.conversation_pass_rate * s0.mint_usd_per_conversation * (1 + s0.item_regeneration_rate);
  const stages = ([
    ['0', 'Pricing pilot on public data (mint cost, gate pass rates, chunked abstention scan); fixed stage cap', STAGE_CAP_USD.stage0],
    ['1', 'Dry run of every frozen configuration through the RS1 cell path on 5 public BEAM-1M dev conversations; judge check; same-build check at the freeze pin; fixed stage cap', STAGE_CAP_USD.stage1],
    ['2', 'Mint and validate in custody: conversations / pass rate x mint cost x (1 + item regeneration rate)', mint],
    ['2', 'Regeneration reserve, 10% of the mint line, the contingency on top of the measured regeneration rate (held on the ledger from the start)', mint * A.regen_reserve_share],
    ['3', 'Ingest, API (five stores)', ingest],
    ['3', 'Ingest, VM time', vm],
    ['4', 'Reads: five 8k stores x three readers, plus system query calls', component],
    ['4', 'Reads: file agent x three agents', agent],
    ...(withThink ? [['4', 'Reads: gbrain think (whole system) x three readers', think]] : []),
    ['4', 'Reads: no-memory floor', none],
    ['4', 'Reads: VM time', readVm],
    ['5', 'Judges (held on the ledger from the start)', judges],
    ['5', 'Sensitivity judge, 30% conversation sample (held from the start)', sensitivity],
  ] as Array<[string, string, number]>).map(([stage, what, est]) => ({ stage, what, est: r2(est) }));
  const total = r2(sum(stages.map(x => x.est)));
  return { conversations: n, questions: q, with_gbrain_think: withThink, ingest_by_system: ingestBy, stages, total_estimate: total, gate_a: gateA(total, PROGRAM_CAP_USD[size]) };
}

/** Review d2: mint at $29 a conversation (the Captain's stage 0 report), at pass rates 1.0 and 0.9, with and without think, at size N. */
export function options(s0: Stage0Inputs = STAGE0_INPUTS) {
  return [1, 0.9].flatMap(rate => [true, false].map(withThink => {
    const p = price('N', withThink, { ...s0, mint_usd_per_conversation: 29, conversation_pass_rate: rate });
    return { mint_usd_per_conversation: 29, conversation_pass_rate: rate, item_regeneration_rate: s0.item_regeneration_rate, with_gbrain_think: withThink, total_estimate: p.total_estimate, gate_a: p.gate_a };
  }));
}

export function pricing(s0: Stage0Inputs = STAGE0_INPUTS) {
  return {
    schema: PRICING_SCHEMA, stage0_inputs: s0, assumptions: ASSUMPTIONS, program_cap_usd: PROGRAM_CAP_USD, stage_cap_usd: STAGE_CAP_USD, gate_a_factor: GATE_A_FACTOR,
    N: price('N', true, s0), N_without_think: price('N', false, s0), O: price('O', true, s0), O_without_think: price('O', false, s0), options: options(s0),
  };
}

export const pricingText = (s0: Stage0Inputs = STAGE0_INPUTS) => JSON.stringify(pricing(s0), null, 1) + '\n';

const usd = (x: number) => `$${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const gateLine = (label: string, p: { total_estimate: number; gate_a: ReturnType<typeof gateA> }) =>
  `gate A ${p.gate_a.pass ? 'pass' : 'FAIL'}: ${label} projected ${usd(p.total_estimate)} against ${usd(p.gate_a.line_usd)} (cap ${usd(p.gate_a.program_cap_usd)} / ${GATE_A_FACTOR}); ${p.gate_a.pass ? 'headroom' : 'shortfall'} ${usd(Math.abs(p.gate_a.headroom_usd))}`;

/** The refusal a failed gate A at size N exits with, after pricing.json is written. */
export function gateAFailure(p: ReturnType<typeof price>, artifact: string) {
  return refuse({
    code: 'RS1_GATE_A_FAIL',
    message: `gate A fails: the projected N total ${usd(p.total_estimate)} is above ${usd(p.gate_a.line_usd)} (the ${usd(p.gate_a.program_cap_usd)} cap / ${GATE_A_FACTOR}) by ${usd(-p.gate_a.headroom_usd)}`,
    why: 'plan v2 ("Money") requires the projected total, at measured rates where they exist, to be at most the hard cap / 1.1 before the program spends further; otherwise the plan comes back to GBEV-3',
    fix: { next: 'ask_user', user_message: "bring the projection to GBEV-3; a higher cap or a dropped row is Garry's", verify: ['bun', 'eval/runner/rs1/pricing.ts'] },
    artifact,
    state: { projected_total_usd: p.total_estimate, gate_line_usd: p.gate_a.line_usd, shortfall_usd: r2(-p.gate_a.headroom_usd), side_effects: 'none: pricing.json rewritten; nothing spent or reserved' },
  });
}

/** Writes pricing.json and prints gate A's lines; returns the exit status (3 with RS1_GATE_A_FAIL on stderr when gate A fails at N). */
export function main(argv: string[], s0: Stage0Inputs = STAGE0_INPUTS, io = { log: (s: string) => console.log(s), error: (s: string) => console.error(s) }): number {
  const i = argv.indexOf('--out');
  const out = resolve(i >= 0 ? argv[i + 1] : PRICING_PATH);
  const text = pricingText(s0);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  const p = JSON.parse(text) as ReturnType<typeof pricing>;
  io.log(`wrote ${relative(ROOT, out) || out}`);
  for (const [label, v] of [['N', p.N], ['N without think', p.N_without_think], ['O', p.O], ['O without think', p.O_without_think]] as const) io.log(gateLine(label, v));
  for (const o of p.options) io.log(gateLine(`option: mint $29, pass rate ${o.conversation_pass_rate.toFixed(1)}, ${o.with_gbrain_think ? 'with' : 'without'} think, N`, o));
  if (p.N.gate_a.pass) return 0;
  const e = gateAFailure(p.N, relative(ROOT, out) || out);
  io.error(renderMessage(e.op));
  return exitCodeOf(e.op);
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));

/**
 * RS1 cell definitions: the ranking set's frozen configurations (docs/benchmarks/2026-11-04-rs1-ranking-set-preregistration.md,
 * GST-1154 PR 2), built with Q1's tooling (definitions.ts makeCell, estimateCell, definitionProblems) and F6's lease
 * helpers, so an RS1 cell is a Q1 cell definition the same runner executes:
 * `bun eval/runner/q1/cell.ts run --cell <id> --manifest rs1`.
 *
 *   Counted (set RS1, sealed, five conversations per launch unit):
 *     family A at 8,000 tokens: gbrain at the repository pin (configuration rs1-master) with arm P's retrieval, the
 *       extract-first server (common), the memory-bank server 1.1.0 (recipe-1.1) and the temporal-graph library 0.31.2
 *       (shipped-0.31); readers claude-opus-5-5 and gpt-6.1-sol.
 *     family B: gbrain's own think on the same brain, under arm P's six search keys (one ingest per conversation), and
 *       the file agent (40 turns, uncapped grep); readers claude-opus-5-5, gpt-6.1-sol and particle-1.
 *     descriptive: the hybrid baseline and the no-memory floor at 8,000 tokens.
 *   Stage 1 (block RS1-dry, public BEAM-1M dev data, at most $220): every frozen configuration, plus arm P at F6's pin
 *     (the same-build check), on five dev conversations (RS1-dev); the file agent and think on two of them (RS1-dev2).
 *   Re-read plans: particle-1 re-reads every packed arm's frozen contexts byte for byte (reread-cell.ts), each with its
 *     own estimate; they run only in paid windows.
 *
 * Every arm carries a judging plan (eval/runner/q1/cells/judging.ts): claude-opus-5-5's answers are scored by gpt-4.1-mini
 * (the BEAM instrument's canonical judge), gpt-6.1-sol's by claude-haiku-5-5, and particle-1's by the mean of both, so
 * no judge grades its own family's rows (GST-767) and particle-1 never judges.
 *
 * `bun eval/runner/q1/cells/rs1.ts` regenerates rs1-cells.json; a test fails when the committed file is stale.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { JudgingPlan } from './judging.ts';
import type { ScoreboardMessage } from '../scoreboard-errors.ts';
import {
  ALL_SETS, ASSUMPTIONS, estimateCell, F6_ASSUMPTIONS, makeCell, MANIFEST_SCHEMA, priceOf, RS1_ASSUMPTIONS,
  type ArmSpec, type BlockId, type CellDefinition, type CellEstimate, type Manifest, type RS1BlockId, type SetId,
} from './definitions.ts';
import { extractionCapUsd, F6_ARMS, withHours, withLease } from './f6.ts';

export const RS1_MANIFEST_PATH = resolve(import.meta.dir, 'rs1-cells.json');
export const RS1_PREREGISTRATION = 'docs/benchmarks/2026-11-04-rs1-ranking-set-preregistration.md';
export const RS1_CAMPAIGN_ID = 'q1-scoreboard-rs1-ranking-set';
/** The program's hard cap and its stage caps (GBEV-3, 2026-11-03); a change to any of them goes back to GBEV-3. */
export const RS1_CAP_USD = 7000;
export const RS1_STAGE0_CAP_USD = 60;
export const RS1_STAGE1_CAP_USD = 220;
export const RS1_CONVERSATIONS_PER_UNIT = 5;

export const OPUS = 'anthropic:claude-opus-5-5';
export const SOL = 'openai:gpt-6.1-sol';
export const PARTICLE = 'particle:particle-1';
export const RS1_READERS = [OPUS, SOL, PARTICLE];
/** The counted judges of each reader's answers; an answer read by particle-1 scores the mean of its two judges. */
export const RS1_JUDGES: Record<string, string[]> = { [OPUS]: ['openai:gpt-4.1-mini'], [SOL]: ['anthropic:claude-haiku-5-5'], [PARTICLE]: ['openai:gpt-4.1-mini', 'anthropic:claude-haiku-5-5'] };
/** The sensitivity judge's seeded sample (eval/runner/rs1/judge.ts sensitivity): 30% of RS1's conversations, smallest sha256(seed, NUL, id) first. */
export const RS1_SENSITIVITY = { seed: 'rs1-sensitivity', share: 0.3 };
/** The judge check's fallback judge (eval/runner/rs1/judge.ts check), priced per answer at RS1_ASSUMPTIONS.check_judge_usd_per_answer. */
export const RS1_CHECK_JUDGE = 'gemini:gemini-3.8-flash';

const judging = (readers: string[]): JudgingPlan => ({ by_reader: Object.fromEntries(readers.map(r => [r, RS1_JUDGES[r]])) });
const PACKED_READERS = [OPUS, SOL];
const WHOLE_READERS = [OPUS, SOL, PARTICLE];
/** A packed arm's plan also names particle-1, which re-reads its frozen contexts. */
const PACKED_JUDGING = judging([...PACKED_READERS, PARTICLE]);

const p = (): ArmSpec => ({ id: 'p', mode: 'packed', budget: 8000, label: F6_ARMS.p.label, retrieval: F6_ARMS.p.retrieval, readers: PACKED_READERS, judging: PACKED_JUDGING });
const b8 = (): ArmSpec => ({ id: 'component-b8000', mode: 'packed', budget: 8000, label: 'component, 8,000 tokens', readers: PACKED_READERS, judging: PACKED_JUDGING });
const think = (): ArmSpec => ({ id: 'whole-think', mode: 'own-answer', variant: 'think', label: 'gbrain think on the same brain, under arm P\'s six search keys', readers: WHOLE_READERS, judging: judging(WHOLE_READERS) });
const agent = (): ArmSpec => ({ id: 'whole-agent', mode: 'agent', label: 'file agent, uncapped grep, 40 turns', readers: WHOLE_READERS, judging: judging(WHOLE_READERS) });

/** No write-to-queryable probes on any RS1 cell. */
const noProbes = (set: SetId) => ({ sample: 0, seed: `rs1-probes-${set.toLowerCase()}`, conversations: 0 });
const cell = (set: SetId, block: RS1BlockId, system: string, configuration: string, arms: ArmSpec[]) => withHours(withLease(makeCell(set, system, configuration, arms, {
  block, probes: noProbes(set), ...(set === 'RS1' ? { shards: ALL_SETS.RS1.conversations / RS1_CONVERSATIONS_PER_UNIT } : {}),
  ...(system === 'gbrain-defaults' ? { launchEnv: { GBRAIN_F6_EXTRACT_CAP_USD: String(extractionCapUsd(set)) } } : {}),
})));

/** RS1's counted cells: family A, family B, then the descriptive rows. */
export function generateRS1Cells(): CellDefinition[] {
  return [
    cell('RS1', 'RS1-8k', 'gbrain-defaults', 'rs1-master', [p(), think()]),
    cell('RS1', 'RS1-8k', 'ext-extract-first', 'common', [b8()]),
    cell('RS1', 'RS1-8k', 'ext-memory-bank', 'recipe-1.1', [b8()]),
    cell('RS1', 'RS1-8k', 'ext-temporal-graph', 'shipped-0.31', [b8()]),
    cell('RS1', 'RS1-whole', 'baseline-file-agent', 'baseline', [agent()]),
    cell('RS1', 'RS1-desc', 'baseline-hybrid', 'baseline', [b8()]),
    cell('RS1', 'RS1-desc', 'baseline-none', 'baseline', [b8()]),
  ];
}

/** Stage 1 (review d1): every frozen configuration and the same-build check on RS1-dev; think and the file agent on RS1-dev2. */
export function generateRS1Stage1Cells(): CellDefinition[] {
  const two = { kind: 'conversations' as const, conversations: ALL_SETS['RS1-dev2'].only_conversations! };
  return [
    cell('RS1-dev', 'RS1-dry', 'gbrain-defaults', 'rs1-master', [p(), { ...think(), set: 'RS1-dev2', questions: two }]),
    cell('RS1-dev', 'RS1-dry', 'gbrain-defaults', 'f6-master', [p()]),
    cell('RS1-dev', 'RS1-dry', 'ext-extract-first', 'common', [b8()]),
    cell('RS1-dev', 'RS1-dry', 'ext-memory-bank', 'recipe-1.1', [b8()]),
    cell('RS1-dev', 'RS1-dry', 'ext-temporal-graph', 'shipped-0.31', [b8()]),
    cell('RS1-dev', 'RS1-dry', 'baseline-hybrid', 'baseline', [b8()]),
    cell('RS1-dev', 'RS1-dry', 'baseline-none', 'baseline', [b8()]),
    cell('RS1-dev2', 'RS1-dry', 'baseline-file-agent', 'baseline', [agent()]),
  ];
}

export interface RereadPlan { id: string; cell: string; arm: string; arm_cell_id: string; reader: string; set: SetId; block: BlockId; judges: string[]; estimate: CellEstimate }

/**
 * particle-1's re-read of each packed arm (eval/runner/q1/reread-cell.ts, under rereadCellId's id): every frozen
 * context read once and judged by its planned judges, priced by estimateCell's reader and judge lines with particle-1
 * as the arm's only reader.
 */
export function rereadPlans(cells: CellDefinition[]): RereadPlan[] {
  return cells.flatMap(c => c.arms.filter(a => a.mode === 'packed').map(a => {
    const e = estimateCell({ ...c, arms: [{ ...a, readers: [PARTICLE], reader_replicates: {} }] });
    const lines = { readers: e.lines.readers ?? 0, judges: e.lines.judges ?? 0 };
    return { id: `${a.cell_id}.reread-${PARTICLE.replace(/[^a-z0-9.-]+/gi, '-')}`, cell: c.id, arm: a.id, arm_cell_id: a.cell_id, reader: PARTICLE, set: a.set, block: c.block,
      judges: a.judging!.by_reader[PARTICLE], estimate: { usd: Math.round((lines.readers + lines.judges) * 100) / 100, lines } };
  }));
}

/** The sensitivity sample's conversations: RS1's ids rs1-001 to rs1-075, the 30% with the smallest sha256(seed, NUL, id). */
export function sensitivityConversations(): string[] {
  const ids = Array.from({ length: ALL_SETS.RS1.conversations }, (_, i) => `rs1-${String(i + 1).padStart(3, '0')}`);
  const rank = (id: string) => createHash('sha256').update(`${RS1_SENSITIVITY.seed}\u0000${id}`).digest('hex');
  return ids.sort((a, b) => (rank(a) < rank(b) ? -1 : 1)).slice(0, Math.ceil(ids.length * RS1_SENSITIVITY.share)).sort();
}

const RS1_BLOCKS: Record<RS1BlockId, string> = {
  'RS1-dry': 'RS1 stage 1 (public BEAM-1M dev conversations; every frozen configuration and the same-build check)',
  'RS1-8k': 'RS1 family A at 8,000 tokens (gbrain arm P and think on one brain, the three servers)',
  'RS1-whole': 'RS1 family B baseline (the file agent)',
  'RS1-desc': 'RS1 descriptive rows (hybrid baseline, no-memory floor)',
};

/**
 * The judge check's allowance in stage 1's estimate: the fallback judge grading every stage 1 answer, the re-reads'
 * included, an upper bound on its keyed and agreement subsets (judge.ts check prices the actual rows before it runs).
 */
export function stage1JudgeCheck(smoke: CellDefinition[], rereads: RereadPlan[]) {
  const answers = smoke.flatMap(c => c.arms.filter(a => a.mode !== 'retrieval-only').map(a => ALL_SETS[a.set].questions * a.readers.length)).reduce((s, n) => s + n, 0)
    + rereads.filter(r => r.block === 'RS1-dry').reduce((s, r) => s + ALL_SETS[r.set].questions, 0);
  const perAnswer = RS1_ASSUMPTIONS.check_judge_usd_per_answer;
  return { judge: RS1_CHECK_JUDGE, answers, usd_per_answer: perAnswer, usd: Math.round(answers * perAnswer * 100) / 100 };
}

export interface RS1Manifest extends Manifest {
  rs1_assumptions: typeof RS1_ASSUMPTIONS; f6_assumptions: typeof F6_ASSUMPTIONS; campaign_id: string;
  stage0_cap_usd: number; stage1_cap_usd: number; stage1_estimate_usd: number; stage1_judge_check: ReturnType<typeof stage1JudgeCheck>;
  judges: Record<string, string[]>; reread_plans: RereadPlan[]; sensitivity_sample: { seed: string; share: number; conversations: string[] };
}

export function buildRS1Manifest(): RS1Manifest {
  const cells = generateRS1Cells();
  const smoke = generateRS1Stage1Cells();
  const rereads = [...rereadPlans(cells), ...rereadPlans(smoke)];
  const check = stage1JudgeCheck(smoke, rereads);
  const round = (x: number) => Math.round(x * 100) / 100;
  const blockUsd = (id: RS1BlockId) => round([...cells, ...smoke].filter(c => c.block === id).reduce((s, c) => s + c.estimate.usd, 0) + rereads.filter(r => r.block === id).reduce((s, r) => s + r.estimate.usd, 0) + (id === 'RS1-dry' ? check.usd : 0));
  // A counted block stops at 1.5 times its estimate, or at its units' leases where they hold more; stage 1 stops at its own cap.
  const blocks = (Object.keys(RS1_BLOCKS) as RS1BlockId[]).map(id => ({ id: id as BlockId, label: RS1_BLOCKS[id], plan_usd: blockUsd(id), estimate_usd: blockUsd(id),
    cap_usd: id === 'RS1-dry' ? RS1_STAGE1_CAP_USD : round(Math.max(blockUsd(id) * 1.5, cells.filter(c => c.block === id).reduce((s, c) => s + c.lease!.usd * c.shards, 0))) }));
  const models = [...RS1_READERS, ...new Set(Object.values(RS1_JUDGES).flat()), F6_ASSUMPTIONS.extraction.model, 'openai:gpt-6-luna'].map(m => [m, priceOf(m)] as const);
  const sets = [...new Set([...cells, ...smoke].map(c => c.set))].map(s => ALL_SETS[s]);
  return {
    schema: MANIFEST_SCHEMA, generated_by: 'bun eval/runner/q1/cells/rs1.ts', preregistration: RS1_PREREGISTRATION, readers: RS1_READERS, effort: 'medium',
    prices: Object.fromEntries(models.sort(([a], [b]) => (a < b ? -1 : 1))), assumptions: ASSUMPTIONS, f6_assumptions: F6_ASSUMPTIONS, rs1_assumptions: RS1_ASSUMPTIONS,
    sets, blocks, cells, smoke_cells: smoke,
    total_usd: round(blocks.filter(b => b.id !== 'RS1-dry').reduce((s, b) => s + b.estimate_usd, 0)), plan_total_usd: RS1_CAP_USD,
    cap_usd: RS1_CAP_USD - RS1_STAGE0_CAP_USD - RS1_STAGE1_CAP_USD, stage0_cap_usd: RS1_STAGE0_CAP_USD, stage1_cap_usd: RS1_STAGE1_CAP_USD,
    stage1_estimate_usd: blocks.find(b => b.id === 'RS1-dry')!.estimate_usd, stage1_judge_check: check, campaign_id: RS1_CAMPAIGN_ID, judges: RS1_JUDGES, reread_plans: rereads,
    sensitivity_sample: { ...RS1_SENSITIVITY, conversations: sensitivityConversations() },
  };
}

/** Stage 1's refusal (review d10): its estimate above its fixed cap stops `cell.ts plan --manifest rs1` before any campaign is written. */
export function stage1OverCap(m: Pick<RS1Manifest, 'stage1_estimate_usd' | 'stage1_cap_usd'>): ScoreboardMessage | null {
  if (m.stage1_estimate_usd <= m.stage1_cap_usd) return null;
  return {
    code: 'RS1_STAGE1_OVER_CAP',
    message: `stage 1 is estimated at $${m.stage1_estimate_usd.toFixed(2)}, above its fixed $${m.stage1_cap_usd.toFixed(2)} cap by $${(m.stage1_estimate_usd - m.stage1_cap_usd).toFixed(2)}`,
    why: 'stage 1\'s cap is fixed in the preregistration (GBEV-3, 2026-11-03); a larger stage 1 or a smaller scope is GBEV-3\'s call, never the planner\'s',
    fix: { next: 'ask_user', user_message: 'bring the stage 1 estimate and its lines (rs1-cells.json blocks RS1-dry) to GBEV-3', verify: ['bun', 'eval/runner/q1/cell.ts', 'plan', '--manifest', 'rs1'] },
    state: { stage1_estimate_usd: m.stage1_estimate_usd, stage1_cap_usd: m.stage1_cap_usd, side_effects: 'none: no campaign manifest written, nothing reserved' },
  };
}

export const rs1ManifestText = (m: RS1Manifest = buildRS1Manifest()) => JSON.stringify(m, null, 2) + '\n';
export const loadRS1Manifest = (path = RS1_MANIFEST_PATH) => JSON.parse(readFileSync(path, 'utf8')) as RS1Manifest;

if (import.meta.main) {
  writeFileSync(RS1_MANIFEST_PATH, rs1ManifestText());
  const m = buildRS1Manifest();
  console.log(`eval/runner/q1/cells/rs1-cells.json written (${m.cells.length} cells, ${m.smoke_cells.length} stage 1 cells, ${m.reread_plans.length} re-read plans; estimate $${m.total_usd}, stage 1 $${m.stage1_estimate_usd} of $${m.stage1_cap_usd})`);
}

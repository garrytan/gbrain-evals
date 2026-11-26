#!/usr/bin/env bun
/**
 * The weekly held-out line's pilot and judge check on public dev worlds (preregistration
 * docs/benchmarks/2026-11-23-weekly-outcome-line-preregistration.md, "Pilots (R111) and the quick look (R112)" and
 * "Readers and judges"), before launch amendment A. It plans, writes the campaigns for and reads back the cells the
 * weekly generator builds for public worlds (eval/runner/q1/cells/weekly-line.ts generateWeeklyLinePilotCells and
 * generateWeeklyLineJudgeCheckCells); it never calls a provider.
 *
 *   bun eval/runner/weekly-line/pilot.ts plan      [--length standard|long|alias] [--gbrain <release>@<commit>] [--world-end <Sunday>] [--json]
 *   bun eval/runner/weekly-line/pilot.ts campaigns [--length standard|long|alias] --out <dir> --window-granted <unit> [--grep-cell <dir>... | --misspelling-stage]
 *                                                  --window-cap-usd <the window's cap> --world-end <Sunday> [--gbrain <release>@<commit>]
 *   bun eval/runner/weekly-line/pilot.ts report    [--length standard|long|alias] --cell <cell out dir>... [--reread <re-read out dir>...] [--json]
 *
 * --length picks the pilot's worlds (weekly-line.ts WEEKLY_PILOT_SETS): standard, the default, runs the pilot on
 * bg1-dev-01 and the judge check on bg1-dev-02 and -03 at set BGW's caps; long runs them on bg1-dev-long-01, and
 * bg1-dev-long-02 and -03 (about 1,000,000 tokens each), at set BGW-long's caps, under campaign ids of their own; alias
 * runs them on bg1-dev-alias-01, and bg1-dev-alias-02 and -03 (changing-facts-gen@3's described subjects, about 200,000
 * tokens each), at set BGW's caps, under campaign ids of its own. Without --length the length is WEEKLY_PILOT_LENGTH_ENV's,
 * standard when that is unset too.
 *
 * The alias pilot follows the preregistration's 2026-11-25 amendment: the grep agent goes first, on all three alias worlds
 * (its pilot cell and the judge check's cell), and the other three rows launch only when the grep agent with
 * claude-opus-5-5 scores below CEILING over those three worlds against the construction labels (STOP_RULE), and the
 * judge check can draw its sample from those answers. Their ledgers say so (after_stop_rule), and campaigns writes them
 * only from --grep-cell's finished grep-agent cells of this manifest when that reading is complete and below the line;
 * without --grep-cell it writes the alias worlds' mint command, the grep agent's pilot, the judge check and its labelling
 * alone. One paid window covers the mint and both stages, at the caps Amendment 1 sets (weekly-line.ts
 * WEEKLY_ALIAS_PILOT_MONEY), and each stage refuses unless all three fit the window's cap together.
 *
 * plan is the dry run: every cell with its estimate, every ledger with its cap, and the totals, printed without calling
 * anything but `git ls-remote --tags` on gbrain's repository when --gbrain is not given (the newest release, R100).
 *
 * Money (R111). Each row's block budget is its rate a world (weekly-line.ts WEEKLY_LINE_RATES) times a block's 32 worlds;
 * its pilot spends at most a tenth of that, split between the row's cell (its campaign's ledger cap and the unit's lease)
 * and, on an 8,000-token row, particle-1's re-read (its own ledger cap). The judge check pauses at its own cap, split
 * between its grep-agent cell and the labelling pass (eval/runner/weekly-line/judge-check.ts label). The Claude Code quick
 * look is printed with its cap and as skipped (WEEKLY_LINE_QUICK_LOOK).
 *
 * campaigns writes one Q1 campaign per row and one for the judge check (cell.ts weeklyPilotCampaignManifest), each with
 * its own ledger at its cap, the re-read and labelling commands, and plan.json; it refuses without a granted window, and
 * when the caps together pass the window's cap. Every unit's command exports the world end and the gbrain build, and
 * runs only inside the window (cell.ts windowedRunGuard covers bg1-dev, the pilot's loader).
 *
 * report reads what each pilot unit and re-read wrote and prints what R111 asks of each row: that the part under test ran
 * (gbrain's facts block reached the reader's context; each server ingested the world and returned memories; ripgrep's
 * version is recorded and every answer the agent's loop produced comes from at least one grep call that returned, as the
 * preregistration words it; answers the loop never produced, such as reader errors and budget stops, are left out), every answer's gating verdict, each row's cost from the metering
 * proxy's usage fields, the grep agent's seconds, tokens and dollars per answer, the ceiling reading (the grep agent with
 * claude-opus-5-5 at 95% or more) and a week projected at the measured rates.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { JUDGED, gatherStaging, loadWeeklyPilotManifest, scheduledQuestions, weeklyPilotCampaignManifest, type CellUpstream } from '../q1/cell.ts';
import { readRecords } from '../memory-qa/records.ts';
import { BG1_FIXTURES_ROOT, loadBg1Dev } from '../memory-qa/corpus.ts';
import { BG1C_RATES } from '../q1/cells/bg1c.ts';
import { bg1JudgeOf, type CellDefinition } from '../q1/cells/definitions.ts';
import {
  WEEKLY_ALIAS_PILOT_MONEY, WEEKLY_ALIAS_STAGE2_MONEY, WEEKLY_ALIAS_STAGE2_SET, WEEKLY_LINE_BLOCK_WORLDS, WEEKLY_PILOT_SETS, WEEKLY_LINE_PILOT_FRACTION, WEEKLY_LINE_QUICK_LOOK, WEEKLY_LINE_ROWS, WEEKLY_PILOT_GBRAIN_ENV, WEEKLY_PILOT_LENGTH_ENV, weeklyLineBuildProblems,
  type WeeklyLineGbrainBuild, type WeeklyPilotManifest,
} from '../q1/cells/weekly-line.ts';
import { exitCodeOf, renderMessage, ScoreboardError } from '../q1/scoreboard-errors.ts';
import { findValues } from '../bg1/match.ts';
import type { MemoryQuestion } from '../memory-qa/corpus.ts';
import { answerKind, buildSample, goldLabel, JudgeCheckRefusal, poolAnswers, type PoolAnswer } from './judge-check.ts';
import { lsRemoteTags, newestGbrainRelease } from './runner.ts';
import { WL_BLOCK_WORLDS, WL_SYSTEMS, WL_WEEK_WORLDS, type WlRow } from './design.ts';

export class PilotError extends Error {}
const refuse = (code: string, m: string): never => { throw new PilotError(`${code}: ${m}`); };
const usd = (x: number) => `$${x.toFixed(2)}`;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** The order the pilot launches in, the weekly runner's: the extract-first server's ingest is the longest. */
export const PILOT_ORDER: readonly WlRow[] = ['extract-first', 'gbrain', 'memory-bank', 'grep-agent'];
/** The alias pilot's order (the 2026-11-25 amendment): the grep agent first, then the other rows only below the stop rule's line. */
export const ALIAS_PILOT_ORDER: readonly WlRow[] = ['grep-agent', 'extract-first', 'gbrain', 'memory-bank'];
/** A week's ceiling on the grep agent: 95% or more with claude-opus-5-5 moves the line to longer worlds (the preregistration's "Ceiling"). */
export const CEILING = 0.95;
/** The alias pilot's stop rule, in the amendment's words: the grep agent's claude-opus-5-5 accuracy pooled over the three alias worlds. */
export const STOP_RULE = 'If the Opus grep agent scores 95% or more on the pilot, the line stops and we publish the grep result.';
const OPUS = 'anthropic:claude-opus-5-5';
/** The top of the planned weekly range, and the share above it that goes back to the owner before week 1 (the plan's section 5). */
export const WEEK_RANGE_TOP_USD = 850;
export const WEEK_OVERRUN_SHARE = 0.2;

// ─── The plan ────────────────────────────────────────────────────────

/** One ledger of the pilot or the judge check: a campaign of one unit, a re-read, the labelling pass, or the alias worlds' mint. */
export interface PilotLedger {
  name: string; kind: 'campaign' | 'reread' | 'label' | 'mint'; row: WlRow | 'judge-check' | 'mint'; units: string[]; estimate_usd: number; cap_usd: number; campaign_id?: string;
  /** The alias pilot's rows after the grep agent: launched only when the stop rule leaves the line running. */
  after_stop_rule?: true;
}
export interface PilotPlan {
  length: WeeklyPilotManifest['length']; gbrain: WeeklyLineGbrainBuild; world_end: string | null; ledgers: PilotLedger[];
  /** Each cell with the questions it schedules on its worlds (scheduledCount), so a cell that would load no question shows 0 before any spend. */
  cells: Array<Pick<CellDefinition, 'id' | 'block' | 'system' | 'only_conversations' | 'expected_hours'> & { estimate_usd: number; lease_usd: number; questions: number }>;
  stop_rule: string | null;
  /** The alias pilot's one window (Amendment 1): the mint's, the grep agent's stage's and the other rows' stage's caps, at most window_usd together. */
  window: { mint_usd: number; grep_first_usd: number; after_stop_rule_usd: number; total_usd: number; window_usd: number } | null;
  /**
   * The alias pilot's stage 2 (Amendment 1's stage-2 lines): its cells with the questions each schedules, one campaign
   * ledger per row at the row's cap, and their caps together against the stage's own window. Null for the other lengths.
   */
  misspelling_stage: { cells: PilotPlan['cells']; ledgers: PilotLedger[]; cap_usd: number; window_usd: number } | null;
  caps: WeeklyPilotManifest['pilot_caps']; judge_check: WeeklyPilotManifest['judge_check']; quick_look: typeof WEEKLY_LINE_QUICK_LOOK;
  totals: { estimate_usd: number; cap_usd: number; pilot_cap_usd: number; judge_check_cap_usd: number; quick_look_cap_usd: number };
}

const rowOf = (c: Pick<CellDefinition, 'system'>): WlRow => WL_SYSTEMS[c.system];
const pilotCell = (m: WeeklyPilotManifest, row: WlRow) => m.cells.find(c => c.set === WEEKLY_PILOT_SETS[m.length].pilot && rowOf(c) === row)!;
/** Any Sunday: the world end moves a world's dates, never which of its questions a cell schedules. */
const COUNT_WORLD_END = '2026-11-22';
/** The questions a cell schedules (cell.ts scheduledQuestions), by id, on its worlds' committed template fixtures, keyless. */
const scheduledIds = (c: CellDefinition) => scheduledQuestions(c, loadBg1Dev({ root: BG1_FIXTURES_ROOT, only: new Set(c.only_conversations ?? []), worldEnd: COUNT_WORLD_END, keyless: true }), null).map(q => q.id);
const scheduledCount = (c: CellDefinition) => scheduledIds(c).length;
/** The committed questions of the named dev worlds, by id, keyless: a question's gold is its plan's at any world end. */
const devQuestions = (worlds: readonly string[]) => new Map(worlds.length ? loadBg1Dev({ root: BG1_FIXTURES_ROOT, only: new Set(worlds), worldEnd: COUNT_WORLD_END, keyless: true }).questions.map(q => [q.id, q] as const) : []);

/** The pilot's and the judge check's ledgers and totals for the manifest at one gbrain build. */
export function pilotPlan(m: WeeklyPilotManifest, worldEnd: string | null): PilotPlan {
  const judge = m.cells.find(c => c.block === 'BGW-judge')!;
  const rows: PilotLedger[] = [];
  const suffix = m.length === 'standard' ? '' : `-${m.length}`, alias = m.length === 'alias';
  for (const row of alias ? ALIAS_PILOT_ORDER : PILOT_ORDER) {
    const c = pilotCell(m, row), cap = m.pilot_caps[row], gated = alias && row !== 'grep-agent' ? { after_stop_rule: true as const } : {};
    rows.push({ name: `pilot-${row}`, kind: 'campaign', row, units: [c.id], estimate_usd: c.estimate.usd, cap_usd: cap.cells_cap_usd, campaign_id: `q1-scoreboard-weekly-pilot${suffix}-${row}`, ...gated });
    for (const r of m.reread_plans.filter(p => p.cell === c.id)) rows.push({ name: `pilot-${row}-reread`, kind: 'reread', row, units: [r.id], estimate_usd: r.estimate.usd, cap_usd: cap.reread_cap_usd, ...gated });
  }
  const labelEstimate = m.blocks.find(b => b.id === 'BGW-judge')!.estimate_usd - judge.estimate.usd;
  const judgeCheck: PilotLedger[] = [
    { name: 'judge-check', kind: 'campaign', row: 'judge-check', units: [judge.id], estimate_usd: judge.estimate.usd, cap_usd: m.judge_check.cells_cap_usd, campaign_id: `q1-scoreboard-weekly-judge-check${suffix}` },
    { name: 'judge-check-label', kind: 'label', row: 'judge-check', units: [], estimate_usd: r2(labelEstimate), cap_usd: m.judge_check.label_cap_usd },
  ];
  const worlds = [...new Set(m.cells.flatMap(c => c.only_conversations ?? []))].sort();
  const mint: PilotLedger = { name: 'mint', kind: 'mint', row: 'mint', units: worlds, estimate_usd: r2(worlds.length * BG1C_RATES.mint_usd_per_world), cap_usd: WEEKLY_ALIAS_PILOT_MONEY.mint_usd };
  const ledgers = alias ? [mint, rows[0], ...judgeCheck, ...rows.slice(1)] : [...rows, ...judgeCheck];
  const pilotCap = r2(Object.values(m.pilot_caps).reduce((s, c) => s + c.cap_usd, 0));
  const capOf = (xs: PilotLedger[]) => r2(xs.reduce((s, l) => s + l.cap_usd, 0));
  const window = alias ? { mint_usd: mint.cap_usd, grep_first_usd: capOf(ledgers.filter(l => l.kind !== 'mint' && !l.after_stop_rule)), after_stop_rule_usd: capOf(ledgers.filter(l => l.after_stop_rule)), total_usd: capOf(ledgers), window_usd: WEEKLY_ALIAS_PILOT_MONEY.window_usd } : null;
  const cellOf = (c: CellDefinition) => ({ id: c.id, block: c.block, system: c.system, only_conversations: c.only_conversations, expected_hours: c.expected_hours, estimate_usd: c.estimate.usd, lease_usd: c.lease!.usd, questions: scheduledCount(c) });
  const stage2 = m.cells.filter(c => c.set === WEEKLY_ALIAS_STAGE2_SET);
  const stage2Ledgers: PilotLedger[] = stage2.map(c => ({ name: `stage2-${rowOf(c)}`, kind: 'campaign', row: rowOf(c), units: [c.id], estimate_usd: c.estimate.usd, cap_usd: c.lease!.usd, campaign_id: `q1-scoreboard-weekly-alias-stage2-${rowOf(c)}` }));
  return {
    length: m.length, gbrain: m.gbrain_build, world_end: worldEnd, ledgers, stop_rule: alias ? STOP_RULE : null, window,
    misspelling_stage: stage2.length ? { cells: stage2.map(cellOf), ledgers: stage2Ledgers, cap_usd: capOf(stage2Ledgers), window_usd: WEEKLY_ALIAS_STAGE2_MONEY.window_usd } : null,
    cells: m.cells.filter(c => c.set !== WEEKLY_ALIAS_STAGE2_SET).map(cellOf),
    caps: m.pilot_caps, judge_check: m.judge_check, quick_look: m.quick_look,
    totals: { estimate_usd: r2(ledgers.reduce((s, l) => s + l.estimate_usd, 0)), cap_usd: r2(ledgers.reduce((s, l) => s + l.cap_usd, 0)), pilot_cap_usd: pilotCap, judge_check_cap_usd: m.judge_check.pause_usd, quick_look_cap_usd: m.quick_look.cap_usd },
  };
}

/** The plan as text: the build, every cell, every ledger with its estimate and cap, the quick look and the totals. */
export function renderPilotPlan(p: PilotPlan): string {
  const rows = Object.values(p.caps);
  return [
    'Weekly line pilot and judge check: dry run, nothing is called',
    `gbrain build: ${p.gbrain.release} (${p.gbrain.commit})`,
    `world end: ${p.world_end ?? 'set at launch (--world-end, a Sunday at most 14 days back)'}`,
    '',
    `Pilot on ${[...new Set(p.cells.filter(c => c.block === 'BGW-pilot').flatMap(c => c.only_conversations ?? []))].join(', ')} (${p.length} length, R111): ${p.window ? 'each row at its cap from Amendment 1, inside the alias window' : `each row under ${WEEKLY_LINE_PILOT_FRACTION * 100}% of its block budget, the row's rate a world times ${WEEKLY_LINE_BLOCK_WORLDS} worlds`}`,
    '| row | rate a world | block budget | pilot cap | cell ledger | re-read ledger |',
    '|---|---:|---:|---:|---:|---:|',
    ...rows.map(c => `| ${c.row} | ${usd(c.rate_usd_per_world)} | ${usd(c.block_budget_usd)} | ${usd(c.cap_usd)} | ${usd(c.cells_cap_usd)} | ${c.reread_cap_usd ? usd(c.reread_cap_usd) : '-'} |`),
    '',
    'Cells',
    '| cell | worlds | questions | estimate | lease | hours |',
    '|---|---|---:|---:|---:|---:|',
    ...p.cells.map(c => `| ${c.id} | ${(c.only_conversations ?? []).join(', ')} | ${c.questions} | ${usd(c.estimate_usd)} | ${usd(c.lease_usd)} | ${c.expected_hours} |`),
    '',
    'Ledgers, in launch order',
    '| ledger | units | estimate | cap |',
    '|---|---|---:|---:|',
    ...p.ledgers.map(l => `| ${l.name}${l.campaign_id ? ` (${l.campaign_id})` : ''}${l.after_stop_rule ? ' (only below the stop rule)' : ''} | ${l.units.join(', ') || `${p.judge_check.labeller} on the model-labelled answers`} | ${usd(l.estimate_usd)} | ${usd(l.cap_usd)} |`),
    ...(p.window ? ['', `Alias window (Amendment 1): the mint ${usd(p.window.mint_usd)}, the grep agent's stage ${usd(p.window.grep_first_usd)} and the other rows' stage ${usd(p.window.after_stop_rule_usd)} cap at ${usd(p.window.total_usd)} together, at most the window's ${usd(p.window.window_usd)}`] : []),
    ...(p.stop_rule ? ['', `Stop rule: ${p.stop_rule} The grep agent's claude-opus-5-5 answers on ${[...new Set(p.cells.filter(c => c.system === p.cells.find(x => x.block === 'BGW-judge')?.system).flatMap(c => c.only_conversations ?? []))].join(', ')} are scored together against the construction labels; the rows marked "only below the stop rule" launch only when that score is below ${CEILING} and the judge check can draw its sample from those answers.`] : []),
    ...(p.misspelling_stage ? ['', 'Stage 2 (Amendment 1, 2026-11-25): gbrain, extract-first and memory-bank on all three alias worlds, each world ingested whole, asking only the questions whose evidence names their subject by its misspelling; claude-opus-5-5 reads, no particle-1 re-read, no mint',
      '| ledger | cell | worlds | questions | estimate | cap (lease) |', '|---|---|---|---:|---:|---:|',
      ...p.misspelling_stage.ledgers.map((l, i) => { const c = p.misspelling_stage!.cells[i]; return `| ${l.name} (${l.campaign_id}) | ${c.id} | ${(c.only_conversations ?? []).join(', ')} | ${c.questions} | ${usd(l.estimate_usd)} | ${usd(l.cap_usd)} |`; }),
      `Stage 2 caps ${usd(p.misspelling_stage.cap_usd)} together, at most its own window's ${usd(p.misspelling_stage.window_usd)} (pilot.ts campaigns --length alias --misspelling-stage)`] : []),
    '',
    `Judge check: pauses at ${usd(p.judge_check.pause_usd)} (its cell ${usd(p.judge_check.cells_cap_usd)}, labelling ${usd(p.judge_check.label_cap_usd)}); ${p.judge_check.per_judge} labelled answers per judge`,
    `Claude Code quick look: cap ${usd(p.quick_look.cap_usd)}, ${p.quick_look.status} (${p.quick_look.reason})`,
    '',
    `Total: estimate ${usd(p.totals.estimate_usd)}; caps ${usd(p.totals.cap_usd)} (${p.window ? `mint ${usd(p.window.mint_usd)}, ` : ''}pilot ${usd(p.totals.pilot_cap_usd)}, judge check ${usd(p.totals.judge_check_cap_usd)}); quick look not run`,
  ].join('\n');
}

// ─── Campaigns ───────────────────────────────────────────────────────

export interface PilotCampaigns { plan: PilotPlan; env: Record<string, string>; campaigns: Array<{ name: string; file: string }>; commands: Array<{ name: string; argv: string[] }> }

/**
 * Write the pilot's campaigns into `out`: one per row and one for the judge check, each its own ledger at its cap, and
 * plan.json with the re-read and labelling commands. Refuses without a granted window, or when the ledgers' caps
 * together pass the window's cap.
 */
/**
 * The alias pilot's campaigns come in two stages (Amendment 1): without a stop-rule reading, the alias worlds' mint, the
 * grep agent's pilot and the judge check alone; with one (stopRuleReading over their cells, with judgeCheckShortfall),
 * the other rows alone, and only when that reading is complete and below CEILING and the judge check can draw its sample
 * from those cells' answers. A reading at or above the line refuses, since the line then stops, and so does one whose
 * judge check is short, which holds the other rows for the owner. One window covers the mint and both stages, so each
 * stage refuses unless all three stages' caps together fit the window's cap.
 */
export type StopReading = ReturnType<typeof pooledGrepOpus> & { judge_check_short?: string | null };
/**
 * With misspellingStage, the alias pilot's stage 2 alone (Amendment 1's stage-2 lines, on the owner's go after the held
 * reading): one campaign per stage-2 row, in its own window with no mint, refused unless the stage's caps together fit
 * both the granted window's cap and the stage's window (WEEKLY_ALIAS_STAGE2_MONEY), and never beside a stop-rule reading.
 */
export function writePilotCampaigns(m: WeeklyPilotManifest, o: { out: string; window?: string; windowCapUsd?: number; worldEnd?: string; stopReading?: StopReading; misspellingStage?: boolean }): PilotCampaigns {
  if (!o.window) refuse('PILOT_NO_WINDOW', 'the pilot and the judge check spend on providers, so their campaigns are written only for a granted paid window; pass --window-granted <unit>');
  if (!(Number.isFinite(o.windowCapUsd) && o.windowCapUsd! > 0)) refuse('PILOT_NO_WINDOW', 'pass --window-cap-usd <the granted window\'s cap>, which the ledgers\' caps together may not pass');
  if (!o.worldEnd) refuse('USAGE', 'pass --world-end <Sunday>, the world end every pilot unit resolves dates from');
  const plan = pilotPlan(m, o.worldEnd!), alias = m.length === 'alias', reading = o.stopReading;
  if (o.misspellingStage) {
    const stage = plan.misspelling_stage ?? refuse('USAGE', `only the alias pilot has a misspelling stage, not the ${m.length} pilot`);
    if (reading) refuse('USAGE', 'the misspelling stage takes no stop-rule reading: it runs on the owner\'s go after the reading was held');
    const over = Math.min(o.windowCapUsd!, stage.window_usd);
    if (stage.cap_usd > over + 1e-9) refuse('PILOT_OVER_WINDOW', `the misspelling stage's ledgers cap at ${usd(stage.cap_usd)} together, above ${o.windowCapUsd! < stage.window_usd ? `the window's ${usd(o.windowCapUsd!)}` : `the stage's own window of ${usd(stage.window_usd)}`}`);
    mkdirSync(o.out, { recursive: true });
    const campaigns = stage.ledgers.map(l => {
      const file = join(o.out, `${l.name}.campaign.json`);
      writeFileSync(file, JSON.stringify(weeklyPilotCampaignManifest(m, { units: l.units, campaign_id: l.campaign_id!, cap_usd: l.cap_usd, window: o.window!, windowCapUsd: over, worldEnd: o.worldEnd! }), null, 2) + '\n');
      return { name: l.name, file };
    });
    const env = { GBRAIN_EVALS_BG1_WORLD_END: o.worldEnd!, [WEEKLY_PILOT_GBRAIN_ENV]: `${m.gbrain_build.release}@${m.gbrain_build.commit}`, [WEEKLY_PILOT_LENGTH_ENV]: m.length };
    writeFileSync(join(o.out, 'plan.json'), JSON.stringify({ ...plan, stage: 'misspelling', window: o.window, window_cap_usd: o.windowCapUsd, env, campaigns, commands: [] }, null, 2) + '\n');
    return { plan, env, campaigns, commands: [] };
  }
  if (!alias && reading) refuse('USAGE', `only the alias pilot takes the grep agent's stop-rule reading, not the ${m.length} pilot`);
  if (reading?.unpaid.length) refuse('PILOT_NOT_PAID', `${reading.unpaid.join(', ')} ${reading.unpaid.length === 1 ? 'is not a paid cell' : 'are not paid cells'}: the receipt records a keyless upstream or no paid window, so the stop rule does not read ${reading.unpaid.length === 1 ? 'it' : 'them'} and no other row's campaign is written; pass the paid cells' out dirs`);
  if (reading && !(reading.complete && reading.grep_agent_opus_accuracy !== null)) refuse('PILOT_STOP_RULE', `the grep agent's stop-rule reading is not complete (${reading.answers} of ${reading.expected_answers} claude-opus-5-5 answers on ${reading.worlds.join(', ') || 'no world'}, every cell complete: ${reading.cells_complete ? 'yes' : 'no'}), so no other row's campaign is written`);
  if (reading?.stops_line) refuse('PILOT_STOP_RULE', `${STOP_RULE} It pooled at ${reading.grep_agent_opus_accuracy}, so no other row's campaign is written`);
  if (reading && reading.judge_check_short !== null) refuse('PILOT_JUDGE_CHECK_SHORT', `the judge check can't draw its sample from the grep agent's answers (${reading.judge_check_short ?? 'not read'}), so the other rows stay held and the reading goes back to the owner`);
  if (plan.window && plan.window.total_usd > o.windowCapUsd! + 1e-9) refuse('PILOT_OVER_WINDOW', `the alias worlds' mint and both stages cap at ${usd(plan.window.total_usd)} together, above the window's ${usd(o.windowCapUsd!)}; one window covers all three`);
  const ledgers = alias ? plan.ledgers.filter(l => Boolean(l.after_stop_rule) === Boolean(reading)) : plan.ledgers;
  const capUsd = r2(ledgers.reduce((s, l) => s + l.cap_usd, 0));
  if (capUsd > o.windowCapUsd! + 1e-9) refuse('PILOT_OVER_WINDOW', `the ${alias ? (reading ? 'other rows\' ' : 'grep agent\'s and judge check\'s ') : 'pilot\'s and judge check\'s '}ledgers cap at ${usd(capUsd)} together, above the window's ${usd(o.windowCapUsd!)}`);
  mkdirSync(o.out, { recursive: true });
  const campaigns = ledgers.filter(l => l.kind === 'campaign').map(l => {
    const file = join(o.out, `${l.name}.campaign.json`);
    writeFileSync(file, JSON.stringify(weeklyPilotCampaignManifest(m, { units: l.units, campaign_id: l.campaign_id!, cap_usd: l.cap_usd, window: o.window!, windowCapUsd: o.windowCapUsd!, worldEnd: o.worldEnd! }), null, 2) + '\n');
    return { name: l.name, file };
  });
  const paid = (cap: number) => ['--paid-window', o.window!, '--window-cap-usd', String(cap), '--ledger-cap-usd', String(cap), '--lease-usd', String(cap)];
  const commands = [
    ...ledgers.filter(l => l.kind === 'reread').map(l => {
      const r = m.reread_plans.find(p => p.id === l.units[0])!;
      return { name: l.name, argv: ['bun', 'eval/runner/q1/reread-cell.ts', '--cell', r.cell, '--arm', r.arm, '--reader', r.reader, '--manifest', 'weekly-pilot', ...paid(l.cap_usd)] };
    }),
    ...ledgers.filter(l => l.kind === 'label').map(l => ({ name: l.name, argv: ['bun', 'eval/runner/weekly-line/judge-check.ts', 'label', ...paid(l.cap_usd)] })),
    ...ledgers.filter(l => l.kind === 'mint').map(l => ({ name: l.name, argv: ['eval/custody/bg1/mint.sh', '--dev', '--worlds', l.units.join(','), '--paid-window', o.window!, '--window-cap-usd', String(l.cap_usd)] })),
  ];
  const env = { GBRAIN_EVALS_BG1_WORLD_END: o.worldEnd!, [WEEKLY_PILOT_GBRAIN_ENV]: `${m.gbrain_build.release}@${m.gbrain_build.commit}`, [WEEKLY_PILOT_LENGTH_ENV]: m.length };
  writeFileSync(join(o.out, 'plan.json'), JSON.stringify({ ...plan, ...(alias ? { stage: reading ? 'after-stop-rule' : 'grep-first', stop_reading: reading ?? null } : {}), window: o.window, window_cap_usd: o.windowCapUsd, env, campaigns: campaigns.map(c => ({ name: c.name, file: c.file })), commands }, null, 2) + '\n');
  return { plan, env, campaigns, commands };
}

// ─── The R111 readings ───────────────────────────────────────────────

const readJson = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));
const lines = <T,>(p: string): T[] => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as T) : []);
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const r4 = (x: number | null) => (x === null ? null : Math.round(x * 10_000) / 10_000);

/** One pilot row's readings from one cell out dir, and the re-read's when the row has one. */
export interface RowReading {
  row: WlRow; cell: string; block: string; worlds: string[]; answers: number;
  /** The cell receipt's run_status (complete, partial or invalid); the stop rule counts only complete cells. */
  status?: string | null;
  /** Where the cell's provider calls went (cell.ts CellUpstream), null on a receipt that predates the record; the stop rule counts only paid cells. */
  upstream?: CellUpstream | null; by_reader: Record<string, number>; outcomes: Record<string, number>;
  /** Answers that need a verdict (scored or ingest_degraded) and how many have one from their reader's gating judge, parsed. */
  verdicts: { needed: number; given: number; parse_failed: number };
  /** Mean gating score per reader, product failures as 0. */
  accuracy: Record<string, number | null>;
  spend_usd: number | null; spend_source: string | null;
  part_under_test: { ran: boolean; detail: Record<string, unknown> };
  /**
   * A grep-agent cell's claude-opus-5-5 answers read against the construction labels (stopRuleLabel): the
   * questions its own loop answered, the questions whose answer it never produced (a reader error, a budget stop), how
   * many answers the labels settle as right, and how many they leave unsettled (hedged, or naming none or several values).
   */
  construction?: { answered: string[]; failed: string[]; correct: number; unsettled: number };
  agent?: { seconds_per_answer: number | null; input_tokens_per_answer: number | null; output_tokens_per_answer: number | null; usd_per_answer: number | null; turns_per_answer: number | null; rates: Record<string, number | null>; ripgrep: string | null };
}
/** One re-read: its answers that need a verdict and how many have a parsed one from the reader's gating judge, as readRow counts a cell's. */
export interface RereadReading { cell: string; answers: number; verdicts: { needed: number; given: number }; accuracy: number | null; spend_usd: number | null; status: string | null }

/** The outcomes the grep agent's own loop ends in; the others (reader errors, budget stops, invalid runs) never ran it. */
const AGENT_OUTCOMES: ReadonlySet<string> = new Set(['scored', 'ingest_degraded', 'turn_cap', 'context_overflow']);

/** The arm cells a cell out dir holds (cells/<arm cell id>/ with a receipt). */
const armDirs = (out: string) => (existsSync(join(out, 'cells')) ? readdirSync(join(out, 'cells')).sort().map(d => join(out, 'cells', d)).filter(d => existsSync(join(d, 'receipt.json'))) : []);

/** Read one pilot or judge-check unit's out dir. */
export function readRow(out: string): RowReading[] {
  return armDirs(out).map(dir => {
    const receipt = readJson(join(dir, 'receipt.json'));
    const cellId = String(receipt.run_cell), system = String(receipt.system?.kind), row = WL_SYSTEMS[system];
    if (!row || !(receipt.block === 'BGW-pilot' || receipt.block === 'BGW-judge')) refuse('PILOT_REPORT', `${dir} is not a pilot or judge-check cell (block ${receipt.block}, system ${system})`);
    const answers = readRecords(join(dir, 'answers.ndjson'), 'answer'), judgments = readRecords(join(dir, 'judgments.ndjson'), 'judgment');
    const gating = new Map(judgments.filter(j => j.judge_replicate === 0).map(j => [`${j.answer_id}|${j.judge}`, j]));
    const verdictOf = (a: (typeof answers)[number]) => gating.get(`${a.answer_id}|${bg1JudgeOf(a.reader)}`);
    const needed = answers.filter(a => JUDGED.has(a.outcome));
    const count = <T,>(xs: T[], key: (x: T) => string) => xs.reduce<Record<string, number>>((m, x) => ({ ...m, [key(x)]: (m[key(x)] ?? 0) + 1 }), {});
    const readers = [...new Set(answers.map(a => a.reader))].sort();
    const accuracy = Object.fromEntries(readers.map(r => [r, r4(mean(answers.filter(a => a.reader === r).map(a => (JUDGED.has(a.outcome) ? verdictOf(a)?.score ?? 0 : 0))))]));
    const staged = gatherStaging(cellId, [out]);
    const retrievals = [...staged.values()].flatMap(s => lines<{ question_id: string; items: Array<{ type?: string; id?: string }>; outcome: string }>(join(s.root, 'r', s.rid, 'retrievals.ndjson')));
    const contexts = lines<{ meta?: { item_ids?: string[] } }>(join(out, 'runs', cellId, 'contexts.ndjson'));
    let part: RowReading['part_under_test'];
    let agent: RowReading['agent'];
    let construction: RowReading['construction'];
    if (row === 'grep-agent') {
      const opus = answers.filter(a => a.reader === OPUS), questions = devQuestions([...new Set(opus.map(a => a.conversation))]);
      const labels = opus.filter(a => JUDGED.has(a.outcome)).map(a => stopRuleLabel(questions.get(a.question_id) ?? refuse('PILOT_REPORT', `question ${a.question_id} of ${a.answer_id} is not in the dev worlds`), { stop_reason: a.stop_reason ?? null, text: a.text }));
      construction = { answered: opus.filter(a => AGENT_OUTCOMES.has(a.outcome)).map(a => a.question_id), failed: opus.filter(a => !AGENT_OUTCOMES.has(a.outcome)).map(a => a.question_id), correct: labels.filter(g => g === 1).length, unsettled: labels.filter(g => g === null).length };
      const searchedBy = (a: (typeof answers)[number]) => (a.tool_calls?.grep?.calls ?? 0) - (a.tool_calls?.grep?.failed ?? 0) >= 1;
      const recorded = answers.filter(a => a.tool_calls !== undefined).length;
      const ripgrep = receipt.system?.versions?.ripgrep ?? null;
      const searchedPerReader = Object.fromEntries(readers.map(r => [r, answers.filter(a => a.reader === r && searchedBy(a)).length]));
      const agentAnswers = answers.filter(a => AGENT_OUTCOMES.has(a.outcome));
      part = { ran: ripgrep !== null && agentAnswers.length > 0 && agentAnswers.every(searchedBy),
        detail: { ripgrep, agent_answers: agentAnswers.length, agent_answers_without_a_returned_grep: agentAnswers.filter(a => !searchedBy(a)).length, answers_with_tool_calls: recorded, answers_with_a_returned_grep: answers.filter(searchedBy).length, answers_with_a_returned_grep_by_reader: searchedPerReader } };
      const per = (f: (a: (typeof answers)[number]) => number | undefined) => r4(mean(answers.map(f).filter((x): x is number => typeof x === 'number')));
      const rate = (k: (a: (typeof answers)[number]) => boolean) => (answers.length ? r4(answers.filter(k).length / answers.length) : null);
      agent = { seconds_per_answer: per(a => a.latency_ms / 1000), input_tokens_per_answer: per(a => a.usage.input + a.usage.cache_read + a.usage.cache_write), output_tokens_per_answer: per(a => a.usage.output),
        usd_per_answer: per(a => a.usd), turns_per_answer: per(a => a.turns), ripgrep,
        rates: { turn_cap: rate(a => a.outcome === 'turn_cap'), context_overflow: rate(a => a.outcome === 'context_overflow'), no_tool_call: rate(a => a.stop_reason === 'no_tool_call') } };
    } else if (row === 'gbrain') {
      const withFacts = contexts.filter(c => (c.meta?.item_ids ?? []).some(id => id.startsWith('fact:'))).length;
      part = { ran: withFacts >= 1, detail: { contexts: contexts.length, contexts_with_facts_block_rows: withFacts, retrievals_with_fact_rows: retrievals.filter(r => r.items?.some(i => i.type === 'fact')).length } };
    } else {
      const ingest = receipt.ingest ?? {};
      const questions = new Set(retrievals.map(r => r.question_id));
      const withMemories = new Set(retrievals.filter(r => (r.items ?? []).length > 0).map(r => r.question_id));
      part = { ran: (ingest.conversations ?? 0) >= 1 && (ingest.failed_sessions ?? 1) === 0 && (ingest.degraded_conversations ?? 1) === 0 && questions.size > 0 && withMemories.size === questions.size,
        detail: { ingested_conversations: ingest.conversations ?? 0, ingested_tokens: ingest.ingested_tokens ?? 0, failed_sessions: ingest.failed_sessions ?? null, degraded: ingest.degraded_conversations ?? null, questions: questions.size, questions_with_memories: withMemories.size } };
    }
    return {
      row, cell: cellId, block: receipt.block, status: receipt.run_status ?? null, upstream: receipt.upstream ?? null, worlds: [...staged.keys()].sort(), answers: answers.length, by_reader: count(answers, a => a.reader), outcomes: count(answers, a => a.outcome),
      verdicts: { needed: needed.length, given: needed.filter(a => verdictOf(a)?.parse_ok).length, parse_failed: needed.filter(a => verdictOf(a) && !verdictOf(a)!.parse_ok).length },
      accuracy, spend_usd: typeof receipt.spend?.total_usd === 'number' ? receipt.spend.total_usd : null, spend_source: receipt.spend?.source ?? null, part_under_test: part, ...(construction ? { construction } : {}), ...(agent ? { agent } : {}),
    };
  });
}

/** Read one re-read out dir (reread-cell.ts --out): its answers and parsed gating verdicts, and its receipt's status and spend from the metering proxy. */
export function readReread(out: string): RereadReading[] {
  return armDirs(out).map(dir => {
    const receipt = readJson(join(dir, 'receipt.json'));
    const spend = receipt.spend ?? {};
    const answers = readRecords(join(dir, 'answers.ndjson'), 'answer');
    const parsed = new Set(readRecords(join(dir, 'judgments.ndjson'), 'judgment').filter(j => j.judge_replicate === 0 && j.parse_ok).map(j => `${j.answer_id}|${j.judge}`));
    const needed = answers.filter(a => JUDGED.has(a.outcome));
    return { cell: String(receipt.cell_id ?? dir), answers: answers.length, verdicts: { needed: needed.length, given: needed.filter(a => parsed.has(`${a.answer_id}|${bg1JudgeOf(a.reader)}`)).length },
      accuracy: Object.values(receipt.per_reader_mean ?? {})[0] as number | null ?? null, spend_usd: typeof spend.reader_usd === 'number' && typeof spend.judge_usd === 'number' ? r2(spend.reader_usd + spend.judge_usd) : null, status: receipt.run_status ?? null };
  });
}

/**
 * The stop rule's construction label of one answer: the judge check's gold-settled label (judge-check.ts goldLabel), and
 * on a withdrawn question (s5_withdrawn, whose gold is the none-forms) a confident answer whose first and last tracked
 * values are none-forms and that names no decoy is right, so "None: the plan with Lisbon was called off" counts as the reference
 * answer it is. goldLabel reads that answer as unsettled because BG1's matchAnswer, which BG1's and BG1-C's counted
 * verdicts and the judge check's labels share, calls a none-form beside the withdrawn value "unclear"; this path leaves
 * matchAnswer and goldLabel as they are and changes no other kind. An answer that leads or ends with the withdrawn value
 * ("None, Goldcrest Insurance"), hedges or abstains stays unsettled, which the stop rule counts as wrong.
 */
export function stopRuleLabel(q: Pick<MemoryQuestion, 'id' | 'bg1'>, a: Pick<PoolAnswer, 'stop_reason' | 'text'>): 0 | 1 | null {
  const { match, gold } = goldLabel(q, a);
  if (gold !== null || match !== 'unclear' || q.bg1?.stratum !== 's5_withdrawn' || answerKind(a) === 'hedged') return gold;
  const hits = findValues(a.text, { gold: q.bg1.gold_values, stale: q.bg1.stale_values, decoy: q.bg1.decoy_values });
  return hits[0]?.kind === 'gold' && hits.at(-1)?.kind === 'gold' && !hits.some(h => h.kind === 'decoy') ? 1 : null;
}

/**
 * The alias pilot's stop-rule reading: the grep agent's claude-opus-5-5 score over its pilot and judge-check cells, read
 * against the construction labels (stopRuleLabel: an answer is right only when it names the gold with no stale or decoy
 * value and doesn't hedge, or on a withdrawn question leads with a none-form and names no decoy), so no judge verdict enters it and a judge error can't move it. Turn-cap and
 * context-overflow answers count as wrong, as R111's rule scores them. It is complete only when every cell finished
 * complete and claude-opus-5-5's own loop answered each question in `expected` exactly once and no other; a question
 * whose answer is missing or failed (a reader error, a budget stop) blocks the reading until a resume answers it, and
 * never counts as right. A cell whose receipt doesn't record real providers under a granted paid window (a keyless
 * rehearsal, which shares the paid cell's id, or a receipt from before that record) is unpaid, and an unpaid cell keeps
 * the reading incomplete. Only a complete reading stops the line or lets the other rows run.
 */
export function pooledGrepOpus(rows: RowReading[], expected: readonly string[]) {
  const grep = rows.filter(r => r.row === 'grep-agent' && r.construction);
  const answered = grep.flatMap(r => r.construction!.answered), got = new Set(answered), want = new Set(expected);
  const missing = expected.filter(id => !got.has(id)).length, stray = [...got].filter(id => !want.has(id)).length;
  const failed = new Set(grep.flatMap(r => r.construction!.failed).filter(id => !got.has(id))).size;
  const correct = grep.reduce((s, r) => s + r.construction!.correct, 0), unsettled = grep.reduce((s, r) => s + r.construction!.unsettled, 0);
  const accuracy = answered.length ? r4(correct / answered.length) : null;
  const cellsComplete = grep.length > 0 && grep.every(r => r.status === 'complete');
  const unpaid = grep.filter(r => !(r.upstream?.keyless === false && typeof r.upstream.paid_window === 'string' && r.upstream.paid_window.length > 0)).map(r => r.cell);
  const complete = expected.length > 0 && cellsComplete && unpaid.length === 0 && missing === 0 && stray === 0 && answered.length === expected.length;
  return { grep_agent_opus_accuracy: accuracy, scored_by: 'construction labels' as const, correct, unsettled, answers: answered.length, expected_answers: expected.length, missing, failed,
    worlds: [...new Set(grep.flatMap(r => r.worlds))].sort(), cells_complete: cellsComplete, unpaid, complete, line: CEILING, stops_line: complete && accuracy !== null && accuracy >= CEILING, rule: STOP_RULE };
}

/**
 * The stop-rule reading for a manifest's grep-agent cells: the questions they schedule (scheduledIds). Refuses a
 * grep-agent reading of a cell that is not one of them, or of one cell twice.
 */
export function stopRuleReading(m: Pick<WeeklyPilotManifest, 'cells'>, rows: RowReading[]) {
  const cells = m.cells.filter(c => rowOf(c) === 'grep-agent'), ids = new Set(cells.map(c => c.id));
  const grep = rows.filter(r => r.row === 'grep-agent');
  const stray = grep.filter(r => !ids.has(r.cell)).map(r => r.cell);
  if (stray.length) refuse('PILOT_STOP_RULE', `${stray.join(', ')} ${stray.length === 1 ? 'is not a grep-agent cell' : 'are not grep-agent cells'} of this pilot, so the stop rule does not read ${stray.length === 1 ? 'it' : 'them'}`);
  const twice = [...new Set(grep.map(r => r.cell).filter((c, i, all) => all.indexOf(c) !== i))];
  if (twice.length) refuse('PILOT_STOP_RULE', `${twice.join(', ')} is read more than once; pass each cell out dir once`);
  return pooledGrepOpus(grep, cells.flatMap(c => scheduledIds(c)));
}

/**
 * Whether the judge check can draw its sample from these grep-agent cell out dirs (judge-check.ts poolAnswers and
 * buildSample on their gating verdicts): null when it can, else the judge check's own refusal, such as a judge short of
 * the answers judged wrong its sample needs.
 */
export function judgeCheckShortfall(dirs: readonly string[], length: WeeklyPilotManifest['length']): string | null {
  const pool = poolAnswers(dirs, length);
  const questions = devQuestions([...new Set(pool.map(a => a.conversation))]);
  try { buildSample(pool, questions); return null; }
  catch (e) { if (e instanceof JudgeCheckRefusal) return e.message; throw e; }
}

/**
 * R111's verdict per pilot row, the ceiling reading and the week projected at the measured rates. For the alias pilot the
 * ceiling is the stop rule (pooledGrepOpus over the manifest's pilot and judge-check worlds), and when it stops the line a
 * row the rule kept from launching has no reading and is reported as not run, which fails nothing.
 */
export function pilotReport(rows: RowReading[], rereads: RereadReading[], m: Pick<WeeklyPilotManifest, 'pilot_caps'> & Partial<Pick<WeeklyPilotManifest, 'length' | 'cells'>>, judgeCheckShort: string | null = null) {
  const pilot = rows.filter(r => r.block === 'BGW-pilot');
  const perRow = Object.fromEntries((Object.keys(WEEKLY_LINE_ROWS) as WlRow[]).map(row => {
    const r = pilot.find(x => x.row === row);
    const rr = rereads.filter(x => x.cell.startsWith(`${r?.cell ?? '\u0000'}.`));
    const spend = r?.spend_usd === null || r === undefined ? null : r2(r.spend_usd + rr.reduce((s, x) => s + (x.spend_usd ?? 0), 0));
    const worlds = r?.worlds.length || 1;
    const checks = r ? {
      part_under_test_ran: r.part_under_test.ran,
      every_answer_judged: r.verdicts.needed > 0 && r.verdicts.given === r.verdicts.needed && rr.every(x => x.status === 'complete' && x.verdicts.given === x.verdicts.needed),
      both_readers_answered: row === 'grep-agent' ? Object.keys(r.by_reader).length === 2 : rr.length === 1 && rr[0].answers > 0,
      under_cap: spend !== null && spend <= m.pilot_caps[row].cap_usd + 1e-9,
    } : null;
    return [row, { reading: r ?? null, rereads: rr, spend_usd: spend, usd_per_world: spend === null ? null : r2(spend / worlds), cap_usd: m.pilot_caps[row].cap_usd, checks, pass: checks !== null && Object.values(checks).every(Boolean) }];
  }));
  const grep = pilot.find(r => r.row === 'grep-agent');
  const opus = grep?.accuracy[OPUS] ?? null;
  const stop = m.length === 'alias' ? stopRuleReading({ cells: m.cells ?? [] }, rows) : null;
  if (stop?.stops_line) for (const [row, x] of Object.entries(perRow)) if (row !== 'grep-agent' && x.reading === null) Object.assign(x, { pass: true, not_run: 'the stop rule' });
  if (stop?.complete && !stop.stops_line && judgeCheckShort !== null) for (const [row, x] of Object.entries(perRow)) if (row !== 'grep-agent' && x.reading === null) Object.assign(x, { pass: false, held: `the judge check is short: ${judgeCheckShort}` });
  const measured = Object.values(perRow).every(x => x.usd_per_world !== null);
  const week = measured ? r2(Object.values(perRow).reduce((s, x) => s + x.usd_per_world!, 0) * WL_WEEK_WORLDS) : null;
  return {
    rows: perRow, judge_check: rows.filter(r => r.block === 'BGW-judge'),
    ceiling: stop
      ? { grep_agent_opus_accuracy: stop.grep_agent_opus_accuracy, line: CEILING, triggers_longer_worlds: false, stop_rule: stop }
      : { grep_agent_opus_accuracy: opus, line: CEILING, triggers_longer_worlds: opus !== null && opus >= CEILING, stop_rule: null },
    projected_week: { usd: week, worlds: WL_WEEK_WORLDS, block_worlds: WL_BLOCK_WORLDS, range_top_usd: WEEK_RANGE_TOP_USD, over_by_more_than_share: week !== null && week > WEEK_RANGE_TOP_USD * (1 + WEEK_OVERRUN_SHARE) },
  };
}

// ─── Command line ────────────────────────────────────────────────────

export interface PilotDeps { lsRemote: () => string; env: Record<string, string | undefined> }
const DEFAULT_DEPS: PilotDeps = { lsRemote: lsRemoteTags, env: process.env };

const flags = (argv: readonly string[], name: string) => argv.flatMap((a, i) => (a === name ? [argv[i + 1] ?? refuse('USAGE', `${name} needs a value`)] : []));
const flag = (argv: readonly string[], name: string) => flags(argv, name).at(-1);

/** The gbrain build: --gbrain <release>@<commit>, else the newest release tag on gbrain's repository (R100). */
export function pilotBuild(argv: readonly string[], deps: PilotDeps): WeeklyLineGbrainBuild {
  const given = flag(argv, '--gbrain');
  if (!given) return newestGbrainRelease(deps.lsRemote());
  const [release, commit = ''] = given.split('@');
  const p = weeklyLineBuildProblems({ release, commit });
  if (p.length) refuse('USAGE', `--gbrain ${given}: ${p.join('; ')}`);
  return { release, commit };
}

/** The environment with --length's world length, when given, in WEEKLY_PILOT_LENGTH_ENV; loadWeeklyPilotManifest refuses a length that is neither standard nor long. */
const withLength = (argv: readonly string[], env: PilotDeps['env']) => { const length = flag(argv, '--length'); return length === undefined ? env : { ...env, [WEEKLY_PILOT_LENGTH_ENV]: length }; };
const manifestAt = (gbrain: WeeklyLineGbrainBuild, argv: readonly string[], env: PilotDeps['env']) => loadWeeklyPilotManifest({ ...withLength(argv, env), [WEEKLY_PILOT_GBRAIN_ENV]: `${gbrain.release}@${gbrain.commit}` });

export function main(argv: readonly string[], deps: PilotDeps = DEFAULT_DEPS, log: (s: string) => void = s => console.log(s)): number {
  const [mode, ...rest] = argv;
  if (mode === 'plan') {
    const plan = pilotPlan(manifestAt(pilotBuild(rest, deps), rest, deps.env), flag(rest, '--world-end') ?? null);
    log(rest.includes('--json') ? JSON.stringify(plan, null, 2) : renderPilotPlan(plan));
    return 0;
  }
  if (mode === 'campaigns') {
    const out = resolve(flag(rest, '--out') ?? refuse('USAGE', 'pass --out <dir>'));
    const cap = flag(rest, '--window-cap-usd');
    const m = manifestAt(pilotBuild(rest, deps), rest, deps.env), grepCells = flags(rest, '--grep-cell');
    const stopReading = grepCells.length ? { ...stopRuleReading(m, grepCells.flatMap(d => readRow(resolve(d)))), judge_check_short: judgeCheckShortfall(grepCells.map(d => resolve(d)), m.length) } : undefined;
    const r = writePilotCampaigns(m, { out, window: flag(rest, '--window-granted'), windowCapUsd: cap === undefined ? undefined : Number(cap), worldEnd: flag(rest, '--world-end'), stopReading, misspellingStage: rest.includes('--misspelling-stage') });
    log(renderPilotPlan(r.plan));
    log(`\nwrote ${r.campaigns.length} campaigns and plan.json to ${out}; every command runs with ${Object.entries(r.env).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    for (const c of r.campaigns) log(`campaign ${c.name}: ${c.file}`);
    for (const c of r.commands) log(`${c.name}: ${c.argv.join(' ')} (the host adds --out and the ledger's flags, and --source for a re-read or --cell for the labelling)`);
    return 0;
  }
  if (mode === 'report') {
    const cells = flags(rest, '--cell'), rereads = flags(rest, '--reread');
    if (!cells.length) refuse('USAGE', 'pass --cell <cell out dir> for each pilot or judge-check unit');
    const m = loadWeeklyPilotManifest(withLength(rest, deps.env));
    const read = cells.map(d => ({ dir: resolve(d), rows: readRow(resolve(d)) })), rows = read.flatMap(x => x.rows), units = new Set(m.cells.map(c => c.id));
    const stray = rows.filter(r => !units.has(r.cell)).map(r => r.cell);
    if (stray.length) refuse('PILOT_REPORT', `${stray.join(', ')} ${stray.length === 1 ? 'is not a unit' : 'are not units'} of the ${m.length} pilot, whose caps this report would judge ${stray.length === 1 ? 'it' : 'them'} by; pass the --length its campaigns were written with`);
    const grepDirs = read.filter(x => x.rows.some(r => r.row === 'grep-agent')).map(x => x.dir);
    const report = pilotReport(rows, rereads.flatMap(d => readReread(resolve(d))), m, m.length === 'alias' && grepDirs.length ? judgeCheckShortfall(grepDirs, m.length) : null);
    log(rest.includes('--json') ? JSON.stringify(report, null, 2) : [
      ...Object.entries(report.rows).map(([row, x]) => `${row}: ${'not_run' in x ? `not run (${x.not_run})` : 'held' in x ? `held (${x.held})` : x.reading ? `${x.pass ? 'pass' : 'FAIL'} (${Object.entries(x.checks!).map(([k, v]) => `${k} ${v ? 'yes' : 'NO'}`).join(', ')}); spend ${x.spend_usd === null ? 'unknown' : usd(x.spend_usd)} of cap ${usd(x.cap_usd)}` : 'no pilot output'}`),
      report.ceiling.stop_rule
        ? `stop rule: the grep agent with claude-opus-5-5 scored ${report.ceiling.stop_rule.grep_agent_opus_accuracy ?? 'n/a'} against the construction labels over ${report.ceiling.stop_rule.answers} of ${report.ceiling.stop_rule.expected_answers} answers on ${report.ceiling.stop_rule.worlds.join(', ') || 'no world'} (${report.ceiling.stop_rule.unsettled} unsettled, counted wrong)${report.ceiling.stop_rule.complete ? '' : ` (not read yet: ${report.ceiling.stop_rule.missing} scheduled questions have no answer from the agent's loop, ${report.ceiling.stop_rule.failed} of them failed; every cell must finish complete)`}${report.ceiling.stop_rule.stops_line ? `, at or above ${CEILING}: the line stops and we publish the grep result` : ''}`
        : `ceiling: the grep agent with claude-opus-5-5 at ${report.ceiling.grep_agent_opus_accuracy ?? 'n/a'}${report.ceiling.triggers_longer_worlds ? `, at or above ${CEILING}: launch amendment A moves to longer worlds` : ''}`,
      `projected week at the measured rates: ${report.projected_week.usd === null ? 'not every row measured' : usd(report.projected_week.usd)}${report.projected_week.over_by_more_than_share ? ` (more than ${WEEK_OVERRUN_SHARE * 100}% over ${usd(WEEK_RANGE_TOP_USD)}: back to the owner before week 1)` : ''}`,
    ].join('\n'));
    return Object.values(report.rows).every(x => x.pass) ? 0 : 3;
  }
  return refuse('USAGE', 'the mode is plan, campaigns or report');
}

if (import.meta.main) {
  try { process.exit(main(process.argv.slice(2))); }
  catch (e) {
    if (e instanceof ScoreboardError) { process.stderr.write(renderMessage(e.op) + '\n'); process.exit(exitCodeOf(e.op)); }
    console.error((e as Error).message); process.exit(2);
  }
}

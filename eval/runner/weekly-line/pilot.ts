#!/usr/bin/env bun
/**
 * The weekly held-out line's pilot and judge check on public dev worlds (preregistration
 * docs/benchmarks/2026-11-23-weekly-outcome-line-preregistration.md, "Pilots (R111) and the quick look (R112)" and
 * "Readers and judges"), before launch amendment A. It plans, writes the campaigns for and reads back the cells the
 * weekly generator builds for public worlds (eval/runner/q1/cells/weekly-line.ts generateWeeklyLinePilotCells and
 * generateWeeklyLineJudgeCheckCells); it never calls a provider.
 *
 *   bun eval/runner/weekly-line/pilot.ts plan      [--gbrain <release>@<commit>] [--world-end <Sunday>] [--json]
 *   bun eval/runner/weekly-line/pilot.ts campaigns --out <dir> --window-granted <unit> --window-cap-usd <the window's cap>
 *                                                  --world-end <Sunday> [--gbrain <release>@<commit>]
 *   bun eval/runner/weekly-line/pilot.ts report    --cell <cell out dir>... [--reread <re-read out dir>...] [--json]
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
 * version is recorded, every grep-agent answer records its tool calls and each reader's agent got grep results back at
 * least once, with its no-tool-call share reported), every answer's gating verdict, each row's cost from the metering
 * proxy's usage fields, the grep agent's seconds, tokens and dollars per answer, the ceiling reading (the grep agent with
 * claude-opus-5-5 at 95% or more) and a week projected at the measured rates.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { JUDGED, gatherStaging, loadWeeklyPilotManifest, weeklyPilotCampaignManifest } from '../q1/cell.ts';
import { readRecords } from '../memory-qa/records.ts';
import { bg1JudgeOf, type CellDefinition } from '../q1/cells/definitions.ts';
import {
  WEEKLY_LINE_BLOCK_WORLDS, WEEKLY_LINE_PILOT_FRACTION, WEEKLY_LINE_QUICK_LOOK, WEEKLY_LINE_ROWS, WEEKLY_PILOT_GBRAIN_ENV, weeklyLineBuildProblems,
  type WeeklyLineGbrainBuild, type WeeklyPilotManifest,
} from '../q1/cells/weekly-line.ts';
import { exitCodeOf, renderMessage, ScoreboardError } from '../q1/scoreboard-errors.ts';
import { lsRemoteTags, newestGbrainRelease } from './runner.ts';
import { WL_BLOCK_WORLDS, WL_SYSTEMS, WL_WEEK_WORLDS, type WlRow } from './design.ts';

export class PilotError extends Error {}
const refuse = (code: string, m: string): never => { throw new PilotError(`${code}: ${m}`); };
const usd = (x: number) => `$${x.toFixed(2)}`;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** The order the pilot launches in, the weekly runner's: the extract-first server's ingest is the longest. */
export const PILOT_ORDER: readonly WlRow[] = ['extract-first', 'gbrain', 'memory-bank', 'grep-agent'];
/** A week's ceiling on the grep agent: 95% or more with claude-opus-5-5 moves the line to longer worlds (the preregistration's "Ceiling"). */
export const CEILING = 0.95;
/** The top of the planned weekly range, and the share above it that goes back to the owner before week 1 (the plan's section 5). */
export const WEEK_RANGE_TOP_USD = 850;
export const WEEK_OVERRUN_SHARE = 0.2;

// ─── The plan ────────────────────────────────────────────────────────

/** One ledger of the pilot or the judge check: a campaign of one unit, a re-read, or the labelling pass. */
export interface PilotLedger { name: string; kind: 'campaign' | 'reread' | 'label'; row: WlRow | 'judge-check'; units: string[]; estimate_usd: number; cap_usd: number; campaign_id?: string }
export interface PilotPlan {
  gbrain: WeeklyLineGbrainBuild; world_end: string | null; ledgers: PilotLedger[]; cells: Array<Pick<CellDefinition, 'id' | 'block' | 'system' | 'only_conversations' | 'expected_hours'> & { estimate_usd: number; lease_usd: number }>;
  caps: WeeklyPilotManifest['pilot_caps']; judge_check: WeeklyPilotManifest['judge_check']; quick_look: typeof WEEKLY_LINE_QUICK_LOOK;
  totals: { estimate_usd: number; cap_usd: number; pilot_cap_usd: number; judge_check_cap_usd: number; quick_look_cap_usd: number };
}

const rowOf = (c: Pick<CellDefinition, 'system'>): WlRow => WL_SYSTEMS[c.system];
const pilotCell = (m: WeeklyPilotManifest, row: WlRow) => m.cells.find(c => c.block === 'BGW-pilot' && rowOf(c) === row)!;

/** The pilot's and the judge check's ledgers and totals for the manifest at one gbrain build. */
export function pilotPlan(m: WeeklyPilotManifest, worldEnd: string | null): PilotPlan {
  const judge = m.cells.find(c => c.block === 'BGW-judge')!;
  const ledgers: PilotLedger[] = [];
  for (const row of PILOT_ORDER) {
    const c = pilotCell(m, row), cap = m.pilot_caps[row];
    ledgers.push({ name: `pilot-${row}`, kind: 'campaign', row, units: [c.id], estimate_usd: c.estimate.usd, cap_usd: cap.cells_cap_usd, campaign_id: `q1-scoreboard-weekly-pilot-${row}` });
    for (const r of m.reread_plans.filter(p => p.cell === c.id)) ledgers.push({ name: `pilot-${row}-reread`, kind: 'reread', row, units: [r.id], estimate_usd: r.estimate.usd, cap_usd: cap.reread_cap_usd });
  }
  ledgers.push({ name: 'judge-check', kind: 'campaign', row: 'judge-check', units: [judge.id], estimate_usd: judge.estimate.usd, cap_usd: m.judge_check.cells_cap_usd, campaign_id: 'q1-scoreboard-weekly-judge-check' });
  const labelEstimate = m.blocks.find(b => b.id === 'BGW-judge')!.estimate_usd - judge.estimate.usd;
  ledgers.push({ name: 'judge-check-label', kind: 'label', row: 'judge-check', units: [], estimate_usd: r2(labelEstimate), cap_usd: m.judge_check.label_cap_usd });
  const pilotCap = r2(Object.values(m.pilot_caps).reduce((s, c) => s + c.cap_usd, 0));
  return {
    gbrain: m.gbrain_build, world_end: worldEnd, ledgers,
    cells: m.cells.map(c => ({ id: c.id, block: c.block, system: c.system, only_conversations: c.only_conversations, expected_hours: c.expected_hours, estimate_usd: c.estimate.usd, lease_usd: c.lease!.usd })),
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
    `Pilot on bg1-dev-01 (R111): each row under ${WEEKLY_LINE_PILOT_FRACTION * 100}% of its block budget, the row's rate a world times ${WEEKLY_LINE_BLOCK_WORLDS} worlds`,
    '| row | rate a world | block budget | pilot cap | cell ledger | re-read ledger |',
    '|---|---:|---:|---:|---:|---:|',
    ...rows.map(c => `| ${c.row} | ${usd(c.rate_usd_per_world)} | ${usd(c.block_budget_usd)} | ${usd(c.cap_usd)} | ${usd(c.cells_cap_usd)} | ${c.reread_cap_usd ? usd(c.reread_cap_usd) : '-'} |`),
    '',
    'Cells',
    '| cell | worlds | estimate | lease | hours |',
    '|---|---|---:|---:|---:|',
    ...p.cells.map(c => `| ${c.id} | ${(c.only_conversations ?? []).join(', ')} | ${usd(c.estimate_usd)} | ${usd(c.lease_usd)} | ${c.expected_hours} |`),
    '',
    'Ledgers, in launch order',
    '| ledger | units | estimate | cap |',
    '|---|---|---:|---:|',
    ...p.ledgers.map(l => `| ${l.name}${l.campaign_id ? ` (${l.campaign_id})` : ''} | ${l.units.join(', ') || `${p.judge_check.labeller} on the model-labelled answers`} | ${usd(l.estimate_usd)} | ${usd(l.cap_usd)} |`),
    '',
    `Judge check: pauses at ${usd(p.judge_check.pause_usd)} (its cell ${usd(p.judge_check.cells_cap_usd)}, labelling ${usd(p.judge_check.label_cap_usd)}); ${p.judge_check.per_judge} labelled answers per judge`,
    `Claude Code quick look: cap ${usd(p.quick_look.cap_usd)}, ${p.quick_look.status} (${p.quick_look.reason})`,
    '',
    `Total: estimate ${usd(p.totals.estimate_usd)}; caps ${usd(p.totals.cap_usd)} (pilot ${usd(p.totals.pilot_cap_usd)}, judge check ${usd(p.totals.judge_check_cap_usd)}); quick look not run`,
  ].join('\n');
}

// ─── Campaigns ───────────────────────────────────────────────────────

export interface PilotCampaigns { plan: PilotPlan; env: Record<string, string>; campaigns: Array<{ name: string; file: string }>; commands: Array<{ name: string; argv: string[] }> }

/**
 * Write the pilot's campaigns into `out`: one per row and one for the judge check, each its own ledger at its cap, and
 * plan.json with the re-read and labelling commands. Refuses without a granted window, or when the ledgers' caps
 * together pass the window's cap.
 */
export function writePilotCampaigns(m: WeeklyPilotManifest, o: { out: string; window?: string; windowCapUsd?: number; worldEnd?: string }): PilotCampaigns {
  if (!o.window) refuse('PILOT_NO_WINDOW', 'the pilot and the judge check spend on providers, so their campaigns are written only for a granted paid window; pass --window-granted <unit>');
  if (!(Number.isFinite(o.windowCapUsd) && o.windowCapUsd! > 0)) refuse('PILOT_NO_WINDOW', 'pass --window-cap-usd <the granted window\'s cap>, which the ledgers\' caps together may not pass');
  if (!o.worldEnd) refuse('USAGE', 'pass --world-end <Sunday>, the world end every pilot unit resolves dates from');
  const plan = pilotPlan(m, o.worldEnd!);
  if (plan.totals.cap_usd > o.windowCapUsd! + 1e-9) refuse('PILOT_OVER_WINDOW', `the pilot's and judge check's ledgers cap at ${usd(plan.totals.cap_usd)} together, above the window's ${usd(o.windowCapUsd!)}`);
  mkdirSync(o.out, { recursive: true });
  const campaigns = plan.ledgers.filter(l => l.kind === 'campaign').map(l => {
    const file = join(o.out, `${l.name}.campaign.json`);
    writeFileSync(file, JSON.stringify(weeklyPilotCampaignManifest(m, { units: l.units, campaign_id: l.campaign_id!, cap_usd: l.cap_usd, window: o.window!, worldEnd: o.worldEnd! }), null, 2) + '\n');
    return { name: l.name, file };
  });
  const paid = (cap: number) => ['--paid-window', o.window!, '--window-cap-usd', String(cap), '--ledger-cap-usd', String(cap), '--lease-usd', String(cap)];
  const commands = [
    ...plan.ledgers.filter(l => l.kind === 'reread').map(l => {
      const r = m.reread_plans.find(p => p.id === l.units[0])!;
      return { name: l.name, argv: ['bun', 'eval/runner/q1/reread-cell.ts', '--cell', r.cell, '--arm', r.arm, '--reader', r.reader, '--manifest', 'weekly-pilot', ...paid(l.cap_usd)] };
    }),
    ...plan.ledgers.filter(l => l.kind === 'label').map(l => ({ name: l.name, argv: ['bun', 'eval/runner/weekly-line/judge-check.ts', 'label', ...paid(l.cap_usd)] })),
  ];
  const env = { GBRAIN_EVALS_BG1_WORLD_END: o.worldEnd!, [WEEKLY_PILOT_GBRAIN_ENV]: `${m.gbrain_build.release}@${m.gbrain_build.commit}` };
  writeFileSync(join(o.out, 'plan.json'), JSON.stringify({ ...plan, window: o.window, window_cap_usd: o.windowCapUsd, env, campaigns: campaigns.map(c => ({ name: c.name, file: c.file })), commands }, null, 2) + '\n');
  return { plan, env, campaigns, commands };
}

// ─── The R111 readings ───────────────────────────────────────────────

const readJson = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));
const lines = <T,>(p: string): T[] => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as T) : []);
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const r4 = (x: number | null) => (x === null ? null : Math.round(x * 10_000) / 10_000);

/** One pilot row's readings from one cell out dir, and the re-read's when the row has one. */
export interface RowReading {
  row: WlRow; cell: string; block: string; worlds: string[]; answers: number; by_reader: Record<string, number>; outcomes: Record<string, number>;
  /** Answers that need a verdict (scored or ingest_degraded) and how many have one from their reader's gating judge, parsed. */
  verdicts: { needed: number; given: number; parse_failed: number };
  /** Mean gating score per reader, product failures as 0. */
  accuracy: Record<string, number | null>;
  spend_usd: number | null; spend_source: string | null;
  part_under_test: { ran: boolean; detail: Record<string, unknown> };
  agent?: { seconds_per_answer: number | null; input_tokens_per_answer: number | null; output_tokens_per_answer: number | null; usd_per_answer: number | null; turns_per_answer: number | null; rates: Record<string, number | null>; ripgrep: string | null };
}
export interface RereadReading { cell: string; answers: number; verdicts: { needed: number; given: number }; accuracy: number | null; spend_usd: number | null; status: string | null }

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
    if (row === 'grep-agent') {
      const searchedBy = (a: (typeof answers)[number]) => (a.tool_calls?.grep?.calls ?? 0) - (a.tool_calls?.grep?.failed ?? 0) >= 1;
      const recorded = answers.filter(a => a.tool_calls !== undefined).length;
      const ripgrep = receipt.system?.versions?.ripgrep ?? null;
      const searchedPerReader = Object.fromEntries(readers.map(r => [r, answers.filter(a => a.reader === r && searchedBy(a)).length]));
      part = { ran: ripgrep !== null && answers.length > 0 && recorded === answers.length && readers.every(r => searchedPerReader[r] > 0),
        detail: { ripgrep, answers_with_tool_calls: recorded, answers_with_a_returned_grep: answers.filter(searchedBy).length, answers_with_a_returned_grep_by_reader: searchedPerReader } };
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
      row, cell: cellId, block: receipt.block, worlds: [...staged.keys()].sort(), answers: answers.length, by_reader: count(answers, a => a.reader), outcomes: count(answers, a => a.outcome),
      verdicts: { needed: needed.length, given: needed.filter(a => verdictOf(a)?.parse_ok).length, parse_failed: needed.filter(a => verdictOf(a) && !verdictOf(a)!.parse_ok).length },
      accuracy, spend_usd: typeof receipt.spend?.total_usd === 'number' ? receipt.spend.total_usd : null, spend_source: receipt.spend?.source ?? null, part_under_test: part, ...(agent ? { agent } : {}),
    };
  });
}

/** Read one re-read out dir (reread-cell.ts --out): its cell's receipt, counts and spend from the metering proxy. */
export function readReread(out: string): RereadReading[] {
  return armDirs(out).map(dir => {
    const receipt = readJson(join(dir, 'receipt.json'));
    const spend = receipt.spend ?? {};
    return { cell: String(receipt.cell_id ?? dir), answers: receipt.counts?.answers ?? 0, verdicts: { needed: receipt.counts?.answers_promised ?? 0, given: receipt.counts?.judgments ?? 0 },
      accuracy: Object.values(receipt.per_reader_mean ?? {})[0] as number | null ?? null, spend_usd: typeof spend.reader_usd === 'number' && typeof spend.judge_usd === 'number' ? r2(spend.reader_usd + spend.judge_usd) : null, status: receipt.run_status ?? null };
  });
}

/** R111's verdict per pilot row, the ceiling reading and the week projected at the measured rates. */
export function pilotReport(rows: RowReading[], rereads: RereadReading[], m: Pick<WeeklyPilotManifest, 'pilot_caps'>) {
  const pilot = rows.filter(r => r.block === 'BGW-pilot');
  const perRow = Object.fromEntries((Object.keys(WEEKLY_LINE_ROWS) as WlRow[]).map(row => {
    const r = pilot.find(x => x.row === row);
    const rr = rereads.filter(x => x.cell.startsWith(`${r?.cell ?? '\u0000'}.`));
    const spend = r?.spend_usd === null || r === undefined ? null : r2(r.spend_usd + rr.reduce((s, x) => s + (x.spend_usd ?? 0), 0));
    const worlds = r?.worlds.length || 1;
    const checks = r ? {
      part_under_test_ran: r.part_under_test.ran,
      every_answer_judged: r.verdicts.needed > 0 && r.verdicts.given === r.verdicts.needed && rr.every(x => x.verdicts.given >= x.verdicts.needed),
      both_readers_answered: row === 'grep-agent' ? Object.keys(r.by_reader).length === 2 : rr.length === 1 && rr[0].answers > 0,
      under_cap: spend !== null && spend <= m.pilot_caps[row].cap_usd + 1e-9,
    } : null;
    return [row, { reading: r ?? null, rereads: rr, spend_usd: spend, usd_per_world: spend === null ? null : r2(spend / worlds), cap_usd: m.pilot_caps[row].cap_usd, checks, pass: checks !== null && Object.values(checks).every(Boolean) }];
  }));
  const grep = pilot.find(r => r.row === 'grep-agent');
  const opus = grep?.accuracy['anthropic:claude-opus-5-5'] ?? null;
  const measured = Object.values(perRow).every(x => x.usd_per_world !== null);
  const week = measured ? r2(Object.values(perRow).reduce((s, x) => s + x.usd_per_world!, 0) * WL_WEEK_WORLDS) : null;
  return {
    rows: perRow, judge_check: rows.filter(r => r.block === 'BGW-judge'),
    ceiling: { grep_agent_opus_accuracy: opus, line: CEILING, triggers_longer_worlds: opus !== null && opus >= CEILING },
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

const manifestAt = (gbrain: WeeklyLineGbrainBuild, env: PilotDeps['env']) => loadWeeklyPilotManifest({ ...env, [WEEKLY_PILOT_GBRAIN_ENV]: `${gbrain.release}@${gbrain.commit}` });

export function main(argv: readonly string[], deps: PilotDeps = DEFAULT_DEPS, log: (s: string) => void = s => console.log(s)): number {
  const [mode, ...rest] = argv;
  if (mode === 'plan') {
    const plan = pilotPlan(manifestAt(pilotBuild(rest, deps), deps.env), flag(rest, '--world-end') ?? null);
    log(rest.includes('--json') ? JSON.stringify(plan, null, 2) : renderPilotPlan(plan));
    return 0;
  }
  if (mode === 'campaigns') {
    const out = resolve(flag(rest, '--out') ?? refuse('USAGE', 'pass --out <dir>'));
    const cap = flag(rest, '--window-cap-usd');
    const r = writePilotCampaigns(manifestAt(pilotBuild(rest, deps), deps.env), { out, window: flag(rest, '--window-granted'), windowCapUsd: cap === undefined ? undefined : Number(cap), worldEnd: flag(rest, '--world-end') });
    log(renderPilotPlan(r.plan));
    log(`\nwrote ${r.campaigns.length} campaigns and plan.json to ${out}; every command runs with ${Object.entries(r.env).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    for (const c of r.campaigns) log(`campaign ${c.name}: ${c.file}`);
    for (const c of r.commands) log(`${c.name}: ${c.argv.join(' ')} (the host adds --out, --budget-ledger and --run-id, and --source for a re-read or --cell for the labelling)`);
    return 0;
  }
  if (mode === 'report') {
    const cells = flags(rest, '--cell'), rereads = flags(rest, '--reread');
    if (!cells.length) refuse('USAGE', 'pass --cell <cell out dir> for each pilot or judge-check unit');
    const m = loadWeeklyPilotManifest(deps.env);
    const report = pilotReport(cells.flatMap(d => readRow(resolve(d))), rereads.flatMap(d => readReread(resolve(d))), m);
    log(rest.includes('--json') ? JSON.stringify(report, null, 2) : [
      ...Object.entries(report.rows).map(([row, x]) => `${row}: ${x.reading ? `${x.pass ? 'pass' : 'FAIL'} (${Object.entries(x.checks!).map(([k, v]) => `${k} ${v ? 'yes' : 'NO'}`).join(', ')}); spend ${x.spend_usd === null ? 'unknown' : usd(x.spend_usd)} of cap ${usd(x.cap_usd)}` : 'no pilot output'}`),
      `ceiling: the grep agent with claude-opus-5-5 at ${report.ceiling.grep_agent_opus_accuracy ?? 'n/a'}${report.ceiling.triggers_longer_worlds ? `, at or above ${CEILING}: launch amendment A moves to longer worlds` : ''}`,
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

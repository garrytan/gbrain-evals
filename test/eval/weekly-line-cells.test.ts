/**
 * The weekly outcome line's cell set (eval/runner/q1/cells/weekly-line.ts; docs/benchmarks/2026-11-23-weekly-outcome-line-
 * preregistration.md, harness item 3) and its launch check (eval/runner/weekly-line/launch.ts weeklyLineLaunchProblems):
 * the four rows on one week's Set W worlds with both readers and their judges, particle-1's re-reads, the system-internal
 * models, the models list against the registry entry, and one refusal per launch guard. Keyless and offline: nothing here
 * builds a provider client, and ripgrep is a stub.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { committedLockSha256, requireWeeklyLineLaunch, weeklyLineCalledModels, weeklyLineLaunchProblems, weeklyLineModelProblems, weeklyLineRegistryModels } from '../../eval/runner/weekly-line/launch.ts';
import { OPUS, PARTICLE } from '../../eval/runner/q1/cells/bg1.ts';
import { BG1C_GBRAIN_LAUNCH, BG1C_RATES } from '../../eval/runner/q1/cells/bg1c.ts';
import { ALL_SETS, definitionProblems, PER_READER_JUDGE_SETTINGS, type CellDefinition } from '../../eval/runner/q1/cells/definitions.ts';
import { F6_ARMS } from '../../eval/runner/q1/cells/f6.ts';
import {
  generateWeeklyLineCells, WEEKLY_LINE_BUNDLE_LOCKS, WEEKLY_LINE_FILE_AGENT_HOURS_MARGIN, WEEKLY_LINE_FILE_AGENT_SECONDS_PER_ANSWER, weeklyLineFileAgentHours, WEEKLY_LINE_MODELS, WEEKLY_LINE_PARTICLE_MAX_TOKENS, WEEKLY_LINE_ROWS, weeklyLineRereadPlans,
  type RegistryModel, type WeeklyLineInput,
} from '../../eval/runner/q1/cells/weekly-line.ts';
import { WL_SYSTEMS } from '../../eval/runner/weekly-line/design.ts';

const ROOT = join(import.meta.dir, '..', '..');
const KINDS = new Set((JSON.parse(readFileSync(join(ROOT, 'eval/systems/kinds.json'), 'utf8')) as { kinds: Array<{ id: string }> }).kinds.map(k => k.id));
const ASTRA = 'openai:gpt-6-astra';
const WORLDS = Array.from({ length: 8 }, (_, i) => `bgw-${1001 + i}`);
const GBRAIN = { release: 'v0.60.800.0', commit: 'a'.repeat(40) };
const INPUT: WeeklyLineInput = { week: { launch: '2026-12-08', world_end: '2026-12-06', batch: 'bgw-1001' }, worlds: WORLDS, gbrain: GBRAIN };
const cells = generateWeeklyLineCells(INPUT);
const rereads = weeklyLineRereadPlans(cells);
/** The registry entry as launch amendment A will make it: today's entry plus the extract-first server's common embedder. */
const AMENDED: RegistryModel[] = [...weeklyLineRegistryModels(), { model: 'text-embedding-3-large', role: 'system-internal', system: 'extract-first server (common setup embedder)' }];
const RG = { ripgrep: () => 'ripgrep 14.1.1', registry: AMENDED };
const launch = (over: { gbrain?: typeof GBRAIN; cells?: CellDefinition[]; rereads?: typeof rereads } = {}, deps: Parameters<typeof weeklyLineLaunchProblems>[1] = RG) =>
  weeklyLineLaunchProblems({ gbrain: over.gbrain ?? GBRAIN, cells: over.cells ?? cells, rereads: over.rereads ?? rereads }, deps);
const edit = (system: string, f: (c: CellDefinition) => CellDefinition) => cells.map(c => (c.system === system ? f(structuredClone(c)) : c));

describe('generateWeeklyLineCells', () => {
  test('four rows on the week\'s Set W worlds, one launch unit each, every one runnable', () => {
    expect(cells.map(c => `${c.system}.${c.configuration}`)).toEqual(Object.values(WEEKLY_LINE_ROWS).map(r => `${r.system}.${r.configuration}`));
    expect(cells.map(c => WL_SYSTEMS[c.system])).toEqual(['gbrain', 'grep-agent', 'extract-first', 'memory-bank']);
    for (const c of cells) {
      expect([c.set, c.block, c.benchmark, c.split, c.canonical_instrument, c.effort, c.descriptive_view, c.shards]).toEqual(['BGW', 'BGW', 'bgw', 'sealed', 'bg1', 'medium', false, 1]);
      expect(c.week).toEqual({ ...INPUT.week, worlds: WORLDS });
      expect(c.probes.sample).toBe(0);
      expect(definitionProblems(c, KINDS)).toEqual([]);
    }
  });

  test('G8 runs arm P at the build passed in, with BG1-C\'s launch; no other cell names a gbrain build', () => {
    const [g8] = cells;
    expect(g8.arms.map(a => [a.id, a.mode, a.budget, a.retrieval])).toEqual([['p', 'packed', 8000, F6_ARMS.p.retrieval]]);
    expect(g8.launch).toEqual({ env: { ...BG1C_GBRAIN_LAUNCH.env, GBRAIN_SHA: GBRAIN.commit, GBRAIN_F6_EXTRACT_CAP_USD: '1' }, config: 'recipe' });
    expect(g8.gbrain_build).toEqual(GBRAIN);
    const other = generateWeeklyLineCells({ ...INPUT, gbrain: { release: 'v0.60.801.0', commit: 'b'.repeat(40) } })[0];
    expect([other.launch!.env.GBRAIN_SHA, other.gbrain_build!.release]).toEqual(['b'.repeat(40), 'v0.60.801.0']);
    expect(cells.slice(1).every(c => c.gbrain_build === undefined)).toBe(true);
  });

  test('readers and judges: Opus reads the 8,000-token rows live, both readers run the grep agent, each judged by its mapped judge', () => {
    for (const c of cells) {
      expect(c.arms).toHaveLength(1);
      const a = c.arms[0];
      const readers = c.system === 'baseline-file-agent' ? [OPUS, PARTICLE] : [OPUS];
      expect([a.mode, a.readers]).toEqual([c.system === 'baseline-file-agent' ? 'agent' : 'packed', readers]);
      expect(a.frontier).toEqual({ judges: [...new Set(readers.map(r => (r === OPUS ? ASTRA : OPUS)))].sort(), readers: null, sample: null, per_reader: true,
        judge_by_reader: Object.fromEntries(readers.map(r => [r, r === OPUS ? ASTRA : OPUS])), settings: { ...PER_READER_JUDGE_SETTINGS } });
    }
    expect(cells[1]).toMatchObject({ runner: 'in-process', arms: [{ id: 'whole-agent', label: 'grep agent, uncapped ripgrep, 40 turns' }] });
  });

  test('particle-1 re-reads G8, EF and MB byte for byte at effort medium and its output floor, judged by claude-opus-5-5; FS has no re-read', () => {
    expect(rereads.map(r => r.arm_cell_id)).toEqual(['bgw.gbrain-defaults.rs1-stable.p', 'bgw.ext-extract-first.common.component-b8000', 'bgw.ext-memory-bank.recipe.component-b8000']);
    for (const r of rereads) {
      expect([r.reader, r.judges, r.worlds, r.effort, r.max_tokens, r.set, r.block]).toEqual([PARTICLE, [OPUS], WORLDS, 'medium', WEEKLY_LINE_PARTICLE_MAX_TOKENS, 'BGW', 'BGW']);
      expect(r.id).toBe(`${r.arm_cell_id}.reread-particle-particle-1`);
      expect(r.estimate.usd).toBeCloseTo(512 * (BG1C_RATES.particle_read_usd_per_answer + BG1C_RATES.particle_judge_usd_per_answer), 2);
    }
    expect(WEEKLY_LINE_PARTICLE_MAX_TOKENS).toBe(16_000);
  });

  test('a full week at BG1-C\'s measured rate per world for each 8,000-token row', () => {
    for (const c of cells.filter(c => c.system !== 'baseline-file-agent')) {
      expect(c.estimate.usd).toBeCloseTo(ALL_SETS.BGW.conversations * BG1C_RATES.row_usd_per_world[`${c.system}:${c.configuration}`], 2);
    }
    expect(Object.keys(cells[1].estimate.lines)).toEqual(['agent', 'frontier_judges']);
  });

  test('the system-internal models: each compared system\'s shipped models, gpt-4o-mini only as the memory-bank server\'s', () => {
    const internal = WEEKLY_LINE_MODELS.filter(m => m.role === 'system-internal');
    expect(internal).toEqual([
      { model: 'openai:gpt-4.1-mini', role: 'system-internal', system: 'ext-extract-first' },
      { model: 'openai:text-embedding-3-large', role: 'system-internal', system: 'ext-extract-first' },
      { model: 'openai:gpt-4o-mini', role: 'system-internal', system: 'ext-memory-bank' },
      { model: 'anthropic:claude-haiku-5-5', role: 'system-internal', system: 'gbrain-defaults' },
      { model: 'voyage:voyage-4', role: 'system-internal', system: 'gbrain-defaults' },
    ]);
    expect(WEEKLY_LINE_MODELS.filter(m => m.role !== 'system-internal')).toEqual([
      { model: OPUS, role: 'under-test' }, { model: PARTICLE, role: 'under-test' }, { model: ASTRA, role: 'judge' }, { model: OPUS, role: 'judge' },
    ]);
  });

  // Value: protects=every model a weekly cell can call is in both the code's list and the registry entry, the extract-first server's common embedder included, so the launch check refuses until launch amendment A registers it; fails_when=a model a cell calls (text-embedding-3-large from shim.py's common setup, or a reader, judge or shipped model) is missing from either list and the week still launches; why_new=#615 final review finding 2 (weekly-line.ts:76), owed by the wiring PR (GBEV-3 ruling); seam=weekly-line.ts WEEKLY_LINE_MODELS and launch.ts weeklyLineLaunchProblems over weeklyLineCalledModels; no_claim=parsing the shims' own configuration
  test('the models list matches the registry entry less the mint\'s simulators, except the common embedder until launch amendment A', () => {
    const registry = weeklyLineRegistryModels();
    expect(registry.length).toBeGreaterThan(0);
    expect(readFileSync(join(ROOT, 'eval/systems/extract-first/shim.py'), 'utf8')).toContain('"model": "text-embedding-3-large"');
    expect(weeklyLineModelProblems(registry)).toEqual(['the cell set calls text-embedding-3-large as system-internal, which the registry entry (docs/benchmarks/preregistrations.d/weekly-outcome-line.json) doesn\'t list']);
    expect(weeklyLineModelProblems(AMENDED)).toEqual([]);
    expect(launch({}, { ...RG, registry })).toEqual([
      'the cell set calls text-embedding-3-large as system-internal, which the registry entry (docs/benchmarks/preregistrations.d/weekly-outcome-line.json) doesn\'t list',
      'a weekly cell can call text-embedding-3-large as system-internal, which the registry entry (docs/benchmarks/preregistrations.d/weekly-outcome-line.json) doesn\'t list',
    ]);
    expect(() => requireWeeklyLineLaunch({ gbrain: GBRAIN, cells, rereads }, { ripgrep: RG.ripgrep })).toThrow(/refused before any cell starts: .*text-embedding-3-large/);
    expect(weeklyLineCalledModels(cells, rereads).filter(m => m.role === 'system-internal').map(m => m.model).sort()).toEqual(WEEKLY_LINE_MODELS.filter(m => m.role === 'system-internal').map(m => m.model).sort());
    const unlisted = rereads.map((r, i) => (i ? r : { ...r, judges: ['openai:gpt-6.2-astra'] }));
    expect(launch({ rereads: unlisted })).toContain("a weekly cell can call gpt-6.2-astra as judge, which WEEKLY_LINE_MODELS doesn't name");
    expect(launch({ rereads: unlisted })).toContain("a weekly cell can call gpt-6.2-astra as judge, which the registry entry (docs/benchmarks/preregistrations.d/weekly-outcome-line.json) doesn't list");
  });

  // Value: protects=the grep agent's cell is timed from the week's answer count at the stated per-answer assumption with a margin, so its VM is not stopped mid-week by the one-hour default; fails_when=the grep agent keeps the default hours (a 4-hour VM limit for 1,024 agent answers) or its hours ignore the week's world count; why_new=#615 final review finding 3 (weekly-line.ts:180), owed by the wiring PR (GBEV-3 ruling); seam=weekly-line.ts generateWeeklyLineCells and weeklyLineFileAgentHours; no_claim=the per-answer time itself, which the pilot measures
  test("the grep agent's hours follow the week's answer count at the per-answer assumption with its margin", () => {
    const fs = cells.find(c => c.system === 'baseline-file-agent')!;
    expect([WEEKLY_LINE_FILE_AGENT_SECONDS_PER_ANSWER, WEEKLY_LINE_FILE_AGENT_HOURS_MARGIN]).toEqual([90, 1.5]);
    expect(fs.expected_hours).toBe(Math.ceil(8 * 64 * 2 * 90 * 1.5 / 3600));
    expect(fs.expected_hours).toBe(39);
    expect(Math.min(72, Math.ceil(fs.expected_hours * 1.5) + 2)).toBe(61);
    const short = generateWeeklyLineCells({ ...INPUT, worlds: WORLDS.slice(0, 2) }).find(c => c.system === 'baseline-file-agent')!;
    expect(short.expected_hours).toBe(weeklyLineFileAgentHours(2));
    expect(short.expected_hours).toBe(10);
    expect(definitionProblems(fs, KINDS)).toEqual([]);
  });

  test('definitionProblems: a Set W cell names its week and only a Set W cell does; gbrain_build sits on the gbrain cell it launches', () => {
    const [g8, fs] = cells;
    expect(definitionProblems({ ...fs, week: undefined }, KINDS)).toEqual(['a Set W (bgw) cell names its week (launch, world_end, batch, worlds), and only a Set W cell does']);
    expect(definitionProblems({ ...fs, week: { ...fs.week!, worlds: ['bg1-031'] } }, KINDS)).toEqual(['week.worlds must list 1 to 8 distinct Set W world ids (bgw- and four digits)']);
    expect(definitionProblems({ ...g8, launch: { ...g8.launch!, env: { ...g8.launch!.env, GBRAIN_SHA: 'b'.repeat(40) } } }, KINDS)).toEqual(['gbrain_build names the build of a gbrain cell, whose launch GBRAIN_SHA is its commit']);
  });

  test('refuses a week that is not a Set W week, and a build that is not a release and a full commit', () => {
    const bad = (over: Partial<WeeklyLineInput>) => () => generateWeeklyLineCells({ ...INPUT, ...over });
    expect(bad({ week: { ...INPUT.week, launch: '2026-12-09' } })).toThrow('not a Tuesday');
    expect(bad({ week: { ...INPUT.week, world_end: '2026-12-05' } })).toThrow('is not 2026-12-06');
    expect(bad({ worlds: [...WORLDS.slice(0, 7), 'bg1-031'] })).toThrow('not Set W worlds');
    expect(bad({ worlds: [...WORLDS, 'bgw-1009'] })).toThrow('1 to 8 worlds');
    expect(bad({ worlds: [WORLDS[1], WORLDS[0]] })).toThrow('slot order');
    expect(bad({ gbrain: { release: 'master', commit: GBRAIN.commit } })).toThrow('not a version tag');
    expect(bad({ gbrain: { release: GBRAIN.release, commit: 'abc1234' } })).toThrow('full 40-character sha');
  });
});

describe('weeklyLineLaunchProblems', () => {
  test('the generated week launches', () => {
    expect(launch()).toEqual([]);
    expect(() => requireWeeklyLineLaunch({ gbrain: GBRAIN, cells, rereads }, RG)).not.toThrow();
  });

  test('refuses the grep agent without ripgrep', () => {
    expect(launch({}, { ...RG, ripgrep: () => null })).toEqual(["ripgrep (rg) can't run on this host, and the grep agent's cell needs it"]);
    expect(launch({ cells: cells.filter(c => c.system !== 'baseline-file-agent') }, { ...RG, ripgrep: () => null })).toEqual(['the week has 0 grep-agent cells (baseline-file-agent.baseline), not one']);
    expect(() => requireWeeklyLineLaunch({ gbrain: GBRAIN, cells, rereads }, { ...RG, ripgrep: () => null })).toThrow('refused before any cell starts');
  });

  test('refuses a gbrain cell pinned to a build other than the one resolved at launch', () => {
    const newer = { release: 'v0.60.801.0', commit: 'b'.repeat(40) };
    expect(launch({ gbrain: newer })).toEqual([`cell bgw.gbrain-defaults.rs1-stable pins gbrain v0.60.800.0 at ${GBRAIN.commit}, not v0.60.801.0 at ${newer.commit}, the build resolved at launch`]);
    const sha = edit('gbrain-defaults', c => ({ ...c, launch: { ...c.launch!, env: { ...c.launch!.env, GBRAIN_SHA: newer.commit } } }));
    expect(launch({ cells: sha })).toContain(`cell bgw.gbrain-defaults.rs1-stable pins gbrain v0.60.800.0 at ${newer.commit}, not v0.60.800.0 at ${GBRAIN.commit}, the build resolved at launch`);
  });

  test('refuses a week that does not hold each preregistered row exactly once, or that adds a canonical judge', () => {
    expect(launch({ cells: cells.slice(1), rereads: rereads.slice(1) })).toEqual(['the week has 0 gbrain cells (gbrain-defaults.rs1-stable), not one']);
    expect(launch({ cells: cells.filter(c => c.system !== 'ext-memory-bank'), rereads: rereads.filter(r => !r.cell.includes('memory-bank')) })).toEqual(['the week has 0 memory-bank cells (ext-memory-bank.recipe), not one']);
    expect(launch({ cells: [...cells, cells[1]] })).toEqual(['the week has 2 grep-agent cells (baseline-file-agent.baseline), not one']);
    const other = { ...cells[3], id: 'bgw.ext-memory-bank.common', configuration: 'common' };
    expect(launch({ cells: [...cells, other] })).toContain('cell bgw.ext-memory-bank.common is not one of the preregistered rows');
    const graded = edit('ext-extract-first', c => { const { descriptive_view: _, ...rest } = c; return rest as CellDefinition; });
    expect(launch({ cells: graded })).toEqual(["cell bgw.ext-extract-first.common would add its instrument's canonical judge to every answer (descriptive_view is not false)"]);
  });

  // Value: protects=each cell's arm reads at its row's mode and reading budget (an 8,000-token read, or the grep agent with none), and has only that arm; fails_when=a hand-edited 16,000-token read, a packed grep agent, an agent-mode server or a second arm passes the launch check; why_new=#615 final review finding 1 (launch.ts:65), owed by the wiring PR (GBEV-3 ruling); seam=launch.ts weeklyLineLaunchProblems over WEEKLY_LINE_ROWS; no_claim=the arm's retrieval settings
  test("refuses an arm whose mode or reading budget is not its row's, or a second arm", () => {
    const wide = edit('ext-extract-first', c => { c.arms[0].budget = 16000; return c; });
    expect(launch({ cells: wide }).join('; ')).toContain("arm bgw.ext-extract-first.common.component-b8000 reads in mode packed at 16000 token budget, not its row's packed at 8000 token budget");
    const g8 = edit('gbrain-defaults', c => { c.arms[0].budget = 16000; return c; });
    expect(launch({ cells: g8 }).join('; ')).toContain("not its row's packed at 8000 token budget");
    const packedGrep = edit('baseline-file-agent', c => { c.arms[0].mode = 'packed'; c.arms[0].budget = 8000; return c; });
    expect(launch({ cells: packedGrep }).join('; ')).toContain("reads in mode packed at 8000 token budget, not its row's agent at no token budget");
    const agentServer = edit('ext-memory-bank', c => { c.arms[0].mode = 'agent'; delete (c.arms[0] as { budget?: number }).budget; return c; });
    expect(launch({ cells: agentServer }).join('; ')).toContain("reads in mode agent at no token budget, not its row's packed at 8000 token budget");
    const twoArms = edit('ext-memory-bank', c => { c.arms.push({ ...c.arms[0], id: 'b16000', cell_id: `${c.id}.b16000`, budget: 16000 }); return c; });
    expect(launch({ cells: twoArms }).join('; ')).toContain('cell bgw.ext-memory-bank.recipe has 2 arms');
  });

  // Value: protects=a week launches only when the committed bundle lockfiles of both servers (the pin table's and the shim's) hash to #594's patched locks, extract-first 9c32b495 and memory-bank 29b875e0; fails_when=a lockfile is missing, reverted to BG1-C's lock or edited and the week still launches; why_new=GBEV-3 ruling 2026-11-23 (bundle locks); seam=launch.ts weeklyLineLaunchProblems over WEEKLY_LINE_BUNDLE_LOCKS and committedLockSha256; no_claim=the lock the machine's image actually installs, which the cell's capability receipt records
  test("refuses unless both servers' committed lockfiles are #594's patched locks", () => {
    expect(Object.values(WEEKLY_LINE_BUNDLE_LOCKS).flatMap(l => l.files.map(f => committedLockSha256(f)!.slice(0, 8)))).toEqual(['9c32b495', '9c32b495', '29b875e0', '29b875e0']);
    expect(launch()).toEqual([]);
    const pinned = (over: Record<string, string | null>) => ({ ...RG, lockSha256: (f: string) => (f in over ? over[f] : committedLockSha256(f)) });
    expect(launch({}, pinned({ 'eval/systems/extract-first/uv.lock': '9777b7a8'.padEnd(64, '0') }))).toEqual(["ext-extract-first's bundle lock eval/systems/extract-first/uv.lock hashes to 9777b7a8, not the patched lock 9c32b495 the line runs on"]);
    expect(launch({}, pinned({ 'docs/comparison-systems/ext-memory-bank/uv.lock': null }))).toEqual(["ext-memory-bank's bundle lock docs/comparison-systems/ext-memory-bank/uv.lock is missing, not the patched lock 29b875e0 the line runs on"]);
    expect(launch({ cells: cells.filter(c => c.system !== 'ext-memory-bank') }, pinned({ 'docs/comparison-systems/ext-memory-bank/uv.lock': null })).join('; ')).not.toContain('bundle lock');
  });

  test('refuses a world outside Set W, a cell on another set, and cells or re-reads of different weeks', () => {
    const outside = cells.map(c => ({ ...c, week: { ...c.week!, worlds: [...WORLDS.slice(0, 7), 'bg1-031'] } }));
    expect(launch({ cells: outside, rereads: weeklyLineRereadPlans(outside) })).toContain('world(s) bg1-031 are not Set W worlds of batch bgw-1001');
    const later = cells.map(c => ({ ...c, week: { ...c.week!, worlds: ['bgw-1057'] } }));
    expect(launch({ cells: later, rereads: weeklyLineRereadPlans(later) })).toEqual(['world(s) bgw-1057 are not Set W worlds of batch bgw-1001']);
    expect(launch({ cells: edit('ext-memory-bank', c => ({ ...c, set: 'BG1C', benchmark: 'bg1c', block: 'BG1C' })) })).toContain('cell bgw.ext-memory-bank.recipe runs set BG1C (bg1c), not Set W');
    expect(launch({ cells: edit('ext-memory-bank', c => ({ ...c, week: { ...c.week!, worlds: WORLDS.slice(0, 4) } })) })).toContain('cell bgw.ext-memory-bank.recipe runs another week than bgw.gbrain-defaults.rs1-stable');
    expect(launch({ rereads: rereads.map((r, i) => (i ? r : { ...r, arm_cell_id: 'bgw.baseline-file-agent.baseline.whole-agent', cell: 'bgw.baseline-file-agent.baseline' })) })).toContain(`re-read ${rereads[0].id} reads no 8,000-token arm of this week's cells`);
    expect(launch({ rereads: rereads.map((r, i) => (i ? r : { ...r, worlds: WORLDS.slice(4) })) })).toEqual([`re-read ${rereads[0].id} reads worlds ${WORLDS.slice(4).join(', ')}, not the week's`]);
  });

  test('refuses a reader or a judge outside the preregistered lists', () => {
    const sol = 'openai:gpt-6.2-sol';
    const solReader = edit('ext-extract-first', c => ({ ...c, arms: c.arms.map(a => ({ ...a, readers: [OPUS, sol], frontier: { ...a.frontier!, judge_by_reader: { ...a.frontier!.judge_by_reader, [sol]: OPUS } } })) }));
    expect(launch({ cells: solReader })).toContain(`arm bgw.ext-extract-first.common.component-b8000 is read by ${OPUS}, ${sol}, not ${OPUS}`);
    const liveParticle = edit('ext-extract-first', c => ({ ...c, arms: c.arms.map(a => ({ ...a, readers: [OPUS, PARTICLE], frontier: { ...a.frontier!, judge_by_reader: { ...a.frontier!.judge_by_reader, [PARTICLE]: OPUS } } })) }));
    expect(launch({ cells: liveParticle })).toEqual([`arm bgw.ext-extract-first.common.component-b8000 is read by ${OPUS}, ${PARTICLE}, not ${OPUS}`]);
    const opusOnlyAgent = edit('baseline-file-agent', c => ({ ...c, arms: c.arms.map(a => ({ ...a, readers: [OPUS] })) }));
    expect(launch({ cells: opusOnlyAgent })).toEqual([`arm bgw.baseline-file-agent.baseline.whole-agent is read by ${OPUS}, not ${OPUS}, ${PARTICLE}`]);
    expect(launch({ rereads: rereads.slice(1) })).toEqual([`arm bgw.gbrain-defaults.rs1-stable.p has 0 particle-1 re-reads, not one`]);
    expect(launch({ rereads: [...rereads, rereads[2]] })).toEqual([`arm bgw.ext-memory-bank.recipe.component-b8000 has 2 particle-1 re-reads, not one`]);
    const selfJudged = edit('baseline-file-agent', c => ({ ...c, arms: c.arms.map(a => ({ ...a, frontier: { ...a.frontier!, judge_by_reader: { ...a.frontier!.judge_by_reader, [OPUS]: OPUS } } })) }));
    expect(launch({ cells: selfJudged })).toContain(`arm bgw.baseline-file-agent.baseline.whole-agent: ${OPUS} is judged by ${OPUS}, not ${ASTRA}`);
    const particleJudges = rereads.map((r, i) => (i ? r : { ...r, judges: [PARTICLE] }));
    expect(launch({ rereads: particleJudges })).toContain(`re-read ${rereads[0].id}: ${PARTICLE} is judged by ${PARTICLE}, not ${OPUS}`);
    const opusReread = rereads.map((r, i) => (i ? r : { ...r, reader: OPUS, judges: [ASTRA] }));
    expect(launch({ rereads: opusReread })).toEqual([`re-read ${rereads[0].id} is read by ${OPUS}, not ${PARTICLE}`]);
  });

  test('refuses a suspended model in a role we choose, and allows gpt-4o-mini only as the memory-bank server\'s system-internal model', () => {
    const suspended = 'openai:gpt-4o-mini';
    const judged = edit('baseline-file-agent', c => ({ ...c, arms: c.arms.map(a => ({ ...a, frontier: { ...a.frontier!, judge_by_reader: { ...a.frontier!.judge_by_reader, [PARTICLE]: suspended } } })) }));
    expect(launch({ cells: judged })).toContain(`${suspended}: gpt-4o and gpt-4o-mini are suspended for new campaigns from 2026-11-21 (CLAUDE.md "Choose models")`);
    const read = rereads.map((r, i) => (i ? r : { ...r, reader: 'openai:gpt-4o' }));
    expect(launch({ rereads: read })).toContain('openai:gpt-4o: gpt-4o and gpt-4o-mini are suspended for new campaigns from 2026-11-21 (CLAUDE.md "Choose models")');
    const registry = AMENDED;
    const asJudge: RegistryModel[] = registry.map(m => (m.model === 'gpt-4o-mini' ? { ...m, role: 'judge' } : m));
    expect(launch({}, { ...RG, registry: asJudge })).toContain('gpt-4o-mini: gpt-4o and gpt-4o-mini are suspended for new campaigns from 2026-11-21 (CLAUDE.md "Choose models")');
    expect(weeklyLineModelProblems(registry, WEEKLY_LINE_MODELS.map(m => (m.system === 'ext-memory-bank' ? { model: m.model, role: 'extractor' } : m)))).toContain('openai:gpt-4o-mini: gpt-4o and gpt-4o-mini are suspended for new campaigns from 2026-11-21 (CLAUDE.md "Choose models")');
  });

  test('refuses a models list that disagrees with the registry entry', () => {
    const registry = AMENDED;
    expect(launch({}, { ...RG, registry: registry.filter(m => m.model !== 'gpt-4.1-mini') })).toEqual([
      'the cell set calls gpt-4.1-mini as system-internal, which the registry entry (docs/benchmarks/preregistrations.d/weekly-outcome-line.json) doesn\'t list',
      'a weekly cell can call gpt-4.1-mini as system-internal, which the registry entry (docs/benchmarks/preregistrations.d/weekly-outcome-line.json) doesn\'t list',
    ]);
    expect(launch({}, { ...RG, registry: [...registry, { model: 'gpt-6.2-sol', role: 'under-test' }] })).toEqual(['the registry entry lists gpt-6.2-sol as under-test, which the cell set doesn\'t call']);
    expect(launch({}, { ...RG, registry: [...registry, { model: 'gemini-4-argon', role: 'simulator' }] })).toEqual([]);
  });
});

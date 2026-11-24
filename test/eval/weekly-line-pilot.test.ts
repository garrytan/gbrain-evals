/**
 * The weekly line's pilot and judge check on public dev worlds (eval/runner/weekly-line/pilot.ts and judge-check.ts, the
 * cells weekly-line.ts generateWeeklyLinePilotCells and generateWeeklyLineJudgeCheckCells build). Keyless: every key is
 * blank, fetch throws for the whole file, the newest gbrain tag is an injected ls-remote line, and the one labelling path
 * that could spend refuses before any lease, proxy or file.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bg1LaunchProblems } from '../../eval/runner/bg1/launch.ts';
import { cohenKappa } from '../../eval/runner/bg1/judge-check.ts';
import { loadBg1Dev, type MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';
import { answerId, answerProblems, sha256, type AnswerRecord } from '../../eval/runner/memory-qa/records.ts';
import { loadWeeklyPilotManifest, windowedRunGuard } from '../../eval/runner/q1/cell.ts';
import { bg1JudgeOf, isWeeklyLineCell } from '../../eval/runner/q1/cells/definitions.ts';
import {
  buildWeeklyPilotManifest, generateWeeklyLineCells, generateWeeklyLineJudgeCheckCells, generateWeeklyLinePilotCells, WEEKLY_LINE_BLOCK_WORLDS, WEEKLY_LINE_JUDGE_CHECK_PAUSE_USD,
  WEEKLY_LINE_LABEL_CAP_USD, WEEKLY_LINE_RATES, WEEKLY_LINE_READERS, WEEKLY_PILOT_GBRAIN_ENV, weeklyLinePilotCaps,
} from '../../eval/runner/q1/cells/weekly-line.ts';
import { prepareReread } from '../../eval/runner/q1/reread-cell.ts';
import { ScoreboardError } from '../../eval/runner/q1/scoreboard-errors.ts';
import { toolCalls } from '../../eval/runner/systems/file-agent.ts';
import { WL_BLOCK_WORLDS } from '../../eval/runner/weekly-line/design.ts';
import { analyze, answerKind, buildSample, main as judgeCheckMain, MODEL_LABEL_SOURCE, poolAnswers, ruleZero, type PoolAnswer } from '../../eval/runner/weekly-line/judge-check.ts';
import { main as pilotMain, pilotPlan, pilotReport, readRow, writePilotCampaigns, type RowReading } from '../../eval/runner/weekly-line/pilot.ts';

const tmp = mkdtempSync(join(tmpdir(), 'weekly-line-pilot-'));
let n = 0;
const scratch = (name: string) => { const d = join(tmp, `${name}-${++n}`); mkdirSync(d, { recursive: true }); return d; };
const realFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = (() => { throw new Error('the weekly pilot tests are offline'); }) as unknown as typeof fetch; });
afterAll(() => { globalThis.fetch = realFetch; rmSync(tmp, { recursive: true, force: true }); });
const KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'BG1_GEMINI_API_KEY', 'PARTICLE_API_KEY', 'VOYAGE_API_KEY', 'SHOOTOUT_PROXY', 'SHOOTOUT_KEYLESS_UPSTREAM'];
let saved: NodeJS.ProcessEnv = {};
beforeEach(() => { saved = { ...process.env }; for (const k of KEYS) process.env[k] = ''; });
afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });

const refused = async (p: Promise<unknown>) => { try { await p; } catch (e) { if (e instanceof ScoreboardError) return e.op; throw e; } return null; };
const refusal = (f: () => unknown) => { try { f(); } catch (e) { if (e instanceof ScoreboardError) return e.op; throw e; } return null; };
const message = (f: () => unknown) => { try { f(); } catch (e) { return (e as Error).message; } return null; };
const REPO = resolve(import.meta.dir, '../..');
const DEAD = 'http://127.0.0.1:9';

const GBRAIN = { release: 'v0.61.10.0', commit: '2'.repeat(40) };
const GBRAIN_ENV = { [WEEKLY_PILOT_GBRAIN_ENV]: `${GBRAIN.release}@${GBRAIN.commit}` };
/** A Sunday two days before this file was written; the guard refuses on the window before it reads the clock. */
const WORLD_END = '2026-11-22';
const manifest = buildWeeklyPilotManifest(GBRAIN);
const pilot = generateWeeklyLinePilotCells(GBRAIN);
const judge = generateWeeklyLineJudgeCheckCells();
const OPUS = 'anthropic:claude-opus-5-5', PARTICLE = 'particle:particle-1';

describe('the pilot and judge-check cells', () => {
  // Value: protects=the pilot measures the counted cells: the same systems, configurations, readers, judges, effort and limits as a counted week, only on a public dev world; fails_when=generateWeeklyLinePilotCells builds its cells by hand, or the weekly generator's refactor lets a pilot cell drift from the counted cell in any field besides its set, loader, worlds, build window and lease; why_new=R111 asks the pilot to show the counted arm's part ran, which a pilot of other settings can't; seam=weekly-line.ts generateWeeklyLinePilotCells and generateWeeklyLineJudgeCheckCells against generateWeeklyLineCells; no_claim=the counted week's own fields (weekly-line-cells.test.ts)
  test('every pilot cell is its counted cell on bg1-dev-01, and the judge check is the grep agent on bg1-dev-02 and bg1-dev-03', () => {
    const counted = generateWeeklyLineCells({ week: { launch: '2026-12-08', world_end: '2026-12-06', batch: 'bgw-1001' }, worlds: ['bgw-1001', 'bgw-1002'], gbrain: GBRAIN });
    const strip = (c: any) => JSON.parse(JSON.stringify(c, (k, v) => (['id', 'cell_id', 'set', 'block', 'benchmark', 'split', 'expected_hours', 'estimate', 'week', 'only_conversations', 'lease'].includes(k) ? undefined : v)));
    expect(pilot.map(c => c.system)).toEqual(counted.map(c => c.system));
    for (const c of pilot) {
      const k = counted.find(x => x.system === c.system)!;
      expect(strip(c)).toEqual(strip(k));
      expect([c.id, c.set, c.block, c.benchmark, c.split, c.only_conversations]).toEqual([k.id.replace(/^bgw\./, 'bgw-pilot.'), 'BGW-pilot', 'BGW-pilot', 'bg1-dev', 'dev', ['bg1-dev-01']]);
      expect(isWeeklyLineCell(c)).toBe(true);
    }
    expect(judge.map(c => [c.id, c.system, c.only_conversations, c.arms[0].readers ?? null])).toEqual([['bgw-judge.baseline-file-agent.baseline', 'baseline-file-agent', ['bg1-dev-02', 'bg1-dev-03'], pilot.find(c => c.system === 'baseline-file-agent')!.arms[0].readers ?? null]]);
    expect(strip(judge[0])).toEqual(strip(pilot.find(c => c.system === 'baseline-file-agent')));
  });

  // Value: protects=each row's pilot spends at most a tenth of its block budget, split between its cell's lease and particle-1's re-read, and the judge check's two ledgers sum to its pause; fails_when=a cap rounds up past its line, the re-read cap is added on top of the tenth, or the block-worlds constant drifts from the design's 32; why_new=R111's tenth, applied per arm (GBEV-128 brief); seam=weekly-line.ts weeklyLinePilotCaps and the cells' leases; no_claim=whether the rates themselves are right (they are the counted estimates)
  test("each row's caps sit within a tenth of its block budget, and each cell's lease is its row's cell cap", () => {
    expect(WEEKLY_LINE_BLOCK_WORLDS).toBe(WL_BLOCK_WORLDS);
    const caps = weeklyLinePilotCaps();
    for (const [row, c] of Object.entries(caps)) {
      const budget = WEEKLY_LINE_RATES[row as keyof typeof WEEKLY_LINE_RATES] * WEEKLY_LINE_BLOCK_WORLDS;
      expect(c.cap_usd).toBeLessThanOrEqual(budget / 10 + 1e-9);
      expect(c.cells_cap_usd + c.reread_cap_usd).toBeLessThanOrEqual(c.cap_usd + 1e-9);
      expect(pilot.find(p => p.system === manifest.cells.find(m => m.block === 'BGW-pilot' && m.id === p.id)!.system && p.lease!.usd === c.cells_cap_usd)).toBeDefined();
    }
    for (const p of pilot) expect(p.lease!.usd).toBeGreaterThan(p.estimate.usd);
    expect(judge[0].lease!.usd + WEEKLY_LINE_LABEL_CAP_USD).toBeLessThanOrEqual(WEEKLY_LINE_JUDGE_CHECK_PAUSE_USD + 1e-9);
    expect(manifest.reread_plans.map(r => r.reader)).toEqual([PARTICLE, PARTICLE, PARTICLE]);
  });

  // Value: protects=a pilot unit on a VM regenerates exactly the cells its plan named; fails_when=loadWeeklyPilotManifest falls back to some default build when the variable is unset or malformed; why_new=the pilot's cells carry a gbrain build that only its plan resolved (R100); seam=cell.ts loadWeeklyPilotManifest; no_claim=the build's resolution from git tags (pilot.ts plan test)
  test('the pilot manifest loads only at a named release and commit', () => {
    expect(refusal(() => loadWeeklyPilotManifest({}))?.code).toBe('PREFLIGHT_FAILED');
    expect(refusal(() => loadWeeklyPilotManifest({ [WEEKLY_PILOT_GBRAIN_ENV]: 'v0.61.10.0@abc' }))?.code).toBe('PREFLIGHT_FAILED');
    expect(loadWeeklyPilotManifest(GBRAIN_ENV).cells.map(c => c.id)).toEqual([...pilot, ...judge].map(c => c.id));
  });
});

describe('the paid-window guard covers the pilot and judge-check cells', () => {
  // Value: protects=no pilot or judge-check cell spends real keys outside a granted paid window; fails_when=windowedRunGuard leaves bg1-dev cells of the weekly line out, or names the wrong manifest in its fix; why_new=GBEV-128 brief: the bgw window guard must cover the new cells, with a keyless test; seam=cell.ts windowedRunGuard, the first thing cell.ts run calls; no_claim=the window's cap arithmetic (bg1-window.test.ts)
  test('every pilot and judge-check cell refuses to run without a granted window, naming the weekly-pilot manifest', async () => {
    for (const def of [...pilot, ...judge]) {
      const op = await refused(windowedRunGuard([], def, { GBRAIN_EVALS_BG1_WORLD_END: WORLD_END, ...GBRAIN_ENV }));
      expect(op).toMatchObject({ code: 'PAID_FLAGS_MISSING', message: expect.stringContaining(`weekly pilot cell ${def.id}`) });
      expect(op!.fix.argv).toEqual(expect.arrayContaining(['--manifest', 'weekly-pilot', '--paid-window']));
    }
  });

  // Value: protects=the CLI a VM runs refuses a pilot unit with no window before it writes anything; fails_when=cell.ts run resolves --manifest weekly-pilot but skips the guard, or creates --out first; why_new=as above, through the real entry point; seam=bun eval/runner/q1/cell.ts run with blank keys; no_claim=a granted run
  test('cell.ts run --manifest weekly-pilot exits 2 with no output directory', () => {
    for (const unit of [pilot[0].id, judge[0].id]) {
      const out = join(scratch('cli'), 'out');
      const r = spawnSync('bun', ['eval/runner/q1/cell.ts', 'run', '--cell', unit, '--manifest', 'weekly-pilot', '--out', out], { cwd: REPO, encoding: 'utf8', timeout: 60_000,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', PARTICLE_API_KEY: '', VOYAGE_API_KEY: '', GBRAIN_EVALS_BG1_WORLD_END: WORLD_END, ...GBRAIN_ENV } });
      expect([r.status, existsSync(out)]).toEqual([2, false]);
      expect(r.stderr).toContain(`[PAID_FLAGS_MISSING] weekly pilot cell ${unit} spends real keys`);
    }
  }, 120_000);

  // Value: protects=a pilot row's particle-1 re-read is graded by its preregistered gating judge alone, as a counted week's is; fails_when=prepareReread's weekly check reads def.week only, so a pilot re-read takes any --gating; why_new=the pilot's cells have no week, so the check needed isWeeklyLineCell; seam=reread-cell.ts prepareReread; no_claim=the re-read's grades
  test("a pilot re-read refuses any gating judge but its reader's preregistered one", () => {
    const def = pilot.find(c => c.system === 'ext-memory-bank')!;
    const op = refusal(() => prepareReread(def, def.arms[0], { sources: [join(tmp, 'none')], reader: PARTICLE, out: join(scratch('reread'), 'out'), gating: 'gemini:gemini-3.8-flash', manifest: 'weekly-pilot' } as any));
    expect(op?.message).toBe(`${def.arms[0].cell_id} is a weekly-line arm, so ${PARTICLE}'s re-read is graded by its preregistered gating judge ${bg1JudgeOf(PARTICLE)}, not gemini:gemini-3.8-flash`);
  });
});

describe('pilot.ts', () => {
  const lsRemote = () => [`${'1'.repeat(40)}\trefs/tags/v0.61.9.0`, `${GBRAIN.commit}\trefs/tags/v0.61.10.0`, `${'3'.repeat(40)}\trefs/tags/v0.61.10.0-rc1`].join('\n');

  // Value: protects=the dry run prints every cell, ledger and cap, the judge check's pause and the skipped quick look, at the newest gbrain release, calling nothing; fails_when=plan reaches a provider, ignores the newest tag, drops a ledger or prints the quick look as run; why_new=GBEV-128 brief: the dry run's output goes in the PR, and GBEV-3 asked for the judge check's pause and the quick look's cap in it; seam=pilot.ts main plan with an injected ls-remote; no_claim=the real tag list
  test('plan prints the cells, ledgers, caps and totals at the newest release', () => {
    const lines: string[] = [];
    expect(pilotMain(['plan'], { lsRemote, env: {} }, s => lines.push(s))).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain(`gbrain build: v0.61.10.0 (${GBRAIN.commit})`);
    for (const c of [...pilot, ...judge]) expect(text).toContain(`| ${c.id} |`);
    for (const l of ['pilot-gbrain', 'pilot-gbrain-reread', 'pilot-grep-agent', 'pilot-extract-first', 'pilot-memory-bank', 'judge-check', 'judge-check-label']) expect(text).toContain(`| ${l}`);
    expect(text).toContain('Judge check: pauses at $100.00');
    expect(text).toContain('Claude Code quick look: cap $100.00, skipped');
    const plan = pilotPlan(manifest, null);
    expect(plan.totals.cap_usd).toBeCloseTo(plan.totals.pilot_cap_usd + plan.totals.judge_check_cap_usd, 2);
    expect(text).toContain(`caps $${plan.totals.cap_usd.toFixed(2)}`);
  });

  // Value: protects=the pilot's campaigns exist only for a granted window that covers every ledger's cap, each unit runs inside that window with the world end and build exported, and the launch check accepts them; fails_when=campaigns writes without a window, past the window's cap, without the exports, or launch.ts can't price a pilot campaign; why_new=GBEV-128: per-arm ledgers at their caps, run by the host after the PR lands; seam=pilot.ts writePilotCampaigns and bg1/launch.ts bg1LaunchProblems; no_claim=the VM run itself
  test('campaigns refuse without a window or past its cap, and every unit runs inside the window', () => {
    const out = scratch('campaigns');
    expect(message(() => writePilotCampaigns(manifest, { out: join(out, 'a'), worldEnd: WORLD_END }))).toContain('PILOT_NO_WINDOW');
    expect(message(() => writePilotCampaigns(manifest, { out: join(out, 'b'), window: 'weekly-line-pilot', windowCapUsd: 100, worldEnd: WORLD_END }))).toContain('PILOT_OVER_WINDOW');
    expect([existsSync(join(out, 'a')), existsSync(join(out, 'b'))]).toEqual([false, false]);
    const r = writePilotCampaigns(manifest, { out: join(out, 'c'), window: 'weekly-line-pilot', windowCapUsd: 300, worldEnd: WORLD_END });
    expect(r.campaigns.map(c => c.name)).toEqual(['pilot-extract-first', 'pilot-gbrain', 'pilot-memory-bank', 'pilot-grep-agent', 'judge-check']);
    for (const c of r.campaigns) {
      const campaign = JSON.parse(readFileSync(c.file, 'utf8'));
      const ledger = r.plan.ledgers.find(l => l.name === c.name)!;
      expect(campaign.cap_usd).toBe(ledger.cap_usd);
      for (const cell of campaign.cells) {
        expect(cell.command).toStartWith(`export GBRAIN_EVALS_BG1_WORLD_END=${WORLD_END}; export ${WEEKLY_PILOT_GBRAIN_ENV}=${GBRAIN.release}@${GBRAIN.commit}; `);
        expect(cell.command).toContain(`--manifest weekly-pilot`);
        expect(cell.command).toContain(`--paid-window weekly-line-pilot --window-cap-usd ${ledger.cap_usd} --out`);
      }
      expect(bg1LaunchProblems(campaign)).toEqual([]);
      const torn = { ...campaign, cells: campaign.cells.map((cell: { command: string }) => ({ ...cell, command: cell.command.replace(/export GBRAIN_EVALS_WEEKLY_PILOT_GBRAIN=\S+; /, '') })) };
      expect(refusal(() => bg1LaunchProblems(torn))?.code).toBe('PREFLIGHT_FAILED');
    }
    expect(r.commands.map(c => c.name)).toEqual(['pilot-extract-first-reread', 'pilot-gbrain-reread', 'pilot-memory-bank-reread', 'judge-check-label']);
    for (const c of r.commands) expect(c.argv).toEqual(expect.arrayContaining(['--paid-window', 'weekly-line-pilot']));
  });

  // Value: protects=the report fails a row whose part under test didn't run, whose answers aren't all judged, or that passed its cap, and reads the ceiling and the projected week; fails_when=pilotReport passes a row on any one check, or projects the week from estimates; why_new=R111's per-arm verdict; seam=pilot.ts pilotReport on synthetic readings; no_claim=readRow over real cell output
  test('the report passes a row only when every R111 check holds', () => {
    const reading = (row: RowReading['row'], o: Partial<RowReading> = {}): RowReading => ({ row, cell: manifest.cells.find(c => c.block === 'BGW-pilot' && pilot.find(p => p.id === c.id) && c.system === ({ gbrain: 'gbrain-defaults', 'grep-agent': 'baseline-file-agent', 'extract-first': 'ext-extract-first', 'memory-bank': 'ext-memory-bank' } as const)[row])!.id,
      block: 'BGW-pilot', worlds: ['bg1-dev-01'], answers: 64, by_reader: row === 'grep-agent' ? { [OPUS]: 64, [PARTICLE]: 64 } : { [OPUS]: 64 }, outcomes: { scored: 64 }, verdicts: { needed: 64, given: 64, parse_failed: 0 },
      accuracy: { [OPUS]: 0.9 }, spend_usd: 2, spend_source: 'proxy', part_under_test: { ran: true, detail: {} }, ...o });
    const rows = [reading('gbrain'), reading('grep-agent', { accuracy: { [OPUS]: 0.97 } }), reading('extract-first', { part_under_test: { ran: false, detail: {} } }), reading('memory-bank', { spend_usd: 50 })];
    const rereads = rows.filter(r => r.row !== 'grep-agent').map(r => ({ cell: `${r.cell}.x.reread-particle-particle-1`, answers: 64, verdicts: { needed: 64, given: 64 }, accuracy: 0.5, spend_usd: 0.2, status: 'complete' }));
    const rep = pilotReport(rows, rereads, manifest);
    expect(Object.fromEntries(Object.entries(rep.rows).map(([k, v]) => [k, v.pass]))).toEqual({ gbrain: true, 'grep-agent': true, 'extract-first': false, 'memory-bank': false });
    expect(rep.rows['memory-bank'].checks!.under_cap).toBe(false);
    expect(rep.ceiling.triggers_longer_worlds).toBe(true);
    expect(rep.projected_week.usd).toBeCloseTo((2.2 + 2 + 2.2 + 50.2) * 8, 2);
  });
});

describe('the judge check', () => {
  const WORLDS = ['bg1-dev-01', 'bg1-dev-02', 'bg1-dev-03'];
  const corpus = loadBg1Dev({ only: new Set(WORLDS), worldEnd: WORLD_END, keyless: true });
  const questions = new Map(corpus.questions.map(q => [q.id, q]));
  const goldText = (q: MemoryQuestion) => `The answer is ${q.bg1!.gold_values.join(' and then ')}.`;
  const wrongText = (q: MemoryQuestion) => (q.bg1!.stale_values[0] ?? q.bg1!.decoy_values[0]) ? `The answer is ${q.bg1!.stale_values[0] ?? q.bg1!.decoy_values[0]}.` : 'The answer is purple elephants.';

  /** One reader's grep-agent answers over the three worlds, with a no-tool-call, a hedged and a turn-cap share, and its gating judge's verdicts. */
  function writeCell(out: string, block: 'BGW-pilot' | 'BGW-judge') {
    const cell = block === 'BGW-pilot' ? pilot.find(c => c.system === 'baseline-file-agent')! : judge[0];
    const dir = join(out, 'cells', cell.arms[0].cell_id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify({ run_cell: cell.id, block, system: { kind: 'baseline-file-agent', versions: { ripgrep: '14.1.0' } } }));
    const answers: string[] = [], judgments: string[] = [];
    const worlds = cell.only_conversations!;
    corpus.questions.filter(q => worlds.includes(q.conversation)).forEach((q, i) => {
      for (const reader of WEEKLY_LINE_READERS) {
        const kind = i % 10 === 0 ? 'no_tool_call' : i % 10 === 1 ? 'hedged' : i % 23 === 2 ? 'turn_cap' : 'other';
        const right = i % 2 === 0;
        const text = kind === 'no_tool_call' ? 'I could not find it.' : kind === 'hedged' ? `I'm not sure, but it might possibly be ${q.bg1!.gold_values[0]}.` : kind === 'turn_cap' ? '' : right ? goldText(q) : wrongText(q);
        const rec: AnswerRecord = { answer_id: answerId(cell.arms[0].cell_id, q.id, reader, 0), cell_id: cell.arms[0].cell_id, realization_id: 'r', question_id: q.id, conversation: q.conversation, system: 'baseline-file-agent', arm: 'whole-agent', reader, replicate: 0, effort: 'high',
          context_sha256: sha256(q.id), text, usage: { input: 10, output: 5, cache_read: 0, cache_write: 0 }, provider_input_tokens: 10, latency_ms: 1000, outcome: kind === 'turn_cap' ? 'turn_cap' : 'scored',
          stop_reason: kind === 'no_tool_call' ? 'no_tool_call' : kind === 'turn_cap' ? 'turn_cap' : 'submitted', turns: 3, tool_calls: { grep: { calls: kind === 'no_tool_call' ? 0 : 2, failed: 0 } }, usd: 0.01 };
        expect(answerProblems(rec)).toEqual([]);
        answers.push(JSON.stringify(rec));
        if (kind === 'turn_cap') continue;
        const score = kind === 'other' ? (right ? 1 : 0) : i % 3 === 0 ? 1 : 0;
        judgments.push(JSON.stringify({ answer_id: rec.answer_id, instrument_id: 'bg1', instrument_sha256: sha256('i'), judge: bg1JudgeOf(reader), judge_replicate: 0, temperature: null, score, parse_ok: true, raw_sha256: sha256('[]'), outcome: 'scored' }));
      }
    });
    writeFileSync(join(dir, 'answers.ndjson'), answers.join('\n') + '\n');
    writeFileSync(join(dir, 'judgments.ndjson'), judgments.join('\n') + '\n');
    return out;
  }
  const cells = () => [writeCell(scratch('pilot-cell'), 'BGW-pilot'), writeCell(scratch('judge-cell'), 'BGW-judge')];

  // Value: protects=each judge's sample holds at least 100 of its reader's answers, at least 40% judged wrong, with the no-tool-call and hedged answers in, turn-cap answers counted outside kappa, and every label's source named; fails_when=the sampler draws only the common kind, under-fills the wrong class, samples one judge's answers for another, or labels a hedged answer from the gold; why_new=R78 for a plan frozen after 2026-11-22 and GBEV-3's ask to name each label's source; seam=judge-check.ts poolAnswers, buildSample, ruleZero and analyze over cell output on the keyless dev fixtures; no_claim=gemini-3.8-flash's own grades
  test('the sample is stratified, at least 40% judged wrong, and names every label source', () => {
    const pool = poolAnswers(cells());
    const sample = buildSample(pool, questions);
    expect(buildSample(pool, questions)).toEqual(sample);
    for (const reader of WEEKLY_LINE_READERS) {
      const mine = sample.filter(i => i.judge === bg1JudgeOf(reader));
      expect(mine.length).toBe(100);
      expect(mine.every(i => i.reader === reader)).toBe(true);
      expect(mine.filter(i => i.judged === 0).length).toBeGreaterThanOrEqual(40);
      expect(new Set(mine.map(i => i.kind))).toEqual(new Set(['no_tool_call', 'hedged', 'other']));
      expect(mine.filter(i => i.kind === 'hedged').every(i => i.gold === null)).toBe(true);
    }
    expect(sample.some(i => i.gold === 1) && sample.some(i => i.gold === 0)).toBe(true);
    const zero = ruleZero(pool);
    expect(Object.keys(zero).sort()).toEqual(WEEKLY_LINE_READERS.map(bg1JudgeOf).sort());
    expect(Object.values(zero).every(z => Object.keys(z).join() === 'turn_cap')).toBe(true);
    const labels = sample.filter(i => i.gold === null).map(i => ({ item: i.id, text_sha256: i.text_sha256, label: i.judged }));
    const report = analyze(sample, labels, zero);
    for (const j of Object.values(report.judges)) {
      expect(j.kappa).toBe(1);
      expect(j.label_sources['gold-settled'] + j.label_sources[MODEL_LABEL_SOURCE]).toBe(100);
      expect(j.model_labelled).toBe(true);
      expect(j.pass).toBe(true);
    }
    expect(new Set(report.items.map(i => i.label_source))).toEqual(new Set(['gold-settled', MODEL_LABEL_SOURCE]));
    expect(report.items.every(i => i.label_source === (sample.find(s => s.id === i.id)!.gold === null ? MODEL_LABEL_SOURCE : 'gold-settled'))).toBe(true);
    expect(message(() => buildSample(pool.filter(a => a.reader !== OPUS || a.verdict === 1), questions))).toContain('JUDGE_CHECK_SHORT');
  });

  // Value: protects=a judge's kappa is Cohen's kappa of its verdicts against the labels, an unlabelled or stale-labelled item stays out, and the gates stop a judge under 0.6 or under 100 labels; fails_when=analyze counts a missing model label as wrong, accepts a label for another text, or gates on agreement instead of kappa; why_new=R78's kappa gate; seam=judge-check.ts analyze; no_claim=the interval's width
  test('kappa is computed against the labels, and the gates stop a weak or short judge', () => {
    const item = (k: number, judged: 0 | 1, gold: 0 | 1 | null) => ({ id: `i${k}`, judge: 'j', reader: OPUS, cell: 'c', answer_id: `a${k}`, question_id: 'q', conversation: 'w', text_sha256: `s${k}`, kind: 'other' as const, judged, match: 'other' as const, gold });
    const sample = Array.from({ length: 120 }, (_, k) => item(k, (k % 2) as 0 | 1, k < 100 ? ((k % 2 === 0 ? (k % 10 === 0 ? 1 : 0) : (k % 7 === 1 ? 0 : 1)) as 0 | 1) : null));
    const r = analyze(sample, [{ item: 'i100', text_sha256: 's100', label: 0 }, { item: 'i101', text_sha256: 'other', label: 1 }], {});
    const labelled = sample.filter(i => i.gold !== null || i.id === 'i100');
    const want = cohenKappa(labelled.map(i => i.judged === 1), labelled.map(i => (i.gold ?? 0) === 1)).kappa!;
    expect(r.judges.j.labelled).toBe(101);
    expect(r.judges.j.kappa).toBe(Math.round(want * 1e4) / 1e4);
    expect(r.judges.j.gates.map(g => g.pass)).toEqual([want >= 0.6, true]);
    const weak = analyze(sample.map(i => ({ ...i, gold: i.gold === null ? null : ((1 - i.judged) as 0 | 1) })), [], {});
    expect([weak.judges.j.pass, weak.stop]).toEqual([false, true]);
  });

  // Value: protects=the labelling pass has a dry run that sends nothing, and a real run refuses outside a granted window before any lease, proxy or file; fails_when=label --dry-run opens a lease or writes, or label without a window or with a lease above the labelling cap gets as far as the proxy; why_new=GBEV-128: labelling with a dry-run mode, and no test may reach a provider; seam=judge-check.ts main; no_claim=a granted label run
  test('label --dry-run prints the sample and estimate, and a paid label run refuses without its window', async () => {
    const dirs = cells();
    const lines: string[] = [];
    const args = dirs.flatMap(d => ['--cell', d]);
    expect(await judgeCheckMain(['label', ...args, '--dry-run', '--keyless-upstream', DEAD, '--world-end', WORLD_END], s => lines.push(s))).toBe(0);
    const dry = JSON.parse(lines.join('\n'));
    expect([dry.dry_run, dry.sends, dry.gold_settled + dry.model_labelled, dry.estimate.cap_usd]).toEqual([true, 'nothing', 200, WEEKLY_LINE_LABEL_CAP_USD]);
    expect(dry.estimate.usd).toBeLessThanOrEqual(WEEKLY_LINE_LABEL_CAP_USD);
    const out = join(scratch('label'), 'out');
    const paid = ['label', ...args, '--out', out, '--budget-ledger', join(tmp, 'ledger'), '--run-id', 'r1', '--ledger-cap-usd', '1', '--world-end', WORLD_END];
    expect(await judgeCheckMain([...paid, '--lease-usd', '1'], () => {})).toBe(2);
    expect(await judgeCheckMain([...paid, '--lease-usd', '5', '--paid-window', 'w', '--window-cap-usd', '300'], () => {})).toBe(2);
    expect(existsSync(out)).toBe(false);
  });

  // Value: protects=report reads the saved sample and the model's labels, names each label's source, and never passes a keyless rehearsal; fails_when=report recomputes a different sample, drops the label sources, or exits 0 on a keyless out; why_new=GBEV-3's ask that the judge-check report names every label's source; seam=judge-check.ts main report over a saved sample and labels; no_claim=the label run that writes them
  test('report gives kappa per judge with each label source, and a keyless rehearsal exits 4', async () => {
    const dirs = cells(), out = scratch('report');
    const sample = buildSample(poolAnswers(dirs), questions);
    writeFileSync(join(out, 'upstream.json'), JSON.stringify({ keyless: true }));
    writeFileSync(join(out, 'sample.json'), JSON.stringify({ seed: 20261124, world_end: WORLD_END, keyless: true, cells: dirs, sample }));
    writeFileSync(join(out, 'labels.ndjson'), sample.filter(i => i.gold === null).map(i => JSON.stringify({ item: i.id, text_sha256: i.text_sha256, label: i.judged })).join('\n') + '\n');
    const lines: string[] = [];
    expect(await judgeCheckMain(['report', ...dirs.flatMap(d => ['--cell', d]), '--out', out], s => lines.push(s))).toBe(4);
    expect(lines.join('\n')).toContain('gold-settled');
    expect(lines.join('\n')).toContain('model-labelled');
    const rep = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    expect(rep.items.length).toBe(200);
    expect(rep.items.every((i: { label_source: string }) => ['gold-settled', MODEL_LABEL_SOURCE].includes(i.label_source))).toBe(true);
  });

  // Value: protects=the pilot report reads a grep-agent cell's own output: ripgrep's version, every answer's tool calls, every verdict and the no-tool-call share; fails_when=readRow reads the wrong judge's verdict, counts a turn-cap answer as needing one, or calls the agent's part run without its tool calls; why_new=R111's per-arm proof on real cell files; seam=pilot.ts readRow over cell output; no_claim=the server and gbrain rows' retrieval files
  test("the report reads a grep-agent cell's tool calls, verdicts and rates", () => {
    const out = writeCell(scratch('row'), 'BGW-pilot');
    const [row] = readRow(out);
    expect([row.row, row.block, row.part_under_test.ran, row.verdicts.given, row.verdicts.parse_failed]).toEqual(['grep-agent', 'BGW-pilot', true, row.verdicts.needed, 0]);
    expect(row.answers).toBe(128);
    expect(row.outcomes.turn_cap).toBeGreaterThan(0);
    expect(row.agent!.rates.no_tool_call).toBeGreaterThan(0);
    expect(row.agent!.ripgrep).toBe('14.1.0');
  });

  // Value: protects=an answer records each tool's calls and failures, so the pilot can show the grep agent searched; fails_when=toolCalls counts a grep error as a search or a tool error as a success; why_new=R111's proof that the grep agent's part ran; seam=file-agent.ts toolCalls; no_claim=the agent loop
  test('tool calls are counted with their failures', () => {
    const t = (name: string, result: string, error?: string) => ({ name, args: {}, ms: 1, chars: 1, truncated: false, result, ...(error ? { error } : {}) });
    expect(toolCalls({ tools: [t('grep', 'a.md:1: x'), t('grep', 'grep error: bad regex'), t('read', '', 'no such file'), t('read', 'text')] })).toEqual({ grep: { calls: 2, failed: 1 }, read: { calls: 2, failed: 1 } });
    expect(answerKind({ stop_reason: 'no_tool_call', text: 'x' })).toBe('no_tool_call');
  });
});

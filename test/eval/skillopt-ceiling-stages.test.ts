/**
 * The SkillOpt ceiling attempt's calibration and gate stages (GBEV-30, plan
 * sections 4 and 5), keyless: every stage runs end to end on a deterministic
 * in-process transport through gbrain's real rollout path, with no key and no
 * paid request.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatResult } from 'gbrain/ai/gateway';
import { describeJudges } from 'gbrain/core/skillopt';
import type { PGLiteEngine } from 'gbrain/pglite-engine';
import { degenerateAnswers, type MethodTaskV3 } from '../../eval/generators/skillopt-method/common-v3.ts';
import { BudgetExceededError, BudgetRun, closeRun, initLedger } from '../../eval/runner/budget-ledger.ts';
import { gbrainInstallTag, gbrainPin } from '../../eval/runner/gbrain-version.ts';
import { withHermeticEnv } from '../../eval/runner/hermetic-env.ts';
import {
  CALIBRATION_HALF_TASKS, CEILING_STAGE_PLANS, fileRows, GATE_PROPOSER_CALLS_PER_PAIR, GATE_ROLLOUTS_PER_PAIR, gateEstimateUsd, memoryRows, PLANNING_PRICES_USD,
  reachabilityHint, repriceStages, runCalibration, runGateStage, type CalibrationResult, type CeilingRow, type GatePairResult, type GateStageResult, type ProposalRow, type RolloutRow, type RowStore,
} from '../../eval/runner/skillopt-method/ceiling-stages.ts';
import { datasetDir, readCriteria, readSealedTasks, readSeed, readTasks, sha256 } from '../../eval/runner/skillopt-method/dataset.ts';
import { fakeReply, fakeRewrite, fakeTransport, NO_SKILL_TEXT, openBrain, type ChatTransport } from '../../eval/runner/skillopt-method/headroom.ts';
import { ONE_SHOT_SYSTEM, ONE_SHOT_SYSTEM_PASS_FAIL } from '../../eval/runner/skillopt-method/one-shot.ts';
import { evaluateLayers, SKILLS, type SkillName } from '../../eval/runner/skillopt-method/score.ts';
import { decisivePages } from '../../eval/runner/skillopt-method/tool-calls.ts';

const isProposer = (system: string | undefined) => system === ONE_SHOT_SYSTEM || system === ONE_SHOT_SYSTEM_PASS_FAIL;

type ChatOpts = Parameters<ChatTransport>[0];

const SPLITS = {
  train: (s: SkillName) => readTasks(s, 'train', 'v3'),
  sel: (s: SkillName) => readTasks(s, 'sel', 'v3'),
  gate: (s: SkillName) => readSealedTasks(s, 'gate', 'v3'),
};

interface TaskInfo { skill: SkillName; split: keyof typeof SPLITS; index: number; task: MethodTaskV3; wrong?: string; wrongIndex?: number }

/** Every train, selection and gate task, with a wrong answer in the skill's form when one exists (so a failing arm still passes every form check), numbered among its split's tasks that have one. */
const INFOS: TaskInfo[] = SKILLS.flatMap(skill => {
  const all = (Object.keys(SPLITS) as Array<keyof typeof SPLITS>).flatMap(split => SPLITS[split](skill).map((task, index) => ({ skill, split, index, task })));
  const numbered = new Map<string, number>();
  return all.map(info => {
    const candidates = [...degenerateAnswers(skill, info.task).map(d => d.text), ...all.filter(o => o.task.task_id !== info.task.task_id).map(o => o.task.oracle_answer)];
    const wrong = candidates.find(text => { const l = evaluateLayers(text, info.task.judge); return !l.substance && !l.failed.some(c => (c as { layer?: string }).layer === 'form'); });
    if (wrong === undefined) return info;
    const wrongIndex = numbered.get(info.split) ?? 0;
    numbered.set(info.split, wrongIndex + 1);
    return { ...info, wrong, wrongIndex };
  });
});

const textOf = (content: unknown) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map(b => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n') : '');
const userText = (opts: ChatOpts) => opts.messages.filter(m => m.role === 'user').map(m => textOf(m.content)).join('\n');
const hasToolResult = (opts: ChatOpts) => opts.messages.some(m => Array.isArray(m.content) && (m.content as Array<{ type?: string }>).some(b => b.type === 'tool-result'));
/** The task a rollout's prompt carries (the longest task text it contains). */
const taskOf = (user: string) => INFOS.filter(i => user.includes(i.task.task)).sort((a, b) => b.task.task.length - a.task.task.length)[0];

const P1 = '<!-- ceiling test proposal 1 -->';
const P2 = '<!-- ceiling test proposal 2 -->';
const RUBRIC = '<!-- ceiling test rubric proposal -->';
const proposal = (marker: string) => `# Rewritten skill\n\n${marker}\n\nAnswer from the brain and cite the page that holds the answer.`;

interface Recorder { proposerInputs: string[]; prompts: Array<{ model: string; system: string; user: string }>; requests: number }

/**
 * The gate's stand-in models. The seed (and #304's rewrite, and the rubric
 * proposal) fails every other task, each pair's first proposal the same
 * tasks, its second
 * every fourth (both nothing when `saturate`), no skill every task, all in the
 * skill's form; Opus answers every reachability task, and Sol is refused its
 * decisive read there (known_as_of beside a read view) and then answers
 * wrong. Tasks with no wrong answer in form are always answered right, and
 * "every other" and "every fourth" count only the split's tasks that have one,
 * so the scores do not depend on which tasks lack one.
 */
function gateTransport(rec: Recorder, o: { saturate?: boolean } = {}): ChatTransport {
  const harnessCalls = new Map<string, number>();
  return async opts => {
    rec.requests++;
    const user = userText(opts);
    if (isProposer(opts.system)) {
      if (user.includes('Failed checks:') !== (opts.system === ONE_SHOT_SYSTEM)) throw new Error('the proposer system prompt does not match its input: the rubric input lists failed checks, the shipped-feedback input shows pass or fail only');
      rec.proposerInputs.push(user);
      if (user.includes('Failed checks:')) return fakeRewrite(opts, proposal(RUBRIC));
      const n = (harnessCalls.get(user) ?? 0) + 1;
      harnessCalls.set(user, n);
      return fakeRewrite(opts, proposal(n % 2 === 1 ? P1 : P2));
    }
    const system = opts.system ?? '';
    const model = String(opts.model ?? '');
    rec.prompts.push({ model, system, user });
    const info = taskOf(user);
    if (!info) return fakeReply(opts, "I don't know.");
    const right = info.task.oracle_answer;
    const failEvery = (n: number) => (info.wrong !== undefined && info.wrongIndex! % n === 0 ? info.wrong : right);
    if (user.includes('Hint:')) {
      if (!model.includes('gpt')) return fakeReply(opts, right);
      const decisive = decisivePages(info.task);
      if (!hasToolResult(opts) && decisive.length) {
        const blocks = [{ type: 'tool-call', toolCallId: 'c1', toolName: 'brain_get_page', input: { slug: decisive[0], known_as_of: '2025-01-01T00:00:00Z', body: 'window' } }];
        return { ...fakeReply(opts, ''), blocks, stopReason: 'tool_calls' } as unknown as ChatResult;
      }
      return fakeReply(opts, info.wrong ?? right);
    }
    if (system.includes(NO_SKILL_TEXT)) return fakeReply(opts, info.wrong ?? right);
    if (system.includes(P2)) return fakeReply(opts, o.saturate ? right : failEvery(4));
    if (system.includes(P1)) return fakeReply(opts, o.saturate ? right : failEvery(2));
    return fakeReply(opts, failEvery(2));
  };
}

const newRecorder = (): Recorder => ({ proposerInputs: [], prompts: [], requests: 0 });
const rollouts = (rows: readonly CeilingRow[]) => rows.filter((r): r is RolloutRow => r.kind === 'rollout');
const proposals = (rows: readonly CeilingRow[]) => rows.filter((r): r is ProposalRow => r.kind === 'proposal');
const readRows = (path: string) => readFileSync(path, 'utf8').trim().split('\n').slice(1).map(l => JSON.parse(l) as CeilingRow);
const GATE_HEADER = { stage: 'gate' as const, attempt: 1, target: null, half: false, mode: 'fake' as const, dataset_manifest_sha256: 'abc' };

let engine: PGLiteEngine;
const dirs: string[] = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'n15-ceiling-')); dirs.push(d); return d; };

beforeAll(async () => {
  engine = await withHermeticEnv('n15-ceiling-brain', () => openBrain('v3'));
}, 120_000);

afterAll(async () => {
  await engine?.disconnect().catch(() => {});
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const gate = (o: Omit<Parameters<typeof runGateStage>[0], 'engine' | 'fake'>) => withHermeticEnv('n15-ceiling-gate', () => runGateStage({ ...o, engine, fake: true }));
const calibrate = (o: Omit<Parameters<typeof runCalibration>[0], 'engine' | 'fake'>) => withHermeticEnv('n15-ceiling-calibration', () => runCalibration({ ...o, engine, fake: true }));

describe('stage plans and prices (plan section 5)', () => {
  test('a gate pair is 456 rollouts and 3 proposer calls, and each stage keeps its approved cap and ledger run', () => {
    expect(GATE_ROLLOUTS_PER_PAIR).toBe(36 + 72 + 48 + 192 + 36 + 36 + 36);
    expect(GATE_PROPOSER_CALLS_PER_PAIR).toBe(3);
    expect(Object.fromEntries(Object.entries(CEILING_STAGE_PLANS).map(([k, v]) => [k, [v.cap_usd, v.ledger_run]]))).toEqual({
      calibration: [50, 'n15-ceiling-calibration'], gate: [470, 'n15-ceiling-gate-<attempt>'], 'stop-read': [650, 'n15-ceiling-stop-read'], 'e1-check': [300, 'n15-ceiling-e1-check'],
    });
    expect(gateEstimateUsd(PLANNING_PRICES_USD.rollout)).toBeCloseTo(3 * 456 * 0.2 + 3 * 456 * 0.1 + 18 * 0.3, 6);
  });

  test("re-pricing at #304's metered means ($0.26 Opus, $0.15 Sol) puts the gate over its $470 cap; the planning prices keep every stage under its cap", () => {
    const planning = repriceStages({});
    expect(planning.every(s => !s.over_cap && s.repriced_usd === s.planning_usd)).toBe(true);
    expect(planning.find(s => s.stage === 'calibration')!.planning_usd).toBeCloseTo(3 * 72 * 0.2 + 36 * 0.1, 6);
    const metered = repriceStages({ opus: 0.26, sol: 0.15 });
    const g = metered.find(s => s.stage === 'gate')!;
    expect(g.repriced_usd).toBeCloseTo(3 * 456 * 0.26 + 3 * 456 * 0.15 + 18 * 0.3, 6);
    expect(g.over_cap).toBe(true);
    expect(g.rollout_usd).toEqual({ opus: { usd: 0.26, source: 'metered' }, sol: { usd: 0.15, source: 'metered' } });
    expect(metered.find(s => s.stage === 'stop-read')!.over_cap).toBe(true);
    expect(repriceStages({ opus: 0.2, sol: null }).find(s => s.stage === 'gate')!.rollout_usd.sol).toEqual({ usd: 0.1, source: 'planning' });
  });
});

describe('reachability hint', () => {
  test('an answerable task names the pages that decide it; an abstention task says none does and names its near-miss pages', () => {
    const gold = (slugs: string[]) => ({ slugs }) as unknown as MethodTaskV3['gold'];
    expect(reachabilityHint({ answerable: true, gold: gold(['people/a']), near_miss: [] })).toBe('Hint: the brain page that decides the answer is people/a.');
    expect(reachabilityHint({ answerable: true, gold: gold(['people/a', 'people/b', 'deals/c']) })).toBe('Hint: the brain pages that decide the answer are people/a, people/b and deals/c.');
    expect(reachabilityHint({ answerable: false, gold: gold([]), near_miss: ['people/a'] })).toBe('Hint: no brain page decides the answer. The nearest page, which does not decide it, is people/a.');
    expect(reachabilityHint({ answerable: false, gold: gold([]), near_miss: [] })).toBe('Hint: no brain page decides the answer.');
  });
});

describe('calibration (train only)', () => {
  let opus: CalibrationResult;
  let opusRows: RowStore;

  test('Opus: the seed at 1 run on all 72 train tasks, scored per skill on substance, with cost per rollout and per call, and every later stage re-priced', async () => {
    opusRows = memoryRows();
    const done: string[] = [];
    opus = await calibrate({ target: 'opus', rows: opusRows, onSkill: s => done.push(s.skill), transport: fakeTransport });
    expect(done).toEqual([...SKILLS]);
    expect(rollouts(opusRows.rows).length).toBe(72);
    expect(new Set(rollouts(opusRows.rows).map(r => `${r.arm}/${r.split}/${r.run}`))).toEqual(new Set(['seed/train/1']));
    for (const s of opus.skills) {
      expect(s.tasks).toBe(24);
      expect(s.substance).toBe(0.5);
      expect(s.in_band).toBe(true);
      expect(s.errored_tasks).toEqual([]);
      expect(s.stops.completed).toBe(24);
    }
    expect(opus.cost.rollouts).toBe(72);
    expect(opus.cost.mean_rollout_usd).toBeGreaterThan(0);
    expect(opus.mean_call_usd).toBeCloseTo(opus.cost.mean_rollout_usd!, 9);
    expect(opus.repriced.map(e => e.stage)).toEqual(['calibration', 'gate', 'stop-read', 'e1-check']);
    expect(opus.repriced[1]!.rollout_usd).toEqual({ opus: { usd: opus.cost.mean_rollout_usd!, source: 'metered' }, sol: { usd: 0.1, source: 'planning' } });
    expect(opus.files_read).toEqual(SKILLS.map(s => `eval/data/skillopt-method-v3/${s}/train.jsonl`));
    expect(opus.stopped).toBeNull();
  }, 120_000);

  test("Sol's read of the frozen knobs: the first 12 train tasks per skill, no band, re-priced with Opus's metered mean", async () => {
    const rows = memoryRows();
    const sol = await calibrate({ target: 'sol', half: true, rows, other: { target: 'opus', mean_rollout_usd: opus.cost.mean_rollout_usd }, transport: fakeTransport });
    expect(rollouts(rows.rows).map(r => r.task_id).sort()).toEqual(SKILLS.flatMap(s => SPLITS.train(s).slice(0, CALIBRATION_HALF_TASKS).map(t => t.task_id)).sort());
    expect(sol.skills.map(s => [s.tasks, s.in_band])).toEqual(SKILLS.map(() => [12, null]));
    expect(sol.repriced[1]!.rollout_usd.opus).toEqual({ usd: opus.cost.mean_rollout_usd!, source: 'metered' });
    expect(sol.repriced[1]!.rollout_usd.sol.source).toBe('metered');
  }, 120_000);

  test('a resume reruns only the errored tasks, with one provider request each and none for a scored task', async () => {
    const failing = new Set([SPLITS.train('query')[3]!.task_id, SPLITS.train('briefing')[7]!.task_id]);
    const rows = memoryRows();
    const first = await calibrate({
      target: 'opus', rows,
      transport: tasks => { const base = fakeTransport(tasks); return async opts => { const t = taskOf(userText(opts)); if (t && failing.has(t.task.task_id)) throw new Error('upstream 500'); return base(opts); }; },
    });
    expect(first.skills.find(s => s.skill === 'query')!.errored_tasks).toEqual([SPLITS.train('query')[3]!.task_id]);
    expect(first.skills.find(s => s.skill === 'query')!.substance).toBeNull();
    expect(first.skills.find(s => s.skill === 'fact-check')!.substance).toBe(0.5);
    expect(rollouts(rows.rows).filter(r => r.error !== undefined).map(r => r.task_id).sort()).toEqual([...failing].sort());
    const asked: string[] = [];
    const second = await calibrate({
      target: 'opus', rows,
      transport: tasks => { const base = fakeTransport(tasks); return async opts => { asked.push(taskOf(userText(opts))!.task.task_id); return base(opts); }; },
    });
    expect(asked.sort()).toEqual([...failing].sort());
    expect(second.skills.map(s => [s.substance, s.errored_tasks])).toEqual(opus.skills.map(s => [s.substance, []]));
  }, 120_000);

  test('a rollout that fails after a billed turn keeps its spend: its error row carries the usage, and the cost counts those dollars but no rollout, before and after the resume', async () => {
    const info = taskOf(SPLITS.train('query')[3]!.task);
    const slug = decisivePages(info.task)[0]!;
    const rows = memoryRows();
    const first = await calibrate({
      target: 'opus', rows,
      transport: tasks => {
        const base = fakeTransport(tasks);
        return async opts => {
          if (taskOf(userText(opts))?.task.task_id !== info.task.task_id) return base(opts);
          if (hasToolResult(opts)) throw new Error('upstream 500');
          const blocks = [{ type: 'tool-call', toolCallId: 'c1', toolName: 'brain_get_page', input: { slug } }];
          return { ...fakeReply(opts, ''), blocks, stopReason: 'tool_calls' } as unknown as ChatResult;
        };
      },
    });
    const failed = rollouts(rows.rows).filter(r => r.error !== undefined);
    expect(failed.map(r => r.task_id)).toEqual([info.task.task_id]);
    expect(failed[0]!.usage!.calls).toBe(1);
    expect(failed[0]!.usage!.usd).toBeGreaterThan(0);
    const usd = () => rollouts(rows.rows).reduce((sum, r) => sum + (r.usage?.usd ?? 0), 0);
    expect(first.cost.rollouts).toBe(71);
    expect(first.cost.usd).toBeCloseTo(usd(), 9);
    expect(first.skills.find(s => s.skill === 'query')!.cost.usd).toBeGreaterThan(first.skills.find(s => s.skill === 'query')!.cost.rollouts * opus.skills.find(s => s.skill === 'query')!.cost.mean_rollout_usd!);
    const second = await calibrate({ target: 'opus', rows, transport: fakeTransport });
    expect(second.cost.rollouts).toBe(72);
    expect(second.cost.usd).toBeCloseTo(usd(), 9);
    expect(second.cost.usd).toBeCloseTo(opus.cost.usd + failed[0]!.usage!.usd, 9);
  }, 120_000);

  test('a rows file starts with its first row, refuses a second run without --resume and a resume of another run, and gives back every row', () => {
    const path = join(tempDir(), 'rows.jsonl');
    const header = { stage: 'calibration' as const, attempt: null, target: 'opus' as const, half: false, mode: 'fake' as const, dataset_manifest_sha256: 'abc' };
    const store = fileRows(path, header, false);
    expect(existsSync(path)).toBe(false);
    for (const r of opusRows.rows.slice(0, 3)) store.append(r);
    expect(readFileSync(path, 'utf8').trim().split('\n').length).toBe(4);
    expect(() => fileRows(path, header, false)).toThrow(/already holds rows; pass --resume/);
    expect(() => fileRows(path, { ...header, target: 'sol' }, true)).toThrow(/belongs to another run/);
    expect(fileRows(path, header, true).rows).toEqual(opusRows.rows.slice(0, 3));
  });
});

describe('gate stage, end to end on six pairs', () => {
  const rec = newRecorder();
  let rowsPath: string;
  let result: GateStageResult;
  const pairWrites: Array<{ pair: string; lines: number; own: number }> = [];
  const failing = SPLITS.gate('query')[5]!.task_id;
  const querySeed = readSeed('query', 'v3');

  test('an errored rollout leaves its arm and pair unscored, the stage goes on to the later Opus pairs, Sol waits for Opus, and each pair is written as it lands', async () => {
    rowsPath = join(tempDir(), 'rows.jsonl');
    const rows = fileRows(rowsPath, GATE_HEADER, false);
    const base = gateTransport(rec);
    let thrown = false;
    const first = await gate({
      attempt: 1, rows,
      transport: () => async opts => {
        const user = userText(opts);
        const seedOnGate = !isProposer(opts.system) && !user.includes('Hint:') && (opts.system ?? '').includes(querySeed.trim().split('\n').slice(-3).join('\n')) && taskOf(user)?.task.task_id === failing;
        if (!thrown && seedOnGate) { thrown = true; throw new Error('upstream 500'); }
        return base(opts);
      },
      onPair: p => {
        const lines = readRows(rowsPath);
        pairWrites.push({ pair: `${p.skill}/${p.target}`, lines: lines.length, own: lines.filter(r => r.skill === p.skill && r.target === p.target).length });
      },
    });
    expect(thrown).toBe(true);
    const query = first.pairs.find(p => p.skill === 'query' && p.target === 'opus')!;
    expect(query.status).toBe('errored');
    expect(query.arms.seed!.errored_tasks).toEqual([failing]);
    expect(query.label).toBeNull();
    expect(first.pairs.filter(p => p.target === 'opus' && p.skill !== 'query').map(p => p.status)).toEqual(['scored', 'scored']);
    expect(rollouts(rows.rows).filter(r => r.error !== undefined).map(r => [r.task_id, r.arm, r.run])).toEqual([[failing, 'seed', 1]]);
    expect(rollouts(rows.rows).find(r => r.error !== undefined)!.error).toContain('upstream 500');
    expect(first.pairs.filter(p => p.target === 'sol').map(p => [p.status, p.not_run_reason])).toEqual(SKILLS.map(() => ['not-run', 'opus-incomplete']));
    expect(first.verdict.verdict).toBe('incomplete');
    const perPair = GATE_ROLLOUTS_PER_PAIR + GATE_PROPOSER_CALLS_PER_PAIR;
    expect(pairWrites.map(w => w.pair)).toEqual(['query/opus', 'briefing/opus', 'fact-check/opus', 'query/sol', 'briefing/sol', 'fact-check/sol']);
    expect(pairWrites.map(w => w.own)).toEqual([perPair, perPair, perPair, 0, 0, 0]);
    expect(pairWrites.map(w => w.lines)).toEqual([1, 2, 3, 3, 3, 3].map(n => n * perPair));
  }, 300_000);

  test('a resume from the rows file reruns only the errored Opus rollout, then runs Sol: one Opus provider request and no repeated proposer call', async () => {
    const rows = fileRows(rowsPath, GATE_HEADER, true);
    const before = rec.requests;
    const proposerBefore = rec.proposerInputs.length;
    const prompts = (m: string) => rec.prompts.filter(x => x.model.includes(m)).length;
    const opusBefore = prompts('opus');
    const solBefore = prompts('sol');
    result = await gate({ attempt: 1, rows, transport: () => gateTransport(rec) });
    expect(prompts('opus') - opusBefore).toBe(1);
    expect(rec.proposerInputs.length - proposerBefore).toBe(SKILLS.length * GATE_PROPOSER_CALLS_PER_PAIR);
    expect(rec.requests - before).toBe(1 + (prompts('sol') - solBefore) + SKILLS.length * GATE_PROPOSER_CALLS_PER_PAIR);
    expect(result.pairs.find(p => p.skill === 'query' && p.target === 'opus')!.status).toBe('scored');
    expect(result.pairs.every(p => p.status === 'scored')).toBe(true);
  }, 300_000);

  test('every arm runs its planned rollouts, Opus pairs before Sol pairs, and the stage reads train, selection and gate but never test', () => {
    const rows = readRows(rowsPath);
    const scored = rollouts(rows).filter(r => r.error === undefined);
    const expected = { 'no-skill': 36, seed: 72, 'seed-sel': 48, 'seed-train': 24, 'proposal-1': 48, 'proposal-2': 48, 'one-shot': 72, 'kept-rewrite': 36, 'rubric-one-shot': 36, reachability: 36 };
    for (const target of ['opus', 'sol'] as const) for (const skill of SKILLS) {
      const counts: Record<string, number> = {};
      for (const r of scored.filter(x => x.target === target && x.skill === skill)) counts[r.arm] = (counts[r.arm] ?? 0) + 1;
      expect(counts).toEqual(expected);
      expect(proposals(rows).filter(r => r.target === target && r.skill === skill).map(r => r.proposal)).toEqual(['proposal-1', 'proposal-2', 'rubric-one-shot']);
    }
    const firstSol = rows.findIndex(r => r.target === 'sol');
    expect(rows.slice(firstSol).every(r => r.target === 'sol' || (r.kind === 'rollout' && r.task_id === failing))).toBe(true);
    expect(result.files_read.map(f => f.path)).toEqual(SKILLS.flatMap(s => ['train', 'sel', 'gate'].map(split => `eval/data/skillopt-method-v3/${s}/${split}.jsonl`)));
    expect(result.pairs.every(p => p.cost.rollouts === GATE_ROLLOUTS_PER_PAIR)).toBe(true);
    expect(result.pairs.every(p => p.proposer_retries === 0 && p.proposer_usd! > 0)).toBe(true);
  });

  test('the kept one-shot is the proposal that beats the seed on selection, and only it runs on the gate split', () => {
    for (const p of result.pairs) {
      expect(p.kept).toBe('proposal-2');
      expect(p.proposals.map(q => [q.id, q.outcome])).toEqual([['proposal-1', 'proposed'], ['proposal-2', 'proposed'], ['rubric-one-shot', 'proposed']]);
      const [p1, p2] = p.proposals;
      expect(p1!.selection).toBe(p.scores.seed_selection);
      expect(p2!.selection!).toBeGreaterThan(p.scores.seed_selection!);
      expect(p.arms['one-shot']!.skill_sha8).toBe(p.arms['proposal-2']!.skill_sha8);
      expect(p.scores.one_shot).toBe(p.arms['one-shot']!.substance);
    }
  });

  test("the two one-shot inputs: the harness's carries describeJudges(train) and pass or fail only, the rubric's criteria.md and failed checks; neither shows a selection or gate task", () => {
    for (const skill of SKILLS) {
      const mine = rec.proposerInputs.filter(i => i.includes(readSeed(skill, 'v3').trim()));
      const harness = mine.filter(i => !i.includes('Failed checks:'));
      const rubric = mine.filter(i => i.includes('Failed checks:'));
      expect(harness.length).toBe(4);
      expect(rubric.length).toBe(2);
      for (const h of harness) {
        expect(h).toContain(describeJudges(SPLITS.train(skill)).trim());
        expect(h).not.toContain(readCriteria(skill, 'v3').trim());
      }
      for (const r of rubric) expect(r).toContain(readCriteria(skill, 'v3').trim());
      for (const t of [...SPLITS.sel(skill), ...SPLITS.gate(skill)]) for (const i of mine) expect(i.includes(t.task)).toBe(false);
    }
  });

  test('the reachability arm appends the hint to every gate task: the deciding pages, or for an abstention task that none decides it', () => {
    const hinted = rec.prompts.filter(p => p.user.includes('Hint:') && !p.model.includes('gpt'));
    for (const skill of SKILLS) for (const t of SPLITS.gate(skill)) {
      expect(hinted.find(p => taskOf(p.user)?.task.task_id === t.task_id)?.user).toContain(reachabilityHint(t));
    }
    expect(reachabilityHint(SPLITS.gate('query').find(t => !t.answerable)!)).toStartWith('Hint: no brain page decides the answer.');
    expect(rec.prompts.some(p => p.user.includes('Hint:') && p.system.includes(NO_SKILL_TEXT))).toBe(false);
  });

  test("Sol's refused decisive reads are kept per rollout with gbrain's error text, classified, and make each Sol pair harness-limited", () => {
    for (const skill of SKILLS) {
      const p = result.pairs.find(x => x.skill === skill && x.target === 'sol')!;
      expect(p.label).toBe('harness-limited');
      expect(p.gate_pair!.reachability).toBeLessThan(0.85);
      expect(p.gate_pair!.refusal_limited).toBe(true);
      const reach = p.arms.reachability!.refusals;
      expect(reach.refused['known-as-of-with-read-view']).toBeGreaterThan(0);
      expect(reach.abandoned['known-as-of-with-read-view']).toBe(reach.refused['known-as-of-with-read-view']);
      expect(reach.read).toBe(0);
    }
    const refused = rollouts(readRows(rowsPath)).find(r => r.target === 'sol' && r.arm === 'reachability' && r.tool_calls?.length)!;
    expect(refused.tool_calls![0]).toMatchObject({ name: 'get_page', input: { known_as_of: '2025-01-01T00:00:00Z', body: 'window' }, error: expect.stringContaining('get_page: known_as_of does not combine with') });
  });

  test('labels and verdict: three Opus headroom pairs and Sol wholly harness-limited, so the attempt reads on Opus alone, where three pairs are too few to power B2', () => {
    expect(result.sol_gate).toEqual({ needed: true, ran: true });
    expect(result.pairs.filter(p => p.target === 'opus').map(p => p.label)).toEqual(['headroom', 'headroom', 'headroom']);
    for (const p of result.pairs.filter(x => x.target === 'opus')) {
      expect(p.gate_pair).toMatchObject({ reachability: 1, refusal_limited: false, limited_share: 0, form_fail: { no_skill: 0, seed: 0 }, proposals_passing_audit: 2 });
      expect(p.scores.one_shot!).toBeLessThanOrEqual(0.8);
      expect(p.scores.seed_run1!).toBeGreaterThanOrEqual(0.2);
      expect(p.scores.seed_run1!).toBeLessThanOrEqual(0.7);
      expect(p.gst956?.difference?.verdict).toBe('no-difference-shown');
    }
    expect(result.verdict).toMatchObject({ verdict: 'fail', cause: 'underpowered', scope: ['opus'], harness_target: 'sol', required: 2, counts: { H: 3, S: 0, D: 0, X: 0, V: 0, U: 0 }, next: 'stop' });
    expect(result.verdict.labels).toMatchObject({ 'query/sol': 'harness-limited', 'briefing/sol': 'harness-limited', 'fact-check/sol': 'harness-limited' });
    expect(result.stopped).toBeNull();
    expect(result.reprice_trigger).toBeNull();
    expect(result.unsolvable).toEqual([]);
  });
});

describe('gate stage, stops and skips', () => {
  test("when every Opus pair reads saturated, Sol's gate is skipped and the attempt is a saturated fail scoped to Opus", async () => {
    const rec = newRecorder();
    const rows = memoryRows();
    const pairs: GatePairResult[] = [];
    const r = await gate({ attempt: 1, rows, transport: () => gateTransport(rec, { saturate: true }), onPair: p => pairs.push(p) });
    expect(r.pairs.filter(p => p.target === 'opus').map(p => p.label)).toEqual(['saturated', 'saturated', 'saturated']);
    expect(r.sol_gate).toEqual({ needed: false, ran: false });
    expect(r.pairs.filter(p => p.target === 'sol').map(p => [p.status, p.not_run_reason])).toEqual(SKILLS.map(() => ['not-run', 'sol-gate-not-needed']));
    expect(rows.rows.some(x => x.target === 'sol')).toBe(false);
    expect(rec.prompts.some(p => p.model.includes('gpt'))).toBe(false);
    expect(pairs.length).toBe(6);
    expect(r.verdict).toMatchObject({ verdict: 'fail', cause: 'saturated', scope: ['opus'] });
  }, 300_000);

  test('a budget refusal mid-arm stops the stage at once: no row for the refused rollout, no error row, later pairs not run, and the attempt reads incomplete', async () => {
    const base = gateTransport(newRecorder());
    const rows = memoryRows();
    let seedCalls = 0;
    let after = 0;
    const r = await gate({
      attempt: 1, rows,
      transport: () => async opts => {
        if (seedCalls >= 5) after++;
        const user = userText(opts);
        const seedOnGate = !isProposer(opts.system) && !user.includes('Hint:') && !(opts.system ?? '').includes(NO_SKILL_TEXT) && taskOf(user)?.split === 'gate';
        if (seedOnGate && ++seedCalls === 5) throw new BudgetExceededError('reserving $0.2600 would take this run to $470.0100, over its $470.00 budget');
        return base(opts);
      },
    });
    expect(r.stopped).toMatchObject({ kind: 'budget_exhausted', target: 'opus', skill: 'query', arm: 'seed' });
    expect(r.pairs.map(p => [p.skill, p.target, p.status, p.not_run_reason ?? null])).toEqual([
      ['query', 'opus', 'stopped', null], ['briefing', 'opus', 'not-run', 'stage-stopped'], ['fact-check', 'opus', 'not-run', 'stage-stopped'],
      ['query', 'sol', 'not-run', 'stage-stopped'], ['briefing', 'sol', 'not-run', 'stage-stopped'], ['fact-check', 'sol', 'not-run', 'stage-stopped'],
    ]);
    expect(rollouts(rows.rows).some(x => x.error !== undefined)).toBe(false);
    expect(after).toBeLessThanOrEqual(3);
    expect(rollouts(rows.rows).filter(x => x.arm === 'seed').length).toBeLessThanOrEqual(4 + after);
    expect(r.sol_gate).toEqual({ needed: null, ran: false });
    expect(r.verdict.verdict).toBe('incomplete');
  }, 300_000);

  test('the re-price trigger: once the mean rollout cost passes 1.25 times its price after a pair, the stage stops after that pair', async () => {
    const rows = memoryRows();
    const r = await gate({ attempt: 2, rows, prices: { opus: 0.0001, sol: 0.0001 }, transport: () => gateTransport(newRecorder()) });
    expect(r.reprice_trigger).toMatchObject({ reason: 'reprice-trigger', target: 'opus', skill: 'query' });
    expect(r.reprice_trigger!.threshold_usd).toBeCloseTo(0.000125, 9);
    expect(r.reprice_trigger!.mean_rollout_usd).toBeGreaterThan(0.000125);
    expect(r.pairs.map(p => p.status)).toEqual(['scored', 'not-run', 'not-run', 'not-run', 'not-run', 'not-run']);
    expect(r.pairs.slice(1).every(p => p.not_run_reason === 'reprice-trigger')).toBe(true);
    expect(new Set(rows.rows.map(x => `${x.target}/${x.skill}`))).toEqual(new Set(['opus/query']));
    expect(r.attempt).toBe(2);
  }, 300_000);

  test('the re-price trigger also fires when a pair bills spend but scores no rollout: every rollout failing after a billed turn stops the stage after that pair', async () => {
    const rows = memoryRows();
    const r = await gate({
      attempt: 1, rows, prices: { opus: 0.2, sol: 0.1 },
      transport: () => {
        const base = gateTransport(newRecorder());
        return async opts => {
          const info = isProposer(opts.system) ? undefined : taskOf(userText(opts));
          if (!info) return base(opts);
          if (hasToolResult(opts)) throw new Error('upstream 500');
          const blocks = [{ type: 'tool-call', toolCallId: 'c1', toolName: 'brain_get_page', input: { slug: decisivePages(info.task)[0] ?? 'people/none' } }];
          return { ...fakeReply(opts, ''), blocks, stopReason: 'tool_calls' } as unknown as ChatResult;
        };
      },
    });
    expect(r.reprice_trigger).toMatchObject({ reason: 'reprice-trigger', target: 'opus', skill: 'query', mean_rollout_usd: null });
    expect(r.pairs[0]!.cost.rollouts).toBe(0);
    expect(r.pairs[0]!.cost.usd).toBeGreaterThan(0);
    expect(r.pairs.slice(1).every(p => p.status === 'not-run' && p.not_run_reason === 'reprice-trigger')).toBe(true);
  }, 300_000);
});

describe('runner CLI (--dataset v3)', () => {
  const run = (args: string[]) => Bun.spawnSync(['bun', 'eval/runner/n15-skillopt-method.ts', ...args], { cwd: join(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe' });

  test('keyless by default: calibration runs on the fake transport without --paid, needs no preregistration, and writes its receipt and rows', () => {
    const out = tempDir();
    const p = run(['--dataset', 'v3', '--stage', 'calibration', '--target', 'sol', '--half', '--output', out]);
    expect(p.exitCode).toBe(0);
    const receipt = JSON.parse(readFileSync(join(out, 'receipt.json'), 'utf8'));
    expect(receipt.run_status).toBe('completed');
    expect(receipt.resolved_config).toMatchObject({ mode: 'ceiling-fake', dataset: 'skillopt-method-v3', stage: 'calibration', target: 'sol', half: true, ledger_runner: 'n15-ceiling-calibration' });
    expect(receipt.preregistration_attestation).toBeUndefined();
    expect(receipt.publishable).toBe(false);
    expect(receipt.data.calibration.skills.map((s: { tasks: number }) => s.tasks)).toEqual([12, 12, 12]);
    expect(readFileSync(join(out, 'rows.jsonl'), 'utf8').trim().split('\n').length).toBe(1 + 36);
  }, 180_000);

  test('a paid ceiling stage refuses before it reads a key or the preregistration or writes a row, when the tree is not at the stage pin or holds no open ledger run of its own', () => {
    const out = tempDir();
    const p = run(['--dataset', 'v3', '--stage', 'gate', '--attempt', '1', '--paid', '--budget-run-id', 'n15-ceiling-gate-1-test', '--budget-ledger', join(out, 'ledger.sqlite'), '--output', out]);
    expect(p.exitCode).toBe(2);
    expect(existsSync(join(out, 'rows.jsonl'))).toBe(false);
    expect(existsSync(join(out, 'receipt.json'))).toBe(false);
  }, 120_000);

  /** No key in the process, so a refusal that came too late could never spend. */
  const keyless = (args: string[]) => Bun.spawnSync(['bun', 'eval/runner/n15-skillopt-method.ts', ...args], { cwd: join(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' } });
  const manifest = () => sha256(readFileSync(join(datasetDir('v3'), 'MANIFEST.json')));
  const calibrationReceipt = (dir: string, target: 'opus' | 'sol', usd: number) => {
    const path = join(dir, `${target}-calibration.json`);
    writeFileSync(path, JSON.stringify({ category: 'n15-skillopt-method', data: { calibration: { stage: 'calibration', target, mode: 'live', dataset_manifest_sha256: manifest(), cost: { mean_rollout_usd: usd } } } }));
    return path;
  };
  const gateArgs = (out: string, extra: string[]) => ['--dataset', 'v3', '--stage', 'gate', '--paid', '--budget-ledger', join(out, 'ledger.sqlite'), '--output', out, ...extra];

  test('the installed gbrain carries the bun tag of the pinned commit, which a live stage checks', () => {
    expect(gbrainInstallTag()).toBe(`garrytan-gbrain-${gbrainPin().split('#')[1]!.slice(0, 7)}`);
  });

  test("a live gate prices from both targets' calibration receipts, and does not start when their metered means put it over its $470 cap", () => {
    const out = tempDir();
    const missing = keyless(gateArgs(out, ['--attempt', '1', '--budget-run-id', 'n15-ceiling-gate-1-test']));
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr.toString()).toContain('pass --calibration');
    const over = keyless(gateArgs(out, ['--attempt', '1', '--budget-run-id', 'n15-ceiling-gate-1-test', '--calibration', `${calibrationReceipt(out, 'opus', 0.26)},${calibrationReceipt(out, 'sol', 0.15)}`]));
    expect(over.exitCode).toBe(2);
    expect(over.stderr.toString()).toContain(`$${gateEstimateUsd({ opus: 0.26, sol: 0.15 }).toFixed(2)} passes the stage's approved $470 cap`);
    expect(existsSync(join(out, 'rows.jsonl'))).toBe(false);
    expect(existsSync(join(out, 'receipt.json'))).toBe(false);
  }, 120_000);

  /**
   * A ledger at out/ledger.sqlite with one earlier run of `runner` that committed `usd` (finished when `close`); `newRun` opens
   * another run of it at `budgetUsd` and leaves it open, as `budget-ledger.ts open` does, and `close` finishes a run.
   */
  const stageLedger = (out: string, runner: string, earlier: { budgetUsd: number; usd: number; close: boolean }) => {
    const ledgerPath = join(out, 'ledger.sqlite');
    initLedger({ ledgerPath, programCapUsd: 1000 });
    const first = BudgetRun.open({ runner, budgetUsd: earlier.budgetUsd, ledgerPath });
    if (earlier.usd) first.reserve(earlier.usd, `an earlier leg of ${runner}`);
    first.close({ finish: earlier.close });
    return {
      earlier: first.runId,
      newRun: (budgetUsd: number) => { const run = BudgetRun.open({ runner, budgetUsd, ledgerPath }); run.close({ finish: false }); return run.runId; },
      close: (runId: string) => closeRun(ledgerPath, runId),
    };
  };
  /** Admitted past every cap check: the next refusal is the missing key, the last check before a paid call. */
  const pastTheCap = (p: ReturnType<typeof keyless>) => { expect(p.exitCode).toBe(2); expect(p.stderr.toString()).toMatch(/_API_KEY (is|and .* are) not set/); };
  const calibrate = (out: string, runId: string) => keyless(['--dataset', 'v3', '--stage', 'calibration', '--target', 'opus', '--paid', '--budget-run-id', runId, '--budget-ledger', join(out, 'ledger.sqlite'), '--output', join(out, runId)]);

  test('the gate cap covers the whole stage across ledger runs: an open earlier run holds its whole budget; once it closes it holds what it spent, so a new run is refused the full $470 and admitted for what is left, on a resume whose rows metered the work done', () => {
    const out = tempDir();
    const { earlier, newRun, close } = stageLedger(out, 'n15-ceiling-gate-1', { budgetUsd: 470, usd: 100, close: false });
    const calibration = `${calibrationReceipt(out, 'opus', 0.2)},${calibrationReceipt(out, 'sol', 0.1)}`;
    const header = { kind: 'header', stage: 'gate', attempt: 1, target: null, half: false, mode: 'live', dataset_manifest_sha256: manifest() };
    const usage = { calls: 1, usd: 100, unpriced_calls: 0, input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0, reasoning_tokens: null };
    const row = { kind: 'rollout', target: 'opus', skill: 'query', arm: 'seed', split: 'gate', task_id: 'query-gate-01', run: 1, skill_sha8: '00000000', error: 'upstream 500', usage, at: '2026-11-02T00:00:00.000Z' };
    writeFileSync(join(out, 'rows.jsonl'), `${JSON.stringify(header)}\n${JSON.stringify(row)}\n`);
    const gate = (runId: string) => keyless(gateArgs(out, ['--attempt', '1', '--resume', '--budget-run-id', runId, '--calibration', calibration]));
    const whileOpen = newRun(370);
    const held = gate(whileOpen);
    expect(held.exitCode).toBe(2);
    expect(held.stderr.toString()).toContain(`other runs of n15-ceiling-gate-1 hold $470.00 of the stage's $470 cap (closed runs what they committed, open runs their budget), so $0.00 is left; still open: ${earlier}`);
    close(whileOpen);
    close(earlier);
    const fullRun = newRun(470);
    const full = gate(fullRun);
    expect(full.exitCode).toBe(2);
    expect(full.stderr.toString()).toContain('other runs of n15-ceiling-gate-1 hold $100.00 of the stage\'s $470 cap (closed runs what they committed, open runs their budget), so $370.00 is left; open a run with --budget-usd 370.00 or less');
    close(fullRun);
    pastTheCap(gate(newRun(370)));
    expect(readFileSync(join(out, 'rows.jsonl'), 'utf8').trim().split('\n').length).toBe(2);
  }, 120_000);

  test("calibration's re-read fits what is left of its $50 cap: with $27.95 committed under a closed run, a new $22.06 run is refused and a $22.05 run is admitted", () => {
    const out = tempDir();
    const { newRun, close } = stageLedger(out, 'n15-ceiling-calibration', { budgetUsd: 50, usd: 27.95, close: true });
    const overRun = newRun(22.06);
    const over = calibrate(out, overRun);
    expect(over.exitCode).toBe(2);
    expect(over.stderr.toString()).toContain('other runs of n15-ceiling-calibration hold $27.95 of the stage\'s $50 cap (closed runs what they committed, open runs their budget), so $22.05 is left');
    close(overRun);
    pastTheCap(calibrate(out, newRun(22.05)));
  }, 120_000);

  test('two open runs of one stage cannot both hold its cap: a second $50 calibration run is refused while the first is open, and admitted once the first closes having spent nothing', () => {
    const out = tempDir();
    const { earlier, newRun, close } = stageLedger(out, 'n15-ceiling-calibration', { budgetUsd: 50, usd: 0, close: false });
    const second = newRun(50);
    const refused = calibrate(out, second);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr.toString()).toContain(`other runs of n15-ceiling-calibration hold $50.00 of the stage's $50 cap (closed runs what they committed, open runs their budget), so $0.00 is left; still open: ${earlier}`);
    close(earlier);
    pastTheCap(calibrate(out, second));
  }, 120_000);

  test("a live attempt 2 takes attempt 1's receipt and refuses the manifest attempt 1 read", () => {
    const out = tempDir();
    const calibration = `${calibrationReceipt(out, 'opus', 0.2)},${calibrationReceipt(out, 'sol', 0.1)}`;
    const args = ['--attempt', '2', '--budget-run-id', 'n15-ceiling-gate-2-test', '--calibration', calibration];
    const none = keyless(gateArgs(out, args));
    expect(none.exitCode).toBe(2);
    expect(none.stderr.toString()).toContain('pass --previous');
    const previous = join(out, 'gate-1.json');
    writeFileSync(previous, JSON.stringify({ category: 'n15-skillopt-method', hashes: { dataset_manifest_sha256: manifest() }, resolved_config: { stage: 'gate', attempt: 1 } }));
    const same = keyless(gateArgs(out, [...args, '--previous', previous]));
    expect(same.exitCode).toBe(2);
    expect(same.stderr.toString()).toContain("read this tree's skillopt-method-v3 manifest");
    expect(existsSync(join(out, 'rows.jsonl'))).toBe(false);
  }, 120_000);

  test('a live attempt 2 runs only after a complete live attempt 1 whose verdict is revise: such a receipt is admitted, and a fake, partial or stub receipt, or one that read stop, is refused', () => {
    const out = tempDir();
    const calibration = `${calibrationReceipt(out, 'opus', 0.2)},${calibrationReceipt(out, 'sol', 0.1)}`;
    const { newRun } = stageLedger(out, 'n15-ceiling-gate-2', { budgetUsd: 470, usd: 0, close: true });
    const attempt1 = (name: string, mode: string, publishable: boolean, next: string | null) => {
      const path = join(out, `${name}.json`);
      writeFileSync(path, JSON.stringify({ category: 'n15-skillopt-method', publishable, hashes: { dataset_manifest_sha256: 'a'.repeat(64) }, resolved_config: { stage: 'gate', attempt: 1, mode }, data: { gate: next ? { verdict: { next } } : null } }));
      return path;
    };
    const gate2 = (previous: string, runId: string) => keyless(gateArgs(out, ['--attempt', '2', '--budget-run-id', runId, '--calibration', calibration, '--previous', previous]));
    pastTheCap(gate2(attempt1('revise', 'ceiling', true, 'revise'), newRun(470)));
    for (const [previous, next] of [[attempt1('fake', 'ceiling-fake', false, 'revise'), 'revise'], [attempt1('partial', 'ceiling', false, 'revise'), 'revise'], [attempt1('stub', 'ceiling', true, null), 'none'], [attempt1('stop', 'ceiling', true, 'stop'), 'stop']] as const) {
      const p = gate2(previous, 'n15-ceiling-gate-2-test');
      expect(p.exitCode).toBe(2);
      expect(p.stderr.toString()).toContain(`is not a complete live attempt 1 whose verdict is revise (next: ${next})`);
    }
    expect(existsSync(join(out, 'rows.jsonl'))).toBe(false);
  }, 120_000);

  test('--dataset v3 refuses an unknown --stage and --probe', () => {
    expect(run(['--dataset', 'v3', '--stage', 'f0a']).exitCode).toBe(3);
    expect(run(['--dataset', 'v3', '--stage', 'gate', '--probe']).exitCode).toBe(3);
  }, 120_000);
});

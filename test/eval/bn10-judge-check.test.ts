/**
 * The BEAM-10M re-measure's judge agreement check (eval/runner/q1/bn10-judges.ts), keyless: the known-verdict items
 * from GST-1365's control builder on rubric-scored BEAM-1M dev questions, every judge's request at its preregistered
 * settings through the lease proxy to a fake upstream, the output-limit tally, kappa and Wilson against hand
 * computations, the per-judge gates and the verdict (STOP, INCOMPLETE, bridge descriptive-only), the report guard, the
 * judges' pairwise agreement on dry-run answers, and the window guard that refuses before any output or lease.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cohenKappa, wilson } from '../../eval/runner/bg1/judge-check.ts';
import { closeLedgers } from '../../eval/runner/budget-ledger.ts';
import type { MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';
import { instrumentFor } from '../../eval/runner/memory-qa/instruments.ts';
import { sha256, type JudgmentRecord } from '../../eval/runner/memory-qa/records.ts';
import { analyzeCheck, BRIDGE, callCount, CHECK_JUDGES, checkItems, checkTasks, dryRunAgreement, dryRunCells, FRONTIER_JUDGES, guardItems, judgeInWindow, readCalls } from '../../eval/runner/q1/bn10-judges.ts';
import type { ControlAnswer, Task } from '../../eval/runner/q1/rejudge-systems.ts';
import { ScoreboardError } from '../../eval/runner/q1/scoreboard-errors.ts';

const ROOT = join(import.meta.dir, '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'bn10-judge-check-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let saved: NodeJS.ProcessEnv = {};
beforeEach(() => { saved = { ...process.env }; });
afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); closeLedgers(); });

const OPUS = 'anthropic:claude-opus-5-5', SOL61 = 'openai:gpt-6.1-sol', MINI = 'openai:gpt-4.1-mini';
const PINNED = { effort: 'medium', max_tokens: 8000 };
const ABILITIES = ['information_extraction', 'multi_session_reasoning', 'knowledge_update', 'temporal_reasoning', 'abstention', 'contradiction_resolution', 'event_ordering', 'instruction_following', 'preference_following', 'summarization'];
/** Invented BEAM-1M-shaped dev questions: two per ability per conversation, each with rubric items except one summarization question per conversation. */
const devQuestions = (conversations: number): MemoryQuestion[] => Array.from({ length: conversations }, (_, c) => ABILITIES.flatMap((category, a) => [0, 1].map(i => ({
  id: `dev-c${c}-${category}-${i}`, conversation: `dev-c${c}`, question: 'q?', category, gold: [], abstention: category === 'abstention', answer: `invented gold ${c} ${category} ${i}`,
  ...(a === 9 && i === 1 ? {} : { rubric: [`first rubric item ${c}-${a}-${i}`, ...(i ? ['second rubric item'] : [])] }) })))).flat() as MemoryQuestion[];
const questions = devQuestions(11);
const byId = new Map(questions.map(q => [q.id, q]));
const refusal = (fn: () => unknown) => { try { fn(); } catch (e) { if (e instanceof ScoreboardError) return e.op; throw e; } throw new Error('expected a refusal'); };
const judgment = (answer_id: string, judge: string, score: number | null, settings?: { effort: string; max_tokens: number }): JudgmentRecord => ({ answer_id, instrument_id: judge === MINI ? 'beam-1m' : `beam-1m@${judge}`,
  instrument_sha256: instrumentFor('beam-1m').sha256, judge, judge_replicate: 0, temperature: 0, score, parse_ok: score !== null, raw_sha256: sha256('raw'), outcome: score === null ? 'judge_error' : 'scored', ...(settings ? { settings } : {}) });
/** Every judge grades every item: correct by default, or as \`verdict\` says; frontier judgments at the pinned settings. */
const grade = (items: readonly ControlAnswer[], verdict: (i: ControlAnswer, judge: string) => boolean = i => i.expected === 'pass') =>
  items.flatMap(i => CHECK_JUDGES.map(j => judgment(i.answer_id, j, verdict(i, j) ? 1 : 0, j === MINI ? undefined : PINNED)));
const calls = (n: number, truncated: Record<string, number> = {}) => Object.fromEntries(CHECK_JUDGES.map(j => [j, { calls: n, truncated: truncated[j] ?? 0 }]));

describe('items and tasks', () => {
  // Value: protects=preregistration "Judge agreement check" item 1: buildControls on 50 rubric-scored BEAM-1M dev questions, four known-verdict controls each, more than 40 items with at least 15 per class; fails_when=a question without rubric items or an event-ordering question is drawn, fewer than 50 questions are used, the items change between builds, or a set too small to meet the counts is accepted; why_new=BN10 judge check; seam=checkItems; no_claim=how many of the real BEAM-1M dev questions carry rubrics
  test('50 rubric-scored questions, four controls each, deterministic, and refused below the preregistered counts', () => {
    const b = checkItems(questions);
    expect(checkItems(questions)).toEqual(b);
    expect(b.questions).toBe(50);
    expect(b.items.length).toBe(200 - b.c2_skipped);
    expect(b.items.length).toBeGreaterThan(40);
    expect(Math.min(b.classes.pass, b.classes.fail)).toBeGreaterThanOrEqual(15);
    for (const i of b.items) {
      const q = byId.get(i.question_id)!;
      expect([q.rubric!.length > 0, q.category !== 'event_ordering', i.set]).toEqual([true, true, 'beam-1m-dev']);
    }
    expect(refusal(() => checkItems(devQuestions(2))).code).toBe('PREFLIGHT_FAILED');
  });

  // Value: protects=preregistration item 2 and A1: the judges whose numbers count are gpt-6.1-sol and claude-opus-5-5 (frontierJudgeOf of the BN10 readers and particle-1) at PER_READER_JUDGE_SETTINGS in the gating view, and gpt-4.1-mini at its canonical settings, all under BEAM's rubric instrument; fails_when=a judge is missing or added, a frontier judge is sent at its default settings, or the bridge is pinned; why_new=BN10 judge check; seam=checkTasks/callCount; no_claim=none
  test('every item for gpt-6.1-sol and claude-opus-5-5 at the pinned settings and for gpt-4.1-mini canonical, under beam-1m', () => {
    const { items } = checkItems(questions);
    const tasks = checkTasks(items);
    expect([FRONTIER_JUDGES, CHECK_JUDGES, BRIDGE]).toEqual([[OPUS, SOL61], [OPUS, SOL61, MINI], MINI]);
    expect(tasks.length).toBe(items.length * 3);
    const sha = instrumentFor('beam-1m').sha256;
    for (const t of tasks) {
      if (t.judge === MINI) expect([t.instrument_id, t.settings, t.view, t.instrument_sha256]).toEqual(['beam-1m', undefined, 'descriptive', sha]);
      else expect([t.instrument_id, t.settings, t.view, t.instrument_sha256]).toEqual([`beam-1m@${t.judge}`, PINNED, 'gating', sha]);
    }
    const rubricItems = items.reduce((n, i) => n + byId.get(i.question_id)!.rubric!.length, 0);
    expect(callCount(tasks, t => byId.get(t.question_id)!)).toBe(rubricItems * 3);
  });
});

describe('grading through the lease proxy, keyless', () => {
  // Value: protects=every check request goes through one lease and the metering proxy to the keyless upstream with placeholder keys, Sol and Opus at medium effort and 8,000 output tokens, gpt-4.1-mini at BEAM's 1,024 with no effort, the pinned settings recorded on each frontier judgment, and every call's finish tallied so a gpt-4.1-mini truncation counts; fails_when=judgeTasks drops a task's pinned settings (sent at each judge's default, as GST-1365 judged), a request leaves the fake upstream or carries a real key, the proxy clamps the pinned 8,000 to the 2,048 judge route, or a truncation goes untallied; why_new=BN10 judge check (pinned settings in rejudge-systems.ts judgeTasks); seam=judgeInWindow with a fake upstream; no_claim=how the real models grade
  test('Sol and Opus at medium effort and 8,000 tokens, gpt-4.1-mini at its canonical request, placeholder keys only, truncations tallied', async () => {
    const seen: Array<{ path: string; auth: string | null; body: Record<string, unknown> }> = [];
    let miniCalls = 0;
    const upstream = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
      const path = new URL(req.url).pathname, body = await req.json() as Record<string, unknown>;
      seen.push({ path, auth: req.headers.get('authorization') ?? req.headers.get('x-api-key'), body });
      const text = JSON.stringify({ score: 1 });
      if (path.endsWith('/messages')) return Response.json({ id: 'm', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 5 } });
      const finish = body.model === 'gpt-4.1-mini' && ++miniCalls === 1 ? 'length' : 'stop';
      return Response.json({ id: 'c', model: body.model, choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 100, completion_tokens: 5 } });
    } });
    const out = join(tmp, 'grade');
    mkdirSync(out, { recursive: true });
    const items = checkItems(questions).items.filter(i => i.control === 'C1').slice(0, 2);
    const tasks = checkTasks(items);
    try {
      const { run, stop } = await judgeInWindow({ tasks, question: (t: Task) => byId.get(t.question_id)!, out, logPath: join(out, 'judgments.ndjson'), keyless: `http://127.0.0.1:${upstream.port}`, window: null,
        lease: { ledger: join(tmp, 'grade-ledger.sqlite'), runId: 'bn10-check-keyless', leaseUsd: 1, capUsd: 2, concurrency: 2 }, runner: 'bn10-judge-check' });
      expect([run.judged, run.remaining, run.request_errors, stop]).toEqual([6, 0, 0, null]);
    } finally { upstream.stop(true); }
    const sol = seen.filter(s => s.body.model === 'gpt-6.1-sol'), opus = seen.filter(s => s.body.model === 'claude-opus-5-5'), mini = seen.filter(s => s.body.model === 'gpt-4.1-mini');
    const rubricCalls = items.reduce((n, i) => n + byId.get(i.question_id)!.rubric!.length, 0);
    expect([sol.length, opus.length, mini.length, seen.length]).toEqual([rubricCalls, rubricCalls, rubricCalls, rubricCalls * 3]);
    expect(new Set(sol.map(s => [s.body.reasoning_effort, s.body.max_completion_tokens].join('|')))).toEqual(new Set(['medium|8000']));
    expect(new Set(opus.map(s => [(s.body.output_config as { effort: string }).effort, s.body.max_tokens].join('|')))).toEqual(new Set(['medium|8000']));
    expect(new Set(mini.map(s => [s.body.reasoning_effort ?? 'none', s.body.max_tokens].join('|')))).toEqual(new Set(['none|1024']));
    expect(seen.every(s => !!s.auth && s.auth.includes('keyless-not-a-provider-key'))).toBe(true);
    const judged = readFileSync(join(out, 'judgments.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as JudgmentRecord);
    expect(judged.filter(j => j.judge !== MINI).every(j => j.settings?.effort === 'medium' && j.settings.max_tokens === 8000 && j.view === 'gating')).toBe(true);
    expect(judged.filter(j => j.judge === MINI).every(j => j.settings === undefined)).toBe(true);
    expect(readCalls(join(out, 'calls.ndjson'))).toEqual({ [SOL61]: { calls: rubricCalls, truncated: 0 }, [OPUS]: { calls: rubricCalls, truncated: 0 }, [MINI]: { calls: rubricCalls, truncated: 1 } });
    const receipt = JSON.parse(readFileSync(join(out, 'receipts', 'bn10-judge-check-bn10-check-keyless.json'), 'utf8'));
    expect([receipt.keyless, receipt.attestation, JSON.parse(readFileSync(join(out, 'ledger-tie.json'), 'utf8')).ledger]).toEqual([true, null, join(tmp, 'grade-ledger.sqlite')]);
  }, 30_000);
});

describe('the gate and the report', () => {
  const { items } = checkItems(questions);

  // Value: protects=preregistration item 3 and A2 check 2: per judge, kappa against the known verdicts at least 0.6 on at least 40 items with at least 15 per class and at most 1% of calls at the output limit, a frontier failure stops the experiment, a gpt-4.1-mini failure makes the bridge descriptive only, and kappa and every Wilson interval match the shared formulas; fails_when=a failing frontier judge does not stop, a failing bridge stops, a gate is missing, or a number differs from cohenKappa or wilson; why_new=BN10 judge check; seam=analyzeCheck; no_claim=none
  test('judges that grade like the labels pass; a frontier failure is STOP, a bridge failure descriptive only, and the numbers match kappa and Wilson', () => {
    const ok = analyzeCheck(items, grade(items), calls(400), false);
    expect([ok.verdict, ok.bridge, ok.stop_reasons]).toEqual(['PASS', 'counts', []]);
    for (const j of CHECK_JUDGES) expect([ok.judges[j].kappa, ok.judges[j].scored, ok.judges[j].pass, ok.judges[j].error_by_kind.C2.rate]).toEqual([1, items.length, true, 0]);
    const lax = (i: ControlAnswer, j: string) => j === OPUS ? true : i.expected === 'pass';
    const stop = analyzeCheck(items, grade(items, lax), calls(400), false);
    expect([stop.verdict, stop.bridge, stop.stop_reasons]).toEqual(['STOP', 'counts', [`${OPUS}:kappa`]]);
    const k = cohenKappa(items.map(i => i.expected === 'pass'), items.map(() => true));
    expect(stop.judges[OPUS].kappa).toBe(k.kappa === null ? null : Math.round(k.kappa * 1e4) / 1e4);
    const c3 = items.filter(i => i.control === 'C3'), wrong = c3.filter(i => i.expected === 'fail').length;
    expect(stop.judges[OPUS].error_by_kind.C3).toEqual({ k: wrong, n: c3.length, rate: Math.round(wrong / c3.length * 1e4) / 1e4, ci95: wilson(wrong, c3.length)!.map(x => Math.round(x * 1e4) / 1e4) });
    const bridge = analyzeCheck(items, grade(items, (i, j) => j === MINI ? true : i.expected === 'pass'), calls(400), false);
    expect([bridge.verdict, bridge.bridge, bridge.judges[MINI].pass]).toEqual(['PASS', 'descriptive-only', false]);
  });

  // Value: protects=the truncation, item-count and class gates, and that frontier judgments not at the pinned settings never count; fails_when=a judge passes with more than 1% of calls at the output limit, with fewer than 40 scored items, with under 15 in a class, or on judgments made at other settings, or an unfinished check reads as STOP or PASS; why_new=BN10 judge check; seam=analyzeCheck; no_claim=none
  test('over 1% truncation, fewer than 40 items, too few in a class, or judgments at other settings fail; items left read INCOMPLETE', () => {
    const trunc = analyzeCheck(items, grade(items), calls(400, { [SOL61]: 5 }), false);
    expect([trunc.verdict, trunc.judges[SOL61].truncation.rate, trunc.stop_reasons]).toEqual(['STOP', 0.0125, [`${SOL61}:truncation`]]);
    expect(analyzeCheck(items, grade(items), calls(400, { [SOL61]: 4 }), false).verdict).toBe('PASS');
    const few = items.slice(0, 39);
    const small = analyzeCheck(few, grade(few), calls(400), false);
    expect(small.judges[OPUS].gates.find(g => g.gate === 'scored_items')!.pass).toBe(false);
    const passOnly = items.filter(i => i.expected === 'pass').slice(0, 41).concat(items.filter(i => i.expected === 'fail').slice(0, 14));
    expect(analyzeCheck(passOnly, grade(passOnly), calls(400), false).judges[SOL61].gates.find(g => g.gate === 'per_class')).toMatchObject({ value: 14, pass: false });
    const unpinned = grade(items).map(j => (j.judge === SOL61 ? { ...j, settings: undefined } : j));
    const off = analyzeCheck(items, unpinned, calls(400), false);
    expect([off.verdict, off.judges[SOL61].graded, off.judges[SOL61].off_settings]).toEqual(['INCOMPLETE', 0, items.length]);
    const partial = analyzeCheck(items, grade(items).filter(j => !(j.judge === MINI && j.answer_id === items[0].answer_id)), calls(400), false);
    expect([partial.verdict, partial.bridge]).toEqual(['PASS', 'incomplete']);
    const errored = grade(items).map(j => (j.judge === OPUS && j.answer_id === items[0].answer_id ? { ...j, score: null, parse_ok: false, outcome: 'judge_error' as const } : j));
    expect([analyzeCheck(items, errored, calls(400), false).judges[OPUS].unscored, analyzeCheck(items, errored, calls(400), false).judges[OPUS].complete]).toEqual([1, true]);
  });

  // Value: protects=the check's item texts stay out of the repository: the report carries counts, rates and kappas, and a report holding an item's question id or text is refused; fails_when=a report field carries an id or text, or the guard lets one through; why_new=BN10 judge check; seam=analyzeCheck/guardItems; no_claim=none
  test('the report holds no item text, question id or dollar field, and the guard refuses one that would', () => {
    const json = JSON.stringify(analyzeCheck(items, grade(items), calls(400), false));
    expect(() => guardItems(json, items)).not.toThrow();
    expect(json).not.toMatch(/usd|spend|cost/i);
    expect(refusal(() => guardItems(`mean 0.5 on ${items[0].question_id}`, items)).code).toBe('PREFLIGHT_FAILED');
    expect(refusal(() => guardItems(JSON.stringify({ text: items[0].text }), items)).message).toContain('question id or text');
  });
});

describe('agreement on the dry run\'s real answers', () => {
  const [p, a0] = dryRunCells().filter(c => !c.includes('reread'));
  const reread = dryRunCells().find(c => c.startsWith(`${p}.reread-`))!;
  const root = (name: string, keyless: boolean | null) => {
    const r = join(tmp, name);
    mkdirSync(r, { recursive: true });
    if (keyless !== null) writeFileSync(join(r, 'upstream.json'), JSON.stringify({ keyless }));
    return r;
  };
  const write = (r: string, cell: string, js: JudgmentRecord[]) => { mkdirSync(join(r, 'cells', cell), { recursive: true }); writeFileSync(join(r, 'cells', cell, 'judgments.ndjson'), js.map(j => JSON.stringify(j) + '\n').join('')); };

  // Value: protects=preregistration item 4: the three judges' pairwise agreement on the dry run's real answers, descriptive, over answers both judges graded, frontier judgments only at the pinned settings, paid dry runs only, and only the dry run's own cells; fails_when=a pair counts answers one judge never graded, an unpinned frontier judgment counts, a keyless dry run or another cell's judgments are read, or a report carries an answer id; why_new=BN10 judge check; seam=dryRunAgreement; no_claim=the pair Sol and Opus share no dry-run answer by design, so its count is 0
  test('pairs over shared answers, unpinned frontier judgments left out, keyless dry runs refused', () => {
    const r = root('dry', false), id = (x: string) => sha256(x);
    write(r, p, [judgment(id('a1'), MINI, 1), judgment(id('a1'), SOL61, 1, PINNED), judgment(id('a2'), MINI, 0), judgment(id('a2'), SOL61, 1, PINNED), judgment(id('a3'), MINI, 1), judgment(id('a3'), SOL61, 1)]);
    write(r, a0, [judgment(id('b1'), MINI, 1), judgment(id('b1'), OPUS, 1, PINNED), judgment(id('b2'), MINI, 0), judgment(id('b2'), OPUS, 0, PINNED)]);
    write(r, reread, [judgment(id('c1'), MINI, 0), judgment(id('c1'), SOL61, 0, PINNED), judgment(id('c2'), MINI, null), judgment(id('c2'), SOL61, 1, PINNED)]);
    write(r, 's1.gbrain-defaults.bn10-newest.p', [judgment(id('z1'), MINI, 1), judgment(id('z1'), SOL61, 1, PINNED)]);
    const a = dryRunAgreement([r]);
    const pair = (x: string, y: string) => a.pairs.find(q => q.judges[0] === x && q.judges[1] === y)!;
    expect([a.cell_files, a.unpinned_frontier_judgments, a.answers]).toEqual([3, 1, 7]);
    expect([pair(OPUS, SOL61).agreement.n, pair(OPUS, MINI).agreement, pair(SOL61, MINI).agreement.k, pair(SOL61, MINI).agreement.n]).toEqual([0, { k: 2, n: 2, rate: 1, ci95: wilson(2, 2)!.map(x => Math.round(x * 1e4) / 1e4) }, 2, 3]);
    expect(['a1', 'b1', 'c1', 'z1'].some(x => JSON.stringify(a).includes(id(x)))).toBe(false);
    expect(refusal(() => dryRunAgreement([root('dry-keyless', true)])).message).toContain('paid dry-run outs only');
    expect(refusal(() => dryRunAgreement([root('dry-empty', false)])).code).toBe('INPUT_MISSING');
  });
});

describe('the command line', () => {
  const cli = (args: string[]) => {
    const r = Bun.spawnSync(['bun', 'eval/runner/q1/bn10-judges.ts', ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } });
    return { code: r.exitCode, text: r.stdout.toString() + r.stderr.toString() };
  };
  const lease = (name: string) => ['--budget-ledger', join(tmp, `${name}.sqlite`), '--run-id', `bn10-${name}`, '--lease-usd', '1', '--ledger-cap-usd', '2'];

  // Value: protects=the check spends real keys only inside a granted paid window: without --keyless-upstream it needs --paid-window and --window-cap-usd, a ledger cap or lease above the window cap is refused, and a keyless run needs its lease flags, each before any output, ledger or lease; fails_when=check-run reaches a provider or writes an out or a ledger outside a window; why_new=BN10 judge check; seam=bn10-judges.ts check-run; no_claim=the paid path's key preflight (preflightKeys is covered in q1-rejudge-systems.test.ts)
  test('check-run without a window, above its cap, or keyless without lease flags exits 2 before any output or ledger', () => {
    const cases: Array<[string, string[], string]> = [
      ['no-window', lease('no-window'), 'needs --paid-window'],
      ['over-cap', [...lease('over-cap'), '--paid-window', 'BN10-TEST', '--window-cap-usd', '1'], 'above paid window BN10-TEST'],
      ['keyless-no-lease', ['--keyless-upstream', 'http://127.0.0.1:9'], 'needs --budget-ledger'],
    ];
    for (const [name, flags, words] of cases) {
      const out = join(tmp, `cli-${name}`);
      const r = cli(['check-run', '--out', out, ...flags]);
      expect([name, r.code, r.text.includes(words), existsSync(out), existsSync(join(tmp, `${name}.sqlite`))]).toEqual([name, 2, true, false, false]);
    }
  });

  // Value: protects=check-report scores only the frozen items in --out and refuses an --out without them; fails_when=a report is written without the check's items; why_new=BN10 judge check; seam=bn10-judges.ts check-report; no_claim=none
  test('check-report refuses an --out with no items.json', () => {
    const r = cli(['check-report', '--out', join(tmp, 'cli-report')]);
    expect([r.code !== 0, r.text.includes('has no items.json'), existsSync(join(tmp, 'cli-report', 'report.json'))]).toEqual([true, true, false]);
  });
});

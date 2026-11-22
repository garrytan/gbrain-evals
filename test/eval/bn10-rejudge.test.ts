/**
 * The BEAM-10M re-measure's custody re-judge of four stored S1 answer sets (eval/runner/q1/bn10-judges.ts rejudge-*)
 * over invented F6 and Q1 receipts, keyless: which Opus answers each set sends and which it counts as product
 * failures, harness failures or missing, that no stored frontier judgment is reused, that Q1's answer ids stay apart
 * from F6's, every request at gpt-6.1-sol's pinned settings through the lease proxy to a fake upstream, the plan's
 * call count, the resume guard on judgments made at other settings, the aggregates (no question or answer id, no
 * dollar figure), and the window guard that refuses before any output or lease.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wilson } from '../../eval/runner/bg1/judge-check.ts';
import { closeLedgers } from '../../eval/runner/budget-ledger.ts';
import type { MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';
import { instrumentFor } from '../../eval/runner/memory-qa/instruments.ts';
import { answerRecord, sha256, type AnswerRecord, type JudgmentRecord } from '../../eval/runner/memory-qa/records.ts';
import { checkOwnLog, judgeInWindow, loadStored, rejudgeAggregates, rejudgePlan, STORED_JUDGE, STORED_SETS, storedTasks } from '../../eval/runner/q1/bn10-judges.ts';
import { CONTRASTS, judgeFor, type Task } from '../../eval/runner/q1/rejudge-systems.ts';
import { ScoreboardError } from '../../eval/runner/q1/scoreboard-errors.ts';

const ROOT = join(import.meta.dir, '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'bn10-rejudge-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let saved: NodeJS.ProcessEnv = {};
beforeEach(() => { saved = { ...process.env }; });
afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); closeLedgers(); });

const OPUS = 'anthropic:claude-opus-5-5', SOL = 'openai:gpt-6.1-sol', MINI = 'openai:gpt-4.1-mini';
const PINNED = { effort: 'medium', max_tokens: 8000 } as const;
const qid = (c: number, i: number) => `s1-c${c}-q${i}`;
const SCHEDULED = [0, 1, 2, 3].flatMap(c => [0, 1, 2].map(i => ({ question_id: qid(c, i), conversation: `s1-c${c}` })));
const EXCLUDED = qid(3, 2);
const F6P = 's1.gbrain-defaults.f6-master.p', F6A = 's1.gbrain-defaults.f6-master.a', FILE_AGENT = 's1.baseline-file-agent.baseline.whole-agent';
/** Opus answers that are not judged: a missing one in F6 arm P, a harness failure in F6 arm A, a product failure in Q1's file agent. */
const MISSING = { root: 'f6', cell: F6P, q: qid(0, 1) }, HARNESS = { root: 'f6', cell: F6A, q: qid(1, 0), outcome: 'reader_error' }, PRODUCT = { root: 'q1', cell: FILE_AGENT, q: qid(2, 2), outcome: 'turn_cap' };
const good = (cell: string, q: string) => parseInt(sha256(`${cell}|${q}`).slice(0, 8), 16) % 3 !== 0;
const lines = (xs: unknown[]) => xs.map(x => JSON.stringify(x) + '\n').join('');

/** One invented receipt: every cell GST-1365's contrasts name on this root plus F6 arm A, all on S1, read by Opus and gpt-6.2-sol, with canonical and, on F6 arm P, default-effort frontier judgments. */
function publish(root: string, kind: 'f6' | 'q1') {
  const ids = [...new Set([...CONTRASTS.filter(c => c.root === kind).flatMap(c => [c.anchor, c.other]), ...STORED_SETS.filter(x => x.root === kind).map(x => x.cell)])];
  const cells = ids.map(id => ({ cell_id: id, set: 'S1', system: id.split('.')[1], readers: [OPUS, 'openai:gpt-6.2-sol'], canonical_instrument: 'beam-10m', status: 'complete' }));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'campaign.json'), JSON.stringify({ sets: [{ id: 'S1', scheduled: SCHEDULED, exclusions: [{ question_id: EXCLUDED, reason: 'invented' }] }], cells }));
  const inst = instrumentFor('beam-10m');
  for (const c of cells) {
    const dir = join(root, 'cells', c.cell_id);
    mkdirSync(dir, { recursive: true });
    const answers: AnswerRecord[] = [], judgments: JudgmentRecord[] = [];
    for (const q of SCHEDULED) for (const reader of c.readers) {
      if (reader === OPUS && MISSING.root === kind && MISSING.cell === c.cell_id && MISSING.q === q.question_id) continue;
      const special = [HARNESS, PRODUCT].find(x => reader === OPUS && x.root === kind && x.cell === c.cell_id && x.q === q.question_id);
      const a = answerRecord({ cell_id: c.cell_id, realization_id: 'r0', question_id: q.question_id, conversation: q.conversation, system: c.system, arm: 'component', reader, replicate: 0, effort: 'medium', context_sha256: sha256(`ctx|${c.cell_id}|${q.question_id}`) } as never,
        { text: `${kind} answer ${c.cell_id} ${reader} ${q.question_id}${good(c.cell_id, q.question_id) ? ' GOOD' : ''}`, outcome: special?.outcome ?? 'scored', usage: { input: 10, output: 2, cache_read: 0, cache_write: 0 }, latency_ms: 5, provider_input_tokens: 10 } as never);
      answers.push(a);
      if (special) continue;
      judgments.push({ answer_id: a.answer_id, instrument_id: inst.id, instrument_sha256: inst.sha256, judge: MINI, judge_replicate: 0, temperature: 0, score: 1, parse_ok: true, raw_sha256: sha256('raw'), outcome: 'scored' });
      if (c.cell_id === F6P && reader === OPUS) judgments.push({ answer_id: a.answer_id, instrument_id: `${inst.id}@${SOL}`, instrument_sha256: inst.sha256, judge: SOL, judge_replicate: 0, temperature: null, score: 1, parse_ok: true, raw_sha256: sha256('raw'), outcome: 'scored' });
    }
    writeFileSync(join(dir, 'answers.ndjson'), lines(answers));
    writeFileSync(join(dir, 'judgments.ndjson'), lines(judgments));
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify({ cell_id: c.cell_id, instrument: { id: inst.id, sha256: inst.sha256 } }));
  }
}
const f6 = join(tmp, 'f6'), q1 = join(tmp, 'q1');
publish(f6, 'f6');
publish(q1, 'q1');
const roots = [`f6=${f6}`, `q1=${q1}`];
const question = (t: { question_id: string }): MemoryQuestion => ({ id: t.question_id, conversation: 'c', question: 'q?', category: t.question_id.endsWith('q0') ? 'event_ordering' : 'information_extraction', gold: [], abstention: false, answer: 'gold', rubric: ['first item', 'second item'] });
const plain = (t: { question_id: string }): MemoryQuestion => ({ ...question(t), category: 'information_extraction' });
const refusal = (fn: () => unknown) => { try { fn(); } catch (e) { if (e instanceof ScoreboardError) return e.op; throw e; } throw new Error('expected a refusal'); };

describe('what the re-judge sends', () => {
  // Value: protects=preregistration "Stored answers judged again, in custody": the four stored S1 sets' replicate-0 claude-opus-5-5 answers, each judged again by gpt-6.1-sol at the pinned settings in the gating view, product failures at 0 and never sent, harness failures and missing answers counted, excluded questions left out, the stored default-effort frontier judgments never reused, and Q1's answer ids kept apart from F6's; fails_when=a set is missing (F6 arm A is not one of GST-1365's contrast cells), another reader or judge is sent, a task lacks the pinned settings, a stored judgment stands in for a new one, or a Q1 file-agent answer shares F6's id; why_new=BN10 custody re-judge; seam=loadStored/storedTasks; no_claim=the real receipts' counts
  test('four stored sets, Opus answers only, gpt-6.1-sol at the pinned settings, stored judgments not reused, Q1 ids apart from F6', () => {
    const s = loadStored(roots, join(tmp, 'tasks'));
    const { tasks, sets, setOf } = storedTasks(s);
    expect([STORED_JUDGE, judgeFor(OPUS)]).toEqual([SOL, SOL]);
    expect(sets).toEqual({
      'f6-p': { scheduled: 11, excluded: 1, missing: 1, product_failures: 0, not_judged: 0, to_judge: 10 },
      'f6-a': { scheduled: 11, excluded: 1, missing: 0, product_failures: 0, not_judged: 1, to_judge: 10 },
      'q1-whole': { scheduled: 11, excluded: 1, missing: 0, product_failures: 0, not_judged: 0, to_judge: 11 },
      'q1-file-agent': { scheduled: 11, excluded: 1, missing: 0, product_failures: 1, not_judged: 0, to_judge: 10 },
    });
    expect(tasks.length).toBe(41);
    expect(new Set(tasks.map(t => t.answer_id)).size).toBe(41);
    for (const t of tasks) expect([t.reader, t.judge, t.settings, t.view, t.instrument_id, t.question_id === EXCLUDED]).toEqual([OPUS, SOL, PINNED, 'gating', `beam-10m@${SOL}`, false]);
    const f6Agent = s.cells.get(`f6:${FILE_AGENT}`)!.answers.map(a => a.answer_id);
    expect(tasks.filter(t => setOf.get(t.answer_id) === 'q1-file-agent').some(t => f6Agent.includes(t.answer_id))).toBe(false);
    const stored = new Set(s.cells.get(`f6:${F6P}`)!.judgments.filter(j => j.judge === SOL).map(j => j.answer_id));
    expect(tasks.filter(t => setOf.get(t.answer_id) === 'f6-p').every(t => stored.has(t.answer_id))).toBe(true);
  });

  // Value: protects=the plan step sends nothing and prints the call count: one call per rubric item per judgment, with event-ordering answers (which also ask BEAM's equivalence calls) counted apart, and no dollar figure; fails_when=the count drifts from the tasks, or a projected dollar figure appears; why_new=BN10 custody re-judge; seam=rejudgePlan; no_claim=the equivalence calls an event-ordering answer asks depend on its text
  test('the plan counts judgments and calls per set, event-ordering answers apart, with no dollar figure', () => {
    const stored = storedTasks(loadStored(roots, join(tmp, 'plan')));
    const p = rejudgePlan(stored, question);
    expect([p.judge, p.settings, p.total.judgments, p.total.calls]).toEqual([SOL, PINNED, 41, 82]);
    expect([p.sets['f6-p'].judgments, p.sets['f6-p'].calls, p.sets['q1-whole'].event_ordering_answers]).toEqual([10, 20, 4]);
    expect(p.total.event_ordering_answers).toBe(stored.tasks.filter(t => t.question_id.endsWith('q0')).length);
    expect(JSON.stringify(p)).not.toMatch(/usd|spend|cost/i);
  });
});

describe('judging and aggregates', () => {
  // Value: protects=every re-judge request goes to gpt-6.1-sol at medium effort and 8,000 output tokens through one lease and the metering proxy to the keyless upstream with placeholder keys, and the aggregates carry per-set counts, means and Wilson pass rates (product failures at 0) with no question or answer id and no dollar figure; fails_when=a request is sent at GST-1365's default effort, leaves the fake upstream, or carries a real key, or the aggregates miscount, drop product failures, or carry an id; why_new=BN10 custody re-judge; seam=judgeInWindow/rejudgeAggregates with a fake upstream; no_claim=how the real model grades
  test('every request at the pinned settings to the keyless upstream; aggregates per set with product failures at 0 and no ids', async () => {
    const seen: Array<{ model: unknown; effort: unknown; max: unknown; auth: string | null }> = [];
    const upstream = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
      const body = await req.json() as { model: string; reasoning_effort?: string; max_completion_tokens?: number; messages: Array<{ content: string }> };
      seen.push({ model: body.model, effort: body.reasoning_effort, max: body.max_completion_tokens, auth: req.headers.get('authorization') });
      const text = JSON.stringify({ score: JSON.stringify(body.messages).includes('GOOD') ? 1 : 0 });
      return Response.json({ id: 'c', model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 100, completion_tokens: 5 } });
    } });
    const out = join(tmp, 'judge');
    mkdirSync(out, { recursive: true });
    const s = loadStored(roots, out), stored = storedTasks(s);
    try {
      const { run, stop } = await judgeInWindow({ tasks: stored.tasks, question: plain, out, logPath: join(out, 'judgments.ndjson'), keyless: `http://127.0.0.1:${upstream.port}`, window: null,
        lease: { ledger: join(tmp, 'judge-ledger.sqlite'), runId: 'bn10-rejudge-keyless', leaseUsd: 1, capUsd: 2, concurrency: 4 }, runner: 'bn10-rejudge' });
      expect([run.judged, run.remaining, run.request_errors, stop]).toEqual([41, 0, 0, null]);
    } finally { upstream.stop(true); }
    expect(seen.length).toBe(82);
    expect(new Set(seen.map(x => [x.model, x.effort, x.max].join('|')))).toEqual(new Set(['gpt-6.1-sol|medium|8000']));
    expect(seen.every(x => x.auth === 'Bearer keyless-not-a-provider-key')).toBe(true);
    const judged = readFileSync(join(out, 'judgments.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as JudgmentRecord);
    const a = rejudgeAggregates(s, stored, judged, true);
    expect(a.complete).toBe(true);
    for (const x of STORED_SETS) {
      const mine = stored.tasks.filter(t => stored.setOf.get(t.answer_id) === x.id), pass = mine.filter(t => t.text.endsWith(' GOOD')).length, pf = stored.sets[x.id].product_failures;
      expect([a.sets[x.id].judged, a.sets[x.id].scored, a.sets[x.id].remaining, a.sets[x.id].mean_judged]).toEqual([mine.length, mine.length, 0, Math.round(pass / mine.length * 1e4) / 1e4]);
      expect(a.sets[x.id].pass).toEqual({ k: pass, n: mine.length + pf, rate: Math.round(pass / (mine.length + pf) * 1e4) / 1e4, ci95: wilson(pass, mine.length + pf)!.map(v => Math.round(v * 1e4) / 1e4) });
    }
    const text = JSON.stringify(a);
    expect([SCHEDULED.some(q => text.includes(q.question_id)), stored.tasks.some(t => text.includes(t.answer_id)), /usd|spend|cost/i.test(text)]).toEqual([false, false, false]);
    const partial = rejudgeAggregates(s, stored, judged.slice(1), true);
    expect([partial.complete, Object.values(partial.sets).reduce((n, v) => n + v.remaining, 0)]).toEqual([false, 1]);
    expect(rejudgeAggregates(s, stored, judged.map(j => ({ ...j, settings: undefined })), true).complete).toBe(false);
  }, 30_000);

  // Value: protects=a custody --out holds only the pinned re-judge's judgments, so a GST-1365 out (default-effort Sol judgments under the same answer and instrument key) never stands in for it on resume; fails_when=a log with another judge's or other settings' judgments is resumed; why_new=BN10 custody re-judge; seam=checkOwnLog; no_claim=none
  test('a resume refuses a log that holds judgments made by another judge or at other settings', () => {
    const dir = join(tmp, 'own');
    mkdirSync(dir, { recursive: true });
    const log = join(dir, 'judgments.ndjson');
    expect(() => checkOwnLog(log)).not.toThrow();
    const j = { answer_id: sha256('a'), instrument_id: `beam-10m@${SOL}`, instrument_sha256: 'x', judge: SOL, judge_replicate: 0, temperature: null, score: 1, parse_ok: true, raw_sha256: 'r', outcome: 'scored' };
    writeFileSync(log, lines([{ ...j, settings: PINNED }]));
    expect(() => checkOwnLog(log)).not.toThrow();
    writeFileSync(log, lines([{ ...j, settings: PINNED }, j]));
    expect(refusal(() => checkOwnLog(log)).code).toBe('RESUME_REFUSED');
  });
});

describe('the command line', () => {
  const cli = (args: string[]) => {
    const r = Bun.spawnSync(['bun', 'eval/runner/q1/bn10-judges.ts', ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } });
    return { code: r.exitCode, text: r.stdout.toString() + r.stderr.toString() };
  };

  // Value: protects=the re-judge spends real keys only inside a granted paid window, refusing before any output, ledger or lease, and every rejudge subcommand runs the reproduction check on the receipts before it opens questions, a ledger or a lease; fails_when=rejudge-run reaches a provider or writes an out or a ledger outside a window, or the plan opens questions on receipts that do not reproduce the published contrasts; why_new=BN10 custody re-judge; seam=bn10-judges.ts rejudge-run/rejudge-plan; no_claim=the fixture receipts fail derive()'s schema check, so this shows the order, not a REPRODUCTION_FAILED message
  test('rejudge-run without a window exits 2 before any output; rejudge-plan runs the reproduction check first', () => {
    const out = join(tmp, 'cli-run'), ledger = join(tmp, 'cli-run.sqlite');
    const r = cli(['rejudge-run', ...roots.flatMap(x => ['--root', x]), '--out', out, '--budget-ledger', ledger, '--run-id', 'bn10-rejudge', '--lease-usd', '1', '--ledger-cap-usd', '2']);
    expect([r.code, r.text.includes('needs --paid-window'), existsSync(out), existsSync(ledger)]).toEqual([2, true, false, false]);
    const k = cli(['rejudge-run', ...roots.flatMap(x => ['--root', x]), '--out', out, '--keyless-upstream', 'http://127.0.0.1:9']);
    expect([k.code, k.text.includes('needs --budget-ledger'), existsSync(out)]).toEqual([2, true, false]);
    const planOut = join(tmp, 'cli-plan');
    const p = cli(['rejudge-plan', ...roots.flatMap(x => ['--root', x]), '--out', planOut]);
    expect([p.code !== 0, p.text.includes('RECEIPT_INVALID'), existsSync(join(planOut, 'judgments.ndjson')), existsSync(join(planOut, 'aggregates.json'))]).toEqual([true, true, false, false]);
  });

  // Value: protects=custody: a JSON parse error on a sealed file, which quotes its text, prints a fixed message, never the file's contents
  test('a parse error prints a fixed message, not the text that failed to parse', () => {
    const out = join(tmp, 'cli-parse');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'items.json'), 'SEALEDFRAGMENT {');
    const r = cli(['check-report', '--out', out]);
    expect([r.code, r.text.includes('SEALEDFRAGMENT'), r.text.includes('no custody data or embedded parser error is printed')]).toEqual([2, false, true]);
  });
});

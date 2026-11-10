/**
 * GST-1365's judge-robustness runner (eval/runner/q1/rejudge-systems.ts) over invented F6 and Q1 receipts: which
 * answers each frontier judge grades and which judgments are reused, the family rule, second-judge outs, the
 * reproduction check, the common cohort, the known-answer controls, the referee's frozen population, the identity
 * file, budget and STOP stops with their codes, the ceiling and reserve grant, the key preflight, every judge's route
 * through the real lease proxy including Gemini's, and the guard that keeps question ids out of reports.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetExceededError, closeLedgers, ledgerStatus } from '../../eval/runner/budget-ledger.ts';
import type { MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';
import { instrumentFor } from '../../eval/runner/memory-qa/instruments.ts';
import { ChatClient, type ChatLike, type ChatResult } from '../../eval/runner/memory-qa/qa-v2.ts';
import { answerRecord, RecordLog, sha256, type AnswerRecord, type JudgmentRecord } from '../../eval/runner/memory-qa/records.ts';
import { DEFAULT_ROUTE_CAPS, MeteringProxy } from '../../eval/runner/metering-proxy.ts';
import { metering } from '../../eval/runner/q1/cell.ts';
import { cohorts, questionView } from '../../eval/runner/q1/rejudge-rule.ts';
import { buildControls, CANONICAL, cellOf, cellValues, ceilingUsd, checkIdentity, checkWindowRoom, checkInstruments, checkPair, contrastResults, CONTRASTS, controlTasks, exitFor, frontierTasks, guardIds, isBudgetStop, judgeFor,
  judgeTasks, judgmentIndex, loadSources, OPUS, openLease, plan, preflightKeys, recordReuseCheck, refereePopulation, refereeSmoke, REFEREE, renderContrasts, reproduce, SOL, stopCode, tieLedger, unattempted, type Published,
  type Task } from '../../eval/runner/q1/rejudge-systems.ts';
import { ScoreboardError } from '../../eval/runner/q1/scoreboard-errors.ts';
import { DEFAULT_ROUTE_CLASSES } from '../../eval/runner/shootout-cell.ts';

const tmp = mkdtempSync(join(tmpdir(), 'q1-rejudge-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let saved: NodeJS.ProcessEnv = {};
beforeEach(() => { saved = { ...process.env }; });
afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); closeLedgers(); });

const SONNET = 'anthropic:claude-sonnet-5-5', READERS = [OPUS, SOL, SONNET];
const BENCH: Record<string, string> = { S1: 'beam-10m', S2b: 'beam-1m', S2a: 'beam-100k', D8: 'beam-d8' };
const SETS = Object.keys(BENCH);
const setOf = (cell: string) => SETS.find(s => cell.startsWith(`${s.toLowerCase()}.`))!;
const qid = (set: string, c: number, i: number) => `${set}-c${c}-q${i}`;
const scheduled = (set: string) => [0, 1, 2, 3].flatMap(c => [0, 1, 2].map(i => ({ question_id: qid(set, c, i), conversation: `${set}-c${c}` })));
const EXCLUDED = qid('S1', 3, 2);
const ANCHOR = 's1.gbrain-defaults.f6-master.p', EXTRACT = 's1.ext-extract-first.common.component-b8000';
const PRODUCT = { cell: 's1.baseline-file-agent.baseline.whole-agent', reader: OPUS, q: qid('S1', 0, 0), outcome: 'turn_cap' };
const HARNESS = { cell: EXTRACT, reader: SOL, q: qid('S1', 1, 1), outcome: 'reader_error' };
const hash = (s: string) => parseInt(sha256(s).slice(0, 8), 16);
const canonicalScore = (key: string) => (hash(`m|${key}`) % 3) / 2;
const frontierPass = (key: string) => hash(`f|${key}`) % 4 !== 0;
const fOf = (cell: string, reader: string, q: string) => (cell === PRODUCT.cell && reader === PRODUCT.reader && q === PRODUCT.q ? 0 : frontierPass(`${cell}|${reader}|${q}`) ? 1 : 0);
const judgment = (answer_id: string, instrument_id: string, instrument_sha256: string, judge: string, score: number): JudgmentRecord =>
  ({ answer_id, instrument_id, instrument_sha256, judge, judge_replicate: 0, temperature: 0, score, parse_ok: true, raw_sha256: sha256('raw'), outcome: 'scored' });
const lines = (xs: unknown[]) => xs.map(x => JSON.stringify(x) + '\n').join('');

/** One invented receipt: every cell the contrasts name, three readers, canonical judgments, and in F6 some frontier judgments (one reusable kind, two not). */
function publish(root: string, kind: 'f6' | 'q1') {
  const ids = [...new Set(CONTRASTS.filter(c => c.root === kind).flatMap(c => [c.anchor, c.other]))];
  const cells = ids.map(id => ({ cell_id: id, set: setOf(id), system: id.split('.')[1], readers: READERS, canonical_instrument: BENCH[setOf(id)], status: 'complete',
    ...(kind === 'q1' && id === EXTRACT ? { reader_replicates: { [SONNET]: 3 } } : {}) }));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'campaign.json'), JSON.stringify({ sets: SETS.map(id => ({ id, scheduled: scheduled(id), exclusions: id === 'S1' ? [{ question_id: EXCLUDED, reason: 'invented' }] : [] })), cells }));
  for (const c of cells) {
    const inst = instrumentFor(c.canonical_instrument), dir = join(root, 'cells', c.cell_id);
    mkdirSync(dir, { recursive: true });
    const answers: AnswerRecord[] = [], judgments: JudgmentRecord[] = [];
    for (const q of scheduled(c.set)) for (const reader of READERS) for (let rep = 0; rep < ((c as { reader_replicates?: Record<string, number> }).reader_replicates?.[reader] ?? 1); rep++) {
      const special = [PRODUCT, HARNESS].find(x => x.cell === c.cell_id && x.reader === reader && x.q === q.question_id && rep === 0);
      const a = answerRecord({ cell_id: c.cell_id, realization_id: 'r0', question_id: q.question_id, conversation: q.conversation, system: c.system, arm: 'component', reader, replicate: rep, effort: 'medium', context_sha256: sha256(`ctx|${c.cell_id}|${q.question_id}`) } as never,
        { text: `answer ${c.cell_id} ${reader} ${q.question_id}${frontierPass(`${c.cell_id}|${reader}|${q.question_id}`) ? ' FRONTIER-PASS' : ''}`, outcome: special?.outcome ?? 'scored', usage: { input: 10, output: 2, cache_read: 0, cache_write: 0 }, latency_ms: 5, provider_input_tokens: 10 } as never);
      answers.push(a);
      if (!special) judgments.push(judgment(a.answer_id, inst.id, inst.sha256, CANONICAL, canonicalScore(`${c.cell_id}|${reader}|${q.question_id}|${rep}`)));
      if (kind === 'f6' && c.cell_id === ANCHOR && rep === 0) {
        const pass = fOf(c.cell_id, reader, q.question_id);
        if (reader !== OPUS) judgments.push(judgment(a.answer_id, `${inst.id}@${SOL}`, inst.sha256, SOL, pass));
        else if (q.question_id === qid('S1', 0, 0)) judgments.push(judgment(a.answer_id, `${inst.id}@${SOL}`, 'stale-instrument-sha', SOL, pass));
      }
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

const question = (t: { question_id: string }): MemoryQuestion => ({ id: t.question_id, conversation: 'c', question: 'q?', category: 'information_extraction', gold: [], abstention: false, answer: 'gold', rubric: ['first item', 'second item'] });
const NO_META = { finish: null, usage: null, response_model: null, attempt_errors: [] as string[] };
/** A judge that passes an answer carrying FRONTIER-PASS on every rubric item; failWith(n) throws on call n. */
function scripted(failWith: (n: number) => Error | null = () => null): ChatLike & { calls: string[] } {
  const calls: string[] = [];
  return { calls, async chat(model, prompt): Promise<ChatResult> {
    calls.push(model);
    const e = failWith(calls.length);
    if (e) throw e;
    return { text: JSON.stringify({ score: prompt.includes('FRONTIER-PASS') ? 1 : 0 }), input_tokens: 10, output_tokens: 2, cached: false, ...NO_META };
  } };
}
const budgetRefusal = () => Object.assign(new Error('openai 402: {"kind":"budget","type":"budget","message":"metering proxy: refused before forwarding: the lease has no room"}'), { status: 402 });
const refusal = (fn: () => unknown) => { try { fn(); } catch (e) { if (e instanceof ScoreboardError) return e.op; throw e; } throw new Error('expected a refusal'); };
const refusalAsync = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { if (e instanceof ScoreboardError) return e.op; throw e; } throw new Error('expected a refusal'); };
const log = (out: string, name = 'judgments.ndjson') => { mkdirSync(out, { recursive: true }); return new RecordLog(join(out, name), 'judgment'); };

describe('what each frontier judge grades', () => {
  // Value: protects=GST-767's family rule and GST-605's particle rule for every judgment GST-1365 sends; fails_when=a reader's own family or particle-1 judges a row; why_new=new; seam=judgeFor/checkPair; no_claim=none
  test('gpt-6.1-sol grades Claude rows, claude-opus-5-5 grades gpt-6.1-sol rows; a same-family pair and particle are refused', () => {
    expect([judgeFor(OPUS), judgeFor(SONNET), judgeFor(SOL)]).toEqual([SOL, SOL, OPUS]);
    expect(refusal(() => judgeFor('particle:particle-1')).message).toContain('no frontier judge is preregistered');
    expect(refusal(() => checkPair(SOL, 'openai:gpt-6.1-sol')).message).toContain('would judge');
    expect(refusal(() => checkPair('particle:particle-1', null)).message).toContain('never judges');
    expect(() => checkPair(REFEREE, SOL)).not.toThrow();
  });

  // Value: protects=the census sends exactly the replicate-0 answers in each contrast's published cohort that lack a family-clean, same-instrument frontier judgment; fails_when=a product failure, an excluded or harness-failed question, a same-family or stale-instrument judgment, or a reusable one changes what is sent; why_new=new; seam=loadSources/frontierTasks; no_claim=none
  test('stratum A: 183 answers to judge, 11 reused, the product failure never sent, same-family and stale judgments not reused', () => {
    const s = loadSources(roots, join(tmp, 'tasks'));
    const t = frontierTasks(s, ['A'], null);
    expect([t.tasks.length, t.reusable, t.productFailures]).toEqual([183, 11, 1]);
    expect(t.byJudge).toEqual({ [SOL]: { needed: 129, reusable: 11, to_judge: 118 }, [OPUS]: { needed: 65, reusable: 0, to_judge: 65 } });
    expect(t.tasks.every(x => x.judge === judgeFor(x.reader!) && x.instrument_id === `beam-10m@${x.judge}` && x.instrument_sha256 === instrumentFor('beam-10m').sha256)).toBe(true);
    expect(t.tasks.some(x => x.question_id === EXCLUDED || (x.cell === EXTRACT && x.question_id === HARNESS.q))).toBe(false);
    expect(t.tasks.some(x => x.cell === PRODUCT.cell && x.reader === OPUS && x.question_id === PRODUCT.q)).toBe(false);
    expect(t.tasks.filter(x => x.cell === ANCHOR && x.reader === OPUS && x.question_id === qid('S1', 0, 0)).length).toBe(1);
    expect(t.tasks.filter(x => x.cell === ANCHOR && x.reader === SOL).length).toBe(11);
    expect(frontierTasks(s, ['A'], { through: 5, reason: 'r', at: 'now' }).tasks.length).toBe(183);
    expect(frontierTasks(s, ['C'], { through: 5, reason: 'r', at: 'now' }).tasks.every(x => x.set === 'S1')).toBe(true);
  });

  // Value: protects=d5, a paid second-judge out's judgments are reused and a keyless one is refused; fails_when=GBEV-35/39's paid judgments are judged again, or a rehearsal's fake scores count; why_new=autoplan finding F6; seam=loadSources roots; no_claim=none
  test('a paid second-judge out is reused; one whose marker or receipt is not keyless:false is refused (KEYLESS_SOURCE)', () => {
    const inst = instrumentFor('beam-10m');
    const anchor = cellOf(loadSources(roots, join(tmp, 'sj')), 'f6', ANCHOR);
    const out = (name: string, marker: unknown, receipt: unknown) => {
      const dir = join(tmp, name), cell = join(dir, 'cells', `${ANCHOR}.second-judge`);
      mkdirSync(cell, { recursive: true });
      if (marker) writeFileSync(join(dir, 'upstream.json'), JSON.stringify(marker));
      writeFileSync(join(cell, 'receipt.json'), JSON.stringify(receipt));
      writeFileSync(join(cell, 'judgments.ndjson'), lines(anchor.answers.filter(a => a.reader === OPUS).map(a => judgment(a.answer_id, `${inst.id}@${SOL}`, inst.sha256, SOL, 1))));
      return `second-judge=${dir}`;
    };
    const t = frontierTasks(loadSources([...roots, out('sj-paid', { keyless: false }, { keyless: false })], join(tmp, 'sj')), ['A'], null);
    expect([t.tasks.length, t.reusable]).toEqual([172, 22]);
    for (const bad of [out('sj-keyless', { keyless: true }, { keyless: true }), out('sj-nomarker', null, { keyless: false }), out('sj-noreceipt-flag', { keyless: false }, {})]) {
      expect(refusal(() => loadSources([...roots, bad], join(tmp, 'sj'))).message).toStartWith('KEYLESS_SOURCE');
    }
  });

  // Value: protects=an answer id names one answer: F6 reran Q1's S1 file agent under the same cell id, so the two receipts share answer ids (answerId hashes cell, question, reader and replicate) but not texts; fails_when=one receipt's frontier judgment scores the other's text, Q1's moved answers lose their judgments or canonical values, or answers both receipts hold verbatim are judged twice; why_new=custody found F6's S1 file-agent F reading Q1's frontier judgments; seam=loadSources; no_claim=none
  test('a Q1 answer whose id F6 uses for another text takes its own id with its judgments; verbatim-shared answers keep one id', () => {
    const q1x = join(tmp, 'q1x'), dir = join(q1x, 'cells', PRODUCT.cell), inst = instrumentFor('beam-10m');
    cpSync(q1, q1x, { recursive: true });
    const rerun = (a: AnswerRecord) => a.reader !== SOL && a.conversation !== 'S1-c2';
    const answers = readFileSync(join(dir, 'answers.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as AnswerRecord).map(a => (rerun(a) ? { ...a, text: `${a.text} Q1RUN` } : a));
    writeFileSync(join(dir, 'answers.ndjson'), lines(answers));
    writeFileSync(join(dir, 'judgments.ndjson'), readFileSync(join(dir, 'judgments.ndjson'), 'utf8') + lines(answers.filter(a => a.reader !== SOL && a.outcome === 'scored').map(a => judgment(a.answer_id, `${inst.id}@${SOL}`, inst.sha256, SOL, 0))));
    const s = loadSources([`f6=${f6}`, `q1=${q1x}`], join(tmp, 'ids'));
    const [F6c, Q1c] = [cellOf(s, 'f6', PRODUCT.cell), cellOf(s, 'q1', PRODUCT.cell)];
    const f6Id = new Map(F6c.answers.map(a => [`${a.question_id}|${a.reader}|${a.replicate}`, a.answer_id]));
    const moved = Q1c.answers.filter(a => a.answer_id !== f6Id.get(`${a.question_id}|${a.reader}|${a.replicate}`));
    expect([moved.length, moved.every(a => a.text.endsWith(' Q1RUN')), Q1c.answers.filter(a => a.text.endsWith(' Q1RUN')).length]).toEqual([18, true, 18]);
    const ids = new Set(Q1c.answers.map(a => a.answer_id));
    expect(Q1c.judgments.every(j => ids.has(j.answer_id))).toBe(true);
    const plain = loadSources(roots, join(tmp, 'ids')), M = (x: typeof s) => [...cellValues(x, cellOf(x, 'q1', PRODUCT.cell), judgmentIndex(x)).values()].map(q => questionView(q, 'M', READERS));
    expect(M(s)).toEqual(M(plain));
    const q1Extract = new Set(cellOf(s, 'q1', EXTRACT).answers.map(a => a.answer_id));
    expect(cellOf(s, 'f6', EXTRACT).answers.every(a => q1Extract.has(a.answer_id))).toBe(true);
    expect([frontierTasks(s, ['A'], null).tasks.length, frontierTasks(s, ['A'], null).reusable]).toEqual([177, 17]);
  });

  // Value: protects=the reuse check's consequence: a judge whose re-judged sample agrees below 95% has its old judgments judged again, while this run's own stay reused; fails_when=a failed check still reuses receipt or second-judge judgments, or discards the run's own; why_new=plan section 4 reuse check; seam=reuseResults/loadSources distrust; no_claim=none
  test('a failed reuse check for gpt-6.1-sol sends its 11 receipt judgments again; a passed one keeps them', () => {
    const write = (out: string, pass: boolean) => { mkdirSync(join(out, 'reuse-check'), { recursive: true }); writeFileSync(join(out, 'reuse-check', 'openai.json'), JSON.stringify({ judge: SOL, sample: 100, agreement: { share: pass ? 0.97 : 0.9, ci95: null }, bar: 0.95, pass })); };
    const failed = join(tmp, 'reuse-failed'), passed = join(tmp, 'reuse-passed');
    write(failed, false); write(passed, true);
    const s = loadSources(roots, failed);
    expect(s.distrust).toEqual([SOL]);
    expect([frontierTasks(s, ['A'], null).tasks.length, frontierTasks(s, ['A'], null).reusable]).toEqual([194, 0]);
    expect(frontierTasks(loadSources(roots, passed), ['A'], null).reusable).toBe(11);
  });

  // Value: protects=d4, no frontier number before the loader reproduces the published canonical cells and contrasts; fails_when=a perturbed derive(), a loader that disagrees with derive(), or a cell count off passes; why_new=autoplan finding; seam=reproduce with an injected derive(); no_claim=does not run scoreboard.ts's derive() on a real receipt (custody only)
  test('reproduction passes on matching values and refuses a perturbed derive(), a loader mismatch and a cell mismatch', () => {
    const s = loadSources(roots, join(tmp, 'repro'));
    const index = judgmentIndex(s);
    const board = (root: 'f6' | 'q1', bump = 0) => ({
      cells: [...s.cells.values()].filter(c => c.root === root).map(c => { const xs = [...cellValues(s, c, index).values()].map(q => questionView(q, 'M', c.def.readers)).filter((x): x is number => x !== null); return { cell_id: c.def.cell_id, valued: xs.length, mean: xs.reduce((a, b) => a + b, 0) / xs.length }; }),
      comparisons: CONTRASTS.filter(c => c.root === root).map(c => {
        const A = cellValues(s, cellOf(s, c.root, c.anchor), index), Bv = cellValues(s, cellOf(s, c.root, c.other), index);
        const coh = cohorts(A, Bv, READERS, scheduled(c.set).map(q => q.question_id));
        const delta = coh.published.reduce((x, q) => x + questionView(A.get(q), 'M', READERS)! - questionView(Bv.get(q), 'M', READERS)!, 0) / coh.published.length + (c.id === 'f6:s1.ext-extract-first.common.component-b8000' ? bump : 0);
        return { anchor: c.anchor, other: c.other, metric: 'answer', delta, ci95: [delta - 0.05, delta + 0.05] as [number, number], cohort: { paired: coh.published.length } };
      }),
    });
    const boards = { f6: board('f6'), q1: board('q1') };
    const pub = (b: typeof boards) => new Map([...b.f6.comparisons, ...b.q1.comparisons].map(x => [CONTRASTS.find(c => c.anchor === x.anchor && c.other === x.other && (c.root === 'f6') === b.f6.comparisons.includes(x))!.id, { delta: x.delta, ci95: x.ci95, cohort: x.cohort.paired } as Published]));
    const derive = (b: typeof boards) => (r: string) => (r === s.receipts.f6 ? b.f6 : b.q1);
    expect(reproduce(s, derive(boards), c => pub(boards).get(c.id)!)).toEqual({ cells: 28, contrasts: 21 });
    const bumped = { f6: board('f6', 0.004), q1: boards.q1 };
    expect(refusal(() => reproduce(s, derive(bumped), c => pub(boards).get(c.id)!)).message).toContain('REPRODUCTION_FAILED: f6:s1.ext-extract-first.common.component-b8000: derive() gives');
    const nudged = { f6: board('f6', 0.00002), q1: boards.q1 };
    expect(refusal(() => reproduce(s, derive(nudged), c => pub(nudged).get(c.id)!)).message).toContain('f6:s1.ext-extract-first.common.component-b8000: the loader gives');
    const cellOff = { f6: { ...boards.f6, cells: boards.f6.cells.map(c => (c.cell_id === ANCHOR ? { ...c, valued: c.valued + 1 } : c)) }, q1: boards.q1 };
    expect(refusal(() => reproduce(s, derive(cellOff), c => pub(boards).get(c.id)!)).message).toContain(`f6:${ANCHOR}: the loader gives 11 questions`);
  });
});

describe('judging, resume and stops', () => {
  // Value: protects=the census judges every planned answer once, Q1 reuses the competitor rows F6's strata already judged, and contrasts get Δ_F on one common cohort only where judged; fails_when=a shared answer is judged twice, Δ_F is computed on another cohort, or an unjudged stratum gets an outcome class; why_new=new; seam=judgeTasks/frontierTasks/contrastResults; no_claim=none
  test('stratum A judged: nothing left in A, Q1 S1 needs only its own gbrain rows, A contrasts get Δ_F and B stays INCOMPLETE', async () => {
    const out = join(tmp, 'census');
    const tasks = frontierTasks(loadSources(roots, out), ['A'], null).tasks;
    const client = scripted();
    const run = await judgeTasks(tasks, question, log(out), { client, concurrency: 4 });
    expect([run.judged, run.remaining, run.request_errors, client.calls.length]).toEqual([183, 0, 0, 366]);
    const s = loadSources(roots, out);
    expect(frontierTasks(s, ['A'], null).tasks.length).toBe(0);
    const c = frontierTasks(s, ['C'], null).tasks.filter(x => x.set === 'S1');
    expect([c.length, c.every(x => x.cell.startsWith('s1.gbrain-defaults.shipped-defaults.'))]).toEqual([66, true]);
    const r = contrastResults(s, null, ['B', 'C', 'D']);
    const extract = r.contrasts.find(x => x.id === 'f6:s1.ext-extract-first.common.component-b8000')!;
    const qs = scheduled('S1').map(q => q.question_id).filter(q => q !== EXCLUDED && q !== HARNESS.q);
    const mean = (cell: string, q: string) => READERS.reduce((a, rd) => a + fOf(cell, rd, q), 0) / 3;
    expect([extract.published_cohort, extract.common_cohort, extract.outcome === 'INCOMPLETE']).toEqual([10, 10, false]);
    expect(extract.F!.delta).toBeCloseTo(qs.reduce((a, q) => a + mean(ANCHOR, q) - mean(EXTRACT, q), 0) / qs.length, 6);
    expect(extract.levels!.anchor.F).toBeCloseTo(qs.reduce((a, q) => a + mean(ANCHOR, q), 0) / qs.length, 6);
    expect(extract.levels!.other.F).toBeCloseTo(qs.reduce((a, q) => a + mean(EXTRACT, q), 0) / qs.length, 6);
    expect(Object.keys(extract.per_reader).sort()).toEqual([...READERS].sort());
    expect(extract.K).toBeNull();
    expect(r.contrasts.filter(x => x.family === 'F6' && x.set === 'S2b').every(x => x.outcome === 'INCOMPLETE')).toBe(true);
    expect(r.families.F6).toBe('INCOMPLETE');
    const cut = contrastResults(s, { through: 4, reason: 'projection', at: 'now' });
    expect([cut.families.D8, cut.contrasts.filter(x => x.family === 'D8').every(x => x.outcome === 'NOT RUN (CUT ORDER)')]).toEqual(['NOT RUN (CUT ORDER)', true]);
  });

  // Value: protects=F10's stop codes: a budget refusal ends the run partial as LEASE_EXHAUSTED or, near the $850 ceiling, CEILING_REACHED, a resume sends only what is left, the STOP file stops, and a request that may have been billed is not sent again in the same invocation; fails_when=a budget stop reads as an error, a resume resends, the codes or exits drift, or a may-have-billed request is resent; why_new=autoplan finding F10; seam=judgeTasks/stopCode/exitFor/isBudgetStop; no_claim=none
  test('budget stop, resume, STOP file, may-have-billed hold and the exit codes', async () => {
    const out = join(tmp, 'stops');
    const tasks = frontierTasks(loadSources(roots, out), ['A'], null).tasks;
    const first = tasks.slice(0, 10);
    const run = await judgeTasks(first, question, log(out), { client: scripted(n => (n === 5 ? budgetRefusal() : null)), concurrency: 1 });
    expect([run.budget_stop, run.judged, run.remaining, run.request_errors]).toEqual([true, 2, 8, 0]);
    expect([stopCode(run, 10, 850), exitFor(stopCode(run, 10, 850), run.remaining)]).toEqual(['LEASE_EXHAUSTED', 4]);
    expect([stopCode(run, 849.5, 850), exitFor(stopCode(run, 849.5, 850), run.remaining)]).toEqual(['CEILING_REACHED', 5]);
    const again = scripted();
    const resumed = await judgeTasks(first, question, log(out), { client: again, concurrency: 1 });
    expect([resumed.judged, resumed.remaining, again.calls.length, stopCode(resumed, 10, 850), exitFor(null, 0)]).toEqual([8, 0, 16, null, 0]);
    const lost = scripted(() => Object.assign(new Error('socket connection was closed unexpectedly'), { code: 'ECONNRESET' }));
    const heldRun = await judgeTasks(tasks.slice(10, 13), question, log(out), { client: lost, concurrency: 1 });
    expect([heldRun.held, heldRun.remaining, lost.calls.length]).toEqual([3, 3, 3]);
    const flaky = scripted(() => Object.assign(new Error('openai 500: upstream budget service unavailable'), { status: 500 }));
    const retried = await judgeTasks(tasks.slice(10, 13), question, log(out), { client: flaky, concurrency: 1 });
    expect([retried.budget_stop, retried.held, retried.request_errors, flaky.calls.length]).toEqual([false, 0, 9, 9]);
    writeFileSync(join(out, 'STOP'), '');
    const stopped = await judgeTasks(tasks.slice(13, 16), question, log(out), { client: scripted(), stopFile: join(out, 'STOP') });
    expect([stopped.stop_file, stopped.judged, stopCode(stopped, 0, 850), exitFor('STOPPED', 3)]).toEqual([true, 0, 'STOPPED', 4]);
    expect([isBudgetStop(new BudgetExceededError('budget: lease')), isBudgetStop(Object.assign(new Error('anthropic 502: {"kind":"budget","type":"budget","message":"metering proxy: x"}'), { status: 502 })),
      isBudgetStop(Object.assign(new Error('openai 500: over budget'), { status: 500 })), isBudgetStop(new Error('budget: plain'))]).toEqual([true, true, false, false]);
  });

  // Value: protects=the identity file refuses a resume onto other answers, texts, judges or instruments; fails_when=a resume with other roots or another tree mixes two populations; why_new=new; seam=checkIdentity; no_claim=none
  test('the identity file pins a stage', () => {
    const s = loadSources(roots, join(tmp, 'identity'));
    const tasks = frontierTasks(s, ['A'], null).tasks, path = join(tmp, 'identity-A.json');
    checkIdentity(path, tasks, false);
    expect(existsSync(path)).toBe(false);
    const id = checkIdentity(path, tasks);
    expect(checkIdentity(path, [...tasks].reverse())).toBe(id);
    expect(refusal(() => checkIdentity(path, tasks.slice(1))).code).toBe('RESUME_REFUSED');
    expect(refusal(() => checkIdentity(path, tasks.map((t, i) => (i ? t : { ...t, text: `${t.text}!` })))).code).toBe('RESUME_REFUSED');
    expect(refusal(() => checkIdentity(path, tasks.map((t, i) => (i ? t : { ...t, instrument_sha256: 'other' })))).code).toBe('RESUME_REFUSED');
  });

  // Value: protects=the referee judges a frozen population: every disagreement and a seeded 600-answer agreement sample, only after its strata are complete or cut, while the smoke's seeded referee sample needs no census; fails_when=the referee runs on a partial census, misses a disagreement, samples differently on a rerun, includes cut strata, or the smoke cannot measure Gemini first; why_new=autoplan finding F16; seam=refereePopulation; no_claim=none
  test('the referee refuses a partial census, then takes every disagreement and min(600, agreements), the same each time', async () => {
    const out = join(tmp, 'referee');
    expect(refusal(() => refereePopulation(loadSources(roots, out), null)).message).toContain('frontier judgments are still missing');
    const smoke = refereeSmoke(loadSources(roots, out), 20, null);
    expect([smoke.length, smoke.every(t => t.judge === REFEREE), new Set(smoke.map(t => t.set)).size, new Set(smoke.map(t => t.answer_id)).size]).toEqual([20, true, 4, 20]);
    expect(refereeSmoke(loadSources(roots, out), 20, null)).toEqual(smoke);
    const all = frontierTasks(loadSources(roots, out), ['A', 'B', 'C', 'D'], null);
    const run = await judgeTasks(all.tasks, question, log(out), { client: scripted(), concurrency: 8 });
    expect(run.remaining).toBe(0);
    const s = loadSources(roots, out);
    const pop = refereePopulation(s, null);
    const rows = all.tasks.length + all.reusable;
    expect(pop.disagreements.length).toBeGreaterThan(0);
    expect(pop.agreements.length).toBe(Math.min(600, rows - pop.disagreements.length));
    expect(pop.tasks.length).toBe(pop.disagreements.length + pop.agreements.length);
    expect(pop.disagreements.some(id => pop.agreements.includes(id))).toBe(false);
    expect(pop.tasks.every(t => t.judge === REFEREE && t.instrument_id === `${BENCH[t.set]}@${REFEREE}`)).toBe(true);
    expect(refereePopulation(s, null)).toEqual(pop);
    const cut = refereePopulation(s, { through: 3, reason: 'projection', at: 'now' });
    expect(cut.tasks.some(t => t.set === 'D8' || t.set === 'S2a')).toBe(false);
  });

  // Value: protects=the preregistration's judge-error rule: a judgment still unparsable after three attempts is final and unscored, is never asked again, leaves no stratum partial, and the referee still runs on the pairs with both scores; fails_when=a logged judge_error counts as missing forever, so the referee refuses and every family resting on its stratum reads INCOMPLETE; why_new=/ship review finding (red team, judge_error); seam=judgeTasks/unattempted/refereePopulation; no_claim=none
  test('a judge_error is final: never asked again, no stratum left partial, and the referee still runs', async () => {
    const out = join(tmp, 'judge-error');
    const all = frontierTasks(loadSources(roots, out), ['A', 'B', 'C', 'D'], null);
    const target = all.tasks[0];
    let garbledCalls = 0;
    const garbled: ChatLike = { async chat(): Promise<ChatResult> { garbledCalls++; return { text: 'no verdict here', input_tokens: 10, output_tokens: 2, cached: false, ...NO_META }; } };
    const failed = await judgeTasks([target], question, log(out), { client: garbled });
    expect([failed.judged, failed.remaining, failed.request_errors, garbledCalls]).toEqual([1, 0, 0, 3]);
    const rest = scripted();
    const run = await judgeTasks(all.tasks, question, log(out), { client: rest, concurrency: 8 });
    expect([run.judged, run.remaining]).toEqual([all.tasks.length - 1, 0]);
    const s = loadSources(roots, out);
    expect(s.own.find(j => j.answer_id === target.answer_id)?.outcome).toBe('judge_error');
    const left = frontierTasks(s, ['A', 'B', 'C', 'D'], null).tasks;
    expect([left.map(t => t.answer_id), unattempted(s, left)]).toEqual([[target.answer_id], []]);
    const pop = refereePopulation(s, null);
    expect([pop.disagreements.length > 0, pop.tasks.some(t => t.answer_id === target.answer_id)]).toEqual([true, false]);
  });

  // Value: protects=a reuse check whose sample holds a judge_error still writes its result, the judge_error counted as a disagreement, so the census is never blocked for good; fails_when=a judge_error keeps the result file from being written, or counts as an agreement; why_new=/ship review finding (red team, judge_error); seam=recordReuseCheck; no_claim=none
  test('a reuse check that holds a judge_error still writes its result, counting it as a disagreement', () => {
    const out = join(tmp, 'reuse-error');
    const tasks = frontierTasks(loadSources(roots, out), ['A'], null).tasks.filter(t => t.judge === SOL).slice(0, 100);
    const prior = Object.fromEntries(tasks.map(t => [t.answer_id, true]));
    const reuse = log(join(out, 'reuse-check'), 'openai.ndjson'), file = join(out, 'reuse-check', 'openai.json');
    tasks.forEach((t, i) => {
      const j = judgment(t.answer_id, t.instrument_id, t.instrument_sha256, SOL, 1);
      reuse.append(i ? j : { ...j, score: null, parse_ok: false, outcome: 'judge_error' });
    });
    recordReuseCheck(out, SOL, tasks, prior, 1);
    expect([tasks.length, existsSync(file)]).toEqual([100, false]);
    const result = recordReuseCheck(out, SOL, tasks, prior, 0);
    expect([result.sample, result.agreement.share, result.pass]).toEqual([100, 0.99, true]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(result);
  });
});

describe('known-answer controls (d6)', () => {
  const CATS = ['information_extraction', 'multi_session_reasoning', 'event_ordering', 'abstention'];
  const controlQuestions = (set: string): MemoryQuestion[] => [0, 1, 2, 3].flatMap(c => Array.from({ length: 20 }, (_, i) => ({
    id: `${set}-k${c}-${i}`, conversation: `${set}-k${c}`, question: 'q?', category: CATS[i % 4], gold: [], abstention: CATS[i % 4] === 'abstention',
    answer: i === 4 ? `Gold ${set}-k${c}-0!` : `gold ${set}-k${c}-${i}`, ...(set === 'D8' ? {} : { rubric: ['item'] }) })));
  const questions = { S1: controlQuestions('S1'), S2b: controlQuestions('S2b'), D8: controlQuestions('D8') };
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  // Value: protects=the 600 control answers and their known verdicts, with C2's abstention fix and the duplicate-gold skip; fails_when=a control is nondeterministic, drops D8 (its questions carry no rubric items, so its instrument scores the gold answer), includes event_ordering, gives a C2 equal to the question's own gold, draws an abstention question's C2 from another abstention question, or scores C3 wrong; why_new=autoplan finding (d6); seam=buildControls; no_claim=none
  test('50 questions per set, four controls each, deterministic, C2 never the own gold and never from an abstention question', () => {
    const b = buildControls(questions);
    expect(buildControls(questions)).toEqual(b);
    const byQ = new Map(Object.values(questions).flat().map(q => [q.id, q]));
    for (const set of ['S1', 'S2b', 'D8']) expect(new Set(b.answers.filter(a => a.set === set).map(a => a.question_id)).size).toBe(50);
    expect(b.answers.some(a => byQ.get(a.question_id)!.category === 'event_ordering')).toBe(false);
    for (const a of b.answers) {
      const q = byQ.get(a.question_id)!;
      if (a.control === 'C1') expect([a.text, a.expected]).toEqual([q.answer!, 'pass']);
      if (a.control === 'C3') expect(a.expected).toBe(q.abstention ? 'pass' : 'fail');
      if (a.control === 'C4') expect([a.text.includes(q.answer!), a.expected]).toEqual([true, 'pass']);
      if (a.control !== 'C2') continue;
      const from = Object.values(questions).flat().find(o => o.answer === a.text && o.id !== q.id)!;
      expect([norm(a.text) !== norm(q.answer!), from.conversation === q.conversation, from.abstention, q.abstention || from.category === q.category, a.expected]).toEqual([true, true, false, true, 'fail']);
    }
    expect(b.c2_skipped).toBe(0);
    expect(b.c2_abstention).toBe(b.answers.filter(a => a.control === 'C2' && byQ.get(a.question_id)!.abstention).length);
    expect(b.c2_abstention).toBeGreaterThan(0);
    expect(b.answers.length).toBe(600);
  });

  // Value: protects=all four judges judge every control under each set's canonical instrument, and cut step 1 drops Opus and Gemini to 25 questions per set; fails_when=a judge is missing, an instrument id or sha drifts, or the cut drops the wrong judges; why_new=new; seam=controlTasks; no_claim=none
  test('four judges per control answer, under the set instrument; cut step 1 leaves Opus and Gemini 25 questions per set', () => {
    const s = loadSources(roots, join(tmp, 'controls'));
    const b = buildControls(questions);
    const full = controlTasks(s, b.answers, () => false, null);
    expect(full.length).toBe(2400);
    const t = (judge: string, set: string) => full.find(x => x.judge === judge && x.set === set)!;
    expect([t(CANONICAL, 'S1').instrument_id, t(REFEREE, 'S2b').instrument_id, t(OPUS, 'D8').instrument_sha256]).toEqual(['beam-10m', `beam-1m@${REFEREE}`, instrumentFor('beam-d8').sha256]);
    const cut = controlTasks(s, b.answers, () => false, { through: 1, reason: 'projection', at: 'now' });
    for (const set of ['S1', 'S2b', 'D8']) {
      expect(new Set(cut.filter(x => x.judge === OPUS && x.set === set).map(x => x.question_id)).size).toBe(25);
      expect(new Set(cut.filter(x => x.judge === SOL && x.set === set).map(x => x.question_id)).size).toBe(50);
    }
    expect(cut.length).toBe(1200 + 600);
  });
});

describe('money, keys and the proxy', () => {
  // Value: protects=d7's pinned $850 ceiling and GBEV-3's reserve; fails_when=a lease passes the ceiling, a grant exceeds $250 or lacks words, or the refusal is not CEILING_REACHED; why_new=autoplan finding F9/F12; seam=ceilingUsd/openLease; no_claim=none
  test('the ceiling is $850, a reserve grant raises it to at most $1,100, and a lease past it is refused as CEILING_REACHED', () => {
    expect([ceilingUsd(null), ceilingUsd({ usd: 250, words: 'release the reserve (GBEV-3)' })]).toEqual([850, 1100]);
    expect(refusal(() => ceilingUsd({ usd: 251, words: 'x' })).message).toContain('at most $250');
    expect(refusal(() => ceilingUsd({ usd: 10, words: ' ' })).code).toBe('USAGE');
    const ledgerPath = join(tmp, 'ledger.sqlite');
    openLease({ runId: 'gst-1365-smoke', leaseUsd: 5, ledgerPath, ceiling: 850 }).close();
    expect(ledgerStatus({ ledgerPath, runId: 'gst-1365-smoke' }).run?.runner).toBe('gst-1365-rejudge');
    const op = refusal(() => openLease({ runId: 'gst-1365-census-a', leaseUsd: 851, ledgerPath, ceiling: 850 }));
    expect([op.code, op.message.startsWith('CEILING_REACHED')]).toEqual(['BUDGET_CAP', true]);
    openLease({ runId: 'gst-1365-census-a', leaseUsd: 851, ledgerPath, ceiling: 1100 }).close();
  });

  // Value: protects=GST-1969: the paid stages and reruns under one granted window spend at most its cap together, from any out on the ledger, and a crashed stage resumes its own lease; fails_when=a second lease under the same window ignores what the first spent, the window's record lives anywhere but beside the ledger (a fresh --out would restart its count), a resumed open lease counts its spend twice, a window's cap changes between stages, or another window inherits the first one's spend; why_new=/ship red team and Step 11 voices on #409: the window guard checked each lease alone, then kept its record in the out; seam=checkWindowRoom; no_claim=the CLI wiring (paid-window-guard.test.ts covers the guard before it)
  test('the leases under one paid window share its cap, counted on the ledger from its spend when the window first ran', () => {
    const ledgerPath = join(tmp, 'window-ledger.sqlite');
    const w = { unit: 'TEST-WINDOW-1', cap_usd: 10 };
    checkWindowRoom(w, ledgerPath, 'gst-1365-w1', 6);
    expect(existsSync(`${ledgerPath}.window-TEST-WINDOW-1.json`)).toBe(true);
    const first = openLease({ runId: 'gst-1365-w1', leaseUsd: 6, ledgerPath, ceiling: 850 });
    first.settle(first.reserve(6, 'judge'), { usd: 6 });
    first.close();
    const spent = refusal(() => checkWindowRoom(w, ledgerPath, 'gst-1365-w2', 5));
    expect([spent.code, spent.message.startsWith('WINDOW_SPENT')]).toEqual(['USAGE', true]);
    checkWindowRoom(w, ledgerPath, 'gst-1365-w2', 4);
    const crashed = openLease({ runId: 'gst-1365-w2', leaseUsd: 4, ledgerPath, ceiling: 850 });
    crashed.settle(crashed.reserve(1, 'judge'), { usd: 1 });
    checkWindowRoom(w, ledgerPath, 'gst-1365-w2', 4);
    expect(refusal(() => checkWindowRoom(w, ledgerPath, 'gst-1365-w3', 4)).message).toMatch(/^WINDOW_SPENT/);
    crashed.close();
    expect(refusal(() => checkWindowRoom({ ...w, cap_usd: 20 }, ledgerPath, 'gst-1365-w3', 1)).message).toContain('with a cap of $10, not $20');
    checkWindowRoom({ unit: 'TEST-WINDOW-2', cap_usd: 10 }, ledgerPath, 'gst-1365-w3', 10);
  });

  // Value: protects=a missing or dead judge key stops before any lease as KEY_MISSING, naming the variable and never its value; fails_when=a missing key reads as a budget stop, or a key value is printed; why_new=autoplan finding F10; seam=preflightKeys with a fake fetch; no_claim=does not call the live model listings
  test('KEY_MISSING for an unset key or a refused listing, never printing the key', async () => {
    const seen: string[] = [];
    const ok = (async (url: string) => { seen.push(String(url)); return new Response('{}', { status: String(url).includes('googleapis') ? 401 : 200 }); }) as unknown as typeof fetch;
    const unset = await refusalAsync(() => preflightKeys([SOL], {}, ok));
    expect([unset.code, unset.message]).toEqual(['KEY_MISSING', `KEY_MISSING: OPENAI_API_KEY for ${SOL}: not set`]);
    const env = { OPENAI_API_KEY: 'sk-secret-openai', ANTHROPIC_API_KEY: 'sk-secret-anthropic', GEMINI_API_KEY: 'secret-gemini' };
    const dead = await refusalAsync(() => preflightKeys([SOL, OPUS, REFEREE, SOL], env, ok));
    expect(dead.message).toBe(`KEY_MISSING: GEMINI_API_KEY for ${REFEREE}: its free model listing answered 401`);
    expect(JSON.stringify(dead)).not.toContain('secret');
    expect(seen).toEqual(['https://api.anthropic.com/v1/models/claude-opus-5-5', 'https://generativelanguage.googleapis.com/v1beta/openai/models/gemini-4-argon']);
    seen.length = 0;
    await preflightKeys([SOL, OPUS], env, ok);
    expect(seen.sort()).toEqual(['https://api.anthropic.com/v1/models/claude-opus-5-5', 'https://api.openai.com/v1/models/gpt-6.1-sol']);
  });

  // Value: protects=d7's one ledger per out: a paid subcommand on an out that already spent on one ledger refuses any other ledger path; fails_when=a mistyped or relative --budget-ledger starts a fresh $850 ceiling for the same out; why_new=/ship review finding (red team, ledger tie); seam=tieLedger; no_claim=none
  test('an out is tied to its first ledger, and another ledger path is refused', () => {
    const out = join(tmp, 'tie'), first = join(tmp, 'tie-ledger.sqlite'), other = join(tmp, 'other-ledger.sqlite');
    mkdirSync(out, { recursive: true });
    tieLedger(out, first);
    tieLedger(out, first);
    expect(JSON.parse(readFileSync(join(out, 'ledger-tie.json'), 'utf8'))).toEqual({ ledger: first });
    const op = refusal(() => tieLedger(out, other));
    expect([op.code, op.message]).toEqual(['USAGE', `${out} spends on the ledger ${first}, not ${other}`]);
  });

  // Value: protects=a ledger kept in the out itself still holds the ceiling: the tie never lands in the budget ledger's legacy slot (<out>/ledger.json beside <out>/ledger.sqlite); fails_when=tying <out>/ledger.sqlite writes <out>/ledger.json and every lease on that out refuses as an unreadable ledger; why_new=/ship review finding (native adversarial, tie in the legacy slot); seam=tieLedger then openLease; no_claim=none
  test('a ledger at <out>/ledger.sqlite is tied without touching its legacy slot, and its lease opens', () => {
    const out = join(tmp, 'tie-in-out'), ledger = join(out, 'ledger.sqlite');
    mkdirSync(out, { recursive: true });
    tieLedger(out, ledger);
    expect([existsSync(join(out, 'ledger.json')), JSON.parse(readFileSync(join(out, 'ledger-tie.json'), 'utf8'))]).toEqual([false, { ledger }]);
    const lease = openLease({ runId: 'gst-1365-tie-in-out', leaseUsd: 1, ledgerPath: ledger, ceiling: 850 });
    lease.close();
  });

  // Value: protects=the tie is created exclusively and validated, never replaced: a start that finds a tie it did not write (another first start's, still empty, or a file with no ledger path) refuses instead of writing its own; fails_when=a second first start overwrites the tie and opens a second $850 ceiling, or a tombstone at the tie path is overwritten; why_new=/ship review finding (outside voice, tie race); seam=tieLedger; no_claim=does not race two processes
  test('a tie with no string ledger is refused and left as it was', () => {
    const out = join(tmp, 'tie-bad'), ledger = join(tmp, 'tie-bad-ledger.sqlite'), tie = join(out, 'ledger-tie.json');
    mkdirSync(out, { recursive: true });
    for (const text of ['', '{"schema":1}\n', 'null\n', '{"ledger":7}\n']) {
      writeFileSync(tie, text);
      const op = refusal(() => tieLedger(out, ledger));
      expect([op.code, op.message, readFileSync(tie, 'utf8')]).toEqual(['USAGE', `${tie} names no ledger`, text]);
    }
  });

  // Value: protects=a Sol or Opus judge request that may have reached its provider (the proxy's 504 on an upstream timeout) is sent once, as a Gemini or Particle request is; fails_when=qa-v2's chat client resends it up to five times, each attempt charged its reservation; why_new=/ship review finding (testing specialist, money-retry); seam=ChatClient holdMayHaveBilled through MeteringProxy; no_claim=does not call a live provider
  test('a Sol judge request the proxy answers 504 is sent once with holdMayHaveBilled, five times without it', async () => {
    const out = join(tmp, 'hold');
    const claude = frontierTasks(loadSources(roots, out), ['A'], null).tasks.find(t => t.judge === SOL)!;
    let sends = 0;
    const fetchImpl = (async () => { sends++; throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }); }) as unknown as typeof fetch;
    mkdirSync(out, { recursive: true });
    const lease = openLease({ runId: 'gst-1365-hold', leaseUsd: 5, ledgerPath: join(tmp, 'hold-ledger.sqlite'), ceiling: 850 });
    const proxy = new MeteringProxy({ fetchImpl, policy: { lease, usageLog: join(out, 'usage.ndjson'), env: { OPENAI_API_KEY: 'dummy', ANTHROPIC_API_KEY: 'dummy', GEMINI_API_KEY: 'dummy-gemini' },
      routeCaps: { caps: { ...DEFAULT_ROUTE_CAPS }, slots: { ...DEFAULT_ROUTE_CLASSES }, defaultClass: 'extraction' } } });
    proxy.start();
    try {
      const meter = metering(`http://127.0.0.1:${proxy.port}`, { meter: () => {} }, process.env);
      const around = (key: string, fn: () => Promise<unknown>) => meter.around('judge', key, 'judge', fn);
      const held = await judgeTasks([claude], question, log(join(out, 'held')), { client: new ChatClient(join(out, 'cache-held'), () => 0, undefined, { holdMayHaveBilled: true }), around });
      expect([held.held, held.remaining, sends]).toEqual([1, 1, 1]);
      sends = 0;
      const resent = await judgeTasks([claude], question, log(join(out, 'resent')), { client: new ChatClient(join(out, 'cache-resent'), () => 0), around });
      expect([resent.held, resent.remaining, sends]).toEqual([1, 1, 5]);
    } finally { proxy.stop(); lease.close(); }
  });

  // Value: protects=a judgment is sent only under the instrument the canonical judgment used; fails_when=a tree whose instrument hash moved judges answers whose reuse key it can never meet; why_new=new; seam=checkInstruments; no_claim=none
  test('a task whose receipt instrument is not this tree\'s is refused', () => {
    const tasks = frontierTasks(loadSources(roots, join(tmp, 'inst')), ['A'], null).tasks;
    expect(() => checkInstruments(tasks)).not.toThrow();
    expect(refusal(() => checkInstruments([{ ...tasks[0], instrument_sha256: 'older' }])).message).toContain('beam-10m');
  });

  // Value: protects=d1/d2, every judge's requests go through the lease proxy on the judge slot to the right upstream, Gemini on its OpenAI-compatible route at its 8,192-token floor with no temperature, settled from usage with thinking counted, and a Gemini request lost mid-flight is answered 504 and never sent again; fails_when=a judge bypasses the proxy, Gemini is clamped to 2,048 tokens or sent a temperature, its thinking is unbilled, or a may-have-billed request is resent; why_new=new; seam=judgeTasks through MeteringProxy with a fake upstream; no_claim=does not call a live provider (the paid smoke checks F8)
  test('Sol, Opus and Gemini through the lease proxy; Gemini at its floor, billed for thinking, and a lost Gemini request never resent', async () => {
    const s = loadSources(roots, join(tmp, 'route'));
    const a = frontierTasks(s, ['A'], null).tasks;
    const claude = a.find(t => t.judge === SOL)!, sol = a.find(t => t.judge === OPUS)!;
    const referee = (t: Task): Task => ({ ...t, judge: REFEREE, instrument_id: `beam-10m@${REFEREE}` });
    const sent: Array<{ host: string; path: string; body: Record<string, unknown> }> = [];
    let fault: Error | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const u = new URL(String(url)), body = JSON.parse(String(init.body));
      sent.push({ host: u.hostname, path: u.pathname, body });
      const text = JSON.stringify({ score: JSON.stringify(body).includes('FRONTIER-PASS') ? 1 : 0 });
      if (u.hostname === 'api.anthropic.com') return Response.json({ id: 'm', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 5 } });
      if (u.hostname === 'generativelanguage.googleapis.com' && fault) throw fault;
      return Response.json({ id: 'c', model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
        usage: u.hostname === 'generativelanguage.googleapis.com' ? { prompt_tokens: 100, completion_tokens: 5, total_tokens: 905 } : { prompt_tokens: 100, completion_tokens: 5 } });
    }) as unknown as typeof fetch;
    const out = join(tmp, 'route'), usageLog = join(out, 'usage.ndjson');
    mkdirSync(out, { recursive: true });
    const lease = openLease({ runId: 'gst-1365-route', leaseUsd: 5, ledgerPath: join(tmp, 'route-ledger.sqlite'), ceiling: 850 });
    const proxy = new MeteringProxy({ fetchImpl, policy: { lease, usageLog, env: { OPENAI_API_KEY: 'dummy', ANTHROPIC_API_KEY: 'dummy', GEMINI_API_KEY: 'dummy-gemini' },
      routeCaps: { caps: { ...DEFAULT_ROUTE_CAPS, 'judge@gemini:gemini-4-argon': 8192 }, slots: { ...DEFAULT_ROUTE_CLASSES }, defaultClass: 'extraction' } } });
    proxy.start();
    try {
      const meter = metering(`http://127.0.0.1:${proxy.port}`, { meter: () => {} }, process.env);
      const around = (key: string, fn: () => Promise<unknown>) => meter.around('judge', key, 'judge', fn);
      const run = await judgeTasks([claude, sol, referee(claude)], question, log(out), { client: new ChatClient(join(out, 'cache')), around, concurrency: 3 });
      expect([run.judged, run.remaining, run.request_errors, run.last_error]).toEqual([3, 0, 0, null]);
      const by = (host: string) => sent.filter(x => x.host === host);
      expect(by('api.openai.com').map(x => [x.path, x.body.model])).toEqual(Array(2).fill(['/v1/chat/completions', 'gpt-6.1-sol']));
      expect(by('api.anthropic.com').map(x => [x.path, x.body.model])).toEqual(Array(2).fill(['/v1/messages', 'claude-opus-5-5']));
      expect(by('generativelanguage.googleapis.com').map(x => [x.path, x.body.model, x.body.max_completion_tokens, 'temperature' in x.body])).toEqual(Array(2).fill(['/v1beta/openai/chat/completions', 'gemini-4-argon', 8192, false]));
      const usage = readFileSync(usageLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
      expect(usage.map(u => [u.slot, u.outcome]).every(([slot, o]) => slot === 'judge' && o === 'forwarded')).toBe(true);
      const gemini = usage.filter(u => u.provider === 'gemini');
      expect(gemini.length).toBe(2);
      for (const u of gemini) expect(u.actual_usd).toBeCloseTo((100 * 4 + 805 * 20) / 1e6, 9);
      fault = Object.assign(new Error('socket connection was closed unexpectedly'), { code: 'ECONNRESET' });
      const before = by('generativelanguage.googleapis.com').length;
      const other = a.find(t => t.judge === SOL && t.answer_id !== claude.answer_id)!;
      const lost = await judgeTasks([referee(other)], question, log(out), { client: new ChatClient(join(out, 'cache')), around });
      expect([lost.judged, lost.held, lost.remaining, by('generativelanguage.googleapis.com').length - before]).toEqual([0, 1, 1, 1]);
    } finally { proxy.stop(); lease.close(); }
  });
});

describe('the command line', () => {
  const cli = (args: string[]) => {
    const r = Bun.spawnSync(['bun', 'eval/runner/q1/rejudge-systems.ts', ...args], { cwd: join(import.meta.dir, '..', '..'), env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } });
    return { code: r.exitCode, text: r.stdout.toString() + r.stderr.toString() };
  };

  // Value: protects=preregistration section 7: cuts are made before any census lease, while the smoke and the reuse checks, which pin no census, leave the cut open; fails_when=a contrast is cut after its census began, or a reuse check blocks the cut it informs; why_new=/ship review finding (red team, cut order); seam=rejudge-systems.ts cut; no_claim=none
  test('cut refuses once a census identity file exists, and not after a reuse check', () => {
    const out = join(tmp, 'cut-cli');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'identity-reuse-openai.json'), '{}');
    expect(cli(['cut', '--through', '1', '--reason', 'projection', '--out', out]).code).toBe(0);
    writeFileSync(join(out, 'identity-B.json'), '{}');
    const refused = cli(['cut', '--through', '2', '--reason', 'projection', '--out', out]);
    expect([refused.code !== 0, refused.text.includes('the census of stratum B has begun')]).toEqual([true, true]);
    expect(JSON.parse(readFileSync(join(out, 'cuts.json'), 'utf8')).through).toBe(1);
  });

  // Value: protects=a failed reproduction costs nothing: a paid subcommand runs the reproduction check (scoreboard.ts's derive() on each receipt) before its key preflight, its ledger and its lease; fails_when=a paid stage opens a lease or calls a provider on receipts that do not reproduce the published contrasts; why_new=/ship review finding (red team, reproduce on paid paths); seam=rejudge-systems.ts judge; no_claim=the fixture receipts fail derive()'s schema check, so this shows the order, not a REPRODUCTION_FAILED message
  test('a paid subcommand runs the reproduction check first and refuses before any ledger, key or lease', () => {
    const out = join(tmp, 'repro-cli'), ledger = join(tmp, 'repro-cli-ledger.sqlite');
    const r = cli(['judge', '--stratum', 'A', ...roots.flatMap(x => ['--root', x]), '--out', out, '--budget-ledger', ledger, '--run-id', 'gst-1365-repro', '--lease-usd', '1', '--keyless-upstream', 'http://127.0.0.1:9']);
    expect([r.code !== 0, r.text.includes('RECEIPT_INVALID') && r.text.includes('campaign.json schema')]).toEqual([true, true]);
    expect([existsSync(ledger), existsSync(join(out, 'ledger-tie.json'))]).toEqual([false, false]);
  });
});

describe('reports', () => {
  // Value: protects=free Stage 0's counts and projection, and that no report carries a question id; fails_when=plan miscounts what is left, or a question id reaches a report; why_new=new; seam=plan/guardIds/renderContrasts; no_claim=none
  test('plan counts what each judge still needs and projects dollars; reports refuse question ids', () => {
    const s = loadSources(roots, join(tmp, 'plan'));
    const p = plan(s);
    expect(p.strata.A.by_judge).toEqual({ [SOL]: { needed: 129, reusable: 11, to_judge: 118 }, [OPUS]: { needed: 65, reusable: 0, to_judge: 65 } });
    expect(p.projection.central.lines.A).toBeCloseTo(118 * 0.0188 + 65 * 0.068, 9);
    expect([p.instrument_mismatch, p.measured.compared, p.projection.central.cut_through, p.projection.central.fits]).toEqual([[], 11, 0, true]);
    const none = { ...s, own: [] }, usd = (ts: Task[]) => ts.reduce((y, t) => y + (t.judge === SOL ? 0.0188 : 0.068), 0);
    const census = (['A', 'B', 'C', 'D'] as const).reduce((y, x) => y + p.projection.central.lines[x], 0);
    expect(usd(frontierTasks(none, ['C'], null).tasks)).toBeGreaterThan(p.projection.central.lines.C + 1);
    expect(census).toBeCloseTo(usd(frontierTasks(none, ['A', 'B', 'C', 'D'], null).tasks), 9);
    expect(p.strata.C.new_to_judge).toBe(frontierTasks(none, ['A', 'B', 'C'], null).tasks.length - frontierTasks(none, ['A', 'B'], null).tasks.length);
    const answers = new Set(frontierTasks(none, ['A', 'B', 'C', 'D'], null).scope);
    expect(p.projection.central.lines.referee).toBeCloseTo((answers.size * p.measured.disagreement_rate! + 600) * 0.03, 9);
    const table = renderContrasts(contrastResults(s, null).contrasts);
    expect(() => guardIds(table + JSON.stringify(p.contrasts), s)).not.toThrow();
    expect(refusal(() => guardIds(`mean 0.5 on ${qid('S2a', 0, 0)}`, s)).message).toContain('question id');
  });
});

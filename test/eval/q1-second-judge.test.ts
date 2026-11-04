/**
 * A6's second-judge sensitivity (eval/runner/q1/second-judge.ts) over invented published cells: which answers
 * gpt-6.1-sol judges, where its judgments go, both judges' paired differences on the same questions, A6's trigger and
 * the other refusals before any request, the budget stop and its resume, the judge's route through the real lease
 * proxy on the re-read ledger, and the summary table.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { closeLedgers, ledgerStatus } from '../../eval/runner/budget-ledger.ts';
import type { Corpus, MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';
import { instrumentFor } from '../../eval/runner/memory-qa/instruments.ts';
import type { ChatLike, ChatResult } from '../../eval/runner/memory-qa/qa-v2.ts';
import { answerRecord, judgmentProblems, sha256, type AnswerRecord, type JudgmentRecord } from '../../eval/runner/memory-qa/records.ts';
import { DEFAULT_ROUTE_CAPS, MeteringProxy } from '../../eval/runner/metering-proxy.ts';
import type { ArmDefinition, CellDefinition } from '../../eval/runner/q1/cells/definitions.ts';
import { PARTICLE, RESAMPLES, SEED, seedNumber } from '../../eval/runner/q1/particle-addon-report.ts';
import { openRereadLease, REREAD_RECEIPT_SCHEMA } from '../../eval/runner/q1/reread-cell.ts';
import { ScoreboardError } from '../../eval/runner/q1/scoreboard-errors.ts';
import { prepareSecondJudge, renderSecondJudge, runSecondJudge, SECOND_JUDGE, secondJudgeCellId } from '../../eval/runner/q1/second-judge.ts';
import { DEFAULT_ROUTE_CLASSES } from '../../eval/runner/shootout-cell.ts';
import { clusteredPairedDelta } from '../../eval/runner/stats/paired.ts';

const ROOT = resolve(import.meta.dir, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'q1-second-judge-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const raw = JSON.parse(readFileSync(join(ROOT, 'test/eval/fixtures/q1-cell/locomo-shaped.json'), 'utf8')) as { conversations: Corpus['conversations']; questions: MemoryQuestion[] };
const corpus: Corpus = { benchmark: 'fixture', conversations: raw.conversations, questions: raw.questions, source: { name: 'LoCoMo-shaped fixture (invented)', files: [{ path: 'test/eval/fixtures/q1-cell/locomo-shaped.json', sha256: 'fixture' }], revision: 'repo', license: 'MIT' } };
const QUESTIONS = raw.questions.slice(0, 15);
const OPUS = 'anthropic:claude-opus-5-5', SOL = 'openai:gpt-6.1-sol';
const locomo = instrumentFor('locomo');
const INSTRUMENT = { id: locomo.id, sha256: locomo.sha256, judge: locomo.canonical_judge };
const CONFIG = sha256('run-config');
const ARM_ID = 'component-b8000';
const ARM = `s3.ext-graph-pipeline.recipe.${ARM_ID}`;
const REREAD = `${ARM}.reread-particle-particle-1`;
const def = { id: 's3.ext-graph-pipeline.recipe', set: 'S3', benchmark: 'locomo', split: 'dev', canonical_instrument: 'locomo', system: 'ext-graph-pipeline' } as unknown as CellDefinition;
const arm = { id: ARM_ID, cell_id: ARM, mode: 'packed' } as unknown as ArmDefinition;
const NO_META = { finish: null, usage: null, response_model: null, attempt_errors: [] as string[] };
const ndjson = (path: string) => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

/**
 * Per reader by question index: [canonical score, gpt-6.1-sol's verdict], or a failure outcome. The canonical judge has
 * particle-1 ahead by 3 of 14 paired questions; gpt-6.1-sol fails particle-1's first four answers and puts it 1 behind.
 */
type Cell = Array<[number, 0 | 1] | 'retrieval_error' | 'reader_error'>;
const OPUS_PLAN: Cell = [[0, 0], [0, 0], [0, 0], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [0, 0], [1, 1], [1, 1], [1, 1], 'retrieval_error'];
const PARTICLE_PLAN: Cell = [[1, 0], [1, 0], [1, 0], [1, 0], [1, 1], [1, 1], [1, 1], [0, 0], [1, 1], [1, 1], [1, 1], [1, 1], 'reader_error', [1, 1], 'retrieval_error'];
const SOL_PLAN: Cell = QUESTIONS.map(() => [1, 1] as [number, 0 | 1]);

function publish(root: string, cellId: string, plans: Record<string, Cell>, receipt: Record<string, unknown> = {}) {
  const dir = join(root, 'cells', cellId);
  mkdirSync(dir, { recursive: true });
  const answers: AnswerRecord[] = [], judgments: JudgmentRecord[] = [];
  for (const [reader, xs] of Object.entries(plans)) xs.forEach((x, i) => {
    const q = QUESTIONS[i];
    const a = answerRecord({ cell_id: cellId, realization_id: 'r0', question_id: q.id, conversation: q.conversation, system: 'ext-graph-pipeline', arm: 'component', reader, replicate: 0, effort: 'medium', context_sha256: sha256(`ctx-${i}`) },
      { text: typeof x === 'string' ? '' : `ANSWER-${reader}-${i}${x[1] ? ' SOL-YES' : ''}`, outcome: typeof x === 'string' ? x : 'scored', usage: { input: 1000, output: 100, cache_read: 0, cache_write: 0 }, latency_ms: 10, provider_input_tokens: 1000 });
    answers.push(a);
    if (typeof x !== 'string') judgments.push({ answer_id: a.answer_id, instrument_id: INSTRUMENT.id, instrument_sha256: INSTRUMENT.sha256, judge: INSTRUMENT.judge, judge_replicate: 0, temperature: 0, score: x[0], parse_ok: true, raw_sha256: sha256('raw'), outcome: 'scored' } as JudgmentRecord);
  });
  writeFileSync(join(dir, 'answers.ndjson'), answers.map(a => JSON.stringify(a) + '\n').join(''));
  writeFileSync(join(dir, 'judgments.ndjson'), judgments.map(j => JSON.stringify(j) + '\n').join(''));
  writeFileSync(join(dir, 'receipt.json'), JSON.stringify({ cell_id: cellId, set: 'S3', block: 'T2-S3', run_status: 'complete', config_sha256: CONFIG, system: { kind: 'ext-graph-pipeline' }, instrument: INSTRUMENT, ...receipt }));
}

const frontier = join(tmp, 'frontier'), reread = join(tmp, 'reread');
publish(frontier, ARM, { [OPUS]: OPUS_PLAN, [SOL]: SOL_PLAN });
publish(reread, REREAD, { [PARTICLE]: PARTICLE_PLAN }, { schema: REREAD_RECEIPT_SCHEMA, keyless: false, source: { arm_cell_id: ARM, config_sha256: CONFIG } });
const roots = [frontier, reread];

/** gpt-6.1-sol's scripted verdicts: yes when the answer carries SOL-YES; throws a budget refusal on call `refuseAt`. */
function scriptedSol(refuseAt = Infinity): ChatLike & { models: string[] } {
  const models: string[] = [];
  return {
    models,
    async chat(model, prompt): Promise<ChatResult> {
      if (models.length + 1 >= refuseAt) throw new Error('budget: the lease has no room for this request');
      models.push(model);
      return { text: prompt.includes('SOL-YES') ? 'yes' : 'no', input_tokens: 100, output_tokens: 1, cached: false, ...NO_META };
    },
  };
}

const refusal = (fn: () => unknown) => {
  try { fn(); } catch (e) { if (e instanceof ScoreboardError) return e.op; throw e; }
  throw new Error('expected a refusal');
};
const round = (x: number) => Math.round(x * 1e4) / 1e4;

let saved: NodeJS.ProcessEnv = {};
beforeEach(() => { saved = { ...process.env }; });
afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); closeLedgers(); });

describe('the second-judge sensitivity', () => {
  // Value: protects=A6's second judge grades exactly both readers' answers on the paired questions and never touches a canonical score; fails_when=it judges another reader, a product failure, a question outside the pairing, or writes beside the canonical judgments, or a resume sends again; why_new=second-judge.ts is new; seam=a scripted judge; no_claim=any real result
  test('gpt-6.1-sol judges Opus and particle-1 on the questions both have scored, apart from the canonical judgments, and a resume sends nothing', async () => {
    const canonicalBytes = [readFileSync(join(frontier, 'cells', ARM, 'judgments.ndjson'), 'utf8'), readFileSync(join(reread, 'cells', REREAD, 'judgments.ndjson'), 'utf8')];
    const out = join(tmp, 'judge');
    const p = prepareSecondJudge(def, arm, { roots, out }, { corpus });
    // 14 paired questions (particle-1's reader_error leaves the denominator); the shared retrieval_error scores 0 without a judge.
    expect([p.paired.length, p.plan.length]).toEqual([14, 26]);
    expect(new Set(p.plan.map(x => x.answer.reader))).toEqual(new Set([OPUS, PARTICLE]));
    const judge = scriptedSol();
    const res = await runSecondJudge(p, {}, { judge });
    expect([res.status, res.cell_id, res.dir]).toEqual(['complete', secondJudgeCellId(ARM), join(out, 'cells', `${ARM}.second-judge`)]);
    expect(judge.models).toEqual(Array(26).fill(SECOND_JUDGE));
    const judgments = ndjson(join(res.dir, 'judgments.ndjson')) as JudgmentRecord[];
    expect(judgments.flatMap(j => judgmentProblems(j))).toEqual([]);
    expect(judgments.map(j => [j.instrument_id, j.instrument_sha256, j.judge, j.judge_replicate])).toEqual(Array(26).fill([`locomo@${SOL}`, locomo.sha256, SOL, 0]));
    expect(new Set(judgments.map(j => j.answer_id))).toEqual(new Set(p.plan.map(x => x.answer.answer_id)));
    expect([readFileSync(join(frontier, 'cells', ARM, 'judgments.ndjson'), 'utf8'), readFileSync(join(reread, 'cells', REREAD, 'judgments.ndjson'), 'utf8')]).toEqual(canonicalBytes);

    const again = await runSecondJudge(prepareSecondJudge(def, arm, { roots, out }, { corpus }), {}, { judge });
    expect([again.status, judge.models.length]).toEqual(['complete', 26]);
    expect(ndjson(join(res.dir, 'judgments.ndjson'))).toEqual(judgments);
  });

  // Value: protects=the findings file's side-by-side numbers; fails_when=either judge's difference, interval, correct counts or pairing drifts from the report's rules, seed or clustering; why_new=new; seam=scripted verdicts that disagree with the canonical ones; no_claim=any real result
  test('the receipt gives particle-1 minus Opus under both judges on the same questions, seeded and clustered as the report', async () => {
    const res = await runSecondJudge(prepareSecondJudge(def, arm, { roots, out: join(tmp, 'compare') }, { corpus }), {}, { judge: scriptedSol() });
    const r = res.receipt as any;
    const paired = QUESTIONS.map((q, i) => ({ q, i })).filter(({ i }) => i !== 12);
    const value = (plan: Cell, i: number, k: 0 | 1) => (typeof plan[i] === 'string' ? 0 : (plan[i] as [number, number])[k]);
    const expected = (k: 0 | 1) => clusteredPairedDelta(paired.map(({ q, i }) => ({ id: q.id, cluster: q.conversation, a: value(OPUS_PLAN, i, k), b: value(PARTICLE_PLAN, i, k) })), { seed: seedNumber(SEED), draws: RESAMPLES });
    const [canonical, second] = [expected(0), expected(1)];
    expect(r.trigger).toEqual({ pairs: 14, delta: round(3 / 14), ci95: [round(canonical.ci95![0]), round(canonical.ci95![1])] });
    expect(r.comparison).toMatchObject({ pairs: 14, clusters: 3, seed: 'f6-p1', resamples: 10_000,
      canonical: { opus_mean: round(9 / 14), particle_mean: round(12 / 14), delta: round(3 / 14), ci95: [round(canonical.ci95![0]), round(canonical.ci95![1])], opus_correct: 9, particle_correct: 12 },
      second: { opus_mean: round(9 / 14), particle_mean: round(8 / 14), delta: round(-1 / 14), ci95: [round(second.ci95![0]), round(second.ci95![1])], opus_correct: 9, particle_correct: 8 } });
    expect(r).toMatchObject({ run_status: 'complete', judge: SOL, canonical_judge: locomo.canonical_judge, instrument: { id: `locomo@${SOL}`, base: 'locomo', sha256: locomo.sha256 },
      frontier_cell: ARM, particle_cell: REREAD, counts: { paired_questions: 14, answers_to_judge: 26, judged: 26, judge_errors: 0, unjudged: 0 } });
    const text = readFileSync(join(res.dir, 'receipt.json'), 'utf8');
    for (const q of QUESTIONS) expect(text).not.toContain(q.id);
    expect(text).not.toContain('ANSWER-');
  });

  // Value: protects=A6's trigger and the checks before any request; fails_when=a cell where particle-1 is not above Opus, another instrument, an unpaired arm, a shared --out, a resume of other answers, or a sealed cell without custody reaches a request or writes --out; why_new=new; seam=invented cells; no_claim=none
  test('a cell where particle-1 is not above Opus, another instrument, an unpaired arm, a shared --out, a resume of other answers and a sealed cell without custody are refused before any request', () => {
    const behind = join(tmp, 'behind');
    publish(behind, REREAD, { [PARTICLE]: OPUS_PLAN }, { schema: REREAD_RECEIPT_SCHEMA, keyless: false, source: { arm_cell_id: ARM, config_sha256: CONFIG } });
    const out = join(tmp, 'refused');
    expect(refusal(() => prepareSecondJudge(def, arm, { roots: [frontier, behind], out }, { corpus })).message).toContain('particle-1 minus Opus on s3.ext-graph-pipeline.recipe.component-b8000 is 0 under the canonical judge, so A6 asks for no second judge there');
    expect(refusal(() => prepareSecondJudge(def, arm, { roots, out }, { corpus, instrument: instrumentFor('lme-s') })).message).toContain(`was judged with locomo (${locomo.sha256.slice(0, 12)})`);
    expect(refusal(() => prepareSecondJudge(def, { ...arm, cell_id: `${ARM}-other` }, { roots, out }, { corpus })).code).toBe('INPUT_MISSING');
    expect(existsSync(out)).toBe(false);
    const sealed = { ...def, benchmark: 'invented-sealed', split: 'sealed' } as unknown as CellDefinition;
    delete process.env.GBRAIN_EVALS_CUSTODY_LOG;
    expect(refusal(() => prepareSecondJudge(sealed, arm, { roots: [join(tmp, 'no-such-root')], out, env: {} })).code).toBe('CUSTODY_REQUIRED');

    const shared = join(tmp, 'shared');
    mkdirSync(join(shared, 'cells', 'another.second-judge'), { recursive: true });
    expect(refusal(() => prepareSecondJudge(def, arm, { roots, out: shared }, { corpus })).message).toContain('give each cell its own --out');
    const resumed = join(tmp, 'resumed');
    prepareSecondJudge(def, arm, { roots, out: resumed }, { corpus });
    const edited = join(tmp, 'edited');
    publish(edited, REREAD, { [PARTICLE]: PARTICLE_PLAN.map((x, i) => (i === 5 ? [1, 0] : x)) as Cell }, { schema: REREAD_RECEIPT_SCHEMA, keyless: false, source: { arm_cell_id: ARM, config_sha256: CONFIG } });
    expect(refusal(() => prepareSecondJudge(def, arm, { roots: [frontier, edited], out: resumed }, { corpus })).code).toBe('RESUME_REFUSED');
    expect(refusal(() => prepareSecondJudge(def, arm, { roots, out: resumed, keyless: true }, { corpus })).message).toContain('holds a paid second-judge run');
  });

  // Value: protects=a lease refusal stops the second judge without a judgment and a resume finishes it; fails_when=the run keeps sending after a budget refusal, records a judgment for it, reports complete, or a resume re-judges what is done; why_new=new; seam=a scripted budget refusal; no_claim=none
  test('a budget refusal stops the run partial, and a resume judges only what is left', async () => {
    const out = join(tmp, 'budget');
    const first = scriptedSol(5);
    const res = await runSecondJudge(prepareSecondJudge(def, arm, { roots, out }, { corpus }), {}, { judge: first });
    expect([res.status, res.stopped?.startsWith('budget'), first.models.length]).toEqual(['partial', true, 4]);
    expect(ndjson(join(res.dir, 'judgments.ndjson'))).toHaveLength(4);
    expect((res.receipt as any).counts).toMatchObject({ judged: 4, unjudged: 22 });
    expect(JSON.parse(readFileSync(join(res.dir, 'receipt.json'), 'utf8')).run_status).toBe('partial');
    const rest = scriptedSol();
    const done = await runSecondJudge(prepareSecondJudge(def, arm, { roots, out }, { corpus }), {}, { judge: rest });
    expect([done.status, rest.models.length, ndjson(join(done.dir, 'judgments.ndjson')).length]).toEqual(['complete', 22, 26]);
  });

  // Value: protects=the second judge's dollars go through the lease proxy on the judge slot and the re-read ledger under its own runner name; fails_when=a judgment bypasses the proxy, goes out on another slot or model, or the lease is not the ceiling-checked re-read lease; why_new=new; seam=a scripted OpenAI upstream; no_claim=OpenAI's billing
  test('each judgment goes to gpt-6.1-sol through the lease proxy on the judge slot, under a ceiling-checked lease named q1-second-judge', async () => {
    const ledgerPath = join(tmp, 'ledger.sqlite');
    const lease = openRereadLease({ runId: 'second-judge-1', leaseUsd: 1, ledgerPath, capUsd: 60, runner: 'q1-second-judge' });
    const sent: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      sent.push(body.model);
      return Response.json({ id: 'x', model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(body.messages).includes('SOL-YES') ? 'yes' : 'no' } }], usage: { prompt_tokens: 100, completion_tokens: 5 } });
    }) as unknown as typeof fetch;
    const out = join(tmp, 'proxied');
    const p = prepareSecondJudge(def, arm, { roots, out }, { corpus });
    const usageLog = join(out, 'usage.ndjson');
    const proxy = new MeteringProxy({ fetchImpl, policy: { lease, usageLog, env: { OPENAI_API_KEY: 'dummy', ANTHROPIC_API_KEY: 'dummy', VOYAGE_API_KEY: 'dummy', PARTICLE_API_KEY: 'dummy-particle' }, routeCaps: { caps: { ...DEFAULT_ROUTE_CAPS }, slots: { ...DEFAULT_ROUTE_CLASSES }, defaultClass: 'extraction' } } });
    proxy.start();
    try {
      const res = await runSecondJudge(p, { providerProxy: `http://127.0.0.1:${proxy.port}`, lease: { usd: 1, usageLog } });
      expect(res.status).toBe('complete');
      expect(sent).toEqual(Array(26).fill('gpt-6.1-sol'));
      expect(ndjson(usageLog).map(l => [l.provider, l.slot, l.route_class, l.outcome])).toEqual(Array(26).fill(['openai', 'judge', 'judge', 'forwarded']));
      const r = res.receipt as any;
      expect([r.lease.requests, r.spend.judge_usd > 0, r.comparison.second.delta]).toEqual([26, true, round(-1 / 14)]);
    } finally { proxy.stop(); lease.close(); }
    expect(ledgerStatus({ ledgerPath, runId: 'second-judge-1' }).run?.runner).toBe('q1-second-judge');
    expect(refusal(() => openRereadLease({ runId: 'second-judge-2', leaseUsd: 60, ledgerPath, capUsd: 60, runner: 'q1-second-judge' })).message).toContain('would pass its $60.00 ceiling');
  });

  // Value: protects=the findings file's table; fails_when=a row drops a judge, mixes judge pairs, or prints a question id; why_new=new; seam=receipts from the runs above; no_claim=none
  test('the summary table gives both judges per cell in the order given, and refuses receipts from two judge pairs', async () => {
    const res = await runSecondJudge(prepareSecondJudge(def, arm, { roots, out: join(tmp, 'summary') }, { corpus }), {}, { judge: scriptedSol() });
    const r = res.receipt as any;
    const table = renderSecondJudge([r, { ...r, frontier_cell: 'second-row', run_status: 'partial', comparison: null }]);
    const rows = table.trim().split('\n');
    expect(rows[0]).toContain(`particle-1 minus Opus, ${locomo.canonical_judge.slice(locomo.canonical_judge.indexOf(':') + 1)} (95% CI)`);
    expect(rows[0]).toContain('particle-1 minus Opus, gpt-6.1-sol (95% CI)');
    expect(rows[2]).toStartWith(`| ${ARM} | complete | 14 (3) | +21.4 (`);
    expect(rows[2]).toContain('| -7.1 (');
    expect(rows[2]).toContain('| 9 / 12 | 9 / 8 |');
    expect(rows[3]).toBe('| second-row | partial | 0 | n/a | n/a | n/a | n/a | $0.00 |');
    for (const q of QUESTIONS) expect(table).not.toContain(q.id);
    expect(() => renderSecondJudge([r, { ...r, judge: 'anthropic:claude-opus-5-5' }])).toThrow('one table compares one pair');
  });
});

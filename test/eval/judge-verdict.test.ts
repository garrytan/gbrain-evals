/**
 * A judge reply with no yes or no is a judge error, never a "no" (GST-2488). A Claude 5 judge thinks before it answers,
 * so at qa.ts's 10-token limit it can return no text at all, and with room to think it sometimes reasons first and ends
 * with its verdict. qa-v2's `judgeVerdict` reads the first three words as before, else a complete reply's last
 * standalone yes or no, else nothing, and every runner that judged through qa.ts's client now judges through qa-v2's.
 * Keyless: provider calls go to a local fake upstream with the provider keys blanked; the real replies are the committed
 * W10b second-judge receipts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { devScore, loadDecision } from '../../eval/runner/budgeted-delivery/c8k.ts';
import { loadCorpus, type Corpus, type MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';
import { anthropicMaxTokens, ChatClient, judgeResponse, judgeVerdict, UnansweredJudgment, type VerdictPath } from '../../eval/runner/memory-qa/qa-v2.ts';
import * as memoryQa from '../../eval/runner/memory-qa/run.ts';
import { qaRows, type NightContext, type SuiteRun } from '../../eval/runner/nightly/adapters.ts';
import type { UsageReceipt } from '../../eval/runner/usage-receipt.ts';

const REPO = resolve(import.meta.dir, '../..');
const OPUS = 'anthropic:claude-opus-5-5';
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'judge-verdict-')); dirs.push(d); return d; };
const question = (o: Partial<MemoryQuestion> = {}): MemoryQuestion => ({ id: 'q-1', conversation: 'conv-1', question: 'How many days was the trip?', category: 'temporal-reasoning', gold: ['s-1'], abstention: false, answer: '21 days', ...o });

/** The fake upstream: each Anthropic call gets the next queued reply after a thinking block, each OpenAI call a reader answer. */
const replies: Array<{ text: string; stop: string }> = [];
const sent: Array<{ path: string; body: Record<string, any> }> = [];
const ENV = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_KEY'] as const;
const saved: Partial<Record<(typeof ENV)[number], string>> = {};
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    const body = await req.json() as Record<string, any>;
    sent.push({ path, body });
    if (path === '/v1/messages') {
      const r = replies.shift();
      if (!r) return Response.json({ error: { message: 'no reply queued' } }, { status: 400 });
      return Response.json({ model: body.model, stop_reason: r.stop, content: [{ type: 'thinking', thinking: 'weighing the rubric item' }, ...(r.text ? [{ type: 'text', text: r.text }] : [])],
        usage: { input_tokens: 300, output_tokens: 40 } });
    }
    return Response.json({ model: body.model, choices: [{ finish_reason: 'stop', message: { content: 'The trip took 21 days.' } }], usage: { prompt_tokens: 300, completion_tokens: 8 } });
  } });
  for (const k of ENV) saved[k] = process.env[k];
  process.env.ANTHROPIC_BASE_URL = process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.port}`;
  process.env.ANTHROPIC_API_KEY = process.env.OPENAI_API_KEY = '';
});
afterEach(() => { replies.length = 0; sent.length = 0; });
afterAll(() => {
  server.stop(true);
  for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('judgeVerdict', () => {
  // Value: protects=every reply qa.ts's judgeYes reads keeps its verdict, a reply that reasons first is read from its end, and a reply with neither is no verdict; fails_when=the head window moves, the tail takes a non-standalone no ("no mention"), a cut-off reply is read from its tail, or an empty reply reads as "no"; why_new=judgeYes scored every reply without a yes or no in its first three words as "no" (GST-2488); seam=none; no_claim=prompts or which judge runs
  test('a yes or no in the first three words decides, cut off or not', () => {
    expect(judgeVerdict({ text: 'yes', finish: 'end_turn' })).toEqual({ path: 'head', yes: true });
    expect(judgeVerdict({ text: 'No. The response gives 3 days.', finish: 'stop' })).toEqual({ path: 'head', yes: false });
    expect(judgeVerdict({ text: '**Verdict:** no', finish: 'end_turn' })).toEqual({ path: 'head', yes: false });
    expect(judgeVerdict({ text: 'Yes, the response satisfies the rubric item because', finish: 'length' })).toEqual({ path: 'head', yes: true });
  });

  test("otherwise a complete reply's last standalone yes or no decides", () => {
    expect(judgeVerdict({ text: 'The model says 3, but the correct answer is 4.\n\n**no**', finish: 'end_turn' })).toEqual({ path: 'tail', yes: false });
    expect(judgeVerdict({ text: 'The response recalls the chain replacement, which is what the rubric asks.\n\nYes', finish: 'end_turn' })).toEqual({ path: 'tail', yes: true });
    expect(judgeVerdict({ text: 'The correct answer is "Yes." The response hedges instead of answering.\n\nno', finish: 'end_turn' })).toEqual({ path: 'tail', yes: false });
    expect(judgeVerdict({ text: 'It matches the correct answer, so yes. Nothing else is missing.', finish: 'stop' })).toEqual({ path: 'tail', yes: true });
  });

  test('an empty reply, a cut-off reply with no head verdict, and a reply with no standalone yes or no have none', () => {
    expect(judgeVerdict({ text: '', finish: 'max_tokens' })).toEqual({ path: 'none', yes: false });
    expect(judgeVerdict({ text: '  ', finish: 'end_turn' })).toEqual({ path: 'none', yes: false });
    expect(judgeVerdict({ text: 'The rubric item asks whether the response', finish: 'max_tokens' })).toEqual({ path: 'none', yes: false });
    expect(judgeVerdict({ text: 'The response matches the correct answer.\n\nyes', finish: 'max_tokens' })).toEqual({ path: 'none', yes: false });
    expect(judgeVerdict({ text: 'The response has no mention of the Garmin computer.', finish: 'end_turn' })).toEqual({ path: 'none', yes: false });
  });

  test('every committed W10b Sonnet 5.5 judge reply without a head verdict ends in a standalone one', () => {
    const file = join(REPO, 'docs/findings/2026-11-01-particle-1-longmemeval-w10b/second-judge/claude-sonnet-5-5/receipts.ndjson');
    const judged = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as UsageReceipt).filter(r => r.role === 'judge' && r.status === 'ok');
    const verdicts = judged.map(r => judgeVerdict({ text: r.answer, finish: r.finish_raw }));
    const tails = verdicts.filter(v => v.path === 'tail');
    expect([judged.length, verdicts.filter(v => v.path === 'head').length, tails.length, tails.filter(v => v.yes).length]).toEqual([1000, 971, 29, 23]);
  });
});

describe('qa-v2 judgeResponse against the fake upstream', () => {
  // Value: protects=a Claude 5 judge is sent the 2,000-token floor, an empty max_tokens reply throws instead of scoring 0, and each judge receipt records its verdict path; fails_when=judgeResponse reads replies with judgeYes, the floor is dropped, or verdict_path is not written; why_new=GBEV-54's v1 pass got 459 of 775 empty Opus replies scored as "no"; seam=a local HTTP upstream; no_claim=real provider behaviour
  test('an empty reply cut off at max_tokens is a judge error, and the Claude 5 judge was sent the floor', async () => {
    replies.push({ text: '', stop: 'max_tokens' });
    const receipts: UsageReceipt[] = [];
    await expect(judgeResponse(new ChatClient(tmp(), () => 0), 'lme-s', OPUS, question(), 'The trip took 21 days.', 0, receipts)).rejects.toBeInstanceOf(UnansweredJudgment);
    expect(sent.map(s => s.body.max_tokens)).toEqual([anthropicMaxTokens('claude-opus-5-5', 10)]);
    expect(sent[0]!.body.max_tokens).toBeGreaterThanOrEqual(2000);
    expect(receipts.at(-1)).toMatchObject({ role: 'judge', status: 'ok', finish: 'max_tokens', answer: '', verdict_path: 'none' });
  });

  test('a reply that reasons first counts by its tail, and each receipt names its path', async () => {
    replies.push({ text: 'yes', stop: 'end_turn' }, { text: 'Item 2 asks for diversity filters, and the response applies them.\n\n**yes**', stop: 'end_turn' });
    const receipts: UsageReceipt[] = [];
    const paths: VerdictPath[] = [];
    const q = question({ rubric: ['Mentions the Cypress tests', 'Applies diversity filters'] });
    expect(await judgeResponse(new ChatClient(tmp(), () => 0), 'beam-1m', OPUS, q, 'An answer.', 0, receipts, paths)).toBe(1);
    expect(receipts.filter(r => r.role === 'judge').map(r => r.verdict_path)).toEqual(['head', 'tail']);
    expect(paths).toEqual(['head', 'tail']);
  });
});

describe('memory-qa and the nightly count an unanswered judgment as a judge harness row', () => {
  // Value: protects=memory-qa records a reply with no verdict as qa_error with the judge receipt last, so the nightly row is a judge harness row, and a tail verdict reaches the nightly evidence; fails_when=readAndJudge scores the empty reply 0, qaRows drops tail_verdicts, or the cause is not judge; why_new=the nightly judges gpt-6.1-sol rows with claude-opus-5-5 through this path; seam=readAndJudge and qaRows against the fake upstream; no_claim=the nightly child process or its ledger
  test('an empty judge reply is a judge harness row; a tail verdict is counted on the row', async () => {
    const corpus = loadCorpus('fixture');
    const q = corpus.questions[0]!;
    const a = memoryQa.parseRunArgs(['--benchmark', 'fixture', '--qa', 'reader', '--qa-context', 'oracle', '--reader', 'openai:gpt-4o-mini', '--judge', OPUS, '--output', join(tmp(), 'out')]);
    const read = () => memoryQa.readAndJudge({ benchmark: 'fixture', qa: a.qa, q, chat: new ChatClient(tmp(), () => 0), think: null, prompt: 'What did the vet visit cost?', countTokens: null });
    replies.push({ text: '', stop: 'max_tokens' });
    const failed = await read();
    expect(failed.qa_error).toStartWith('judge reply holds no yes or no verdict');
    expect(failed.qa_receipts!.at(-1)).toMatchObject({ role: 'judge', verdict_path: 'none' });
    replies.push({ text: 'The response gives the cost the reference gives.\n\nyes', stop: 'end_turn' });
    const tailed = await read();
    expect([tailed.qa_score, tailed.qa_tail_verdicts]).toEqual([1, 1]);

    const out = tmp();
    writeFileSync(join(out, 'rows.ndjson'), [{ id: 'q-fail', ...failed }, { id: 'q-tail', ...tailed }].map(r => JSON.stringify(r)).join('\n') + '\n');
    const run = { suite: { id: 'lme-s-hard', kind: 'qa', scoring: 'judge', about: '', source: '' }, digest: 'd', items: [{ id: 'q-fail', role: 'headroom' }, { id: 'q-tail', role: 'headroom' }], readers: ['gpt-6.1-sol'], k: 1 } as SuiteRun;
    const rows = qaRows(run, { night: '2026-11-12', ref: 'master', sha: 'sha' } as NightContext, 'gpt-6.1-sol', out, OPUS);
    expect(rows.map(r => [r.item, r.pass, r.stop, r.harness?.cause ?? null, r.evidence.tail_verdicts ?? null])).toEqual([['q-fail', false, 'error', 'judge', null], ['q-tail', true, 'answered', null, 1]]);
  });
});

describe('c8k dev-score judges through qa-v2', () => {
  // Value: protects=the 8k conversion's development judge is sent the floor when it is a Claude 5 model, marks a tail verdict, and stops on an empty reply; fails_when=devScore goes back to qa.ts's client (10 tokens) or judgeYes; why_new=c8k.ts judged through the v1 client; seam=devScore against the fake upstream; no_claim=the held-out scoring, which sealed-confirmation.ts does
  test('a Claude 5 dev judge is sent the floor, a tail verdict is marked, an empty reply stops the step', async () => {
    const { decision: D } = loadDecision(join(REPO, 'docs/benchmarks/2026-10-26-gbrain-8k-conversion/decision.json'));
    const decision = { ...D, development: { ...D.development, judge: OPUS } };
    const corpus = { benchmark: 'lme-s', conversations: [], questions: [question()], source: { name: 'lme-s', files: [], revision: 'test', license: 'test' } } as Corpus;
    const score = async (reply: { text: string; stop: string }) => {
      const root = tmp();
      const answersDir = join(root, 'answers');
      mkdirSync(answersDir, { recursive: true });
      writeFileSync(join(answersDir, 'A0.jsonl'), [{ record_type: 'meta' }, { question_id: 'q-1', hypothesis: 'The trip took 21 days.', retrieved: ['s-1'] }].map(r => JSON.stringify(r)).join('\n') + '\n');
      replies.push(reply);
      await devScore({ custodyRoot: root, decision, corpus, answersDir, outDir: join(root, 'scores'), cache: join(root, 'qa') });
      return JSON.parse(readFileSync(join(root, 'scores', 'A0.json'), 'utf8')) as { per_question: Array<Record<string, unknown>> };
    };
    const report = await score({ text: 'The response gives 21 days, which matches.\n\nyes', stop: 'end_turn' });
    expect(sent.map(s => s.body.max_tokens)).toEqual([anthropicMaxTokens('claude-opus-5-5', 10)]);
    expect(report.per_question[0]).toMatchObject({ question_id: 'q-1', answer_correct: true, verdict_path: 'tail' });
    await expect(score({ text: '', stop: 'max_tokens' })).rejects.toBeInstanceOf(UnansweredJudgment);
  });
});

describe("no runner judges through qa.ts's chat client", () => {
  // Value: protects=qa.ts keeps the bytes the H1 decision pins, so its 10-token client and three-word verdict stay; only qa-v2 builds on them, and the lifecycle-lite files stay on them only while they hold the bytes their preregistration froze; fails_when=a runner imports ChatClient, judgeResponse, chatWithReceipts or judgeYes from qa.ts, or a pinned lifecycle-lite file changes and keeps the import; why_new=c8k, p4-stream, feedback-think-replay and p8 judged through qa.ts's client; seam=static imports under eval/ and scripts/; no_claim=dynamic imports of older trees (q1/golden-fixture.ts)
  test('only qa-v2 and the frozen lifecycle-lite files import them', () => {
    const QA = join(REPO, 'eval/runner/memory-qa/qa.ts');
    const BANNED = new Set(['ChatClient', 'judgeResponse', 'chatWithReceipts', 'judgeYes']);
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (f !== 'node_modules' && f !== 'reports') walk(p); } else if (p.endsWith('.ts')) files.push(p); } };
    walk(join(REPO, 'eval'));
    walk(join(REPO, 'scripts'));
    const offenders = files.filter(f => f !== join(REPO, 'eval/runner/memory-qa/qa-v2.ts')).flatMap(f => [...readFileSync(f, 'utf8').matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g)]
      .filter(m => resolve(dirname(f), m[2]!) === QA)
      .flatMap(m => m[1]!.split(',').map(n => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!).filter(n => BANNED.has(n)).map(n => `${relative(REPO, f)}: ${n}`)));
    const prereg = readFileSync(join(REPO, 'docs/benchmarks/2026-10-06-oss-memory-shootout-lifecycle-lite-preregistration.md'), 'utf8');
    const frozen = new Map([...prereg.matchAll(/^\| `(eval\/runner\/lifecycle-lite(?:\/run)?\.ts)` \| `([0-9a-f]{64})` \|$/gm)].map(m => [m[1]!, m[2]!]));
    expect([...frozen.keys()].sort()).toEqual(['eval/runner/lifecycle-lite.ts', 'eval/runner/lifecycle-lite/run.ts']);
    for (const [f, h] of frozen) expect([f, createHash('sha256').update(readFileSync(join(REPO, f))).digest('hex')]).toEqual([f, h]);
    expect(offenders.sort()).toEqual(['eval/runner/lifecycle-lite.ts: ChatClient', 'eval/runner/lifecycle-lite/run.ts: judgeYes']);
  });
});

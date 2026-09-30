/**
 * E2 sealed bridge, E3 product-path checks and budget-ledger wiring for the
 * evidence-delivery study. Public synthetic fixtures only; no network.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetExceededError, BudgetRun, installPaidRequestGuard, type PaidRequestGuard } from '../../eval/runner/budget-ledger.ts';
import { loadDecisionManifest } from '../../eval/runner/evidence-delivery/decision.ts';
import { buildSealedRequests, decisionIdFor, gbrainJudgeId, scoreSealed, sealedDatasetView, sealedFreezeInputs } from '../../eval/runner/evidence-delivery/e2-bridge.ts';
import { requestParts } from '../../eval/runner/evidence-delivery/arms.ts';
import { checkQuestion, resultsOf, requestFromSerialized, specFingerprint, uncontainedSegments, type E3Transport } from '../../eval/runner/evidence-delivery/e3.ts';
import { officialJudge, officialJudgePrompt } from '../../eval/runner/evidence-delivery/calls.ts';
import { runJob, type E1Context } from '../../eval/runner/evidence-delivery/e1.ts';
import { stripFrontmatter } from '../../eval/runner/evidence-delivery/parity.ts';
import { Args, costPlan, paidGuard } from '../../eval/runner/evidence-delivery.ts';
import { openLabels, toLmeRows } from '../../eval/runner/sealed-confirmation.ts';
import { READER_MODEL as SEALED_READER_MODEL } from '../../eval/runner/sealed-confirmation.ts';
import { RENDERER, fixture } from '../support/evidence-delivery-fixture.ts';
import { sha256 } from '../../eval/runner/evidence-delivery/data.ts';

const { manifest } = loadDecisionManifest();
const SONNET = 'anthropic:claude-sonnet-4-6';

/** A tiny public sealed-shaped questions file: two invented personas, invented chats. */
function sealedQuestions() {
  const haystack = (id: string) => ({ haystack_id: id, sessions: [0, 1, 2].map(i => ({ session_id: `${id}-s${i}`, date: `2025-0${i + 1}-01`, turns: [{ role: 'user' as const, content: `persona ${id} talks about widget ${i}` }, { role: 'assistant' as const, content: 'ok' }] })) });
  return {
    schema: 'sealed-confirmation/questions/v1', set_id: 'synthetic',
    haystacks: [haystack('p0'), haystack('p1')],
    questions: [
      { question_id: 'sq-1', haystack_id: 'p0', question: 'Which widget came first?', question_date: '2025-05-01' },
      { question_id: 'sq-2', haystack_id: 'p1', question: 'What did I say about widgets?', question_date: '2025-05-01' },
    ],
  } as any;
}

describe('E2 bridge: identical prompts and settings apart from evidence', () => {
  test('sealed questions become gold-free freeze inputs in LongMemEval shape', () => {
    const inputs = sealedFreezeInputs(toLmeRows(sealedQuestions()));
    expect(inputs).toHaveLength(2);
    expect(inputs[0].set).toBe('sealed');
    expect(Object.keys(inputs[0].question).sort()).toEqual(['haystack_dates', 'haystack_session_ids', 'haystack_sessions', 'question', 'question_date', 'question_id']);
    expect(JSON.stringify(inputs)).not.toContain('answer');
  });

  test('chunk and winner requests share model, system, output limit, framing and question; only evidence differs', () => {
    const { store, q } = fixture();
    const sealed = sealedQuestions();
    const sq = { ...q, question_id: 'sq-1', set: 'sealed' as const, question_type: null };
    const ctx = { store, renderer: RENDERER, dataset: sealedDatasetView(sealed), readerModel: SONNET, manifest };
    const reqs = buildSealedRequests(ctx, sq, 'window1');
    const a = requestParts(reqs.chunk.request, reqs.chunk.rendered), b = requestParts(reqs.winner.request, reqs.winner.rendered);
    expect(a.invariant).toBe(b.invariant);
    expect(a.evidence).not.toBe(b.evidence);
    for (const r of [reqs.chunk.request, reqs.winner.request]) {
      expect(r).toMatchObject({ model: SONNET, max_tokens: manifest.reader.max_tokens });
      expect(sha256(r.system)).toBe(manifest.reader.system_sha256);
      expect('temperature' in r).toBe(false);
      expect(r.messages[0].content.startsWith('Question:\nWhich widget came first?\n\nCurrent Date: 2025-05-01\n\nRetrieved sessions:\n')).toBe(true);
    }
  });

  test('the bridge replaces the sealed runner settings (temperature 0, 2048 tokens, official JSON-history prompt) with the E1 pins', () => {
    const { store, q } = fixture();
    const ctx = { store, renderer: RENDERER, dataset: sealedDatasetView(sealedQuestions()), readerModel: SONNET, manifest };
    const r = buildSealedRequests(ctx, { ...q, question_id: 'sq-1' }, 'window1').chunk.request;
    expect(SEALED_READER_MODEL).toBe('claude-sonnet-4-6');
    expect(r.max_tokens).not.toBe(2048);
    expect(r.system).toContain('<chat_session>');
    expect(r.messages[0].content).toContain('<chat_session id=');
  });

  test('the E2 request for a question equals the E1 request built from the same frozen evidence and question text', async () => {
    const { store, q, dataset } = fixture();
    const { armRequest } = await import('../../eval/runner/evidence-delivery/e1.ts');
    const e1 = armRequest({ store, renderer: RENDERER, dataset, readerModel: SONNET, manifest }, q, 'window1').request;
    const sealed = sealedQuestions();
    sealed.questions[0] = { ...sealed.questions[0], question: dataset.get('syn-1').question, question_date: q.question_date, question_id: 'syn-1' };
    const e2 = buildSealedRequests({ store, renderer: RENDERER, dataset: sealedDatasetView(sealed), readerModel: SONNET, manifest }, q, 'window1').winner.request;
    expect(e2).toEqual(e1);
  });

  test('the decision id names the manifest and the winner; non-candidates are refused', () => {
    expect(decisionIdFor(manifest, 'auto6k')).toBe(`${manifest.id}:e2:auto6k`);
    expect(() => decisionIdFor(manifest, 'k10')).toThrow('not a family candidate');
    expect(gbrainJudgeId({ question_id: 'x', question_type: 'abstention' })).toBe('x_abs');
    expect(gbrainJudgeId({ question_id: 'x', question_type: 'multi-session' })).toBe('x');
  });

  test('scoring refuses to open labels while an answer row is missing, and opens them once with the decision id', async () => {
    const questions = sealedQuestions();
    const opened: string[] = [];
    const labels = { labels: [{ question_id: 'sq-1', question_type: 'multi-session', abstention: false, answer: 'a', answer_session_ids: [], related_session_ids: [] }, { question_id: 'sq-2', question_type: 'abstention', abstention: true, answer: 'b', answer_session_ids: [], related_session_ids: [] }] } as any;
    const answers = ['chunk', 'window1'].flatMap(arm => questions.questions.map((x: any) => ({ question_id: x.question_id, arm, hypothesis: 'h', provider_input_tokens: 100, request_sha256: 'r', evidence_sha256: 'e' })));
    const common = { manifest, winner: 'window1', questions, openLabels: (id: string) => { opened.push(id); return labels; }, judgePrimary: async () => 1 as const, judgeConfirm: async () => 1 as const };
    await expect(scoreSealed({ ...common, answers: answers.slice(1) })).rejects.toThrow('no answer row');
    expect(opened).toEqual([]);
    const res = await scoreSealed({ ...common, answers });
    expect(opened).toEqual([`${manifest.id}:e2:window1`]);
    expect(res.decision.outcome).toBe('pass');
    expect(res.decision.n_clusters).toBe(2);
  });

  test('the sealed runner refuses to open labels for scoring without a decision id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ed-seal-'));
    const lPath = join(dir, 'labels.json');
    writeFileSync(lPath, JSON.stringify({ labels: [] }));
    const bytes = readFileSync(lPath);
    const m = { set: 't', commitments: { 'labels.json': { sha256: sha256(bytes), bytes: bytes.length } } } as any;
    const log = join(dir, 'access-log.jsonl');
    for (const decision_id of [null, '', '  ']) expect(() => openLabels(lPath, m, { path: log, action: 'score', purpose: 'test', decision_id, run_sha256: null })).toThrow('--decision-id is required');
    expect(existsSync(log)).toBe(false);
    openLabels(lPath, m, { path: log, action: 'score', purpose: 'test', decision_id: 'evidence-delivery:e2:window1', run_sha256: null });
    expect(JSON.parse(readFileSync(log, 'utf8').trim()).decision_id).toBe('evidence-delivery:e2:window1');
  });
});

describe('E3 product-path checks', () => {
  function stub(q: ReturnType<typeof fixture>['q'], opts: { tamper?: boolean; drift?: boolean } = {}): E3Transport & { calls: string[] } {
    const pageResults = q.pages.map((p, i) => ({ source_id: 'default', slug: p.slug, chunk_id: q.hits5[i].chunk_id, chunk_text: 'placeholder', delivered: { unit: 'page', chunk_ids: [q.hits5[i].chunk_id], tokens: 7 } }));
    const calls: string[] = [];
    return {
      calls,
      async call(op, args) {
        calls.push(`${op}:${args.return_unit}`);
        if (op === 'query' && args.return_unit === 'chunk') {
          const hits = q.hits5.map(h => ({ slug: h.slug, chunk_id: opts.drift ? h.chunk_id + 100 : h.chunk_id, chunk_text: 'x' }));
          return { ok: true, raw: JSON.stringify(hits, null, 2), data: hits, ms: 1 };
        }
        const results = pageResults.map(r => ({ ...r, chunk_text: opts.tamper && op === 'query' ? r.chunk_text + ' INJECTED' : r.chunk_text }));
        const data = op === 'assemble_evidence' ? { results, delivery: {}, unresolved: [] } : results;
        return { ok: true, raw: JSON.stringify(data, null, 2), data, ms: 1 };
      },
    };
  }

  test('local/remote and product-path fingerprints, token counts and containment are compared per arm', async () => {
    const f = fixture();
    const bodies = f.q.pages.map(p => stripFrontmatter(f.store.get(p.harness_body)));
    const t = stub(f.q);
    const orig = t.call.bind(t);
    t.call = async (op, args) => {
      const r = await orig(op, args);
      for (const x of resultsOf(r.data)) { const i = f.q.pages.findIndex(p => p.slug === x.slug); if (i >= 0 && args.return_unit !== 'chunk') x.chunk_text = bodies[i]; }
      return { ...r, raw: JSON.stringify(r.data, null, 2) };
    };
    const frozenFp = specFingerprint(f.q.pages.map((p, i) => ({ source_id: 'default', slug: p.slug, chunk_id: f.q.hits5[i].chunk_id, chunk_text: bodies[i], delivered: { unit: 'page', chunk_ids: [f.q.hits5[i].chunk_id] } })));
    f.q.arms.page = { ...f.q.arms.page, product_fingerprint: frozenFp, product_encoding_tokens: 21 };
    const rec = await checkQuestion(t, f.q, 'What happened to the widget I bought?', [manifest.arms.find(a => a.id === 'page')!], f.store, specFingerprint, s => s.length);
    expect(rec.live_hits_match_frozen).toBe(true);
    const page = rec.arms[0];
    expect(page).toMatchObject({ local_remote_match: true, product_path_match: true, tokens_match: true, uncontained_segments: 0 });
    expect(page.page_parity).toMatchObject({ frontmatter_only: 3 });
    expect(t.calls).toEqual(['query:chunk', 'assemble_evidence:page', 'query:page', 'assemble_evidence:page']);
  });

  test('retrieval drift and text the page does not contain are reported', async () => {
    const f = fixture();
    const rec = await checkQuestion(stub(f.q, { tamper: true, drift: true }), f.q, 'q', [manifest.arms.find(a => a.id === 'page')!], f.store, specFingerprint, s => s.length);
    expect(rec.live_hits_match_frozen).toBe(false);
    expect(rec.arms[0].uncontained_segments).toBe(3);
    expect(rec.arms[0].product_path_match).toBe(false);
    expect(uncontainedSegments('**user:** The widget broke, so I returned it.\n\n[…]\n\nnot there', f.store.get(f.q.pages[1].harness_body))).toEqual(['not there']);
  });

  test('answers are scored from the exact serialized chunk_text', () => {
    const f = fixture();
    const serialized = [{ slug: f.slugs[1], chunk_text: 'exact bytes \u00e9 from the server' }];
    const { request } = requestFromSerialized(RENDERER, f.q, { question: 'q?', question_date: 'd' }, serialized, SONNET, 1024);
    expect(request.messages[0].content).toContain('<chat_session id="s-bbbbbbbbbb" date="2025/02/03 (Mon) 11:00">\nexact bytes \u00e9 from the server\n</chat_session>');
  });
});

describe('every paid call goes through the budget ledger', () => {
  let guard: PaidRequestGuard | null = null;
  afterEach(() => { guard?.uninstall(); guard = null; });

  const openAiReply = (text: string) => new Response(JSON.stringify({ model: 'gpt-4o-2024-08-06', choices: [{ message: { content: text } }], usage: { prompt_tokens: 500, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });

  test('the official judge is reserved and reconciled at the snapshot price', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ed-ledger-'));
    const run = BudgetRun.open({ runner: 'test', budgetUsd: 1, ledgerPath: join(dir, 'l.json'), programCapUsd: 10 });
    guard = installPaidRequestGuard(run, { fetchImpl: (async () => openAiReply('Yes')) as unknown as typeof fetch });
    const r = await officialJudge({ question_id: 'q', question_type: 'multi-session', question: 'Q', answer: 'A' }, 'resp');
    expect(r).toMatchObject({ off_judge_correct: true });
    const s = run.summary();
    expect(s).toMatchObject({ requests: 1, charged_reservations: 0, input_tokens: 500, output_tokens: 1 });
    expect(s.actual_usd).toBeCloseTo((500 * 2.5 + 10) / 1e6, 12);
  });

  test('a refused reservation stops the judge instead of being retried or scored', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ed-ledger-'));
    const run = BudgetRun.open({ runner: 'test', budgetUsd: 0.000001, ledgerPath: join(dir, 'l.json'), programCapUsd: 10 });
    let sent = 0;
    guard = installPaidRequestGuard(run, { fetchImpl: (async () => { sent++; return openAiReply('Yes'); }) as unknown as typeof fetch });
    await expect(officialJudge({ question_id: 'q', question_type: 'multi-session', question: 'Q', answer: 'A' }, 'resp')).rejects.toBeInstanceOf(BudgetExceededError);
    expect(sent).toBe(0);
  });

  test('E1 rows record the three token counts and never swallow a budget refusal', async () => {
    const f = fixture();
    const fakeG: any = {
      gateway: { chat: async () => ({ text: 'The widget was returned.', usage: { input_tokens: 900, output_tokens: 40, cache_read_tokens: 100, cache_creation_tokens: 0 }, stopReason: 'end', model: 'anthropic:claude-sonnet-4-6' }) },
      judge: { judgeRow: async () => ({ judge_correct: true }) },
      judgeRunner: { BudgetLedger: class { constructor() {} } },
    };
    const ctx = { g: fakeG, manifest, manifestSha: 'm', header: { gbrain: { commit: 'c' } }, frozenSha: 'f', store: f.store, questions: new Map([[f.q.question_id, f.q]]), renderer: RENDERER, dataset: f.dataset, clusters: {}, outDir: '/unused', set: 'pilot', readerModel: SONNET, evalsCommit: 'e', smoke: true } as unknown as E1Context;
    const dir = mkdtempSync(join(tmpdir(), 'ed-ledger-'));
    const run = BudgetRun.open({ runner: 'test', budgetUsd: 1, ledgerPath: join(dir, 'l.json'), programCapUsd: 10 });
    guard = installPaidRequestGuard(run, { fetchImpl: (async () => openAiReply('no')) as unknown as typeof fetch });
    const row = await runJob(ctx, { q: f.q, arm: 'page' });
    expect(row.tokens).toMatchObject({ product_encoding: 10, provider_input: 1000, provider_output: 40 });
    expect(row).toMatchObject({ primary: 1, confirmation: 0, arm: 'page' });
    fakeG.gateway.chat = async () => { throw new BudgetExceededError('cap'); };
    await expect(runJob(ctx, { q: f.q, arm: 'chunk' })).rejects.toBeInstanceOf(BudgetExceededError);
  });

  test('smoke runs are capped at $3 and real runs must join the campaign run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ed-guard-'));
    const ledger = join(dir, 'l.json');
    expect(() => paidGuard(new Args(['--smoke', '--budget-usd', '5', '--budget-ledger', ledger]), manifest, 'x', 1)).toThrow('--budget-usd <= 3');
    const other = BudgetRun.open({ runner: 'not-campaign', budgetUsd: 1, ledgerPath: ledger, programCapUsd: 1000 });
    expect(() => paidGuard(new Args(['--budget-run-id', other.runId, '--budget-ledger', ledger]), manifest, 'x', 1)).toThrow('is not an evidence-delivery-campaign run');
    expect(() => paidGuard(new Args(['--budget-ledger', ledger]), manifest, 'x', 1)).toThrow('--budget-run-id');
  });

  test('the cost plan stays inside the $400 campaign cap with a retry margin', () => {
    const plan = costPlan();
    expect(plan.with_retry_margin_usd).toBeLessThan(manifest.budget.campaign_cap_usd);
    expect(plan.lines.length).toBe(7);
  });

  test('the official judge prompt is the verbatim upstream text', () => {
    expect(officialJudgePrompt('multi-session', 'Q', 'A', 'R', false)).toContain('If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: Q\n\nCorrect Answer: A\n\nModel Response: R\n\nIs the model response correct? Answer yes or no only.');
    expect(officialJudgePrompt('temporal-reasoning', 'Q', 'A', 'R', true)).toContain('Does the model correctly identify the question as unanswerable?');
  });
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importGbrain, resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { ABORT_CODES, GuardRefusal, LiveRecallAbort, classifySql, installGuards, readOnlyUrl, verifyReadOnly } from '../../eval/runner/live-recall/brain.ts';
import { FIXTURE_DIR, buildFixtureBrain, freezeSummary, liveRecall, parseQuestions, presenceCheck, runQuestions, type Question, type SearchContext } from '../../eval/runner/live-recall/run.ts';
import { ARMS, buildScorecard, compareRuns, renderMarkdown, scanForLeaks, validateScorecard, type QueryRecord } from '../../eval/runner/live-recall/scorecard.ts';

const gut = resolveGbrainUnderTest(null);
const fixtureText = readFileSync(join(FIXTURE_DIR, 'questions.jsonl'), 'utf8');
const fixtureQuestions = parseQuestions(fixtureText);
const CANARY_FORM = 'Where is the zebracanary7731 runbook kept';
const abortCode = async (p: Promise<unknown> | (() => unknown)) => {
  try { await (typeof p === 'function' ? p() : p); return 'no abort'; } catch (e) { return e instanceof LiveRecallAbort ? e.code : String(e); }
};

describe('live-recall fixture control (keyless)', () => {
  let dir: string;
  let paths: { scorecard: string; markdown: string; detail: string };
  const terminal: string[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'live-recall-'));
    const canary = { id: 'canary-1', type: 'topic', forms: { exact: CANARY_FORM, paraphrase: 'zebracanary7731 paraphrase form' }, gold: [{ slug: 'runbooks/oncall-handbook' }], gold_found_by: 'page_first' };
    const questionsPath = join(dir, 'questions.jsonl');
    writeFileSync(questionsPath, fixtureText + JSON.stringify(canary) + '\n');
    paths = await liveRecall({ fixture: true, questionsPath, databaseUrlEnv: 'UNUSED', out: join(dir, 'run'), gut }, line => terminal.push(line));
  }, 180_000);
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test('writes a valid control scorecard with every arm and the expected n', () => {
    const card = JSON.parse(readFileSync(paths.scorecard, 'utf8'));
    expect(() => validateScorecard(card)).not.toThrow();
    expect(card.run.control).toBe(true);
    expect(card.run.barrier).toBe('copy');
    expect(card.questions.loaded).toBe(21);
    expect(card.eligibility.eligible_question_forms).toBe(42);
    expect(card.eligibility.invalid_arms).toEqual({});
    for (const arm of ['keyword', 'vector', 'hybrid_lexical', 'hybrid', 'configured']) expect(card.arms[arm].overall.all.n).toBe(42);
    expect(card.arms.configured_window.overall.all.n).toBe(8);
    expect(card.comparisons.filter((c: any) => c.primary === 'P1' || c.primary === 'P2').map((c: any) => c.id + ':' + c.metric)).toEqual([
      'p1_hybrid_vs_keyword:success_at_5', 'p1_hybrid_vs_keyword:mrr', 'p2_configured_vs_keyword_paraphrase:success_at_5', 'p2_configured_vs_keyword_paraphrase:mrr',
    ]);
    expect(card.custody.readonly_verified_end).toBe(true);
    expect(card.arms.configured.overall.all.model_calls.rerank).toBe(42);
    expect(card.arms.keyword.overall.all.model_calls).toEqual({});
  });

  test('no question form, gold slug or retrieved slug reaches the outbound files or the terminal', () => {
    const outbound = readFileSync(paths.scorecard, 'utf8') + readFileSync(paths.markdown, 'utf8') + terminal.join('\n');
    expect(outbound).not.toContain('zebracanary7731');
    const pages = readFileSync(paths.detail, 'utf8').split('\n').filter(Boolean).flatMap(l => (JSON.parse(l) as QueryRecord).pages);
    for (const needle of new Set([...pages, ...fixtureQuestions.flatMap(q => [...Object.values(q.forms), ...q.gold.map(g => g.slug)])])) expect(outbound).not.toContain(needle as string);
    expect(readFileSync(paths.detail, 'utf8')).toContain('runbooks/oncall-handbook');
  });

  test('a scorecard carrying private text is refused before it is written', () => {
    const card = JSON.parse(readFileSync(paths.scorecard, 'utf8'));
    const withString = structuredClone(card);
    withString.arms.keyword.overall.all.n = CANARY_FORM;
    expect(() => validateScorecard(withString)).toThrow(LiveRecallAbort);
    const withKey = structuredClone(card);
    withKey.arms.keyword.overall['runbooks/oncall-handbook'] = 1;
    expect(() => validateScorecard(withKey)).toThrow(LiveRecallAbort);
    try { validateScorecard(withString); } catch (e) { expect(String((e as Error).message)).not.toContain('zebracanary7731'); }
    expect(() => scanForLeaks('| keyword | ' + CANARY_FORM + ' |', [CANARY_FORM])).toThrow(LiveRecallAbort);
    expect(() => scanForLeaks('pages returned', ['pages'])).not.toThrow();
  });
});

describe('live-recall guards on PGLite', () => {
  test('forces read-only transactions, refuses writes and session changes, allows SET LOCAL, and leaves search_telemetry empty', async () => {
    const { engine, close } = await buildFixtureBrain(gut);
    const counters = { refusals: {} as Record<string, number> };
    try {
      installGuards(engine, counters);
      await verifyReadOnly(engine);
      await expect(engine.executeRaw('DELETE FROM pages')).rejects.toBeInstanceOf(GuardRefusal);
      await expect(engine.executeRaw('SET default_transaction_read_only = off')).rejects.toBeInstanceOf(GuardRefusal);
      expect(await engine.transaction(async (tx: any) => (await tx.executeRaw("SELECT current_setting('transaction_read_only') AS ro"))[0].ro)).toBe('on');
      await expect(engine.transaction(async (tx: any) => tx.setConfig('live_recall_probe', 'x'))).rejects.toThrow();
      expect(await engine.transaction(async (tx: any) => { await tx.executeRaw("SET LOCAL statement_timeout = '5s'"); return true; })).toBe(true);
      const { hybridSearch } = await importGbrain<any>(gut, 'src/core/search/hybrid.ts');
      const { withAIInvocationGuard } = await importGbrain<any>(gut, 'src/core/ai/invocation-guard.ts');
      await runQuestions({ engine, hybridSearch, withGuard: withAIInvocationGuard, rerankerEnabled: true, embeddingOptedOut: false }, fixtureQuestions);
      expect(counters.refusals.telemetry_write).toBeGreaterThan(0);
      const [row] = await engine.executeRaw('SELECT count(*)::int AS n FROM search_telemetry');
      expect(row.n).toBe(0);
    } finally {
      await close();
    }
  }, 180_000);

  test('classifySql allows reads and transaction-local settings only', () => {
    const ok = ['SELECT 1', 'WITH a AS (SELECT 1) SELECT * FROM a', "SELECT set_config('search_path', 'public', true)", "SET LOCAL hnsw.ef_search = 100", 'BEGIN READ ONLY', 'COMMIT', "SELECT 'insert into x' AS literal", 'SELECT 1 -- delete from pages'];
    for (const sql of ok) expect([sql, classifySql(sql).ok]).toEqual([sql, true]);
    const refused: Array<[string, string]> = [
      ['INSERT INTO pages (slug) VALUES (1)', 'insert'], ['UPDATE pages SET title = 1', 'update'], ['DELETE FROM pages', 'delete'], ['TRUNCATE pages', 'truncate'],
      ['SET statement_timeout = 0', 'set_session'], ["SELECT set_config('statement_timeout', '0', false)", 'set_config_session'], ['SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE', 'read_only_setting'],
      ['BEGIN READ WRITE', 'begin_read_write'], ['WITH x AS (DELETE FROM pages RETURNING 1) SELECT 1', 'data_modifying_cte'], ["SELECT nextval('s')", 'write_function'],
      ['CREATE TABLE t (a int)', 'create'], ['SELECT 1; DROP TABLE pages', 'drop'], ['INSERT INTO search_telemetry (date) VALUES (now())', 'telemetry_write'],
    ];
    for (const [sql, verb] of refused) expect([sql, classifySql(sql)]).toEqual([sql, { ok: false, verb }]);
  });

  test('readOnlyUrl moves a transaction-pooler URL to the session pooler and asks for read-only sessions', () => {
    const r = readOnlyUrl('postgresql://u:p@aws-0.pooler.supabase.com:6543/postgres?pgbouncer=true');
    expect(r.connection).toBe('transaction_pooler_rewritten');
    expect(r.url).toBe('postgresql://u:p@aws-0.pooler.supabase.com:5432/postgres?default_transaction_read_only=on');
    expect(readOnlyUrl('postgres://u:p@127.0.0.1:55432/brain').connection).toBe('direct_or_local');
  });
});

describe('live-recall scoring and refusals', () => {
  const q = (id: string, slug: string, extra: Partial<Question> = {}): Question => ({ id, type: 'topic', forms: { exact: 'exact ' + id, paraphrase: 'para ' + id }, gold: [{ slug }], gold_found_by: 'page_first', ...extra });
  const questions = [q('a', 'p/a'), q('b', 'p/b'), q('c', 'p/c', { type: 'time_window', window: { since: '2026-01-01', until: '2026-01-31' } })];
  const goldFor = (text: string) => 'p/' + text.split(' ')[1];
  const fakeCtx = (answer: (text: string) => string[], onSearch?: () => Promise<void>): SearchContext => {
    const rows = (text: string) => answer(text).map((slug, i) => ({ slug, chunk_id: i + 1, rerank_score: 1 }));
    let embedded = '';
    return {
      engine: { searchKeyword: async (t: string) => rows(t), searchVector: async () => rows(embedded), getPage: async () => ({}) },
      hybridSearch: async (_e: unknown, text: string, opts: any) => { embedded = text; await onSearch?.(); opts.onQueryEmbedding?.(new Float32Array(4)); opts.onMeta?.({ degraded: [] }); return rows(text); },
      withGuard: async (_g, run) => run(),
      rerankerEnabled: true,
      embeddingOptedOut: false,
    };
  };
  const identity = { started_at: '2026-11-06T00:00:00.000Z', finished_at: '2026-11-06T00:00:01.000Z', runner_commit: 'abcdef1', runner_dirty: false, gbrain_pin_version: '0.60.557.0', gbrain_pin_commit: 'abcdef1', gbrain_loaded_version: '0.60.577.0', gbrain_loaded_commit: 'abcdef2', gbrain_overlay: true, schema_version: 286, engine: 'pglite' as const, barrier: 'copy', connection: 'in_process', search_mode: 'balanced', reranker_enabled: true, reranker_model: 'voyage:rerank-3-lite', embedding_model: 'openai:text-embedding-3-small', mode_expansion: false, control: true };
  const summary = { loaded: 3, gold_missing: 0, by_type: {}, gold_found_by: {}, paraphrase_shares_identifier_token: 0, freeze_sha_prefix: 'abcdef123456' };
  const custody = { readonly_verified_start: true, readonly_verified_end: true, guard_refusals: {} };

  test('an oracle retriever scores 1 and an empty one scores 0 on every arm', async () => {
    const oracle = buildScorecard(await runQuestions(fakeCtx(t => [goldFor(t)]), questions), summary, identity, custody) as any;
    const empty = buildScorecard(await runQuestions(fakeCtx(() => []), questions), summary, identity, custody) as any;
    for (const arm of ARMS) {
      expect([arm, oracle.arms[arm].overall.all.success_at.k1.rate, oracle.arms[arm].overall.all.mrr.mean]).toEqual([arm, 1, 1]);
      expect([arm, empty.arms[arm].overall.all.success_at.k20.rate]).toEqual([arm, 0]);
    }
    expect(oracle.arms.configured_window.overall.all.n).toBe(2);
    expect(renderMarkdown(oracle)).toContain('| keyword | 6 | 100.0 |');
  });

  test('a configured result without rerank scores counts as fail-open and past the cap invalidates the arm', async () => {
    const ctx = fakeCtx(t => [goldFor(t)]);
    const plain = ctx.hybridSearch;
    ctx.hybridSearch = async (e, text, opts) => (await plain(e, text, opts)).map(({ rerank_score: _r, ...rest }) => rest);
    const card = buildScorecard(await runQuestions(ctx, questions), summary, identity, custody) as any;
    expect(card.arms.configured).toEqual({ invalid: 'rerank_fail_open_over_cap' });
  });

  test('the AI guard refuses a chat call inside an arm and marks the query', async () => {
    const { invokeAI, withAIInvocationGuard } = await importGbrain<any>(gut, 'src/core/ai/invocation-guard.ts');
    const ctx = fakeCtx(t => [goldFor(t)], () => invokeAI({ operation: 'probe', model: 'x', kind: 'chat' }, async () => 'answer', () => null));
    ctx.withGuard = withAIInvocationGuard;
    const records = await runQuestions(ctx, questions.slice(0, 1));
    expect(records.filter(r => r.arm === 'hybrid').map(r => [r.status, r.calls.chat])).toEqual([['ai_refused', 1], ['ai_refused', 1]]);
    expect(records.filter(r => r.arm === 'keyword').map(r => r.status)).toEqual(['ok', 'ok']);
  });

  test('absent gold pages are dropped and counted, and past 10% the run aborts', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => q('q' + i, 'p/' + i));
    const engine = (missing: number) => ({ getPage: async (slug: string) => (Number(slug.slice(2)) < missing ? null : {}) });
    expect((await presenceCheck(engine(2), twenty)).missing).toBe(2);
    expect(await abortCode(presenceCheck(engine(3), twenty))).toBe('LR_GOLD_MISSING_CAP');
  });

  test('a counted run refuses a question file that does not match its freeze, before opening any database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'live-recall-freeze-'));
    try {
      writeFileSync(join(dir, 'q.jsonl'), fixtureText);
      writeFileSync(join(dir, 'freeze.json'), JSON.stringify(freezeSummary(fixtureText + '\n', fixtureQuestions)));
      expect(await abortCode(liveRecall({ fixture: false, questionsPath: join(dir, 'q.jsonl'), freezePath: join(dir, 'freeze.json'), databaseUrlEnv: 'LIVE_RECALL_TEST_UNSET', out: join(dir, 'out'), gut }, () => {}))).toBe('LR_FREEZE_MISMATCH');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('question-file refusals name the line and field, never the content', () => {
    const bad = [JSON.stringify({ id: 'x', type: 'not-a-type', forms: { exact: 'zebracanary7731' }, gold: [{ slug: 'secret/slug' }] })];
    try { parseQuestions(bad.join('\n')); throw new Error('accepted'); } catch (e) {
      expect(e).toBeInstanceOf(LiveRecallAbort);
      expect((e as LiveRecallAbort).code).toBe('LR_QUESTIONS_INVALID');
      expect((e as Error).message).toBe('LR_QUESTIONS_INVALID: line 1 field type');
    }
    expect(() => parseQuestions('{"id":"a","type":"topic","forms":{"exact":"x"},"gold":[{"slug":"p"}]}')).toThrow('line 1 field forms.paraphrase');
    expect(() => parseQuestions('{"id":"a","type":"topic","forms":{"exact":"x","paraphrase":"y"},"gold":[]}')).toThrow('line 1 field gold');
    expect(() => parseQuestions('{"id":"a","type":"topic","forms":{"exact":"x","paraphrase":"y"},"gold":[{"slug":"p"}],"gold_found_by":"guess"}')).toThrow('field gold_found_by');
    for (const code of Object.keys(ABORT_CODES)) expect(code).toMatch(/^LR_[A-Z_]+$/);
  });

  test('freeze reports counts, the file hash and the minimum detectable difference, and nothing else', () => {
    const f = freezeSummary(fixtureText, fixtureQuestions);
    expect(f.n_questions).toBe(20);
    expect(f.windowed_time_window).toBe(4);
    expect(f.questions_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(f.mde_success_at_5.p2_paraphrase.pd20).toBeCloseTo(2.8016 * Math.sqrt(0.2 / 20), 3);
    expect(JSON.stringify(f)).not.toContain('HRN-2041');
  });

  test('compare pairs two runs per arm and form and emits aggregates only', async () => {
    const a = await runQuestions(fakeCtx(t => [goldFor(t)]), questions);
    const b = await runQuestions(fakeCtx(t => (t.startsWith('para') ? [] : [goldFor(t)])), questions);
    const result = compareRuns(a, b) as any;
    expect(() => validateScorecard(result)).not.toThrow();
    const hybridPara = result.comparisons.find((c: any) => c.id === 'run_b_vs_run_a_hybrid_paraphrase' && c.metric === 'success_at_5');
    expect([hybridPara.n_pairs, hybridPara.delta, hybridPara.top5_changed]).toEqual([3, -1, 3]);
    expect(JSON.stringify(result)).not.toContain('p/a');
  });
});

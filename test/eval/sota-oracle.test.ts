/**
 * The SOTA oracle (eval/runner/sota/oracle.ts) on memory-qa's invented fixture, with every provider call answered in
 * process: the reader receives only each question's gold sessions, the cache row records the answer's finish_reason
 * and the digest of exactly that prompt, an empty answer cut at its limit has no verdict, and a rerun buys nothing.
 * Nothing reaches a provider: fetch is replaced for the whole test and the keys stay blank.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetRun, closeLedgers, initLedger } from '../../eval/runner/budget-ledger.ts';
import { loadSplit } from '../../eval/runner/decisions/splits.ts';
import { loadFixture } from '../../eval/runner/memory-qa/corpus.ts';
import { judgeFor } from '../../eval/runner/nightly/adapters.ts';
import { CACHE_SCHEMA, freshness, OutcomeCache, staleMessage } from '../../eval/runner/sota/cache.ts';
import { a4Rows, a4Spec, EXPORT_READER, main, ORACLE_READERS, oracleJudge, oraclePrompt, oracleSpec, poolItems, runOracle } from '../../eval/runner/sota/oracle.ts';
import { FRONTIER_READERS } from '../../eval/runner/systems/baselines.ts';

const roots: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'sota-oracle-')); roots.push(d); return d; };
afterAll(() => { closeLedgers(); for (const d of roots) rmSync(d, { recursive: true, force: true }); });
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const READER = 'I will give you several history chats';

/** Answers every provider call in process: the reader on OpenAI's chat shape, the judge on Anthropic's messages shape. */
function stubFetch(cutQuestion: string) {
  const prompts: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string | Array<{ text: string }> }> };
    const first = body.messages[0]!.content;
    const prompt = typeof first === 'string' ? first : first.map(p => p.text).join('');
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('anthropic')) return json({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'yes' }], stop_reason: 'end_turn', usage: { input_tokens: 50, output_tokens: 1 } });
    if (!prompt.startsWith(READER)) throw new Error(`unexpected call to ${url}`);
    prompts.push(prompt);
    const cut = prompt.includes(`Question: ${cutQuestion}\n`);
    return json({ choices: [{ message: { content: cut ? '' : 'The answer.' }, finish_reason: cut ? 'length' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: cut ? 64 : 3 } });
  }) as never;
  return { prompts, restore: () => { globalThis.fetch = real; } };
}

describe('the oracle reader', () => {
  test('sees only each question\'s gold sessions; the row keeps that prompt\'s digest and its finish_reason; a cut-off empty answer has no verdict; a rerun buys nothing', async () => {
    const fx = loadFixture();
    const items = fx.questions.map(q => q.id);
    const cutQ = fx.questions.find(q => q.gold.length)!;
    const dir = scratch(), ledger = join(dir, 'ledger.sqlite');
    initLedger({ ledgerPath: ledger });
    const budgetRunId = BudgetRun.open({ runner: 'test', budgetUsd: 1, estimateUsd: 0.1, ledgerPath: ledger }).runId;
    const opts = { benchmark: 'fixture', reader: 'openai:gpt-4o-mini', items, cache: join(dir, 'cache'), work: join(dir, 'work'), budgetLedger: ledger, budgetRunId };
    const stub = stubFetch(cutQ.question);
    try {
      const first = await runOracle(opts);
      expect(first).toEqual({ bought: items.length, fresh: 0, errored: [] });
      const spec = oracleSpec('fixture', 'openai:gpt-4o-mini', 1024);
      const cache = new OutcomeCache(opts.cache);
      for (const q of fx.questions) {
        const conv = fx.conversations.find(c => c.id === q.conversation)!;
        const expected = oraclePrompt(q, conv.sessions);
        const sent = stub.prompts.find(p => p.includes(`Question: ${q.question}\n`))!;
        expect(sent).toBe(expected);
        expect((sent.match(/### Session \d+:/g) ?? []).length).toBe(q.gold.length);
        for (const s of conv.sessions) expect(sent.includes(JSON.stringify(s.turns.map(t => ({ role: t.speaker, content: t.content }))))).toBe(q.gold.includes(s.id));
        const hit = cache.lookup(spec, q.id, sha256(expected));
        expect(hit.status).toBe('hit');
        const row = (hit as { row: { finish_reason: string; pass: boolean | null; score: number | null; judge: string; max_tokens: number } }).row;
        expect(row).toMatchObject({ judge: 'anthropic:claude-opus-5-5', max_tokens: 1024 });
        expect(row).toMatchObject(q.id === cutQ.id ? { finish_reason: 'max_tokens', pass: null, score: null } : { finish_reason: 'stop', pass: true, score: 1 });
      }
      const calls = stub.prompts.length;
      expect(await runOracle(opts)).toEqual({ bought: 0, fresh: items.length, errored: [] });
      expect(stub.prompts.length).toBe(calls);
    } finally {
      stub.restore();
    }
  }, 60_000);
});

describe('the oracle work directory', () => {
  test('a re-buy on changed inputs runs in its own directory under the same --work, so memory-qa never refuses the earlier run\'s output', async () => {
    const fx = loadFixture();
    const items = fx.questions.map(q => q.id);
    const dir = scratch(), ledger = join(dir, 'ledger.sqlite');
    initLedger({ ledgerPath: ledger });
    const budgetRunId = BudgetRun.open({ runner: 'test', budgetUsd: 1, estimateUsd: 0.1, ledgerPath: ledger }).runId;
    const opts = { benchmark: 'fixture', reader: 'openai:gpt-4o-mini', items, cache: join(dir, 'cache'), work: join(dir, 'work'), budgetLedger: ledger, budgetRunId };
    const stub = stubFetch('no question is cut off');
    try {
      expect(await runOracle(opts)).toEqual({ bought: items.length, fresh: 0, errored: [] });
      expect(await runOracle({ ...opts, maxTokens: 2048 })).toEqual({ bought: items.length, fresh: 0, errored: [] });
    } finally {
      stub.restore();
    }
  }, 60_000);
});

describe('oracle specs', () => {
  test('judges with the nightly\'s QA judge for the reader\'s family: GPT-6.2 Astra grades Claude and particle-1 answers, Opus grades GPT answers', () => {
    const readers = ['anthropic:claude-opus-5-5', 'openai:gpt-6.1-sol', 'particle:particle-1'];
    expect(readers.map(oracleJudge)).toEqual(['openai:gpt-6.2-astra', 'anthropic:claude-opus-5-5', 'openai:gpt-6.2-astra']);
    expect(readers.map(oracleJudge)).toEqual(readers.map(judgeFor));
  });

  test('the judge is part of the spec: a row graded by GPT-6 Astra is stale under GPT-6.2 Astra and names the change', () => {
    const spec = oracleSpec('lme-s', 'anthropic:claude-opus-5-5');
    const item = poolItems('lme-s')[0]!;
    const cache = new OutcomeCache(scratch());
    cache.put([{ ...spec, judge: 'openai:gpt-6-astra', schema: CACHE_SCHEMA, item, context_digest: 'c', score: 1, pass: true, finish_reason: 'stop',
      usage: { reader_input: 5317, reader_output: 40, judge_input: 600, judge_output: 5 }, at: '2026-11-23T00:00:00.000Z', source: 'GBEV-119 refresh' }]);
    const f = freshness(cache, spec, [item]);
    expect([f.hits.size, f.stale.map(s => s.changed)]).toEqual([0, [['judge']]]);
    expect(staleMessage(f, 'items.txt', 'cache')).toContain('changed judge: openai:gpt-6-astra -> openai:gpt-6.2-astra (1 rows)');
  });

  test('the three nightly readers take their suite\'s 8,192-token output limit, particle-1 its 16,000-token floor, and the pool is the nightly suites\' items', () => {
    expect(oracleSpec('beam-1m', 'anthropic:claude-opus-5-5')).toMatchObject({ max_tokens: 8192, judge: 'openai:gpt-6.2-astra', system: 'oracle' });
    expect(oracleSpec('beam-1m', 'openai:gpt-6.2-sol')).toMatchObject({ max_tokens: 8192, judge: 'anthropic:claude-opus-5-5', system_version: oracleSpec('lme-s', 'openai:gpt-6.2-sol').system_version });
    expect(oracleSpec('lme-s', 'openai:gpt-6.1-sol')).toMatchObject({ max_tokens: 8192, judge: 'anthropic:claude-opus-5-5' });
    expect(oracleSpec('beam-1m', 'particle:particle-1')).toMatchObject({ max_tokens: 16_000, judge: 'openai:gpt-6.2-astra' });
    expect(ORACLE_READERS).toEqual([...FRONTIER_READERS, 'particle:particle-1']);
    expect(ORACLE_READERS).toEqual(['anthropic:claude-opus-5-5', 'openai:gpt-6.2-sol', 'particle:particle-1']);
    expect(EXPORT_READER).toBe('openai:gpt-6.1-sol');
    expect([poolItems('beam-1m').length, poolItems('lme-s').length]).toEqual([126, 50]);
  });

  test('a BEAM-1M run reads the dev conversations only, never a held-out one', () => {
    const empty = scratch();
    const probe = `import { runOracle } from './eval/runner/sota/oracle.ts';
      try { await runOracle({ benchmark: 'beam-1m', reader: 'anthropic:claude-opus-5-5', items: ['1m-2:event_ordering:0'], cache: '${scratch()}', work: '${scratch()}', budgetLedger: 'x', budgetRunId: 'x' }); console.log('no error'); }
      catch (e) { console.log(String((e as Error).message)); }`;
    const out = spawnSync('bun', ['-e', probe], { cwd: join(import.meta.dir, '../..'), env: { PATH: process.env.PATH!, HOME: empty, GBRAIN_EVALS_DATASETS: empty }, encoding: 'utf8' }).stdout;
    const missing = /chats\/1M\/(\d+)\//.exec(out)?.[1];
    expect(out).toContain('DATASET_MISSING');
    expect(loadSplit('beam-1m').dev).toContain(`1m-${missing}`);
  });

  test('plan lists the nightly\'s gpt-6.2-sol beside Opus and particle-1 on both benchmarks, and lists gpt-6.1-sol for the answerability files without a buy file no window reads', async () => {
    const cache = scratch(), lines: string[] = [];
    expect(await main(['plan', '--cache', cache], s => lines.push(s))).toBe(0);
    expect(lines.map(l => l.split(':').slice(0, 2).join(':'))).toEqual(['beam-1m', 'lme-s'].flatMap(b => [...ORACLE_READERS, EXPORT_READER].map(r => `${b} ${r}`)));
    expect(lines).toContain(`beam-1m openai:gpt-6.2-sol: 126 items, 0 fresh, 126 unknown, 0 stale; to buy: ${join(cache, 'plan', 'oracle-beam-1m-openai_gpt-6.2-sol.txt')}`);
    expect(lines).toContain(`lme-s openai:gpt-6.2-sol: 50 items, 0 fresh, 50 unknown, 0 stale; to buy: ${join(cache, 'plan', 'oracle-lme-s-openai_gpt-6.2-sol.txt')}`);
    expect(lines).toContain('lme-s openai:gpt-6.1-sol: 50 items, 0 fresh, 50 unknown, 0 stale');
    expect(existsSync(join(cache, 'plan', 'oracle-lme-s-openai_gpt-6.1-sol.txt'))).toBe(false);
    expect(lines).toContain('beam-1m openai:gpt-6.1-sol: 126 items, 0 fresh, 126 unknown, 0 stale');
  });

  test('Sol\'s BEAM-1M rows are A4\'s, pinned: every pool item is covered, and a re-buy is refused', async () => {
    expect(oracleSpec('beam-1m', 'openai:gpt-6.1-sol')).toEqual(a4Spec());
    const rows = a4Rows('2026-11-20T00:00:00Z');
    expect(rows).toHaveLength(220);
    const ids = new Set(rows.map(r => r.item));
    expect(poolItems('beam-1m').every(id => ids.has(id))).toBe(true);
    expect(rows.filter(r => r.pass === null).every(r => r.finish_reason === 'length')).toBe(true);
    await expect(runOracle({ benchmark: 'beam-1m', reader: 'openai:gpt-6.1-sol', items: ['1m-2:event_ordering:0'], cache: scratch(), work: scratch(), budgetLedger: 'x', budgetRunId: 'x' })).rejects.toThrow('run import-a4');
  });
});

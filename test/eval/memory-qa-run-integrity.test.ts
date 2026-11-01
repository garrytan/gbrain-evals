/**
 * memory-qa run integrity (fix wave 2, memory-qa group): gbrain think's reference date on the memory-system harness's
 * legacy gbrain lane (#210), a budget stop that says why and exits non-zero (#216), the reading lane's judging path and
 * output limits in the run config hash (#248), and usage by role over each question's latest row (#251). Keyless:
 * provider responses come from a mocked fetch or a loopback server, every key is a placeholder, and the stopped runs are
 * refused by the budget ledger before any request leaves the process.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetRun, closeLedgers, initLedger } from '../../eval/runner/budget-ledger.ts';
import { resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { loadCorpus } from '../../eval/runner/memory-qa/corpus.ts';
import { ChatClient } from '../../eval/runner/memory-qa/qa-v2.ts';
import * as memoryQa from '../../eval/runner/memory-qa/run.ts';
import * as systems from '../../eval/runner/memory-qa/run-systems.ts';

const ROOT = join(import.meta.dir, '../..');
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'memory-qa-integrity-')); dirs.push(d); return d; };
const ENV = ['PARTICLE_API_KEY', 'PARTICLE_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'GBRAIN_EVALS_QA_CACHE'] as const;
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
const realFetch = globalThis.fetch;
beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, { PARTICLE_API_KEY: 'test-key', OPENAI_API_KEY: 'test', ANTHROPIC_API_KEY: 'test', GBRAIN_EVALS_QA_CACHE: join(tmp(), 'qa-cache') });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  closeLedgers();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PARTICLE_OK = {
  id: 'chatcmpl-1', object: 'chat.completion', model: 'particle-ai/particle-1', service_tier: 'default', system_fingerprint: 'fp_1', metadata: { weight_version: 'default' },
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '85 dollars.' } }],
  usage: { prompt_tokens: 330, completion_tokens: 86, total_tokens: 416, prompt_tokens_details: { cached_tokens: 256 }, completion_tokens_details: { reasoning_tokens: 49 } },
};
const OPENAI_YES = { model: 'gpt-4o-mini', choices: [{ finish_reason: 'stop', message: { content: 'yes' } }], usage: { prompt_tokens: 300, completion_tokens: 1 } };
const ANTHROPIC_OK = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: '85 dollars' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } };

/** Mock fetch: Particle, OpenAI and Anthropic each answer with one canned success. Records every request. */
function serve() {
  const seen: Array<{ host: string; body: Record<string, any> }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    seen.push({ host: url.hostname, body: JSON.parse(String(init?.body)) });
    const body = { 'api.particle.ai': PARTICLE_OK, 'api.openai.com': OPENAI_YES, 'api.anthropic.com': ANTHROPIC_OK }[url.hostname];
    if (!body) throw new Error(`unexpected request to ${url.hostname}`);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const on = (host: string) => () => seen.filter(s => s.host === host);
  return { particle: on('api.particle.ai'), openai: on('api.openai.com'), anthropic: on('api.anthropic.com') };
}

/** A paid ledger run for runArm: `--paid --budget-run-id <id> --budget-ledger <path>`. */
function paidArgs(budgetUsd = 1) {
  const ledger = join(tmp(), 'ledger.sqlite');
  initLedger({ ledgerPath: ledger });
  const run = BudgetRun.open({ runner: 'test', budgetUsd, estimateUsd: 0.05, ledgerPath: ledger });
  closeLedgers();
  return ['--paid', '--budget-run-id', run.runId, '--budget-ledger', ledger];
}

type Usage = { records: number; provider_calls: number; cache_hits: number; errors: number; input_total: number };
const byRole = (receipt: Record<string, unknown>) => (receipt.usage as { by_role: Record<string, Usage> }).by_role;

describe('gbrain think on the legacy memory-system lane (#210)', () => {
  // Value: protects=a --system gbrain --qa think row answers relative dates against the conversation's own time, as run.ts's think lane does; fails_when=run-systems.ts calls think without referenceDate, so think answers against the day the run happens, or records no qa_reference_date; why_new=only run.ts's think lane got the reference date (#207), and the memory-system harness's legacy lane kept the run date (#210); seam=systems.runArm over the fixture with real gbrain think and a mocked provider; no_claim=a real model's answer quality
  test('think is asked for the latest session date and each row records the date think reports', async () => {
    const mock = serve();
    const { rows } = await systems.runArm(systems.parseRunArgs(['--benchmark', 'fixture', '--system', 'gbrain', '--embed', 'hash', '--qa', 'think', '--judge', 'openai:gpt-4o-mini', '--limit', '2',
      ...paidArgs(), '--output', join(tmp(), 'out')]));
    const corpus = loadCorpus('fixture');
    const latest = (conv: string) => corpus.conversations.find(c => c.id === conv)!.sessions.map(s => s.date!).sort().pop()!;
    expect(rows.map(r => [r.id, r.qa_error ?? null, (r as { qa_reference_date?: string }).qa_reference_date])).toEqual(rows.map(r => [r.id, null, latest(r.conversation)]));
    const sent = mock.anthropic().map(s => JSON.stringify(s.body.messages));
    expect(sent).toHaveLength(2);
    for (const r of rows) expect(sent.find(body => body.includes(corpus.questions.find(q => q.id === r.id)!.question))).toContain(`Current date: ${latest(r.conversation)}`);
  }, 120_000);
});

describe('a paid run the budget ledger stopped (#216)', () => {
  /** The run.ts CLI in a child process (async, so a loopback server in this process can answer it). */
  const cli = async (argv: string[], env: Record<string, string>) => {
    const proc = Bun.spawn([process.execPath, 'eval/runner/memory-qa/run.ts', ...argv], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, OPENAI_API_KEY: 'test', ANTHROPIC_API_KEY: 'test', PARTICLE_API_KEY: 'test-key', BRAINBENCH_BUDGET_LEDGER: '', ...env } });
    const [, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, err };
  };
  const receipt = (out: string) => JSON.parse(readFileSync(join(out, 'receipt.json'), 'utf8')) as { run_status: string; summary: Record<string, unknown> };

  // Value: protects=a caller (decide.ts, a shootout cell, an operator) learns that a paid run stopped at the ledger and why; fails_when=a guard stop leaves run_status partial with exit 0 and no reason in the receipt; why_new=the stop was reported only as summary.stopped with the process exiting 0 (#216); seam=the run.ts CLI in a child process, refused before any request is sent; no_claim=run-systems.ts's own entry point, which run.ts dispatches memory-system cells to
  test('the cap or an unpriceable host stops the run with the refusal as stop_reason and exit 3, and a rerun that can pay resumes the stopped question', async () => {
    const cases = [
      { name: 'unpriced host', args: ['--reader', 'openai:gpt-4o-mini'], budget: 1, env: { OPENAI_BASE_URL: 'https://unpriced.invalid/v1' }, reason: 'https://unpriced.invalid is not a host the ledger can price' },
      { name: 'cap', args: ['--reader', 'anthropic:claude-opus-5-5', '--qa-max-tokens', '4096'], budget: 0.06, env: {} as Record<string, string>, reason: 'over its $0.06 budget' },
    ];
    const runs = cases.map(c => ({ ...c, out: join(tmp(), 'out'), cache: join(tmp(), 'qa-cache') })).map(c => ({ ...c,
      argv: ['--benchmark', 'fixture', '--qa', 'reader', '--qa-context', 'oracle', '--judge', 'openai:gpt-4o-mini', '--limit', '1', ...c.args, ...paidArgs(c.budget), '--output', c.out] }));
    for (const c of runs) {
      const run = await cli(c.argv, { GBRAIN_EVALS_QA_CACHE: c.cache, ...c.env });
      expect([c.name, run.code]).toEqual([c.name, 3]);
      expect(run.err).toContain('[BUDGET_CAP]');
      expect(run.err).toContain(c.reason);
      const r = receipt(c.out);
      expect(r.run_status).toBe('partial');
      expect(r.summary.stopped).toBe('budget');
      expect(String(r.summary.stop_reason)).toContain(c.reason);
    }
    // The host is reachable now (a loopback stand-in for a registered one): the rerun reads the stopped question and exits 0.
    const server = Bun.serve({ port: 0, fetch: () => Response.json(OPENAI_YES) });
    try {
      const c = runs[0];
      const rerun = await cli(c.argv, { GBRAIN_EVALS_QA_CACHE: c.cache, OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1` });
      expect(rerun.code).toBe(0);
      const r = receipt(c.out);
      expect([r.run_status, 'stopped' in r.summary, r.summary.qa_rows]).toEqual(['complete', false, 1]);
    } finally { server.stop(true); }
  }, 120_000);

  // Value: protects=a ledger refusal that no question row records, such as one inside gbrain's fact extraction, still stops the run with a reason and exit 3; fails_when=only a question's BudgetExceededError sets stopped, so the run ends partial with no stop_reason and exit 0; why_new=the post-loop stop for a refusal no question recorded had no test (pass 1 review of this fix); seam=the run.ts CLI with --facts conversation and the extractor's Anthropic host unpriceable; no_claim=which product call was refused, which the receipt does not name
  test('a refusal no question recorded, here during fact extraction, stops the run with a reason and exit 3', async () => {
    const out = join(tmp(), 'out');
    const run = await cli(['--benchmark', 'fixture', '--facts', 'conversation', '--limit', '1', ...paidArgs(), '--output', out],
      { GBRAIN_EVALS_QA_CACHE: join(tmp(), 'qa-cache'), ANTHROPIC_BASE_URL: 'https://unpriced.invalid' });
    expect(run.code).toBe(3);
    expect(run.err).toContain('[BUDGET_CAP]');
    const r = receipt(out) as { run_status: string; summary: Record<string, unknown>; counts: { rows: number } };
    expect([r.run_status, r.counts.rows, r.summary.stopped]).toEqual(['partial', 0, 'budget']);
    expect(String(r.summary.stop_reason)).toContain('no question recorded as its error');
  }, 120_000);
});

describe('the run config hash covers how the reading lane judges (#248)', () => {
  // Value: protects=a resumed memory-qa run never pools verdicts judged through another path or at another output limit; fails_when=runConfigHash leaves out the judging path or the limit each reader and judge call is sent; why_new=Claude 5 judges moved from a 10-token to a 2,000-token verdict (#228) without changing the run config, so a partial run resumed across that change mixed both (#248); seam=runConfigPreimage, and readAndJudge through a mocked fetch for what is actually sent; no_claim=other runners' run config hashes
  test('the preimage names the judging path and each call\'s output limit as sent, and those are the limits the client sends', async () => {
    const gut = resolveGbrainUnderTest(null), corpus = loadCorpus('fixture');
    const args = (judge: string, reader = 'openai:gpt-4o-mini', extra: string[] = []) => memoryQa.parseRunArgs(['--benchmark', 'fixture', '--qa', 'reader', '--qa-context', 'oracle', '--reader', reader, '--judge', judge, ...extra, '--output', join(tmp(), 'out')]);
    const reading = (a: memoryQa.RunArgs) => memoryQa.runConfigPreimage(a, gut, corpus).reading;
    expect(reading(args('anthropic:claude-sonnet-5-5'))).toEqual({ judging: 'qa-v2 judgeResponse', judge_max_tokens_sent: 2000, reader_max_tokens_sent: 1024 });
    expect(reading(args('openai:gpt-4o-2024-08-06'))).toMatchObject({ judge_max_tokens_sent: 10 });
    expect(reading(args('openai:gpt-4o-mini', 'particle:particle-1'))).toMatchObject({ reader_max_tokens_sent: 16_000 });
    expect(reading(args('openai:gpt-4o-mini', 'openai:gpt-6.1-sol', ['--qa-max-tokens', '512']))).toMatchObject({ reader_max_tokens_sent: 2000 });
    const a = args('anthropic:claude-sonnet-5-5', 'openai:gpt-6.1-sol');
    expect(memoryQa.runConfigHash(a, gut, corpus)).toBe(createHash('sha256').update(JSON.stringify(memoryQa.runConfigPreimage(a, gut, corpus))).digest('hex'));
    const retrievalOnly = memoryQa.parseRunArgs(['--benchmark', 'fixture', '--output', join(tmp(), 'none')]);
    expect('reading' in memoryQa.runConfigPreimage(retrievalOnly, gut, corpus)).toBe(false);
    const mock = serve();
    const q = corpus.questions[0];
    const row = await memoryQa.readAndJudge({ benchmark: 'fixture', qa: a.qa, q, chat: new ChatClient(process.env.GBRAIN_EVALS_QA_CACHE!, () => 0), think: null, prompt: 'What did the vet visit cost?', countTokens: null });
    expect(row.qa_error).toBeUndefined();
    const sent = memoryQa.runConfigPreimage(a, gut, corpus).reading as Record<string, number>;
    expect(mock.openai().map(s => s.body.max_completion_tokens)).toEqual([sent.reader_max_tokens_sent]);
    expect(mock.anthropic().map(s => s.body.max_tokens)).toEqual([sent.judge_max_tokens_sent]);
  });
});

describe('usage by role after a resumed budget stop (#251)', () => {
  // Value: protects=a resumed run's reading-lane usage counts each answer's tokens once; fails_when=usage.by_role sums every row in rows.ndjson, so a budget-stopped row's paid reader and the rerun's cached replay of it both count; why_new=by_role summed all rows while counts and summary read each question's latest row (#251); seam=runArm with a mocked fetch, the judge's host unpriceable on the first attempt; no_claim=the ledger's dollar cost, which attempts[].usd carries per attempt
  test('the stopped row\'s reader and its cached replay count once, and the receipt records what the lane sends', async () => {
    const out = join(tmp(), 'run');
    const argv = ['--benchmark', 'fixture', '--qa', 'reader', '--qa-context', 'oracle', '--reader', 'particle:particle-1', '--judge', 'openai:gpt-4o-mini', '--limit', '1', ...paidArgs(), '--output', out];
    process.env.OPENAI_BASE_URL = 'https://unpriced.invalid/v1';
    serve();
    const first = await memoryQa.runArm(memoryQa.parseRunArgs(argv));
    expect(first.receipt.summary).toMatchObject({ stopped: 'budget' });
    expect(byRole(first.receipt).reader).toMatchObject({ records: 1, provider_calls: 1, input_total: 330 });
    delete process.env.OPENAI_BASE_URL;
    const mock = serve();
    const second = await memoryQa.runArm(memoryQa.parseRunArgs(argv));
    expect(mock.particle()).toHaveLength(0);
    expect([second.rows.length, second.receipt.run_status]).toEqual([2, 'complete']);
    expect(byRole(second.receipt).reader).toMatchObject({ records: 1, cache_hits: 1, input_total: 330 });
    expect(byRole(second.receipt).judge).toMatchObject({ records: 1, errors: 0, input_total: 300 });
    expect(second.receipt.reading).toMatchObject({ judging: 'qa-v2 judgeResponse', judge_max_tokens_sent: 10, reader_max_tokens_sent: 16_000 });
  }, 60_000);
});

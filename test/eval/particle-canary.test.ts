/**
 * scripts/particle-canary.ts, keyless: the canary's paid guard, its refusal of a host the ledger cannot price, a full
 * run against the fake provider on loopback (eval/systems/_shim/fake_provider.py) under a scratch budget ledger, a
 * budget stop, and the comparison of two canaries. No provider is called.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BudgetRun, closeLedgers, initLedger } from '../../eval/runner/budget-ledger.ts';
import { CANARY_MODEL, CANARY_PROMPTS, CANARY_SAMPLING, compareCanary, runCanary, type CanaryRecord, type CanaryResult } from '../../scripts/particle-canary.ts';

const ROOT = resolve(import.meta.dir, '../..');
const dir = mkdtempSync(join(tmpdir(), 'particle-canary-'));
afterAll(() => { closeLedgers(); rmSync(dir, { recursive: true, force: true }); });

function canary(args: string[], env: Record<string, string>) {
  const p = Bun.spawnSync(['bun', 'scripts/particle-canary.ts', ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }, stdout: 'pipe', stderr: 'pipe' });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

const result = (id: string, answer: string, mean: number | null): CanaryResult => ({
  id, prompt_sha256: 'p', status: 'ok', answer, answer_sha256: answer, finish: 'stop', mean_logprob: mean, logprobs: null, response_model: 'particle-ai/particle-1', weight_version: null, service_tier: 'default', system_fingerprint: null,
});

describe('compareCanary', () => {
  const same = { model: CANARY_MODEL, base_url: 'https://api.particle.ai/v1', sampling: CANARY_SAMPLING, prompts_sha256: 'x' };

  test('counts changed answers and the mean and largest move in mean log probability over prompts both runs answered', () => {
    const a = { ...same, results: [result('c01', '391', -0.1), result('c02', 'Canberra', -0.2), result('c03', 'yrassecen', -0.3)] };
    const b = { ...same, results: [result('c01', '391', -0.15), result('c02', 'Sydney', -0.2), { ...result('c03', '', null), status: 'error' as const }] };
    expect(compareCanary(a, b)).toEqual({ compared: 2, complete: false, changed_answers: 1, changed_identity: 0, mean_abs_logprob_change: expect.closeTo(0.025, 10), max_abs_logprob_change: expect.closeTo(0.05, 10) });
    expect(() => compareCanary(a, { ...b, prompts_sha256: 'y' })).toThrow('different prompts');
  });

  test('a comparison is complete only when both canaries answered every prompt, and canaries of another model, endpoint or sampling are refused; a proxy slot\'s per-run port is not another endpoint', () => {
    const all = { ...same, results: CANARY_PROMPTS.map((_, i) => result(`c${String(i + 1).padStart(2, '0')}`, 'a', -0.1)) };
    expect(compareCanary(all, all)).toMatchObject({ compared: CANARY_PROMPTS.length, complete: true, changed_answers: 0 });
    expect(compareCanary(all, { ...all, results: all.results.slice(0, 1) })).toMatchObject({ compared: 1, complete: false });
    expect(compareCanary(all, { ...all, results: all.results.map((r, i) => (i === 3 ? { ...r, system_fingerprint: 'fp_new' } : r)) })).toMatchObject({ changed_answers: 0, changed_identity: 1 });
    expect(() => compareCanary(all, { ...all, base_url: 'https://us.api.particle.ai/v1' })).toThrow('differ in base_url');
    const slot = (port: number) => ({ ...all, base_url: `http://127.0.0.1:${port}/slot-1/particle/v1` });
    expect(compareCanary(slot(8787), slot(9911))).toMatchObject({ compared: CANARY_PROMPTS.length, complete: true });
    expect(() => compareCanary(all, { ...all, model: 'particle:particle-2' })).toThrow('differ in model');
    expect(() => compareCanary(all, { ...all, sampling: { ...CANARY_SAMPLING, seed: 8 } })).toThrow('different sampling');
  });
});

describe('what counts as an answer', () => {
  test('an empty or length-truncated answer is a failed prompt, and a token without a finite log probability leaves the mean unset', async () => {
    let n = 0;
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => {
      const i = n++;
      const message = { role: 'assistant', content: i % 3 === 0 ? '' : i % 3 === 1 ? 'cut off' : 'ok' };
      return Response.json({ id: `c${i}`, model: 'particle-ai/particle-1', choices: [{ index: 0, finish_reason: i % 3 === 2 ? 'stop' : 'length', message, logprobs: { content: [{ token: 'ok', top_logprobs: [] }] } }] });
    } });
    try {
      const rec = await runCanary({ PARTICLE_API_KEY: 'dummy-key', PARTICLE_BASE_URL: `http://127.0.0.1:${server.port}/v1` });
      expect(rec.results.map(r => r.status)).toEqual(CANARY_PROMPTS.map((_, i) => (i % 3 === 2 ? 'ok' : 'error')));
      expect(rec.results.filter(r => r.status === 'error').every(r => r.answer_sha256 === null)).toBe(true);
      expect(rec.results.every(r => r.mean_logprob === null)).toBe(true);
      expect(n).toBe(CANARY_PROMPTS.length);
    } finally { server.stop(true); }
  });
});

describe('answers stopped by an output limit, blank answers and billed malformed answers', () => {
  test('an answer stopped by any output limit, or holding only whitespace, is a failed prompt', async () => {
    const cases = [['cut off', 'max_tokens'], ['cut off', 'model_context_window_exceeded'], [' \n', 'stop'], ['ok', 'stop']] as const;
    let n = 0;
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => {
      const [content, finish_reason] = cases[n++ % cases.length]!;
      return Response.json({ model: 'particle-ai/particle-1', choices: [{ index: 0, finish_reason, message: { role: 'assistant', content } }] });
    } });
    try {
      const rec = await runCanary({ PARTICLE_API_KEY: 'dummy-key', PARTICLE_BASE_URL: `http://127.0.0.1:${server.port}/v1` });
      expect(rec.results.map(r => r.status)).toEqual(CANARY_PROMPTS.map((_, i) => (i % cases.length === 3 ? 'ok' : 'error')));
    } finally { server.stop(true); }
  });

  test('a 2xx answer without a message is retried, and its attempt\'s receipt keeps the usage it reported', async () => {
    let n = 0;
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => (n++ === 0
      ? Response.json({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 } })
      : Response.json({ model: 'particle-ai/particle-1', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] })) });
    try {
      const rec = await runCanary({ PARTICLE_API_KEY: 'dummy-key', PARTICLE_BASE_URL: `http://127.0.0.1:${server.port}/v1` }, { retryDelayMs: () => 0 });
      expect(rec.results.every(r => r.status === 'ok')).toBe(true);
      expect(rec.receipts[0]).toMatchObject({ attempt: 0, status: 'error', usage_raw: { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 }, usage: { input_total: 20, output_total: 7 } });
      expect(rec.receipts[1]).toMatchObject({ question_id: 'c01', attempt: 1, status: 'ok' });
      expect(n).toBe(CANARY_PROMPTS.length + 1);
    } finally { server.stop(true); }
  });
});

describe('the canary run', () => {
  let fake: ReturnType<typeof Bun.spawn>;
  let base = '';
  const fakeLog = join(dir, 'fake.jsonl');
  const ledger = join(dir, 'ledger.sqlite');
  let runId = '';
  const keyless = () => ({ PARTICLE_API_KEY: 'dummy-key', PARTICLE_BASE_URL: `${base}/particle/v1` });

  beforeAll(async () => {
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
    const port = probe.port as number;
    probe.stop(true);
    fake = Bun.spawn(['python3', 'eval/systems/_shim/fake_provider.py', '--port', String(port), '--log', fakeLog], { cwd: ROOT, stdout: 'ignore', stderr: 'pipe' });
    base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 200; i++) { try { await fetch(`${base}/particle/v1/models`, { keepalive: false }); break; } catch { await Bun.sleep(50); } }
    initLedger({ ledgerPath: ledger, programCapUsd: 1, reason: 'particle canary test' });
    runId = BudgetRun.open({ runner: 'canary-test', budgetUsd: 0.5, ledgerPath: ledger }).runId;
  });
  afterAll(() => fake?.kill());

  test('refuses without --paid and --budget-run-id', () => {
    const r = canary(['--out', join(dir, 'none'), '--budget-ledger', ledger], keyless());
    expect(r.code).toBe(1);
    expect(r.out).toContain('--paid and --budget-run-id <id> are missing');
  });

  test('refuses a base URL the ledger cannot price before sending anything', () => {
    const r = canary(['--paid', '--budget-run-id', runId, '--budget-ledger', ledger, '--out', join(dir, 'unpriced')], { PARTICLE_API_KEY: 'dummy-key', PARTICLE_BASE_URL: 'https://api.unlisted-vendor.example/v1' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('the ledger cannot price api.unlisted-vendor.example');
  });

  test('12 prompts at effort none in canary mode, one receipt each, answer hashes and log probabilities in the run directory; a second run compares clean', () => {
    const first = canary(['--paid', '--budget-run-id', runId, '--budget-ledger', ledger, '--out', join(dir, 'a')], keyless());
    expect(first.out).toContain('12 of 12 answered');
    expect(first.code).toBe(0);
    const rec = JSON.parse(readFileSync(join(dir, 'a', 'particle-canary.json'), 'utf8')) as CanaryRecord;
    expect(rec.results).toHaveLength(CANARY_PROMPTS.length);
    expect(rec.results.every(r => r.status === 'ok' && r.answer_sha256 && r.logprobs?.length && r.response_model === 'particle-ai/particle-1')).toBe(true);
    expect(rec.receipts).toHaveLength(12);
    expect(rec.receipts[0]).toMatchObject({ lane: 'particle-canary', status: 'ok', request: { effort_sent: 'none', effort_effective: 'none', output_limit: 64, temperature_sent: 0, seed_sent: 20261031 }, response_meta: { service_tier: 'default', truncated: false } });
    const sent = readFileSync(fakeLog, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.route === 'chat');
    expect(sent).toHaveLength(12);
    expect(sent.every(l => l.effort === 'none' && l.max_completion_tokens === 64 && l.logprobs === true && l.auth_is_dummy)).toBe(true);
    const second = canary(['--paid', '--budget-run-id', runId, '--budget-ledger', ledger, '--out', join(dir, 'b'), '--compare', join(dir, 'a', 'particle-canary.json'), '--warn-changed', '0', '--warn-logprob', '0.01'], keyless());
    expect(second.code).toBe(0);
    expect(second.out).toContain('"compared":12,"complete":true,"changed_answers":0,"changed_identity":0,"mean_abs_logprob_change":0');
    expect(second.out).not.toContain('warning:');
  });

  test('--compare naming the file this run writes is refused before anything is sent, and the baseline stays as it was', () => {
    const baseline = join(dir, 'a', 'particle-canary.json');
    const before = readFileSync(baseline, 'utf8');
    const chats = () => readFileSync(fakeLog, 'utf8').trim().split('\n').filter(l => JSON.parse(l).route === 'chat').length;
    const sentBefore = chats();
    const r = canary(['--paid', '--budget-run-id', runId, '--budget-ledger', ledger, '--out', join(dir, 'a'), '--compare', baseline], keyless());
    expect(r.code).toBe(1);
    expect(r.out).toContain('--compare names the file this run writes');
    expect(readFileSync(baseline, 'utf8')).toBe(before);
    expect(chats()).toBe(sentBefore);
  });

  test('a --compare baseline of the same file by another path, of other sampling or model, or a --warn threshold that is not a number, is refused before anything is sent', () => {
    const baseline = join(dir, 'a', 'particle-canary.json');
    const before = readFileSync(baseline, 'utf8');
    const chats = () => readFileSync(fakeLog, 'utf8').trim().split('\n').filter(l => JSON.parse(l).route === 'chat').length;
    const sentBefore = chats();
    linkSync(baseline, join(dir, 'hardlink.json'));
    symlinkSync(join(dir, 'a'), join(dir, 'a-link'));
    const rec = JSON.parse(before) as CanaryRecord;
    writeFileSync(join(dir, 'other-sampling.json'), JSON.stringify({ ...rec, sampling: { ...rec.sampling, seed: 7 } }));
    writeFileSync(join(dir, 'other-model.json'), JSON.stringify({ ...rec, model: 'particle:particle-2' }));
    const paid = ['--paid', '--budget-run-id', runId, '--budget-ledger', ledger];
    for (const [args, message] of [
      [['--out', join(dir, 'a'), '--compare', join(dir, 'hardlink.json')], '--compare names the file this run writes'],
      [['--out', join(dir, 'a-link'), '--compare', baseline], '--compare names the file this run writes'],
      [['--out', join(dir, 'm1'), '--compare', join(dir, 'other-sampling.json')], 'the two canaries used different sampling'],
      [['--out', join(dir, 'm2'), '--compare', join(dir, 'other-model.json')], 'the two canaries differ in model'],
      [['--out', join(dir, 'm3'), '--compare', baseline, '--warn-logprob', 'abc'], '--warn-logprob takes a number, not "abc"'],
      [['--out', join(dir, 'm4'), '--warn-changed'], '--warn-changed takes a number, not ""'],
    ] as const) {
      const r = canary([...paid, ...args], keyless());
      expect(r.code).toBe(1);
      expect(r.out).toContain(message);
    }
    expect(readFileSync(baseline, 'utf8')).toBe(before);
    expect(chats()).toBe(sentBefore);
    expect(['m1', 'm2', 'm3', 'm4'].some(d => existsSync(join(dir, d)))).toBe(false);
  });

  test('a credit 402 after a 429 stops the canary with both attempts receipted', async () => {
    await fetch(`${base}/__fake/particle/faults`, { method: 'POST', body: JSON.stringify({ faults: [{ status: 429, retry_after: '0' }, { status: 402 }] }), keepalive: false });
    const r = canary(['--paid', '--budget-run-id', runId, '--budget-ledger', ledger, '--out', join(dir, 'stop')], keyless());
    expect(r.code).toBe(1);
    expect(r.out).toContain('0 of 12 answered; stopped: budget: Particle credit exhausted');
    const rec = JSON.parse(readFileSync(join(dir, 'stop', 'particle-canary.json'), 'utf8')) as CanaryRecord;
    expect(rec.receipts.map(x => [x.attempt, x.status])).toEqual([[0, 'error'], [1, 'error']]);
    expect(rec.receipts[0]!.error).toStartWith('particle 429: ');
    expect(rec.receipts[1]!.error).toStartWith('budget: Particle credit exhausted');
    expect(rec.receipts[1]!.response_meta).toEqual({ metadata: null, weight_version: null, service_tier: null, system_fingerprint: null, non_default_tier: null, truncated: null });
    expect(rec.results).toHaveLength(1);
  });
});

/**
 * scripts/particle-canary.ts, keyless: the canary's paid guard, its refusal of a host the ledger cannot price, a full
 * run against the fake provider on loopback (eval/systems/_shim/fake_provider.py) under a scratch budget ledger, a
 * budget stop, and the comparison of two canaries. No provider is called.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BudgetRun, closeLedgers, initLedger } from '../../eval/runner/budget-ledger.ts';
import { CANARY_PROMPTS, compareCanary, type CanaryRecord, type CanaryResult } from '../../scripts/particle-canary.ts';

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
  test('counts changed answers and the mean and largest move in mean log probability over prompts both runs answered', () => {
    const a = { prompts_sha256: 'x', results: [result('c01', '391', -0.1), result('c02', 'Canberra', -0.2), result('c03', 'yrassecen', -0.3)] };
    const b = { prompts_sha256: 'x', results: [result('c01', '391', -0.15), result('c02', 'Sydney', -0.2), { ...result('c03', '', null), status: 'error' as const }] };
    expect(compareCanary(a, b)).toEqual({ compared: 2, changed_answers: 1, mean_abs_logprob_change: expect.closeTo(0.025, 10), max_abs_logprob_change: expect.closeTo(0.05, 10) });
    expect(() => compareCanary(a, { ...b, prompts_sha256: 'y' })).toThrow('different prompts');
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
    expect(second.out).toContain('"compared":12,"changed_answers":0,"mean_abs_logprob_change":0');
    expect(second.out).not.toContain('warning:');
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

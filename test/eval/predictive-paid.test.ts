/**
 * Paid execution for the predictive runner (paid.ts and run.ts --paid), keyless: provider keys are deleted for the file,
 * every provider answer comes from a fake Anthropic upstream behind the real paid-request guard and a temporary ledger,
 * and the refusal tests swap globalThis.fetch for a dead upstream that counts calls.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetRun, installPaidRequestGuard, ledgerStatus } from '../../eval/runner/budget-ledger.ts';
import { priceUsage, runAgent, type Arm } from '../../eval/runner/cat40/loop.ts';
import { HERMETIC_KEY_PATTERN, HERMETIC_STRIPPED_KEYS } from '../../eval/runner/hermetic-env.ts';
import { EPISODE_LOG_SCHEMA, meteredFetch, missingKeys, readEpisodeLog, runPaid, type EpisodeUsage, type PaidJob } from '../../eval/runner/predictive/paid.ts';
import { main, paidJobs, scorecards } from '../../eval/runner/predictive/run.ts';

const saved: Record<string, string | undefined> = {};
let dir = '';
beforeAll(() => {
  for (const k of Object.keys(process.env)) if ((HERMETIC_STRIPPED_KEYS as readonly string[]).includes(k) || HERMETIC_KEY_PATTERN.test(k) || /PARTICLE|UBICLOUD/.test(k)) { saved[k] = process.env[k]; delete process.env[k]; }
  dir = mkdtempSync(join(tmpdir(), 'predictive-paid-'));
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

const USAGE = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
/** A fake Anthropic Messages upstream. reply(body) returns the tool call to make, or a status to fail with. */
function anthropicUpstream(reply: (body: { model: string; messages: Array<{ content: Array<{ text?: string }> }> }) => { status: number } | { name: string; input: Record<string, unknown> }) {
  const seen: unknown[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith('https://api.anthropic.com/')) throw new Error(`fake upstream got a request for ${url}`);
    const body = JSON.parse(String(init?.body));
    seen.push(body);
    const r = reply(body);
    if ('status' in r) return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'fake refusal' } }), { status: r.status, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: `msg_${seen.length}`, type: 'message', role: 'assistant', model: body.model, stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: `toolu_${seen.length}`, name: r.name, input: r.input }], usage: USAGE }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const stubArm: Arm = { name: 'stub', systemHint: () => 'stub arm', tools: () => [], call: async () => 'ok', writeTools: () => [] };
const MODEL = 'claude-opus-5-5';
const job = (key: string): PaidJob => ({
  key, unit: 'test', model: MODEL,
  run: async fetchImpl => {
    const run = await runAgent({ model: MODEL, system: 'test', user: key, arm: stubArm, fetchImpl, classifyStops: true, maxTurns: 2 });
    return { success: run.final !== null, usd: run.usd, stop: run.stop, model: run.model };
  },
});
const upstream = () => anthropicUpstream(body => body.messages[0].content[0].text?.includes('bad') ? { status: 400 } : { name: 'submit_answer', input: { answer: 'fictional answer' } });

function paidRun(name: string, budgetUsd: number, fetchImpl: typeof fetch) {
  const run = BudgetRun.open({ runner: name, budgetUsd, ledgerPath: join(dir, `${name}.sqlite`), programCapUsd: 100 });
  return { run, guard: installPaidRequestGuard(run, { fetchImpl }) };
}

describe('refusals before any provider work', () => {
  test('every paid entry refuses with keys blanked, and no request is attempted', async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => { calls.push(String(input)); throw new Error('dead upstream'); }) as unknown as typeof fetch;
    const ledgerPath = join(dir, 'refusal.sqlite');
    const open = BudgetRun.open({ runner: 'predictive-refusal-test', budgetUsd: 1000, ledgerPath, programCapUsd: 5000 });
    open.close({ finish: false });
    const ledger = ['--budget-ledger', ledgerPath];
    try {
      expect(missingKeys(['claude-opus-5-5', 'gpt-6.1-sol', 'particle-1'])).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PARTICLE_API_KEY']);
      expect(missingKeys(['claude-opus-5-5'], { ANTHROPIC_API_KEY: 'set' })).toEqual([]);
      for (const unit of ['g1', 'g3', 'g4', 'g6']) {
        expect(await main([unit, '--smoke', ...ledger])).toBe(2);
        expect(await main([unit, '--paid', '--smoke', ...ledger])).toBe(2);
        expect(await main([unit, '--paid', '--budget-run-id', 'not-a-run', ...ledger])).toBe(2);
        expect(await main([unit, '--paid', '--smoke', '--budget-run-id', open.runId, ...ledger, '--out', join(dir, `refused-${unit}`)])).toBe(2);
      }
    } finally { globalThis.fetch = original; }
    expect(calls).toEqual([]);
    expect(ledgerStatus({ ledgerPath, runId: open.runId }).run!.remaining_usd).toBe(1000);
  });
});

describe('the resume estimate', () => {
  test('requirePaidArm checks only the episodes a resume would send', async () => {
    const ledgerPath = join(dir, 'resume-estimate.sqlite');
    const open = BudgetRun.open({ runner: 'predictive-resume-estimate-test', budgetUsd: 0.01, ledgerPath, programCapUsd: 100 });
    open.close({ finish: false });
    const out = join(dir, 'resume-estimate');
    const argv = ['g4', '--paid', '--smoke', '--budget-run-id', open.runId, '--budget-ledger', ledgerPath, '--out', out];
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
    try {
      expect(await main(argv)).toBe(2);
      expect(errors.join('\n')).toMatch(/has only \$0\.01 left/);
      errors.length = 0;
      const rows = paidJobs('g4', { tasks: 1, k: 1, models: ['claude-opus-5-5', 'gpt-6.1-sol', 'particle-1'], budgetRunId: '' })
        .map(j => JSON.stringify({ schema: EPISODE_LOG_SCHEMA, key: j.key, unit: 'g4', model: j.model, status: 'done', counted: false, at: 'then' }));
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'episodes.jsonl'), rows.join('\n') + '\n');
      expect(await main(argv)).toBe(2);
      expect(errors.join('\n')).toMatch(/is not set; nothing was sent|are not set; nothing was sent/);
    } finally { console.error = original; }
  });
});

describe('the metered fetch', () => {
  test('fits Claude 5 requests, leaves other providers byte-identical, and adds provider usage', async () => {
    const bodies: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => { bodies.push(String(init?.body)); return new Response(JSON.stringify({ usage: USAGE }), { headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch;
    const usage: EpisodeUsage = { requests: 0, input: 0, output: 0, cache_read: 0, cache_write: 0 };
    try {
      const claude = { model: MODEL, max_tokens: 4096, temperature: 0, tool_choice: { type: 'tool', name: 'submit_answer' }, messages: [{ role: 'user', content: 'q' }] };
      await meteredFetch(MODEL, usage)('https://api.anthropic.com/v1/messages', { method: 'POST', body: JSON.stringify(claude) });
      const gpt = JSON.stringify({ model: 'gpt-6.1-sol', temperature: 0, input: 'q' });
      await meteredFetch('gpt-6.1-sol', usage)('https://api.openai.com/v1/responses', { method: 'POST', body: gpt });
      const sent = JSON.parse(bodies[0]);
      expect(sent.temperature).toBeUndefined();
      expect(sent.tool_choice).toEqual({ type: 'auto' });
      expect(bodies[1]).toBe(gpt);
      expect(usage).toEqual({ requests: 2, input: 1000 + 1000, output: 200, cache_read: 0, cache_write: 0 });
    } finally { globalThis.fetch = original; }
  });
});

describe('the paid executor', () => {
  test('one ledger writer: reserves and reconciles every request from usage; resume skips done, errored and in-flight episodes', async () => {
    const up = upstream();
    const log = join(dir, 'exec', 'episodes.jsonl');
    const jobs = ['a', 'b', 'bad-c', 'd'].map(job);
    const { run, guard } = paidRun('predictive-exec-test', 5, up.fetchImpl);
    const lines: string[] = [];
    let first, second, third;
    try {
      first = await runPaid(jobs, { log, concurrency: 2, retryErrored: false, counted: false, guard, resumeCommand: 'resume-cmd', print: l => lines.push(l) });
      expect(up.seen.length).toBe(4);
      second = await runPaid(jobs, { log, concurrency: 2, retryErrored: false, counted: false, guard, resumeCommand: 'resume-cmd', print: l => lines.push(l) });
      expect(up.seen.length).toBe(4);
      writeFileSync(log, readFileSync(log, 'utf8') + JSON.stringify({ schema: EPISODE_LOG_SCHEMA, key: 'e', unit: 'test', model: MODEL, status: 'started', counted: false, at: 'then' }) + '\n');
      third = await runPaid([...jobs, job('e')], { log, concurrency: 2, retryErrored: false, counted: false, guard, resumeCommand: 'resume-cmd', print: l => lines.push(l) });
      expect(up.seen.length).toBe(4);
    } finally { guard.uninstall(); }
    const summary = run.close({ finish: false });
    expect(first.status).toBe('incomplete');
    expect(first.done.map(r => r.key).sort()).toEqual(['a', 'b', 'd']);
    expect(first.errored.map(r => r.key)).toEqual(['bad-c']);
    expect(first.errored[0].record!.stop).toBe('error');
    expect(second).toMatchObject({ ran: 0, skipped: { done: 3, errored: 1, in_flight: 0 } });
    expect(third).toMatchObject({ ran: 0, skipped: { done: 3, errored: 1, in_flight: 1 } });
    expect(lines.some(l => /may already have been billed; pass --retry-errored/.test(l))).toBe(true);
    const perRequest = priceUsage(MODEL, { input: 1000, output: 100, cache_read: 0, cache_write: 0 });
    expect(summary.requests).toBe(4);
    expect(summary.charged_reservations).toBe(0);
    expect(summary.actual_usd).toBeCloseTo(3 * perRequest, 6);
    const rows = readEpisodeLog(log);
    expect(rows.get('a')).toMatchObject({ status: 'done', counted: false, usage: { requests: 1, input: 1000, output: 100 } });
    expect(rows.get('a')!.record!.usd).toBeCloseTo(perRequest, 9);
  });

  test('--retry-errored resends errored and in-flight episodes, and only those', async () => {
    const up = upstream();
    const log = join(dir, 'retry', 'episodes.jsonl');
    const jobs = ['a', 'bad-b'].map(job);
    const { run, guard } = paidRun('predictive-retry-test', 5, up.fetchImpl);
    let again;
    try {
      await runPaid(jobs, { log, concurrency: 1, retryErrored: false, counted: true, guard, resumeCommand: 'x', print: () => {} });
      again = await runPaid(jobs, { log, concurrency: 1, retryErrored: true, counted: true, guard, resumeCommand: 'x', print: () => {} });
    } finally { guard.uninstall(); run.close({ finish: false }); }
    expect(again.ran).toBe(1);
    expect(up.seen.length).toBe(3);
  });

  test('a cap stop pauses cleanly before sending, prints the resume command, and resume re-runs the refused episode', async () => {
    const up = upstream();
    const log = join(dir, 'cap', 'episodes.jsonl');
    const jobs = ['a', 'b', 'c'].map(job);
    const lines: string[] = [];
    const capped = paidRun('predictive-cap-test', 1e-9, up.fetchImpl);
    let paused;
    try { paused = await runPaid(jobs, { log, concurrency: 1, retryErrored: false, counted: true, guard: capped.guard, resumeCommand: 'bun eval/runner/predictive/run.ts g4 --paid --budget-run-id R', print: l => lines.push(l) }); }
    finally { capped.guard.uninstall(); capped.run.close({ finish: false }); }
    expect(up.seen.length).toBe(0);
    expect(paused).toMatchObject({ status: 'paused', ran: 1 });
    expect(paused.pause_reason).toMatch(/^cap stop: /);
    expect(readEpisodeLog(log).get('a')!.status).toBe('refused');
    expect(readEpisodeLog(log).has('b')).toBe(false);
    expect(lines.join('\n')).toContain('resume with:\n  bun eval/runner/predictive/run.ts g4 --paid --budget-run-id R');
    const raised = paidRun('predictive-cap-raised-test', 5, up.fetchImpl);
    let resumed;
    try { resumed = await runPaid(jobs, { log, concurrency: 1, retryErrored: false, counted: true, guard: raised.guard, resumeCommand: 'x', print: () => {} }); }
    finally { raised.guard.uninstall(); raised.run.close({ finish: false }); }
    expect(resumed).toMatchObject({ status: 'complete', ran: 3 });
    expect(up.seen.length).toBe(3);
  });

  test('a G4 paid job runs a real episode on the gbrain CLI through the guard', async () => {
    const up = anthropicUpstream(() => ({ name: 'submit_answer', input: { answer: 'fictional answer' } }));
    const { run, guard } = paidRun('predictive-g4-job-test', 5, up.fetchImpl);
    const jobs = paidJobs('g4', { tasks: 1, k: 1, models: [MODEL], budgetRunId: run.runId });
    let result;
    try { result = await runPaid(jobs, { log: join(dir, 'g4', 'episodes.jsonl'), concurrency: 1, retryErrored: false, counted: false, guard, resumeCommand: 'x', print: () => {} }); }
    finally { guard.uninstall(); run.close({ finish: false }); }
    expect(jobs.map(j => j.key)).toEqual([`g4:${MODEL}:${jobs[0].key.split(':')[2]}:0`]);
    expect(result.status).toBe('complete');
    expect(up.seen.length).toBe(1);
    expect(result.done[0].record).toMatchObject({ model: MODEL, stop: 'submitted', success: false });
    expect(scorecards('g4', result.done.map(r => r.record!), 1)).toHaveLength(1);
  }, 120_000);
});

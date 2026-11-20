/**
 * Paid execution for the predictive runner (paid.ts and run.ts --paid), keyless: provider keys are deleted for the file,
 * every provider answer comes from a fake Anthropic, OpenAI Responses or Particle Chat Completions upstream behind the
 * real paid-request guard and a temporary ledger (the Particle test sets a placeholder key, never a real one), and the
 * refusal tests swap globalThis.fetch for a dead upstream that counts calls.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetRun, installPaidRequestGuard, ledgerStatus, readLedger } from '../../eval/runner/budget-ledger.ts';
import { priceUsage, runAgent, type Arm } from '../../eval/runner/cat40/loop.ts';
import { HERMETIC_KEY_PATTERN, HERMETIC_STRIPPED_KEYS } from '../../eval/runner/hermetic-env.ts';
import { EPISODE_LOG_SCHEMA, meteredFetch, missingKeys, readEpisodeLog, ResumeRefusal, runPaid, type EpisodeRecord, type EpisodeUsage, type LogRow, type PaidJob } from '../../eval/runner/predictive/paid.ts';
import { scoreEntityEpisode } from '../../eval/runner/predictive/entity-agent.ts';
import { generateEntityTasks } from '../../eval/generators/entity-agent-gen.ts';
import { G3_CAUSES } from '../../eval/generators/write-contract-gen.ts';
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

const GBRAIN = { version: '0.0.0-test', commit: 'a'.repeat(40) };
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

describe('the smoke plan', () => {
  test('--dry-run --smoke prints the smoke plan and sends nothing', async () => {
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
    try { expect(await main(['g3', '--dry-run', '--smoke'])).toBe(0); }
    finally { console.log = original; }
    expect(JSON.parse(logs[0])).toMatchObject({ mode: 'dry-run', tasks: 1, surfaces: 2, k: 1, episodes: 6 });
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
      first = await runPaid(jobs, { log, concurrency: 2, retryErrored: false, counted: false, gbrain: GBRAIN, guard, resumeCommand: 'resume-cmd', print: l => lines.push(l) });
      expect(up.seen.length).toBe(4);
      second = await runPaid(jobs, { log, concurrency: 2, retryErrored: false, counted: false, gbrain: GBRAIN, guard, resumeCommand: 'resume-cmd', print: l => lines.push(l) });
      expect(up.seen.length).toBe(4);
      writeFileSync(log, readFileSync(log, 'utf8') + JSON.stringify({ schema: EPISODE_LOG_SCHEMA, key: 'e', unit: 'test', model: MODEL, status: 'started', counted: false, at: 'then', gbrain: GBRAIN }) + '\n');
      third = await runPaid([...jobs, job('e')], { log, concurrency: 2, retryErrored: false, counted: false, gbrain: GBRAIN, guard, resumeCommand: 'resume-cmd', print: l => lines.push(l) });
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
      await runPaid(jobs, { log, concurrency: 1, retryErrored: false, counted: true, gbrain: GBRAIN, guard, resumeCommand: 'x', print: () => {} });
      again = await runPaid(jobs, { log, concurrency: 1, retryErrored: true, counted: true, gbrain: GBRAIN, guard, resumeCommand: 'x', print: () => {} });
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
    try { paused = await runPaid(jobs, { log, concurrency: 1, retryErrored: false, counted: true, gbrain: GBRAIN, guard: capped.guard, resumeCommand: 'bun eval/runner/predictive/run.ts g4 --paid --budget-run-id R', print: l => lines.push(l) }); }
    finally { capped.guard.uninstall(); capped.run.close({ finish: false }); }
    expect(up.seen.length).toBe(0);
    expect(paused).toMatchObject({ status: 'paused', ran: 1 });
    expect(paused.pause_reason).toMatch(/^cap stop: /);
    expect(readEpisodeLog(log).get('a')!.status).toBe('refused');
    expect(readEpisodeLog(log).has('b')).toBe(false);
    expect(lines.join('\n')).toContain('resume with:\n  bun eval/runner/predictive/run.ts g4 --paid --budget-run-id R');
    const raised = paidRun('predictive-cap-raised-test', 5, up.fetchImpl);
    let resumed;
    try { resumed = await runPaid(jobs, { log, concurrency: 1, retryErrored: false, counted: true, gbrain: GBRAIN, guard: raised.guard, resumeCommand: 'x', print: () => {} }); }
    finally { raised.guard.uninstall(); raised.run.close({ finish: false }); }
    expect(resumed).toMatchObject({ status: 'complete', ran: 3 });
    expect(up.seen.length).toBe(3);
  });

  test('a counted run resumes only from counted rows: a smoke done row for the same key runs again', async () => {
    const up = upstream();
    const log = join(dir, 'counted-resume', 'episodes.jsonl');
    mkdirSync(join(dir, 'counted-resume'), { recursive: true });
    writeFileSync(log, JSON.stringify({ schema: EPISODE_LOG_SCHEMA, key: 'a', unit: 'test', model: MODEL, status: 'done', counted: false, at: 'then' }) + '\n');
    const { run, guard } = paidRun('predictive-counted-resume-test', 5, up.fetchImpl);
    let result;
    try {
      result = await runPaid([job('a')], { log, concurrency: 1, retryErrored: false, counted: true, gbrain: GBRAIN, guard, resumeCommand: 'resume-cmd', print: () => {} });
    } finally { guard.uninstall(); run.close({ finish: false }); }
    expect(up.seen.length).toBe(1);
    expect(result).toMatchObject({ status: 'complete', ran: 1, skipped: { done: 0, errored: 0, in_flight: 0 } });
    expect(result.done[0]).toMatchObject({ key: 'a', counted: true });
    expect(readEpisodeLog(log, false).get('a')!.counted).toBe(false);
  });

  test('a resume refuses rows from another gbrain build, or from none, before sending anything', async () => {
    const up = upstream();
    const log = join(dir, 'build-resume', 'episodes.jsonl');
    mkdirSync(join(dir, 'build-resume'), { recursive: true });
    const row = (gbrain?: object) => JSON.stringify({ schema: EPISODE_LOG_SCHEMA, key: 'a', unit: 'test', model: MODEL, status: 'done', counted: true, at: 'then', ...(gbrain ? { gbrain } : {}) }) + '\n';
    const { run, guard } = paidRun('predictive-build-resume-test', 5, up.fetchImpl);
    const resume = () => runPaid([job('a'), job('b')], { log, concurrency: 1, retryErrored: false, counted: true, gbrain: GBRAIN, guard, resumeCommand: 'x', print: () => {} });
    let same;
    try {
      for (const other of [{ version: '0.0.1-test', commit: GBRAIN.commit }, { version: GBRAIN.version, commit: 'b'.repeat(40) }, undefined]) {
        writeFileSync(log, row(other));
        await expect(resume()).rejects.toThrow(ResumeRefusal);
        expect(readFileSync(log, 'utf8')).toBe(row(other));
      }
      expect(up.seen.length).toBe(0);
      writeFileSync(log, row(GBRAIN));
      same = await resume();
    } finally { guard.uninstall(); run.close({ finish: false }); }
    expect(same).toMatchObject({ ran: 1, skipped: { done: 1, errored: 0, in_flight: 0 } });
    expect(readEpisodeLog(log, true).get('b')!.gbrain).toEqual(GBRAIN);
  });

  test('cost per correct answer counts errored spend, earlier attempts of a retried episode included', async () => {
    const up = upstream();
    const log = join(dir, 'errored-spend', 'episodes.jsonl');
    const { run, guard } = paidRun('predictive-errored-spend-test', 5, up.fetchImpl);
    let again;
    try {
      await runPaid(['a', 'bad-b'].map(job), { log, concurrency: 1, retryErrored: false, counted: true, gbrain: GBRAIN, guard, resumeCommand: 'x', print: () => {} });
      again = await runPaid(['a', 'bad-b'].map(job), { log, concurrency: 1, retryErrored: true, counted: true, gbrain: GBRAIN, guard, resumeCommand: 'x', print: () => {} });
    } finally { guard.uninstall(); run.close({ finish: false }); }
    expect(again.errored_attempts.map(r => r.key)).toEqual(['bad-b', 'bad-b']);
    const [task] = generateEntityTasks({ n: 1 });
    const right = scoreEntityEpisode({ task, model: MODEL, trial: 0, answer: task.gold, usd: 0.5, stop: 'submitted' });
    const wrong = scoreEntityEpisode({ task, model: MODEL, trial: 1, answer: null, usd: 0.25, stop: 'submitted' });
    const usage = { requests: 1, input: 1000, output: 100, cache_read: 0, cache_write: 0 };
    const errored: LogRow[] = [
      { schema: EPISODE_LOG_SCHEMA, key: `g4:${MODEL}:${task.id}:2`, unit: 'g4', model: MODEL, status: 'errored', counted: true, at: 'then', usage, error: 'socket hang up' },
      { schema: EPISODE_LOG_SCHEMA, key: `g4:${MODEL}:${task.id}:3`, unit: 'g4', model: MODEL, status: 'errored', counted: true, at: 'then', record: { success: false, usd: 0.125, stop: 'error', model: MODEL } },
    ];
    const erroredUsd = priceUsage(MODEL, usage) + 0.125;
    const [card] = scorecards('g4', [right, wrong], 2, errored) as Array<{ usd: number; errored_usd: number; cost_per_correct_usd: number }>;
    expect(card.errored_usd).toBeCloseTo(erroredUsd, 9);
    expect(card.usd).toBeCloseTo(0.75 + erroredUsd, 9);
    expect(card.cost_per_correct_usd).toBeCloseTo(0.75 + erroredUsd, 9);
  });

  test('cost per correct answer counts the turns a mid-episode cap stop already billed, once', async () => {
    const reply = (body: { messages: unknown[] }) => body.messages.length === 1 ? { name: 'lookup', input: { q: 'fictional' } } : { name: 'submit_answer', input: { answer: 'fictional answer' } };
    const probeUp = anthropicUpstream(reply);
    const probe = paidRun('predictive-refused-probe-test', 5, probeUp.fetchImpl);
    try { await runPaid([twoTurnJob(MODEL)], { log: join(dir, 'refused-probe', 'episodes.jsonl'), concurrency: 1, retryErrored: false, counted: true, gbrain: GBRAIN, guard: probe.guard, resumeCommand: 'x', print: () => {} }); }
    finally { probe.guard.uninstall(); probe.run.close({ finish: false }); }
    const firstReservation = Math.min(...readLedger(join(dir, 'predictive-refused-probe-test.sqlite')).entries.map(e => e.reserved_usd));
    const up = anthropicUpstream(reply);
    const log = join(dir, 'refused-spend', 'episodes.jsonl');
    const opts = { log, concurrency: 1, retryErrored: false, counted: true, gbrain: GBRAIN, resumeCommand: 'x', print: () => {} };
    const capped = paidRun('predictive-refused-capped-test', firstReservation * 1.001, up.fetchImpl);
    let paused;
    try { paused = await runPaid([twoTurnJob(MODEL)], { ...opts, guard: capped.guard }); }
    finally { capped.guard.uninstall(); }
    const cappedSpend = capped.run.close({ finish: false }).actual_usd;
    expect(up.seen.length).toBe(1);
    expect(paused.status).toBe('paused');
    const refused = readEpisodeLog(log).get('route:' + MODEL)!;
    expect(refused).toMatchObject({ status: 'refused', usage: { requests: 1 } });
    const raised = paidRun('predictive-refused-raised-test', 5, up.fetchImpl);
    let resumed, again;
    try {
      resumed = await runPaid([twoTurnJob(MODEL)], { ...opts, guard: raised.guard });
      again = await runPaid([twoTurnJob(MODEL)], { ...opts, guard: raised.guard });
    } finally { raised.guard.uninstall(); }
    const raisedSpend = raised.run.close({ finish: false }).actual_usd;
    expect(resumed.status).toBe('complete');
    expect(again).toMatchObject({ status: 'complete', ran: 0 });
    expect(up.seen.length).toBe(3);
    expect(again.errored_attempts).toEqual([refused]);
    const [task] = generateEntityTasks({ n: 1 });
    const right = scoreEntityEpisode({ task, model: MODEL, trial: 0, answer: task.gold, usd: again.done[0].record!.usd, stop: 'submitted' });
    const [card] = scorecards('g4', [right], 1, again.errored_attempts) as Array<{ errored_usd: number; cost_per_correct_usd: number }>;
    expect(card.errored_usd).toBeCloseTo(cappedSpend, 6);
    expect(card.cost_per_correct_usd).toBeCloseTo(cappedSpend + raisedSpend, 6);
  });

  test('a model or G3 surface with errored or refused spend and no done episode gets a row with its spend, and no other row changes', () => {
    const usage = { requests: 1, input: 1000, output: 100, cache_read: 0, cache_write: 0 };
    const row = (key: string, model: string, status: 'errored' | 'refused', extra: Partial<LogRow>): LogRow => ({ schema: EPISODE_LOG_SCHEMA, key, unit: key.split(':')[0], model, status, counted: true, at: 'then', ...extra });
    const sol = 'gpt-6.1-sol';
    const [task] = generateEntityTasks({ n: 1 });
    const right = scoreEntityEpisode({ task, model: MODEL, trial: 0, answer: task.gold, usd: 0.5, stop: 'submitted' });
    const solRows = [row(`g4:${sol}:${task.id}:0`, sol, 'errored', { usage, error: 'socket hang up' }), row(`g4:${sol}:${task.id}:1`, sol, 'refused', { usage, error: 'cap stop' })];
    const solUsd = 2 * priceUsage(sol, usage);
    const g4 = scorecards('g4', [right], 1, solRows) as Array<Record<string, unknown>>;
    expect(g4).toHaveLength(2);
    expect(g4[0]).toEqual(scorecards('g4', [right], 1)[0] as Record<string, unknown>);
    expect(g4[1]).toEqual({ unit: 'G4', model: sol, episodes: 0, usd: expect.closeTo(solUsd, 9), errored_usd: expect.closeTo(solUsd, 9), cost_per_correct_usd: null });
    expect(scorecards('g4', [], 1, solRows)).toEqual([g4[1]]);
    expect([scorecards('g4', [], 1), scorecards('g3', [], 1)]).toEqual([[], []]);
    const write = {
      task_id: 't1', task_cause: 'missing_provenance', surface: 'cli', model: MODEL, trial: 0, calls: 1, refusals: [], exposure: Object.fromEntries(G3_CAUSES.map(c => [c, 0])),
      target_landed: true, landed_on_decoy: false, claimed_landed: 1, reported_done_not_landed: 0, ledger: { write_count: 1, pages_written: 0 }, success: true, cause: 'correct', usd: 0.25, stop: 'submitted',
    } as unknown as EpisodeRecord;
    const mcpErrored = row(`g3:${MODEL}:t1:mcp:0`, MODEL, 'errored', { record: { success: false, usd: 0.125, stop: 'error', model: MODEL } });
    const g3 = scorecards('g3', [write], 1, [mcpErrored]) as Array<Record<string, unknown>>;
    expect(g3).toHaveLength(2);
    expect(g3[0]).toEqual(scorecards('g3', [write], 1)[0] as Record<string, unknown>);
    expect(g3[1]).toEqual({ unit: 'G3', model: MODEL, surface: 'mcp', episodes: 0, usd: 0.125, errored_usd: 0.125, cost_per_correct_usd: null });
  });

  test('a G4 paid job runs a real episode on the gbrain CLI through the guard', async () => {
    const up = anthropicUpstream(() => ({ name: 'submit_answer', input: { answer: 'fictional answer' } }));
    const { run, guard } = paidRun('predictive-g4-job-test', 5, up.fetchImpl);
    const jobs = paidJobs('g4', { tasks: 1, k: 1, models: [MODEL], budgetRunId: run.runId });
    let result;
    try { result = await runPaid(jobs, { log: join(dir, 'g4', 'episodes.jsonl'), concurrency: 1, retryErrored: false, counted: false, gbrain: GBRAIN, guard, resumeCommand: 'x', print: () => {} }); }
    finally { guard.uninstall(); run.close({ finish: false }); }
    expect(jobs.map(j => j.key)).toEqual([`g4:${MODEL}:${jobs[0].key.split(':')[2]}:0`]);
    expect(result.status).toBe('complete');
    expect(up.seen.length).toBe(1);
    expect(result.done[0].record).toMatchObject({ model: MODEL, stop: 'submitted', success: false });
    expect(scorecards('g4', result.done.map(r => r.record!), 1)).toHaveLength(1);
  }, 120_000);
});

describe('the run guide', () => {
  test('the README says cost per correct counts turns billed before a cap stop, and that spend with no finished episode gets a row', () => {
    const text = readFileSync(join(import.meta.dir, '../../eval/runner/predictive/README.md'), 'utf8').replace(/\s+/g, ' ');
    expect(text).toContain("Turns it sent before the refusal were billed, so they stay in the refused row's `usage`, and cost per correct answer counts them once.");
    expect(text).toContain('a model, or a G3 surface, with spend but no finished episode gets a row with 0 episodes, its spend and a null cost per correct answer');
  });
});

describe('preregistration', () => {
  function capture() {
    const errors: string[] = [];
    const calls: string[] = [];
    const original = { error: console.error, fetch: globalThis.fetch };
    console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => { calls.push(String(input)); throw new Error('dead upstream'); }) as unknown as typeof fetch;
    return { errors, calls, restore: () => { console.error = original.error; globalThis.fetch = original.fetch; } };
  }
  function openRun(name: string) {
    const ledgerPath = join(dir, `${name}.sqlite`);
    const run = BudgetRun.open({ runner: name, budgetUsd: 5000, ledgerPath, programCapUsd: 10_000 });
    run.close({ finish: false });
    return { ledgerPath, runId: run.runId };
  }

  test('a counted run refuses without an attested preregistration, before any client exists', async () => {
    const { ledgerPath, runId } = openRun('predictive-prereg-refusal-test');
    const c = capture();
    try {
      for (const unit of ['g1', 'g3', 'g4', 'g6']) {
        const argv = [unit, '--paid', '--budget-run-id', runId, '--budget-ledger', ledgerPath, '--out', join(dir, `prereg-${unit}`)];
        expect(await main(argv)).toBe(2);
        expect(await main([...argv, '--preregistration', 'docs/benchmarks/no-such-preregistration.md'])).toBe(2);
      }
    } finally { c.restore(); }
    expect(c.errors.filter(e => /a counted run needs --preregistration <path>.*nothing was sent/.test(e))).toHaveLength(4);
    expect(c.errors.filter(e => /preregistration attestation failed: .*does not exist.*nothing was sent/.test(e))).toHaveLength(4);
    expect(c.errors.some(e => /not set/.test(e))).toBe(false);
    expect(c.calls).toEqual([]);
    expect(ledgerStatus({ ledgerPath, runId }).run!.remaining_usd).toBe(5000);
  });

  test('a smoke needs no preregistration, and a pushed one attests for a counted run', async () => {
    const { ledgerPath, runId } = openRun('predictive-prereg-pass-test');
    const repo = mkdtempSync(join(tmpdir(), 'predictive-prereg-repo-'));
    const remote = mkdtempSync(join(tmpdir(), 'predictive-prereg-remote-'));
    const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    g(remote, 'init', '-q', '--bare');
    g(repo, 'init', '-q', '-b', 'main');
    g(repo, 'config', 'user.email', 't@example.com');
    g(repo, 'config', 'user.name', 't');
    g(repo, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'prereg.md'), 'fictional preregistration\n');
    g(repo, 'add', 'prereg.md');
    g(repo, 'commit', '-q', '-m', 'prereg');
    g(repo, 'remote', 'add', 'origin', remote);
    g(repo, 'push', '-q', 'origin', 'main');
    g(repo, 'fetch', '-q', 'origin');
    const base = ['--budget-run-id', runId, '--budget-ledger', ledgerPath, '--tasks', '1', '--k', '1'];
    const c = capture();
    const cwd = process.cwd();
    try {
      expect(await main(['g4', '--paid', '--smoke', ...base, '--out', join(dir, 'prereg-smoke')])).toBe(2);
      process.chdir(repo);
      expect(await main(['g4', '--paid', ...base, '--preregistration', 'prereg.md', '--out', join(dir, 'prereg-counted')])).toBe(2);
    } finally { process.chdir(cwd); c.restore(); rmSync(repo, { recursive: true, force: true }); rmSync(remote, { recursive: true, force: true }); }
    expect(c.errors.some(e => /preregistration/.test(e))).toBe(false);
    expect(c.errors.filter(e => /not set; nothing was sent/.test(e))).toHaveLength(2);
    expect(c.calls).toEqual([]);
  });
});

/** A two-turn episode on an arm with one lookup tool: turn 1 calls lookup, turn 2 submits. */
const lookupArm: Arm = {
  name: 'lookup', systemHint: () => 'lookup arm', writeTools: () => [], call: async () => 'fictional lookup result',
  tools: () => [{ name: 'lookup', description: 'Look a fictional fact up.', input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }],
};
const twoTurnJob = (model: string): PaidJob => ({
  key: 'route:' + model, unit: 'test', model,
  run: async fetchImpl => {
    const run = await runAgent({ model, system: 'test', user: 'fictional question', arm: lookupArm, fetchImpl, classifyStops: true, maxTurns: 3 });
    return { success: run.final !== null, usd: run.usd, stop: run.stop, model: run.model };
  },
});

describe('the OpenAI and particle routes', () => {
  test('gpt-6.1-sol: Responses requests reconcile on the ledger from usage with cached input', async () => {
    const seen: Array<{ url: string; body: Record<string, any> }> = [];
    const usage = { input_tokens: 1200, input_tokens_details: { cached_tokens: 800 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 40 } };
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = JSON.parse(String(init?.body));
      seen.push({ url, body });
      const n = seen.length;
      const call = n === 1 ? { name: 'lookup', arguments: JSON.stringify({ q: 'fictional' }) } : { name: 'submit_answer', arguments: JSON.stringify({ answer: 'fictional answer' }) };
      return new Response(JSON.stringify({ id: `resp_fake_${n}`, object: 'response', model: body.model, status: 'completed',
        output: [{ type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, ...call }], usage }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const model = 'gpt-6.1-sol';
    const { run, guard } = paidRun('predictive-openai-route-test', 5, fetchImpl);
    let result;
    try { result = await runPaid([twoTurnJob(model)], { log: join(dir, 'openai', 'episodes.jsonl'), concurrency: 1, retryErrored: false, counted: false, gbrain: GBRAIN, guard, resumeCommand: 'x', print: () => {} }); }
    finally { guard.uninstall(); }
    const summary = run.close({ finish: false });
    expect(seen.map(s => s.url)).toEqual(['https://api.openai.com/v1/responses', 'https://api.openai.com/v1/responses']);
    expect(seen[0].body).toMatchObject({ model, instructions: expect.stringContaining('test'), input: [{ role: 'user', content: 'fictional question' }] });
    expect(seen[0].body.tools.map((t: { name: string }) => t.name)).toEqual(['lookup', 'submit_answer']);
    expect(seen[0].body.temperature).toBeUndefined();
    expect(seen[1].body).toMatchObject({ store: false, input: [{ role: 'user', content: 'fictional question' }, { type: 'function_call', call_id: 'call_1', name: 'lookup' }, { type: 'function_call_output', call_id: 'call_1', output: 'fictional lookup result' }] });
    expect(seen[1].body.previous_response_id).toBeUndefined();
    expect(result.status).toBe('complete');
    const row = result.done[0];
    expect(row.record).toMatchObject({ stop: 'submitted', success: true });
    expect(row.usage).toEqual({ requests: 2, input: 2 * 400, output: 200, cache_read: 2 * 800, cache_write: 0 });
    const perRequest = priceUsage(model, { input: 400, output: 100, cache_read: 800, cache_write: 0 });
    expect(perRequest).toBeLessThan(priceUsage(model, { input: 1200, output: 100, cache_read: 0, cache_write: 0 }));
    expect(row.record!.usd).toBeCloseTo(2 * perRequest, 9);
    expect(summary).toMatchObject({ requests: 2, charged_reservations: 0 });
    expect(summary.actual_usd).toBeCloseTo(2 * perRequest, 6);
  });

  test('particle-1: Chat Completions requests reconcile on the ledger from usage with cached prompt tokens', async () => {
    const seen: Array<{ url: string; body: Record<string, any> }> = [];
    const usage = { prompt_tokens: 1200, prompt_tokens_details: { cached_tokens: 800 }, completion_tokens: 100, total_tokens: 1300 };
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = JSON.parse(String(init?.body));
      seen.push({ url, body });
      const n = seen.length;
      const fn = n === 1 ? { name: 'lookup', arguments: JSON.stringify({ q: 'fictional' }) } : { name: 'submit_answer', arguments: JSON.stringify({ answer: 'fictional answer' }) };
      return new Response(JSON.stringify({ id: `chatcmpl_${n}`, object: 'chat.completion', model: 'particle-ai/particle-1',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `tc_${n}`, type: 'function', function: fn }] } }], usage }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const model = 'particle-1';
    process.env.PARTICLE_API_KEY = 'fake-test-key-not-a-secret';
    const { run, guard } = paidRun('predictive-particle-route-test', 5, fetchImpl);
    let result;
    try { result = await runPaid([twoTurnJob(model)], { log: join(dir, 'particle', 'episodes.jsonl'), concurrency: 1, retryErrored: false, counted: false, gbrain: GBRAIN, guard, resumeCommand: 'x', print: () => {} }); }
    finally { guard.uninstall(); delete process.env.PARTICLE_API_KEY; }
    const summary = run.close({ finish: false });
    expect(seen.map(s => s.url)).toEqual(['https://api.particle.ai/v1/chat/completions', 'https://api.particle.ai/v1/chat/completions']);
    expect(seen[0].body).toMatchObject({ model, tool_choice: 'auto', messages: [{ role: 'system' }, { role: 'user', content: 'fictional question' }] });
    expect(seen[0].body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(['lookup', 'submit_answer']);
    expect(seen[1].body.messages.slice(-2)).toMatchObject([{ role: 'assistant', tool_calls: [{ id: 'tc_1' }] }, { role: 'tool', tool_call_id: 'tc_1', content: 'fictional lookup result' }]);
    expect(result.status).toBe('complete');
    const row = result.done[0];
    expect(row.record).toMatchObject({ stop: 'submitted', success: true });
    expect(row.usage).toEqual({ requests: 2, input: 2 * 400, output: 200, cache_read: 2 * 800, cache_write: 0 });
    const perRequest = priceUsage(model, { input: 400, output: 100, cache_read: 800, cache_write: 0 });
    expect(row.record!.usd).toBeCloseTo(2 * perRequest, 9);
    expect(summary).toMatchObject({ requests: 2, charged_reservations: 0 });
    expect(summary.actual_usd).toBeCloseTo(2 * perRequest, 6);
  });
});

describe('the Ubicloud launcher, with a fake runner and no keys', () => {
  const REPO = join(import.meta.dir, '../..');

  test('run.sh refuses to launch beside a live VM of its owner, and launches once none remains', () => {
    const root = join(dir, 'ubi');
    mkdirSync(root, { recursive: true });
    const fake = join(root, 'fake-ubi.sh');
    writeFileSync(fake, '#!/usr/bin/env bash\ncase "$1" in\n  list) cat "$(dirname "$0")/vms" ;;\n  run) echo launched >> "$(dirname "$0")/launches" ;;\nesac\n', { mode: 0o755 });
    const env = { PATH: process.env.PATH!, HOME: join(root, 'home'), UBI_RUNNER: fake };
    const launch = () => spawnSync('bash', ['eval/runner/predictive/ubicloud/run.sh', 'g4', 'smoke', '1'], { cwd: REPO, env, encoding: 'utf8' });
    writeFileSync(join(root, 'vms'), 'ubirun-gbev55-old running\n');
    const refused = launch();
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('second ledger writer');
    expect(existsSync(join(root, 'launches'))).toBe(false);
    writeFileSync(join(root, 'vms'), '');
    expect(launch().status).toBe(0);
    expect(readFileSync(join(root, 'launches'), 'utf8')).toBe('launched\n');
  });

  test('run.sh refuses a second launch of the same unit and mode while the first holds the state lock', () => {
    const root = join(dir, 'ubi-lock');
    mkdirSync(root, { recursive: true });
    const fake = join(root, 'fake-ubi.sh');
    writeFileSync(fake, '#!/usr/bin/env bash\ncase "$1" in\n  list) : ;;\n  run) echo launched >> "$(dirname "$0")/launches" ;;\nesac\n', { mode: 0o755 });
    const home = join(root, 'home');
    const state = join(home, '.capy/work/predictive/g4-smoke');
    mkdirSync(state, { recursive: true });
    const env = { PATH: process.env.PATH!, HOME: home, UBI_RUNNER: fake };
    const held = spawnSync('flock', [state, 'bash', 'eval/runner/predictive/ubicloud/run.sh', 'g4', 'smoke', '1'], { cwd: REPO, env, encoding: 'utf8' });
    expect(held.status).toBe(2);
    expect(held.stderr).toContain('another launch of g4 smoke holds');
    expect(existsSync(join(root, 'launches'))).toBe(false);
    expect(spawnSync('bash', ['eval/runner/predictive/ubicloud/run.sh', 'g4', 'smoke', '1'], { cwd: REPO, env, encoding: 'utf8' }).status).toBe(0);
    expect(readFileSync(join(root, 'launches'), 'utf8')).toBe('launched\n');
  });

  test('run.sh refuses to launch when listing VMs fails, and its teardown check fails too', () => {
    const root = join(dir, 'ubi-list-fails');
    mkdirSync(root, { recursive: true });
    const fake = join(root, 'fake-ubi.sh');
    writeFileSync(fake, '#!/usr/bin/env bash\ncase "$1" in\n  list) echo "HTTP 503" >&2; exit 1 ;;\n  run) echo launched >> "$(dirname "$0")/launches" ;;\nesac\n', { mode: 0o755 });
    const env = { PATH: process.env.PATH!, HOME: join(root, 'home'), UBI_RUNNER: fake };
    const refused = spawnSync('bash', ['eval/runner/predictive/ubicloud/run.sh', 'g4', 'smoke', '1'], { cwd: REPO, env, encoding: 'utf8' });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('could not list the VMs of owner gbev55');
    expect(existsSync(join(root, 'launches'))).toBe(false);
    expect(spawnSync('bash', ['eval/runner/predictive/ubicloud/run.sh', 'check'], { cwd: REPO, env, encoding: 'utf8' }).status).toBe(1);
  });

  test('vm-run.sh reuses an open budget run with money left, and opens a new one after a launch that paused', () => {
    const home = join(dir, 'vm-home');
    const S = join(home, 'work', 'g4-smoke');
    const vmRun = () => spawnSync('bash', ['eval/runner/predictive/ubicloud/vm-run.sh', 'g4', 'smoke', '1'], { cwd: REPO, env: { PATH: process.env.PATH!, HOME: home }, encoding: 'utf8' });
    const first = vmRun();
    expect(first.status).toBe(2);
    expect(first.stderr).toMatch(/not set; nothing was sent/);
    const rid = readFileSync(join(S, 'run-id'), 'utf8').trim();
    vmRun();
    expect(readFileSync(join(S, 'run-id'), 'utf8').trim()).toBe(rid);
    writeFileSync(join(S, 'out', 'summary.json'), JSON.stringify({ status: 'paused' }));
    vmRun();
    const next = readFileSync(join(S, 'run-id'), 'utf8').trim();
    expect(next).not.toBe(rid);
    expect(ledgerStatus({ ledgerPath: join(S, 'ledger.sqlite'), runId: next }).run).toMatchObject({ finished_at: null });
  }, 60_000);
});

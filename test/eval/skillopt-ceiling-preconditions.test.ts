/**
 * GST-903's N15-path preconditions for the SkillOpt ceiling attempt (GBEV-30,
 * plan section 1), keyless:
 *
 * - a frontier receipt from another gbrain pin is refused unless --accept-pin
 *   names it;
 * - the proposer input withholds gold only from the training-task block, so
 *   the seed and criteria text reach the proposer verbatim;
 * - the harness is the only retry layer: the AI SDK sends each rollout and
 *   proposer request once, and `scoreArm` retries a rollout only after a
 *   failure that provably produced no billable completion;
 * - a refusal is terminal: a budget refusal (the ledger, gbrain's hook cap or
 *   a metering proxy's 402 or 503) or the proxy's tripwire stops the arm, no
 *   later rollout calls anything, and the arm reads incomplete or invalid;
 * - every provider request the gate's paths and gbrain's own SkillOpt make
 *   (rollouts on both targets, the harness proposer, `runSkillOpt` one-shot
 *   and two loop steps) goes through the budget ledger: the test answers
 *   provider URLs from an in-process HTTP fake below the ledger's fetch guard
 *   and refuses every other host; a forwarded 504 without usage is sent once,
 *   charged at its reservation and never retried.
 */
// First import: the budget ledger replaces globalThis.fetch before gbrain or an SDK can capture it.
import { BudgetExceededError, BudgetRun, initLedger, installPaidRequestGuard, readLedger } from '../../eval/runner/budget-ledger.ts';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APICallError } from 'ai';
import { runSkillOpt, SKILLOPT_HOOK_BUDGET_EXHAUSTED, type BenchmarkTask } from 'gbrain/core/skillopt';
import type { PGLiteEngine } from 'gbrain/pglite-engine';
import { withHermeticEnv } from '../../eval/runner/hermetic-env.ts';
import { pinAccepted } from '../../eval/runner/n15-skillopt-method.ts';
import { readSeed, readTasks } from '../../eval/runner/skillopt-method/dataset.ts';
import { fakeTransport, FRONTIER_TARGETS, lastUserText, openBrain, withProbeGateway, type ChatTransport } from '../../eval/runner/skillopt-method/headroom.ts';
import { proposeRewrite, proposerInput, PROPOSER_MODEL, WITHHELD, type TrainTrajectory } from '../../eval/runner/skillopt-method/one-shot.ts';
import { emptyMeter, refusalKind, scoreArm, unbilledFailure, type MeterTotals } from '../../eval/runner/skillopt-method/rollouts.ts';
import { valuePattern } from '../../eval/runner/skillopt-method/score.ts';

const INSTALLED = 'github:garrytan/gbrain#311a83bbefb127118acb252fe827cb047126aa4d';
const OLD = 'github:garrytan/gbrain#ca1281a2ed3236ac45adddb2d08e84423769c321';

describe('receipt pin', () => {
  test('a receipt from another pin is refused unless --accept-pin names it by spec or by at least 7 characters of its commit', () => {
    expect(pinAccepted(INSTALLED, INSTALLED, undefined)).toBe(true);
    expect(pinAccepted(OLD, INSTALLED, undefined)).toBe(false);
    expect(pinAccepted(OLD, INSTALLED, 'ca1281a2')).toBe(true);
    expect(pinAccepted(OLD, INSTALLED, OLD)).toBe(true);
    expect(pinAccepted(OLD, INSTALLED, 'ca1281')).toBe(false);
    expect(pinAccepted(OLD, INSTALLED, '311a83bb')).toBe(false);
    expect(pinAccepted(undefined, INSTALLED, 'ca1281a2')).toBe(false);
  });
});

describe('proposer input scope', () => {
  test("the seed and the criteria reach the proposer verbatim; only the training-task block is withheld from, and the input says what the marker means", () => {
    const seed = readSeed('fact-check');
    expect(seed).toContain('<5% unverifiable');
    const marker = { kind: 'value' as const, pattern: valuePattern({ kind: 'number', value: 5, unit: 'percent' }) };
    const trajectories: TrainTrajectory[] = [{ task_id: 't1', task: 'Check the claim.', answer: 'About 5% of the claims were unverifiable.', correct: false, failed: [], tool_calls: [] }];
    const criteria = 'A HIGH rating needs under 5% unverifiable claims.';
    const { text, withheld } = proposerInput({ seedText: seed, criteria, trajectories, markers: [marker], pages: { visible: new Set(), corpus: new Set() } });
    expect(text).toContain(seed.trim());
    expect(text).toContain(criteria);
    expect(text).toContain(`About ${WITHHELD} of the claims`);
    expect(withheld).toBe(1);
    expect(text).toContain(`${WITHHELD} marks a page or value from tasks you are not shown`);
  });
});

/** The metering proxy's error body (eval/runner/metering-proxy.ts, `json(status, kind, message)`). */
const proxyBody = (kind: string, message: string) => ({ error: { kind, type: kind, message: `metering proxy: ${message}` } });
const TRIPWIRE = proxyBody('invalid_request', 'tripwire: the request body carries 1 forbidden marker(s); the cell is invalid');
const apiError = (statusCode: number, body: unknown) =>
  new APICallError({ message: `HTTP ${statusCode}`, url: 'http://127.0.0.1:9/anthropic/v1/messages', requestBodyValues: {}, statusCode, responseBody: JSON.stringify(body) });

describe('transient rollout failures', () => {
  const status = (n: number) => Object.assign(new Error(`HTTP ${n}`), { statusCode: n });
  test('only a refusal before sending, a 429 or a 529 counts as unbilled, through cause chains and the SDK retry wrapper; a 5xx and a refusal never do', () => {
    expect(unbilledFailure(status(429))).toBe(true);
    expect(unbilledFailure(status(529))).toBe(true);
    expect(unbilledFailure(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(unbilledFailure(new Error('wrapped', { cause: status(529) }))).toBe(true);
    expect(unbilledFailure(Object.assign(new Error('retries exhausted'), { lastError: status(429), errors: [status(429)] }))).toBe(true);
    expect(unbilledFailure(status(500))).toBe(false);
    expect(unbilledFailure(status(504))).toBe(false);
    expect(unbilledFailure(status(400))).toBe(false);
    expect(unbilledFailure(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(false);
    expect(unbilledFailure(new BudgetExceededError('cap'))).toBe(false);
    expect(unbilledFailure(new Error('wrapped', { cause: new BudgetExceededError('cap') }))).toBe(false);
    expect(unbilledFailure(Object.assign(new Error('wrapped', { cause: new BudgetExceededError('cap') }), { errors: [status(429)] }))).toBe(false);
    expect(unbilledFailure(Object.assign(new Error('wrapped', { cause: apiError(403, TRIPWIRE) }), { errors: [status(429)] }))).toBe(false);
  });

  test('refusalKind reads the ledger, gbrain\'s hook cap and the metering proxy\'s budget and tripwire answers, anywhere in the cause chain', () => {
    expect(refusalKind(new BudgetExceededError('cap'))).toBe('budget');
    expect(refusalKind(apiError(402, proxyBody('budget', 'reserving $0.0500 would take this lease over its cap')))).toBe('budget');
    expect(refusalKind(apiError(503, proxyBody('budget', "ANTHROPIC_API_KEY is not set in the proxy's environment")))).toBe('budget');
    expect(refusalKind(new Error(`${SKILLOPT_HOOK_BUDGET_EXHAUSTED}: the rollout server's cap is spent`))).toBe('budget');
    expect(refusalKind(apiError(403, TRIPWIRE))).toBe('invalid-cell');
    expect(refusalKind(new Error('[chat] HTTP 402', { cause: apiError(402, proxyBody('budget', 'over the lease cap')) }))).toBe('budget');
    expect(refusalKind(new Error('wrapped', { cause: new BudgetExceededError('cap') }))).toBe('budget');
    expect(refusalKind(Object.assign(new Error('retries exhausted'), { lastError: apiError(403, TRIPWIRE) }))).toBe('invalid-cell');
    expect(refusalKind(apiError(403, proxyBody('invalid_request', 'route POST /anthropic/v1/files is not allowlisted')))).toBeNull();
    expect(refusalKind(apiError(500, { type: 'error', error: { type: 'api_error', message: 'Internal server error' } }))).toBeNull();
    expect(refusalKind(apiError(504, { type: 'error', error: { type: 'api_error', message: 'upstream gateway timed out' } }))).toBeNull();
    expect(refusalKind(apiError(402, { error: { message: 'insufficient credits' } }))).toBeNull();
    expect(refusalKind(apiError(503, { type: 'error', error: { type: 'overloaded_error', message: 'Service unavailable' } }))).toBeNull();
    expect(refusalKind(status(429))).toBeNull();
  });

  test('a budget refusal is terminal: no later rollout reaches a provider, nothing retries, and the arm reads incomplete', async () => {
    const tasks = readTasks('query', 'sel').slice(0, 6);
    const refusedTask = tasks[0]!;
    const base = fakeTransport(tasks);
    const reached: string[] = [];
    let release!: () => void;
    const released = new Promise<void>(r => { release = r; });
    let refused = false;
    const transport: ChatTransport = async opts => {
      const task = tasks.find(t => lastUserText(opts).includes(t.task))!;
      reached.push(task.task_id);
      if (task === refusedTask) {
        refused = true;
        setTimeout(release, 50);
        throw new Error('reservation refused', { cause: new BudgetExceededError('cap') });
      }
      if (!refused) await released;
      return base(opts);
    };
    const meter = emptyMeter();
    const retried: string[] = [];
    const arm = await withHermeticEnv('ceiling-budget-refusal', async () => {
      const engine = await openBrain();
      try {
        return await withProbeGateway({ chatModel: FRONTIER_TARGETS.opus, fake: true, transport, keys: ['ANTHROPIC_API_KEY'] }, () =>
          scoreArm({ engine, skillText: readSeed('query'), tasks, model: FRONTIER_TARGETS.opus, runs: 1, meter, retryDelaysMs: [0], onRetry: id => retried.push(id) }));
      } finally {
        await engine.disconnect().catch(() => {});
      }
    });
    expect(arm.score).toBeNull();
    expect(arm.budget_exhausted).toBe(true);
    expect(arm.error).toStartWith('budget refusal: ');
    expect(arm.task_medians).toBeUndefined();
    expect(retried).toEqual([]);
    expect(meter.retries).toBe(0);
    // gbrain's gate keeps 4 rollouts in flight; the 3 held beside the refused one finish, and the 2 that start after it never reach a provider.
    expect([...reached].sort()).toEqual(tasks.slice(0, 4).map(t => t.task_id).sort());
    expect(meter.rollouts).toBe(4);
  }, 120_000);
});

/** An error answer for one provider request: its status and JSON body. */
type FakeError = { status: number; body: unknown } | null;

/**
 * An HTTP fake for the two providers, below the ledger's fetch guard: every
 * Anthropic Messages and OpenAI Responses request is recorded and answered
 * with `fail`'s error when it returns one, else with a short text and usage;
 * any other URL throws.
 */
function providerHttpFake(fail: (url: string, body: string) => FakeError = () => null) {
  const requests: string[] = [];
  const failed: string[] = [];
  let n = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const raw = String(init?.body ?? '{}');
    const body = JSON.parse(raw) as { model?: string };
    n++;
    if (url !== 'https://api.anthropic.com/v1/messages' && url !== 'https://api.openai.com/v1/responses') throw new Error(`outbound request refused in a keyless test: ${url}`);
    requests.push(url);
    const error = fail(url, raw);
    if (error) {
      failed.push(url);
      return json(error.body, error.status);
    }
    if (url === 'https://api.anthropic.com/v1/messages') {
      return json({ id: `msg_${n}`, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: "I don't know." }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 500, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    }
    return json({ id: `resp_${n}`, object: 'response', created_at: 1, status: 'completed', model: body.model, output: [{ type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: "I don't know.", annotations: [] }] }], reasoning: { effort: 'medium', summary: null }, incomplete_details: null, usage: { input_tokens: 500, output_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 510 } });
  }) as typeof fetch;
  return { requests, failed, impl };
}

/** Run `fn` on a fresh brain under the ledger's fetch guard over `fake`, with dummy keys for both providers; returns its result and the run's ledger entries. */
async function underLedger<T>(name: string, fake: ReturnType<typeof providerHttpFake>, fn: (engine: PGLiteEngine) => Promise<T>) {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  const ledgerPath = join(dir, 'ledger.sqlite');
  try {
    initLedger({ ledgerPath, programCapUsd: 100 });
    const run = BudgetRun.open({ runner: name, budgetUsd: 50, ledgerPath });
    const out = await withHermeticEnv(name, async () => {
      process.env.ANTHROPIC_API_KEY = 'dummy-keyless-test';
      process.env.OPENAI_API_KEY = 'dummy-keyless-test';
      const guard = installPaidRequestGuard(run, { fetchImpl: fake.impl });
      const engine = await openBrain();
      try {
        return await fn(engine);
      } finally {
        guard.uninstall();
        await engine.disconnect().catch(() => {});
      }
    });
    run.close();
    return { out, entries: readLedger(ledgerPath).entries.filter(e => e.run_id === run.runId) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The seed arm on one target through the real provider SDKs, with zero retry delays. */
const seedArm = (engine: PGLiteEngine, target: 'opus' | 'sol', tasks: ReturnType<typeof readTasks>, meter: MeterTotals, retried: string[]) =>
  withProbeGateway({ chatModel: FRONTIER_TARGETS[target], fake: false }, () =>
    scoreArm({ engine, skillText: readSeed('query'), tasks, model: FRONTIER_TARGETS[target], runs: 1, meter, retryDelaysMs: [0], onRetry: id => retried.push(id) }));

/** Whether a request body carries a task's text, as the provider SDKs encode it. */
const carries = (body: string, task: { task: string }) => body.includes(JSON.stringify(task.task).slice(1, -1));

const bench = (t: { task_id: string; task: string; judge: BenchmarkTask['judge'] }): BenchmarkTask => ({ task_id: t.task_id, task: t.task, judge: t.judge });

describe('ledger coverage below the fetch boundary', () => {
  test("rollouts on both targets, the harness proposer, and runSkillOpt's one-shot and two loop steps each reserve and settle one ledger entry per provider request", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ceiling-ledger-'));
    const ledgerPath = join(dir, 'ledger.sqlite');
    const fake = providerHttpFake();
    try {
      initLedger({ ledgerPath, programCapUsd: 100 });
      const run = BudgetRun.open({ runner: 'ceiling-ledger-coverage', budgetUsd: 50, ledgerPath });
      const outcomes = await withHermeticEnv('ceiling-ledger', async h => {
        process.env.ANTHROPIC_API_KEY = 'dummy-keyless-test';
        process.env.OPENAI_API_KEY = 'dummy-keyless-test';
        const guard = installPaidRequestGuard(run, { fetchImpl: fake.impl });
        const engine = await openBrain();
        try {
          const train = readTasks('query', 'train').slice(0, 4);
          const sel = readTasks('query', 'sel').slice(0, 5);
          const seed = readSeed('query');
          for (const target of ['opus', 'sol'] as const) {
            await withProbeGateway({ chatModel: FRONTIER_TARGETS[target], fake: false }, () =>
              scoreArm({ engine, skillText: seed, tasks: sel.slice(0, 2), model: FRONTIER_TARGETS[target], runs: 1 }));
          }
          await withProbeGateway({ chatModel: PROPOSER_MODEL, fake: false }, () => proposeRewrite('input', seed));
          const result: string[] = [];
          for (const optimizerMode of ['one-shot-rewrite', 'reflect'] as const) {
            const skillsDir = join(h.home, `skills-${optimizerMode}`);
            mkdirSync(join(skillsDir, 'query'), { recursive: true });
            writeFileSync(join(skillsDir, 'query', 'SKILL.md'), seed);
            const r = await withProbeGateway({ chatModel: FRONTIER_TARGETS.opus, fake: false }, () => runSkillOpt({
              engine, skillName: 'query', skillsDir, tasks: { train: train.map(bench), sel: sel.map(bench) },
              epochs: 1, batchSize: 2, lr: 4, lrSchedule: 'cosine',
              optimizerModel: PROPOSER_MODEL, targetModel: FRONTIER_TARGETS.opus, judgeModel: FRONTIER_TARGETS.opus,
              mode: 'patch', dryRun: false, noMutate: true, allowMutateBundled: false, bootstrapReviewed: false, json: true,
              maxCostUsd: 0, maxRuntimeMin: 10, force: true, optimizerMode,
            }));
            result.push(`${optimizerMode}:${r.outcome}:${r.receipt.stop_reason ?? ''}`);
          }
          return result;
        } finally {
          guard.uninstall();
          await engine.disconnect().catch(() => {});
        }
      });
      const summary = run.close();
      const entries = readLedger(ledgerPath).entries.filter(e => e.run_id === run.runId);
      expect(fake.requests.length).toBeGreaterThan(12);
      expect(fake.requests).toContain('https://api.openai.com/v1/responses');
      expect(entries).toHaveLength(fake.requests.length);
      expect(entries.every(e => e.status === 'reconciled' && e.actual_usd !== null && e.actual_usd > 0)).toBe(true);
      expect(summary).toMatchObject({ requests: fake.requests.length, charged_reservations: 0 });
      expect(outcomes).toEqual(['one-shot-rewrite:no_improvement:completed', 'reflect:errored:early_stop_unusable_output']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  test("a metering proxy's budget refusal (402, or 503 for a missing key) and its tripwire (403) stop the arm after one provider request, with no retry at any layer", async () => {
    const cases = [
      { status: 402, body: proxyBody('budget', 'reserving $0.0500 would take this lease over its cap'), flag: { budget_exhausted: true } },
      { status: 503, body: proxyBody('budget', "ANTHROPIC_API_KEY is not set in the proxy's environment"), flag: { budget_exhausted: true } },
      { status: 403, body: TRIPWIRE, flag: { cell_invalid: true } },
    ];
    let answer: FakeError = null;
    const fake = providerHttpFake(() => answer);
    const { out } = await underLedger('ceiling-refusals', fake, async engine => {
      const seen = [];
      for (const target of ['opus', 'sol'] as const) {
        for (const c of cases) {
          answer = { status: c.status, body: c.body };
          const before = fake.requests.length;
          const meter = emptyMeter();
          const retried: string[] = [];
          const arm = await seedArm(engine, target, readTasks('query', 'sel').slice(0, 1), meter, retried);
          seen.push({ target, status: c.status, flag: c.flag, arm, requests: fake.requests.length - before, retried, retries: meter.retries });
        }
      }
      return seen;
    });
    expect(out).toHaveLength(6);
    for (const r of out) {
      expect({ target: r.target, status: r.status, requests: r.requests, retried: r.retried, retries: r.retries }).toEqual({ target: r.target, status: r.status, requests: 1, retried: [], retries: 0 });
      expect(r.arm).toMatchObject({ score: null, ...r.flag });
    }
  }, 120_000);

  test('a forwarded 504 with no usage is sent once, charged at its reservation, never retried, and leaves the arm with no score', async () => {
    const tasks = readTasks('query', 'sel').slice(0, 3);
    const broken = tasks[1]!;
    const fake = providerHttpFake((url, body) => (carries(body, broken)
      ? { status: 504, body: url.includes('anthropic') ? { type: 'error', error: { type: 'api_error', message: 'upstream gateway timed out' } } : { error: { message: 'upstream gateway timed out', type: 'server_error', param: null, code: null } } }
      : null));
    const meter = emptyMeter();
    const retried: string[] = [];
    const { out: arms, entries } = await underLedger('ceiling-ledger-504', fake, async engine => [
      await seedArm(engine, 'opus', tasks, meter, retried),
      await seedArm(engine, 'sol', tasks, meter, retried),
    ]);
    expect(fake.failed).toEqual(['https://api.anthropic.com/v1/messages', 'https://api.openai.com/v1/responses']);
    const charged = entries.filter(e => e.status === 'charged-reservation');
    expect(charged).toHaveLength(2);
    expect(charged.every(e => e.reserved_usd > 0 && e.actual_usd === e.reserved_usd)).toBe(true);
    expect(entries).toHaveLength(fake.requests.length);
    expect(fake.requests).toHaveLength(2 * tasks.length);
    expect(retried).toEqual([]);
    expect(meter.retries).toBe(0);
    for (const arm of arms) {
      expect(arm.score).toBeNull();
      expect(arm.error).toStartWith(`1 of 3 tasks errored (${broken.task_id})`);
      expect(arm.budget_exhausted).toBeUndefined();
      expect(arm.cell_invalid).toBeUndefined();
    }
  }, 120_000);

  test('a 529 (Anthropic) or 429 (OpenAI) is retried by the harness alone, one SDK attempt per harness attempt, and the arm scores', async () => {
    const tasks = readTasks('query', 'sel').slice(0, 2);
    const flaky = tasks[0]!;
    const hits = new Map<string, number>();
    const fake = providerHttpFake((url, body) => {
      if (!carries(body, flaky)) return null;
      const n = (hits.get(url) ?? 0) + 1;
      hits.set(url, n);
      if (n > 1) return null;
      return url.includes('anthropic')
        ? { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }
        : { status: 429, body: { error: { message: 'Rate limit reached', type: 'requests', param: null, code: 'rate_limit_exceeded' } } };
    });
    const meter = emptyMeter();
    const retried: string[] = [];
    const { out: arms } = await underLedger('ceiling-ledger-529', fake, async engine => [
      await seedArm(engine, 'opus', tasks, meter, retried),
      await seedArm(engine, 'sol', tasks, meter, retried),
    ]);
    expect(retried).toEqual([flaky.task_id, flaky.task_id]);
    expect(meter.retries).toBe(2);
    expect(meter.rollouts).toBe(2 * tasks.length);
    expect(Object.fromEntries(hits)).toEqual({ 'https://api.anthropic.com/v1/messages': 2, 'https://api.openai.com/v1/responses': 2 });
    expect(fake.failed).toHaveLength(2);
    for (const arm of arms) {
      expect(arm.error).toBeUndefined();
      expect(arm.score).not.toBeNull();
    }
  }, 120_000);

  test('the harness proposer sends a forwarded 504 once and fails', async () => {
    const fake = providerHttpFake(() => ({ status: 504, body: { type: 'error', error: { type: 'api_error', message: 'upstream gateway timed out' } } }));
    const { out: error, entries } = await underLedger('ceiling-proposer-504', fake, async () => {
      try {
        await withProbeGateway({ chatModel: PROPOSER_MODEL, fake: false }, () => proposeRewrite('input', 'seed'));
        return null;
      } catch (e) {
        return e;
      }
    });
    expect(error).not.toBeNull();
    expect(fake.requests).toEqual(['https://api.anthropic.com/v1/messages']);
    expect(entries.map(e => e.status)).toEqual(['charged-reservation']);
  }, 60_000);

  test('a run whose budget cannot cover the next request refuses it before sending', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ceiling-ledger-cap-'));
    const ledgerPath = join(dir, 'ledger.sqlite');
    const fake = providerHttpFake();
    try {
      initLedger({ ledgerPath, programCapUsd: 100 });
      const run = BudgetRun.open({ runner: 'ceiling-ledger-cap', budgetUsd: 0.001, ledgerPath });
      const { error, arm } = await withHermeticEnv('ceiling-ledger-cap', async () => {
        process.env.ANTHROPIC_API_KEY = 'dummy-keyless-test';
        const guard = installPaidRequestGuard(run, { fetchImpl: fake.impl });
        const engine = await openBrain();
        try {
          const arm = await withProbeGateway({ chatModel: FRONTIER_TARGETS.opus, fake: false }, () =>
            scoreArm({ engine, skillText: readSeed('query'), tasks: readTasks('query', 'sel').slice(0, 6), model: FRONTIER_TARGETS.opus, runs: 1 }));
          try {
            await withProbeGateway({ chatModel: PROPOSER_MODEL, fake: false }, () => proposeRewrite('input', 'seed'));
            return { error: null, arm };
          } catch (e) {
            return { error: e, arm };
          }
        } finally {
          guard.uninstall();
          await engine.disconnect().catch(() => {});
        }
      });
      run.close();
      expect(String(error)).toMatch(/reserving \$[\d.]+ would take this run to \$[\d.]+, over its \$0\.00 budget/);
      expect(unbilledFailure(error)).toBe(false);
      expect(refusalKind(error)).toBe('budget');
      expect(arm).toMatchObject({ score: null, budget_exhausted: true });
      expect(fake.requests).toEqual([]);
      expect(readLedger(ledgerPath).entries.filter(e => e.run_id === run.runId)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

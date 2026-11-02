/**
 * GST-903's N15-path preconditions for the SkillOpt ceiling attempt (GBEV-30,
 * plan section 1), keyless:
 *
 * - a frontier receipt from another gbrain pin is refused unless --accept-pin
 *   names it;
 * - the proposer input withholds gold only from the training-task block, so
 *   the seed and criteria text reach the proposer verbatim;
 * - a rollout is retried only after a failure that provably produced no
 *   billable completion, and an arm may leave a bounded number of errored
 *   tasks out of its score;
 * - every provider request the gate's paths and gbrain's own SkillOpt make
 *   (rollouts on both targets, the harness proposer, `runSkillOpt` one-shot
 *   and two loop steps) goes through the budget ledger: the test answers
 *   provider URLs from an in-process HTTP fake below the ledger's fetch guard
 *   and refuses every other host.
 */
// First import: the budget ledger replaces globalThis.fetch before gbrain or an SDK can capture it.
import { BudgetExceededError, BudgetRun, initLedger, installPaidRequestGuard, readLedger } from '../../eval/runner/budget-ledger.ts';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSkillOpt, type BenchmarkTask } from 'gbrain/core/skillopt';
import { withHermeticEnv } from '../../eval/runner/hermetic-env.ts';
import { pinAccepted } from '../../eval/runner/n15-skillopt-method.ts';
import { readSeed, readTasks } from '../../eval/runner/skillopt-method/dataset.ts';
import { fakeReply, fakeTransport, FRONTIER_TARGETS, lastUserText, openBrain, withProbeGateway, type ChatTransport } from '../../eval/runner/skillopt-method/headroom.ts';
import { proposeRewrite, proposerInput, PROPOSER_MODEL, WITHHELD, type TrainTrajectory } from '../../eval/runner/skillopt-method/one-shot.ts';
import { emptyMeter, scoreArm, unbilledFailure } from '../../eval/runner/skillopt-method/rollouts.ts';
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

describe('transient rollout failures', () => {
  const status = (n: number) => Object.assign(new Error(`HTTP ${n}`), { statusCode: n });
  test('only a refusal before sending, a 429 or a 529 counts as unbilled, through cause chains and the SDK retry wrapper; a 5xx and a budget refusal never do', () => {
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
  });

  test('a 529 rollout is retried and scored, a 504 is not; within maxErroredTasks the errored task is left out and listed', async () => {
    const tasks = readTasks('query', 'sel').slice(0, 4);
    const [flaky, broken] = [tasks[0]!, tasks[1]!];
    const base = fakeTransport(tasks);
    let flakyCalls = 0;
    const transport: ChatTransport = async opts => {
      const text = lastUserText(opts);
      if (text.includes(flaky.task) && flakyCalls++ === 0) throw status(529);
      if (text.includes(broken.task)) throw status(504);
      return base(opts);
    };
    const meter = emptyMeter();
    const retried: string[] = [];
    const arm = await withHermeticEnv('ceiling-retry', async () => {
      const engine = await openBrain();
      try {
        return await withProbeGateway({ chatModel: FRONTIER_TARGETS.opus, fake: true, transport, keys: ['ANTHROPIC_API_KEY'] }, () =>
          scoreArm({ engine, skillText: readSeed('query'), tasks, model: FRONTIER_TARGETS.opus, runs: 1, meter, maxErroredTasks: 1, retryDelaysMs: [0], onRetry: id => retried.push(id) }));
      } finally {
        await engine.disconnect().catch(() => {});
      }
    });
    expect(retried).toEqual([flaky.task_id]);
    expect(meter.retries).toBe(1);
    expect(meter.rollouts).toBe(4);
    expect(arm.errored_tasks).toEqual([broken.task_id]);
    expect(arm.score).not.toBeNull();
    expect(Object.keys(arm.task_medians!).sort()).toEqual(tasks.filter(t => t !== broken).map(t => t.task_id).sort());
    expect(arm.score).toBeCloseTo(Object.values(arm.task_medians!).reduce((a, b) => a + b, 0) / 3, 12);
  }, 120_000);
});

/**
 * An HTTP fake for the two providers, below the ledger's fetch guard: every
 * Anthropic Messages and OpenAI Responses request is answered with a short
 * text and usage, and recorded; any other URL throws.
 */
function providerHttpFake() {
  const requests: string[] = [];
  let n = 0;
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
    n++;
    if (url === 'https://api.anthropic.com/v1/messages') {
      requests.push(url);
      return json({ id: `msg_${n}`, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: "I don't know." }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 500, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    }
    if (url === 'https://api.openai.com/v1/responses') {
      requests.push(url);
      return json({ id: `resp_${n}`, object: 'response', created_at: 1, status: 'completed', model: body.model, output: [{ type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: "I don't know.", annotations: [] }] }], reasoning: { effort: 'medium', summary: null }, incomplete_details: null, usage: { input_tokens: 500, output_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 510 } });
    }
    throw new Error(`outbound request refused in a keyless test: ${url}`);
  }) as typeof fetch;
  return { requests, impl };
}

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

  test('a run whose budget cannot cover the next request refuses it before sending', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ceiling-ledger-cap-'));
    const ledgerPath = join(dir, 'ledger.sqlite');
    const fake = providerHttpFake();
    try {
      initLedger({ ledgerPath, programCapUsd: 100 });
      const run = BudgetRun.open({ runner: 'ceiling-ledger-cap', budgetUsd: 0.001, ledgerPath });
      const error = await withHermeticEnv('ceiling-ledger-cap', async () => {
        process.env.ANTHROPIC_API_KEY = 'dummy-keyless-test';
        const guard = installPaidRequestGuard(run, { fetchImpl: fake.impl });
        try {
          await withProbeGateway({ chatModel: PROPOSER_MODEL, fake: false }, () => proposeRewrite('input', 'seed'));
          return null;
        } catch (e) {
          return e;
        } finally {
          guard.uninstall();
        }
      });
      run.close();
      expect(String(error)).toMatch(/reserving \$[\d.]+ would take this run to \$[\d.]+, over its \$0\.00 budget/);
      expect(unbilledFailure(error)).toBe(false);
      expect(fake.requests).toEqual([]);
      expect(readLedger(ledgerPath).entries.filter(e => e.run_id === run.runId)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

/**
 * Batch lane (eval/runner/batch/): ledger reservations, exactly-once
 * submission, reconciliation, settlement and the guard's batch allow-list.
 * Tests B1-B13 of the 2026-10 eng test plan plus the crash, partial-result
 * and malformed-usage cases. A fake provider stands in for both batch APIs;
 * nothing touches the network or spends money.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetExceededError, BudgetRun, closeLedgers, initLedger, installPaidRequestGuard, priceRequest, readLedger, runInBatchLane, verifyLedger, batchRequestKind } from '../../eval/runner/budget-ledger.ts';
import { buildManifest, freezeManifest, type ArmManifest } from '../../eval/runner/batch/manifest.ts';
import { readerBody } from '../../eval/runner/batch/sources.ts';
import { anthropicTransport, openAiTransport } from '../../eval/runner/batch/transport.ts';
import { BatchLane, laneTestHooks } from '../../eval/runner/batch/submit.ts';
import { worstCaseListUsd } from '../../eval/runner/batch/ledger.ts';
import { readerRows, scoreRows } from '../../eval/runner/batch/receipts.ts';
import { FakeProvider } from './batch-fake-provider.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'batch-lane-')); dirs.push(d); return d; };
const lanes: BatchLane[] = [];
afterEach(() => {
  for (const k of Object.keys(laneTestHooks) as (keyof typeof laneTestHooks)[]) delete laneTestHooks[k];
  for (const l of lanes.splice(0)) l.close();
  closeLedgers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(opts: { cap?: number; budget?: number; parallel?: boolean; fake?: FakeProvider; dir?: string; runId?: string } = {}) {
  const dir = opts.dir ?? tmp();
  const ledgerPath = join(dir, 'ledger.sqlite');
  if (!opts.dir) initLedger({ ledgerPath, programCapUsd: opts.cap ?? 10, reason: 'test' });
  const run = opts.runId ? BudgetRun.join({ runId: opts.runId, ledgerPath }) : BudgetRun.open({ runner: 'w10-test', budgetUsd: opts.budget ?? 5, ledgerPath });
  const fake = opts.fake ?? new FakeProvider();
  const transports = { openai: openAiTransport({ fetchImpl: fake.fetch, apiKey: 'test' }), anthropic: anthropicTransport({ fetchImpl: fake.fetch, apiKey: 'test' }) };
  const lane = new BatchLane({ statePath: join(dir, 'state.sqlite'), transports, run, parallel: opts.parallel, now: () => fake.clock, log: () => {} });
  lanes.push(lane);
  return { dir, ledgerPath, run, fake, lane, transports };
}

function arm(model: string, n = 3, armId = `arm-${model}`): { manifest: ArmManifest; bodies: Map<string, Record<string, unknown>> } {
  const bodies = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < n; i++) bodies.set(`q${i}`, readerBody(model, { system: 'SYSTEM', user: `Question:\nquestion ${i}\n\nRetrieved sessions:\n` }));
  const settings = model.startsWith('gpt') ? { provider: 'openai' as const, max: 12000, effort: 'medium' } : { provider: 'anthropic' as const, max: 4096, effort: 'low' };
  const manifest = buildManifest({ arm_id: armId, workstream: 'W10-test', kind: 'reader', provider: settings.provider, model, max_output_tokens: settings.max, reasoning_effort: settings.effort, protocol: { name: 't', sha256: 'x' }, source: 'test', denominator: n, bodies });
  return { manifest, bodies };
}

const openEntries = (ledgerPath: string) => readLedger(ledgerPath).entries.filter(e => e.actual_usd === null);

describe('reservations', () => {
  test('B1: an over-cap batch is never uploaded or submitted', async () => {
    const { lane, fake } = setup({ cap: 0.05, budget: 0.05 });
    const { manifest, bodies } = arm('claude-sonnet-5-5');
    await expect(lane.submit(manifest, bodies)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(fake.submissions.length).toBe(0);
    expect(fake.uploads.length).toBe(0);
    expect(lane.intents()[0].state).toBe('abandoned');
    const g = arm('gpt-6.1-sol');
    await expect(lane.submit(g.manifest, g.bodies)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(fake.uploads.length).toBe(0);
  });

  test('B2: reservation = sum of per-request worst cases x factor, exact dollars', async () => {
    const { lane, fake, ledgerPath } = setup();
    const { manifest, bodies } = arm('claude-sonnet-5-5');
    // 1,000 counted tokens + 16 margin at $2/M, plus 4,096 output tokens at $10/M, per request.
    const perRequest = (1016 * 2 + 4096 * 10) / 1e6;
    expect(worstCaseListUsd('anthropic', bodies.get('q0')!, 1016)).toBeCloseTo(perRequest, 12);
    const pilot = await lane.submit(manifest, bodies, { questionIds: ['q0'], pilot: true });
    expect(pilot.factor).toBe(1);
    expect(pilot.reserved_usd).toBeCloseTo(perRequest, 12);
    fake.finish(pilot.batch_id!);
    await lane.poll();
    expect(lane.factorFor('anthropic', 'claude-sonnet-5-5')).toMatchObject({ factor: 0.5, confirmed: true });
    const full = await lane.submit(manifest, bodies, { questionIds: ['q1', 'q2'], requireFactor: 0.5 });
    expect(full.reserved_usd).toBeCloseTo(2 * perRequest * 0.5, 12);
    expect(openEntries(ledgerPath).map(e => e.reserved_usd)[0]).toBeCloseTo(2 * perRequest * 0.5, 12);
  });

  test('B3: settlement applies the confirmed batch discount to provider usage', async () => {
    const { lane, fake, ledgerPath } = setup();
    const { manifest, bodies } = arm('claude-sonnet-5-5');
    const p = await lane.submit(manifest, bodies, { questionIds: ['q0'], pilot: true });
    fake.finish(p.batch_id!);
    const [pilotOutcome] = await lane.poll();
    expect(pilotOutcome.settled_usd).toBeCloseTo((900 * 2 + 100 * 10) / 1e6, 12);
    const full = await lane.submit(manifest, bodies, { questionIds: ['q1', 'q2'], requireFactor: 0.5 });
    fake.finish(full.batch_id!, () => ({ kind: 'ok', usage: { input_tokens: 2000, output_tokens: 300, service_tier: 'batch' } }));
    const [outcome] = await lane.poll();
    expect(outcome.settled_usd).toBeCloseTo(2 * ((2000 * 2 + 300 * 10) / 1e6) * 0.5, 12);
    expect(openEntries(ledgerPath).length).toBe(0);
    expect(verifyLedger(ledgerPath).ok).toBe(true);
  });

  test('B4: partial results settle succeeded rows at actual, failed rows at 0, close the reservation and list failed ids', async () => {
    const { lane, fake, ledgerPath } = setup();
    const { manifest, bodies } = arm('gpt-6.1-sol');
    const intent = await lane.submit(manifest, bodies);
    fake.finish(intent.batch_id!, (_c, _b, i) => (i === 1 ? { kind: 'expired' } : { kind: 'ok' }), { status: 'expired' });
    const [outcome] = await lane.poll();
    // gpt-6.1-sol: $2/M input, $10/M output, list price (no pilot).
    expect(outcome.settled_usd).toBeCloseTo(2 * ((900 * 2 + 100 * 10) / 1e6), 12);
    expect(outcome.counts).toEqual({ succeeded: 2, expired: 1 });
    expect(outcome.failed_question_ids).toEqual(['q1']);
    expect(lane.failedQuestionIds(manifest)).toEqual(['q1']);
    expect(openEntries(ledgerPath).length).toBe(0);
    const retry = await lane.submit(manifest, bodies, { questionIds: lane.failedQuestionIds(manifest) });
    expect(retry.items.map(i => i.question_id)).toEqual(['q1']);
  });

  test('malformed usage is charged at the worst case, never undercounted', async () => {
    const { lane, fake } = setup();
    const { manifest, bodies } = arm('claude-sonnet-5-5', 1);
    const intent = await lane.submit(manifest, bodies);
    fake.finish(intent.batch_id!, () => ({ kind: 'ok', usage: { weird: 'x' } }));
    const [outcome] = await lane.poll();
    expect(outcome.settled_usd).toBeCloseTo(intent.items[0].worst_list_usd, 12);
    expect(lane.results(manifest.arm_id).get('q0')!.cost_basis).toBe('worst-case');
  });

  test('L2: an unpriced model refuses before any request', async () => {
    expect(() => worstCaseListUsd('anthropic', { model: 'claude-unknown-9', max_tokens: 10, messages: [] }, 10)).toThrow(/no chat price/);
  });

  test('L3: the dated official judge snapshot is priced', () => {
    const p = priceRequest('https://api.openai.com/v1/chat/completions', { model: 'gpt-4o-2024-08-06', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] })!;
    expect([p.input, p.output]).toEqual([2.5, 10]);
  });
});

describe('exactly-once submission', () => {
  test('B5 (OpenAI): crash after the provider accepted, before the batch id was saved, adopts the batch by metadata and never posts a second batch', async () => {
    const s = setup();
    const { manifest, bodies } = arm('gpt-6.1-sol');
    laneTestHooks.afterCreate = () => { throw new Error('simulated crash'); };
    await expect(s.lane.submit(manifest, bodies)).rejects.toThrow('simulated crash');
    expect(s.lane.intents()[0].state).toBe('sending');
    delete laneTestHooks.afterCreate;
    const again = setup({ dir: s.dir, runId: s.run.runId, fake: s.fake });
    await expect(again.lane.submit(manifest, bodies)).rejects.toThrow(/one at a time/);
    expect(s.fake.submissions.length).toBe(1);
    const intent = again.lane.intents()[0];
    expect(intent.state).toBe('submitted');
    expect(intent.batch_id).toBe(s.fake.batches[0].id);
    s.fake.finish(intent.batch_id!);
    const [outcome] = await again.lane.poll();
    expect(outcome.state).toBe('settled');
    expect(s.fake.submissions.length).toBe(1);
  });

  test('B5 (Anthropic): the same crash adopts the one batch with the right count and time, then checks custom ids', async () => {
    const s = setup();
    const { manifest, bodies } = arm('claude-sonnet-5-5');
    laneTestHooks.afterCreate = () => { throw new Error('simulated crash'); };
    await expect(s.lane.submit(manifest, bodies)).rejects.toThrow('simulated crash');
    delete laneTestHooks.afterCreate;
    const again = setup({ dir: s.dir, runId: s.run.runId, fake: s.fake });
    const [touched] = await again.lane.reconcile();
    expect(touched.state).toBe('submitted');
    s.fake.finish(touched.batch_id!);
    const [outcome] = await again.lane.poll();
    expect(outcome.counts).toEqual({ succeeded: 3 });
    expect(s.fake.submissions.length).toBe(1);
  });

  test('a sending intent with no matching provider batch becomes unknown: not resubmitted, reservation held until an operator resolves it', async () => {
    const s = setup();
    const { manifest, bodies } = arm('gpt-6.1-sol');
    laneTestHooks.afterCreate = () => { throw new Error('simulated crash'); };
    await expect(s.lane.submit(manifest, bodies)).rejects.toThrow('simulated crash');
    delete laneTestHooks.afterCreate;
    s.fake.batches.splice(0);
    const again = setup({ dir: s.dir, runId: s.run.runId, fake: s.fake });
    await expect(again.lane.submit(manifest, bodies)).rejects.toThrow(/unknown/);
    expect(s.fake.submissions.length).toBe(1);
    expect(openEntries(s.ledgerPath).length).toBe(1);
    const resolved = again.lane.resolveUnknown(again.lane.intents()[0].intent_id, { notSubmitted: true, reason: 'checked the console: no batch' });
    expect(resolved.state).toBe('abandoned');
    expect(openEntries(s.ledgerPath).length).toBe(0);
  });

  test('crash before submission was attempted releases the reservation on restart', async () => {
    const s = setup();
    const { manifest, bodies } = arm('gpt-6.1-sol');
    const failing = { ...s.transports.openai, prepare: async () => { throw new Error('upload crashed'); } };
    const lane = new BatchLane({ statePath: join(s.dir, 'state.sqlite'), transports: { openai: failing }, run: s.run, now: () => s.fake.clock, log: () => {} });
    lanes.push(lane);
    await expect(lane.submit(manifest, bodies)).rejects.toThrow('upload crashed');
    expect(openEntries(s.ledgerPath).length).toBe(1);
    const again = setup({ dir: s.dir, runId: s.run.runId, fake: s.fake });
    const [touched] = await again.lane.reconcile();
    expect(touched.state).toBe('abandoned');
    expect(openEntries(s.ledgerPath).length).toBe(0);
    expect(s.fake.submissions.length).toBe(0);
  });

  test('B6: a restarted poll only polls; one submission in total', async () => {
    const s = setup();
    const { manifest, bodies } = arm('claude-sonnet-5-5');
    const intent = await s.lane.submit(manifest, bodies);
    const again = setup({ dir: s.dir, runId: s.run.runId, fake: s.fake });
    expect((await again.lane.poll())[0].state).toBe('submitted');
    s.fake.finish(intent.batch_id!);
    expect((await again.lane.poll())[0].state).toBe('settled');
    expect(await again.lane.poll()).toEqual([]);
    expect(s.fake.submissions.length).toBe(1);
  });

  test('B7: a body that differs from the frozen manifest refuses, naming the question', async () => {
    const { lane, fake, dir } = setup();
    const { manifest, bodies } = arm('claude-sonnet-5-5');
    freezeManifest(join(dir, 'm.json'), manifest);
    const drifted = new Map(bodies);
    drifted.set('q1', readerBody('claude-sonnet-5-5', { system: 'SYSTEM v2', user: 'Question:\nquestion 1\n\nRetrieved sessions:\n' }));
    await expect(lane.submit(manifest, drifted)).rejects.toThrow(/q1/);
    expect(() => freezeManifest(join(dir, 'm.json'), arm('claude-sonnet-5-5', 2).manifest)).toThrow(/immutable/);
    expect(fake.submissions.length).toBe(0);
  });

  test('completed rows are never resubmitted', async () => {
    const { lane, fake } = setup();
    const { manifest, bodies } = arm('claude-sonnet-5-5');
    const intent = await lane.submit(manifest, bodies);
    fake.finish(intent.batch_id!);
    await lane.poll();
    await expect(lane.submit(manifest, bodies, { questionIds: ['q0'] })).rejects.toThrow(/never resubmitted/);
    expect(lane.failedQuestionIds(manifest)).toEqual([]);
  });

  test('crash during settlement: a restart finds the ledger already settled and does not settle twice', async () => {
    const s = setup();
    const { manifest, bodies } = arm('claude-sonnet-5-5');
    const intent = await s.lane.submit(manifest, bodies);
    s.fake.finish(intent.batch_id!);
    laneTestHooks.afterLedgerSettle = () => { throw new Error('crash after ledger settle'); };
    await expect(s.lane.poll()).rejects.toThrow('crash after ledger settle');
    delete laneTestHooks.afterLedgerSettle;
    const again = setup({ dir: s.dir, runId: s.run.runId, fake: s.fake });
    const [outcome] = await again.lane.poll();
    expect(outcome.state).toBe('settled');
    expect(readLedger(s.ledgerPath).entries.filter(e => e.description.includes(intent.intent_id)).length).toBe(1);
    expect(verifyLedger(s.ledgerPath).ok).toBe(true);
  });

  test('crash after results are stored, before settlement, settles from stored rows on restart', async () => {
    const s = setup();
    const { manifest, bodies } = arm('claude-sonnet-5-5');
    const intent = await s.lane.submit(manifest, bodies);
    s.fake.finish(intent.batch_id!);
    laneTestHooks.afterResultsStored = () => { throw new Error('crash after results'); };
    await expect(s.lane.poll()).rejects.toThrow('crash after results');
    delete laneTestHooks.afterResultsStored;
    const again = setup({ dir: s.dir, runId: s.run.runId, fake: s.fake });
    const [outcome] = await again.lane.poll();
    expect(outcome.state).toBe('settled');
    expect(outcome.counts).toEqual({ succeeded: 3 });
    expect(openEntries(s.ledgerPath).length).toBe(0);
  });
});

describe('results', () => {
  test('out-of-order and identical duplicate results join by id; missing ids are recorded as missing', async () => {
    const { lane, fake } = setup();
    const { manifest, bodies } = arm('gpt-6.1-sol', 3);
    const intent = await lane.submit(manifest, bodies);
    fake.finish(intent.batch_id!, () => ({ kind: 'ok' }), { mutate: lines => [lines[2], lines[0], lines[0]] });
    const [outcome] = await lane.poll();
    expect(outcome.counts).toEqual({ succeeded: 2, missing: 1 });
    expect(lane.results(manifest.arm_id).get('q2')!.text).toBe(`answer for ${intent.items[2].custom_id}`);
    expect(outcome.failed_question_ids).toEqual(['q1']);
  });

  test('conflicting duplicate results and unknown custom ids refuse to settle', async () => {
    const { lane, fake, ledgerPath } = setup();
    const { manifest, bodies } = arm('gpt-6.1-sol', 2);
    const intent = await lane.submit(manifest, bodies);
    fake.finish(intent.batch_id!, () => ({ kind: 'ok' }), { mutate: lines => [...lines, { ...lines[0], response: { status_code: 200, body: { choices: [{ message: { content: 'other' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } } } }] });
    await expect(lane.poll()).rejects.toThrow(/two different results/);
    expect(openEntries(ledgerPath).length).toBe(1);
    const s2 = setup();
    const b = arm('claude-sonnet-5-5', 1);
    const i2 = await s2.lane.submit(b.manifest, b.bodies);
    s2.fake.finish(i2.batch_id!, () => ({ kind: 'ok' }), { mutate: lines => [...lines, { custom_id: 'stranger-q9', result: { type: 'succeeded', message: { content: [], usage: {} } } }] });
    await expect(s2.lane.poll()).rejects.toThrow(/never sent/);
  });

  test('B10: a max_tokens / length finish is a reader error, empty hypothesis, wrong under both judges', async () => {
    const { lane, fake } = setup();
    const a = arm('claude-sonnet-5-5', 2, 'anth');
    const ia = await lane.submit(a.manifest, a.bodies);
    fake.finish(ia.batch_id!, (_c, _b, i) => (i === 0 ? { kind: 'ok', finish: 'max_tokens', text: 'partial notes' } : { kind: 'ok' }));
    await lane.poll();
    const o = arm('gpt-6.1-sol', 2, 'oai');
    const io = await lane.submit(o.manifest, o.bodies);
    fake.finish(io.batch_id!, (_c, _b, i) => (i === 1 ? { kind: 'ok', finish: 'length', text: '' } : { kind: 'ok' }));
    await lane.poll();
    const types = new Map([['q0', 'multi-session'], ['q1', 'multi-session']]);
    const ra = readerRows(a.manifest, lane.results('anth'), types);
    const ro = readerRows(o.manifest, lane.results('oai'), types);
    expect(ra[0]).toMatchObject({ error: 'reader_max_tokens', hypothesis: '', finish: 'max_tokens' });
    expect(ro[1]).toMatchObject({ error: 'reader_max_tokens', hypothesis: '' });
    const scored = scoreRows(ra, new Map(), new Map());
    expect(scored[0]).toMatchObject({ correct_official: 0, correct_secondary: 0, reader_error: 'reader_max_tokens' });
  });
});

describe('gating, pilot and guard', () => {
  test('B11: a reasoning reader refuses a limit below its preregistered floor', () => {
    expect(() => readerBody('gpt-6.1-sol', { system: 's', user: 'u' }, 1024)).toThrow(/floor/);
    expect(() => readerBody('claude-sonnet-5-5', { system: 's', user: 'u' }, 1024)).toThrow(/floor/);
    const bodies = new Map([['q0', { model: 'gpt-5.4', messages: [], max_completion_tokens: 800 }]]);
    expect(() => buildManifest({ arm_id: 'x', workstream: 'w', kind: 'reader', provider: 'openai', model: 'gpt-5.4', max_output_tokens: 800, reasoning_effort: 'medium', protocol: { name: 'n', sha256: 's' }, source: 's', denominator: 1, bodies })).toThrow(/floor/);
  });

  test('B12: arm N+1 does not reserve while arm N is unsettled; in parallel mode the ledger bounds the sum', async () => {
    const { lane, ledgerPath } = setup();
    const a = arm('claude-sonnet-5-5', 2, 'arm-1');
    const b = arm('claude-sonnet-5-5', 2, 'arm-2');
    await lane.submit(a.manifest, a.bodies);
    await expect(lane.submit(b.manifest, b.bodies)).rejects.toThrow(/one at a time/);
    expect(openEntries(ledgerPath).length).toBe(1);
    const p = setup({ cap: 0.13, budget: 0.13, parallel: true });
    await p.lane.submit(a.manifest, a.bodies);
    await expect(p.lane.submit(b.manifest, b.bodies)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(p.fake.submissions.length).toBe(1);
  });

  test('B13: the pilot goes through the batch endpoint; full submission refuses unless the pilot confirmed the preregistered factor', async () => {
    const good = setup();
    const { manifest, bodies } = arm('claude-sonnet-5-5', 3);
    const pilot = await good.lane.submit(manifest, bodies, { questionIds: ['q0'], pilot: true });
    expect(good.fake.submissions.map(s => new URL(s.url).pathname)).toEqual(['/v1/messages/batches']);
    good.fake.finish(pilot.batch_id!);
    const [o] = await good.lane.poll();
    expect(o.factor).toMatchObject({ confirmed: true, factor: 0.5 });
    await expect(good.lane.submit(manifest, bodies, { questionIds: ['q1', 'q2'], requireFactor: 0.5 })).resolves.toBeDefined();

    const bad = setup();
    bad.fake.serviceTier = 'standard';
    const p2 = await bad.lane.submit(manifest, bodies, { questionIds: ['q0'], pilot: true });
    bad.fake.finish(p2.batch_id!);
    await bad.lane.poll();
    expect(bad.lane.factorFor('anthropic', 'claude-sonnet-5-5')).toMatchObject({ factor: 1, confirmed: false });
    await expect(bad.lane.submit(manifest, bodies, { questionIds: ['q1', 'q2'], requireFactor: 0.5 })).rejects.toThrow(/preregistered batch factor/);

    const oai = setup();
    const g = arm('gpt-6.1-sol', 2);
    const p3 = await oai.lane.submit(g.manifest, g.bodies, { questionIds: ['q0'], pilot: true });
    oai.fake.finish(p3.batch_id!);
    await oai.lane.poll();
    expect(oai.lane.factorFor('openai', 'gpt-6.1-sol')).toMatchObject({ factor: 0.5, confirmed: true });
  });

  test('B8: with the paid-request guard on, batch control calls pass, unlaned submissions and model-less paid calls refuse', async () => {
    const dir = tmp();
    const ledgerPath = join(dir, 'ledger.sqlite');
    initLedger({ ledgerPath, programCapUsd: 10, reason: 'test' });
    const run = BudgetRun.open({ runner: 'w10-guard', budgetUsd: 5, ledgerPath });
    const fake = new FakeProvider();
    const guard = installPaidRequestGuard(run, { fetchImpl: fake.fetch as typeof fetch });
    try {
      const lane = new BatchLane({ statePath: join(dir, 'state.sqlite'), transports: { openai: openAiTransport({ apiKey: 't' }), anthropic: anthropicTransport({ apiKey: 't' }) }, run, now: () => fake.clock, log: () => {} });
      lanes.push(lane);
      const o = arm('gpt-6.1-sol', 2);
      const io = await lane.submit(o.manifest, o.bodies);
      fake.finish(io.batch_id!);
      expect((await lane.poll())[0].state).toBe('settled');
      const a = arm('claude-sonnet-5-5', 2);
      const ia = await lane.submit(a.manifest, a.bodies);
      fake.finish(ia.batch_id!);
      expect((await lane.poll())[0].state).toBe('settled');
      await expect(fetch('https://api.openai.com/v1/batches', { method: 'POST', body: JSON.stringify({ input_file_id: 'f' }) })).rejects.toThrow(/batch lane/);
      await expect(fetch('https://api.anthropic.com/v1/messages/batches', { method: 'POST', body: JSON.stringify({ requests: [{ custom_id: 'x', params: { model: 'claude-sonnet-5-5' } }] }) })).rejects.toThrow(/batch lane/);
      await expect(fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [] }) })).rejects.toThrow(/names no model/);
      expect((await fetch('https://api.openai.com/v1/batches?limit=1')).status).toBe(200);
      expect(() => runInBatchLane('', async () => 1)).toThrow(/reserve/);
      expect(fake.submissions.length).toBe(2);
    } finally {
      guard.uninstall();
    }
    expect(batchRequestKind('https://api.anthropic.com/v1/messages/count_tokens', 'POST')).toBe('free');
    expect(batchRequestKind('https://api.openai.com/v1/files/file-1/content', 'GET')).toBe('free');
    expect(batchRequestKind('https://api.openai.com/v1/files', 'POST')).toBe('submission');
    expect(batchRequestKind('https://api.openai.com/v1/chat/completions', 'POST')).toBeNull();
  });

  test('L1: two budget runs on one ledger reserving batch-sized amounts never exceed the program cap', () => {
    const dir = tmp();
    const ledgerPath = join(dir, 'ledger.sqlite');
    initLedger({ ledgerPath, programCapUsd: 30, reason: 'test' });
    const a = BudgetRun.open({ runner: 'lane-a', budgetUsd: 20, ledgerPath });
    const b = BudgetRun.open({ runner: 'lane-b', budgetUsd: 10, ledgerPath });
    a.reserve(18, 'batch a');
    expect(() => b.reserve(12.5, 'batch b')).toThrow(BudgetExceededError);
    b.reserve(9, 'batch b');
    expect(() => a.reserve(3.5, 'batch a2')).toThrow(BudgetExceededError);
  });
});

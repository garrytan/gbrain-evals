/**
 * eval/runner/q1/stress-pilot.ts, keyless: the paid guard (refusals in the operator-message shape before any data
 * or system is touched), the dev-only split guard, the engine rule, and the whole pilot flow (ingest into one
 * namespace, quiesce, footprint, restart, retrieval-only queries, receipt, resume) against a stand-in gbrain-defaults
 * shim built on the in-repo fake system and the decide fixture corpus. The paid pilot itself is never run here.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BudgetRun, closeLedgers, initLedger } from '../../eval/runner/budget-ledger.ts';
import { DecideError } from '../../eval/runner/decisions/errors.ts';
import { loadFixture } from '../../eval/runner/memory-qa/corpus.ts';
import { assertDevOnly, engineRule, guardPaid, parsePilotArgs, PILOT_ESTIMATE_USD, pilotPlan, runStressPilot, SALT, type QueryRecord } from '../../eval/runner/q1/stress-pilot.ts';
import { FakeMemorySystem, serveProtocol } from '../../eval/runner/systems/fake.ts';
import { Sanitizer } from '../../eval/runner/systems/sanitize.ts';

const ROOT = resolve(import.meta.dir, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'q1-stress-'));
afterAll(() => { closeLedgers(); rmSync(tmp, { recursive: true, force: true }); });

const cli = (args: string[], env: Record<string, string> = {}) => Bun.spawnSync([process.execPath, 'eval/runner/q1/stress-pilot.ts', ...args], { cwd: ROOT, env: { ...process.env, ...env } });

/** A stand-in gbrain-defaults shim: the TypeScript fake system, renamed, plus the /stats and /restart routes the pilot reads. */
function standIn() {
  const fake = serveProtocol(new FakeMemorySystem());
  const hits: string[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', idleTimeout: 0, fetch: async req => {
    const path = new URL(req.url).pathname;
    hits.push(path);
    if (path === '/stats') return Response.json({ serve_rss_kb: 200_000, serve_peak_rss_kb: 250_000, brain_bytes: 1_000_000, service_ms: 0.1 });
    if (path === '/restart') return Response.json({ restart_ms: 812.5, serve_session: { id: 'x' }, service_ms: 812.6 });
    const res = await fetch(`${fake.url}${path}`, { method: req.method, headers: { 'content-type': 'application/json' }, body: req.method === 'POST' ? await req.text() : undefined, keepalive: false });
    const json = await res.json() as Record<string, unknown>;
    if (path === '/capabilities') json.system = 'gbrain-defaults';
    return Response.json(json, { status: res.status });
  } });
  return { url: `http://127.0.0.1:${server.port}`, hits, stop: () => { server.stop(true); fake.stop(); } };
}

describe('the paid guard refuses before any data or system is touched', () => {
  test('no --paid: PAID_FLAGS_MISSING in the operator-message shape, exit 3, the system never contacted', () => {
    const s = standIn();
    try {
      const r = cli(['--system', s.url, '--output', join(tmp, 'refused'), '--json']);
      expect(r.exitCode).toBe(3);
      const op = JSON.parse(r.stderr.toString().trim());
      expect(op.code).toBe('PAID_FLAGS_MISSING');
      expect(typeof op.message).toBe('string');
      expect(typeof op.why).toBe('string');
      expect(op.fix.next).toBe('tell_user_to_run');
      expect(op.fix.argv).toEqual(expect.arrayContaining(['bun', 'eval/runner/budget-ledger.ts', 'open', '--runner', 'q1-stress-pilot', '--budget-usd', String(PILOT_ESTIMATE_USD)]));
      expect(op.fix.verify.slice(0, 3)).toEqual(['bun', 'eval/runner/budget-ledger.ts', 'status']);
      expect(s.hits).toEqual([]);
      expect(existsSync(join(tmp, 'refused'))).toBe(false);
      expect(cli(['--system', s.url, '--output', join(tmp, 'refused')]).stderr.toString()).toContain('[PAID_FLAGS_MISSING]');
    } finally { s.stop(); }
  });

  test('a run id the ledger does not hold, or one without the estimate left, is refused; an open run with money passes', () => {
    const ledger = join(tmp, 'ledger.sqlite');
    initLedger({ ledgerPath: ledger, programCapUsd: 200 });
    const r = cli(['--paid', '--budget-run-id', 'no-such-run', '--budget-ledger', ledger, '--json']);
    expect(r.exitCode).toBe(3);
    expect(JSON.parse(r.stderr.toString().trim()).code).toBe('PAID_FLAGS_MISSING');
    const small = BudgetRun.open({ runner: 'q1-stress-pilot', budgetUsd: 10, ledgerPath: ledger });
    expect(() => guardPaid(['--paid', '--budget-run-id', small.runId, '--budget-ledger', ledger])).toThrow(DecideError);
    const run = BudgetRun.open({ runner: 'q1-stress-pilot', budgetUsd: 60, ledgerPath: ledger });
    expect(guardPaid(['--paid', '--budget-run-id', run.runId, '--budget-ledger', ledger]).budgetRunId).toBe(run.runId);
    expect(() => guardPaid(['--budget-run-id', run.runId, '--budget-ledger', ledger])).toThrow(/--paid/);
  });

  test('--plan without the dev files refuses with DATASET_MISSING and the fetch command', () => {
    const r = cli(['--plan', '--json'], { GBRAIN_EVALS_DATASETS: join(tmp, 'no-datasets') });
    expect(r.exitCode).toBe(2);
    const op = JSON.parse(r.stderr.toString().trim());
    expect(op.code).toBe('DATASET_MISSING');
    expect(op.fix).toMatchObject({ next: 'run', argv: ['bun', 'run', 'eval:decide', 'fetch', '--benchmark', 'beam-1m'] });
  });
});

describe('split guard and engine rule', () => {
  test('only BEAM-1M dev conversations may enter the pilot', () => {
    expect(() => assertDevOnly(['1m-16', '1m-2'])).not.toThrow();
    for (const bad of [['1m-1'], ['1m-16', '1m-35'], ['not-a-conversation']]) {
      let err: unknown;
      try { assertDevOnly(bad); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(DecideError);
      expect((err as DecideError).op.code).toBe('SEALED_SOURCE_IN_DEV');
    }
  });

  const q = (service_ms: number, reasons: string[] = [], delivery_fallbacks: string[] = []): QueryRecord => ({ id: 'q', ok: true, wall_ms: service_ms, service_ms, gbrain_ms: service_ms, items: 1,
    recall_any_10: 1, recall_all_10: 1, tokens_delivered: 100, outcome: reasons.length ? 'harness_invalid' : 'scored', reasons, recorded: [], delivery_fallbacks, dropped_reasons: {} });
  test('PGLite stays the headline only with p95 under 10 s, no fallbacks, no failures and RSS inside the VM', () => {
    const fast = Array.from({ length: 20 }, (_, i) => q(500 + i));
    expect(engineRule(fast, 4_000_000, 16)).toMatchObject({ engine: 'pglite', query_p95_ms: 518 });
    expect(engineRule([...fast.slice(0, 18), q(12_000), q(13_000)], 4_000_000, 16).engine).toBe('postgres');
    expect(engineRule([...fast, q(700, ['degraded:rerank_failed'])], 4_000_000, 16)).toMatchObject({ engine: 'postgres', rerank_fallback_queries: 1 });
    expect(engineRule([...fast, q(700, [], ['fetch_timeout'])], 4_000_000, 16)).toMatchObject({ engine: 'postgres', delivery_fallback_queries: 1 });
    expect(engineRule(fast, 20 * 1024 * 1024, 16).checks.rss_fits_vm).toBe(false);
    expect(engineRule([...fast, { ...q(1), ok: false, service_ms: null }], 4_000_000, 16).engine).toBe('postgres');
    expect(engineRule(fast, null, 16).engine).toBe('postgres');
  });
});

describe('the pilot flow (stand-in shim, fixture corpus)', () => {
  test('every session lands in one namespace in event-time order, then quiesce, footprint, restart, queries and a receipt; a rerun resumes', async () => {
    const corpus = loadFixture();
    const plan = pilotPlan(corpus, new Sanitizer(corpus, SALT));
    const times = plan.map(s => s.event_time ?? '');
    expect(times).toEqual([...times].sort());
    expect(new Set(plan.map(s => s.input.source_id)).size).toBe(plan.length);
    const s = standIn();
    const out = join(tmp, 'pilot');
    try {
      const args = { ...parsePilotArgs(['--stats-every', '2'], {}), system: s.url, output: out };
      const receipt = await runStressPilot(args, { corpus: () => corpus, log: () => {} }) as any;
      expect(receipt.corpus).toMatchObject({ split: 'dev', conversations: corpus.conversations.length, sessions: plan.length });
      expect(receipt.ingest).toMatchObject({ committed_total: plan.length, failed_total: 0, sessions_written_this_run: plan.length, sessions_resumed: 0 });
      expect(receipt.finish.ready).toBe(true);
      expect(receipt.restart.restart_ms).toBe(812.5);
      expect(receipt.footprint).toMatchObject({ peak_serve_rss_kb: 250_000, brain_bytes: 1_000_000 });
      expect(receipt.queries.n).toBe(corpus.questions.length);
      expect(receipt.queries.ok).toBe(corpus.questions.length);
      expect(receipt.queries.policy).toMatchObject({ on_degraded: 'report' });
      expect(receipt.queries.policy.token_budget).toBeUndefined();
      expect(receipt.engine_rule.engine).toBe('pglite');
      const resets = s.hits.filter(h => h === '/reset').length;
      expect(resets).toBe(1);
      expect(s.hits.filter(h => h === '/ingest').length).toBe(plan.length);
      for (const f of ['receipt.json', 'ingest.ndjson', 'footprint.ndjson', 'queries.ndjson']) expect(existsSync(join(out, f))).toBe(true);
      expect(readFileSync(join(out, 'queries.ndjson'), 'utf8').trim().split('\n')).toHaveLength(corpus.questions.length);

      const again = await runStressPilot(args, { corpus: () => corpus, log: () => {} }) as any;
      expect(again.ingest).toMatchObject({ sessions_written_this_run: 0, sessions_resumed: plan.length, committed_total: plan.length });
      expect(s.hits.filter(h => h === '/reset').length).toBe(1);
      expect(s.hits.filter(h => h === '/ingest').length).toBe(plan.length);
    } finally { s.stop(); }
  }, 120_000);

  test('a system other than gbrain-defaults is refused', async () => {
    const fake = serveProtocol(new FakeMemorySystem());
    try {
      const args = { ...parsePilotArgs([], {}), system: fake.url, output: join(tmp, 'wrong') };
      let err: unknown;
      try { await runStressPilot(args, { corpus: loadFixture, log: () => {} }); } catch (e) { err = e; }
      expect((err as DecideError).op.code).toBe('SPEC_INVALID');
    } finally { fake.stop(); }
  });
});

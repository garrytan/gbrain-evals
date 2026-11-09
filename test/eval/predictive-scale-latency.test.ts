/**
 * GBEV-55 G5, latency at brain scale: the keyless checks for
 * eval/runner/predictive/scale-latency/.
 *
 * - The page generator is pinned by digest, and its vectors are unit length at
 *   gbrain's default embedding width.
 * - A 1,000-page brain on in-process PGLite goes through the same builder (cut
 *   short after one batch, then resumed from its checkpoint) and the same probe,
 *   inside the hermetic environment with in-process transports, so no provider
 *   is reachable.
 * - The Ubicloud lifecycle (gate change J1) runs against a fake client that
 *   fails: the paid-arm guard refuses first, the VM name is recorded before the
 *   create, teardown runs, retries stop at 2 and the report names the VM.
 * - Opt-in: with SCALE_LATENCY_DATABASE_URL naming a scratch Postgres database
 *   with pgvector, a 300-page build and probe run there. Skipped otherwise.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetRun, closeLedgers, initLedger } from '../../eval/runner/budget-ledger.ts';
import { importGbrain, resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { withHermeticEnv } from '../../eval/runner/hermetic-env.ts';
import { PaidArmRefusal } from '../../eval/runner/paid-arm.ts';
import { buildScaleBrain, openScaleEngine, pagesDigest, randomUnitVector, readCheckpoint, scalePage, useScaleTransports } from '../../eval/runner/predictive/scale-latency/build.ts';
import { OPS, SCORECARD_SCHEMA, calibrate, countFallOpens, opStats, probeArgs, probeLatency, type Op, type OpStats } from '../../eval/runner/predictive/scale-latency/probe.ts';
import { MAX_RETRIES, defaultSteps, loadState, runOnUbicloud, ubiRunnerClient, vmName, type UbicloudClient } from '../../eval/runner/predictive/scale-latency/ubicloud.ts';

const gut = resolveGbrainUnderTest(null);
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'scale-latency-test-')); dirs.push(d); return d; };
afterAll(() => { closeLedgers(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('page generator', () => {
  test('is pinned by digest and fictional', () => {
    expect(pagesDigest(55, 200)).toBe('a9831fccde32e929e318d1476ae1859af7d926251a5dcee4603a34fca8a14f0d');
    const p = scalePage(55, 4);
    expect(scalePage(55, 4)).toEqual(p);
    expect(p.slug.endsWith('-4')).toBe(true);
    expect(p.markdown.startsWith('---\ntype: ' + p.type + '\ntitle: ' + p.title)).toBe(true);
  });

  test('vectors are seeded unit vectors at the width asked for', () => {
    const v = randomUnitVector('a chunk', 1024);
    expect(v).toHaveLength(1024);
    expect(Math.abs(Math.sqrt(v.reduce((s, x) => s + x * x, 0)) - 1)).toBeLessThan(1e-9);
    expect(randomUnitVector('a chunk', 1024)).toEqual(v);
    expect(randomUnitVector('another chunk', 1024)).not.toEqual(v);
  });
});

describe('probe helpers', () => {
  test('a fall-open is keyword_arm_failed with a timeout reason, nothing else', () => {
    expect(countFallOpens({ degraded: [{ stage: 'keyword_arm_failed', reason: 'timeout' }, { stage: 'keyword_arm_failed', reason: 'skipped_after_timeout' }] })).toBe(2);
    expect(countFallOpens({ degraded: [{ stage: 'keyword_arm_failed', reason: 'provider_error' }, { stage: 'keyword_count_unavailable' }, { stage: 'rerank_failed', reason: 'timeout' }] })).toBe(0);
    expect(countFallOpens(null)).toBe(0);
  });

  test('calibration is a factor-of-2 check on p50 and p95, and only calibration', () => {
    const ops = Object.fromEntries(OPS.map(op => [op, opStats([], 0)])) as Record<Op, OpStats>;
    ops.query = { n: 3, p50_ms: 5_050, p95_ms: 60_200, errors: 0 };
    ops.get = { n: 3, p50_ms: 1_000, p95_ms: 10_900, errors: 0 };
    const c = calibrate(ops);
    expect(c.role).toBe('calibration_only');
    expect(c.ops.query).toMatchObject({ p50_ratio: 0.5, p95_ratio: 2, within_factor: true });
    expect(c.ops.get?.within_factor).toBe(false);
    expect(c.ops.entity).toBeNull();
    expect(c.ops.recall).toBeNull();
    expect(c.ops.search?.within_factor).toBeNull();
    expect(c.within_factor_all).toBeNull();
  });

  test('probe arguments are seeded and name loaded pages', () => {
    expect(probeArgs('get', 3, 55, 100)).toEqual(probeArgs('get', 3, 55, 100));
    const slug = String(probeArgs('get', 3, 55, 100).slug);
    expect(Number(slug.split('-').pop())).toBeLessThan(100);
  });
});

describe('build and probe on in-process PGLite (keyless)', () => {
  test('1,000 pages: build, cut short, resume, then probe every op', async () => {
    await withHermeticEnv('scale-latency-test', async h => {
      expect(h.stripped.every(k => process.env[k] === undefined)).toBe(true);
      const transports = await useScaleTransports(gut);
      const { DEFAULT_EMBEDDING_DIMENSIONS } = await importGbrain<any>(gut, 'src/core/ai/defaults.ts');
      expect(transports.embedding_dim).toBe(DEFAULT_EMBEDDING_DIMENSIONS);
      const engine = await openScaleEngine(gut, { kind: 'pglite' });
      try {
        const checkpointPath = join(tmp(), 'checkpoint.json');
        const opts = { gut, engine, pages: 1_000, batchSize: 250, embeddingDim: transports.embedding_dim, checkpointPath };
        const first = await buildScaleBrain({ ...opts, maxBatches: 1 });
        expect(first).toMatchObject({ pages_loaded: 250, batches_run: 1, resumed_from_batch: 0, complete: false });
        expect(readCheckpoint(checkpointPath)?.last_batch).toBe(0);
        await expect(buildScaleBrain({ ...opts, seed: 56 })).rejects.toThrow('is for seed 55');
        const rest = await buildScaleBrain(opts);
        expect(rest).toMatchObject({ pages_loaded: 1_000, batches_run: 3, resumed_from_batch: 1, complete: true });

        const card = await probeLatency({ gut, engine, engineKind: 'pglite', transports, pagesLoaded: 1_000, n: 8, syncN: 4, warmup: 1 });
        expect(card.schema).toBe(SCORECARD_SCHEMA);
        expect(card.pages).toBeGreaterThanOrEqual(1_000);
        expect(card.chunks).toBeGreaterThanOrEqual(card.pages);
        expect(card.embedding_dim).toBe(DEFAULT_EMBEDDING_DIMENSIONS);
        expect(card.gbrain_version).toBe(gut.version);
        expect(card.engine).toBe('pglite');
        expect(card.search_config.keyword_statement_timeout_ms).toBeNull();
        for (const op of OPS) {
          expect(card.ops[op].errors).toBe(0);
          expect(card.ops[op].n).toBe(op === 'sync' ? 4 : 8);
          expect(card.ops[op].p95_ms!).toBeGreaterThanOrEqual(card.ops[op].p50_ms!);
        }
        expect(card.statement_timeout_fall_opens).toBe(0);
        expect(card.ai_refused).toEqual({});
        expect(card.calibration.role).toBe('calibration_only');
      } finally {
        transports.reset();
        await engine.disconnect();
      }
    });
  }, 300_000);
});

describe('Ubicloud lifecycle (J1) with a fake client', () => {
  function paidLedger() {
    const ledgerPath = join(tmp(), 'ledger.sqlite');
    initLedger({ ledgerPath, programCapUsd: 10 });
    const run = BudgetRun.open({ runner: 'scale-latency-test', budgetUsd: 1, ledgerPath });
    return { ledgerPath, argv: ['--paid', '--budget-run-id', run.runId, '--budget-ledger', ledgerPath] };
  }

  function fakeClient(o: { statePath: string; failUp?: boolean; failSteps?: number; failDown?: boolean; answersSsh?: boolean }) {
    const calls: string[] = [];
    let stepFailures = o.failSteps ?? 0;
    const client: UbicloudClient = {
      up: async name => {
        const recorded = loadState(o.statePath).vms.find(v => v.name === name);
        calls.push('up ' + name + ' recorded=' + recorded?.status);
        if (o.failUp) throw new Error('create failed: HTTP 500');
      },
      sync: async name => { calls.push('sync ' + name); },
      ssh: async (name, command) => {
        calls.push('ssh ' + name + ' ' + command.split(' ')[0]);
        if (command === 'true') { if (!o.answersSsh) throw new Error('no route to host'); return; }
        if (stepFailures !== 0) { stepFailures--; throw new Error('build step exited 1'); }
      },
      pull: async name => { calls.push('pull ' + name); },
      down: async name => {
        calls.push('down ' + name);
        if (o.failDown) throw new Error('down timed out');
      },
    };
    return { client, calls };
  }

  const base = (statePath: string, client: UbicloudClient, argv: string[], ledgerPath?: string) => {
    let tick = 1_700_000_000_000;
    let n = 0;
    return {
      argv, client, statePath, ledgerPath, owner: 'GBEV-55',
      steps: defaultSteps({ pages: 300_000, n: 200, syncN: 30 }),
      pull: { remote: 'scale-latency/scorecard.json', localDir: tmp() },
      repoDir: tmp(),
      now: () => new Date(tick += 1000),
      hex: () => (n++).toString(16).padStart(8, '0'),
    };
  };

  test('vm names follow ubi-runner.sh', () => {
    expect(vmName('GBEV-55', 6, 1_700_000_000, '0a1b2c3d')).toBe('ubirun-gbev55-1700000000-0a1b2c3d-t6');
    expect(vmName('55x', 6, 1, '00000000')).toMatch(/^ubirun-u55x-/);
  });

  test('refused without --paid and --budget-run-id, before any client call', async () => {
    const statePath = join(tmp(), 'state.json');
    const { client, calls } = fakeClient({ statePath });
    await expect(runOnUbicloud(base(statePath, client, [], join(tmp(), 'missing.sqlite')))).rejects.toThrow(PaidArmRefusal);
    await expect(runOnUbicloud(base(statePath, client, ['--paid'], join(tmp(), 'missing.sqlite')))).rejects.toThrow('--budget-run-id');
    expect(calls).toEqual([]);
    expect(existsSync(statePath)).toBe(false);
  });

  test('a step that keeps failing: the VM is recorded first, reused, retried twice, torn down, reported partial', async () => {
    const { argv } = paidLedger();
    const statePath = join(tmp(), 'state.json');
    const { client, calls } = fakeClient({ statePath, failSteps: -1 });
    const report = await runOnUbicloud(base(statePath, client, argv));
    const name = 'ubirun-gbev55-1700000001-00000000-t6';
    expect(calls[0]).toBe('up ' + name + ' recorded=recorded');
    expect(calls.filter(c => c.startsWith('up '))).toHaveLength(1);
    expect(calls.filter(c => c.startsWith('sync '))).toHaveLength(MAX_RETRIES + 1);
    expect(calls.at(-1)).toBe('down ' + name);
    expect(report).toMatchObject({ status: 'partial', attempts: 3, retries: 2, vm_ids: [name], scorecard: null });
    expect(report.side_effects).toEqual([{ vm: name, created: true, torn_down: true }]);
    expect(report.error).toContain('build step exited 1');
    expect(loadState(statePath).vms.map(v => v.status)).toEqual(['down']);
  });

  test('a create that keeps failing: each name recorded before its create, every one torn down', async () => {
    const { argv } = paidLedger();
    const statePath = join(tmp(), 'state.json');
    const { client, calls } = fakeClient({ statePath, failUp: true });
    const report = await runOnUbicloud(base(statePath, client, argv));
    const ups = calls.filter(c => c.startsWith('up '));
    expect(ups).toHaveLength(3);
    expect(ups.every(c => c.endsWith('recorded=recorded'))).toBe(true);
    expect(calls.filter(c => c.startsWith('down '))).toHaveLength(3);
    expect(report.status).toBe('partial');
    expect(report.retries).toBe(2);
    expect(report.side_effects.every(s => s.created === 'unknown' && s.torn_down)).toBe(true);
    expect(report.vm_ids).toHaveLength(3);
  });

  test('a failed teardown is partial and names the VM', async () => {
    const { argv } = paidLedger();
    const statePath = join(tmp(), 'state.json');
    const { client } = fakeClient({ statePath, failDown: true });
    const report = await runOnUbicloud(base(statePath, client, argv));
    expect(report.status).toBe('partial');
    expect(report.side_effects[0]).toMatchObject({ torn_down: false, error: 'down timed out' });
    expect(report.error).toContain(report.vm_ids[0]);
    expect(loadState(statePath).vms[0].status).toBe('down_failed');
  });

  test('one failure then success: complete after one retry on the same VM', async () => {
    const { argv } = paidLedger();
    const statePath = join(tmp(), 'state.json');
    const { client, calls } = fakeClient({ statePath, failSteps: 1 });
    const report = await runOnUbicloud(base(statePath, client, argv));
    expect(report).toMatchObject({ status: 'complete', attempts: 2, retries: 1, error: null });
    expect(calls.filter(c => c.startsWith('up '))).toHaveLength(1);
    expect(report.scorecard).toEndWith('scorecard.json');
  });

  test('a rerun adopts a VM an earlier controller left created, so the load resumes there', async () => {
    const { argv } = paidLedger();
    const statePath = join(tmp(), 'state.json');
    const first = fakeClient({ statePath, failDown: true });
    await runOnUbicloud(base(statePath, first.client, argv));
    const s = loadState(statePath);
    s.vms[0].status = 'created';
    await Bun.write(statePath, JSON.stringify(s));
    const second = fakeClient({ statePath, answersSsh: true });
    const report = await runOnUbicloud(base(statePath, second.client, argv));
    expect(second.calls[0]).toBe('ssh ' + s.vms[0].name + ' true');
    expect(second.calls.some(c => c.startsWith('up '))).toBe(false);
    expect(report).toMatchObject({ status: 'complete', vm_ids: [s.vms[0].name] });
  });

  test('ubi-runner.sh gets only the variables it reads, never a provider key', async () => {
    const dir = tmp();
    const script = join(dir, 'fake-ubi-runner.sh');
    writeFileSync(script, '#!/usr/bin/env bash\ncompgen -e | sort > "$(dirname "$0")/names"\n');
    const dummies = { ANTHROPIC_API_KEY: 'dummy-anthropic', OPENAI_API_KEY: 'dummy-openai', UBICLOUD_API_KEY: 'dummy-ubicloud', UBI_SIZE: 'standard-2' };
    const saved = Object.fromEntries(Object.keys(dummies).map(name => [name, process.env[name]]));
    Object.assign(process.env, dummies);
    try { await ubiRunnerClient(script, { owner: 'gbev55', ttlHours: 1 }).up('ubirun-gbev55-test', { size: 'standard-2', location: 'eu-central-h1' }); }
    finally { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
    const names = readFileSync(join(dir, 'names'), 'utf8').split('\n').filter(Boolean).filter(name => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(name));
    expect(names).toEqual(expect.arrayContaining(['HOME', 'PATH', 'UBICLOUD_API_KEY', 'UBI_OWNER', 'UBI_SIZE', 'UBI_TTL_HOURS']));
    expect(names).not.toContain('ANTHROPIC_API_KEY');
    expect(names).not.toContain('OPENAI_API_KEY');
    const allowed = ['PATH', 'HOME', 'TMPDIR', 'XDG_STATE_HOME', 'UBICLOUD_API_KEY', 'UBICLOUD_API_TOKEN', 'UBICLOUD_API_URL', 'GSTACK_CAPY_RECOVERY_DIR'];
    expect(names.filter(name => !allowed.includes(name) && !name.startsWith('UBI_'))).toEqual([]);
  });
});

describe.skipIf(!process.env.SCALE_LATENCY_DATABASE_URL)('build and probe on a scratch Postgres (opt-in)', () => {
  test('300 pages', async () => {
    const url = process.env.SCALE_LATENCY_DATABASE_URL!;
    await withHermeticEnv('scale-latency-pg-test', async () => {
      const transports = await useScaleTransports(gut);
      const engine = await openScaleEngine(gut, { kind: 'postgres', url, poolMax: 4 });
      try {
        await buildScaleBrain({ gut, engine, pages: 300, batchSize: 100, concurrency: 2, embeddingDim: transports.embedding_dim, checkpointPath: join(tmp(), 'checkpoint.json') });
        const card = await probeLatency({ gut, engine, engineKind: 'postgres', transports, pagesLoaded: 300, n: 3, syncN: 2, warmup: 1 });
        expect(card.engine).toBe('postgres');
        expect(card.search_config.keyword_statement_timeout_ms).toBeGreaterThan(0);
        for (const op of OPS) expect(card.ops[op].errors).toBe(0);
      } finally {
        transports.reset();
        await engine.disconnect();
      }
    });
  }, 300_000);
});

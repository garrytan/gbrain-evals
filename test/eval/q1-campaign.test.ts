/**
 * The Q1 scoreboard campaign in eval/runner/shootout-cell.ts: its own
 * manifest kind and identity, the freeze over the executed git tree and image
 * digests (reserve, launch, resume and render refuse on a mismatch), the
 * repository-owned VM executor, timeouts that reach the VM, row checkpoints
 * every 20 attempts, ingest realizations with store snapshots, resume, block
 * and campaign caps as partial results, and a launcher that exits non-zero
 * when its cell fails. The shootout's own campaign hash is pinned unchanged.
 * Keyless: no VM starts; runners are fakes that write what a pulled VM would.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BudgetRun, closeLedgers } from '../../eval/runner/budget-ledger.ts';
import { Campaign, executedTree, loadCampaign, ownerTag, planWaves, REPO_RUNNER, resolveRunner, runRemote, treeDiff, type CampaignManifest, type LaunchContext, type RemotePayload } from '../../eval/runner/shootout-cell.ts';
import { exitCodeOf, ScoreboardError } from '../../eval/runner/q1/scoreboard-errors.ts';

const ROOT = resolve(import.meta.dir, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'q1-campaign-'));
/** Executed files must be inside the repository (the freeze hashes the git tree); untracked, unignored files count. */
const inRepo = join(ROOT, 'test/eval/fixtures/scoreboard', `tmp-${process.pid}-${Date.now()}`);
mkdirSync(inRepo, { recursive: true });
afterAll(() => { closeLedgers(); rmSync(tmp, { recursive: true, force: true }); rmSync(inRepo, { recursive: true, force: true }); });
const rel = (p: string) => p.slice(ROOT.length + 1);
let n = 0;
const rejected = async (p: Promise<unknown>): Promise<ScoreboardError> => { try { await p; } catch (e) { if (e instanceof ScoreboardError) return e; throw e; } throw new Error('expected a ScoreboardError'); };
const OLD_OWNER = process.env.UBI_OWNER;
beforeEach(() => { closeLedgers(); process.env.UBI_OWNER = 'gbra49test'; });
afterAll(() => { if (OLD_OWNER === undefined) delete process.env.UBI_OWNER; else process.env.UBI_OWNER = OLD_OWNER; });

function q1(over: Partial<CampaignManifest> = {}, cells?: CampaignManifest['cells']) {
  const dir = join(tmp, `q${++n}`);
  mkdirSync(dir, { recursive: true });
  const exec = join(inRepo, `adapter-${n}.ts`);
  writeFileSync(exec, `export const adapter = ${n};\n`);
  const manifest: CampaignManifest = { kind: 'q1-scoreboard-campaign', schema_version: 1, campaign_id: 'q1-scoreboard', cap_usd: 20, ledger: join(dir, 'campaign.sqlite'),
    executes: [rel(exec), 'bun.lock'], images: { 'gbrain-defaults': `sha256:${'a'.repeat(64)}` },
    blocks: { T1: { estimate_usd: 6, cap_usd: 9 }, T2: { estimate_usd: 10, cap_usd: 15 } },
    provider_limits: { openai: { rpm: 1000, tpm: 2_000_000, concurrency: 16 } },
    cells: cells ?? [
      { id: 'kb-locomo', system: 'ext-markdown-kb', benchmark: 'locomo', config: 'recipe', lease_usd: 4, command: 'true', block: 'T1', timeout_hours: 2, vm: { size: 'standard-4' }, providers: ['openai'] },
      { id: 'fx-locomo', system: 'ext-extract-first', benchmark: 'locomo', config: 'common', lease_usd: 4, command: 'true', block: 'T1', vm: { size: 'standard-4' }, providers: ['openai'] },
      { id: 'hy-locomo', system: 'baseline-hybrid', benchmark: 'locomo', config: 'common', lease_usd: 4, command: 'true', block: 'T2', restore_command: 'true' },
    ], ...over };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { dir, manifestPath: join(dir, 'manifest.json'), state: join(dir, 'state'), exec };
}

const caught = (fn: () => unknown): ScoreboardError => { try { fn(); } catch (e) { if (e instanceof ScoreboardError) return e; throw e; } throw new Error('expected a ScoreboardError'); };
const payloadOf = (argv: string[]) => JSON.parse(Buffer.from(argv.at(-1)!.split('--cell-b64 ').at(-1)!, 'base64').toString('utf8')) as RemotePayload;

/** What a pulled VM leaves behind: its lease ledger with some spend, a lease summary, and optionally a realization. */
function vm(usd: number, opts: { exit?: number; realization?: boolean; timedOut?: boolean; seen?: (argv: string[], ctx: LaunchContext) => void } = {}) {
  return async (argv: string[], ctx: LaunchContext) => {
    opts.seen?.(argv, ctx);
    mkdirSync(ctx.resultsDir, { recursive: true });
    const lease = BudgetRun.openLease({ runId: ctx.lease.lease_id, leaseUsd: ctx.lease.usd, ledgerPath: join(ctx.resultsDir, 'lease.sqlite') });
    if (usd > 0) lease.settle(lease.reserve(usd, 'vm spend'), { usd });
    closeLedgers();
    writeFileSync(join(ctx.resultsDir, 'lease-summary.json'), JSON.stringify({ run_id: ctx.lease.lease_id, lease_usd: ctx.lease.usd, committed_usd: usd, requests: 1, cell_exit_code: opts.exit ?? 0, ...(opts.timedOut ? { timed_out: true } : {}) }));
    if (opts.realization) {
      mkdirSync(join(ctx.resultsDir, 'realization', 'snapshot'), { recursive: true });
      writeFileSync(join(ctx.resultsDir, 'realization', 'snapshot', 'store.tar'), 'store bytes');
      const sha = new Bun.CryptoHasher('sha256').update('store bytes').digest('hex');
      writeFileSync(join(ctx.resultsDir, 'realization', 'realization.json'), JSON.stringify({ realization_id: `real-${ctx.cell.id}-0123456789abcdef`, cell: ctx.cell.id, lease_id: ctx.lease.lease_id, campaign_sha256: null, created_at: '', trigger: 'first-row',
        files: [{ path: 'store.tar', sha256: sha, bytes: 11 }], status: 'complete' }));
      mkdirSync(join(ctx.resultsDir, 'checkpoint'), { recursive: true });
      writeFileSync(join(ctx.resultsDir, 'checkpoint', 'attempts.ndjson'), '{"id":"q1"}\n');
    }
    return 0;
  };
}

describe('the shootout campaign is untouched', () => {
  test('REGRESSION: the shootout campaign hash is byte-identical to the pre-Q1 code (golden computed from the ported shootout-cell.ts)', () => {
    const loaded = loadCampaign(join(ROOT, 'test/eval/fixtures/scoreboard/shootout/campaign.json'));
    expect(loaded.sha256).toBe('5d06d4bb9bb3f43bc48caf4efdde408abaa9f0f8310d69d1bd4f86036497c509');
    expect(loaded.tree).toBeUndefined();
    expect(loaded.manifest.cells.map(c => c.id)).toEqual(['fake-locomo-common', 'fake-lme-s-100', 'fake-agent']);
  });

  test('a shootout payload carries no Q1 fields, except a cell timeout that now reaches the VM', () => {
    const dir = join(tmp, 'shootout-payload');
    mkdirSync(dir, { recursive: true });
    const m: CampaignManifest = { kind: 'oss-shootout-campaign', schema_version: 1, campaign_id: 'oss-x', cap_usd: 10, ledger: join(dir, 'l.sqlite'),
      cells: [{ id: 'a', system: 'fake', benchmark: 'locomo', config: 'common', lease_usd: 1, command: 'true', timeout_hours: 3 }] };
    writeFileSync(join(dir, 'm.json'), JSON.stringify(m));
    const c = new Campaign(join(dir, 'm.json'), join(dir, 'state'));
    c.init();
    const l = c.reserve('a');
    const p = payloadOf(c.launchArgv(l));
    expect(Object.keys(p).sort()).toEqual(['command', 'lease_id', 'lease_usd', 'max_output_tokens', 'out', 'timeout_hours']);
    expect(c.launchArgv(l)).not.toContain('-n');
  });
});

describe('Q1 campaign identity and freeze', () => {
  test('the hash covers the executed git tree and image digests; tags must be digests; the identity must be q1-scoreboard', () => {
    const a = q1();
    const loaded = loadCampaign(a.manifestPath);
    expect(loaded.tree!.map(e => e.path)).toEqual(['bun.lock', rel(a.exec)].sort());
    const blob = Bun.spawnSync(['git', 'hash-object', a.exec]).stdout.toString().trim();
    expect(loaded.tree!.find(e => e.path === rel(a.exec))!.blob).toBe(blob);
    const bad = q1({ images: { 'gbrain-defaults': 'gbrain-defaults:latest' }, campaign_id: 'q1-other' });
    expect(() => loadCampaign(bad.manifestPath)).toThrow(/campaign_id is q1-scoreboard.*pinned by digest/);
    const none = q1({ executes: [] });
    expect(() => loadCampaign(none.manifestPath)).toThrow(/executes must list/);
    expect(() => loadCampaign(q1({ executes: ['no/such/path'] }).manifestPath)).toThrow(/no\/such\/path has no files/);
    expect(treeDiff([{ path: 'a', blob: '1' }, { path: 'b', blob: '2' }], [{ path: 'a', blob: '1' }, { path: 'b', blob: '3' }, { path: 'c', blob: '4' }])).toEqual(['b', 'c']);
    expect(executedTree(['bun.lock']).entries).toHaveLength(1);
  });

  test('reserve, launch, resume and render refuse once an executed file changes, naming it; reverting restores the freeze', async () => {
    const a = q1();
    const c = new Campaign(a.manifestPath, a.state);
    c.init();
    expect(JSON.parse(readFileSync(join(a.state, 'frozen-tree.json'), 'utf8')).tree.length).toBe(2);
    c.reserve('kb-locomo');
    writeFileSync(a.exec, 'export const adapter = "changed after freeze";\n');
    const after = new Campaign(a.manifestPath, a.state);
    const e = caught(() => after.reserve('fx-locomo'));
    expect(e.op.code).toBe('CAMPAIGN_HASH_MISMATCH');
    expect(e.op.message).toContain(rel(a.exec));
    expect((e.op.state as { changed: string[] }).changed).toEqual([rel(a.exec)]);
    expect(e.op.fix.next).toBe('ask_user');
    expect(exitCodeOf(e.op)).toBe(3);
    await expect(after.launch('kb-locomo', vm(1))).rejects.toBeInstanceOf(ScoreboardError);
    await expect(after.resume('kb-locomo', vm(1))).rejects.toBeInstanceOf(ScoreboardError);
    expect(caught(() => after.verifyFrozen('render')).op.message).toMatch(/^render refused/);
    writeFileSync(a.exec, `export const adapter = ${a.exec.match(/adapter-(\d+)/)![1]};\n`);
    const reverted = new Campaign(a.manifestPath, a.state);
    expect(() => reverted.verifyFrozen('render')).not.toThrow();
    expect((await reverted.launch('kb-locomo', vm(1))).status).toBe('settled');
  });

  test('a changed image digest is named too', () => {
    const a = q1();
    new Campaign(a.manifestPath, a.state).init();
    const m = JSON.parse(readFileSync(a.manifestPath, 'utf8'));
    m.images['gbrain-defaults'] = `sha256:${'b'.repeat(64)}`;
    writeFileSync(a.manifestPath, JSON.stringify(m));
    expect(caught(() => new Campaign(a.manifestPath, a.state).reserve('kb-locomo')).op.message).toContain('image digest(s) changed: gbrain-defaults');
  });
});

describe('executor, VM payload and schedule', () => {
  test('the executor is the repository runner unless UBI_RUNNER names another file; a shared drive copy or a missing file is refused', () => {
    expect(resolveRunner({})).toBe(REPO_RUNNER);
    expect(existsSync(REPO_RUNNER)).toBe(true);
    expect(caught(() => resolveRunner({ UBI_RUNNER: '/nope/ubi-runner.sh' })).op.code).toBe('RUNNER_UNRESOLVED');
    const drive = join(tmp, '.capy/drive/user/skills/ubicloud/scripts');
    mkdirSync(drive, { recursive: true });
    writeFileSync(join(drive, 'ubi-runner.sh'), '');
    expect(caught(() => resolveRunner({ UBI_RUNNER: join(drive, 'ubi-runner.sh') })).op.message).toContain('shared drive copy');
  });

  test('a Q1 launch names its VM with the owner tag and sends the timeout, checkpoint interval, route caps and its admission share', () => {
    const a = q1();
    const c = new Campaign(a.manifestPath, a.state);
    c.init();
    const l = c.reserve('kb-locomo');
    const name = c.vmName(l);
    expect(name).toMatch(/^ubirun-gbra49test-\d+-[0-9a-f]{6}$/);
    const argv = c.launchArgv(l, { vm: name });
    expect(argv.slice(argv.indexOf('-n'), argv.indexOf('-n') + 2)).toEqual(['-n', name]);
    const p = payloadOf(argv);
    expect(p).toMatchObject({ cell: 'kb-locomo', timeout_hours: 2, row_pull_every: 20, campaign_sha256: c.sha256,
      route_caps: { caps: { extraction: 4096, reader: 2048, judge: 1024 }, slots: { harness: 'reader', judge: 'judge' }, defaultClass: 'extraction' } });
    expect(p.admission).toEqual({ openai: { rpm: 333, tpm: 666_666, concurrency: 5 } });
    delete process.env.UBI_OWNER;
    expect(caught(() => c.vmName(l)).op.code).toBe('OWNER_UNSET');
    expect(ownerTag('GBRA-49')).toBe('gbra49');
    expect(ownerTag('49x')).toBe('u49x');
  });

  test('waves pack cells under the daytime vCPU cap, explicit waves first', () => {
    const cells = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, system: 's', benchmark: 'locomo', config: 'common', lease_usd: 1, command: 'true', vm: { size: 'standard-16' }, expected_hours: i + 1 }));
    const waves = planWaves({ kind: 'q1-scoreboard-campaign', schema_version: 1, campaign_id: 'q1-scoreboard', cap_usd: 1, ledger: 'x', schedule: { vcpu_cap_day: 32 }, cells: [...cells, { ...cells[0], id: 'pinned', wave: 2 }] });
    expect(waves.map(w => [w.cells, w.vcpu, w.expected_hours])).toEqual([[['c0', 'c1'], 32, 2], [['pinned', 'c2'], 32, 3], [['c3', 'c4'], 32, 5]]);
  });
});

describe('on the VM', () => {
  test('timeout_hours reaches the cell: the command is stopped at its deadline and the summary says so', async () => {
    const out = join(tmp, 'timeout-out');
    const port = 24000 + Math.floor(Math.random() * 9000);
    const t0 = performance.now();
    const code = await runRemote({ lease_id: 'timeout-lease', lease_usd: 0.1, command: 'sleep 30', out, timeout_hours: 1 / 3600 }, { port });
    expect(code).toBe(124);
    expect(performance.now() - t0).toBeLessThan(15_000);
    expect(JSON.parse(readFileSync(join(out, 'lease-summary.json'), 'utf8'))).toMatchObject({ timed_out: true, timeout_hours: 1 / 3600, cell_exit_code: 124 });
  }, 30_000);

  test('rows are checkpointed every 20 attempts, and the store snapshot after ingest gets an immutable realization id', async () => {
    const out = join(tmp, 'checkpoint-out');
    const port = 24000 + Math.floor(Math.random() * 9000);
    const write = (k: number) => `for i in $(seq 1 ${k}); do echo '{"id":"q'$i'"}' >> "$SHOOTOUT_OUT/attempts.ndjson"; done`;
    const command = `${write(20)}; sleep 0.8; ${write(20)}; sleep 0.8; ${write(5)}`;
    const seen = new Set<number>();
    const run = runRemote({ lease_id: 'ckpt-lease', lease_usd: 0.1, command, out, cell: 'kb-locomo', campaign_sha256: 'f'.repeat(64), row_pull_every: 20,
      snapshot_command: 'printf "store bytes" > "$SHOOTOUT_SNAPSHOT_DIR/store.tar"; [ "$OPENAI_API_KEY" != placeholder-real ]' }, { port, pollMs: 50 });
    let done = false;
    run.finally(() => { done = true; });
    while (!done) {
      const p = join(out, 'checkpoint', 'checkpoint.json');
      if (existsSync(p)) try { seen.add(JSON.parse(readFileSync(p, 'utf8')).rows); } catch { /* mid-rename */ }
      await Bun.sleep(25);
    }
    expect(await run).toBe(0);
    expect([...seen].filter(x => x === 20 || x === 40).sort()).toEqual([20, 40]);
    expect(readFileSync(join(out, 'checkpoint', 'attempts.ndjson'), 'utf8').trim().split('\n')).toHaveLength(45);
    expect(existsSync(join(out, 'checkpoint', 'lease.sqlite'))).toBe(false);
    const r = JSON.parse(readFileSync(join(out, 'realization', 'realization.json'), 'utf8'));
    expect(r).toMatchObject({ status: 'complete', cell: 'kb-locomo', lease_id: 'ckpt-lease', trigger: 'first-row', files: [{ path: 'store.tar', bytes: 11 }] });
    expect(r.realization_id).toMatch(/^real-kb-locomo-[0-9a-f]{16}$/);
    expect(JSON.parse(readFileSync(join(out, 'lease-summary.json'), 'utf8'))).toMatchObject({ checkpoint_rows: 45, realization_id: r.realization_id, realization_status: 'complete' });
  }, 30_000);
});

describe('launch, realizations and resume on the launching host', () => {
  test('a pulled realization is recorded once its snapshot bytes verify; resume restores it and reruns only the query phase', async () => {
    const a = q1();
    const c = new Campaign(a.manifestPath, a.state);
    c.init();
    c.reserve('hy-locomo');
    const first = await c.launch('hy-locomo', vm(1.5, { realization: true }));
    expect(first).toMatchObject({ status: 'settled', actual_usd: 1.5, realization_id: 'real-hy-locomo-0123456789abcdef' });
    expect((c.status() as any).realizations).toEqual([{ lease_id: first.lease_id, realization_id: 'real-hy-locomo-0123456789abcdef', files: 1 }]);
    let staged: string | null = null;
    const r = await c.resume('hy-locomo', vm(0.5, { seen: argv => { const p = payloadOf(argv); staged = join(ROOT, p.restore!.dir); expect(p.restore).toMatchObject({ realization_id: 'real-hy-locomo-0123456789abcdef', restore_command: 'true' });
      expect(readFileSync(join(staged, 'realization', 'snapshot', 'store.tar'), 'utf8')).toBe('store bytes'); expect(existsSync(join(staged, 'checkpoint', 'attempts.ndjson'))).toBe(true); } }));
    expect(r.mode).toBe('snapshot');
    expect(r.lease).toMatchObject({ status: 'settled', attempt: 2, restored_from: 'real-hy-locomo-0123456789abcdef' });
    expect(existsSync(staged!)).toBe(false);
  });

  test('a tampered snapshot is not recorded; a cell without a restore command repeats the whole conversation', async () => {
    const a = q1();
    const c = new Campaign(a.manifestPath, a.state);
    c.init();
    c.reserve('kb-locomo');
    const tamper = vm(1, { realization: true });
    await c.launch('kb-locomo', async (argv, ctx) => { const code = await tamper(argv, ctx); writeFileSync(join(ctx.resultsDir, 'realization', 'snapshot', 'store.tar'), 'other bytes'); return code; });
    expect((c.status() as any).realizations).toEqual([]);
    const r = await c.resume('kb-locomo', vm(1, { seen: argv => expect(payloadOf(argv).restore).toBeUndefined() }));
    expect(r.mode).toBe('repeat');
    expect(r.note).toContain('whole conversation was repeated');
  });

  test('a lost VM: resume refuses until the lease is abandoned, and the abandon says it is charged its full reservation', async () => {
    const a = q1();
    const c = new Campaign(a.manifestPath, a.state);
    c.init();
    const l = c.reserve('kb-locomo');
    await expect(c.launch('kb-locomo', async () => { throw new Error('ssh dropped'); })).rejects.toThrow(/ssh dropped/);
    const e = await rejected(c.resume('kb-locomo', vm(1)));
    expect(e.op.code).toBe('RESUME_REFUSED');
    expect(e.op.fix.argv).toContain('abandon');
    const closed = c.abandon(l.lease_id, 'VM lost');
    expect(closed.note).toContain('charged its full reservation of $4.00');
    expect(c.status()).toMatchObject({ committed_usd: 4, unsettled_usd: 4 });
    expect((await c.resume('kb-locomo', vm(1))).mode).toBe('repeat');
  });
});

describe('caps are partial results', () => {
  test('a block cap stops the block (exit 4) while other blocks continue', async () => {
    const a = q1({ blocks: { T1: { estimate_usd: 4, cap_usd: 6 }, T2: { estimate_usd: 10, cap_usd: 15 } } });
    const c = new Campaign(a.manifestPath, a.state);
    c.init();
    c.reserve('kb-locomo');
    const e = caught(() => c.reserve('fx-locomo'));
    expect([e.op.code, e.op.partial, exitCodeOf(e.op)]).toEqual(['BUDGET_CAP', true, 4]);
    expect(e.op.message).toContain('block T1');
    expect(c.reserve('hy-locomo').status).toBe('reserved');
  });

  test('the campaign cap is a partial result that states the leases charged at their full reservation', () => {
    const a = q1({ cap_usd: 6, blocks: undefined });
    const c = new Campaign(a.manifestPath, a.state);
    c.init();
    c.reserve('kb-locomo');
    const e = caught(() => c.reserve('fx-locomo'));
    expect([e.op.code, exitCodeOf(e.op)]).toEqual(['BUDGET_CAP', 4]);
    expect(e.op.state).toMatchObject({ cap_usd: 6, committed_usd: 4, charged_reservations_usd: 4 });
    expect(e.op.fix.user_message).toContain('full reservation');
  });
});

describe('the launcher CLI', () => {
  test('a failed child cell makes `launch` exit non-zero with an operator message', async () => {
    const dir = join(tmp, 'cli-fail');
    mkdirSync(dir, { recursive: true });
    const runner = join(dir, 'fake-runner.sh');
    writeFileSync(runner, '#!/usr/bin/env bash\necho "fake runner: the cell failed" >&2\nexit 3\n');
    chmodSync(runner, 0o755);
    writeFileSync(join(dir, 'm.json'), JSON.stringify({ kind: 'oss-shootout-campaign', schema_version: 1, campaign_id: 'cli-fail', cap_usd: 5, ledger: join(dir, 'l.sqlite'),
      cells: [{ id: 'a', system: 'fake', benchmark: 'locomo', config: 'common', lease_usd: 1, command: 'false' }] }));
    const cli = (...args: string[]) => Bun.spawnSync([process.execPath, 'eval/runner/shootout-cell.ts', ...args, '--campaign', join(dir, 'm.json'), '--state', join(dir, 'state')], { cwd: ROOT, env: { ...process.env, UBI_RUNNER: runner } });
    expect(cli('init').exitCode).toBe(0);
    expect(cli('reserve', '--cell', 'a').exitCode).toBe(0);
    const launched = cli('launch', '--cell', 'a', '--json');
    expect(launched.exitCode).toBe(2);
    expect(JSON.parse(launched.stderr.toString().slice(launched.stderr.toString().indexOf('{')))).toMatchObject({ code: 'CELL_FAILED', state: { exit_code: 3, status: 'finished' } });
  }, 30_000);
});

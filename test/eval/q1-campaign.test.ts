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
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { BudgetRun, closeLedgers } from '../../eval/runner/budget-ledger.ts';
import { Campaign, executedTree, loadCampaign, ownerTag, planWaves, REPO_RUNNER, resolveRunner, runRemote, treeDiff, type CampaignManifest, type LaunchContext, type RemotePayload } from '../../eval/runner/shootout-cell.ts';
import { exitCodeOf, ScoreboardError } from '../../eval/runner/q1/scoreboard-errors.ts';
import { freePort } from '../../eval/runner/lifecycle/slice.ts';

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
function vm(usd: number, opts: { exit?: number; realization?: boolean; store?: Buffer; timedOut?: boolean; seen?: (argv: string[], ctx: LaunchContext) => void } = {}) {
  return async (argv: string[], ctx: LaunchContext) => {
    opts.seen?.(argv, ctx);
    mkdirSync(ctx.resultsDir, { recursive: true });
    const lease = BudgetRun.openLease({ runId: ctx.lease.lease_id, leaseUsd: ctx.lease.usd, ledgerPath: join(ctx.resultsDir, 'lease.sqlite') });
    if (usd > 0) lease.settle(lease.reserve(usd, 'vm spend'), { usd });
    closeLedgers();
    writeFileSync(join(ctx.resultsDir, 'lease-summary.json'), JSON.stringify({ run_id: ctx.lease.lease_id, lease_usd: ctx.lease.usd, committed_usd: usd, requests: 1, cell_exit_code: opts.exit ?? 0, ...(opts.timedOut ? { timed_out: true } : {}) }));
    if (opts.realization) {
      mkdirSync(join(ctx.resultsDir, 'realization', 'snapshot'), { recursive: true });
      const store = opts.store ?? Buffer.from('store bytes');
      writeFileSync(join(ctx.resultsDir, 'realization', 'snapshot', 'store.tar'), store);
      const sha = new Bun.CryptoHasher('sha256').update(store).digest('hex');
      writeFileSync(join(ctx.resultsDir, 'realization', 'realization.json'), JSON.stringify({ realization_id: `real-${ctx.cell.id}-0123456789abcdef`, cell: ctx.cell.id, lease_id: ctx.lease.lease_id, campaign_sha256: null, created_at: '', trigger: 'first-row',
        files: [{ path: 'store.tar', sha256: sha, bytes: store.length }], status: 'complete' }));
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
      route_caps: { caps: { extraction: 4096, reader: 2048, judge: 2048, agent: 16000 }, slots: { harness: 'reader', judge: 'judge', agent: 'agent' }, defaultClass: 'extraction' } });
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
    const port = await freePort(0);
    const t0 = performance.now();
    const code = await runRemote({ lease_id: 'timeout-lease', lease_usd: 0.1, command: 'sleep 30', out, timeout_hours: 1 / 3600 }, { port });
    expect(code).toBe(124);
    expect(performance.now() - t0).toBeLessThan(15_000);
    expect(JSON.parse(readFileSync(join(out, 'lease-summary.json'), 'utf8'))).toMatchObject({ timed_out: true, timeout_hours: 1 / 3600, cell_exit_code: 124 });
  }, 30_000);

  test('a server already answering on the proxy port is not taken for the lease proxy: the launch fails naming the proxy\'s exit and the cell never runs', async () => {
    const out = join(tmp, 'foreign-out');
    const port = await freePort(0);
    const foreign = Bun.serve({ port, hostname: '0.0.0.0', fetch: () => Response.json({ run_id: 'another-lease' }) });
    try {
      await expect(runRemote({ lease_id: 'foreign-lease', lease_usd: 0.1, command: 'touch "$SHOOTOUT_OUT/ran"', out }, { port }))
        .rejects.toThrow(/the metering proxy exited \(code \d+\) before it served lease foreign-lease/);
    } finally { foreign.stop(true); }
    expect(existsSync(join(out, 'ran'))).toBe(false);
  }, 30_000);

  test('rows are checkpointed every 20 attempts, and the store snapshot after ingest gets an immutable realization id', async () => {
    const out = join(tmp, 'checkpoint-out');
    const port = await freePort(0);
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

describe('A22: the VM side under a stop and a checkpoint-only resume', () => {
  test('a SIGTERM (ubi-runner stopping the detached command) stops the cell and still writes the final checkpoint and lease summary', async () => {
    const out = join(tmp, 'sigterm-out');
    const port = await freePort(0);
    const command = `for i in $(seq 1 25); do echo '{"id":"q'$i'"}' >> "$SHOOTOUT_OUT/attempts.ndjson"; done; sleep 30`;
    const run = runRemote({ lease_id: 'term-lease', lease_usd: 0.1, command, out, cell: 'kb-locomo', campaign_sha256: 'f'.repeat(64), row_pull_every: 20 }, { port, pollMs: 50 });
    while (!existsSync(join(out, 'checkpoint', 'checkpoint.json'))) await Bun.sleep(25);
    process.emit('SIGTERM' as never);
    const code = await run;
    expect(code).not.toBe(0);
    expect(JSON.parse(readFileSync(join(out, 'lease-summary.json'), 'utf8'))).toMatchObject({ stopped_by: 'SIGTERM', checkpoint_rows: 25 });
    expect(readFileSync(join(out, 'checkpoint', 'attempts.ndjson'), 'utf8').trim().split('\n')).toHaveLength(25);
  }, 30_000);

  test('a resume without a snapshot drops the old ingest-complete marker, so the new store is snapshotted after its own ingest, not at once', async () => {
    const out = join(tmp, 'answers-out');
    const staged = join(inRepo, `staged-${Date.now()}`);
    mkdirSync(join(staged, 'checkpoint'), { recursive: true });
    writeFileSync(join(staged, 'checkpoint', 'attempts.ndjson'), '{"id":"q1"}\n{"id":"q2"}\n');
    writeFileSync(join(staged, 'checkpoint', 'ingest-complete'), '{}\n');
    const port = await freePort(0);
    const command = `[ ! -e "$SHOOTOUT_OUT/ingest-complete" ] && [ ! -e "$SHOOTOUT_OUT/realization" ] && sleep 0.3 && touch "$SHOOTOUT_OUT/ingest-complete" && sleep 0.5`;
    const code = await runRemote({ lease_id: 'answers-lease', lease_usd: 0.1, command, out, cell: 'kb-locomo', campaign_sha256: 'f'.repeat(64), row_pull_every: 20,
      snapshot_command: 'printf "new store" > "$SHOOTOUT_SNAPSHOT_DIR/store.tar"', restore: { realization_id: null, dir: rel(staged) } }, { port, pollMs: 50 });
    expect(code).toBe(0);
    expect(readFileSync(join(out, 'attempts.ndjson'), 'utf8')).toBe('{"id":"q1"}\n{"id":"q2"}\n');
    expect(JSON.parse(readFileSync(join(out, 'realization', 'realization.json'), 'utf8'))).toMatchObject({ status: 'complete', trigger: 'ingest-complete' });
    expect(JSON.parse(readFileSync(join(out, 'lease-summary.json'), 'utf8'))).toMatchObject({ restored_from: null, resumed_from_checkpoint: true });
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

  test('a tampered snapshot is not recorded; without a usable snapshot the resume keeps the checkpoint and answers only what it lacks (A22)', async () => {
    const a = q1();
    const c = new Campaign(a.manifestPath, a.state);
    c.init();
    c.reserve('kb-locomo');
    const tamper = vm(1, { realization: true });
    await c.launch('kb-locomo', async (argv, ctx) => { const code = await tamper(argv, ctx); writeFileSync(join(ctx.resultsDir, 'realization', 'snapshot', 'store.tar'), 'other bytes'); return code; });
    expect((c.status() as any).realizations).toEqual([]);
    const r = await c.resume('kb-locomo', vm(1, { seen: argv => { const p = payloadOf(argv); expect(p.restore).toMatchObject({ realization_id: null }); expect(p.restore!.restore_command).toBeUndefined();
      expect(readFileSync(join(ROOT, p.restore!.dir, 'checkpoint', 'attempts.ndjson'), 'utf8')).toBe('{"id":"q1"}\n'); expect(existsSync(join(ROOT, p.restore!.dir, 'realization'))).toBe(false); } }));
    expect([r.mode, r.snapshot_check]).toEqual(['answers', 'none']);
    expect(r.note).toContain('only questions without them were answered');
  });

  test('a snapshot damaged after it was realized (an overlapping pull) is caught by its recorded sha256 before the resume launches (A22)', async () => {
    const a = q1();
    const c = new Campaign(a.manifestPath, a.state);
    c.init();
    c.reserve('hy-locomo');
    const first = await c.launch('hy-locomo', vm(1, { realization: true }));
    expect(first.realization_id).toBe('real-hy-locomo-0123456789abcdef');
    const store = join(c.resultsDir(first), 'realization', 'snapshot', 'store.tar');
    writeFileSync(store, 'store by\0\0\0');
    const r = await c.resume('hy-locomo', vm(1, { seen: argv => { const p = payloadOf(argv); expect(p.restore).toMatchObject({ realization_id: null }); expect(existsSync(join(ROOT, p.restore!.dir, 'checkpoint'))).toBe(true); } }));
    expect(r.mode).toBe('answers');
    expect(r.snapshot_check).toMatch(/^damaged: store\.tar does not match the sha256 recorded when real-hy-locomo-0123456789abcdef was realized/);
    expect(r.note).toContain('is damaged');
  });

  test('a snapshot that verifies by sha256 but lacks a volume the system\'s compose file declares is not restored; the resume ingests again (A23)', async () => {
    const snapshotTar = (volumes: string[]) => {
      const d = mkdtempSync(join(tmp, 'snap-'));
      writeFileSync(join(d, 'volumes.json'), JSON.stringify({ system: 'ext-memory-bank', volumes: volumes.map(key => ({ key, sha256: 'f'.repeat(64) })) }));
      execFileSync('tar', ['-C', d, '-cf', join(d, 'snapshot.tar'), './volumes.json']);
      return readFileSync(join(d, 'snapshot.tar'));
    };
    const cells: CampaignManifest['cells'] = [{ id: 'mb-locomo', system: 'ext-memory-bank', benchmark: 'locomo', config: 'recipe', lease_usd: 4, command: 'true', block: 'T1', restore_command: 'true' }];
    const resumeWith = async (volumes: string[]) => {
      const a = q1({}, cells);
      const c = new Campaign(a.manifestPath, a.state);
      c.init();
      c.reserve('mb-locomo');
      await c.launch('mb-locomo', vm(1, { realization: true, store: snapshotTar(volumes) }));
      return c.resume('mb-locomo', vm(0.5));
    };
    const empty = await resumeWith([]);
    expect([empty.mode, empty.realization_id]).toEqual(['answers', null]);
    expect(empty.snapshot_check).toBe('incomplete: store.tar holds no volumes, so a restore would start the system with an empty store');
    const other = await resumeWith(['cache']);
    expect(other.snapshot_check).toBe('incomplete: store.tar lacks volume db-data that docs/comparison-systems/ext-memory-bank/docker-compose.yml declares');
    const whole = await resumeWith(['db-data']);
    expect([whole.mode, whole.snapshot_check]).toEqual(['snapshot', 'verified']);
  });

  test.skipIf(process.platform !== 'linux')('a multi-GB snapshot is hashed in chunks: a 1 GiB realization verifies under a 600 MB address-space limit (A23: S2b shipped-defaults died with ENOMEM hashing its snapshot)', async () => {
    const a = q1();
    const c = new Campaign(a.manifestPath, a.state);
    c.init();
    c.reserve('hy-locomo');
    const first = await c.launch('hy-locomo', vm(1, { realization: true }));
    const dir = join(c.resultsDir(c.lease(first.lease_id)), 'realization');
    const tar = join(dir, 'snapshot', 'store.tar');
    rmSync(tar);
    execFileSync('truncate', ['-s', '1G', tar]);
    const sha = execFileSync('sha256sum', [tar], { encoding: 'utf8' }).split(' ')[0];
    const realization = JSON.parse(readFileSync(join(dir, 'realization.json'), 'utf8'));
    writeFileSync(join(dir, 'realization.json'), JSON.stringify({ ...realization, files: [{ path: 'store.tar', sha256: sha, bytes: 1 << 30 }] }));
    const script = `import { Campaign } from ${JSON.stringify(join(ROOT, 'eval/runner/shootout-cell.ts'))};
      const id = new Campaign(${JSON.stringify(a.manifestPath)}, ${JSON.stringify(a.state)}).recordRealization(${JSON.stringify(first.lease_id)});
      process.exit(id ? 0 : 3);`;
    const run = Bun.spawnSync(['bash', '-c', 'ulimit -v 600000; exec "$0" -e "$1"', process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });
    expect(run.stderr.toString()).not.toContain('ENOMEM');
    expect(run.exitCode).toBe(0);
    rmSync(tar);
  });

  test('every Q1 shim system keeps its store in named volumes, so its snapshot carries something (A23: the temporal graph and the memory bank had none)', () => {
    const plan = JSON.parse(readFileSync(join(ROOT, 'eval/runner/q1/cells/q1-cells.json'), 'utf8')) as { cells: Array<{ system: string; snapshot_command?: string }> };
    const systems = [...new Set(plan.cells.filter(c => c.snapshot_command).map(c => c.system))].sort();
    expect(systems).toContain('ext-temporal-graph');
    const unnamed = systems.flatMap(system => {
      const compose = [join(ROOT, 'eval/systems', system, 'docker-compose.yml'), join(ROOT, 'docs/comparison-systems', system, 'docker-compose.yml')].find(existsSync)!;
      const doc = Bun.YAML.parse(readFileSync(compose, 'utf8')) as { volumes?: Record<string, unknown>; services: Record<string, { volumes?: string[] }> };
      const mounted = new Set(Object.values(doc.services).flatMap(svc => (svc.volumes ?? []).map(v => String(v).split(':')[0])));
      const declared = Object.keys(doc.volumes ?? {}).filter(k => mounted.has(k));
      return declared.length ? [] : [system];
    });
    expect(unnamed).toEqual([]);
    const graph = Bun.YAML.parse(readFileSync(join(ROOT, 'docs/comparison-systems/ext-temporal-graph/docker-compose.yml'), 'utf8')) as { services: Record<string, { volumes?: string[] }> };
    expect(graph.services.neo4j.volumes).toEqual(['neo4j-data:/data', 'neo4j-logs:/logs']);
  });

  test('resume --from another campaign stages that campaign\'s checkpoint and verified snapshot under this campaign\'s lease (A22: wave-1 gaps rerun at the re-freeze)', async () => {
    const old = q1();
    const before = new Campaign(old.manifestPath, old.state);
    before.init();
    before.reserve('hy-locomo');
    await before.launch('hy-locomo', vm(1, { realization: true }));
    const now = q1();
    const c = new Campaign(now.manifestPath, now.state);
    c.init();
    const r = await c.resume('hy-locomo', vm(0.5, { seen: argv => { const p = payloadOf(argv); expect(p.restore).toMatchObject({ realization_id: 'real-hy-locomo-0123456789abcdef', restore_command: 'true' });
      expect(readFileSync(join(ROOT, p.restore!.dir, 'realization', 'snapshot', 'store.tar'), 'utf8')).toBe('store bytes'); } }), { from: before });
    expect([r.mode, r.snapshot_check]).toEqual(['snapshot', 'verified']);
    expect(r.lease).toMatchObject({ status: 'settled', attempt: 1 });
    expect(c.leases().map(l => l.cell)).toEqual(['hy-locomo']);
    expect(before.leases()).toHaveLength(1);
  });

  test('a final pull that kept failing (ubi-runner exit 253) leaves the lease open; after an abandon, the kept VM pulled late still restores (A23)', async () => {
    const a = q1();
    const c = new Campaign(a.manifestPath, a.state);
    c.init();
    const l = c.reserve('hy-locomo');
    const done = await c.launch('hy-locomo', async () => 253);
    expect(done).toMatchObject({ status: 'finished', exit_code: 253 });
    expect(c.abandon(l.lease_id, 'final pull failed; VM kept').status).toBe('abandoned');
    await vm(1, { realization: true })([], { resultsDir: c.resultsDir(done), lease: done, cell: c.cell('hy-locomo') } as unknown as LaunchContext);
    expect(c.realizedEvents()).toHaveLength(0);
    const r = await c.resume('hy-locomo', vm(0.5, { seen: argv => expect(payloadOf(argv).restore).toMatchObject({ realization_id: 'real-hy-locomo-0123456789abcdef', restore_command: 'true' }) }));
    expect([r.mode, r.snapshot_check]).toEqual(['snapshot', 'verified']);
    expect(c.realizedEvents().map(e => e.lease_id)).toEqual([l.lease_id]);
  });

  test('campaign.json names the ledger relative to the checkout, and an absolute path from another host resolves here (A23)', () => {
    const ledger = 'eval/reports/scoreboard/a23-ledger-test/campaign.sqlite';
    rmSync(join(ROOT, dirname(ledger)), { recursive: true, force: true });
    try {
      const a = q1({ ledger });
      const c = new Campaign(a.manifestPath, a.state);
      c.init();
      const statePath = join(a.state, 'campaign.json');
      expect(JSON.parse(readFileSync(statePath, 'utf8')).ledger).toBe(ledger);
      c.reserve('hy-locomo');
      const moved = { ...JSON.parse(readFileSync(statePath, 'utf8')), ledger: `/Users/custodian/old-host/gbrain-evals/${ledger}` };
      writeFileSync(statePath, JSON.stringify(moved));
      const again = new Campaign(a.manifestPath, a.state);
      expect(again.status()).toMatchObject({ committed_usd: 4 });
    } finally { rmSync(join(ROOT, dirname(ledger)), { recursive: true, force: true }); }
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

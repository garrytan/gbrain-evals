import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BudgetExceededError, closeLedgers, initLedger, readLedger } from '../../eval/runner/budget-ledger.ts';
import { analyze, failureClasses, overallVerdict, pairedBootstrap, partBReasons, pooledBootstrap, quietLatencyMs, reached, upperBound, PART_B_CELLS } from '../../eval/runner/refresh-barrier/analyze.ts';
import { PROVIDER_KEYS, brainPaths, createRepos, harnessDigest, hermeticGit } from '../../eval/runner/refresh-barrier/fixture.ts';
import { isCapStop, openBudgetItem } from '../../eval/runner/refresh-barrier/ledger.ts';
import { B_KINDS, planJobs, runBlock, type RunArgs } from '../../eval/runner/refresh-barrier/run.ts';
import { allOps, generateSchedule } from '../../eval/runner/refresh-barrier/schedule.ts';
import { B2_BUDGET, CELLS, MARGIN, compare, compareLatency, ledgerEnv, runnerArgs } from '../../eval/runner/refresh-barrier/retrieval.ts';
import { POLL_LIMIT_MS, classifyResult } from '../../eval/runner/refresh-barrier/runtime.ts';
import { cliWrapperScript } from '../../eval/runner/refresh-barrier/trial.ts';
import { allowedCode, clientView, ledgerCommits, removedByBlindPut, removerOf, verifyTrial } from '../../eval/runner/refresh-barrier/verify.ts';

describe('refresh-barrier schedule', () => {
  test('a quiet schedule keeps the seed\'s writers and writes and drops every refresh, push, sync and fault', () => {
    for (let seed = 1001; seed <= 1100; seed++) for (const engine of ['postgres', 'pglite'] as const) {
      const full = generateSchedule(seed, engine), q = generateSchedule(seed, engine, true);
      expect(q.ticks).toEqual([]); expect(q.foreign).toEqual([]); expect(q.max_wait_ms).toBeNull();
      expect(Object.values(q.strata).every(x => x === false)).toBe(true);
      expect(q.writers.every(w => w.kill_after_op === null)).toBe(true);
      const plain = (ops: ReturnType<typeof allOps>) => ops.filter(o => !/i[ab]q$/.test(o.marker)).map(o => [o.writer, o.kind, o.source, o.slug, o.request_id]);
      if (!full.strata.import_sequence) expect(plain(allOps(q))).toEqual(plain(allOps(full)));
    }
  });
  test('a seed replays identically and its markers and request ids are unique', () => {
    for (const seed of [1001, 1002, 1500]) {
      const a = generateSchedule(seed, 'postgres');
      expect(JSON.stringify(generateSchedule(seed, 'postgres'))).toBe(JSON.stringify(a));
      const ops = allOps(a);
      expect(new Set(ops.map(o => o.marker)).size).toBe(ops.length);
      expect(new Set(ops.map(o => o.request_id)).size).toBe(ops.length);
    }
  });
  test('process faults exist only on Postgres; the import sequence adds a blind put A before write B on one page', () => {
    let seenImport = 0;
    for (let seed = 1001; seed <= 1100; seed++) {
      const p = generateSchedule(seed, 'pglite');
      expect(p.strata.crash || p.strata.writer_kill).toBe(false);
      if (!p.strata.import_sequence) continue;
      seenImport++;
      const ops = allOps(p);
      const a = ops.find(o => o.marker.endsWith('iaq'))!, b = ops.find(o => o.marker.endsWith('ibq'))!;
      expect(a.kind).toBe('put_blind');
      expect(b.slug).toBe(a.slug);
      expect(b.at_ms).toBeGreaterThan(a.at_ms);
      expect(p.foreign[0]!.path).toBe(`alpha/${a.slug}.md`);
    }
    expect(seenImport).toBeGreaterThan(0);
  });
  test('no tick pushes a file a foreign commit changes (a same-line conflict the eval does not measure)', () => {
    for (let seed = 1001; seed <= 1500; seed++) for (const engine of ['postgres', 'pglite'] as const) {
      const s = generateSchedule(seed, engine);
      const foreign = new Set(s.foreign.map(f => f.path));
      expect(s.ticks.flatMap(t => t.pushes).filter(p => foreign.has(p.path))).toEqual([]);
    }
  });
});

describe('refresh-barrier analysis', () => {
  test('upper bounds match the rule of three and Clopper-Pearson', () => {
    expect(upperBound(0, 1000)).toBeCloseTo(1 - 0.05 ** (1 / 1000), 12);
    expect(upperBound(0, 500)).toBeCloseTo(0.00597, 5);
    expect(Math.abs(upperBound(1, 100) - 0.0466)).toBeLessThan(0.0005);
    expect(upperBound(3, 3)).toBe(1);
    expect(upperBound(0, 0)).toBe(1);
  });
  test('the paired bootstrap is deterministic and centred on the mean difference', () => {
    const diffs = [0.1, 0.2, 0, 0.3, 0.1, 0.2];
    const a = pairedBootstrap(diffs), b = pairedBootstrap(diffs);
    expect(a).toEqual(b);
    expect(a.mean).toBeCloseTo(0.15, 10);
    expect(a.lo!).toBeLessThanOrEqual(a.mean!);
    expect(a.hi!).toBeGreaterThanOrEqual(a.mean!);
    expect(pairedBootstrap([0, 0, 0])).toEqual({ mean: 0, lo: 0, hi: 0 });
  });
  test('the quiet latency gate pools writes per arm and resamples whole runs', () => {
    const pairs: Array<[number[], number[]]> = [[[110, 130], [100, 100]], [[200], [190, 210, 200]], [[95, 105], [100]]];
    const a = pooledBootstrap(pairs), b = pooledBootstrap(pairs);
    expect(a).toEqual(b);
    expect(a.runs).toBe(3); expect(a.writes_on).toBe(5); expect(a.writes_off).toBe(6);
    expect(a.mean).toBeCloseTo(640 / 5 - 900 / 6, 10);
    expect(a.lo!).toBeLessThanOrEqual(a.mean!); expect(a.hi!).toBeGreaterThanOrEqual(a.mean!);
    expect(pooledBootstrap([[[50], [50]], [[70], [70]]])).toEqual({ runs: 2, writes_on: 2, writes_off: 2, mean: 0, lo: 0, hi: 0 });
    expect(pooledBootstrap([]).hi).toBeNull();
  });

  test('the quiet gate times every write that ended committed to its committed answer, so a slowed write stays in the sample', () => {
    const w = { issued: true, state: 'committed' };
    expect(quietLatencyMs({ ...w, first: 'committed', first_ms: 240, committed_ms: 240 })).toBe(240);
    expect(quietLatencyMs({ ...w, first: 'pending', first_ms: 30, committed_ms: 2_400 })).toBe(2_400);
    expect(quietLatencyMs({ ...w, first: 'refused_retryable', first_ms: 20, committed_ms: 1_300 })).toBe(1_300);
    expect(quietLatencyMs({ ...w, first: 'pending', first_ms: 30, committed_ms: null })).toBe(POLL_LIMIT_MS);
    expect(quietLatencyMs({ issued: true, state: 'conflict', first: 'refused', first_ms: 25 })).toBeNull();
    expect(quietLatencyMs({ issued: false, state: 'committed', first: null })).toBeNull();
  });

  test('the writer\'s view times a write to its committed answer, and to the database commit when the writer stopped polling first', () => {
    const call = (t: number, ms: number, cls: string, attempt = 1) => ({ ev: 'response', t, ms, cls, attempt });
    const committed = { state: 'committed', updated_at: new Date(10_500).toISOString() };
    expect(clientView([call(1_240, 240, 'committed')], committed).committed_ms).toBe(240);
    expect(clientView([call(1_030, 30, 'refused_retryable'), call(2_300, 50, 'committed', 2)], committed).committed_ms).toBe(1_300);
    expect(clientView([call(1_030, 30, 'pending'), { ev: 'final', state: 'committed', after_ms: 2_400 }], committed).committed_ms).toBe(2_400);
    expect(clientView([call(1_030, 30, 'pending'), { ev: 'poll_gave_up' }], committed).committed_ms).toBe(9_500);
    expect(clientView([call(1_030, 30, 'pending'), { ev: 'poll_gave_up' }], { state: 'pending' }).committed_ms).toBeNull();
  });

  test('a failed read before an update leaves the write issued and unexpected, so it stays in the denominator', () => {
    const v = clientView([{ ev: 'read_failed', code: 'worktree_refreshing' }], null);
    expect(v.issued).toBe(true);
    expect(v.clientReasons).toEqual(['read_failed:worktree_refreshing']);
    expect(clientView([], null)).toMatchObject({ issued: false, clientReasons: [] });
  });
  test('failure classes come from ops and from run flags', () => {
    const ok = { flags: { quiesce: { ok: true }, quiesce_final: { ok: true }, converge: { ok: true }, deadlocks: 0, deadlock_mentions: 0 }, upstream: { missing_head: 0 }, child_errors: [], ops: [{ lost: false }] };
    expect(failureClasses(ok, 'trial')).toEqual([]);
    expect(failureClasses({ ...ok, ops: [{ overwritten: true }, { false_refusal: true }] }, 'trial')).toEqual(['overwritten', 'false_refusal']);
    expect(failureClasses({ ...ok, flags: { ...ok.flags, w2_hang: true } }, 'trial')).toEqual(['hang']);
    expect(failureClasses({ ...ok, flags: { ...ok.flags, deadlocks: 1 } }, 'trial')).toEqual(['deadlock']);
    expect(failureClasses({ ...ok, upstream: { missing_head: 1 } }, 'trial')).toEqual(['no_converge']);
    expect(failureClasses({ ...ok, flags: { ...ok.flags, converge: undefined } }, 'trial')).toEqual(['no_converge']);
    expect(failureClasses({ ...ok, child_errors: [{ role: 'tick', code: 'refresh_diverged' }] }, 'trial')).toEqual([]);
    expect(failureClasses({ ...ok, child_errors: [{ role: 'writer', code: null }] }, 'trial')).toEqual(['harness_error']);
    expect(failureClasses({ ...ok, strata: { writer_kill: true }, faults: { writer_killed: 1 }, flags: { ...ok.flags, writer_exits: { w0: -1, w1: 0 } } }, 'trial')).toEqual([]);
    expect(failureClasses({ ...ok, strata: { writer_kill: false }, flags: { ...ok.flags, writer_exits: { w0: -1, w1: 0 } } }, 'trial')).toEqual(['harness_error']);
    expect(failureClasses({ harness_error: { exit: 1 }, ops: [] }, 'trial')).toEqual(['harness_error']);
    expect(failureClasses({ ...ok, flags: { ...ok.flags, push_errors: 1 } }, 'trial')).toEqual(['harness_error']);
    expect(failureClasses({ ...ok, flags: { ...ok.flags, foreign_commit_errors: 1 } }, 'trial')).toEqual(['harness_error']);
    expect(failureClasses({ ...ok, flags: { ...ok.flags, unplanned_child_exits: 1 } }, 'trial')).toEqual(['harness_error']);
    expect(failureClasses({ flags: { quiesce: { ok: true }, writers_done: false }, ops: [] }, 'named')).toEqual(['hang']);
  });
  test('the gate classes added at the plan gate: unpublished, unexpected outcomes and harness signals', () => {
    const ok = { arm: 'on', flags: { quiesce: { ok: true }, quiesce_final: { ok: true }, converge: { ok: true } }, upstream: { missing_head: 0 }, child_errors: [],
      switches: [{ role: 'w0', refresh_barrier: true }], ops: [{ lost: false }] };
    expect(failureClasses(ok, 'trial')).toEqual([]);
    expect(failureClasses({ ...ok, ops: [{ unpublished: true }, { unexpected_outcome: true }] }, 'trial')).toEqual(['unpublished', 'unexpected_outcome']);
    expect(failureClasses({ ...ok, ops: [{ harness_error: true }] }, 'trial')).toEqual(['harness_error']);
    expect(failureClasses({ ...ok, switches: [{ role: 'w0', refresh_barrier: false }] }, 'trial')).toEqual(['harness_error']);
    expect(failureClasses({ ...ok, switches: [] }, 'trial')).toEqual(['harness_error']);
    expect(failureClasses({ ...ok, pause_misses: 1 }, 'trial')).toEqual(['harness_error']);
    expect(failureClasses({ ...ok, pause_skipped_current: 2 }, 'trial')).toEqual([]);
    expect(failureClasses({ ...ok, unknown_statuses: ['tick:renamed'] }, 'trial')).toEqual(['harness_error']);
    expect(failureClasses({ ...ok, flags: { ...ok.flags, too_many_clients: 1 } }, 'trial')).toEqual(['harness_error']);
    expect(failureClasses({ ...ok, flags: { ...ok.flags, writers_not_ready: true } }, 'trial')).toEqual(['harness_error']);
  });
  test('the allow-list admits expiry codes only where the schedule or the hold makes them possible', () => {
    const ctx = { expiryPossible: false, heldForRefresh: false, heldForImport: false, final: true };
    expect(allowedCode('revision_conflict', ctx)).toBe(true);
    expect(allowedCode('source_changed', ctx)).toBe(true);
    expect(allowedCode('refresh_barrier_expired', ctx)).toBe(false);
    expect(allowedCode('refresh_barrier_expired', { ...ctx, expiryPossible: true })).toBe(false);
    expect(allowedCode('refresh_barrier_expired', { ...ctx, expiryPossible: true, heldForRefresh: true })).toBe(true);
    expect(allowedCode('pending_import_expired', ctx)).toBe(false);
    expect(allowedCode('pending_import_expired', { ...ctx, heldForImport: true })).toBe(true);
    expect(allowedCode('scope_denied', { ...ctx, expiryPossible: true, heldForRefresh: true, heldForImport: true })).toBe(false);
    expect(allowedCode('cancelled', ctx)).toBe(false);
  });
  test('the spec client reads pending, refusal and unreadable answers as gbrain does', () => {
    const frozen = { error: 'unavailable', code: 'unavailable', write_error: 'write_pending', write_request: { request_id: 'r', state: 'running' }, retry_after_ms: 1000 };
    expect(classifyResult(true, frozen).cls).toBe('pending');
    expect(classifyResult(true, { ...frozen, write_request: { request_id: 'r', state: 'failed' } }).cls).toBe('refused');
    expect(classifyResult(true, { code: 'unavailable', write_error: 'write_pending' }).cls).toBe('refused');
    expect(classifyResult(true, { code: 'worktree_refreshing', retryable: true }).cls).toBe('refused_retryable');
    expect(classifyResult(true, { message: 'no code' }).cls).toBe('harness_error');
    expect(classifyResult(true, { error: 'scope_denied', code: 'scope_denied', write_error: 'source_changed', detail: 'pending_import' })).toMatchObject({ cls: 'refused', code: 'source_changed' });
    expect(classifyResult(true, { error: 'scope_denied', code: 'scope_denied' })).toMatchObject({ cls: 'refused', code: 'scope_denied' });
    expect(classifyResult(false, { state: 'committed' }).cls).toBe('committed');
    expect(classifyResult(false, { status: 'pending', state: 'queued' }).cls).toBe('pending');
    expect(classifyResult(false, { status: 'renamed' })).toMatchObject({ cls: 'harness_error', code: 'unexpected_ok:renamed' });
  });
  test('the Part B latency gate compares median query time per Cat 18 cell', () => {
    expect(compareLatency({ openai: [40, 50, 60] }, { openai: [55, 60, 65] }).pass).toBe(true);
    expect(compareLatency({ openai: [40, 50, 60] }, { openai: [61, 62, 63] }).pass).toBe(false);
    expect(compareLatency({}, {}).pass).toBe(false);
  });
  test('a stratum counts a trial only when its fault happened', () => {
    expect(reached({ strata: { crash: true }, faults: { tick_killed: 1 } }, 'crash')).toBe(true);
    expect(reached({ strata: { crash: true }, faults: { tick_killed: 0 } }, 'crash')).toBe(false);
    expect(reached({ strata: { crash: false }, faults: { tick_killed: 1 } }, 'crash')).toBe(false);
    expect(reached({ strata: { writer_kill: true }, faults: { writer_killed: 1 } }, 'writer_kill')).toBe(true);
    expect(reached({ strata: { import_sequence: true }, ops: [{ marker: 'RBM7iaq', deferred_import: true }] }, 'import_sequence')).toBe(true);
    expect(reached({ strata: { import_sequence: true }, ops: [{ marker: 'RBM7iaq', deferred_import: false }] }, 'import_sequence')).toBe(false);
  });
  test('B1 and B2 use their own preregistered margins', () => {
    const off = Object.fromEntries(CELLS.map(c => [c, Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`q${i}`, 0.5]))]));
    const on = Object.fromEntries(CELLS.map(c => [c, Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`q${i}`, 0.485]))]));
    expect(MARGIN).toEqual({ b1: -0.01, b2: -0.02 });
    expect(compare(off, on).pass).toBe(false);
    expect(compare(off, on, MARGIN.b2).pass).toBe(true);
  });
  test('the Part B margin gate needs every preregistered cell in both arms', () => {
    const all = Object.fromEntries(CELLS.map(c => [c, { q1: 1, q2: 0.5 }]));
    expect(compare(all, all).pass).toBe(true);
    const cat26Only = Object.fromEntries(CELLS.filter(c => c.startsWith('cat26/')).map(c => [c, { q1: 1, q2: 0.5 }]));
    expect(compare(cat26Only, cat26Only).pass).toBe(false);
  });
  test('removerOf names the markers that arrived in the version that dropped a marker', () => {
    expect(removerOf(['RBM1w0o0q', 'RBM1w0o0q RBM1w1o0q', 'RBM1w0o0q RBM1iaq'], 'RBM1w1o0q')).toEqual(['RBM1iaq']);
    expect(removerOf(['RBM1w0o0q', 'RBM1w0o0q RBM1w1o0q'], 'RBM1w1o0q')).toBeNull();
  });
  test('an upstream marker a committed blind put replaced after its import is not a convergence fault', () => {
    const file = ['seed', 'UPM16t1p0q\nseed', 'UPM16t1p0q\nseed RBM16w0o1q', 'RBM16w2o0q'];
    const blind = new Set(['RBM16w2o0q']);
    expect(removedByBlindPut(file, 'UPM16t1p0q', x => blind.has(x))).toBe(true);
    expect(removedByBlindPut(['seed', 'UPM16t1p0q\nseed', 'seed RBM16w0o1q'], 'UPM16t1p0q', x => blind.has(x))).toBe(false);
    expect(removedByBlindPut(['seed', 'UPM16t1p0q\nseed', 'seed'], 'UPM16t1p0q', x => blind.has(x))).toBe(false);
    expect(removedByBlindPut(['seed', 'UPM16t1p0q\nseed'], 'UPM16t1p0q', x => blind.has(x))).toBe(false);
  });
});

describe('refresh-barrier arguments', () => {
  const bad = (script: string, args: string[]) => Bun.spawnSync(['bun', '--no-env-file', `eval/runner/refresh-barrier/${script}`, ...args], { cwd: `${import.meta.dir}/../..` });
  test('a bad value exits 2 with the operation, the value and an example', () => {
    const r = bad('trial.ts', ['--seed', 'x7', '--arm', 'on', '--engine', 'pglite', '--out', '/tmp', '--gbrain-root', '/nonexistent']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toMatch(/^trial: --gbrain-root .*\nexample: bun eval\/runner\/refresh-barrier\/trial\.ts/);
    expect(bad('trial.ts', ['--arm', 'on', '--engine', 'pgsql', '--out', '/tmp', '--gbrain-root', '/tmp']).stderr.toString()).toMatch(/--engine must be postgres or pglite \(got "pgsql"\)/);
    const root = mkdtempSync(join(tmpdir(), 'rb-root-'));
    mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/cli.ts'), '');
    expect(bad('trial.ts', ['--seed', 'x7', '--arm', 'on', '--engine', 'pglite', '--out', root, '--gbrain-root', root]).stderr.toString()).toMatch(/^trial: --seed must be a non-negative integer \(got "x7"\)/);
    const named = bad('named-case.ts', ['--b', 'put', '--rep', '1', '--arm', 'on', '--engine', 'pglite', '--out', root, '--gbrain-root', root]);
    expect(named.exitCode).toBe(2);
    expect(named.stderr.toString()).toMatch(/^named-case: --b must be one of put_update, remember_entity, put_blind \(got "put"\)/);
    const b2 = bad('retrieval.ts', ['--gbrain-root', root, '--work', root]);
    expect(b2.exitCode).toBe(2);
    expect(b2.stderr.toString()).toMatch(/^retrieval: B2 \(real embedders\) makes paid calls/);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('refresh-barrier run plan', () => {
  const args: RunArgs = { block: 'trials', engine: 'postgres', gbrainRoot: '/g', out: '/o', seeds: [1001, 1010], reps: [101, 103], arms: ['off', 'on'],
    concurrency: 6, prereg: 'p.md', dry: true };
  test('every seed and arm runs once, in one fixed shuffled order', () => {
    const jobs = planJobs(args);
    expect(jobs.length).toBe(20);
    expect(new Set(jobs.map(j => j.id)).size).toBe(20);
    expect(planJobs(args).map(j => j.id)).toEqual(jobs.map(j => j.id));
    expect(jobs.map(j => j.id)).not.toEqual([...jobs.map(j => j.id)].sort());
    expect(jobs[0]!.result).toMatch(/^\/o\/trials\/postgres\/(off|on)\/10\d\d\.json$/);
  });
  test('named runs cover every repetition, kind of write B and arm', () => {
    const jobs = planJobs({ ...args, block: 'named', engine: 'pglite' });
    expect(jobs.length).toBe(3 * B_KINDS.length * 2);
    expect(jobs.every(j => j.args.includes('--b') && j.result.includes('/named/pglite/'))).toBe(true);
  });
  test('quiet runs go seed by seed with the arms alternating, each under quiet/', () => {
    const jobs = planJobs({ ...args, block: 'quiet', seeds: [2001, 2004] });
    expect(jobs.map(j => j.id)).toEqual(['quiet-postgres-on-2001', 'quiet-postgres-off-2001', 'quiet-postgres-off-2002', 'quiet-postgres-on-2002',
      'quiet-postgres-on-2003', 'quiet-postgres-off-2003', 'quiet-postgres-off-2004', 'quiet-postgres-on-2004']);
    expect(jobs.every(j => j.args.includes('--quiet') && /^\/o\/quiet\/postgres\/(off|on)\/200\d\.json$/.test(j.result))).toBe(true);
  });
});

describe('refresh-barrier counted-run integrity', () => {
  const REPO = `${import.meta.dir}/../..`;
  const put = (dir: string, rel: string, x: unknown) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), JSON.stringify(x)); };
  const gitRoot = () => {
    const root = mkdtempSync(join(tmpdir(), 'rb-g-'));
    for (const args of [['init', '-q'], ['config', 'user.name', 'Example'], ['config', 'user.email', 'example@example.invalid'], ['config', 'commit.gpgsign', 'false'], ['commit', '-q', '--allow-empty', '-m', 'init']]) Bun.spawnSync(['git', '-C', root, ...args]);
    return { root, sha: Bun.spawnSync(['git', '-C', root, 'rev-parse', 'HEAD']).stdout.toString().trim() };
  };
  const run = (args: string[]) => Bun.spawnSync(['bun', '--no-env-file', 'eval/runner/refresh-barrier/run.ts', ...args], { cwd: REPO });

  test('only a writer kill that fired excuses a writer exit', () => {
    const t = { arm: 'on', ops: [], child_errors: [], switches: [{ refresh_barrier: true }], upstream: { missing_head: 0 }, strata: { writer_kill: true },
      flags: { quiesce: { ok: true }, quiesce_final: { ok: true }, converge: { ok: true }, writer_exits: { w0: 1, w1: 0 } } };
    expect(failureClasses({ ...t, faults: { writer_killed: 0 } }, 'trial')).toContain('harness_error');
    expect(failureClasses({ ...t, faults: { writer_killed: 1 } }, 'trial')).not.toContain('harness_error');
    expect(failureClasses({ ...t, flags: { ...t.flags, writer_exits: { w0: 1, w1: 1 } }, faults: { writer_killed: 1 } }, 'trial')).toContain('harness_error');
  });

  test('the named bound counts failures over the runs in the window; every run still counts toward the verdict', () => {
    const out = mkdtempSync(join(tmpdir(), 'rb-a-'));
    const r = { arm: 'on', ops: [], switches: [{ refresh_barrier: true }] };
    put(out, 'named/postgres/on/order-put_update-101.json', { ...r, b: 'put_update', rep: 101, flags: { writers_done: true }, observed: { window_hit: true } });
    put(out, 'named/postgres/on/order-put_update-102.json', { ...r, b: 'put_update', rep: 102, flags: { writers_done: false }, observed: { window_hit: false } });
    const { bounds } = analyze(out);
    expect([bounds.named_in_window.n, bounds.named_in_window.failures]).toEqual([1, 0]);
    expect([bounds.named_all_runs.n, bounds.named_all_runs.failures]).toEqual([2, 1]);
    rmSync(out, { recursive: true, force: true });
  });

  test('non-Git effects left queued or running with recovery_required are reported per engine and arm, not counted as failures', () => {
    const out = mkdtempSync(join(tmpdir(), 'rb-a-'));
    const eff = (kind: string, state: string, error_code: string | null, n: number) => ({ kind, state, error_code, parked: false, push: null, n });
    put(out, 'trials/postgres/on/1001.json', { seed: 1001, arm: 'on', ops: [], effects: [eff('links', 'queued', 'recovery_required', 2), eff('facts-backstop', 'running', 'recovery_required', 1), eff('links', 'completed', null, 9)] });
    put(out, 'trials/postgres/on/1002.json', { seed: 1002, arm: 'on', ops: [], effects: [eff('git', 'queued', 'recovery_required', 4), eff('links', 'completed', 'recovery_required', 5)] });
    const s = analyze(out).summary['postgres/on'];
    expect(s.residual_recovery_required).toEqual({ trials: 1, rows: 3 });
    expect(s.failures.flatMap((f: { classes: string[] }) => f.classes).some((c: string) => c.includes('recovery'))).toBe(false);
    rmSync(out, { recursive: true, force: true });
  });

  test('a run is counted only with a counted receipt for every block and engine, and complete only on the preregistered seeds', () => {
    const out = mkdtempSync(join(tmpdir(), 'rb-a-'));
    put(out, 'receipt-trials-postgres.json', { counted: true, block: 'trials', engine: 'postgres' });
    put(out, 'trials/postgres/on/7.json', { seed: 7, arm: 'on', ops: [] });
    const first = analyze(out);
    expect(first.counted).toBe(false);
    expect(first.incomplete).toContain('trials postgres/on 0 of 500, 1 outside the preregistered seeds');
    expect(first.verdict_part_a).toStartWith('UNCOUNTED (would read ');
    expect(first.recommend_flag_on).toBe(false);
    put(out, 'trials/postgres/on/1001.json', { seed: 1001, arm: 'on', ops: [] });
    put(out, 'trials/postgres/on/1001-replay.json', { seed: 1001, arm: 'on', ops: [] });
    expect(analyze(out).incomplete).toContain('trials postgres/on 1 of 500, 1 outside the preregistered seeds, 1 duplicated');
    for (const block of ['trials', 'named', 'quiet']) for (const engine of ['postgres', 'pglite']) put(out, `receipt-${block}-${engine}.json`, { counted: true, block, engine });
    const counted = analyze(out);
    expect(counted.counted).toBe(true);
    expect(counted.verdict_part_a).not.toStartWith('UNCOUNTED');
    rmSync(out, { recursive: true, force: true });
  });

  test('PC2 holds only at the detector build with ten runs per kind of write B and engine', () => {
    const out = mkdtempSync(join(tmpdir(), 'rb-a-')), pc2 = mkdtempSync(join(tmpdir(), 'rb-pc2-'));
    for (const e of ['postgres', 'pglite']) for (const b of B_KINDS) for (let rep = 1; rep <= 10; rep++) {
      put(pc2, `named/${e}/on/order-${b}-${rep}.json`, { b, rep, provenance: { gbrain_sha: 'de22702a0000', harness_digest: harnessDigest() }, observed: { window_hit: true }, ops: [{ overwritten: true }] });
    }
    expect(analyze(out, pc2).positive_controls.PC2.pass).toBe(true);
    put(pc2, 'named/pglite/on/order-put_blind-10.json', { b: 'put_blind', rep: 10, provenance: { gbrain_sha: 'de22702a0000', harness_digest: 'another-tree' }, observed: { window_hit: true }, ops: [{ overwritten: true }] });
    expect(analyze(out, pc2).positive_controls.PC2).toMatchObject({ at_detector_build: true, same_harness: false, pass: false });
    put(pc2, 'named/pglite/on/order-put_blind-10.json', { b: 'put_blind', rep: 10, provenance: { gbrain_sha: 'f04429da0000', harness_digest: harnessDigest() }, observed: { window_hit: true }, ops: [{ overwritten: true }] });
    expect(analyze(out, pc2).positive_controls.PC2).toMatchObject({ at_detector_build: false, pass: false });
    rmSync(join(pc2, 'named/pglite/on/order-put_blind-10.json'));
    expect(analyze(out, pc2).positive_controls.PC2).toMatchObject({ at_detector_build: true, planned_runs: false, pass: false });
    rmSync(out, { recursive: true, force: true }); rmSync(pc2, { recursive: true, force: true });
  });

  test("the analysis records whether this analyzer's harness digest matches the results'", () => {
    const out = mkdtempSync(join(tmpdir(), 'rb-a-'));
    put(out, 'trials/postgres/on/1001.json', { seed: 1001, arm: 'on', ops: [], provenance: { gbrain_sha: 'g', harness_digest: 'h' } });
    expect(analyze(out).provenance).toMatchObject({ analyzer_digest: harnessDigest(), analyzer_matches_results: false });
    put(out, 'trials/postgres/on/1001.json', { seed: 1001, arm: 'on', ops: [], provenance: { gbrain_sha: 'g', harness_digest: harnessDigest() } });
    expect(analyze(out).provenance.analyzer_matches_results).toBe(true);
    rmSync(out, { recursive: true, force: true });
  });

  test("a job that leaves no result counts as a harness error under the block's provenance, not as mixed provenance", () => {
    const g = gitRoot(), out = mkdtempSync(join(tmpdir(), 'rb-o-'));
    const r = run(['--block', 'trials', '--engine', 'pglite', '--gbrain-root', g.root, '--out', out, '--seeds', '1001-1001', '--arms', 'on', '--dry']);
    expect(r.exitCode).toBe(0);
    const result = JSON.parse(readFileSync(join(out, 'trials/pglite/on/1001.json'), 'utf8'));
    expect(result.harness_error.exit).toBe(2);
    expect(result.provenance).toEqual({ gbrain_sha: g.sha, harness_digest: harnessDigest() });
    const a = analyze(out);
    expect(a.provenance.mixed).toBe(false);
    expect(a.bounds.trials_both_engines.failures).toBe(1);
    expect(existsSync(join(out, 'run-trials-pglite.lock'))).toBe(false);
    const events = readFileSync(join(out, 'run-trials-pglite.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(events.some(e => e.ev === 'job_start' && e.id === 'trial-pglite-on-1001')).toBe(true);
    expect(events.find(e => e.ev === 'job')).toMatchObject({ result: 'trials/pglite/on/1001.json', placeholder: true, post_result_exit: false });
    rmSync(g.root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
  });

  test('run.ts refuses a counted quiet run off the preregistered concurrency, an --out mixing dry and counted runs, and a live lock', () => {
    const g = gitRoot(), out = mkdtempSync(join(tmpdir(), 'rb-o-'));
    const quiet = run(['--block', 'quiet', '--engine', 'pglite', '--gbrain-root', g.root, '--out', out, '--gbrain-sha', g.sha, '--concurrency', '6']);
    expect(quiet.exitCode).not.toBe(0);
    expect(quiet.stderr.toString()).toContain('refusing a counted quiet run at --concurrency 6: the preregistration runs 2 at a time');
    const dry = ['--block', 'trials', '--engine', 'pglite', '--gbrain-root', g.root, '--out', out, '--seeds', '1001-1001', '--arms', 'on', '--dry'];
    put(out, 'run-trials-pglite.jsonl', { ev: 'start', dry: false });
    expect(run(dry).stderr.toString()).toContain('records a counted run of this block; dry and counted runs never share an --out');
    rmSync(join(out, 'run-trials-pglite.jsonl'));
    put(out, 'run-trials-pglite.lock', { pid: process.pid, groups: [] });
    expect(run(dry).stderr.toString()).toContain(`names a run.ts or jobs still running (pid ${process.pid})`);
    put(out, 'run-trials-pglite.lock', { pid: 2 ** 22 + 1, groups: [] });
    expect(run(dry).stderr.toString()).toContain('was left by a run.ts that did not exit cleanly and nothing it names is running; delete it and rerun');
    const trials = run(['--block', 'trials', '--engine', 'pglite', '--gbrain-root', g.root, '--out', out, '--gbrain-sha', g.sha, '--concurrency', '4']);
    expect(trials.stderr.toString()).toContain('refusing a counted trials run at --concurrency 4: the preregistration runs 6 at a time');
    rmSync(g.root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
  });

  test('a counted run refuses a harness with local changes and results no counted run of this preregistration started', async () => {
    const g = gitRoot(), out = mkdtempSync(join(tmpdir(), 'rb-o-'));
    const a: RunArgs = { block: 'trials', engine: 'pglite', gbrainRoot: g.root, out, seeds: [1001, 1001], reps: [101, 101], arms: ['on'], concurrency: 6,
      prereg: 'docs/benchmarks/2026-11-06-refresh-barrier-preregistration.md', dry: false, gbrainSha: g.sha };
    const attest = () => ({ preregistration_commit: 'c'.repeat(40) }) as unknown as ReturnType<typeof import('../../eval/runner/prereg.ts').attestPreregistration>;
    await expect(runBlock(a, { attest, harnessStatus: () => ' M eval/runner/refresh-barrier/trial.ts' })).rejects.toThrow('has uncommitted or untracked changes');
    put(out, 'trials/pglite/on/1001.json', { seed: 1001, arm: 'on', ops: [] });
    await expect(runBlock(a, { attest, harnessStatus: () => '' })).rejects.toThrow(`holds 1 results that no counted run of preregistration commit ${'c'.repeat(12)} started`);
    expect(existsSync(join(out, 'run-trials-pglite.lock'))).toBe(false);
    rmSync(g.root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
  });

  test('a development --replace refuses inside a directory that holds a counted run', () => {
    const g = gitRoot(), out = mkdtempSync(join(tmpdir(), 'rb-o-'));
    put(out, 'run-trials-pglite.jsonl', { ev: 'start', dry: false });
    mkdirSync(join(g.root, 'src')); writeFileSync(join(g.root, 'src/cli.ts'), '');
    const r = Bun.spawnSync(['bun', '--no-env-file', 'eval/runner/refresh-barrier/trial.ts', '--seed', '1001', '--arm', 'on', '--engine', 'pglite', '--out', out, '--gbrain-root', g.root, '--replace'], { cwd: REPO });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain(`--replace refuses inside ${out}, which holds a counted run`);
    rmSync(g.root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
  });

  test('a result whose job exited abnormally after writing it counts as a harness error', () => {
    const out = mkdtempSync(join(tmpdir(), 'rb-a-'));
    const clean = { seed: 1001, arm: 'on', ops: [], child_errors: [], switches: [{ refresh_barrier: true }], upstream: { missing_head: 0 },
      flags: { quiesce: { ok: true }, quiesce_final: { ok: true }, converge: { ok: true } } };
    put(out, 'trials/postgres/on/1001.json', clean);
    put(out, 'trials/postgres/on/1002.json', { ...clean, seed: 1002 });
    writeFileSync(join(out, 'run-trials-postgres.jsonl'), `${JSON.stringify({ ev: 'job', result: 'trials/postgres/on/1002.json', exit: 1, signal: null, placeholder: false, post_result_exit: true })}\n`);
    expect(analyze(out).summary['postgres/on'].failures).toEqual([{ seed: 1002, classes: ['harness_error'] }]);
    rmSync(out, { recursive: true, force: true });
  });
});

describe('refresh-barrier Amendment 1', () => {
  const REPO = `${import.meta.dir}/../..`;
  const put = (dir: string, rel: string, x: unknown) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), JSON.stringify(x)); };
  const G = 'a'.repeat(40);
  const reasons = (r: Partial<Parameters<typeof overallVerdict>[0]> = {}) => ({ counted: true, fix_method: [], fail: [], incomplete: [], incomplete_method: [], inconclusive: [], ...r });

  test('A6: the publish child runs the gbrain CLI under bun --no-env-file', () => {
    expect(cliWrapperScript('/g')).toBe('#!/bin/sh\nexec bun --no-env-file "/g/src/cli.ts" "$@"\n');
  });

  test('A7: one rule names every key-like variable, and a trial child that still sees one exits 3', () => {
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_BASE_URL', 'VOYAGE_API_KEY', 'GEMINI_API_KEY', 'PARTICLE_API_KEY', 'UBICLOUD_API_KEY', 'TYPESAFE_API_KEY', 'JEV_TYPESAFE_API_KEY',
      'EXAMPLE_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'PGPASSWORD', 'DB_PASSWD', 'GOOGLE_APPLICATION_CREDENTIALS', 'X_BEARER', 'HTTP_AUTH', 'AUTH', 'openai_api_key']) expect(PROVIDER_KEYS.test(k)).toBe(true);
    for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ', 'GBRAIN_HOME', 'GBRAIN_REFRESH_BARRIER', 'GBRAIN_JOB_CHILD_CLI', 'GIT_CONFIG_GLOBAL', 'GIT_AUTHOR_NAME',
      'RB_DIR', 'RB_DB_URL', 'RB_DB_PREFIX', 'RB_POOL', 'RB_GBRAIN_ROOT', 'RB_LEDGER_STOPS', 'BRAINBENCH_BUDGET_LEDGER', 'BRAINBENCH_BUDGET_RUN_ID']) expect(PROVIDER_KEYS.test(k)).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), 'rb-leak-'));
    const r = Bun.spawnSync(['bun', '--no-env-file', 'eval/runner/refresh-barrier/child.ts', 'writer', '0'], { cwd: REPO, env: { PATH: process.env.PATH!, RB_DIR: dir, EXAMPLE_TOKEN: 'not-a-key' } });
    expect(r.exitCode).toBe(3);
    expect(JSON.parse(readFileSync(join(dir, `env-leak-${r.pid}.json`), 'utf8'))).toEqual(['EXAMPLE_TOKEN']);
    rmSync(dir, { recursive: true, force: true });
  });

  test('O2: the overall verdict follows the decision rule, lists every reason and reads UNCOUNTED without counted receipts', () => {
    expect(overallVerdict(reasons())).toBe('PASS');
    expect(overallVerdict(reasons({ inconclusive: ['Part C inconclusive for openai:gpt-6.1-sol'] }))).toBe('PASS, agent experience inconclusive');
    expect(overallVerdict(reasons({ fail: ['B1 margin missed in cat18/openai/recall_at_10'], incomplete: ['B2 stopped at its budget cap'] })))
      .toBe('FAIL (B1 margin missed in cat18/openai/recall_at_10; also: B2 stopped at its budget cap)');
    expect(overallVerdict(reasons({ incomplete: ['Part C anthropic:claude-opus-5-5 stopped at its budget cap'], incomplete_method: ['B1 has no result'] })))
      .toBe('INCOMPLETE (Part C anthropic:claude-opus-5-5 stopped at its budget cap; also: B1 has no result)');
    expect(overallVerdict(reasons({ incomplete_method: ['B1 has no result'] }))).toBe('FIX-METHOD (B1 has no result)');
    expect(overallVerdict(reasons({ fix_method: ['positive control missed: PC2'], fail: ['3 failed flag-on trials'] }))).toBe('FIX-METHOD (positive control missed: PC2; also: 3 failed flag-on trials)');
    expect(overallVerdict(reasons({ counted: false }))).toStartWith('UNCOUNTED (would read PASS;');
  });

  test('A9: results or receipts not from G read FIX-METHOD, and the CLI needs G\'s full sha', () => {
    const out = mkdtempSync(join(tmpdir(), 'rb-a-'));
    put(out, 'trials/postgres/on/1001.json', { seed: 1001, arm: 'on', ops: [], provenance: { gbrain_sha: 'b'.repeat(40), harness_digest: harnessDigest() } });
    const notG = analyze(out, undefined, { gbrainSha: G });
    expect(notG.verdict_reasons.fix_method.some((x: string) => x.startsWith(`results or receipts not from G ${G.slice(0, 12)}`))).toBe(true);
    expect(notG.verdict).toStartWith('UNCOUNTED (would read FIX-METHOD (');
    expect(notG.provenance.results_from_g).toBe(false);
    put(out, 'trials/postgres/on/1001.json', { seed: 1001, arm: 'on', ops: [], provenance: { gbrain_sha: G, harness_digest: harnessDigest() } });
    const atG = analyze(out, undefined, { gbrainSha: G });
    expect(atG.verdict_reasons.fix_method.some((x: string) => x.includes('not from G'))).toBe(false);
    expect(atG.provenance.results_from_g).toBe(true);
    for (const sha of [[], ['--gbrain-sha', 'abc123']]) {
      const r = Bun.spawnSync(['bun', '--no-env-file', 'eval/runner/refresh-barrier/analyze.ts', '--out', out, ...sha], { cwd: REPO });
      expect(r.exitCode).toBe(2);
      expect(r.stderr.toString()).toContain("--gbrain-sha must be G's full 40-character sha");
    }
    rmSync(out, { recursive: true, force: true });
  });

  test('A2/R2: a missed positive control reads FIX-METHOD and still lists the flag-on failures', () => {
    const out = mkdtempSync(join(tmpdir(), 'rb-a-'));
    put(out, 'trials/postgres/on/1001.json', { seed: 1001, arm: 'on', ops: [{ issued: true, lost: true }], provenance: { gbrain_sha: G, harness_digest: harnessDigest() } });
    const a = analyze(out, undefined, { gbrainSha: G });
    expect(a.flag_on_failures).toEqual([{ block: 'trials', engine: 'postgres', run: '1001', classes: expect.arrayContaining(['lost']) }]);
    expect(a.verdict_part_a).toContain('would read FIX-METHOD (positive control missed: ');
    expect(a.verdict_part_a).toContain('also: 1 failed flag-on trials, quiet runs and named-case runs');
    rmSync(out, { recursive: true, force: true });
  });

  test('S1: PC5 leaves crash placeholders out of its switch and deferral checks, and a placeholder still counts as a harness error', () => {
    const out = mkdtempSync(join(tmpdir(), 'rb-a-'));
    const placeholder = { seed: 1001, arm: 'on', ops: [], placeholder: true, harness_error: { exit: 1, signal: null, timed_out: false, ms: 5, log_tail: '' } };
    put(out, 'trials/pglite/on/1001.json', placeholder);
    put(out, 'trials/pglite/on/1002.json', { seed: 1002, arm: 'on', switches: [{ refresh_barrier: true }], ops: [{ issued: true, deferred_refresh: true, first: 'pending' }] });
    put(out, 'trials/pglite/off/1002.json', { seed: 1002, arm: 'off', switches: [{ refresh_barrier: false }], ops: [] });
    const a = analyze(out);
    expect(a.positive_controls.PC5.pglite).toMatchObject({ deferral_share: 1, switches_match_arm: true, pass: true });
    expect(failureClasses(placeholder, 'trial')).toContain('harness_error');
    expect(a.positive_controls.PC4.on).toMatchObject({ trials: 2, harness_errors: 1 });
    rmSync(out, { recursive: true, force: true });
  });

  test('T3: a write that ended committed in a trial without a commit ledger is a harness error', () => {
    const t = { arm: 'on', ops: [{ state: 'committed' }], child_errors: [], switches: [{ refresh_barrier: true }], upstream: { missing_head: 0 },
      flags: { quiesce: { ok: true }, quiesce_final: { ok: true }, converge: { ok: true } } };
    expect(failureClasses({ ...t, ledger_present: false }, 'trial')).toContain('harness_error');
    expect(failureClasses({ ...t, ledger_present: true }, 'trial')).not.toContain('harness_error');
    expect(failureClasses({ ...t, ops: [{ state: 'failed' }], ledger_present: false }, 'trial')).not.toContain('harness_error');
  });

  test('T3: a ledger whose commits carry no request id is still present (gbrain records effect and merge commits that way)', () => {
    const root = mkdtempSync(join(tmpdir(), 'rb-ledger-'));
    Bun.spawnSync(['git', 'init', '-q', root]);
    expect(ledgerCommits(root)).toEqual({ byRequest: new Map(), commits: 0 });
    mkdirSync(join(root, '.git', 'gbrain'));
    const line = (x: object) => JSON.stringify({ v: 1, t: '2026-11-07T00:00:00Z', ...x });
    writeFileSync(join(root, '.git', 'gbrain', 'commit-ledger.jsonl'), [line({ e: 'start' }), line({ e: 'intent', writer: 'effect' }),
      line({ e: 'commit', sha: 'a', writer: 'effect', request_id: null }), line({ e: 'commit', sha: 'b', writer: 'merge', request_id: null }),
      line({ e: 'commit', sha: 'c', writer: 'request', request_id: 'r1' }), line({ e: 'commit', sha: 'd', writer: 'request', request_id: 'r1' })].join('\n') + '\n');
    expect(ledgerCommits(root)).toEqual({ byRequest: new Map([['r1', 2]]), commits: 4 });
    rmSync(root, { recursive: true, force: true });
  });

  test('T1, T2: lost_git and unpublished ignore write_through, and a cancelled write is always unexpected', async () => {
    const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
    const dir = mkdtempSync(join(tmpdir(), 'rb-v-'));
    try {
      const gitEnv = hermeticGit(join(dir, 'git'));
      const paths = brainPaths(dir);
      createRepos(paths);
      const schedule = generateSchedule(1001, 'pglite', true);
      const [op] = allOps(schedule);
      const events = join(dir, 'events'); mkdirSync(events);
      const verify = async (state: string, errorCode: string | null) => {
        const at = new Date().toISOString();
        const engine = { searchKeyword: async () => [], executeRaw: async (sql: string) => sql.includes('UNION ALL') ? []
          : sql.includes('FROM persistence_requests') ? [{ request_id: op!.request_id, state, error_code: errorCode, deferred_refresh_id: null, deferred_import_from: null,
            outcome: { write_through: { written: false } }, created_at: at, updated_at: at, sequence: '1', released_at: null }]
          : sql.includes('FROM pages WHERE') ? [{ body: `x ${op!.marker} y` }] : [] };
        return (await verifyTrial(engine, schedule, paths, {} as never, events)).ops.find(o => o.request_id === op!.request_id)!;
      };
      expect(await verify('committed', null)).toMatchObject({ write_through: false, lost_git: true, unpublished: false });
      writeFileSync(join(paths.root, 'marker.md'), `${op!.marker}\n`);
      Bun.spawnSync(['git', '-C', paths.root, 'add', '-A'], { env: { ...process.env, ...gitEnv } });
      Bun.spawnSync(['git', '-C', paths.root, 'commit', '-qm', 'marker'], { env: { ...process.env, ...gitEnv } });
      expect(await verify('committed', null)).toMatchObject({ write_through: false, lost_git: false, unpublished: true });
      expect((await verify('cancelled', 'revision_conflict')).unexpected_reasons).toContain('final:cancelled:revision_conflict');
      expect((await verify('conflict', 'revision_conflict')).unexpected_reasons).not.toContain('final:conflict:revision_conflict');
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('O1, A1: a counted resume refuses results from another gbrain commit or harness tree, and a job whose logged result is gone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rb-g-'));
    for (const args of [['init', '-q'], ['config', 'user.name', 'Example'], ['config', 'user.email', 'example@example.invalid'], ['config', 'commit.gpgsign', 'false'], ['commit', '-q', '--allow-empty', '-m', 'init']]) Bun.spawnSync(['git', '-C', root, ...args]);
    const sha = Bun.spawnSync(['git', '-C', root, 'rev-parse', 'HEAD']).stdout.toString().trim();
    const out = mkdtempSync(join(tmpdir(), 'rb-o-'));
    const a: RunArgs = { block: 'trials', engine: 'pglite', gbrainRoot: root, out, seeds: [1001, 1002], reps: [101, 101], arms: ['on'], concurrency: 6,
      prereg: 'docs/benchmarks/2026-11-06-refresh-barrier-preregistration.md', dry: false, gbrainSha: sha };
    const commit = 'c'.repeat(40);
    const deps = { attest: () => ({ preregistration_commit: commit }) as unknown as ReturnType<typeof import('../../eval/runner/prereg.ts').attestPreregistration>, harnessStatus: () => '' };
    writeFileSync(join(out, 'run-trials-pglite.jsonl'), `${JSON.stringify({ ev: 'start', dry: false, preregistration_commit: commit })}\n`);
    for (const provenance of [undefined, { gbrain_sha: 'd'.repeat(40), harness_digest: harnessDigest() }, { gbrain_sha: sha, harness_digest: 'another-tree' }]) {
      put(out, 'trials/pglite/on/1001.json', { seed: 1001, arm: 'on', ops: [], provenance });
      await expect(runBlock(a, deps)).rejects.toThrow('refusing to resume: 1 results carry no provenance or another gbrain commit');
    }
    put(out, 'trials/pglite/on/1001.json', { seed: 1001, arm: 'on', ops: [], provenance: { gbrain_sha: sha, harness_digest: harnessDigest() } });
    writeFileSync(join(out, 'run-trials-pglite.jsonl'), [{ ev: 'start', dry: false, preregistration_commit: commit }, { ev: 'job', result: 'trials/pglite/on/1002.json', placeholder: false }].map(e => JSON.stringify(e)).join('\n') + '\n');
    await expect(runBlock(a, deps)).rejects.toThrow('refusing to run: 1 jobs finished in');
    expect(existsSync(join(out, 'run-trials-pglite.lock'))).toBe(false);
    rmSync(root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
  });

  test('a cap stop is a reservation over a cap, a finished run or a provider budget stop; a ledger failure is not', () => {
    expect(isCapStop(new BudgetExceededError('POST api.openai.com: reserving $0.0100 would take this run to $5.0100, over its $5.00 budget'))).toBe(true);
    expect(isCapStop(new BudgetExceededError('POST: reserving $0.0100 would take the program to $2000.0100, over its $2000.00 cap (/l.sqlite)'))).toBe(true);
    expect(isCapStop(new BudgetExceededError('POST: budget run 1234 already finished'))).toBe(true);
    expect(isCapStop('budget: Particle credit exhausted (HTTP 402); top up the balance')).toBe(true);
    expect(isCapStop('budget: the metering proxy refused the openai request (HTTP 402): over budget')).toBe(true);
    expect(isCapStop(new BudgetExceededError('budget ledger lock /l.sqlite.lock has been held for over 30 s by pid 7 on h; another process is creating or migrating the ledger.'))).toBe(false);
    expect(isCapStop(new BudgetExceededError('POST: the budget ledger /l.sqlite stayed locked by another process for 30 s; nothing was reserved.'))).toBe(false);
    expect(isCapStop(new BudgetExceededError('POST: writing the budget ledger /l.sqlite failed (disk I/O error); this process refuses further spending.'))).toBe(false);
    expect(isCapStop('budget: the ledger cannot price example.com, so this request would spend unmetered')).toBe(false);
    expect(isCapStop(new Error('over its $5.00 budget'))).toBe(false);
  });

  test('B2: refused without a budget ledger; with one, every embedding request is reserved on run gbev44-refresh-barrier-b2 and a cap stop is recorded', () => {
    const work = mkdtempSync(join(tmpdir(), 'rb-b2-'));
    const env = { PATH: process.env.PATH!, HOME: work };
    const refused = Bun.spawnSync(['bun', '--no-env-file', 'eval/runner/refresh-barrier/retrieval.ts', '--gbrain-root', work, '--work', work], { cwd: REPO, env });
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr.toString()).toContain('pass --budget-ledger <path> to run B2, or --stub-embed for B1');
    expect(runnerArgs('eval/runner/cat18-embedding-providers.ts', false, true)).toEqual(['--preload', join(import.meta.dir, '../../eval/runner/refresh-barrier/ledger-preload.ts'), 'eval/runner/cat18-embedding-providers.ts']);
    expect(runnerArgs('eval/runner/cat18-embedding-providers.ts', true, false)).toEqual(['eval/runner/cat18-embedding-providers.ts', '--stub-embed']);
    const fake = join(work, 'fake-fetch.ts'), script = join(work, 'embed.ts');
    writeFileSync(fake, "globalThis.fetch = (async () => Response.json({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1] }], model: 'text-embedding-3-large', usage: { prompt_tokens: 1000, total_tokens: 1000 } })) as unknown as typeof fetch;\n");
    writeFileSync(script, "const r = await fetch('https://api.openai.com/v1/embeddings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'text-embedding-3-large', input: ['alpha beta'] }) });\nconsole.log(r.status);\n");
    const embed = (ledger: Record<string, string>) => Bun.spawnSync(['bun', '--no-env-file', '--preload', fake, ...runnerArgs(script, false, true)], { cwd: REPO, env: { ...env, ...ledger } });
    const ledgerPath = join(work, 'ledger.sqlite');
    initLedger({ ledgerPath });
    const paid = openBudgetItem(B2_BUDGET, { budgetUsd: null, ledgerPath, programCapUsd: null, programCapSource: null, runId: null });
    paid.guard.uninstall();
    const stops = join(work, 'stops.jsonl');
    const ok = embed(ledgerEnv(paid.run, stops));
    expect(ok.exitCode).toBe(0);
    let run = readLedger(ledgerPath).runs.find(r => r.run_id === paid.run.runId)!;
    expect(run).toMatchObject({ runner: 'gbev44-refresh-barrier-b2', budget_usd: 5, finished_at: null });
    const entries = readLedger(ledgerPath).entries.filter(e => e.run_id === run.run_id);
    expect(entries.map(e => e.status)).toEqual(['reconciled']);
    expect(entries[0]!.actual_usd).toBeGreaterThan(0);
    expect(existsSync(stops)).toBe(false);
    const again = openBudgetItem(B2_BUDGET, { budgetUsd: null, ledgerPath, programCapUsd: null, programCapSource: null, runId: null });
    again.guard.uninstall();
    expect(again.run.runId).toBe(paid.run.runId);
    const tiny = openBudgetItem({ runner: 'gbev44-test-tiny', cap_usd: 1e-9 }, { budgetUsd: null, ledgerPath, programCapUsd: null, programCapSource: null, runId: null });
    tiny.guard.uninstall();
    const capped = embed(ledgerEnv(tiny.run, stops));
    expect(capped.exitCode).not.toBe(0);
    const messages = readFileSync(stops, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as string);
    expect(messages.length).toBe(1);
    expect(isCapStop(messages[0]!)).toBe(true);
    tiny.run.close({ finish: true });
    expect(() => openBudgetItem({ runner: 'gbev44-test-tiny', cap_usd: 1e-9 }, { budgetUsd: null, ledgerPath, programCapUsd: null, programCapSource: null, runId: null }))
      .toThrow('a cap stop ends that part INCOMPLETE and is never retried');
    paid.run.close({ finish: false }); again.run.close({ finish: false });
    run = readLedger(ledgerPath).runs.find(r => r.run_id === paid.run.runId)!;
    expect(run.finished_at).toBeNull();
    closeLedgers();
    rmSync(work, { recursive: true, force: true });
  });

  test('Part B reasons: a missing cell is incomplete, a missed margin fails, a cap stop is INCOMPLETE, and a run not of G or not this tree is FIX-METHOD', () => {
    const digest = harnessDigest();
    const cells = Object.fromEntries(PART_B_CELLS.map(c => [c, { missing: false, pass: true }]));
    const b2 = { label: 'g', stub_embed: false, gbrain: G, harness_digest: digest, switches: { off: false, on: true }, scores: { margin: -0.02, cells }, cap_stop: false, ledger_stops: [] };
    expect(partBReasons('b2', b2, G, digest)).toEqual({ fix_method: [], fail: [], incomplete: [], incomplete_method: [] });
    expect(partBReasons('b2', null, G, digest).incomplete_method).toEqual(['B2 has no result']);
    expect(partBReasons('b2', { ...b2, scores: { margin: -0.02, cells: { ...cells, 'cat18/voyage/recall_at_10': { missing: true, pass: false } } } }, G, digest).incomplete_method).toEqual(['B2 cell cat18/voyage/recall_at_10 missing from an arm']);
    expect(partBReasons('b2', { ...b2, scores: { margin: -0.02, cells: { ...cells, 'cat26/title/mrr': { missing: false, pass: false } } } }, G, digest).fail).toEqual(['B2 margin missed in cat26/title/mrr']);
    expect(partBReasons('b2', { ...b2, cap_stop: true, ledger_stops: ['x: over its $5.00 budget'] }, G, digest)).toMatchObject({ incomplete: ['B2 stopped at its budget cap'], incomplete_method: [] });
    expect(partBReasons('b2', { ...b2, ledger_stops: ['budget ledger lock held'] }, G, digest).incomplete_method).toEqual(["B2's budget ledger refused requests without a cap stop"]);
    expect(partBReasons('b2', { ...b2, gbrain: 'b'.repeat(40), harness_digest: 'x', scores: { margin: -0.01, cells } }, G, digest).fix_method).toHaveLength(3);
  });
});

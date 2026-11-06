import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { analyze, failureClasses, pairedBootstrap, pooledBootstrap, quietLatencyMs, reached, upperBound } from '../../eval/runner/refresh-barrier/analyze.ts';
import { harnessDigest } from '../../eval/runner/refresh-barrier/fixture.ts';
import { B_KINDS, planJobs, runBlock, type RunArgs } from '../../eval/runner/refresh-barrier/run.ts';
import { allOps, generateSchedule } from '../../eval/runner/refresh-barrier/schedule.ts';
import { CELLS, MARGIN, compare, compareLatency } from '../../eval/runner/refresh-barrier/retrieval.ts';
import { POLL_LIMIT_MS, classifyResult } from '../../eval/runner/refresh-barrier/runtime.ts';
import { allowedCode, removedByBlindPut, removerOf } from '../../eval/runner/refresh-barrier/verify.ts';

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

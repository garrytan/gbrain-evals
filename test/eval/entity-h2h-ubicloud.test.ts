/**
 * The entity-dedupe head-to-head's Ubicloud launcher (eval/runner/entity-h2h/ubicloud/), keyless: run.sh against a fake
 * ubi-runner that records its arguments and environment, so no VM starts and no key leaves this machine. Key values
 * here are dummies.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetRun, closeLedgers } from '../../eval/runner/budget-ledger.ts';
import { buildWorld } from '../../eval/runner/entity-h2h/world.ts';

const REPO = join(import.meta.dir, '../..');
const dir = mkdtempSync(join(tmpdir(), 'entity-h2h-ubi-'));
const DUMMIES = { OPENAI_API_KEY: 'dummy-openai-value', ENTITY_H2H_SEED: '424242' };

function fakeRunner(name: string) {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  const fake = join(root, 'fake-ubi.sh');
  writeFileSync(fake, `#!/usr/bin/env bash
echo "$1" >> "$(dirname "$0")/calls"
case "$1" in
  list) cat "$(dirname "$0")/vms" 2>/dev/null || true ;;
  run) shift; echo "$*" >> "$(dirname "$0")/launches"; echo "quota=$UBI_QUOTA_VCPUS crew=$UBI_CREW_VCPUS owner=$UBI_OWNER reap=$UBI_REAP" >> "$(dirname "$0")/run-env"; exit 0 ;;
esac
`, { mode: 0o755 });
  const home = join(root, 'home');
  const launch = (args: string[], env: Record<string, string> = DUMMIES) => spawnSync('bash', ['eval/runner/entity-h2h/ubicloud/run.sh', ...args], { cwd: REPO, env: { PATH: process.env.PATH!, HOME: home, UBI_RUNNER: fake, ...env }, encoding: 'utf8' });
  const read = (f: string) => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8').trim().split('\n') : []);
  return { root, home, fake, launch, launches: () => read('launches'), runEnv: () => read('run-env'), cells: join(home, '.capy/work/entity-h2h-cells') };
}

describe('entity-h2h ubicloud run.sh, with a fake runner', () => {
  test('a launch passes the seed and the one key by name only, on a standard-8 VM inside the vCPU lines, detached through ubi-runner run', () => {
    const f = fakeRunner('launch');
    const r = f.launch(['launch', 'tg-default', 'ext-temporal-graph', 'default', '107.51']);
    expect(r.status).toBe(0);
    const [line] = f.launches();
    expect(line).toContain('-s standard-8');
    expect(line).toContain('--setup eval/runner/entity-h2h/ubicloud/setup.sh --env ENTITY_H2H_SYSTEM=ext-temporal-graph --pass ENTITY_H2H_SEED --pass OPENAI_API_KEY');
    expect(line).toContain(`--push ${f.cells}/tg-default:work/tg-default --pull work/tg-default:${f.cells}`);
    expect(line).toContain('-- bash eval/runner/entity-h2h/ubicloud/vm-run.sh tg-default ext-temporal-graph default 107.51 run 1 none');
    for (const v of Object.values(DUMMIES)) expect(line).not.toContain(v);
    expect(f.runEnv()).toEqual(['quota=464 crew=208 owner=gbev99 reap=0']);
    expect(existsSync(join(f.cells, 'tg-default.in-flight'))).toBe(false);
    expect(r.stdout).toContain('teardown check: no VMs of owner gbev99 remain');
  });

  test('refuses a missing key or seed, a raised vCPU line, a system that is not a memory kind, a live VM of its owner and a second launch of a cell', () => {
    const f = fakeRunner('refusals');
    const noKey = f.launch(['launch', 'c1', 'ext-temporal-graph', 'default', '5'], { ENTITY_H2H_SEED: '1' });
    expect([noKey.status, noKey.stderr]).toEqual([2, expect.stringContaining('OPENAI_API_KEY must be set')]);
    const raised = f.launch(['launch', 'c1', 'ext-temporal-graph', 'default', '5'], { ...DUMMIES, UBI_CREW_VCPUS: '300' });
    expect([raised.status, raised.stderr]).toEqual([2, expect.stringContaining('above the crew\'s line of 208')]);
    expect(f.launch(['launch', 'c1', 'gbrain', 'default', '5']).status).toBe(2);
    writeFileSync(join(f.root, 'vms'), 'ubirun-gbev99-1-abc-t12 running\n');
    const live = f.launch(['launch', 'c1', 'ext-temporal-graph', 'default', '5']);
    expect([live.status, live.stderr]).toEqual([2, expect.stringContaining('second ledger writer')]);
    expect(f.launch(['check']).status).toBe(1);
    writeFileSync(join(f.root, 'vms'), '');
    mkdirSync(join(f.cells, 'c2', 'cell'), { recursive: true });
    expect(f.launch(['launch', 'c2', 'ext-temporal-graph', 'default', '5']).stderr).toContain('launches once');
    const held = spawnSync('flock', [join(f.cells, 'c2'), 'bash', 'eval/runner/entity-h2h/ubicloud/run.sh', 'launch', 'c3', 'ext-temporal-graph', 'default', '5'], { cwd: REPO, env: { PATH: process.env.PATH!, HOME: f.home, UBI_RUNNER: f.fake, ...DUMMIES }, encoding: 'utf8' });
    expect(held.status).toBe(0);
    writeFileSync(join(f.cells, 'c9.in-flight'), 'vm=ubirun-gbev99-1-abc-t12\n');
    const stale = f.launch(['launch', 'c4', 'ext-temporal-graph', 'default', '5']);
    expect([stale.status, stale.stderr]).toEqual([2, expect.stringContaining('final pull never landed')]);
    expect(f.launches()).toEqual([expect.stringContaining('vm-run.sh c3 ')]);
  });

  test('a restart reconciles the pulled ledger first and launches attempt 2 on a fresh VM; a failed reconcile launches nothing', () => {
    const f = fakeRunner('restart');
    const cellDir = join(f.cells, 'mb', 'cell'), att = join(f.cells, 'mb', 'attempt-1');
    mkdirSync(cellDir, { recursive: true }); mkdirSync(att, { recursive: true });
    const run = BudgetRun.openLease({ runId: 'entity-h2h-mb-a1', leaseUsd: 1, ledgerPath: join(att, 'lease.sqlite') });
    run.settle(run.reserve(0.1, 'one page'), { usd: 0.02 });
    closeLedgers();
    writeFileSync(join(att, 'usage.ndjson'), JSON.stringify({ at: 'x', key: 'k', request_id: 'entity-h2h-mb-a1-1', provider: 'openai', model: 'm', outcome: 'forwarded', actual_usd: 0.02 }) + '\n');
    const w = buildWorld(7, 1);
    const cell = { cell: 'entity-h2h', system: 'ext-memory-bank', config: 'default', model: 'openai:gpt-6.2-sol', world_dir: '/home/ubi/world', world: { seed: 7, per_family: 1, pages: w.pages.length, people_ledger_sha256: w.fingerprints.people, company_ledger_sha256: w.fingerprints.companies }, projected_usd: 0.2, stop_usd: 0.31, status: 'open', label: 'x',
      attempts: [{ n: 1, kind: 'first', status: 'crashed', pid: 1, started_at: 'x', finished_at: 'x', paid: { budget_ledger: '../attempt-1/lease.sqlite', run_id: 'entity-h2h-mb-a1', usage_log: '../attempt-1/usage.ndjson' }, done: 3, reason: 'vm lost' }] };
    writeFileSync(join(cellDir, 'cell.json'), JSON.stringify(cell));
    expect(f.launch(['restart', 'nope', '0.2']).stderr).toContain('launch the cell first');
    const r = f.launch(['restart', 'mb', '0.29']);
    expect(r.status).toBe(0);
    expect(existsSync(join(cellDir, 'reconcile-entity-h2h-mb-a1.json'))).toBe(true);
    expect(f.launches()).toEqual([expect.stringContaining('vm-run.sh mb ext-memory-bank from-cell 0.29 restart 2 none')]);
    writeFileSync(join(att, 'usage.ndjson'), [1, 2].map(n => JSON.stringify({ at: 'x', key: 'k', request_id: `entity-h2h-mb-a1-${n}`, provider: 'openai', model: 'm', outcome: 'forwarded', actual_usd: 1 })).join('\n') + '\n');
    const bad = f.launch(['continue', 'mb', '0.29', '1']);
    expect([bad.status, bad.stderr]).toEqual([2, expect.stringContaining('REFUSED LEDGER_UNRECONCILED')]);
    expect(f.launches()).toHaveLength(1);
  });

  // Value: protects=no paid VM boots for an attempt vm-run.sh would refuse; fails_when=run.sh launches while an unrecorded attempt-<n> folder exists
  test('an attempt folder the cell never recorded refuses the launch before any VM starts', () => {
    const f = fakeRunner('orphan');
    mkdirSync(join(f.cells, 'o1', 'attempt-1'), { recursive: true });
    const r = f.launch(['launch', 'o1', 'ext-memory-bank', 'default', '0.2']);
    expect([r.status, r.stderr]).toEqual([2, expect.stringContaining('attempt-1 exists but the cell lists 0 attempts')]);
    expect(f.launches()).toEqual([]);
  });

  test('the VM scripts parse', () => {
    for (const s of ['run.sh', 'vm-run.sh', 'setup.sh']) expect(spawnSync('bash', ['-n', join(REPO, 'eval/runner/entity-h2h/ubicloud', s)]).status).toBe(0);
  });
});

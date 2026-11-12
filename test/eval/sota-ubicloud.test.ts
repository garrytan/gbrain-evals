/**
 * The SOTA loop's Ubicloud window launcher (eval/runner/sota/ubicloud/), keyless: run.sh against a fake runner that
 * records its arguments, and vm-run.sh on this machine with no keys and no dataset, so every paid step stops before a
 * provider is reached. Key values here are dummies; no test reads a real key.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '../..');
const dir = mkdtempSync(join(tmpdir(), 'sota-ubicloud-'));
const DUMMIES = { ANTHROPIC_API_KEY: 'dummy-anthropic', OPENAI_API_KEY: 'dummy-openai', VOYAGE_API_KEY: 'dummy-voyage', PARTICLE_API_KEY: 'dummy-particle' };

/** A fake ubi-runner: it declares UBI_TTL_HOURS support unless ttl is false, logs each subcommand to <root>/calls, list prints <root>/vms, run appends its arguments to <root>/launches. */
function fakeRunner(name: string, list = 'cat "$(dirname "$0")/vms" 2>/dev/null || true', ttl = true) {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  const fake = join(root, 'fake-ubi.sh');
  writeFileSync(fake, `#!/usr/bin/env bash\n${ttl ? '# honours UBI_TTL_HOURS\n' : ''}echo "$1" >> "$(dirname "$0")/calls"\ncase "$1" in\n  list) ${list} ;;\n  run) shift; echo "$*" >> "$(dirname "$0")/launches" ;;\nesac\n`, { mode: 0o755 });
  const home = join(root, 'home');
  const launch = (args: string[], env: Record<string, string> = DUMMIES) => spawnSync('bash', ['eval/runner/sota/ubicloud/run.sh', ...args], { cwd: REPO, env: { PATH: process.env.PATH!, HOME: home, UBI_RUNNER: fake, ...env }, encoding: 'utf8' });
  const launches = () => (existsSync(join(root, 'launches')) ? readFileSync(join(root, 'launches'), 'utf8').trim().split('\n') : []);
  const calls = () => (existsSync(join(root, 'calls')) ? readFileSync(join(root, 'calls'), 'utf8').trim().split('\n') : []);
  return { root, home, launch, launches, calls };
}
const passed = (line: string) => [...line.matchAll(/--pass (\S+)/g)].map(m => m[1]);

describe('run.sh, with a fake runner', () => {
  test('each window takes only the keys it needs: none to rehearse, Voyage for the gbrain agent\'s ingest, particle-1\'s key in its own window only', () => {
    const f = fakeRunner('keys');
    for (const w of ['rehearse', 'oracle-dev', 'dev-agent', 'particle', 'leader-cache']) expect(f.launch([w, '5']).status).toBe(0);
    expect(f.launches().map(passed)).toEqual([
      [], ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'], ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'VOYAGE_API_KEY'], ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'VOYAGE_API_KEY', 'PARTICLE_API_KEY'], ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']]);
    expect(f.launches()[3]).toContain('--setup eval/runner/sota/ubicloud/setup.sh');
    expect(f.launches()[3]).toContain(`--push ${f.home}/.capy/work/sota-windows/particle:work/particle`);
    expect(f.launches()[3]).toContain('-- bash eval/runner/sota/ubicloud/vm-run.sh particle 5');
    for (const l of f.launches()) for (const v of Object.values(DUMMIES)) expect(l).not.toContain(v);
  });

  test('refuses a window missing a key, an unknown window, a live VM of its owner, a failed VM list and a second launch holding the state lock', () => {
    const f = fakeRunner('refusals');
    const missing = f.launch(['dev-agent', '5'], { ANTHROPIC_API_KEY: 'dummy', OPENAI_API_KEY: 'dummy' });
    expect([missing.status, missing.stderr]).toEqual([2, expect.stringContaining('run.sh: window dev-agent needs VOYAGE_API_KEY set')]);
    expect(f.launch(['nightly', '5']).status).toBe(2);
    writeFileSync(join(f.root, 'vms'), 'ubirun-gbev78-1-abc-t12 running\n');
    const live = f.launch(['oracle-dev', '5']);
    expect([live.status, live.stderr]).toEqual([2, expect.stringContaining('second ledger writer')]);
    expect(f.launch(['check']).status).toBe(1);
    writeFileSync(join(f.root, 'vms'), 'ubirun-gbev55-1-abc-t4 running\n');
    expect(f.launch(['oracle-dev', '5']).status).toBe(0);
    const state = join(f.home, '.capy/work/sota-windows/oracle-dev');
    const held = spawnSync('flock', [state, 'bash', 'eval/runner/sota/ubicloud/run.sh', 'oracle-dev', '5'], { cwd: REPO, env: { PATH: process.env.PATH!, HOME: f.home, UBI_RUNNER: join(f.root, 'fake-ubi.sh'), ...DUMMIES }, encoding: 'utf8' });
    expect([held.status, held.stderr]).toEqual([2, expect.stringContaining('another launch of oracle-dev holds')]);
    expect(f.launches()).toHaveLength(1);
    const broken = fakeRunner('list-fails', 'echo "HTTP 503" >&2; exit 1');
    const r = broken.launch(['oracle-dev', '5']);
    expect([r.status, r.stderr]).toEqual([2, expect.stringContaining('could not list the VMs of owner gbev78')]);
    expect(broken.launches()).toEqual([]);
  });

  test('refuses to launch through a runner that puts no lifetime cap on its VMs, before any VM exists', () => {
    const f = fakeRunner('no-ttl', undefined, false);
    const r = f.launch(['oracle-dev', '5']);
    expect([r.status, r.stderr]).toEqual([2, expect.stringContaining('puts no lifetime cap on its VMs (it does not honour UBI_TTL_HOURS)')]);
    expect(r.stderr).toContain('set UBI_RUNNER to a runner that honours UBI_TTL_HOURS');
    expect(f.calls().filter(c => c === 'up' || c === 'run')).toEqual([]);
    expect(f.launches()).toEqual([]);
  });

  test('seeds the window\'s cache from --cache-seed on its first launch only', () => {
    const f = fakeRunner('seed');
    const seed = join(f.root, 'seed');
    mkdirSync(join(seed, 'oracle'), { recursive: true });
    writeFileSync(join(seed, 'oracle', 'beam-1m.ndjson'), 'first\n');
    expect(f.launch(['leader-cache', '5', '--cache-seed', seed]).status).toBe(0);
    const cached = join(f.home, '.capy/work/sota-windows/leader-cache/cache/oracle/beam-1m.ndjson');
    expect(readFileSync(cached, 'utf8')).toBe('first\n');
    writeFileSync(join(seed, 'oracle', 'beam-1m.ndjson'), 'second\n');
    expect(f.launch(['leader-cache', '5', '--cache-seed', seed]).status).toBe(0);
    expect(readFileSync(cached, 'utf8')).toBe('first\n');
  });
});

describe('vm-run.sh, on this machine with no keys and no dataset', () => {
  const vmRun = (home: string, window: string) => spawnSync('bash', ['eval/runner/sota/ubicloud/vm-run.sh', window, '3'], { cwd: REPO, env: { PATH: process.env.PATH!, HOME: home }, encoding: 'utf8' });

  test('rehearse runs every plan step and opens no ledger', () => {
    const home = join(dir, 'vm-rehearse');
    const r = vmRun(home, 'rehearse');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('lme-s whole-history openai:gpt-6.1-sol: 50 items, 0 fresh, 50 unknown, 0 stale');
    expect(r.stdout).toContain('sota-leader-lme.baseline-full-context.baseline: baseline-full-context (baseline) on SOTA-leader-lme');
    expect(existsSync(join(home, 'work/rehearse/ledger.sqlite'))).toBe(false);
  }, 60_000);

  test('a paid window opens one budget run under the window cap, reports each failed step and goes on, and a relaunch reuses the open run', () => {
    const home = join(dir, 'vm-particle');
    const first = vmRun(home, 'particle');
    expect(first.status).toBe(1);
    expect(first.stdout).toContain('vm-run: bun eval/runner/sota/oracle.ts run --benchmark lme-s --reader particle:particle-1');
    expect(first.stdout.match(/vm-run: FAILED/g)).toHaveLength(4);
    const S = join(home, 'work/particle');
    const rid = readFileSync(join(S, 'run-id'), 'utf8').trim();
    expect(JSON.parse(readFileSync(join(S, 'ledger-status.json'), 'utf8')).run).toMatchObject({ finished_at: null });
    vmRun(home, 'particle');
    expect(readFileSync(join(S, 'run-id'), 'utf8').trim()).toBe(rid);
  }, 120_000);
});

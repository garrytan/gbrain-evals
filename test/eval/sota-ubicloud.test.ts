/**
 * The SOTA loop's Ubicloud window launcher (eval/runner/sota/ubicloud/), keyless: run.sh against a fake runner that
 * records its arguments, and vm-run.sh on this machine with no keys and no dataset, so every paid step stops before a
 * provider is reached. Key values here are dummies; no test reads a real key.
 */
import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROVIDER_KEYS } from '../support/no-provider-keys.ts';

const REPO = join(import.meta.dir, '../..');
const dir = mkdtempSync(join(tmpdir(), 'sota-ubicloud-'));
const DUMMIES = { ANTHROPIC_API_KEY: 'dummy-anthropic', OPENAI_API_KEY: 'dummy-openai', VOYAGE_API_KEY: 'dummy-voyage', PARTICLE_API_KEY: 'dummy-particle' };

/**
 * A fake ubi-runner: it logs each subcommand to <root>/calls, list prints <root>/vms, run appends its arguments to <root>/launches and exits runExit (leaving its -n VM in <root>/vms
 * when keep is set), pull appends its arguments to <root>/pulls and its UBI_FINAL_PULL to <root>/pull-env, ssh exits
 * sshExit (or, with 'exec', runs its command here with <root>/vmhome as the VM's home), and down removes the VM from
 * <root>/vms.
 */
function fakeRunner(name: string, list = 'cat "$(dirname "$0")/vms" 2>/dev/null || true', runExit = 0, keep = false, sshExit: number | 'exec' = 0) {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  const fake = join(root, 'fake-ubi.sh');
  writeFileSync(fake, `#!/usr/bin/env bash\necho "$1" >> "$(dirname "$0")/calls"\ncase "$1" in\n  list) ${list} ;;\n  run) shift; echo "$*" >> "$(dirname "$0")/launches"; echo "UBI_REAP=\${UBI_REAP:-unset}" >> "$(dirname "$0")/run-env"; ${keep ? 'echo "$2 running" >> "$(dirname "$0")/vms"; ' : ''}exit ${runExit} ;;\n  pull) shift; echo "$*" >> "$(dirname "$0")/pulls"; echo "\${UBI_FINAL_PULL:-unset}" >> "$(dirname "$0")/pull-env" ;;\n  ssh) ${sshExit === 'exec' ? 'HOME="$(dirname "$0")/vmhome" bash -c "$3"' : `exit ${sshExit}`} ;;\n  down) sed -i "/^$2 /d" "$(dirname "$0")/vms" ;;\nesac\n`, { mode: 0o755 });
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

  test('never reaps: an expired VM of its owner with no in-flight marker here refuses the launch and the check, naming its age, before any run, reap or down, and the run is told not to reap', () => {
    const f = fakeRunner('expired');
    const fresh = `ubirun-gbev78-${Math.floor(Date.now() / 1000) - 3600}-sota-def456-t12`;
    writeFileSync(join(f.root, 'vms'), `ubirun-gbev78-1000000000-sota-abc123-t12 running\n${fresh} running\n`);
    const r = f.launch(['rehearse', '1']);
    expect([r.status, r.stderr]).toEqual([2, expect.stringContaining("may hold a window's only ledger, so a person pulls it and destroys it by hand")]);
    expect(r.stderr).toMatch(/^ubirun-gbev78-1000000000-sota-abc123-t12 is \d+h old, past its 12h TTL: pull or down by hand; nothing destroys gbev78 VMs automatically$/m);
    expect(r.stderr).not.toContain(`${fresh} is`);
    const check = f.launch(['check']);
    expect([check.status, check.stderr]).toEqual([1, expect.stringContaining('past its 12h TTL: pull or down by hand; nothing destroys gbev78 VMs automatically')]);
    expect(f.launches()).toEqual([]);
    expect(f.calls().filter(c => c !== 'list')).toEqual([]);
    expect(readFileSync(join(f.root, 'vms'), 'utf8')).toContain('ubirun-gbev78-1000000000-sota-abc123-t12');
    writeFileSync(join(f.root, 'vms'), '');
    expect(f.launch(['rehearse', '1']).status).toBe(0);
    expect(readFileSync(join(f.root, 'run-env'), 'utf8').trim()).toBe('UBI_REAP=0');
    expect(f.calls()).not.toContain('reap');
  });

  test('a window whose final pull never landed keeps its in-flight marker: the next launch and the teardown check refuse with the pull command, and pull clears it', () => {
    const f = fakeRunner('in-flight', undefined, 253, true);
    const first = f.launch(['oracle-dev', '5']);
    expect(first.status).toBe(253);
    expect(f.calls()).not.toContain('reap');
    const marker = join(f.home, '.capy/work/sota-windows/oracle-dev.in-flight');
    const vm = /^vm=(.*)$/m.exec(readFileSync(marker, 'utf8'))?.[1] ?? '';
    expect(vm).toMatch(/^ubirun-gbev78-\d{10}-sota-[0-9a-f]{6}-t12$/);
    expect(readFileSync(marker, 'utf8')).toMatch(/^launched_at=\d{4}-\d{2}-\d{2}T/m);
    expect(f.launches()[0]).toContain(`-n ${vm} `);
    const next = f.launch(['dev-agent', '5']);
    expect(next.status).toBe(2);
    expect(next.stderr).toContain('final pull never landed');
    expect(next.stderr).toContain('run.sh pull oracle-dev');
    expect(next.stderr).toContain(`pull ${vm} work/oracle-dev ${f.home}/.capy/work/sota-windows`);
    expect(f.calls()).not.toContain('reap');
    expect(f.launches()).toHaveLength(1);
    const check = f.launch(['check']);
    expect([check.status, check.stderr]).toEqual([1, expect.stringContaining('run.sh pull oracle-dev')]);
    const pull = f.launch(['pull', 'oracle-dev']);
    expect(pull.status).toBe(0);
    expect(readFileSync(join(f.root, 'pulls'), 'utf8').trim()).toBe(`${vm} work/oracle-dev ${f.home}/.capy/work/sota-windows`);
    expect(existsSync(marker)).toBe(false);
    expect(f.calls().at(-1)).toBe('down');
    expect(f.launch(['check']).status).toBe(0);
  });

  test('pull stops the command and waits for its exit status before pulling, never takes the runner\'s skip, and keeps the marker when the command has not exited or a launch still runs', () => {
    const marker = (f: ReturnType<typeof fakeRunner>) => join(f.home, '.capy/work/sota-windows/oracle-dev.in-flight');
    const ok = fakeRunner('pull-order', undefined, 253, true);
    expect(ok.launch(['oracle-dev', '5']).status).toBe(253);
    expect(ok.launch(['pull', 'oracle-dev']).status).toBe(0);
    expect(ok.calls().slice(-4)).toEqual(['stop', 'ssh', 'pull', 'down']);
    expect(readFileSync(join(ok.root, 'pull-env'), 'utf8').trim()).toBe('1');
    expect(existsSync(marker(ok))).toBe(false);

    const running = fakeRunner('pull-running', undefined, 255, true, 1);
    expect(running.launch(['oracle-dev', '5']).status).toBe(255);
    const r = running.launch(['pull', 'oracle-dev']);
    expect([r.status, r.stderr]).toEqual([1, expect.stringContaining('has not exited')]);
    expect(running.calls().slice(-2)).toEqual(['stop', 'ssh']);
    expect(existsSync(marker(running))).toBe(true);

    const held = fakeRunner('pull-held', undefined, 253, true);
    expect(held.launch(['oracle-dev', '5']).status).toBe(253);
    const state = join(held.home, '.capy/work/sota-windows/oracle-dev');
    const h = spawnSync('flock', [state, 'bash', 'eval/runner/sota/ubicloud/run.sh', 'pull', 'oracle-dev'], { cwd: REPO, env: { PATH: process.env.PATH!, HOME: held.home, UBI_RUNNER: join(held.root, 'fake-ubi.sh') }, encoding: 'utf8' });
    expect([h.status, h.stderr]).toEqual([2, expect.stringContaining('a launch of oracle-dev still holds')]);
    expect(held.calls().filter(c => c === 'stop' || c === 'pull' || c === 'down')).toEqual([]);
    expect(existsSync(marker(held))).toBe(true);
  });

  test('pull waits for every process of the stopped command\'s session, so a paid step orphaned by SIGTERM keeps the marker', async () => {
    const f = fakeRunner('pull-orphan', undefined, 253, true, 'exec');
    expect(f.launch(['oracle-dev', '5']).status).toBe(253);
    const vmHome = join(f.root, 'vmhome');
    mkdirSync(vmHome, { recursive: true });
    writeFileSync(join(vmHome, '.ubirun-cmd.rc'), '143\n');
    const orphan = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    writeFileSync(join(vmHome, '.ubirun-cmd.pid'), `${orphan.pid}\n`);
    const live = f.launch(['pull', 'oracle-dev']);
    expect([live.status, live.stderr]).toEqual([1, expect.stringContaining('or a step it started, has not exited')]);
    expect(f.calls().filter(c => c === 'pull' || c === 'down')).toEqual([]);
    const gone = new Promise(r => orphan.once('exit', r));
    orphan.kill('SIGKILL');
    await gone;
    writeFileSync(join(vmHome, '.ubirun-cmd.pid'), '');
    expect(f.launch(['pull', 'oracle-dev']).status).toBe(1);
    writeFileSync(join(vmHome, '.ubirun-cmd.pid'), `${orphan.pid}\n`);
    expect(f.launch(['pull', 'oracle-dev']).status).toBe(0);
    expect(f.calls().slice(-2)).toEqual(['pull', 'down']);
    expect(existsSync(join(f.home, '.capy/work/sota-windows/oracle-dev.in-flight'))).toBe(false);
  });

  test('the marker clears only when the run ends with its pull landed and its VM gone', () => {
    const marker = (f: ReturnType<typeof fakeRunner>) => existsSync(join(f.home, '.capy/work/sota-windows/oracle-dev.in-flight'));
    for (const code of [255, 130]) {
      const f = fakeRunner(`exit-${code}`, undefined, code);
      expect(f.launch(['oracle-dev', '5']).status).toBe(code);
      expect(marker(f)).toBe(true);
    }
    const kept = fakeRunner('vm-kept', undefined, 0, true);
    expect(kept.launch(['oracle-dev', '5']).status).toBe(1);
    expect(marker(kept)).toBe(true);
    const failed = fakeRunner('step-failed', undefined, 1);
    expect(failed.launch(['oracle-dev', '5']).status).toBe(1);
    expect(marker(failed)).toBe(false);
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
  const vmEnv = (home: string) => ({ PATH: process.env.PATH!, HOME: home, ...Object.fromEntries(PROVIDER_KEYS.map(k => [k, ''])) });
  const vmRun = (home: string, window: string) => spawnSync('bash', ['eval/runner/sota/ubicloud/vm-run.sh', window, '3'], { cwd: REPO, env: vmEnv(home), encoding: 'utf8' });

  test('its child processes see every provider key blank, so a .env in their cwd cannot fill one', () => {
    const cwd = mkdtempSync(join(dir, 'dotenv-'));
    writeFileSync(join(cwd, '.env'), PROVIDER_KEYS.map(k => `${k}=from-dotenv`).join('\n') + '\n');
    const r = spawnSync('bun', ['-e', `console.log(JSON.stringify(${JSON.stringify(PROVIDER_KEYS)}.map(k => process.env[k] ?? null)))`], { cwd, env: vmEnv(join(dir, 'vm-dotenv')), encoding: 'utf8' });
    expect(JSON.parse(r.stdout)).toEqual(PROVIDER_KEYS.map(() => ''));
  });

  test('rehearse runs every plan step and opens no ledger', () => {
    const home = join(dir, 'vm-rehearse');
    const r = vmRun(home, 'rehearse');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('lme-s whole-history openai:gpt-6.2-sol: 50 items, 0 fresh, 50 unknown, 0 stale');
    expect(r.stdout).toContain('sota-leader-lme.baseline-full-context.baseline: baseline-full-context (baseline) on SOTA-leader-lme');
    expect(existsSync(join(home, 'work/rehearse/ledger.sqlite'))).toBe(false);
  }, 60_000);

  test('the oracle and leader windows buy the nightly\'s GPT-6.2 Sol rows on both benchmarks beside Opus, from the plan files plan writes', () => {
    const oracle = vmRun(join(dir, 'vm-oracle'), 'oracle-dev').stdout;
    for (const [b, r] of [['beam-1m', 'anthropic:claude-opus-5-5'], ['beam-1m', 'openai:gpt-6.2-sol'], ['lme-s', 'anthropic:claude-opus-5-5'], ['lme-s', 'openai:gpt-6.2-sol']])
      expect(oracle).toContain(`vm-run: bun eval/runner/sota/oracle.ts run --benchmark ${b} --reader ${r} --items `);
    expect(oracle).not.toContain('--reader openai:gpt-6.1-sol');
    const leader = vmRun(join(dir, 'vm-leader'), 'leader-cache').stdout;
    for (const [b, s] of [['lme-s', 'whole-history'], ['beam-1m', 'grep-agent']]) for (const r of ['anthropic:claude-opus-5-5', 'openai:gpt-6.2-sol'])
      expect(leader).toContain(`vm-run: bun eval/runner/sota/leader.ts run --benchmark ${b} --system ${s} --reader ${r} --items `);
  }, 300_000);

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

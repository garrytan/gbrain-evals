/**
 * ubi-runner pulls of one VM never overlap: a periodic pull (the campaign
 * launcher's checkpoint pull) and the run's final pull take the VM's pull lock
 * in turn, and a periodic pull after the final pull has begun is skipped. A
 * pull cut short keeps the previous copy (A22). Detached commands (A22) survive
 * a dropped session, follow retries, and stop forwards SIGTERM. A push whose stream fails is retried, and the ssh
 * control socket fits the 104-byte limit under a long state root (A23).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const RUNNER = resolve(import.meta.dir, '../../scripts/ubicloud/ubi-runner.sh');
const tmp = mkdtempSync(join(tmpdir(), 'ubi-pull-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

/** A VM whose "ssh" runs the remote command locally after a delay and logs when each transfer starts and ends. */
function vm(delaySeconds: number) {
  const root = join(tmp, `v${++n}`), bin = join(root, 'bin'), state = join(root, 'state'), name = `ubirun-test-1791700000-${n}`;
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(state, name), { recursive: true });
  writeFileSync(join(state, name, 'env'), 'IP=127.0.0.1\nLOCATION=eu-central-h1\n');
  const log = join(root, 'ssh.log');
  writeFileSync(join(bin, 'ssh'), `#!/usr/bin/env bash\nfor a; do last=$a; done\necho "start $$ $(date +%s.%N)" >>${log}\nsleep ${delaySeconds}\nbash -c "$last"\necho "end $$ $(date +%s.%N)" >>${log}\n`);
  chmodSync(join(bin, 'ssh'), 0o755);
  const remote = join(root, 'remote');
  mkdirSync(join(remote, 'checkpoint'), { recursive: true });
  writeFileSync(join(remote, 'checkpoint', 'rows.ndjson'), '{"row":1}\n');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, UBI_RUNNER_STATE: state, UBI_OWNER: 'test' };
  const pull = (to: string, extra: Record<string, string> = {}) => Bun.spawn(['bash', RUNNER, 'pull', name, join(remote, 'checkpoint'), to], { env: { ...env, ...extra }, stdout: 'pipe', stderr: 'pipe' });
  const transfers = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(l => l.split(' ')).reduce((acc, [kind, pid, at]) => {
    if (kind === 'start') acc.push({ pid, start: Number(at), end: NaN }); else acc.find(t => t.pid === pid)!.end = Number(at);
    return acc;
  }, [] as Array<{ pid: string; start: number; end: number }>) : [];
  return { root, dir: join(state, name), pull, transfers };
}

const overlaps = (ts: Array<{ start: number; end: number }>) => ts.some((a, i) => ts.some((b, j) => i !== j && a.start < b.end && b.start < a.end));

describe('ubi-runner pull lock', () => {
  test('two pulls of the same VM run one after the other, and both land', async () => {
    const v = vm(1);
    const [a, b] = [v.pull(join(v.root, 'out-a')), v.pull(join(v.root, 'out-b'))];
    expect([await a.exited, await b.exited]).toEqual([0, 0]);
    const ts = v.transfers();
    expect(ts.length).toBe(2);
    expect(overlaps(ts)).toBe(false);
    expect(readFileSync(join(v.root, 'out-b', 'checkpoint', 'rows.ndjson'), 'utf8')).toBe('{"row":1}\n');
    expect(existsSync(join(v.dir, 'pull.lock'))).toBe(false);
  }, 20_000);

  test('the final pull waits out a periodic pull in flight, and a periodic pull after it begins is skipped', async () => {
    const v = vm(2);
    const periodic = v.pull(join(v.root, 'out'));
    await Bun.sleep(500);
    writeFileSync(join(v.dir, 'final-pull'), '');
    const final = v.pull(join(v.root, 'out'), { UBI_FINAL_PULL: '1' });
    await Bun.sleep(300);
    const late = v.pull(join(v.root, 'out'));
    expect([await periodic.exited, await final.exited, await late.exited]).toEqual([0, 0, 0]);
    expect(await new Response(late.stderr).text()).toContain('skipped: the run\'s final pull');
    const ts = v.transfers();
    expect(ts.length).toBe(2);
    expect(overlaps(ts)).toBe(false);
  }, 20_000);

  test('a pull stopped by a signal ends its ssh and tar and leaves no scratch directory or lock (A23)', async () => {
    const v = vm(3);
    const to = join(v.root, 'out');
    const p = v.pull(to);
    await Bun.sleep(1000);
    p.kill('SIGTERM');
    await p.exited;
    await Bun.sleep(4000);
    expect(require('node:fs').readdirSync(to)).toEqual([]);
    expect(existsSync(join(v.dir, 'pull.lock'))).toBe(false);
  }, 20_000);

  test('a lock left by a pull that died is broken', async () => {
    const v = vm(0);
    const dead = Bun.spawn(['true']);
    await dead.exited;
    mkdirSync(join(v.dir, 'pull.lock'));
    writeFileSync(join(v.dir, 'pull.lock', 'pid'), `${dead.pid}\n`);
    const p = v.pull(join(v.root, 'out'));
    expect(await p.exited).toBe(0);
    expect(v.transfers().length).toBe(1);
  }, 20_000);
});

/** A VM whose "ssh" runs the remote command locally (HOME is the VM home), failing while `drop` exists. */
function local(opts: { truncate?: number; failPushes?: number; state?: string; recordArgs?: boolean } = {}) {
  const root = join(tmp, `l${++n}`), bin = join(root, 'bin'), state = opts.state ?? join(root, 'state'), home = join(root, 'home'), name = `ubirun-test-1791700000-l${n}`;
  for (const d of [bin, join(state, name), home]) mkdirSync(d, { recursive: true });
  writeFileSync(join(state, name, 'env'), 'IP=127.0.0.1\nLOCATION=eu-central-h1\n');
  const drop = join(root, 'drop');
  const cut = opts.truncate ? ` | head -c ${opts.truncate}` : '';
  const failPush = opts.failPushes ? `case "$last" in *"rm -rf"*"tar -xzf"*) c=$(cat ${root}/push-fails 2>/dev/null || echo 0); if [ "$c" -lt ${opts.failPushes} ]; then echo $((c + 1)) > ${root}/push-fails; head -c 10 >/dev/null; echo "tar: Write error" >&2; exit 2; fi ;; esac\n` : '';
  const record = opts.recordArgs ? `echo "$*" >> ${root}/ssh-args\n` : '';
  writeFileSync(join(bin, 'ssh'), `#!/usr/bin/env bash\n${record}for a; do last=$a; done\n[ -e ${drop} ] && exit 255\n${failPush}cd ${home} && HOME=${home} bash -c "$last"${cut}\n`);
  chmodSync(join(bin, 'ssh'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, UBI_RUNNER_STATE: state, UBI_OWNER: 'test', UBI_FOLLOW_SECONDS: '1', UBI_STOP_WAIT_SECONDS: '10' };
  const ubi = (args: string[], extra: Record<string, string> = {}) => Bun.spawn(['bash', RUNNER, ...args], { env: { ...env, ...extra }, stdout: 'pipe', stderr: 'pipe' });
  return { root, home, name, drop, ubi };
}

describe('ubi-runner atomic pulls', () => {
  test('a pull cut short keeps the previous copy and leaves no temporary directory', async () => {
    const v = local({ truncate: 60 });
    mkdirSync(join(v.home, 'out', 'checkpoint'), { recursive: true });
    writeFileSync(join(v.home, 'out', 'checkpoint', 'rows.ndjson'), 'new\n'.repeat(5000));
    const to = join(v.root, 'pulled');
    mkdirSync(join(to, 'checkpoint'), { recursive: true });
    writeFileSync(join(to, 'checkpoint', 'rows.ndjson'), 'old\n');
    const p = v.ubi(['pull', v.name, join(v.home, 'out', 'checkpoint'), to]);
    expect(await p.exited).not.toBe(0);
    expect(await new Response(p.stderr).text()).toContain('kept the previous copy');
    expect(readFileSync(join(to, 'checkpoint', 'rows.ndjson'), 'utf8')).toBe('old\n');
    expect(require('node:fs').readdirSync(to)).toEqual(['checkpoint']);
  }, 20_000);

  test('a complete pull replaces the entry', async () => {
    const v = local();
    mkdirSync(join(v.home, 'out', 'checkpoint'), { recursive: true });
    writeFileSync(join(v.home, 'out', 'checkpoint', 'rows.ndjson'), 'new\n');
    const to = join(v.root, 'pulled');
    mkdirSync(join(to, 'checkpoint'), { recursive: true });
    writeFileSync(join(to, 'checkpoint', 'stale.ndjson'), 'old\n');
    expect(await v.ubi(['pull', v.name, join(v.home, 'out', 'checkpoint'), to]).exited).toBe(0);
    expect(readFileSync(join(to, 'checkpoint', 'rows.ndjson'), 'utf8')).toBe('new\n');
    expect(existsSync(join(to, 'checkpoint', 'stale.ndjson'))).toBe(false);
    expect(require('node:fs').readdirSync(to)).toEqual(['checkpoint']);
  }, 20_000);
});

describe('ubi-runner detached commands', () => {
  test('follow streams the log and returns the command status', async () => {
    const v = local();
    writeFileSync(join(v.home, '.ubirun-env'), 'export GREETING=hello\n');
    expect(await v.ubi(['detach', v.name, v.home, 'echo $GREETING; sleep 2; echo bye; exit 3']).exited).toBe(0);
    const f = v.ubi(['follow', v.name]);
    expect(await f.exited).toBe(3);
    expect(await new Response(f.stdout).text()).toBe('hello\nbye\n');
  }, 30_000);

  test('a dropped session is retried and the command keeps running', async () => {
    const v = local();
    writeFileSync(join(v.home, '.ubirun-env'), '');
    expect(await v.ubi(['detach', v.name, v.home, 'for i in 1 2 3 4 5 6; do echo $i; sleep 1; done; exit 0']).exited).toBe(0);
    const f = v.ubi(['follow', v.name]);
    await Bun.sleep(1500);
    writeFileSync(v.drop, '');
    await Bun.sleep(3000);
    rmSync(v.drop);
    expect(await f.exited).toBe(0);
    expect(await new Response(f.stdout).text()).toBe('1\n2\n3\n4\n5\n6\n');
    expect(await new Response(f.stderr).text()).toContain('lost the ssh session');
  }, 30_000);

  test('follow gives up with 255 after the lost window, and the command still finishes on the VM', async () => {
    const v = local();
    writeFileSync(join(v.home, '.ubirun-env'), '');
    expect(await v.ubi(['detach', v.name, v.home, 'sleep 4; echo done; exit 5']).exited).toBe(0);
    writeFileSync(v.drop, '');
    const f = v.ubi(['follow', v.name], { UBI_FOLLOW_LOST_SECONDS: '2' });
    expect(await f.exited).toBe(255);
    await Bun.sleep(4000);
    expect(readFileSync(join(v.home, '.ubirun-cmd.rc'), 'utf8').trim()).toBe('5');
    expect(readFileSync(join(v.home, '.ubirun-cmd.log'), 'utf8')).toBe('done\n');
  }, 30_000);

  test('stop forwards SIGTERM to the command, which records its own status', async () => {
    const v = local();
    writeFileSync(join(v.home, '.ubirun-env'), '');
    expect(await v.ubi(['detach', v.name, v.home, 'trap "echo stopping; exit 7" TERM; sleep 60 & wait']).exited).toBe(0);
    await Bun.sleep(1000);
    expect(await v.ubi(['stop', v.name]).exited).toBe(0);
    expect(readFileSync(join(v.home, '.ubirun-cmd.rc'), 'utf8').trim()).toBe('7');
    expect(readFileSync(join(v.home, '.ubirun-cmd.log'), 'utf8')).toBe('stopping\n');
  }, 30_000);
});

describe('ubi-runner streams and sockets (A23)', () => {
  test('a push whose stream fails ("tar: Write error") is retried whole, and gives up after UBI_PUSH_TRIES', async () => {
    const v = local({ failPushes: 1 });
    const src = join(v.root, 'custody');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'beam.json'), 'sealed bytes\n');
    const p = v.ubi(['push', v.name, src, join(v.home, 'custody')], { UBI_PUSH_TRIES: '2' });
    expect(await p.exited).toBe(0);
    expect(await new Response(p.stderr).text()).toContain('failed (attempt 1 of 2); retrying');
    expect(readFileSync(join(v.home, 'custody', 'beam.json'), 'utf8')).toBe('sealed bytes\n');

    const w = local({ failPushes: 5 });
    mkdirSync(join(w.root, 'custody'), { recursive: true });
    writeFileSync(join(w.root, 'custody', 'beam.json'), 'x\n');
    const q = w.ubi(['push', w.name, join(w.root, 'custody'), join(w.home, 'custody')], { UBI_PUSH_TRIES: '2' });
    expect(await q.exited).not.toBe(0);
    expect(await new Response(q.stderr).text()).toContain('failed after 2 attempts');
  }, 60_000);

  test('the ssh control socket stays under the 104-byte socket limit when the state root is long', async () => {
    const deep = join(tmp, 'k'.repeat(60), 'custody-host-runner-state-keep2');
    for (const [root, short] of [[join(tmp, 's'), true], [deep, false]] as const) {
      const v = local({ state: root, recordArgs: true });
      expect(await v.ubi(['pull', v.name, join(v.home, 'nothing-here'), join(v.root, 'out')]).exited).not.toBe(0);
      const path = readFileSync(join(v.root, 'ssh-args'), 'utf8').match(/ControlPath=(\S+)/)![1];
      expect(path.length + 17).toBeLessThan(104);
      if (short) expect(path).toBe(join(root, v.name, 'ctl'));
      else expect(path).toMatch(/^\/tmp\/ubi-ctl-\d+\/[0-9a-f]{32}$/);
    }
  }, 30_000);
});

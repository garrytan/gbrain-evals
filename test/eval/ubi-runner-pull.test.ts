/**
 * ubi-runner pulls of one VM never overlap: a periodic pull (the campaign
 * launcher's checkpoint pull) and the run's final pull take the VM's pull lock
 * in turn, and a periodic pull after the final pull has begun is skipped.
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

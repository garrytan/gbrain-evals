import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { main, scrubLauncherLog } from '../../eval/runner/engine-bench/launch-log.ts';
import { MACHINE_LOCAL_PATH } from '../../eval/runner/receipt.ts';

const ROOT = resolve(import.meta.dir, '../..');
const HOME = '/home/runner-x';

describe('scrubLauncherLog', () => {
  test('rewrites VM names, public IP addresses and machine paths, and keeps versions, loopback and timestamps', () => {
    const text = [
      'ubi-runner: creating eu-central-h1/ubirun-gbev98-1794926729-13834805-t5 (standard-16)',
      'ubi-runner: ready: ubirun-gbev98-1794926729-13834805-t5 (188.40.181.219)',
      'ubi-runner: ipv6 2a01:4f8:c17:abcd::1 ready',
      `ubi-runner: synced ${ROOT} -> ubirun-gbev98-1794926729-13834805-t5:work/gbrain-evals`,
      `cache ${HOME}/.capy/work/lme/cache.sqlite, gbrain ${HOME}/gbrain@v0.60.734.0`,
      'gbrain 0.60.735.0 serving on 127.0.0.1:8080 at 19:48:17',
      'gstack 1.97.0.0 and 1.100.0.0; host 10.1.2.3 and 2001:4860:4860:0:0:0:0:8888; loopback ::1',
      'db postgresql://bench:' + 's3cret' + '@10.1.2.3:5432/postgres',
      'reached 188.40.181.219. Then 188.40.181.219.5 is not an address.',
    ].join('\n');
    expect(scrubLauncherLog(text, HOME).split('\n')).toEqual([
      'ubi-runner: creating eu-central-h1/<vm> (standard-16)',
      'ubi-runner: ready: <vm> (<ip>)',
      'ubi-runner: ipv6 <ip> ready',
      'ubi-runner: synced . -> <vm>:work/gbrain-evals',
      'cache <work>/lme/cache.sqlite, gbrain ~/gbrain@v0.60.734.0',
      'gbrain 0.60.735.0 serving on 127.0.0.1:8080 at 19:48:17',
      'gstack 1.97.0.0 and 1.100.0.0; host <ip> and <ip>; loopback ::1',
      'db postgresql://bench:<redacted>@<ip>:5432/postgres',
      'reached <ip>. Then 188.40.181.219.5 is not an address.',
    ]);
  });

  test('the launcher passes output through and writes the scrubbed log with the command\'s exit code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'launch-log-'));
    try {
      const out = join(dir, 'logs/launcher.log');
      const code = await main(['--out', out, '--', 'sh', '-c', `echo "ready: ubirun-gbev98-1-ab-t5 (188.40.181.219)"; echo "out ${tmpdir()}/x" >&2; exit 3`]);
      expect(code).toBe(3);
      const log = readFileSync(out, 'utf8');
      expect(log).toContain('ready: <vm> (<ip>)');
      expect(log).toContain('out <tmp>/x');
      expect(MACHINE_LOCAL_PATH.test(log)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('stdout and stderr lines stay whole, a character split across chunks survives, and a missing command is logged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'launch-log-'));
    try {
      const out = join(dir, 'a.log');
      const script = [
        `process.stdout.write('out-a ');`,
        `process.stderr.write('err-line\\n');`,
        `setTimeout(() => { process.stdout.write(Buffer.from([0xc3])); setTimeout(() => process.stdout.write(Buffer.concat([Buffer.from([0xa9]), Buffer.from(' out-b', 'utf8'), Buffer.from([10])])), 20); }, 20);`,
      ].join(' ');
      expect(await main(['--out', out, '--', process.execPath, '-e', script])).toBe(0);
      expect(readFileSync(out, 'utf8').split('\n').filter(Boolean).sort()).toEqual(['err-line', 'out-a é out-b']);
      const missing = join(dir, 'b.log');
      expect(await main(['--out', missing, '--', join(dir, 'no-such-command')])).toBe(127);
      expect(readFileSync(missing, 'utf8')).toContain('launch-log: could not start <tmp>/');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a SIGTERM to the launcher reaches its command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'launch-log-'));
    try {
      const out = join(dir, 'c.log');
      const run = main(['--out', out, '--', 'sh', '-c', 'trap "echo got-term; exit 7" TERM; echo ready; while :; do sleep 0.05; done']);
      const deadline = Date.now() + 10_000;
      while (!(existsSync(out) && readFileSync(out, 'utf8').includes('ready\n')) && Date.now() < deadline) await Bun.sleep(20);
      process.emit('SIGTERM', 'SIGTERM');
      expect(await run).toBe(7);
      expect(readFileSync(out, 'utf8')).toBe('ready\ngot-term\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

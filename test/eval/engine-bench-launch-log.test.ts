import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    ].join('\n');
    expect(scrubLauncherLog(text, HOME).split('\n')).toEqual([
      'ubi-runner: creating eu-central-h1/<vm> (standard-16)',
      'ubi-runner: ready: <vm> (<ip>)',
      'ubi-runner: ipv6 <ip> ready',
      'ubi-runner: synced . -> <vm>:work/gbrain-evals',
      'cache <work>/lme/cache.sqlite, gbrain ~/gbrain@v0.60.734.0',
      'gbrain 0.60.735.0 serving on 127.0.0.1:8080 at 19:48:17',
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
});

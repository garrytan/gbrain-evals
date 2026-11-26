/**
 * ubi-runner.sh sends the Ubicloud API key to curl as a header file on a pipe, never in curl's argv, so a process
 * listing that prints arguments never shows it. A curl wrapper on PATH records the argv it was given and execs the real
 * curl against a fake Ubicloud API on 127.0.0.1, which records the Authorization header it received. The key is a
 * dummy value; no test reaches the network or makes a VM.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const RUNNER = resolve(import.meta.dir, '../../scripts/ubicloud/ubi-runner.sh');
const DUMMY = 'ubi-dummy-key-0f3a9c';
const tmp = mkdtempSync(join(tmpdir(), 'ubi-key-argv-'));
const argvLog = join(tmp, 'curl-argv.log');
const seen: string[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) { seen.push(req.headers.get('authorization') ?? ''); return new Response(''); } });
  const realCurl = Bun.which('curl');
  if (!realCurl) throw new Error('curl is not installed');
  const bin = join(tmp, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> '${argvLog}'\nexec '${realCurl}' "$@"\n`);
  chmodSync(join(bin, 'curl'), 0o755);
  process.env.UBI_KEY_ARGV_BIN = bin;
});
afterAll(() => { server.stop(true); rmSync(tmp, { recursive: true, force: true }); });

test('the API key reaches Ubicloud as a header but never appears in curl argv', async () => {
  const env = {
    PATH: `${process.env.UBI_KEY_ARGV_BIN}:${process.env.PATH ?? ''}`, HOME: tmp, UBI_RUNNER_STATE: join(tmp, 'state'),
    UBICLOUD_API_KEY: DUMMY, UBICLOUD_API_URL: `http://127.0.0.1:${server.port}`, UBI_OWNER: 'test', UBI_API_TIMEOUT: '5',
  };
  const p = Bun.spawn(['bash', RUNNER, 'list'], { env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  await p.exited;
  const argv = readFileSync(argvLog, 'utf8');
  expect(argv.length).toBeGreaterThan(0);
  expect(argv.includes(DUMMY)).toBe(false);
  expect(/authorization/i.test(argv)).toBe(false);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every(h => h === `Bearer ${DUMMY}`)).toBe(true);
});

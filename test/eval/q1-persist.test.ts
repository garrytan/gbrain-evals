/**
 * eval/runner/q1/persist.sh keeps copying a public campaign's state to the results branch until its hours run out.
 * Hours may be fractional (default 5.8): a stub clock advances ten minutes per reading and a stub sleep returns at
 * once, so the number of sleeps counts the rounds the deadline allows.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dir, '../../eval/runner/q1/persist.sh');
const tmp = mkdtempSync(join(tmpdir(), 'q1-persist-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

function run(hours: string) {
  const dir = join(tmp, `r${++n}`);
  const bin = join(dir, 'bin'), state = join(dir, 'state'), wt = join(dir, 'wt'), remote = join(dir, 'remote.git');
  for (const d of [bin, state, wt]) mkdirSync(d, { recursive: true });
  writeFileSync(join(state, 'leases.ndjson'), '{}\n');
  const git = (cwd: string, ...args: string[]) => Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  Bun.spawnSync(['git', 'init', '-q', '--bare', remote]);
  git(wt, 'init', '-q');
  git(wt, 'config', 'user.name', 't');
  git(wt, 'config', 'user.email', 't@example.invalid');
  git(wt, 'remote', 'add', 'origin', remote);
  writeFileSync(join(bin, 'date'), `#!/usr/bin/env bash
if [ "$1" = "+%s" ]; then c=$(cat "${dir}/clock" 2>/dev/null || echo 1000000); echo "$c"; echo $((c + 600)) > "${dir}/clock"; else exec /bin/date "$@"; fi
`);
  writeFileSync(join(bin, 'sleep'), `#!/usr/bin/env bash\necho "$1" >> "${dir}/sleeps"\n`);
  for (const f of ['date', 'sleep']) chmodSync(join(bin, f), 0o755);
  const p = Bun.spawnSync(['bash', SCRIPT, state, 'q1-public-test', '10', hours], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, Q1_RESULTS_WORKTREE: wt, Q1_RESULTS_BRANCH: 'results' }, stdout: 'pipe', stderr: 'pipe' });
  const sleeps = existsSync(join(dir, 'sleeps')) ? readFileSync(join(dir, 'sleeps'), 'utf8').split('\n').filter(Boolean).length : 0;
  return { code: p.exitCode, stderr: p.stderr.toString(), sleeps, pushed: git(remote, 'log', '--oneline', 'results').stdout.toString().trim() };
}

describe('persist.sh deadline', () => {
  test('half an hour of ten-minute rounds sleeps twice; a fractional hour is not truncated to zero', () => {
    const r = run('0.5');
    expect(r.code, r.stderr).toBe(0);
    expect(r.sleeps).toBe(2);
    expect(r.pushed).toContain('q1 results: q1-public-test');
  });

  test('1.5 hours of ten-minute rounds sleeps eight times, not five', () => {
    expect(run('1.5').sleeps).toBe(8);
  });

  test('a sealed campaign is refused before anything is copied', () => {
    const p = Bun.spawnSync(['bash', SCRIPT, tmp, 'q1-scoreboard-sealed'], { stdout: 'pipe', stderr: 'pipe' });
    expect([p.exitCode, p.stderr.toString().trim()]).toEqual([2, 'persist.sh refuses sealed campaigns']);
  });
});

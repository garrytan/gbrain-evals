import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countedRun } from '../../eval/runner/engine-bench/counted.ts';

function pushedRepo(): string {
  const remote = mkdtempSync(join(tmpdir(), 'counted-remote-'));
  execFileSync('git', ['init', '-q', '--bare', remote]);
  const dir = mkdtempSync(join(tmpdir(), 'counted-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  g('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs/x-prereg.md'), 'rule');
  g('add', '-A');
  g('commit', '-q', '-m', 'prereg');
  g('remote', 'add', 'origin', remote);
  g('push', '-q', 'origin', 'main');
  g('fetch', '-q', 'origin');
  return dir;
}

describe('countedRun', () => {
  test('--dev is an uncounted run with no attestation', () => {
    expect(countedRun(['--dev'], '/nonexistent', 9)).toEqual({ counted: false, preregistration_attestation: null });
  });

  test('a run without --dev needs --prereg', () => {
    expect(() => countedRun(['--engines', 'pglite'], '/nonexistent', 0)).toThrow(/needs --prereg/);
  });

  test('a counted run attests a pushed preregistration', () => {
    const dir = pushedRepo();
    const run = countedRun(['--prereg', 'docs/x-prereg.md'], dir, 0.5);
    expect(run.counted).toBe(true);
    expect(run.preregistration_attestation?.preregistration).toBe('docs/x-prereg.md');
    expect(countedRun(['--prereg=docs/x-prereg.md'], dir, 0.5).counted).toBe(true);
  });

  test('a counted run refuses a load average above 2', () => {
    expect(() => countedRun(['--prereg', 'docs/x-prereg.md'], pushedRepo(), 2.5)).toThrow(/load average 2.50/);
  });
});

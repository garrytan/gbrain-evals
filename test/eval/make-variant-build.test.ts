import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeVariantBuild } from '../../eval/runner/lifecycle/make-variant-build.ts';

describe('make-variant-build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'variant-test-'));
  const repo = join(dir, 'repo');
  const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  let base = '';

  beforeAll(() => {
    writeFileSync(join(dir, 'gitconfig'), '[user]\n\tname = fixture\n\temail = fixture@example.invalid\n');
    process.env.GIT_CONFIG_GLOBAL = join(dir, 'gitconfig');
    execFileSync('git', ['init', '-q', repo]);
    writeFileSync(join(repo, 'guard.ts'), 'export const GUARD = true;\nexport const OTHER = 1;\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    base = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'guard.ts'), 'export const OTHER = 1;\n');
    writeFileSync(join(dir, 'no-guard.patch'), `${git('diff')}\n`);
    git('checkout', '-q', '--', 'guard.ts');
  });
  afterAll(() => {
    if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    rmSync(dir, { recursive: true, force: true });
  });

  test('commits base + patch without touching the checkout, keeps it under a local ref, reuses it on rerun', () => {
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
    const v = makeVariantBuild({ checkout: repo, ref: 'HEAD', patch: join(dir, 'no-guard.patch'), name: 'no-guard' });
    expect(v.base).toBe(base);
    expect(git('rev-parse', `${v.sha}^`)).toBe(base);
    expect(git('show', `${v.sha}:guard.ts`)).toBe('export const OTHER = 1;');
    expect(git('rev-parse', v.ref)).toBe(v.sha);
    expect(v.gbrain_spec).toBe(`${repo}@${v.sha}`);
    expect(git('rev-parse', 'HEAD')).toBe(base);
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);
    expect(git('status', '--porcelain')).toBe('');
    expect(readFileSync(join(repo, 'guard.ts'), 'utf8')).toContain('GUARD');
    const again = makeVariantBuild({ checkout: repo, ref: base, patch: join(dir, 'no-guard.patch'), name: 'no-guard' });
    expect(again.reused).toBe(true);
    expect(again.sha).toBe(v.sha);
  });

  test('a patch that does not apply or changes nothing is refused', () => {
    writeFileSync(join(dir, 'bad.patch'), 'diff --git a/missing.ts b/missing.ts\n--- a/missing.ts\n+++ b/missing.ts\n@@ -1 +1 @@\n-a\n+b\n');
    expect(() => makeVariantBuild({ checkout: repo, ref: base, patch: join(dir, 'bad.patch'), name: 'bad' })).toThrow(/does not apply/);
    expect(() => makeVariantBuild({ checkout: repo, ref: base, patch: join(dir, 'no-guard.patch'), name: 'bad name' })).toThrow(/--name/);
  });
});

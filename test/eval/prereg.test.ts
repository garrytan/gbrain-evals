import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attestPreregistration, checkOrder } from '../../eval/runner/prereg.ts';

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'prereg-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  g('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  return dir;
}

function commit(dir: string, file: string, body: string, message: string): string {
  writeFileSync(join(dir, file), body);
  execFileSync('git', ['add', file], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

const entry = { id: 'x', preregistration: 'docs/x-prereg.md', results: ['docs/x-receipt*.json'] };

describe('checkOrder', () => {
  test('passes when the preregistration is committed before the receipt', () => {
    const dir = repo();
    commit(dir, 'docs/x-prereg.md', 'rule', 'prereg');
    commit(dir, 'docs/x-receipt.json', '{}', 'receipt');
    expect(checkOrder([entry], dir)).toEqual([]);
  });

  test('fails when the receipt lands in the same commit as the preregistration', () => {
    const dir = repo();
    writeFileSync(join(dir, 'docs/x-prereg.md'), 'rule');
    writeFileSync(join(dir, 'docs/x-receipt.json'), '{}');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'both'], { cwd: dir });
    expect(checkOrder([entry], dir).map(p => p.file)).toEqual(['docs/x-receipt.json']);
  });

  test('fails when the receipt predates the preregistration', () => {
    const dir = repo();
    commit(dir, 'docs/x-receipt.json', '{}', 'receipt');
    commit(dir, 'docs/x-prereg.md', 'rule', 'prereg');
    expect(checkOrder([entry], dir)).toHaveLength(1);
  });

  test('fails when the preregistration is missing', () => {
    const dir = repo();
    commit(dir, 'docs/x-receipt.json', '{}', 'receipt');
    expect(checkOrder([entry], dir)[0]!.problem).toContain('not committed');
  });

  test('fails when a receipt attestation names another preregistration', () => {
    const dir = repo();
    const pre = commit(dir, 'docs/x-prereg.md', 'rule', 'prereg');
    commit(dir, 'docs/x-receipt.json', JSON.stringify({ preregistration_attestation: { preregistration: 'docs/other.md', preregistration_commit: pre } }), 'receipt');
    expect(checkOrder([entry], dir)[0]!.problem).toContain('expected docs/x-prereg.md');
  });
});

describe('attestPreregistration', () => {
  test('refuses an uncommitted preregistration', () => {
    const dir = repo();
    commit(dir, 'README', 'r', 'init');
    writeFileSync(join(dir, 'docs/x-prereg.md'), 'rule');
    expect(() => attestPreregistration('docs/x-prereg.md', dir)).toThrow(/uncommitted|not committed/);
  });

  test('refuses a preregistration that is not on origin', () => {
    const dir = repo();
    commit(dir, 'docs/x-prereg.md', 'rule', 'prereg');
    expect(() => attestPreregistration('docs/x-prereg.md', dir)).toThrow(/not on origin/);
  });

  test('attests a pushed preregistration', () => {
    const remote = mkdtempSync(join(tmpdir(), 'prereg-remote-'));
    execFileSync('git', ['init', '-q', '--bare', remote]);
    const dir = repo();
    const pre = commit(dir, 'docs/x-prereg.md', 'rule', 'prereg');
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: dir });
    execFileSync('git', ['fetch', '-q', 'origin'], { cwd: dir });
    const a = attestPreregistration('docs/x-prereg.md', dir, new Date('2026-10-06T00:00:00Z'));
    expect(a.preregistration_commit).toBe(pre);
    expect(a.on_origin).toBe(true);
  });
});

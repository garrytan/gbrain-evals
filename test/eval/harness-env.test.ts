import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureHarnessSource, type HarnessLock } from '../../eval/runner/harness-env.ts';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'harness-env-'));
  const upstream = join(root, 'upstream');
  execFileSync('git', ['init', '-q', upstream]);
  writeFileSync(join(upstream, 'pinned.txt'), 'pinned harness source\n');
  git(upstream, 'add', '.');
  git(upstream, 'commit', '-q', '-m', 'pinned');
  const commit = git(upstream, 'rev-parse', 'HEAD');
  const lock = { harness_repo: `file://${upstream}`, harness_commit: commit } as HarnessLock;
  const home = join(root, 'home');
  const pack = join(home, 'packs', `${commit}.pack`);
  const src = join(home, 'src', commit);
  return { root, upstream, commit, lock, home, pack, src, offline: { ...lock, harness_repo: `file://${join(root, 'no-such-repo')}` } };
}

function packOf(dir: string, objects: string[], out: string) {
  writeFileSync(out, execFileSync('git', ['-C', dir, 'pack-objects', '--stdout'], { input: objects.join('\n') + '\n' }));
}

describe('harness source cache (GST-1266)', () => {
  test('the first setup fetches the pinned commit and keeps a pack, and a later setup restores from the pack without fetching', () => {
    const f = fixture();
    try {
      const first: string[] = [];
      expect(ensureHarnessSource(f.lock, l => first.push(l), f.home)).toBe(f.src);
      expect(first.some(l => l.includes('fetching'))).toBe(true);
      expect(existsSync(f.pack)).toBe(true);

      rmSync(f.src, { recursive: true, force: true });
      const second: string[] = [];
      expect(ensureHarnessSource(f.offline, l => second.push(l), f.home)).toBe(f.src);
      expect(second.some(l => l.includes('fetching'))).toBe(false);
      expect(git(f.src, 'rev-parse', 'HEAD')).toBe(f.commit);
      expect(git(f.src, 'status', '--porcelain', '--untracked-files=all')).toBe('');
      expect(readFileSync(join(f.src, 'pinned.txt'), 'utf8')).toBe('pinned harness source\n');
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('a pack whose objects do not make up the pinned commit is refused, and the commit is fetched again', () => {
    const f = fixture();
    try {
      ensureHarnessSource(f.lock, () => {}, f.home);
      rmSync(f.src, { recursive: true, force: true });
      writeFileSync(join(f.upstream, 'tampered.txt'), 'tampered harness source\n');
      const tampered = git(f.upstream, 'hash-object', '-w', 'tampered.txt');
      packOf(f.upstream, [f.commit, git(f.upstream, 'rev-parse', 'HEAD^{tree}'), tampered], f.pack);

      const logs: string[] = [];
      ensureHarnessSource(f.lock, l => logs.push(l), f.home);
      expect(logs.some(l => l.includes('refused the cached pack'))).toBe(true);
      expect(logs.some(l => l.includes('fetching'))).toBe(true);
      expect(readFileSync(join(f.src, 'pinned.txt'), 'utf8')).toBe('pinned harness source\n');
      expect(git(f.src, 'status', '--porcelain', '--untracked-files=all')).toBe('');

      rmSync(f.src, { recursive: true, force: true });
      ensureHarnessSource(f.offline, () => {}, f.home);
      expect(git(f.src, 'rev-parse', 'HEAD')).toBe(f.commit);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('a pack of another commit, or one that is not a pack, is refused and the pinned commit is fetched', () => {
    const f = fixture();
    try {
      writeFileSync(join(f.upstream, 'pinned.txt'), 'a later commit\n');
      git(f.upstream, 'commit', '-q', '-am', 'later');
      for (const write of [
        () => packOf(f.upstream, [git(f.upstream, 'rev-parse', 'HEAD'), git(f.upstream, 'rev-parse', 'HEAD^{tree}'), git(f.upstream, 'rev-parse', 'HEAD:pinned.txt')], f.pack),
        () => writeFileSync(f.pack, 'not a pack'),
      ]) {
        rmSync(f.src, { recursive: true, force: true });
        execFileSync('mkdir', ['-p', join(f.home, 'packs')]);
        write();
        const logs: string[] = [];
        ensureHarnessSource(f.lock, l => logs.push(l), f.home);
        expect(logs.some(l => l.includes('refused the cached pack'))).toBe(true);
        expect(git(f.src, 'rev-parse', 'HEAD')).toBe(f.commit);
        expect(readFileSync(join(f.src, 'pinned.txt'), 'utf8')).toBe('pinned harness source\n');
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

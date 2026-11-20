/**
 * ubi-runner pack --only (GST-2280). A Q1 launch sends a VM only the tracked files under the campaign's executes paths
 * and Q1_VM_PATHS, byte for byte and without .git, instead of the whole checkout (2 GB of benchmark docs and a 1.6 GB
 * .git made each upload take hours). A listed path with no tracked files, a tracked file missing from disk, or an
 * untracked file under a listed path refuses, before any VM exists, rather than sending a tree the campaign hash does
 * not describe.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { BG1_DEV_ROOT } from '../../eval/runner/memory-qa/corpus.ts';
import { EXECUTES } from '../../eval/runner/q1/cell.ts';
import { executedTree, Q1_VM_PATHS } from '../../eval/runner/shootout-cell.ts';

const ROOT = resolve(import.meta.dir, '../..');
const RUNNER = join(ROOT, 'scripts/ubicloud/ubi-runner.sh');
const tmp = mkdtempSync(join(tmpdir(), 'ubi-pack-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const under = (paths: string[]) => (f: string) => paths.some(p => f === p || f.startsWith(`${p}/`));
const blob = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

function files(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap(e => { const p = join(dir, e); return statSync(p).isDirectory() ? files(p, base) : [relative(base, p)]; }).sort();
}

/** A checkout with code under eval/runner, a large docs directory and its .git history. */
function fixture() {
  const dir = join(tmp, `repo-${++n}`);
  for (const d of ['eval/runner/q1', 'eval/data/worlds', 'docs/benchmarks/run-1']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'eval/runner/q1/cell.ts'), 'export const cell = 1;\n');
  writeFileSync(join(dir, 'eval/runner/q1/table.bin'), randomBytes(65_536));
  writeFileSync(join(dir, 'eval/data/worlds/plan.json'), '{"world":1}\n');
  writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}\n');
  writeFileSync(join(dir, 'docs/benchmarks/run-1/rows.bin'), randomBytes(4 << 20));
  execFileSync('git', ['init', '-q', dir]);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture');
  const list = join(dir, '..', `ship-${n}.list`);
  writeFileSync(list, 'eval/runner/q1\neval/data/worlds\npackage.json\n');
  return { dir, list };
}

function pack(dir: string, list?: string) {
  const r = Bun.spawnSync(['bash', RUNNER, 'pack', ...(list ? ['--only', list] : []), dir], { stdout: 'pipe', stderr: 'pipe' });
  return { code: r.exitCode, tgz: Buffer.from(r.stdout), stderr: r.stderr.toString() };
}

function unpack(tgz: Buffer) {
  const out = join(tmp, `out-${++n}`);
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}.tgz`, tgz);
  execFileSync('tar', ['-xzf', `${out}.tgz`, '-C', out]);
  return out;
}

describe('ubi-runner pack --only', () => {
  // Value: protects=BG1 stage 2 uploads (GST-2280); fails_when=pack sends the docs tree or .git, drops or alters a listed file, or adds an unlisted one; why_new=--only replaces the whole-checkout upload for Q1 cells; seam=none; no_claim=keyless, no VM
  test('sends every tracked file under the listed paths byte for byte, and no docs directory or .git', () => {
    const { dir, list } = fixture();
    const lean = pack(dir, list);
    expect(lean.code).toBe(0);
    const out = unpack(lean.tgz);
    expect(existsSync(join(out, '.git'))).toBe(false);
    expect(existsSync(join(out, 'docs'))).toBe(false);
    const listed = git(dir, 'ls-files', '--', 'eval/runner/q1', 'eval/data/worlds', 'package.json').trim().split('\n').sort();
    expect(files(out)).toEqual(listed);
    for (const f of listed) expect(readFileSync(join(out, f)).equals(readFileSync(join(dir, f)))).toBe(true);
    const full = pack(dir);
    expect(full.code).toBe(0);
    expect(lean.tgz.length * 20).toBeLessThan(full.tgz.length);
  }, 30_000);

  // Value: protects=no silent fallback (GST-2280); fails_when=a missing, deleted or untracked file under a listed path is left out quietly or the whole tree is sent instead; why_new=--only refuses where the old pack sent everything; seam=none; no_claim=keyless
  test('refuses a listed path with no tracked files, a tracked file missing from disk, and an untracked file under a listed path', () => {
    const missing = fixture();
    writeFileSync(missing.list, 'eval/runner/q1\neval/runner/q1/gone.ts\n');
    const absent = fixture();
    rmSync(join(absent.dir, 'eval/runner/q1/cell.ts'));
    const extra = fixture();
    writeFileSync(join(extra.dir, 'eval/runner/q1/scratch.ts'), 'export const x = 1;\n');
    const results = [pack(missing.dir, missing.list), pack(absent.dir, absent.list), pack(extra.dir, extra.list)];
    expect(results.map(r => r.code)).toEqual([1, 1, 1]);
    expect(results.map(r => r.tgz.length)).toEqual([0, 0, 0]);
    expect(results[0].stderr).toContain('eval/runner/q1/gone.ts has no tracked files');
    expect(results[1].stderr).toContain('tracked files are missing');
    expect(results[1].stderr).toContain('eval/runner/q1/cell.ts');
    expect(results[2].stderr).toContain('untracked files under the listed paths');
    expect(results[2].stderr).toContain('eval/runner/q1/scratch.ts');
  }, 30_000);

  // Value: protects=a launch never creates a VM it cannot fill; fails_when=run --only reaches the Ubicloud API before the pack check; why_new=run checks --only before up; seam=none; no_claim=keyless, dead API URL
  test('run --only refuses a missing executes path before it calls the Ubicloud API', () => {
    const { dir, list } = fixture();
    writeFileSync(list, 'eval/runner/q1\neval/runner/q1/gone.ts\n');
    const bin = join(tmp, `bin-${++n}`), calls = join(tmp, `curl-${n}.log`);
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash\necho "$@" >>${calls}\nexit 7\n`, { mode: 0o755 });
    const r = Bun.spawnSync(['bash', RUNNER, 'run', '--src', dir, '--only', list, '--', 'true'], { stdout: 'pipe', stderr: 'pipe',
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, UBI_RUNNER_STATE: join(tmp, `state-${n}`), UBI_OWNER: 'test', UBICLOUD_API_KEY: 'ubi-test-placeholder', UBICLOUD_API_URL: 'http://127.0.0.1:9' } });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain('eval/runner/q1/gone.ts has no tracked files');
    expect(existsSync(calls)).toBe(false);
  }, 30_000);
});

describe('the Q1 VM file set', () => {
  // Value: protects=every Q1 VM has the code it runs (GST-2280); fails_when=a module the cell runner, launcher, proxy or dataset fetcher imports, the lockfile patch or the BG1 dev worlds fall outside executes and Q1_VM_PATHS; why_new=the VM no longer receives the whole checkout; seam=none; no_claim=static imports only (bun build metafile)
  test('every repository module the VM entry points import, the lockfile patch and the BG1 dev worlds are under executes or Q1_VM_PATHS', () => {
    const ship = under([...EXECUTES, ...Q1_VM_PATHS]);
    const out = join(tmp, `meta-${++n}`);
    const r = Bun.spawnSync([process.execPath, 'build', 'eval/runner/q1/cell.ts', 'eval/runner/shootout-cell.ts', 'eval/runner/metering-proxy.ts', 'eval/runner/decide.ts',
      '--target', 'bun', '--outdir', out, `--metafile=${out}/meta.json`], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    expect(r.exitCode).toBe(0);
    const inputs = Object.keys(JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8')).inputs).filter(k => /^(eval|docs|scripts)\//.test(k));
    expect(inputs).toContain('eval/runner/decide.ts');
    expect(inputs.filter(f => !ship(f))).toEqual([]);
    const patches = Object.values((JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { patchedDependencies?: Record<string, string> }).patchedDependencies ?? {});
    expect(patches.filter(p => !ship(p))).toEqual([]);
    expect(ship(relative(ROOT, BG1_DEV_ROOT))).toBe(true);
  }, 60_000);

  // Value: protects=the campaign hash describes what runs on the VM; fails_when=a file the campaign tree hashes arrives with other bytes or not at all, or the pack carries .git, benchmark docs, or anything outside executes and Q1_VM_PATHS, or passes 34 MB; why_new=GST-2280 size target and hash match; seam=a sparse clone of HEAD stands in for the launching checkout; no_claim=committed files only
  test('packing this repository for a Q1 cell sends exactly the files the campaign tree hashes, with the same blob ids, in under 34 MB', () => {
    const ship = [...EXECUTES, ...Q1_VM_PATHS];
    const clone = join(tmp, 'clone');
    execFileSync('git', ['clone', '-q', '--shared', '--no-checkout', ROOT, clone]);
    git(clone, 'sparse-checkout', 'set', '--no-cone', ...ship.map(p => `/${p}`));
    git(clone, 'reset', '-q', '--hard', 'HEAD');
    const list = join(tmp, 'q1.list');
    writeFileSync(list, ship.join('\n') + '\n');
    const r = pack(clone, list);
    expect(r.code).toBe(0);
    expect(r.tgz.length).toBeLessThan(34 << 20);
    const out = unpack(r.tgz);
    const got = files(out);
    expect(got.filter(f => f === '.git' || f.startsWith('.git/') || f.startsWith('docs/benchmarks/'))).toEqual([]);
    expect(got.filter(f => !under(ship)(f))).toEqual([]);
    const tree = executedTree(EXECUTES, clone);
    expect(tree.missing).toEqual([]);
    expect(tree.entries.map(e => ({ path: e.path, blob: blob(readFileSync(join(out, e.path))) }))).toEqual(tree.entries);
    expect(got.filter(under(EXECUTES))).toEqual(tree.entries.map(e => e.path).sort());
  }, 60_000);
});

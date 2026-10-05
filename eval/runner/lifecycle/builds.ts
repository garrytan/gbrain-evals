/**
 * Prepare gbrain builds as COPIED overlays and prove which code runs.
 *
 * The 2026-09-28 audit found that Bun resolves symlinked files back to their
 * real location, so a symlinked overlay silently ran the pinned dependency
 * instead of the checkout under test. Each build here is a plain directory
 * extracted with `git archive`, with its own `bun install --frozen-lockfile`.
 * The runner invokes `<copy>/src/cli.ts` by absolute path and never imports
 * gbrain into its own process.
 *
 * Identity proof, recorded in the receipt:
 * - the copy's tracked files hash to the requested commit's tree (a fresh
 *   `git write-tree` over the copy, excluding `node_modules`);
 * - no symlink exists under the copy's `src/`, and the copy path is its realpath;
 * - `gbrain --version` from the copy prints the copy's VERSION file.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface BuildSpec {
  label: string;
  /** A commit-ish, or `merge:<base>+<branch>` for an evaluation-only merge. */
  ref: string;
  description: string;
}

export interface BuildInfo {
  label: string;
  description: string;
  ref: string;
  dir: string;
  commit: string;
  tree: string;
  version: string;
  merge?: { base: string; branch: string; branch_head: string; resolved_non_runtime_conflicts: string[] };
  verified: {
    copy_tree: string;
    tree_matches: boolean;
    symlinks_under_src: number;
    dir_is_realpath: boolean;
    cli_version: string;
    cli_version_matches: boolean;
  };
}

function git(repo: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string } = {}): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: opts.env ?? process.env, input: opts.input, maxBuffer: 64 * 1024 * 1024 }).trim();
}

/**
 * Create an evaluation-only merge commit of `branch` into `base` in a scratch
 * clone. Conflicts outside runtime code (anything not under `src/`) are
 * resolved to the base side; those are version stamps, changelogs and lint
 * limits. A conflict under `src/` aborts, because resolving it would mean
 * writing code the PRs do not contain.
 */
function makeMerge(repo: string, base: string, branch: string, scratch: string): { commit: string; branchHead: string; resolved: string[] } {
  const clone = join(scratch, 'merge-clone');
  rmSync(clone, { recursive: true, force: true });
  execFileSync('git', ['clone', '-q', '--no-checkout', repo, clone]);
  const baseCommit = git(repo, ['rev-parse', `${base}^{commit}`]);
  const branchHead = git(repo, ['rev-parse', `${branch}^{commit}`]);
  git(clone, ['checkout', '-q', '--detach', baseCommit]);
  const env = { ...process.env, GIT_AUTHOR_DATE: '2026-09-29T00:00:00Z', GIT_COMMITTER_DATE: '2026-09-29T00:00:00Z' };
  const merge = spawnSync('git', ['-C', clone, '-c', 'user.name=lifecycle-eval', '-c', 'user.email=lifecycle-eval@example.invalid', 'merge', '--no-edit', '-q', branchHead], { encoding: 'utf8', env });
  const resolved: string[] = [];
  if (merge.status !== 0) {
    const conflicted = git(clone, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
    const runtime = conflicted.filter(f => f.startsWith('src/'));
    if (runtime.length) throw new Error(`merge ${branch} into ${base} conflicts in runtime code: ${runtime.join(', ')}`);
    for (const f of conflicted) { git(clone, ['checkout', '--ours', '--', f]); resolved.push(f); }
    git(clone, ['add', '-A']);
    git(clone, ['-c', 'user.name=lifecycle-eval', '-c', 'user.email=lifecycle-eval@example.invalid', 'commit', '-q', '--no-edit'], { env });
  }
  const commit = git(clone, ['rev-parse', 'HEAD']);
  // Make the merge commit reachable from the source repo for archiving.
  git(repo, ['fetch', '-q', clone, `${commit}:refs/lifecycle-eval/merge-${commit.slice(0, 12)}`]);
  return { commit, branchHead, resolved };
}

export function countSymlinks(dir: string): number {
  const out = spawnSync('find', [dir, '-type', 'l'], { encoding: 'utf8' });
  return out.stdout.split('\n').filter(Boolean).length;
}

function copyTree(repo: string, dir: string): string {
  const index = join(mkdtempSync(join(tmpdir(), 'lc-index-')), 'index');
  const env = { ...process.env, GIT_INDEX_FILE: index, GIT_WORK_TREE: dir };
  execFileSync('git', ['--git-dir', join(repo, '.git'), 'add', '-A', '-f', '--', '.', ':!node_modules', ':!.lifecycle-build.json'], { env, cwd: dir });
  return execFileSync('git', ['--git-dir', join(repo, '.git'), 'write-tree'], { env, cwd: dir, encoding: 'utf8' }).trim();
}

export function prepareBuild(repo: string, spec: BuildSpec, root: string, opts: { reinstall?: boolean } = {}): BuildInfo {
  mkdirSync(root, { recursive: true });
  let commit: string;
  let merge: BuildInfo['merge'];
  if (spec.ref.startsWith('merge:')) {
    const [base, branch] = spec.ref.slice('merge:'.length).split('+');
    const m = makeMerge(repo, base, branch, root);
    commit = m.commit;
    merge = { base: git(repo, ['rev-parse', `${base}^{commit}`]), branch, branch_head: m.branchHead, resolved_non_runtime_conflicts: m.resolved };
  } else {
    commit = git(repo, ['rev-parse', `${spec.ref}^{commit}`]);
  }
  const tree = git(repo, ['rev-parse', `${commit}^{tree}`]);
  const dir = join(root, spec.label);
  const stamp = join(dir, '.lifecycle-build.json');
  const fresh = !existsSync(stamp) || JSON.parse(readFileSync(stamp, 'utf8')).tree !== tree || opts.reinstall;
  if (fresh) {
    // Build in a private directory and move it into place, so concurrent processes preparing the same overlay
    // (parallel shards or arms) never extract over each other; the first finished build wins.
    const tmp = `${dir}.build-${process.pid}-${Date.now()}`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    execFileSync('bash', ['-c', `git -C "${repo}" archive ${commit} | tar -x -C "${tmp}" 2>/dev/null`], { maxBuffer: 64 * 1024 * 1024 });
    execFileSync('bun', ['install', '--frozen-lockfile'], { cwd: tmp, stdio: 'ignore' });
    writeFileSync(join(tmp, '.lifecycle-build.json'), JSON.stringify({ commit, tree }) + '\n');
    const current = existsSync(stamp) && JSON.parse(readFileSync(stamp, 'utf8')).tree === tree && !opts.reinstall;
    if (current) rmSync(tmp, { recursive: true, force: true });
    else {
      rmSync(dir, { recursive: true, force: true });
      try { renameSync(tmp, dir); } catch { rmSync(tmp, { recursive: true, force: true }); if (!existsSync(stamp)) throw new Error(`overlay build for ${commit} did not land at ${dir}`); }
    }
  }
  const version = readFileSync(join(dir, 'VERSION'), 'utf8').trim();
  const cli = spawnSync('bun', [join(dir, 'src/cli.ts'), '--version'], { encoding: 'utf8', env: { ...process.env, GBRAIN_SKIP_STARTUP_HOOKS: '1' } });
  const cliVersion = (cli.stdout || '').trim().replace(/^gbrain\s+/, '');
  const copy = copyTree(repo, dir);
  return {
    label: spec.label,
    description: spec.description,
    ref: spec.ref,
    dir,
    commit,
    tree,
    version,
    ...(merge ? { merge } : {}),
    verified: {
      copy_tree: copy,
      tree_matches: copy === tree,
      symlinks_under_src: countSymlinks(join(dir, 'src')),
      dir_is_realpath: realpathSync(dir) === dir,
      cli_version: cliVersion,
      cli_version_matches: cliVersion === version,
    },
  };
}

export function assertBuildVerified(b: BuildInfo): void {
  const v = b.verified;
  const problems: string[] = [];
  if (!v.tree_matches) problems.push(`copied files hash to tree ${v.copy_tree}, expected ${b.tree}`);
  if (v.symlinks_under_src) problems.push(`${v.symlinks_under_src} symlink(s) under src/`);
  if (!v.dir_is_realpath) problems.push('build directory is reached through a symlink');
  if (!v.cli_version_matches) problems.push(`gbrain --version printed "${v.cli_version}", VERSION says ${b.version}`);
  if (problems.length) {
    throw new Error(`Refusing to run build ${b.label} (${b.commit.slice(0, 9)}): ${problems.join('; ')}. Delete ${b.dir} and rerun to re-extract the copy.`);
  }
}

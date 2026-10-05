/**
 * Make a local, never-pushed variant commit of a gbrain checkout: `<ref>` with
 * one named patch applied, for an arm such as "the delta build with the
 * NOT_EMPLOYMENT_ROLE guard removed" (P5 delta H10).
 *
 *   bun eval/runner/lifecycle/make-variant-build.ts --checkout ../gbrain --ref 0a967e5d5 \
 *     --patch eval/data/p5-delta/no-not-employment-role-guard.patch --name no-guard
 *
 * The patch is applied to a scratch index (`git apply --cached` with its own
 * GIT_INDEX_FILE), so the checkout's working tree, index and branches are
 * untouched. The commit is created with `git commit-tree` under the
 * machine's git identity and kept from garbage collection by a local ref
 * `refs/eval-variants/<name>/<base sha>`, which no branch push sends. A rerun
 * with the same base and patch reuses the existing commit when its tree and
 * parent match. Prints the variant SHA and the `--gbrain <checkout>@<sha>`
 * spec runners take; `--json` prints the same as JSON.
 *
 * Never push the variant: it exists only to be measured.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export interface VariantBuild { checkout: string; base: string; patch: string; patch_sha256: string; name: string; ref: string; sha: string; tree: string; reused: boolean; gbrain_spec: string }

function git(checkout: string, args: string[], env?: Record<string, string>): string {
  return execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function makeVariantBuild(opts: { checkout: string; ref: string; patch: string; name: string }): VariantBuild {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(opts.name)) throw new Error(`--name ${JSON.stringify(opts.name)}: use letters, digits, '.', '_' or '-'`);
  const checkout = resolve(opts.checkout);
  const patch = resolve(opts.patch);
  const patchBytes = readFileSync(patch);
  const patchSha = createHash('sha256').update(patchBytes).digest('hex');
  const base = git(checkout, ['rev-parse', `${opts.ref}^{commit}`]);
  const scratch = mkdtempSync(join(tmpdir(), 'variant-build-'));
  const env = { GIT_INDEX_FILE: join(scratch, 'index') };
  let tree: string;
  try {
    git(checkout, ['read-tree', base], env);
    try {
      git(checkout, ['apply', '--cached', '--check', patch], env);
    } catch (e) {
      throw new Error(`${opts.patch} does not apply to ${base.slice(0, 12)} (${opts.ref}): ${e instanceof Error ? e.message : String(e)}. Regenerate the patch against this base or pass the base it was made for.`);
    }
    git(checkout, ['apply', '--cached', patch], env);
    tree = git(checkout, ['write-tree'], env);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (tree === git(checkout, ['rev-parse', `${base}^{tree}`])) throw new Error(`${opts.patch} changes nothing at ${base.slice(0, 12)}; the variant would equal the base`);
  const ref = `refs/eval-variants/${opts.name}/${base}`;
  let existing: string | null = null;
  try { existing = git(checkout, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); } catch { existing = null; }
  const reusable = existing && git(checkout, ['rev-parse', `${existing}^{tree}`]) === tree && git(checkout, ['rev-parse', `${existing}^`]) === base;
  const sha = reusable ? existing! : git(checkout, ['commit-tree', tree, '-p', base, '-m',
    `eval variant ${opts.name} (local only, never pushed)\n\nBase ${base}\nPatch ${opts.patch} sha256 ${patchSha}`]);
  if (!reusable) git(checkout, ['update-ref', ref, sha]);
  return { checkout, base, patch: opts.patch, patch_sha256: patchSha, name: opts.name, ref, sha, tree, reused: !!reusable, gbrain_spec: `${checkout}@${sha}` };
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) return argv[at + 1];
  return argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const [checkout, ref, patch, name] = ['--checkout', '--ref', '--patch', '--name'].map(f => argValue(argv, f));
  if (!checkout || !ref || !patch || !name) {
    console.error('usage: bun eval/runner/lifecycle/make-variant-build.ts --checkout <gbrain checkout> --ref <commit-ish> --patch <file> --name <label> [--json]');
    process.exit(2);
  }
  try {
    const v = makeVariantBuild({ checkout, ref, patch, name });
    if (argv.includes('--json')) process.stdout.write(JSON.stringify(v, null, 2) + '\n');
    else console.log(`${v.reused ? 'reused' : 'created'} variant ${v.name}: ${v.sha} (base ${v.base.slice(0, 12)}, patch sha256 ${v.patch_sha256.slice(0, 12)}, kept by ${v.ref}; local only, never push)\n--gbrain ${v.gbrain_spec}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

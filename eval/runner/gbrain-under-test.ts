/**
 * Which gbrain a runner measures: the pinned dependency, or a COPIED overlay
 * of a local checkout.
 *
 * `--gbrain <checkout>[@<ref>]` (or GBRAIN_UNDER_TEST) extracts `<ref>`
 * (default HEAD) with `git archive` into .gbrain-overlays/ (ignored, outside every tsc and test root), runs
 * `bun install --frozen-lockfile` there and verifies the copy (lifecycle
 * builds.ts: tree hash equals the commit's tree, no symlink under src/, the
 * CLI prints the copy's VERSION). Bun resolves symlinks back to their real
 * location, so a symlinked overlay would silently measure the pin; this
 * never symlinks. Uncommitted edits in the checkout are not measured: the
 * receipt records `checkout_dirty` so that is visible.
 *
 * Runners load gbrain modules through `importGbrain`, which imports by
 * absolute path under the chosen root, so gbrain's own relative imports and
 * dependencies resolve inside that copy. Static `import type` from 'gbrain/…'
 * stays fine: types are erased.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { prepareBuild, type BuildInfo } from './lifecycle/builds.ts';
import { productIdentity, type ProductIdentity } from './receipt.ts';
import { regressionPackageHash } from './situation-recall-provenance.ts';

const REPO_ROOT = resolve(import.meta.dir, '../..');
export const OVERLAY_ROOT = join(REPO_ROOT, '.gbrain-overlays');

export interface GbrainOverlay {
  requested: string;
  checkout: string;
  ref: string;
  checkout_dirty: boolean;
  build: BuildInfo;
}

export interface GbrainUnderTest {
  /** Directory whose src/ the runner imports. */
  root: string;
  version: string;
  overlay: GbrainOverlay | null;
}

/** The `--gbrain` value from argv, else GBRAIN_UNDER_TEST, else null. */
export function gbrainSpecFrom(argv: readonly string[], env: Record<string, string | undefined> = process.env): string | null {
  const at = argv.indexOf('--gbrain');
  if (at >= 0) {
    const value = argv[at + 1];
    if (!value || value.startsWith('--')) throw new Error('--gbrain needs a checkout path, optionally <path>@<ref>');
    return value;
  }
  const inline = argv.find(a => a.startsWith('--gbrain='));
  if (inline) return inline.slice('--gbrain='.length);
  return env.GBRAIN_UNDER_TEST || null;
}

/** Split `<path>@<ref>` at the last `@` whose left side is a directory; otherwise the whole spec is a path at HEAD. */
export function parseGbrainSpec(spec: string): { checkout: string; ref: string } {
  const at = spec.lastIndexOf('@');
  if (at > 0 && existsSync(spec.slice(0, at)) && statSync(spec.slice(0, at)).isDirectory()) {
    return { checkout: resolve(spec.slice(0, at)), ref: spec.slice(at + 1) || 'HEAD' };
  }
  return { checkout: resolve(spec), ref: 'HEAD' };
}

export function resolveGbrainUnderTest(spec: string | null): GbrainUnderTest {
  if (!spec) {
    const root = join(REPO_ROOT, 'node_modules/gbrain');
    return { root, version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, overlay: null };
  }
  const { checkout, ref } = parseGbrainSpec(spec);
  const status = execFileSync('git', ['-C', checkout, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
  const label = ref.replace(/[^A-Za-z0-9._-]+/g, '_');
  const build = prepareBuild(checkout, { label, ref, description: `gbrain under test from ${checkout}` }, OVERLAY_ROOT);
  const { tree_matches, symlinks_under_src, dir_is_realpath, cli_version_matches } = build.verified;
  if (!tree_matches || symlinks_under_src !== 0 || !dir_is_realpath || !cli_version_matches) {
    throw new Error(overlayMismatchMessage({ spec, checkout, ref, dirty: status.trim() !== '', build }));
  }
  return { root: build.dir, version: build.version, overlay: { requested: spec, checkout, ref, checkout_dirty: status.trim() !== '', build } };
}

/** Problem, cause and fix for an overlay copy that does not match the commit it was asked for. */
export function overlayMismatchMessage(o: { spec: string; checkout: string; ref: string; dirty: boolean; build: Pick<BuildInfo, 'commit' | 'tree' | 'version' | 'verified'> }): string {
  const v = o.build.verified;
  const problems: string[] = [];
  if (!v.tree_matches) problems.push(`the copied tree is \`${v.copy_tree.slice(0, 12)}\`, but \`--gbrain ${o.spec}\` asked for commit \`${o.build.commit.slice(0, 12)}\` (tree \`${o.build.tree.slice(0, 12)}\`)`);
  if (v.symlinks_under_src !== 0) problems.push(`the copy has ${v.symlinks_under_src} symlinks under src/, so Bun would load files from outside the copy`);
  if (!v.dir_is_realpath) problems.push('the overlay directory is reached through a symlink, so Bun would resolve modules outside it');
  if (!v.cli_version_matches) problems.push(`the copied CLI prints ${JSON.stringify(v.cli_version)}, not the commit's VERSION ${o.build.version}`);
  const cause = o.dirty
    ? `The checkout ${o.checkout} has uncommitted changes, which a copied overlay never measures, or ${o.ref} moved while the copy was made.`
    : `The ref ${o.ref} probably moved while the copy was made, or an earlier copy in .gbrain-overlays/ is stale.`;
  return `gbrain overlay failed verification: ${problems.join('; ')}. ${cause} Commit or stash, or pass \`--gbrain <path>@<ref>\` with a fixed commit, then delete .gbrain-overlays/ and rerun.`;
}

/** Import `<root>/<subpath>`, for example `src/core/pglite-engine.ts`. */
export async function importGbrain<T = Record<string, unknown>>(gut: GbrainUnderTest, subpath: string): Promise<T> {
  return await import(join(gut.root, subpath)) as T;
}

/** The v2 receipt product block for what actually ran. */
export function productIdentityFor(gut: GbrainUnderTest): ProductIdentity {
  if (!gut.overlay) return productIdentity('gbrain');
  const pinned = productIdentity('gbrain');
  return {
    package: 'gbrain',
    declared_pin: pinned.declared_pin,
    declared_sha: pinned.declared_sha,
    version: gut.version,
    package_sha256: regressionPackageHash(gut.root),
    loaded_git_head: gut.overlay.build.commit,
  };
}

/** Receipt-friendly summary of the overlay (null for the pinned dependency). */
export function overlaySummary(gut: GbrainUnderTest): Record<string, unknown> | null {
  if (!gut.overlay) return null;
  const { requested, ref, checkout_dirty, build } = gut.overlay;
  return { requested, ref, commit: build.commit, tree: build.tree, version: build.version, checkout_dirty, verified: build.verified, copied_not_symlinked: true };
}

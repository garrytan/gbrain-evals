#!/usr/bin/env bun
/**
 * Moves the `gbrain` dependency to gbrain's newest release (CLAUDE.md, "Choose the gbrain build").
 *
 *   bun eval/runner/gbrain-pin.ts bump [--dry-run]
 *
 * The newest release is the highest `v<major>.<minor>.<patch>.<micro>` tag reachable from gbrain's master, never the
 * weekly `stable` tag or the `latest-stable` alias. The command fetches master's commits and the release tags,
 * without file contents, into a temporary repository (about 10 MB, a few seconds), so it spends no GitHub API quota.
 * Then it:
 *
 *   1. refuses with exit 2 when package.json already pins that release's commit, a later master commit or a build whose
 *      version is at least that release's;
 *   2. rewrites the `gbrain` spec in package.json to `github:garrytan/gbrain#<full sha>` and runs `bun install`, which
 *      updates bun.lock, and checks that the installed gbrain reports the tag's version (when this or the next step
 *      fails, it puts every file back and exits 1);
 *   3. rewrites the pin sentence in docs/gbrain-under-test.md, the one page that names the pin, adds that page's dated
 *      changelog entry and writes the changelog.d fragment `gbrain-v<version>.md`;
 *   4. prints the commit range and every gbrain CHANGELOG section after the old pin's version up to the new one.
 *
 * A bump pull request is those four files. The other pages link to docs/gbrain-under-test.md#the-pin instead of naming
 * the commit, and that page says which release its descriptions were last read against, so the printed changelog is
 * what to read for harness breaks and for capabilities worth describing. `--dry-run` resolves and prints the same range
 * and changelog and writes nothing. `gbrain-cues` and `gbrain-reader` are frozen pins of named experiments
 * (eval/runner/pins.ts) and never move here.
 *
 * Exit 0: bumped, or a dry run that would bump. Exit 2: refused, nothing to do. Exit 1: an error; nothing changed.
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { declaredPin } from './pins.ts';

export const GBRAIN_REPO = 'https://github.com/garrytan/gbrain.git';
const SPEC_PREFIX = 'github:garrytan/gbrain#';
const RELEASE_TAG = /^v(\d+(?:\.\d+)+)$/;
const REPO_ROOT = resolve(import.meta.dir, '../..');
export const PIN_PAGE = 'docs/gbrain-under-test.md';
const PIN_LINE = /^This repository installs gbrain v\d+(?:\.\d+)+ \(\[`[0-9a-f]{9}`\]\(https:\/\/github\.com\/garrytan\/gbrain\/tree\/[0-9a-f]{40}\)\), gbrain's newest release on \d{4}-\d{2}-\d{2}\.$/gm;
const CHANGELOG_HEADING = '\n## Changelog\n\n';

export interface PinChange {
  from: { version: string; sha: string };
  to: { version: string; sha: string };
  date: string;
  releases: number;
  commits: number;
}

/** Numeric comparison of dotted versions: negative when a sorts before b. */
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The highest release version among tag names (`v0.60.733.0` gives `0.60.733.0`), ignoring every other tag. */
export function newestRelease(tags: string[]): string | null {
  const versions = tags.flatMap(t => RELEASE_TAG.exec(t.trim())?.[1] ?? []);
  return versions.sort(compareVersions).at(-1) ?? null;
}

/** The commit a `github:garrytan/gbrain#<sha>` spec pins. */
export function specSha(spec: string): string {
  const sha = spec.startsWith(SPEC_PREFIX) ? spec.slice(SPEC_PREFIX.length) : '';
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`package.json's gbrain spec ${JSON.stringify(spec)} is not ${SPEC_PREFIX}<full sha>`);
  return sha;
}

/** package.json text with the `gbrain` dependency's spec replaced and its formatting kept. */
export function withGbrainSpec(packageJson: string, oldSpec: string, newSpec: string): string {
  const from = `"gbrain": ${JSON.stringify(oldSpec)}`;
  if (packageJson.split(from).length !== 2) throw new Error(`package.json does not hold ${from} exactly once`);
  return packageJson.replace(from, `"gbrain": ${JSON.stringify(newSpec)}`);
}

/** The CHANGELOG sections (`## [<version>] ...`) after `from` up to and including `to`, in the file's order. */
export function changelogBetween(changelog: string, from: string, to: string): { versions: string[]; text: string } {
  const versions: string[] = [];
  const kept: string[] = [];
  let keep = false;
  for (const line of changelog.split('\n')) {
    const heading = /^## \[(\d+(?:\.\d+)+)\]/.exec(line);
    if (heading) {
      keep = compareVersions(heading[1], from) > 0 && compareVersions(heading[1], to) <= 0;
      if (keep) versions.push(heading[1]);
    } else if (line.startsWith('## ')) {
      keep = false;
    }
    if (keep) kept.push(line);
  }
  return { versions, text: kept.join('\n').trimEnd() };
}

/** The line of docs/gbrain-under-test.md that names the pin. */
export function pinLine(version: string, sha: string, date: string): string {
  return `This repository installs gbrain v${version} ([\`${sha.slice(0, 9)}\`](https://github.com/garrytan/gbrain/tree/${sha})), gbrain's newest release on ${date}.`;
}

/** Throws unless the page holds exactly one pin line and one `## Changelog` heading, the two places a bump writes. */
export function checkPinPage(page: string): void {
  const lines = (page.match(PIN_LINE) ?? []).length;
  if (lines !== 1) throw new Error(`${PIN_PAGE} holds ${lines} pin lines, not 1: a line of its own reading "This repository installs gbrain v<version> ([\`<sha>\`](https://github.com/garrytan/gbrain/tree/<full sha>)), gbrain's newest release on <date>."`);
  if (page.split(CHANGELOG_HEADING).length !== 2) throw new Error(`${PIN_PAGE} does not hold one "## Changelog" heading`);
}

/** docs/gbrain-under-test.md with its pin line rewritten and a dated entry at the top of its changelog. */
export function withPinOnPage(page: string, c: PinChange): string {
  checkPinPage(page);
  const entry = [
    `### ${c.date}: Re-pin to gbrain \`${c.to.sha.slice(0, 9)}\` (v${c.to.version})`,
    '',
    `\`bun eval/runner/gbrain-pin.ts bump\` moved the pin from \`${c.from.sha.slice(0, 9)}\` (v${c.from.version}) to \`${c.to.sha.slice(0, 9)}\` (v${c.to.version}),`,
    `${c.releases} releases and ${c.commits} commits later. Only the pin line changed, and no result was rerun.`,
    '', '',
  ].join('\n');
  return page.replace(PIN_LINE, pinLine(c.to.version, c.to.sha, c.date)).replace(CHANGELOG_HEADING, CHANGELOG_HEADING + entry);
}

/** The changelog.d fragment for a bump. */
export function pinFragment(c: PinChange): string {
  return [
    `### Tests run against gbrain v${c.to.version}`,
    '',
    `- \`package.json\` and \`bun.lock\` move the \`gbrain\` dependency from v${c.from.version} (\`${c.from.sha.slice(0, 9)}\`) to v${c.to.version}`,
    `  (\`${c.to.sha.slice(0, 9)}\`), gbrain's newest release on ${c.date}, ${c.releases} releases and ${c.commits} commits later.`,
    `  [docs/gbrain-under-test.md](docs/gbrain-under-test.md#the-pin) names the new pin. No result was rerun.`,
    '',
  ].join('\n');
}

function run(cmd: string[], cwd: string): string {
  const p = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(' ')} exited ${p.exitCode}: ${p.stderr.toString().trim()}`);
  return p.stdout.toString();
}

function bump(dryRun: boolean): number {
  const packagePath = join(REPO_ROOT, 'package.json');
  const lockPath = join(REPO_ROOT, 'bun.lock');
  const pagePath = join(REPO_ROOT, PIN_PAGE);
  const packageJson = readFileSync(packagePath, 'utf8');
  const page = readFileSync(pagePath, 'utf8');
  const oldSpec = declaredPin('gbrain', REPO_ROOT);
  const oldSha = specSha(oldSpec);
  checkPinPage(page);

  const scratch = mkdtempSync(join(tmpdir(), 'gbrain-pin-'));
  try {
    const git = (...args: string[]) => run(['git', '-C', scratch, ...args], scratch).trim();
    const isAncestor = (a: string, b: string) => Bun.spawnSync(['git', '-C', scratch, 'merge-base', '--is-ancestor', a, b]).exitCode === 0;
    git('init', '--quiet', '--bare');
    git('fetch', '--quiet', '--filter=tree:0', '--no-tags', GBRAIN_REPO,
      '+refs/heads/master:refs/heads/master', '+refs/tags/v*:refs/tags/v*');
    if (Bun.spawnSync(['git', '-C', scratch, 'cat-file', '-e', `${oldSha}^{commit}`]).exitCode !== 0) {
      git('fetch', '--quiet', '--filter=tree:0', '--no-tags', GBRAIN_REPO, oldSha);
    }
    const newVersion = newestRelease(git('tag', '--merged', 'master').split('\n'));
    if (!newVersion) throw new Error('no release tag is reachable from gbrain master');
    const newSha = git('rev-parse', `v${newVersion}^{commit}`);
    const oldVersion = JSON.parse(git('show', `${oldSha}:package.json`)).version as string;
    const short = (sha: string) => sha.slice(0, 9);

    if (oldSha === newSha || isAncestor(newSha, oldSha) || compareVersions(newVersion, oldVersion) <= 0) {
      console.log(`GBRAIN_PIN_CURRENT: package.json pins gbrain ${short(oldSha)} (v${oldVersion}) and the newest release is v${newVersion} (${short(newSha)}), so there is nothing to bump.`);
      return 2;
    }

    const commits = git('rev-list', '--count', `${oldSha}..${newSha}`);
    const log = changelogBetween(git('show', `${newSha}:CHANGELOG.md`), oldVersion, newVersion);
    const date = new Date().toISOString().slice(0, 10);
    const change: PinChange = { from: { version: oldVersion, sha: oldSha }, to: { version: newVersion, sha: newSha }, date, releases: log.versions.length, commits: Number(commits) };
    const fragmentPath = join(REPO_ROOT, 'changelog.d', `gbrain-v${newVersion}.md`);

    if (!dryRun) {
      if (existsSync(fragmentPath)) throw new Error(`${fragmentPath} already exists`);
      const newSpec = `${SPEC_PREFIX}${newSha}`;
      const backup = mkdtempSync(join(tmpdir(), 'gbrain-pin-backup-'));
      copyFileSync(packagePath, join(backup, 'package.json'));
      copyFileSync(lockPath, join(backup, 'bun.lock'));
      try {
        writeFileSync(packagePath, withGbrainSpec(packageJson, oldSpec, newSpec));
        run(['bun', 'install'], REPO_ROOT);
        if (!readFileSync(lockPath, 'utf8').includes(`"gbrain": ${JSON.stringify(newSpec)}`)) throw new Error('bun.lock does not name the new spec');
        const installed = JSON.parse(readFileSync(join(REPO_ROOT, 'node_modules/gbrain/package.json'), 'utf8')).version;
        if (installed !== newVersion) throw new Error(`node_modules/gbrain reports ${installed}, not ${newVersion}`);
        writeFileSync(pagePath, withPinOnPage(page, change));
        writeFileSync(fragmentPath, pinFragment(change));
      } catch (e) {
        copyFileSync(join(backup, 'package.json'), packagePath);
        copyFileSync(join(backup, 'bun.lock'), lockPath);
        writeFileSync(pagePath, page);
        rmSync(fragmentPath, { force: true });
        const restore = Bun.spawnSync(['bun', 'install'], { cwd: REPO_ROOT });
        if (restore.exitCode !== 0) throw new Error(`${(e as Error).message}; restoring node_modules with bun install also failed (exit ${restore.exitCode}), so run bun install`);
        throw e;
      } finally {
        rmSync(backup, { recursive: true, force: true });
      }
    }

    console.log(`${dryRun ? 'GBRAIN_PIN_WOULD_BUMP' : 'GBRAIN_PIN_BUMPED'}: v${oldVersion} (${short(oldSha)}) -> v${newVersion} (${short(newSha)})`);
    console.log(`Commit range: garrytan/gbrain ${short(oldSha)}..${short(newSha)}, ${commits} commits, ${log.versions.length} releases${isAncestor(oldSha, newSha) ? '' : ' (the old pin is not an ancestor of the new release)'}`);
    console.log(`Compare: https://github.com/garrytan/gbrain/compare/${oldSha}...${newSha}`);
    if (!dryRun) console.log(`Updated package.json, bun.lock, ${PIN_PAGE} and changelog.d/gbrain-v${newVersion}.md. Read the changelog below for changes that break the harness, and describe new capabilities on ${PIN_PAGE} by hand when they matter.`);
    console.log(`\n--- gbrain CHANGELOG after v${oldVersion} through v${newVersion} ---\n`);
    console.log(log.text);
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [command, ...flags] = process.argv.slice(2);
  if (command !== 'bump' || flags.some(f => f !== '--dry-run')) {
    console.error('usage: bun eval/runner/gbrain-pin.ts bump [--dry-run]');
    process.exit(1);
  }
  try {
    process.exit(bump(flags.includes('--dry-run')));
  } catch (e) {
    console.error(`GBRAIN_PIN_ERROR: ${(e as Error).message}`);
    process.exit(1);
  }
}

/**
 * Test brain for the refresh-barrier validation (docs/benchmarks/2026-11-06-refresh-barrier-preregistration.md).
 *
 * A synthetic, file-backed brain shaped like gbrain's own refresh fixture (test/helpers/worktree-refresh-fixture.ts at
 * the gbrain commit under test): a bare upstream repository, a pushing clone that plays "another machine", and a managed
 * clone whose alpha/ and beta/ directories are two sources bound to one canonical worktree. Every page is invented
 * (people/*-example, notes/*); nothing comes from a real brain.
 *
 * Only gbrain's own source modules are called (registerLocalWriter, claimWorktree, performManagedSync), loaded from the
 * gbrain root under test, so the fixture follows whichever commit the run measures.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Environment names that may hold a provider key or secret: never passed to a trial process. */
export const PROVIDER_KEYS = /(_API_KEY|_API_TOKEN|_SECRET|ANTHROPIC|OPENAI|VOYAGE|GEMINI|PARTICLE|UBICLOUD)/;
export const GIT_IDENTITY = { name: 'Example', email: 'example@example.invalid' };

/**
 * A trial-local Git config: a fixed identity and no host config (no system file, no hooks, signing or credential helper),
 * so a trial on this machine behaves as on a fresh VM. Sets it on this process and returns the entries for child processes.
 */
export function hermeticGit(dir: string): Record<string, string> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'gitconfig');
  writeFileSync(path, `[user]\n\tname = ${GIT_IDENTITY.name}\n\temail = ${GIT_IDENTITY.email}\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n[core]\n\thooksPath = /dev/null\n`);
  const env = { GIT_CONFIG_GLOBAL: path, GIT_CONFIG_NOSYSTEM: '1' };
  Object.assign(process.env, env);
  return env;
}

export const SOURCES = ['alpha', 'beta'] as const;
export type SourceKey = typeof SOURCES[number];
export const PEOPLE = ['alice', 'bruno', 'chen', 'dara', 'eli', 'farah', 'gus', 'hana'].map(n => `people/${n}-example`);
export const NOTES = Array.from({ length: 8 }, (_, i) => `notes/topic-${i + 1}`);
export const SEED_SLUGS = [...PEOPLE, ...NOTES];

export const personPage = (slug: string, line = '') => {
  const name = slug.split('/')[1]!.replace('-example', '');
  return `---\ntype: person\ntitle: ${name[0]!.toUpperCase()}${name.slice(1)} Example\n---\n\n${name[0]!.toUpperCase()}${name.slice(1)} is a fictional person used by the refresh-barrier eval.${line ? `\n\n${line}` : ''}\n`;
};
/** Pages are written in gbrain's own rendering (type before title, a blank line after the frontmatter), so gbrain's first write to a seed page changes only its end. */
export const notePage = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n\n${body}\n`;
export const seedPage = (slug: string) => slug.startsWith('people/') ? personPage(slug) : notePage(`Topic ${slug.split('-').pop()}`, `Seed note for ${slug}.`);

export function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function commitFile(root: string, path: string, content: string, message = `update ${path}`): string {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
  git(root, 'add', '--', path); git(root, 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
}

export interface BrainPaths { dir: string; home: string; remote: string; upstream: string; root: string }
export interface BrainIds { alpha: string; beta: string; worktreeId: string }

export function brainPaths(dir: string): BrainPaths {
  return { dir, home: join(dir, 'home'), remote: join(dir, 'origin.git'), upstream: join(dir, 'upstream'), root: join(dir, 'brain') };
}

/** Creates the git side: bare upstream seeded with every page under alpha/ and beta/, a pushing clone and the managed clone. */
export function createRepos(p: BrainPaths): void {
  mkdirSync(p.home, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', p.remote]);
  execFileSync('git', ['clone', '-q', p.remote, p.upstream], { stdio: 'ignore' });
  setIdentity(p.upstream);
  git(p.upstream, 'checkout', '-q', '-b', 'main');
  for (const src of SOURCES) for (const slug of SEED_SLUGS) {
    mkdirSync(join(p.upstream, src, slug, '..'), { recursive: true });
    writeFileSync(join(p.upstream, src, `${slug}.md`), seedPage(slug));
  }
  git(p.upstream, 'add', '-A'); git(p.upstream, 'commit', '-qm', 'seed');
  git(p.upstream, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', p.remote, p.root], { stdio: 'ignore' });
  setIdentity(p.root);
}

/** gbrain's effect commit uses the checkout's own identity, so each clone carries the fixed one in its local config. */
function setIdentity(root: string): void {
  execFileSync('git', ['-C', root, 'config', 'user.name', GIT_IDENTITY.name]);
  execFileSync('git', ['-C', root, 'config', 'user.email', GIT_IDENTITY.email]);
}

/**
 * Inserts a line at the top of a page body, right after its frontmatter, or creates the page when it does not exist.
 * gbrain's own writes land at the end of a page (an appended update, the facts fence), so another machine's line at the
 * top merges cleanly with them: the trial exercises a refresh that changes a page a deferred write targets, not a
 * same-line Git conflict (`integrate_conflict`, a separate convergence path this eval does not measure).
 */
export function insertTopLine(root: string, path: string, line: string, create: () => string): void {
  const file = join(root, path);
  mkdirSync(join(file, '..'), { recursive: true });
  if (!existsSync(file)) { writeFileSync(file, create()); return; }
  const text = readFileSync(file, 'utf8');
  const end = text.startsWith('---\n') ? text.indexOf('\n---\n', 3) : -1;
  const at = end < 0 ? 0 : end + 5 + (text.startsWith('\n', end + 5) ? 1 : 0);
  writeFileSync(file, `${text.slice(0, at)}${line}\n\n${text.slice(at)}`);
}

/**
 * Another machine's write: from the newest upstream commit it adds one line to the top of each named page (or creates it), commits
 * and pushes, starting again from the newest upstream commit when the push loses a race with gbrain's own push.
 */
export function pushUpstream(p: BrainPaths, edits: Array<{ path: string; line: string; create: () => string }>, message: string): string {
  for (let attempt = 0; ; attempt++) {
    git(p.upstream, 'fetch', '-q', 'origin', 'main'); git(p.upstream, 'reset', '-q', '--hard', 'origin/main');
    for (const e of edits) insertTopLine(p.upstream, e.path, e.line, e.create);
    git(p.upstream, 'add', '-A'); git(p.upstream, 'commit', '-qm', message);
    try { git(p.upstream, 'push', '-q', 'origin', 'main'); return git(p.upstream, 'rev-parse', 'HEAD'); }
    catch (error) { if (attempt >= 10) throw error; }
  }
}

/** Each harness file's sha256; every receipt carries it, and every result carries its digest (harnessDigest). */
export function harnessFiles(): Record<string, string> {
  const dir = import.meta.dir;
  return Object.fromEntries(readdirSync(dir).filter(f => f.endsWith('.ts')).sort().map(f => [f, createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')]));
}
export const harnessDigest = (): string => createHash('sha256').update(JSON.stringify(harnessFiles())).digest('hex');
/** Whether a block directory holds a counted run (a run.ts start event that was not --dry). */
export const countedRunIn = (out: string): boolean => existsSync(out) && readdirSync(out).filter(f => /^run-.*\.jsonl$/.test(f)).sort()
  .some(f => readFileSync(join(out, f), 'utf8').split('\n').filter(Boolean).some(l => { const e = JSON.parse(l); return e.ev === 'start' && e.dry === false; }));
export const gitHead = (root: string): string => execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

type Mod = Record<string, any>;
export interface GbrainModules {
  identity: Mod; ownership: Mod; syncRun: Mod; service: Mod; refresh: Mod; dispatch: Mod; switches: Mod; journal: Mod; pageMutations: Mod;
}

export async function loadGbrain(root: string): Promise<GbrainModules> {
  const m = (sub: string) => import(join(root, sub)) as Promise<Mod>;
  const [identity, ownership, syncRun, service, refresh, dispatch, switches, journal, pageMutations] = await Promise.all([
    m('src/core/persistence/identity.ts'), m('src/core/persistence/ownership.ts'), m('src/core/persistence/sync-run.ts'),
    m('src/core/persistence/service.ts'), m('src/core/persistence/worktree-refresh.ts'), m('src/mcp/dispatch.ts'),
    m('src/core/persistence/switches.ts'), m('src/core/persistence/journal.ts'), m('src/core/persistence/page-mutations.ts')]);
  return { identity, ownership, syncRun, service, refresh, dispatch, switches, journal, pageMutations };
}

/** Registers the sources on the managed clone, claims the shared worktree on this host and runs the first managed sync. */
export async function registerBrain(g: GbrainModules, engine: any, p: BrainPaths): Promise<BrainIds> {
  const tag = randomUUID().replace(/-/g, '').slice(0, 8);
  const ids = { alpha: `alpha-${tag}`, beta: `beta-${tag}` };
  await g.identity.registerLocalWriter(engine, 'cli');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  for (const src of SOURCES) {
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)',
      [ids[src], join(p.root, src), JSON.stringify({ remote_url: p.remote })]);
    await g.ownership.claimWorktree(engine, ids[src], join(p.root, src));
  }
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  for (const src of SOURCES) await g.syncRun.performManagedSync(engine, { sourceId: ids[src], noPull: true, noEmbed: true });
  const worktreeId = (await g.ownership.getWorktreeBinding(engine, ids.alpha)).worktree_id as string;
  // Git durability on, as on a production brain: the persistence owner commits every page write and pushes it to the
  // tracking remote. This is the setting `gbrain sources writer git-durability <source> --enable` records on the binding.
  await engine.executeRaw("UPDATE persistence_host_bindings SET git_durability='enabled' WHERE worktree_id=$1::uuid", [worktreeId]);
  return { ...ids, worktreeId };
}

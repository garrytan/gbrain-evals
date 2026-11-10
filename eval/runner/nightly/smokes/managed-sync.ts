/**
 * managed-sync: a managed brain synced against a bare Git remote keeps hub index.md files as scaffolding, and a page
 * delete whose first push fails still reaches the remote.
 *
 * Hubs: from v0.60.337.0 sync imports a nested index.md or README.md that has type: or title:. A hub whose own slug:
 * line names its folder, or only its leaf, could then only be held as frontmatter_slug_conflict, one hold per hub
 * (#7341). v0.60.401.0 made such files scaffolding again. The seeded brain has 30 of them. They arrive in a commit after
 * the first sync, with the slug auto-remove lane (sync.slug_conflicts.auto_remove, on by default since v0.60.277.0)
 * turned off: that lane rewrites a held hub without its slug: line and clears the hold within the same sync, which
 * would hide the hold. A hub whose bytes gbrain changed fails as well, so a rewrite under any setting is caught.
 *
 * Delete: with Git durability on, a page delete whose first push failed left its removal commit local-only. The retry
 * found nothing to commit and completed without pushing, while writer status reported nothing pending (#7089, broken
 * at v0.60.317.0, fixed in v0.60.318.0). A pre-receive hook in the bare remote refuses exactly one push and counts every
 * attempt; a one-shot CLI only queues the Git effect, so a running gbrain serve runs it and its retry.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateBrain, writeBrain } from './brain.ts';
import { check, fail, git, jsonOut, seedBrain, serveHttp, tail, type SmokeContext } from './harness.ts';

const SEED = 1;
/** How long a running serve may take to run the delete's Git effect and make the push the hook refuses. */
const FIRST_PUSH_MS = 120_000;
/**
 * gbrain requeues a Git effect whose push failed about 30 s later. The smoke decides on states (the remote's tree, the
 * effect left pending, the push count); this bound only stops a retry that never comes from hanging the smoke.
 */
const RETRY_MS = 240_000;
const POLL_MS = 2_000;

export async function managedSync(ctx: SmokeContext): Promise<string> {
  const root = ctx.tonightRoot;
  const hubs = generateBrain(SEED).pages.filter(p => p.kind === 'hub').map(p => p.path);
  // The bare remote is a local path, and gbrain refuses Git's file transport unless this documented switch is set.
  const b = await seedBrain(ctx, root, { seed: SEED, remote: true, filter: path => !hubs.includes(path), env: { GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' } });
  const remote = b.remote!;

  const off = await b.cli(root, ['config', 'set', 'sync.slug_conflicts.auto_remove', 'false']);
  if (off.code !== 0) ctx.log(`sync.slug_conflicts.auto_remove could not be turned off (exit ${off.code}); the hub bytes check still catches a rewrite`);
  writeBrain(b.repo, b.seed, path => hubs.includes(path));
  b.git('add', '-A'); b.git('commit', '-qm', 'add hub index files'); b.git('push', '-q');
  const sync = await b.cli(root, ['sync', '--source', b.source, '--no-pull'], { timeoutMs: 600_000 });
  const holds = jsonOut<{ items?: Array<{ key: string; code: string }> }>(await b.cli(root, ['sources', 'retry-held', b.source, '--dry-run', '--json']));
  check(Array.isArray(holds?.items), 'holds_unreadable', 'sources retry-held --dry-run --json printed no items array');
  const held = holds!.items!.filter(item => hubs.includes(item.key));
  check(!held.length, 'hub_index_held', () => `sync held ${held.length} of ${hubs.length} hub index.md files that carry their own slug: line: `
    + held.slice(0, 3).map(item => `${item.key} (${item.code})`).join(', '));
  check(sync.code === 0, 'hub_sync_failed', () => `gbrain sync exited ${sync.code} after the hub commit: ${tail(sync.stdout + '\n' + sync.stderr, 4)}`);
  const rewritten = hubs.filter(path => !existsSync(join(b.repo, path)) || readFileSync(join(b.repo, path), 'utf8') !== b.seed.files.get(path));
  check(!rewritten.length, 'hub_index_rewritten', () => `gbrain changed ${rewritten.length} of ${hubs.length} hub index.md files in the checkout, for example ${rewritten[0]}`);

  const status = jsonOut<{ admin_state?: string }>(await b.cli(root, ['sources', 'writer', 'status', b.source, '--json']));
  check(typeof status?.admin_state === 'string', 'writer_status_unreadable', 'sources writer status --json printed no admin_state');
  const enable = await b.cli(root, ['sources', 'writer', 'git-durability', b.source, '--enable', '--admin-intent', 'writer_git_durability',
    '--expected-state', status!.admin_state!, '--json']);
  check(enable.code === 0, 'git_durability_not_enabled', () => `sources writer git-durability --enable exited ${enable.code}: ${tail(enable.stdout + '\n' + enable.stderr, 4)}`);

  const target = b.seed.pages.find(p => p.kind === 'note')!;
  const file = `${target.slug}.md`;
  // The hook refuses the first push whose main no longer has the file, so the refused push is the one carrying the delete.
  const attempts = join(ctx.work, 'push-attempts.log'), refuse = join(ctx.work, 'refuse-delete-push'), hooks = join(ctx.work, 'remote-hooks');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'pre-receive'), ['#!/bin/sh', `echo attempt >> '${attempts}'`, 'while read old new ref; do',
    `  if [ -f '${refuse}' ] && ! git cat-file -e "$new:${file}" 2>/dev/null; then rm -f '${refuse}'; echo 'smoke: refusing the delete push once' >&2; exit 1; fi`,
    'done', 'exit 0', ''].join('\n'));
  chmodSync(join(hooks, 'pre-receive'), 0o755);
  // The bare remote's own config wins over the hermetic global config, whose hooksPath is /dev/null.
  git(remote, b.dirs, 'config', 'core.hooksPath', hooks);
  writeFileSync(refuse, '');
  const pushes = () => existsSync(attempts) ? readFileSync(attempts, 'utf8').split('\n').filter(Boolean).length : 0;

  const onRemote = () => { try { git(remote, b.dirs, 'cat-file', '-e', `main:${file}`); return true; } catch { return false; } };
  const page = jsonOut<{ revision?: string }>(await b.cli(root, ['get', target.slug, '--source', b.source, '--json']));
  check(typeof page?.revision === 'string', 'delete_target_unreadable', `gbrain get ${target.slug} --json printed no revision`);
  const del = await b.cli(root, ['delete', target.slug, '--source-id', b.source, '--expected-revision', page!.revision!, '--json']);
  check(del.code === 0, 'delete_failed', () => `gbrain delete ${target.slug} exited ${del.code}: ${tail(del.stdout + '\n' + del.stderr, 4)}`);

  const server = await serveHttp(root, { env: b.env, cwd: join(b.repo, '..'), log: ctx.log });
  try {
    for (const until = Date.now() + FIRST_PUSH_MS; existsSync(refuse) && Date.now() < until;) await Bun.sleep(POLL_MS);
    check(!existsSync(refuse), 'delete_never_pushed', `gbrain serve pushed no commit removing ${file} within ${FIRST_PUSH_MS / 1000} s (${pushes()} push attempt(s))`);
    const until = Date.now() + RETRY_MS;
    for (;;) {
      // Effects first: an effect completes after its push, so a settled effect read before the remote cannot race it.
      const effects = jsonOut<{ effects?: Array<{ kind: string; state: string }> }>(await b.cli(root, ['sources', 'writer', 'status', b.source, '--json']))?.effects;
      if (!onRemote()) break;
      const pending = effects?.filter(e => e.kind === 'git' && e.state !== 'failed');
      if (pending && !pending.length) {
        const ahead = b.git('rev-list', '--count', '@{upstream}..HEAD');
        fail('delete_not_pushed', `the delete of ${target.slug} is still on the remote's main with no Git effect pending (${JSON.stringify(effects)}); `
          + `the checkout is ${ahead} commit(s) ahead of its upstream after ${pushes()} push attempt(s), the delete's first one refused`);
      }
      if (Date.now() > until) fail('delete_push_not_retried', `the delete of ${target.slug} is still on the remote's main ${RETRY_MS / 1000} s after its refused push; `
        + `effects ${JSON.stringify(effects)}, ${pushes()} push attempt(s)`);
      await Bun.sleep(POLL_MS);
    }
  } finally { await server.stop(); }
  return `${hubs.length} hub index.md files with their own slug: line synced unheld and unchanged; a delete whose first push was refused reached the remote `
    + `(${pushes()} push attempts)`;
}

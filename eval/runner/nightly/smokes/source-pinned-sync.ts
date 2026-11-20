/**
 * source-pinned-sync: a source pinned to slug_root_mode=source-root keeps syncing once its root is the repository root.
 *
 * A source at a subdirectory of its repository pins source-root at its first sync, so its slugs are relative to the
 * source. gbrain has no command that sets the pin, so the smoke reaches a pinned root source the way a user does: the
 * brain's files move up to the repository root with git mv, and `gbrain sources set-path` points the source there. The
 * pin stays. Up to v0.60.247.0 discovery used git-root at a repository root while the checkpoint guard compared the
 * pin, so every managed sync wrote its pages and then failed its checkpoint with revision_conflict, pointing at a
 * concurrent writer that did not exist (#6694, fixed in v0.60.248.0). Both modes give a root source the same slugs, so
 * the pages keep theirs after the move.
 */
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, jsonOut, seedBrain, tail, type SmokeContext } from './harness.ts';

const SEED = 3;
const SUBDIR = 'brain';
const ADDED = { slug: 'notes/after-the-move', token: `smk${SEED}moved` };

export async function sourcePinnedSync(ctx: SmokeContext): Promise<string> {
  const root = ctx.tonightRoot;
  // Hub index files stay out: from v0.60.337.0 to v0.60.400.0 sync holds them (the managed-sync smoke's subject).
  const b = await seedBrain(ctx, root, { seed: SEED, subdir: SUBDIR, filter: path => !path.endsWith('index.md') });
  const kept = b.seed.pages.find(p => p.kind === 'person')!;
  const before = await b.cli(root, ['get', kept.slug, '--source', b.source, '--json']);
  check(before.code === 0, 'pin_not_source_root', () => `after the first sync of a source at ${SUBDIR}/, ${kept.slug} has no page under its source-relative slug, `
    + `so the source did not pin source-root: ${tail(before.stdout + '\n' + before.stderr, 3)}`);

  for (const entry of readdirSync(join(b.repo, SUBDIR)).sort()) b.git('mv', join(SUBDIR, entry), entry);
  writeFileSync(join(b.repo, `${ADDED.slug}.md`), `---\ntype: note\ntitle: After the move\n---\n\nA note written after the brain moved to the repository root. Search token ${ADDED.token}.\n`);
  b.git('add', '-A'); b.git('commit', '-qm', 'move the brain to the repository root');
  const rebind = await b.cli(root, ['sources', 'set-path', b.source, b.repo, '--json']);
  check(rebind.code === 0, 'set_path_failed', () => `sources set-path to the repository root exited ${rebind.code}: ${tail(rebind.stdout + '\n' + rebind.stderr, 4)}`);

  const sync = await b.cli(root, ['sync', '--source', b.source, '--no-pull'], { timeoutMs: 600_000 });
  const said = sync.stdout + '\n' + sync.stderr;
  check(!(/revision_conflict/.test(said) && /checkpoint/i.test(said)), 'checkpoint_revision_conflict', () => `the first sync of the source-root pinned `
    + `source at its repository root failed its checkpoint: ${said.split('\n').filter(line => /revision_conflict|checkpoint/i.test(line)).slice(0, 3).map(line => line.trim()).join(' / ')}`);
  check(sync.code === 0, 'pinned_sync_failed', () => `gbrain sync exited ${sync.code} after the move: ${tail(said, 5)}`);
  const status = jsonOut<{ last_error?: { code?: string } | null }>(await b.cli(root, ['sync', 'status', '--source', b.source, '--json']));
  check(status !== null, 'sync_status_unreadable', 'sync status --json printed no JSON');
  check(status!.last_error == null, 'pinned_sync_not_settled', () => `sync status still reports ${JSON.stringify(status!.last_error)}`);

  const found = jsonOut<Array<{ slug?: string }>>(await b.cli(root, ['search', ADDED.token, '--json']));
  check(Array.isArray(found) && found.some(row => row.slug === ADDED.slug), 'page_not_searchable',
    () => `keyword search for ${ADDED.token} did not return ${ADDED.slug}, the page added with the move: ${JSON.stringify(found)?.slice(0, 300)}`);
  const after = await b.cli(root, ['get', kept.slug, '--source', b.source, '--json']);
  check(after.code === 0, 'slug_moved', () => `${kept.slug} lost its slug after the move: ${tail(after.stdout + '\n' + after.stderr, 3)}`);
  return `a source pinned source-root synced at its repository root with no revision_conflict; ${ADDED.slug} is searchable and ${kept.slug} kept its slug`;
}

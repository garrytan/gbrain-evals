/**
 * postgres-15: managed sync and a small burst of concurrent writes on Postgres 15 beside the current Postgres, both
 * pgvector. Before v0.60.326.0 every managed sync on a Postgres 15 brain stopped at its checkpoint with storage_error
 * (PostgreSQL 42601, syntax_error), run after run: the statement that merges sources.config used the IS JSON predicate,
 * which only Postgres 16 and newer parse (#7112, fixed with gbrain_try_jsonb, migration v263).
 *
 * On each server the smoke seeds a fresh brain (a managed first sync), checks the sync checkpoint names the checkout's
 * HEAD, syncs a commit that adds, edits and deletes pages, then runs eight writers at once (six new pages and two
 * forced writes to one existing page) and syncs again. Every check reads stored state: the checkpoint commit, page rows
 * and write-request states, never timing.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, fail, scratchDatabase, seedBrain, sql, SmokeFail, tail, type SeededBrain, type SmokeContext } from './harness.ts';

const SOURCE = 'vault';
const WRITERS = 6;

interface Server { label: string; url: string }

/** A failed sync whose output names the checkpoint write failed at its checkpoint, the #7112 shape. */
const syncFailure = (output: string) => /__managed_sync_checkpoint__/.test(output) ? 'sync_checkpoint_failed' : 'managed_sync_failed';

/** The fields of the persistence log line that says why a sync failed, else the output's last lines. */
function syncCause(output: string): string {
  const line = output.split('\n').find(l => /\b(errno|reason)=/.test(l));
  if (!line) return tail(output, 4);
  return ['phase', 'reason', 'errno', 'operation', 'slug'].map(k => line.match(new RegExp(`\\b${k}=[^\\s"]+`))?.[0]).filter(Boolean).join(' ');
}

export async function postgres15(ctx: SmokeContext): Promise<string> {
  const { pg15, current } = ctx.postgres;
  check(pg15 && current, 'harness_missing_postgres', `postgres-15 needs both servers: --pg15 ${pg15 ? 'given' : 'missing'}, --pg ${current ? 'given' : 'missing'}`);
  const servers: Server[] = [];
  for (const url of [pg15!, current!]) {
    const [{ v }] = await sql<{ v: string }>(url, 'SELECT current_setting(\'server_version_num\') AS v');
    servers.push({ label: `Postgres ${Math.floor(Number(v) / 10000)}.${Number(v) % 10000}`, url });
  }
  check(servers[0]!.label.startsWith('Postgres 15.'), 'harness_wrong_postgres', `--pg15 points at ${servers[0]!.label}`);
  // Both servers run every step, so a failure on one says what the other did.
  const outcomes: Array<{ server: Server; detail?: string; error?: SmokeFail }> = [];
  for (const server of servers) {
    try { outcomes.push({ server, detail: await onServer(ctx, server) }); }
    catch (error) {
      if (!(error instanceof SmokeFail)) throw error;
      ctx.log(`${server.label}: ${error.code}: ${error.detail}`);
      outcomes.push({ server, error });
    }
  }
  const failed = outcomes.find(o => o.error);
  if (failed) {
    const others = outcomes.filter(o => o !== failed).map(o => `${o.server.label}: ${o.error ? `also failed, ${o.error.code}` : 'passed every step'}`);
    fail(failed.error!.code, `${failed.server.label}: ${failed.error!.detail} (${others.join('; ')})`);
  }
  return outcomes.map(o => `${o.server.label}: ${o.detail}`).join('; ');
}

async function onServer(ctx: SmokeContext, server: Server): Promise<string> {
  const root = ctx.tonightRoot;
  const tag = server.label.replace(/\D+/g, '_');
  const db = await scratchDatabase(server.url, `pg15smoke${tag}`);
  try {
    let b: SeededBrain;
    try { b = await seedBrain(ctx, root, { name: `brain${tag}`, seed: 15, databaseUrl: db.url, source: SOURCE }); }
    catch (error) {
      if (!(error instanceof SmokeFail) || error.code !== 'seed_sync') throw error;
      return fail(syncFailure(error.detail), `the first managed sync exited nonzero: ${syncCause(error.detail)}`);
    }
    const live = async () => new Set((await sql<{ slug: string }>(db.url,
      'SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [SOURCE])).map(r => r.slug));
    const checkpoint = async (step: string) => {
      const head = b.git('rev-parse', 'HEAD');
      const [row] = await sql<{ last_commit: string | null }>(db.url, 'SELECT last_commit FROM sources WHERE id=$1', [SOURCE]);
      check(row?.last_commit === head, 'sync_checkpoint_not_recorded', () => `after ${step} the source's sync checkpoint is ${row?.last_commit ?? 'empty'}, not the checkout's HEAD ${head}`);
    };
    const sync = async (step: string) => {
      const r = await b.cli(root, ['sync', '--source', SOURCE, '--no-pull'], { timeoutMs: 600_000 });
      if (r.code !== 0) fail(syncFailure(r.stdout + r.stderr), `${step}: gbrain sync exited ${r.code}: ${syncCause(r.stdout + '\n' + r.stderr)}`);
      await checkpoint(step);
    };

    await checkpoint('the first sync');
    const expected = b.seed.pages.filter(p => p.kind !== 'hub').map(p => p.slug);
    const seeded = await live();
    const missing = expected.filter(s => !seeded.has(s));
    check(!missing.length, 'sync_pages_missing', () => `the first sync left ${missing.length} of ${expected.length} pages unimported, e.g. ${missing.slice(0, 3).join(', ')}`);

    // A commit that adds, edits and deletes a page: the incremental managed sync a brain runs after every commit.
    const [edited, removed] = [b.seed.pages.find(p => p.kind === 'note')!, b.seed.pages.find(p => p.kind === 'meeting')!];
    writeFileSync(join(b.repo, 'notes/pg-added.md'), '---\ntype: note\ntitle: Added on this server\n---\n\nAdded by the second sync. Search token pgadded.\n');
    writeFileSync(join(b.repo, edited.path), readFileSync(join(b.repo, edited.path), 'utf8') + '\nEdited by the second sync. Search token pgedited.\n');
    rmSync(join(b.repo, removed.path));
    b.git('add', '-A'); b.git('commit', '-qm', 'add, edit and delete a page');
    await sync('the incremental sync');
    const [after] = await sql<{ added: number; edited: number; removed: number }>(db.url,
      `SELECT count(*) FILTER (WHERE slug='notes/pg-added')::int AS added,
              count(*) FILTER (WHERE slug=$2 AND compiled_truth LIKE '%pgedited%')::int AS edited,
              count(*) FILTER (WHERE slug=$3)::int AS removed
         FROM pages WHERE source_id=$1 AND deleted_at IS NULL`, [SOURCE, edited.slug, removed.slug]);
    check(after?.added === 1 && after.edited === 1 && after.removed === 0, 'sync_change_not_applied',
      () => `the incremental sync committed but its pages are wrong: added ${after?.added}, edited ${after?.edited}, deleted page still live ${after?.removed}`);
    const before = await live();

    // Eight writers at once: six new pages and two forced writes to one existing page.
    const contended = b.seed.pages.filter(p => p.kind === 'note')[1]!;
    const body = (title: string, token: string) => `---\ntype: note\ntitle: ${title}\n---\n\nWritten concurrently. Search token ${token}.\n`;
    const writes = [
      ...Array.from({ length: WRITERS }, (_, i) => ({ slug: `notes/pg-writer-${i + 1}`, token: `pgw${i + 1}x`, force: false })),
      ...['a', 'b'].map(w => ({ slug: contended.slug, token: `pgcontended${w}`, force: true })),
    ];
    const runs = await Promise.all(writes.map(w => b.cli(root,
      ['put', w.slug, ...(w.force ? ['--force'] : []), '--wait-ms', '30000'], { input: body(`Concurrent ${w.token}`, w.token), timeoutMs: 180_000 })));
    runs.forEach((r, i) => check(r.code === 0, 'concurrent_write_failed',
      () => `put ${writes[i]!.slug}${writes[i]!.force ? ' --force' : ''} (one of ${writes.length} at once) exited ${r.code}: ${tail(r.stdout + '\n' + r.stderr, 4)}`));
    const open = await sql<{ state: string; n: number }>(db.url,
      `SELECT state, count(*)::int AS n FROM persistence_requests WHERE operation='put_page' AND state <> 'committed' GROUP BY state`);
    check(!open.length, 'concurrent_write_not_committed', () => `write requests left uncommitted after every writer exited: ${open.map(o => `${o.n} ${o.state}`).join(', ')}`);
    const rows = await sql<{ slug: string; truth: string }>(db.url,
      'SELECT slug, compiled_truth AS truth FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND slug = ANY($2)', [SOURCE, [...new Set(writes.map(w => w.slug))]]);
    for (const w of writes.filter(x => !x.force)) {
      const row = rows.filter(r => r.slug === w.slug);
      check(row.length === 1 && row[0]!.truth.includes(w.token), 'concurrent_write_lost', () => `${w.slug}: ${row.length} live rows, holding its writer's token: ${row.some(r => r.truth.includes(w.token))}`);
      const file = join(b.repo, `${w.slug}.md`);
      check(existsSync(file) && readFileSync(file, 'utf8').includes(w.token), 'concurrent_write_lost', () => `${w.slug}: its file in the checkout is missing or lacks its writer's token`);
    }
    const winner = writes.filter(w => w.force).find(w => rows.some(r => r.slug === w.slug && r.truth.includes(w.token)));
    check(winner, 'concurrent_write_lost', () => `${contended.slug} holds neither forced writer's text after both reported success`);
    const onDisk = readFileSync(join(b.repo, contended.path), 'utf8');
    check(onDisk.includes(winner!.token), 'concurrent_write_split', () => `${contended.slug}: the database holds writer ${winner!.token} but its file does not`);
    const now = await live();
    const added = [...now].filter(s => !before.has(s));
    check(now.size === before.size + WRITERS && added.length === WRITERS, 'concurrent_write_duplicated',
      () => `${WRITERS} new pages were written but the source went from ${before.size} to ${now.size} live pages (new: ${added.join(', ')})`);

    await sync('the sync after the concurrent writes');
    const final = await live();
    check(final.size === now.size, 'sync_changed_page_count', () => `the sync after the concurrent writes changed the live page count from ${now.size} to ${final.size}`);
    return `${expected.length} pages synced, checkpoint at HEAD after 3 syncs, ${writes.length} concurrent writes committed (${WRITERS} new pages, contended page kept ${winner!.token})`;
  } finally {
    await db.drop().catch(error => ctx.log(`drop failed: ${(error as Error).message}`));
  }
}

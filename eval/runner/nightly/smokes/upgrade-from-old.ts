/**
 * upgrade-from-old: a brain written by gbrain v0.52.2.0, the last release before managed persistence (from v0.53.0.0
 * every fresh `gbrain init` is managed), upgraded by tonight's gbrain the way the docs say a user upgrades:
 * `gbrain post-upgrade` (what `gbrain upgrade` runs once the new build is installed), then the claim and activation
 * runbook of docs/architecture/topologies.md, because neither the upgrade nor startup activates managed persistence on
 * an existing brain. The old brain carries the old release's own migration history (its `gbrain apply-migrations --yes`,
 * which its install's postinstall and every `gbrain upgrade` run), so tonight's upgrade does not stamp the v0.13.1
 * `validate: false` grandfather flag onto its pages; that separate file_drift cause was fixed in v0.60.417.0. The old
 * release imports every page itself, so after activation they are legacy pages: pages with no import record until
 * gbrain's bounded legacy sweep screens them. 1,500 of them hold an edit the database kept that their committed files
 * lack (the old sync read a working tree whose edits were then discarded), so no sweep can ever record them.
 *
 * (a) Legacy pages advance (#7189, fixed in v0.60.339.0). A commit made after the upgrade must become searchable while
 *     the sweep still has those pages ahead of it. Before the fix the first managed full round screened every legacy
 *     page before importing anything, and a pass stopped mid-sweep kept nothing, so on a large brain every pass ended
 *     at its deadline with 0 changes. Here each sync is interrupted with SIGINT (the graceful stop `--timeout` and
 *     Ctrl-C take) once one pass has screened more than 500 legacy pages, the point by which a fixed pass has screened
 *     its 500 and moved on to the commit. Failure: legacy_sweep_blocks_commit.
 * (b) Edits to legacy pages become searchable (#7338, fixed in v0.60.371.0). A Git edit to a legacy page the sweep has
 *     not reached must import, with no file_drift hold. Failure: legacy_edit_held_file_drift, or
 *     legacy_edit_not_searchable when nothing is held and the edit still cannot be found.
 *
 * It needs real Postgres: the stop in (a) reads the pass row a running sync rewrites after every 100 legacy pages it
 * screens, so it is decided by a page count, never by a clock.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { archiveBrain } from './brain.ts';
import { check, fail, jsonOut, rootVersion, scratchDatabase, seedBrain, sql, tail, type Run, type SeededBrain, type SmokeContext } from './harness.ts';

/** The old release this smoke is validated with (pass it as --old). */
export const OLD_RELEASE = 'v0.52.2.0';
const SEED = 21;
/** Legacy pages whose database copy differs from their file, so the sweep never records them. */
const ARCHIVE = 1500;
/** How many legacy pages a pass may screen before it imports the round's changes (v0.60.339.0 and later). */
const SWEEP_MAX = 500;
/** Sync passes (a) allows; a fixed gbrain needs one. */
const PASSES = 3;
const KEPT = 'An edit the brain kept that the file never had.';

export async function upgradeFromOld(ctx: SmokeContext): Promise<string> {
  const admin = ctx.postgres.current;
  if (!admin) return fail('harness_no_postgres', 'upgrade-from-old reads a running sync pass from the database, so it needs --pg <admin url>');
  const db = await scratchDatabase(admin, 'upgrade_old');
  try { return await upgradeAndCheck(ctx, db.url); } finally { await db.drop(); }
}

async function upgradeAndCheck(ctx: SmokeContext, url: string): Promise<string> {
  const brain = archiveBrain(SEED, ARCHIVE);
  const archive = brain.pages.filter(p => p.path.startsWith('archive/'));
  const b = await seedBrain(ctx, ctx.oldRoot, { brain, databaseUrl: url, migrate: true,
    beforeInit: repo => { for (const p of archive) appendFileSync(join(repo, p.path), `\n${KEPT}\n`); } });
  b.git('checkout', '--', '.');
  const old = rootVersion(ctx.oldRoot), T = ctx.tonightRoot;
  const oldStatus = jsonOut(await b.cli(ctx.oldRoot, ['sources', 'writer', 'status', '--json']));
  check(oldStatus?.enabled === false, 'harness_old_release_managed',
    () => `--old (${old}) must write a brain without managed persistence; its writer status reads enabled=${oldStatus?.enabled}`);
  const [kept] = await sql<{ n: number }>(url, 'SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND compiled_truth LIKE $2', [b.source, `%${KEPT}%`]);
  check(kept?.n === ARCHIVE, 'harness_kept_edits_missing', `${old} imported the kept edit on ${kept?.n} of ${ARCHIVE} archive pages, so they would not differ from their files`);

  const up = await b.cli(T, ['post-upgrade', '--no-autopilot-install'], { timeoutMs: 600_000 });
  check(up.code === 0, 'post_upgrade_failed', () => `gbrain post-upgrade exited ${up.code} on the ${old} brain: ${tail(up.stdout + '\n' + up.stderr, 6)}`);
  const [{ n: grandfathered } = { n: -1 }] = await sql<{ n: number }>(url, "SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND frontmatter ? 'validate'", [b.source]);
  check(grandfathered === 0, 'harness_old_migrations_missing', `the upgrade stamped validate: false onto ${grandfathered} pages, so ${old}'s own migrations did not run before it`);
  await activate(b, T);

  // (a) A commit made after the upgrade, waiting behind 1,800 legacy pages.
  const fresh = { path: 'notes/after-upgrade.md', slug: 'notes/after-upgrade', token: `smk${SEED}fresh` };
  writeFileSync(join(b.repo, fresh.path), `---\ntype: note\ntitle: After the upgrade\n---\n\nWritten after the upgrade. Search token ${fresh.token}.\n`);
  b.git('add', '--', fresh.path); b.git('commit', '-qm', 'a note written after the upgrade');
  const passes: Awaited<ReturnType<typeof syncPass>>[] = [];
  let found = false;
  while (!found && passes.length < PASSES) {
    const p = await syncPass(b, T, url);
    passes.push(p);
    check(p.run.code === 0 || p.interrupted, 'sync_failed', () => `gbrain sync exited ${p.run.code} with no interrupt: ${tail(p.run.stdout + '\n' + p.run.stderr, 6)}`);
    found = await searchable(b, T, fresh.token, fresh.slug);
  }
  const screened = Math.max(...passes.map(p => p.screened)), interrupted = passes.filter(p => p.interrupted).length;
  check(found, 'legacy_sweep_blocks_commit', `the commit made after the upgrade is not searchable after ${passes.length} sync passes: ${interrupted} were stopped`
    + ` after one pass screened more than ${SWEEP_MAX} legacy pages without importing it (most screened in one pass: ${screened})`);
  const unrecorded = Math.max(...passes.map(p => p.unrecorded));
  check(unrecorded >= ARCHIVE, 'harness_legacy_pages_recorded', `only ${unrecorded} legacy pages are still unrecorded, fewer than the ${ARCHIVE} that differ from their files,`
    + ' so the sweep never ran over pages it cannot record');
  const a = `(a) the commit made after the upgrade was searchable after ${passes.length} sync pass(es), no pass screening more than ${SWEEP_MAX} legacy pages first`
    + ` (most in one pass: ${screened}; ${unrecorded} legacy pages still unrecorded)`;

  // (b) A Git edit to the legacy page the sweep reaches last (archive/ sorts first).
  const target = brain.pages.filter(p => p.kind !== 'hub' && !p.path.startsWith('archive/')).sort((x, y) => x.path < y.path ? -1 : 1).at(-1)!;
  const [recorded] = await sql<{ n: number }>(url, `SELECT count(*)::int AS n FROM op_checkpoints c JOIN pages p ON p.id = (c.completed_keys->0->>'page_id')::int
    WHERE c.op = 'sync-import-provenance' AND p.source_id = $1 AND p.slug = $2`, [b.source, target.slug]);
  check(recorded?.n === 0, 'harness_legacy_page_recorded', `${target.path} already has an import record, so editing it would not test a legacy page; ${a}`);
  const edit = `smk${SEED}edited`;
  writeFileSync(join(b.repo, target.path), `${readFileSync(join(b.repo, target.path), 'utf8').trimEnd()}\n\nEdited after the upgrade. Search token ${edit}.\n`);
  b.git('add', '--', target.path); b.git('commit', '-qm', 'edit a page the old release imported');
  for (let attempt = 1; ; attempt++) {
    const s = await b.cli(T, ['sync', '--source', b.source, '--no-pull'], { timeoutMs: 600_000 });
    check(s.code === 0, 'sync_failed', () => `gbrain sync after the legacy edit exited ${s.code}: ${tail(s.stdout + '\n' + s.stderr, 6)}; ${a}`);
    const held = (await holds(b, T)).filter(h => h.path === target.path);
    check(!held.some(h => h.code === 'file_drift'), 'legacy_edit_held_file_drift',
      () => `the Git edit to legacy page ${target.path} is held file_drift (side ${held.find(h => h.code === 'file_drift')?.side ?? 'unknown'}) instead of importing; ${a}`);
    if (await searchable(b, T, edit, target.slug)) break;
    check(attempt < 2, 'legacy_edit_not_searchable', `the Git edit to legacy page ${target.path} is not searchable after 2 syncs`
      + `${held.length ? ` (held ${held.map(h => h.code).join(', ')})` : ' and nothing holds it'}; ${a}`);
  }
  return `${old} brain (${brain.pages.filter(p => p.kind !== 'hub').length} pages, ${ARCHIVE} differing from their files) upgraded and activated by ${rootVersion(T)}; ${a};`
    + ` (b) a Git edit to unrecorded legacy page ${target.path} imported with no file_drift hold and is searchable`;
}

/** The claim and activation runbook (docs/architecture/topologies.md), each step bound to a freshly read admin_state. */
async function activate(b: SeededBrain, root: string): Promise<void> {
  const status = async () => {
    const r = await b.cli(root, ['sources', 'writer', 'status', '--json']);
    const j = jsonOut(r);
    check(r.code === 0 && typeof j?.admin_state === 'string', 'writer_status_unreadable', () => `gbrain sources writer status exited ${r.code}: ${tail(r.stdout + '\n' + r.stderr, 4)}`);
    return j as { admin_state: string; enabled?: boolean };
  };
  const claim = await b.cli(root, ['sources', 'writer', 'claim', b.source, '--path', b.repo, '--admin-intent', 'writer_claim', '--expected-state', (await status()).admin_state, '--json']);
  check(claim.code === 0 && jsonOut(claim)?.claimed === true, 'activation_claim_refused', () => `gbrain sources writer claim exited ${claim.code}: ${tail(claim.stdout + '\n' + claim.stderr, 6)}`);
  const state = (await status()).admin_state;
  const preview = await b.cli(root, ['sources', 'writer', 'activate', '--confirm-quiesced', '--dry-run', '--json']);
  check(preview.code === 0, 'activation_refused', () => `gbrain sources writer activate --dry-run exited ${preview.code}: ${tail(preview.stdout + '\n' + preview.stderr, 6)}`);
  const act = await b.cli(root, ['sources', 'writer', 'activate', '--confirm-quiesced', '--admin-intent', 'writer_activate', '--expected-state', state, '--json']);
  check(act.code === 0, 'activation_refused', () => `gbrain sources writer activate exited ${act.code}: ${tail(act.stdout + '\n' + act.stderr, 6)}`);
  const after = await status();
  check(after.enabled === true, 'activation_not_enabled', `gbrain sources writer status reads enabled=${after.enabled} after activation`);
}

/**
 * One `gbrain sync`, sent SIGINT once a single pass has screened more than SWEEP_MAX legacy pages. The pass row
 * (op_checkpoints, op managed-sync-pass) is rewritten after every 100-page sweep slice with the pass's running count,
 * and a 50 ms poll is far quicker than the sweep of the 1,300 legacy pages left at that point, so the stop lands
 * mid-sweep. A fixed gbrain never reaches the count. `unrecorded` is the largest legacy_unverified class a round reported.
 */
async function syncPass(b: SeededBrain, root: string, url: string): Promise<{ run: Run; interrupted: boolean; screened: number; unrecorded: number }> {
  const { SQL } = await import('bun');
  const db = new SQL(url);
  type Telemetry = { pass_id?: string; outcome?: string; counts?: { legacy_swept?: number }; classes?: { legacy_unverified?: { count?: number } } };
  const read = async () => ((await db.unsafe(`SELECT completed_keys->0->'telemetry' AS t FROM op_checkpoints WHERE op = 'managed-sync-pass'
    AND completed_keys->0->>'source_id' = $1`, [b.source])) as Array<{ t: Telemetry | null }>)[0]?.t ?? null;
  try {
    const before = (await read())?.pass_id;
    const stop = new AbortController();
    let done = false, screened = 0, unrecorded = 0;
    const note = (t: Telemetry | null) => {
      if (!t || t.pass_id === before) return;
      const swept = Number(t.counts?.legacy_swept ?? 0);
      screened = Math.max(screened, swept);
      unrecorded = Math.max(unrecorded, Number(t.classes?.legacy_unverified?.count ?? 0));
      if (t.outcome === 'open' && swept > SWEEP_MAX && !stop.signal.aborted) stop.abort();
    };
    const pending = b.cli(root, ['sync', '--source', b.source, '--no-pull'], { timeoutMs: 600_000, interrupt: stop.signal }).finally(() => { done = true; });
    while (!done) { note(await read()); await Bun.sleep(50); }
    const run = await pending;
    note(await read());
    return { run, interrupted: stop.signal.aborted, screened, unrecorded };
  } finally { await db.close(); }
}

async function searchable(b: SeededBrain, root: string, token: string, slug: string): Promise<boolean> {
  const r = await b.cli(root, ['search', token]);
  return r.code === 0 && r.stdout.includes(slug);
}

/** The source's held files (`gbrain sources status --json`, git_holds.items). */
async function holds(b: SeededBrain, root: string): Promise<Array<{ path?: string; code?: string; side?: string }>> {
  const j = jsonOut(await b.cli(root, ['sources', 'status', b.source, '--json']));
  return (j?.sources ?? []).flatMap((s: { git_holds?: { items?: Array<{ path?: string; code?: string; side?: string }> } }) => s.git_holds?.items ?? []);
}

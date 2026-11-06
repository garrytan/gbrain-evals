/**
 * Ground truth for one refresh-barrier trial, read after the trial has quiesced: every write the schedule planned is
 * looked up in the database (its request row, facts, current pages and page history), in Git (the managed checkout's
 * HEAD and every commit's added lines) and in gbrain's commit ledger, then classified.
 *
 * Gate classes (docs/benchmarks/2026-11-06-refresh-barrier-preregistration.md, "Metric and denominator"):
 *   lost        gbrain acknowledged the write (a committed or pending answer) and it never applied: its row is missing,
 *               or committed with its marker nowhere in the database or Git history; or the client saw it committed (in
 *               any answer or poll) and its row is missing, not committed, or committed without the write applied.
 *   lost_git    committed and present in its page's current database content, but absent from the checkout's Git HEAD after
 *               every Git effect settled (a file-backed write the markdown never got). A write replaced before its commit
 *               coalesces into the replacing commit, so only what is current is checked.
 *   phantom     applied although its final receipt is not committed (a refusal or conflict that wrote anyway).
 *   duplicated  applied more than once: two request rows, two live facts, two copies of the marker at HEAD or in the
 *               current pages, or two ledger commits for one request id.
 *   stuck       a request row still not final when the trial quiesced or hit its deadline (a hang).
 *   overwritten a committed write whose marker is gone from its page's current content, removed by anything other than a
 *               blind put admitted after it. Every write in the trial keeps what it read (an update re-puts the page it
 *               read plus one line, remember adds one fact, another machine and the cron add a line at the top), so only a
 *               blind put that read the page before this write landed may legitimately drop it (last writer wins); a
 *               blind put admitted earlier that lands later breaks FIFO order (GBRA-347's finding on #8705).
 *   wrong_expiry a write expired after its hold was released: refresh_barrier_expired after its refresh's release, or
 *               pending_import_expired more than 2 s after a sync or refresh tick had completed.
 *   unindexed   committed and present in its page's current content, but keyword search for its marker returns no chunk
 *               that holds it (a write the search index never saw).
 *   unpublished committed and at the managed checkout's HEAD, but absent from the tracking remote's main after every Git
 *               effect settled and the sources converged (Git durability publishes every commit).
 *   false_refusal the writer's last answer was a non-retryable refusal and no poll reported it committed, yet it committed
 *               (an agent told "not saved" may save it again under a new request id).
 *   unexpected_outcome an outcome outside the preregistered allow-list (ALLOWED_CODES, expiry codes only where the
 *               schedule or the write's hold makes them possible, retryable refusals that a retry resolved): a refusal or
 *               final code outside it, a pending write ending failed or cancelled with another code, retries exhausted,
 *               or a call or poll that timed out. A pending write whose issuing process died must still commit (gbrain
 *               cancels a write only through an explicit cancel or admission_paused), so cancelled is never allowed.
 *   harness_error an answer the harness could not read (an OK body with no known state, an error with no code).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainIds, BrainPaths } from './fixture.ts';
import { allOps, type TrialSchedule } from './schedule.ts';

export const TERMINAL = new Set(['committed', 'conflict', 'failed', 'cancelled']);
/** Non-retryable codes that are a normal answer to this workload: a put_update whose read went stale, a source that moved. */
export const ALLOWED_CODES = new Set(['revision_conflict', 'source_changed']);

/** Whether a refusal or final code is on the allow-list for this write. */
export function allowedCode(code: string, ctx: { expiryPossible: boolean; heldForRefresh: boolean; heldForImport: boolean; final: boolean }): boolean {
  if (ALLOWED_CODES.has(code)) return true;
  if (code === 'refresh_barrier_expired') return ctx.expiryPossible && (ctx.heldForRefresh || !ctx.final);
  if (code === 'pending_import_expired') return ctx.heldForImport;
  return false;
}

export interface OpRecord {
  writer: number; op: number; kind: string; source: string; slug: string | null; marker: string; request_id: string;
  issued: boolean; attempts: number; first: string | null; first_code: string | null; first_deferred: boolean;
  first_ms: number | null; first_t: number | null; first_slip_ms: number | null;
  codes: string[]; acknowledged: boolean; client_committed: boolean; call_timeouts: number; client_final: string | null;
  rows: number; state: string | null; error_code: string | null; deferred_refresh: boolean; deferred_import: boolean;
  write_through: boolean | null;
  facts_all: number; facts_live: number; pages_occ: number; versions: number; git_head_occ: number; git_hist: number; origin_occ: number; ledger_commits: number;
  applied: boolean; landed_naive: boolean; landed_spec: boolean;
  defer_to_apply_ms: number | null; release_to_apply_ms: number | null;
  sequence: number | null; removed_by: string[] | null; overwritten_blind: boolean;
  lost: boolean; lost_git: boolean; phantom: boolean; duplicated: boolean; stuck: boolean; overwritten: boolean; wrong_expiry: boolean;
  indexed: boolean | null; unindexed: boolean; false_refusal: boolean; unpublished: boolean;
  unexpected_outcome: boolean; unexpected_reasons: string[]; harness_error: boolean;
}

const MARKER = /(?:RBM|UPM|FCM)\d+[a-z0-9]*?q/g;
const markersIn = (text: string) => new Set(text.match(MARKER) ?? []);

/**
 * Which write removed marker `m` from a page: walks the page's archived revisions (page_versions, oldest first) and its
 * current content, finds the first revision without `m` after one with it, and returns the markers that revision added.
 * Null when `m` never disappeared.
 */
export function removerOf(contents: string[], m: string): string[] | null {
  const first = contents.findIndex(c => c.includes(m));
  if (first < 0) return null;
  const drop = contents.findIndex((c, i) => i > first && !c.includes(m));
  if (drop < 0) return null;
  const before = markersIn(contents[drop - 1]!);
  return [...markersIn(contents[drop]!)].filter(x => !before.has(x));
}

/**
 * Whether a blind put removed upstream marker `m` from its file: `contents` is the file at each commit that touched it,
 * oldest first, and every marker the removing commit added must be a committed blind put. As for `overwritten`, a blind put
 * that lands after the import may drop the line (last writer wins), so the marker's absence from HEAD is no convergence fault.
 */
export function removedByBlindPut(contents: string[], m: string, committedBlindPut: (marker: string) => boolean): boolean {
  const by = removerOf(contents, m);
  return by !== null && by.length > 0 && by.every(committedBlindPut);
}

/** A file's content at each first-parent commit of HEAD that touched it, oldest first ('' at a commit that deleted it). */
export function fileHistory(root: string, path: string): string[] {
  const shas = execFileSync('git', ['-C', root, 'log', '--first-parent', '--reverse', '--format=%H', 'HEAD', '--', path], { encoding: 'utf8' }).split('\n').filter(Boolean);
  return shas.map(h => { try { return execFileSync('git', ['-C', root, 'show', `${h}:${path}`], { encoding: 'utf8', maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } });
}

export function readEvents(dir: string): Array<Record<string, any>> {
  return readdirSync(dir).sort().filter(f => f.startsWith('events-') && f.endsWith('.jsonl'))
    .flatMap(f => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)));
}

const count = (text: string, needle: string) => { let n = 0, i = 0; while ((i = text.indexOf(needle, i)) >= 0) { n++; i += needle.length; } return n; };

/** Occurrences of each marker across the .md files of `ref`'s tree in repository `repo` (a checkout or a bare remote). */
export function treeMarkers(repo: string, ref: string, markers: string[]): Map<string, number> {
  const files = execFileSync('git', ['-C', repo, 'ls-tree', '-r', '--name-only', '-z', ref], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\0').filter(f => f.endsWith('.md'));
  const show = files.length ? execFileSync('git', ['-C', repo, 'show', ...files.map(f => `${ref}:${f}`)], { encoding: 'utf8', maxBuffer: 256 << 20 }) : '';
  return new Map(markers.map(m => [m, count(show, m)]));
}

/** Per marker: occurrences across files at HEAD, and the number of commits whose diff adds a line containing it. */
export function gitMarkers(root: string, markers: string[]): { head: Map<string, number>; hist: Map<string, number> } {
  const head = treeMarkers(root, 'HEAD', markers), hist = new Map<string, number>();
  const log = execFileSync('git', ['-C', root, 'log', '--all', '-p', '--no-color', '--no-renames', '--format=@@COMMIT %H'], { encoding: 'utf8', maxBuffer: 512 << 20 });
  const perCommit = log.split('@@COMMIT ').slice(1).map(chunk => chunk.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).join('\n'));
  for (const m of markers) hist.set(m, perCommit.filter(added => added.includes(m)).length);
  return { head, hist };
}

export function ledgerCommits(root: string): Map<string, number> {
  const common = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  const out = new Map<string, number>();
  for (const name of ['commit-ledger.1.jsonl', 'commit-ledger.jsonl']) {
    const path = join(common, 'gbrain', name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let rec: Record<string, unknown>; try { rec = JSON.parse(line); } catch { continue; }
      if (rec.e !== 'commit') continue;
      const ids = Array.isArray(rec.request_ids) ? rec.request_ids : rec.request_id ? [rec.request_id] : [];
      for (const id of ids as string[]) out.set(id, (out.get(id) ?? 0) + 1);
    }
  }
  return out;
}

export async function verifyTrial(engine: any, schedule: TrialSchedule, paths: BrainPaths, ids: BrainIds, dir: string): Promise<{ ops: OpRecord[]; upstream: { pushed: number; missing_head: number; removed_by_blind_put: number }; ledger_present: boolean }> {
  const ops = allOps(schedule);
  const events = readEvents(dir);
  const byReq = new Map<string, Array<Record<string, any>>>();
  for (const e of events) if (e.request_id) (byReq.get(e.request_id) ?? byReq.set(e.request_id, []).get(e.request_id)!).push(e);
  const reqIds = ops.map(o => o.request_id);
  const rows = await engine.executeRaw(`SELECT r.request_id::text AS request_id, r.state, r.error_code, r.deferred_refresh_id::text AS deferred_refresh_id,
    r.deferred_import_from, r.outcome, r.created_at, r.updated_at, r.sequence::text AS sequence, f.released_at
    FROM persistence_requests r LEFT JOIN persistence_worktree_refreshes f ON f.id=r.deferred_refresh_id WHERE r.request_id::text = ANY($1::text[])`, [reqIds]);
  const rowsBy = new Map<string, any[]>();
  for (const row of rows) (rowsBy.get(row.request_id) ?? rowsBy.set(row.request_id, []).get(row.request_id)!).push(row);
  const facts = await engine.executeRaw(`SELECT fact, expired_at IS NULL AS live FROM facts WHERE fact LIKE '%RBM%'`);
  const pages = await engine.executeRaw(`SELECT coalesce(compiled_truth,'') || E'\\n' || coalesce(timeline,'') AS body FROM pages WHERE deleted_at IS NULL AND (compiled_truth LIKE '%RBM%' OR timeline LIKE '%RBM%')`);
  const versions = await engine.executeRaw(`SELECT coalesce(compiled_truth,'') AS body FROM page_versions WHERE compiled_truth LIKE '%RBM%'`);
  const history = await engine.executeRaw(`SELECT p.id AS page_id, v.id AS vid, coalesce(v.compiled_truth,'') AS body FROM page_versions v JOIN pages p ON p.id=v.page_id
    UNION ALL SELECT p.id, 9223372036854775807, coalesce(p.compiled_truth,'') || E'\\n' || coalesce(p.timeline,'') FROM pages p WHERE p.deleted_at IS NULL ORDER BY 1, 2`);
  const pageContents = new Map<number, string[]>();
  for (const h of history) (pageContents.get(Number(h.page_id)) ?? pageContents.set(Number(h.page_id), []).get(Number(h.page_id))!).push(h.body as string);
  const completions = events.filter(e => (e.ev === 'sync_result' || (e.ev === 'tick_result' && e.mode !== 'resume')) && ['completed', 'synced', 'ok', 'up_to_date', 'imported'].includes(String(e.status)))
    .map(e => Number(e.t));
  const markers = ops.map(o => o.marker);
  const upMarkers = schedule.ticks.flatMap(t => t.pushes.map(p => p.marker));
  const git = gitMarkers(paths.root, [...markers, ...upMarkers]);
  const origin = treeMarkers(paths.remote, 'main', markers);
  const expiryPossible = schedule.max_wait_ms !== null;
  const ledger = ledgerCommits(paths.root);
  const pageText = pages.map((p: any) => p.body as string);
  const versionText = versions.map((v: any) => v.body as string);
  const exact = count;

  const opByMarker = new Map(ops.map(o => [o.marker, o]));
  const records = ops.map((op): OpRecord => {
    const ev = byReq.get(op.request_id) ?? [];
    const responses = ev.filter(e => e.ev === 'response').sort((a, b) => a.attempt - b.attempt);
    const first = responses[0] ?? null;
    const finals = ev.filter(e => e.ev === 'final');
    const rs = rowsBy.get(op.request_id) ?? [];
    const row = rs[0] ?? null;
    const m = op.marker;
    const factsAll = facts.filter((f: any) => exact(f.fact, m) > 0);
    const facts_live = factsAll.filter((f: any) => f.live).length;
    const pages_occ = pageText.reduce((n: number, t: string) => n + exact(t, m), 0);
    const versionsN = versionText.filter((t: string) => exact(t, m) > 0).length;
    const git_head_occ = git.head.get(m) ?? 0, git_hist = git.hist.get(m) ?? 0;
    const ledger_commits = ledger.get(op.request_id) ?? 0;
    const applied = factsAll.length > 0 || pages_occ > 0 || versionsN > 0 || git_hist > 0;
    const acknowledged = responses.some(r => r.cls === 'committed' || r.cls === 'pending');
    const client_committed = responses.some(r => r.cls === 'committed') || finals.some(f => f.state === 'committed');
    const origin_occ = origin.get(m) ?? 0;
    const state = row?.state ?? null;
    const wt = row?.outcome?.write_through?.written;
    const write_through = typeof wt === 'boolean' ? wt : null;
    const committedAt = row?.updated_at ? new Date(row.updated_at).getTime() : null;
    const deferred = Boolean(row?.deferred_refresh_id || row?.deferred_import_from != null);
    const sequence = row?.sequence != null ? Number(row.sequence) : null;
    let removed_by: string[] | null = null;
    for (const contents of pageContents.values()) { const r = removerOf(contents, m); if (r) { removed_by = r; break; } }
    const currentlyPresent = pages_occ > 0;
    const blindLater = removed_by !== null && removed_by.length > 0 && removed_by.every(x => {
      const o = opByMarker.get(x); const xr = o ? rowsBy.get(o.request_id)?.[0] : undefined;
      return o?.kind === 'put_blind' && xr?.sequence != null && sequence !== null && Number(xr.sequence) > sequence;
    });
    const overwrittenAny = state === 'committed' && applied && !currentlyPresent;
    const createdAt = row?.created_at ? new Date(row.created_at).getTime() : null;
    const ctx = { expiryPossible, heldForRefresh: Boolean(row?.deferred_refresh_id), heldForImport: row?.deferred_import_from != null };
    const unexpected_reasons = [
      ...responses.filter(r => r.cls === 'refused' && !allowedCode(String(r.code), { ...ctx, final: false })).map(r => `refused:${r.code}`),
      ...(state && TERMINAL.has(state) && state !== 'committed' && !allowedCode(String(row?.error_code), { ...ctx, final: true }) ? [`final:${state}:${row?.error_code ?? ''}`] : []),
      ...ev.filter(e => e.ev === 'retries_exhausted').map(() => 'retries_exhausted'),
      ...ev.filter(e => e.ev === 'call_timeout' || e.ev === 'poll_timeout').map(e => e.ev as string),
    ];
    const wrong_expiry = (row?.error_code === 'refresh_barrier_expired' && row.released_at != null && committedAt !== null && new Date(row.released_at).getTime() < committedAt)
      || (row?.error_code === 'pending_import_expired' && createdAt !== null && committedAt !== null && completions.some(t => t > createdAt && t < committedAt - 2_000));
    return {
      writer: op.writer, op: op.index, kind: op.kind, source: op.source, slug: op.slug, marker: m, request_id: op.request_id,
      issued: responses.length > 0 || ev.some(e => e.ev === 'call_timeout'), attempts: responses.length,
      first: first?.cls ?? null, first_code: first?.code ?? null, first_deferred: Boolean(first?.deferred),
      first_ms: first?.ms ?? null, first_t: first ? Number(first.t) - Number(first.ms ?? 0) : null, first_slip_ms: first?.slip_ms ?? null,
      codes: responses.map(r => r.code).filter(Boolean), acknowledged, client_committed, call_timeouts: ev.filter(e => e.ev === 'call_timeout' || e.ev === 'poll_timeout').length,
      client_final: finals[finals.length - 1]?.state ?? (responses.find(r => r.cls === 'committed') ? 'committed' : null),
      rows: rs.length, state, error_code: row?.error_code ?? null,
      deferred_refresh: Boolean(row?.deferred_refresh_id), deferred_import: row?.deferred_import_from != null, write_through,
      facts_all: factsAll.length, facts_live, pages_occ, versions: versionsN, git_head_occ, git_hist, origin_occ, ledger_commits,
      applied,
      landed_naive: applied && state === 'committed' && (first?.cls === 'committed' || first?.cls === 'pending'),
      landed_spec: applied && state === 'committed',
      defer_to_apply_ms: deferred && state === 'committed' && committedAt ? committedAt - new Date(row.created_at).getTime() : null,
      release_to_apply_ms: row?.released_at && state === 'committed' && committedAt ? committedAt - new Date(row.released_at).getTime() : null,
      lost: (acknowledged && (rs.length === 0 || (state === 'committed' && !applied))) || (client_committed && (rs.length === 0 || state !== 'committed' || !applied)),
      lost_git: state === 'committed' && pages_occ > 0 && git_head_occ === 0 && write_through !== false,
      phantom: applied && state !== 'committed',
      duplicated: rs.length > 1 || facts_live > 1 || git_head_occ > 1 || pages_occ > 1 || ledger_commits > 1,
      stuck: rs.length > 0 && !TERMINAL.has(String(state)),
      sequence, removed_by, overwritten_blind: overwrittenAny && blindLater,
      overwritten: overwrittenAny && !blindLater, wrong_expiry, indexed: null, unindexed: false,
      false_refusal: state === 'committed' && responses[responses.length - 1]?.cls === 'refused' && !finals.some(f => f.state === 'committed'),
      unpublished: state === 'committed' && write_through !== false && git_head_occ > 0 && origin_occ === 0,
      unexpected_outcome: unexpected_reasons.length > 0, unexpected_reasons, harness_error: responses.some(r => r.cls === 'harness_error'),
    };
  });
  for (const r of records) {
    if (r.state !== 'committed' || r.pages_occ === 0) continue;
    const hits = await engine.searchKeyword(r.marker, { limit: 10 });
    r.indexed = hits.some((h: { chunk_text?: string }) => String(h.chunk_text ?? '').includes(r.marker));
    r.unindexed = !r.indexed;
  }
  const pushPath = new Map(schedule.ticks.flatMap(t => t.pushes.map(p => [p.marker, p.path] as const)));
  const committedBlindPut = (x: string) => { const o = opByMarker.get(x); return o?.kind === 'put_blind' && rowsBy.get(o.request_id)?.[0]?.state === 'committed'; };
  const missingUp = upMarkers.filter(m => (git.head.get(m) ?? 0) === 0);
  const removed_by_blind_put = missingUp.filter(m => removedByBlindPut(fileHistory(paths.root, pushPath.get(m)!), m, committedBlindPut)).length;
  return { ops: records, upstream: { pushed: upMarkers.length, missing_head: missingUp.length - removed_by_blind_put, removed_by_blind_put }, ledger_present: ledger.size > 0 };
}

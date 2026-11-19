/**
 * AD: who can read what when a brain's sharing changes. A keyless contract test with no model calls: every brain is
 * synthetic (PGLite in memory, a hashed stand-in for embeddings, no provider key), and every read goes through gbrain's
 * own transports. For each way a personal brain can turn shared, it reads every piece of content as every kind of
 * caller before and after the change, and checks each cell against gbrain's access contract
 * (docs/guides/access-designations.md, docs/guides/conversation-archive.md): the owner's own callers never lose a read,
 * and nobody else ever gains one. Run it against another gbrain build by pointing node_modules/gbrain at that checkout.
 * A cell that fails names the scenario, phase, caller, content and read path, and AD_REPORT_DIR=<dir> writes every cell,
 * with the build it ran on (the commit and whether the tree was clean, when node_modules/gbrain is a git checkout, read
 * once before the scenarios and again after them) and every scenario this build defines, so a reader can tell a full run on one commit from a partial or mislabelled one.
 * Every count it reports is on PGLite: no Postgres brain runs here. Source config goes in through gbrain's
 * executeRawJsonb, because a JSON.stringify'd ::jsonb parameter is stored as a JSON string on Postgres, and setup fails
 * if the owner-only source doesn't read back owner_only: true.
 *
 * On a build whose get_page reads several pages with `slugs` (gbrain#9798, GBRA-650), every page is also read through a
 * batch that asks for it first and then for every other page in the brain, scoped to its source and unscoped. Those
 * cells answer to the same contract as a single get_page, and any page a batch delivers, the one it asks for first or a
 * later one, that the same caller does not read through a single get_page fails as slugs_only. On a build without `slugs` those paths are skipped.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PGLiteEngine } from '../../node_modules/gbrain/src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../node_modules/gbrain/src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../../node_modules/gbrain/src/core/oauth-provider.ts';
import { executeRawJsonb, sqlQueryForEngine } from '../../node_modules/gbrain/src/core/sql-query.ts';
import { mintLegacyToken } from '../../node_modules/gbrain/src/core/token-mint.ts';
import { noGrantFederatedScope, localFederatedSourceIds } from '../../node_modules/gbrain/src/core/source-resolver.ts';
import { dispatchToolCall } from '../../node_modules/gbrain/src/mcp/dispatch.ts';
import { startHttpTransport } from '../../node_modules/gbrain/src/mcp/http-transport.ts';
import { RateLimiter } from '../../node_modules/gbrain/src/mcp/rate-limit.ts';
import { __resetPrivateVisibilityCacheForTests } from '../../node_modules/gbrain/src/core/search/private-visibility.ts';
import { addMember, bindCredential, disableMember } from '../../node_modules/gbrain/src/core/access/members.ts';
import { setOwner } from '../../node_modules/gbrain/src/core/access/owner.ts';
import { brainServes } from '../../node_modules/gbrain/src/core/access/serves.ts';
import { classifyBrainAudience } from '../../node_modules/gbrain/src/core/facts/writeback-audience.ts';
import { disposePersistenceConsumer } from '../../node_modules/gbrain/src/core/persistence/service.ts';
import { ARCHIVE_TIMEZONE_KEY, archiveRescopeSkipped, runTranscriptArchive, setArchiveEnabled } from '../../node_modules/gbrain/src/core/transcripts/archive.ts';
import { softDeleteSource, restoreSource } from '../../node_modules/gbrain/src/core/destructive-guard.ts';
import { importFromContent } from '../../node_modules/gbrain/src/core/import-file.ts';
import { runAccess } from '../../node_modules/gbrain/src/commands/access.ts';
import { runConfig } from '../../node_modules/gbrain/src/commands/config.ts';
import { mountAdminAccess } from '../../node_modules/gbrain/src/commands/serve-http-access.ts';
import { createRequireAdmin } from '../../node_modules/gbrain/src/commands/serve-http-admin-api.ts';
import express from 'express';
import cookieParser from 'cookie-parser';
import { emptyHome, withEnv } from '../../node_modules/gbrain/test/helpers/with-env.ts';
import { archivedPages, conversation, staticReader } from '../../node_modules/gbrain/test/helpers/transcript-archive.ts';

/**
 * The contract needs owner-only sources (gbrain v0.60.738.0) and the archive re-scope on sharing (v0.60.735.0), so on an
 * older pinned build every scenario is skipped with this reason instead of reporting their absence as leaks.
 */
const MIN_GBRAIN = '0.60.738.0';
const GBRAIN_VERSION: string = JSON.parse(readFileSync(join(import.meta.dir, '../../node_modules/gbrain/package.json'), 'utf8')).version;
const older = (a: string, b: string) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0); } return false; };
const TOO_OLD = older(GBRAIN_VERSION, MIN_GBRAIN);
if (TOO_OLD) console.warn('sharing contract skipped: the pinned gbrain is v' + GBRAIN_VERSION + ', and this test needs v' + MIN_GBRAIN + ' or later');
/**
 * The build node_modules/gbrain holds: its version, and its commit and whether its tree is clean when it is a git checkout
 * of its own (a link to a gbrain clone). An installed package records no commit, so sha is null there.
 */
export function gbrainBuild(root: string = join(import.meta.dir, '../../node_modules/gbrain')): { version: string; sha: string | null; dirty: boolean | null } {
  const real = realpathSync(root);
  const version = (JSON.parse(readFileSync(join(real, 'package.json'), 'utf8')) as { version: string }).version;
  const git = (...args: string[]) => { const r = spawnSync('git', ['-C', real, ...args], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };
  const top = git('rev-parse', '--show-toplevel');
  if (!top || realpathSync(top) !== real) return { version, sha: null, dirty: null };
  return { version, sha: git('rev-parse', 'HEAD'), dirty: (git('status', '--porcelain') ?? 'unknown') !== '' };
}
const BUILD_AT_START = gbrainBuild();

/** get_page { slugs } ships in gbrain#9798 as src/core/ops/get-page-batch.ts. */
export const HAS_SLUGS = existsSync(join(import.meta.dir, '../../node_modules/gbrain/src/core/ops/get-page-batch.ts'));

/**
 * Pages in an archived source stay hidden from every page read for API tokens, and the owner admin page re-scopes the
 * archive before it adds a member, from gbrain v0.60.744.0 (#9795). On an older build the archived-source items and the
 * admin-route scenario are left out with this reason.
 */
const ARCHIVE_FIX_GBRAIN = '0.60.744.0';
const ARCHIVE_FIX = !older(GBRAIN_VERSION, ARCHIVE_FIX_GBRAIN);
if (!TOO_OLD && !ARCHIVE_FIX) console.warn('sharing contract: the archived-source items and the admin-route scenario are skipped: the pinned gbrain is v' + GBRAIN_VERSION + ', and they need v' + ARCHIVE_FIX_GBRAIN + ' or later');

const OWNER = 'alice-example';
const OTHER = 'bob-example';
const DIMS = 1536;
const GRANT = ['default', 'conversations', 'owner-notes', ...(ARCHIVE_FIX ? ['old-project'] : [])];

function vectorFor(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIMS] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}

/** One piece of content. Its mark appears only in the stored text, never in a query, so an echoed query is never a read. */
interface Item { id: string; label: string; kind: 'page' | 'fact'; source: string; slug: string; query: string; mark: string }
const page = (id: string, label: string, source: string, slug: string, query: string, mark: string): Item => ({ id, label, kind: 'page', source, slug, query, mark });
const ITEMS: Item[] = [
  page('world', 'public page (no designation)', 'default', 'notes/adworldqzx', 'adworldqzx harbor', 'markworldjtq'),
  page('private', 'private page (visibility: private)', 'default', 'notes/adprivateqzx', 'adprivateqzx harbor', 'markprivatejtq'),
  page('owner_listed', 'page kept to the owner (readable_by owner)', 'default', 'notes/adlistedqzx', 'adlistedqzx harbor', 'marklistedjtq'),
  page('owner_source', 'page in an owner-only source', 'owner-notes', 'notes/advaultqzx', 'advaultqzx harbor', 'markvaultjtq'),
  page('archive', 'conversation archive page written while personal', 'conversations', '', 'adarchiveqzx harbor', 'markarchivejtq'),
  ...(ARCHIVE_FIX ? [
    page('archived_source', 'page in an archived source', 'old-project', 'notes/adoldqzx', 'adoldqzx harbor', 'markoldjtq'),
    page('archived_private', 'private page in an archived source', 'old-project', 'notes/adoldprivateqzx', 'adoldprivateqzx harbor', 'markoldprivatejtq'),
  ] : []),
  { id: 'world_fact', label: 'public fact', kind: 'fact', source: 'default', slug: 'notes/adworldqzx', query: 'adfactworldqzx ledger', mark: 'factworldhmz' },
  { id: 'private_fact', label: 'private fact', kind: 'fact', source: 'default', slug: 'notes/adworldqzx', query: 'adfactprivateqzx ledger', mark: 'factprivatehmz' },
];

type CallerKind = 'local' | 'owner' | 'owner_unset' | 'member' | 'nonmember' | 'unauthenticated' | 'disabled';
interface Caller { id: string; label: string; kind: CallerKind }
const CALLERS: Caller[] = [
  { id: 'local', label: 'trusted local owner (CLI on the brain host)', kind: 'local' },
  { id: 'owner_http', label: "owner's remote MCP caller: token bound to the owner, over HTTP", kind: 'owner' },
  { id: 'owner_oauth', label: "owner's remote MCP caller: OAuth client bound to the owner", kind: 'owner' },
  { id: 'owner_stdio', label: "owner's MCP caller: stdio server bound to the owner", kind: 'owner' },
  { id: 'member_http', label: 'another member: token bound to bob-example, over HTTP', kind: 'member' },
  { id: 'nonmember_http', label: 'non-member token (bound to nobody), over HTTP', kind: 'nonmember' },
  { id: 'unauth_http', label: 'unauthenticated HTTP caller (no bearer token)', kind: 'unauthenticated' },
];

/** Each read names the item's source; the _unscoped twins name none, the way an agent usually calls. */
type ReadPath = 'get_page' | 'search' | 'query' | 'list_pages' | 'recall' | 'get_page_unscoped' | 'search_unscoped' | 'query_unscoped' | 'list_unscoped' | 'recall_unscoped'
  | 'get_page_slugs' | 'get_page_slugs_unscoped';
const PAGE_PATHS: ReadPath[] = ['get_page', 'search', 'query', 'list_pages', 'get_page_unscoped', 'search_unscoped', 'query_unscoped', 'list_unscoped',
  ...(HAS_SLUGS ? ['get_page_slugs', 'get_page_slugs_unscoped'] as ReadPath[] : [])];
const FACT_PATHS: ReadPath[] = ['recall', 'query', 'recall_unscoped', 'query_unscoped'];
const OP: Record<ReadPath, string> = { get_page: 'get_page', search: 'search', query: 'query', list_pages: 'list_pages', recall: 'recall', get_page_unscoped: 'get_page',
  search_unscoped: 'search', query_unscoped: 'query', list_unscoped: 'list_pages', recall_unscoped: 'recall', get_page_slugs: 'get_page', get_page_slugs_unscoped: 'get_page' };

/** `others` is every other page slug in the brain, which a slugs batch asks for after the item's own. */
function argsFor(path: ReadPath, item: Item, slug: string, others: string[] = []): Record<string, unknown> {
  switch (path) {
    case 'get_page_slugs': return { slugs: [slug, ...others], source_id: item.source };
    case 'get_page_slugs_unscoped': return { slugs: [slug, ...others] };
    case 'get_page': return { slug, source_id: item.source };
    case 'search': return { query: item.query, match: 'keyword', fields: 'full', limit: 50, source_id: item.source };
    case 'query': return { query: item.query, expand: false, fields: 'full', limit: 50, source_id: item.source };
    case 'list_pages': return { limit: 500, source_id: item.source };
    case 'recall': return { query: item.query, limit: 50, source_id: item.source };
    case 'get_page_unscoped': return { slug };
    case 'search_unscoped': return { query: item.query, match: 'keyword', fields: 'full', limit: 50 };
    case 'query_unscoped': return { query: item.query, expand: false, fields: 'full', limit: 50 };
    case 'list_unscoped': return { limit: 500 };
    case 'recall_unscoped': return { query: item.query, limit: 50 };
  }
}

/**
 * What the contract allows, from access-designations.md's "Who reads what" table and conversation-archive.md:
 * Unscoped reads (no source_id) search the caller's default read set, so for them only 'never' and the before/after
 * comparison bind. 'must' = the caller must read it (the owner's callers, R94: never lose a read); 'never' = it must not;
 * 'may' = the contract allows either (an unbound token reading world content in its grace, personal-era archive pages
 * on a personal brain, where gbrain treats every caller as the owner, or on a shared brain while gbrain reports
 * archive_rescope_pending, the documented wait in conversation-archive.md "When a personal brain becomes shared"; the owner's own member before any owner is set,
 * which reads what lists it but gets no owner relaxation; a page in an archived source, which the owner hid on purpose
 * and multi-source-brains.md keeps from every reader but the owner).
 */
type Expect = 'must' | 'never' | 'may';
function contract(caller: CallerKind, item: Item, state: State, path: ReadPath): Expect {
  const shared = state.shared;
  if (caller === 'unauthenticated' || caller === 'disabled') return 'never';
  const scoped = !path.endsWith('_unscoped');
  if (item.id === 'archived_source' || item.id === 'archived_private') return caller === 'local' || caller === 'owner' ? 'may' : 'never';
  if (caller === 'local' || caller === 'owner') return scoped ? 'must' : 'may';
  if (caller === 'owner_unset') return ['private', 'owner_source', 'private_fact'].includes(item.id) ? 'never' : 'may';
  if (item.id === 'world' || item.id === 'world_fact') return caller === 'member' && scoped ? 'must' : 'may';
  if (item.id === 'archive' && !shared && caller === 'nonmember') return 'may';
  if (item.id === 'archive' && shared && state.rescopePending) return 'may';
  return 'never';
}

/** `batch`, on a slugs cell: the other pages whose marks the batch result carried. */
export interface Cell { scenario: string; phase: 'before' | 'after'; caller: string; item: string; path: ReadPath; read: boolean | null; batch?: string[]; error?: string; expect: Expect; verdict: 'ok' | 'violation' | 'owner_lost' | 'slugs_only' }

interface Brain {
  engine: any; home: string; tokens: Record<string, string>; server: any; archiveSlug: string;
  oauth: () => Promise<string>;
}

async function makeBrain(opts: { ownerSet: boolean; otherDisabled?: boolean }): Promise<Brain> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  __resetPrivateVisibilityCacheForTests();
  const home = emptyHome();
  await engine.setConfig('maintenance.auto', 'false');
  await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
  await setArchiveEnabled(engine, true);
  const sources: Array<[string, Record<string, boolean>]> = [['owner-notes', { owner_only: true, federated: true }], ...(ARCHIVE_FIX ? [['old-project', { federated: true }] as [string, Record<string, boolean>]] : [])];
  for (const [id, config] of sources) {
    await executeRawJsonb(engine, 'INSERT INTO sources (id, name, config) VALUES ($1, $1, $2::jsonb) ON CONFLICT (id) DO NOTHING', [id], [config]);
  }
  const [ownerOnly] = await engine.executeRaw("SELECT config->>'owner_only' AS owner_only FROM sources WHERE id = 'owner-notes'") as Array<{ owner_only: string | null }>;
  if (ownerOnly?.owner_only !== 'true') throw new Error('setup: owner-notes did not store owner_only: true (config->>\'owner_only\' read ' + ownerOnly?.owner_only + ')');
  const body = (it: Item, fm: string) => '---\ntype: note\ntitle: ' + it.id + '\n' + fm + '---\n# ' + it.id + '\n\nPlanning notes ' + it.query + ' ' + it.mark + '.\n';
  for (const it of ITEMS.filter(i => i.kind === 'page' && i.id !== 'archive')) {
    const fm = it.id === 'private' || it.id === 'archived_private' ? 'visibility: private\n' : it.id === 'owner_listed' ? 'readable_by: [' + OWNER + ']\n' : '';
    await importFromContent(engine, it.slug, body(it, fm), { sourceId: it.source });
  }
  await addMember(engine, OWNER);
  if (opts.otherDisabled) { await addMember(engine, OTHER); await disableMember(engine, OTHER); }
  if (opts.ownerSet) await setOwner(engine, OWNER);
  const reader = staticReader('openclaw', [conversation('openclaw', 'agent:main:main', [['user', '2026-10-01T10:00:00.000Z', 'Planning notes adarchiveqzx harbor private markarchivejtq']], { chatType: 'direct', verified: true })]);
  const run = await withEnv({ GBRAIN_HOME: home }, () => runTranscriptArchive(engine, { mode: 'backfill', from: '2026-10-01', to: '2026-10-01', readers: [reader], now: new Date('2026-10-05T00:00:00Z') }));
  if (run.privacy !== 'personal') throw new Error('setup: the archive did not run as personal');
  const archiveSlug = (await archivedPages(engine, 'conversations')).find((p: { body: string }) => p.body.includes('markarchivejtq'))!.slug;
  for (const it of ITEMS.filter(i => i.kind === 'fact')) {
    await engine.insertFact({ fact: 'Planning notes ' + it.query + ' ' + it.mark, kind: 'fact', source: 'test', visibility: it.id === 'private_fact' ? 'private' : 'world' }, { source_id: it.source });
    await engine.executeRaw('UPDATE facts SET source_markdown_slug = $1 WHERE fact LIKE $2', [it.slug, '%' + it.mark]);
  }
  const tokens: Record<string, string> = {};
  const brain: Brain = { engine, home, tokens, server: null, archiveSlug, oauth: async () => '' };
  await mint(brain, 'owner_http', OWNER);
  await mint(brain, 'nonmember_http', null);
  const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: (fn: any) => engine.transaction((tx: any) => fn(sqlQueryForEngine(tx))) });
  const client = await provider().registerClientManual('ad-owner-client', ['client_credentials'], 'read', [], 'default', GRANT);
  await bindCredential(engine, { kind: 'client', id: client.clientId }, { member: OWNER });
  brain.oauth = async () => (await provider().exchangeClientCredentials(client.clientId, client.clientSecret!)).access_token;
  brain.server = await startHttpTransport({ port: 0, engine, surface: 'full', limiters: {
    ip: new RateLimiter({ limit: 100_000, windowMs: 60_000, lruCap: 1000 }),
    token: new RateLimiter({ limit: 100_000, windowMs: 60_000, lruCap: 1000 }),
  } });
  return brain;
}

async function mint(b: Brain, name: string, member: string | null): Promise<void> {
  const minted = await mintLegacyToken(b.engine, { name: 'tok-' + name, scopes: ['read'], takesHolders: ['world'], sourceGrant: GRANT });
  b.tokens[name] = minted.token;
  if (member) await bindCredential(b.engine, { kind: 'token', id: minted.id }, { member });
}

async function closeBrain(b: Brain): Promise<void> {
  b.server?.stop(true);
  await disposePersistenceConsumer(b.engine).catch(() => {});
  await b.engine.disconnect();
}

async function http(b: Brain, token: string | null, op: string, args: Record<string, unknown>): Promise<string> {
  const res = await fetch('http://127.0.0.1:' + b.server.port + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: op, arguments: args } }),
  });
  return res.status + ' ' + await res.text();
}

async function dispatchText(b: Brain, op: string, args: Record<string, unknown>, opts: Record<string, unknown>): Promise<string> {
  try {
    const out = await dispatchToolCall(b.engine, op, { ...args }, opts);
    return out.content.map((c: { text?: string }) => c.text ?? '').join('\n');
  } catch (e) {
    return 'threw ' + (e instanceof Error ? e.message : String(e));
  }
}

async function readAs(b: Brain, caller: Caller, op: string, args: Record<string, unknown>): Promise<string> {
  switch (caller.id) {
    case 'local': return dispatchText(b, op, args, { remote: false });
    case 'owner_stdio': {
      const localFederated = await localFederatedSourceIds(b.engine, 'default', 'seed_default').catch(() => undefined);
      return dispatchText(b, op, args, { remote: true, transport: 'stdio', sourceId: 'default', stdioMember: OWNER, takesHoldersAllowList: ['world'], ...(localFederated ? { localFederatedSourceIds: localFederated } : {}) });
    }
    case 'owner_oauth': {
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(b.engine), transaction: (fn: any) => b.engine.transaction((tx: any) => fn(sqlQueryForEngine(tx))) });
      let auth: any;
      try { auth = await provider.verifyAccessToken(await b.oauth()); } catch (e) { return 'refused ' + (e as Error).message; }
      const sourceId = auth.sourceId ?? 'default';
      const localFederated = await noGrantFederatedScope(b.engine, auth.hasSourceGrant, sourceId);
      return dispatchText(b, op, args, { remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'], ...(localFederated ? { localFederatedSourceIds: localFederated } : {}) });
    }
    case 'unauth_http': return http(b, null, op, args);
    default: {
      const token = b.tokens[caller.id];
      if (!token) return 'absent';
      return http(b, token, op, args);
    }
  }
}

function present(caller: Caller, b: Brain): boolean {
  return !['member_http', 'nonmember_http', 'owner_http'].includes(caller.id) || !!b.tokens[caller.id];
}

/** The kind a caller has in this state: the owner's credentials count as the owner only while an owner is set, and a disabled member's token reads nothing. */
interface State { shared: boolean; ownerSet: boolean; otherEnabled: boolean; rescopePending: boolean }
function kindNow(caller: Caller, state: State): CallerKind {
  if (caller.kind === 'owner' && !state.ownerSet) return 'owner_unset';
  if (caller.kind === 'member' && !state.otherEnabled) return 'disabled';
  return caller.kind;
}

async function matrix(b: Brain, scenario: string, phase: 'before' | 'after', state: State): Promise<Cell[]> {
  __resetPrivateVisibilityCacheForTests();
  const cells: Cell[] = [];
  for (const caller of CALLERS) {
    if (!present(caller, b)) continue;
    const listing: Record<string, string> = {};
    const listKey = (path: ReadPath, item: Item) => path + ':' + (path === 'list_pages' ? item.source : '');
    const pageSlugs = ITEMS.filter(i => i.kind === 'page').map(i => (i.id === 'archive' ? b.archiveSlug : i.slug));
    for (const item of ITEMS) {
      const slug = item.id === 'archive' ? b.archiveSlug : item.slug;
      for (const path of item.kind === 'page' ? PAGE_PATHS : FACT_PATHS) {
        let text: string;
        const isList = path === 'list_pages' || path === 'list_unscoped';
        if (isList) text = listing[listKey(path, item)] ??= await readAs(b, caller, OP[path], argsFor(path, item, slug));
        else text = await readAs(b, caller, OP[path], argsFor(path, item, slug, pageSlugs.filter(s => s !== slug)));
        const read = isList ? text.includes('"' + slug + '"') || text.includes('\\"' + slug + '\\"') : text.includes(item.mark);
        const expect = contract(kindNow(caller, state), item, state, path);
        const verdict = expect === 'never' && read ? 'violation' : expect === 'must' && !read ? 'owner_lost' : 'ok';
        const batch = path === 'get_page_slugs' || path === 'get_page_slugs_unscoped' ? ITEMS.filter(o => o.kind === 'page' && o.id !== item.id && text.includes(o.mark)).map(o => o.id) : null;
        cells.push({ scenario, phase, caller: caller.id, item: item.id, path, read, ...(batch ? { batch } : {}), expect, verdict,
          ...(verdict !== 'ok' || !read ? { error: (text.match(/"code"\s*:\s*"([a-z_]+)"/)?.[1] ?? text.slice(0, 160)) } : {}) });
      }
    }
  }
  return slugsOnly(cells);
}

/** A page a caller reads through a get_page slugs batch, first or later in it, but not through a single get_page of the same scope: a leak. */
export function slugsOnly(cells: Cell[]): Cell[] {
  const single = new Map(cells.filter(c => c.path === 'get_page' || c.path === 'get_page_unscoped').map(c => [c.caller + '|' + c.item + '|' + c.path, c.read === true]));
  const alone = (c: Cell, item: string) => single.get(c.caller + '|' + item + '|' + c.path.replace('_slugs', '')) === true;
  for (const c of cells) {
    if (c.path !== 'get_page_slugs' && c.path !== 'get_page_slugs_unscoped') continue;
    if ((c.read && !alone(c, c.item)) || (c.batch ?? []).some(id => !alone(c, id))) c.verdict = 'slugs_only';
  }
  return cells;
}

/** A cell the owner's caller read before the change and does not read after it (R94). */
function ownerLosses(before: Cell[], after: Cell[]): Cell[] {
  const key = (c: Cell) => c.caller + '|' + c.item + '|' + c.path;
  const had = new Set(before.filter(c => c.read && (c.caller === 'local' || c.caller.startsWith('owner_'))).map(key));
  return after.filter(c => had.has(key(c)) && !c.read && !c.item.startsWith('archived_'));
}

/** shared: 'audience' takes the brain's state from classifyBrainAudience after the change (the client-count trigger). */
interface Scenario { name: string; ownerSet?: boolean; otherDisabled?: boolean; change: (b: Brain) => Promise<void>; shared: boolean | 'audience'; mintOther?: boolean; otherEnabledAfter?: boolean }

const inHome = <T>(b: Brain, fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: b.home }, fn);
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log, err = console.error;
  console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.error = err; }
};
const access = (b: Brain, argv: string[]) => inHome(b, () => quiet(() => runAccess(b.engine, argv)));
const archiveRun = (b: Brain) => inHome(b, () => runTranscriptArchive(b.engine, { mode: 'run', readers: [staticReader('openclaw', [])], now: new Date('2026-10-05T00:00:00Z') }));
/** Add a member the way the owner's admin page does: POST /admin/api/access/members on gbrain's own admin routes. */
async function adminAddMember(b: Brain, id: string): Promise<void> {
  const app = express();
  app.use(cookieParser());
  mountAdminAccess(app, createRequireAdmin(new Map([['owner-session', Date.now() + 3_600_000]])), b.engine);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', () => r()));
  try {
    const res = await fetch('http://127.0.0.1:' + (server.address() as { port: number }).port + '/admin/api/access/members', { method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'gbrain_admin=owner-session' }, body: JSON.stringify({ action: 'add', id }) });
    if (res.status !== 200) throw new Error('admin member add answered ' + res.status + ' ' + await res.text());
  } finally {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  }
}

async function threeOwnerClients(b: Brain): Promise<void> {
  await mint(b, 'owner_muse', OWNER);
  await mint(b, 'owner_grok', OWNER);
  for (const name of ['owner_http', 'owner_muse', 'owner_grok']) {
    for (const op of ['search', 'get_page', 'query']) await http(b, b.tokens[name]!, op, op === 'get_page' ? { slug: 'notes/adworldqzx' } : { query: 'harbor', limit: 3 });
  }
  delete b.tokens.owner_muse; delete b.tokens.owner_grok;
}

export const SCENARIOS: Scenario[] = [
  { name: 'personal, no change (control)', change: async () => {}, shared: false },
  { name: 'declared shared: gbrain config set brain.audience shared', shared: true, mintOther: true,
    change: async b => { await inHome(b, () => quiet(() => runConfig(b.engine, ['set', 'brain.audience', 'shared']))); await addMember(b.engine, OTHER); } },
  { name: 'member count: gbrain access member add bob-example', shared: true, mintOther: true, change: b => access(b, ['member', 'add', OTHER]) },
  { name: 'member count: gbrain access member enable bob-example', otherDisabled: true, shared: true, mintOther: true, change: b => access(b, ['member', 'enable', OTHER]) },
  { name: 'explicit sharing: gbrain access serves several --members alice-example,bob-example --yes', shared: true, mintOther: true,
    change: b => access(b, ['serves', 'several', '--members', OWNER + ',' + OTHER, '--yes']) },
  { name: 'explicit sharing, then the next archive run', shared: true, mintOther: true,
    change: async b => { await access(b, ['serves', 'several', '--members', OWNER + ',' + OTHER, '--yes']); await archiveRun(b); } },
  { name: "MCP-client count: three of the owner's own clients in 30 days, no command", shared: 'audience', change: threeOwnerClients },
  { name: "MCP-client count: three of the owner's own clients, then the next archive run", shared: 'audience', change: async b => { await threeOwnerClients(b); await archiveRun(b); } },
  { name: 'MCP-client count, then a second member joins by the addMember library call, no hook', shared: true, mintOther: true,
    change: async b => { await threeOwnerClients(b); await addMember(b.engine, OTHER); } },
  ...(ARCHIVE_FIX ? [{ name: 'MCP-client count, then a second member joins on the owner admin page (POST /admin/api/access/members)', shared: true, mintOther: true,
    change: async (b: Brain) => { await threeOwnerClients(b); await adminAddMember(b, OTHER); } }] : []),
  { name: 'shared with no owner, then gbrain access owner set alice-example', ownerSet: false, shared: true, mintOther: true,
    change: async b => { await access(b, ['member', 'add', OTHER]); await access(b, ['owner', 'set', OWNER]); } },
  { name: 'shared, then back to personal (member disable, brain.audience personal, archive run)', shared: false, otherEnabledAfter: false,
    change: async b => {
      await access(b, ['member', 'add', OTHER]); await mint(b, 'member_http', OTHER);
      await access(b, ['member', 'disable', OTHER]);
      await inHome(b, () => quiet(() => runConfig(b.engine, ['set', 'brain.audience', 'personal'])));
      await archiveRun(b);
    } },
  { name: 'conversation source archived while personal, shared by member add, then restored', shared: true, mintOther: true,
    change: async b => {
      await softDeleteSource(b.engine, 'conversations');
      await access(b, ['member', 'add', OTHER]);
      await restoreSource(b.engine, 'conversations');
    } },
];

const report: Cell[] = [];
const notes: Record<string, unknown> = {};

const savedDiscovery = process.env.GBRAIN_MODEL_DISCOVERY;
process.env.GBRAIN_MODEL_DISCOVERY = 'off';
const realFetch = globalThis.fetch;
const offHostFetches: string[] = [];
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== '127.0.0.1') {
    offHostFetches.push(url.origin);
    throw new Error('network disabled in the sharing contract test: ' + url.origin);
  }
  return realFetch(input, init);
}, realFetch) as typeof fetch;
configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'keyless-test' } });
__setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);

describe('AD sharing contract: the build it ran on', () => {
  test('a gbrain checkout reports its commit and whether its tree is clean; a directory that is not its own checkout reports no commit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ad-build-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'gbrain', version: '9.9.9' }));
    expect(gbrainBuild(dir)).toEqual({ version: '9.9.9', sha: null, dirty: null });
    const g = (...a: string[]) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).stdout.trim();
    g('init', '-q'); g('add', 'package.json'); g('commit', '-q', '-m', 'a');
    expect(gbrainBuild(dir)).toEqual({ version: '9.9.9', sha: g('rev-parse', 'HEAD'), dirty: false });
    writeFileSync(join(dir, 'extra.ts'), 'export {}');
    expect(gbrainBuild(dir).dirty).toBe(true);
  });
});

describe('AD sharing contract: get_page slugs leak check', () => {
  const cell = (path: ReadPath, read: boolean, caller = 'member_http', item = 'private'): Cell => ({ scenario: 's', phase: 'after', caller, item, path, read, expect: 'may', verdict: 'ok' });
  test('a page read through slugs but not through a single get_page of the same scope is slugs_only; matching reads pass', () => {
    const cells = slugsOnly([
      cell('get_page', false), cell('get_page_slugs', true),
      cell('get_page_unscoped', true), cell('get_page_slugs_unscoped', true),
      cell('get_page', true, 'owner_http', 'world'), cell('get_page_slugs', true, 'owner_http', 'world'),
      cell('get_page', true, 'owner_http', 'archive'), cell('get_page_slugs', false, 'owner_http', 'archive'),
    ]);
    expect(cells.filter(c => c.verdict === 'slugs_only').map(c => c.caller + ' ' + c.item + ' ' + c.path)).toEqual(['member_http private get_page_slugs']);
  });
  test('a page delivered later in an allowed batch that a single get_page denies is slugs_only', () => {
    const cells = slugsOnly([
      cell('get_page', true, 'member_http', 'world'), cell('get_page', false), cell('get_page_unscoped', true, 'member_http', 'world'), cell('get_page_unscoped', true),
      { ...cell('get_page_slugs', true, 'member_http', 'world'), batch: ['private'] }, { ...cell('get_page_slugs_unscoped', true, 'member_http', 'world'), batch: ['private'] },
    ]);
    expect(cells.filter(c => c.verdict === 'slugs_only').map(c => c.item + ' ' + c.path)).toEqual(['world get_page_slugs']);
  });
  test('the slugs paths run exactly when the installed gbrain has get_page slugs', () => {
    expect(PAGE_PATHS.includes('get_page_slugs')).toBe(HAS_SLUGS);
    expect(argsFor('get_page_slugs', ITEMS[0]!, 'notes/a', ['notes/b'])).toEqual({ slugs: ['notes/a', 'notes/b'], source_id: 'default' });
    expect(argsFor('get_page_slugs_unscoped', ITEMS[0]!, 'notes/a', ['notes/b'])).toEqual({ slugs: ['notes/a', 'notes/b'] });
  });
});

for (const s of SCENARIOS) {
  describe.skipIf(TOO_OLD)('AD sharing contract: ' + s.name, () => {
    test("no non-owner gains a read and the owner's callers lose none", async () => {
      offHostFetches.length = 0;
      const b = await makeBrain({ ownerSet: s.ownerSet ?? true, otherDisabled: s.otherDisabled });
      try {
        if (ARCHIVE_FIX) await softDeleteSource(b.engine, 'old-project');
        const before = await matrix(b, s.name, 'before', { shared: false, ownerSet: s.ownerSet ?? true, otherEnabled: true, rescopePending: false });
        await s.change(b);
        if (s.mintOther && !b.tokens.member_http) await mint(b, 'member_http', OTHER);
        const rescope = await inHome(b, () => archiveRescopeSkipped(b.engine)) as { code?: string } | null;
        const audience = await classifyBrainAudience(b.engine);
        const shared = s.shared === 'audience' ? audience.audience !== 'personal' : s.shared;
        const after = await matrix(b, s.name, 'after', { shared, ownerSet: true, otherEnabled: s.otherEnabledAfter ?? true, rescopePending: rescope?.code === 'archive_rescope_pending' });
        for (const c of ownerLosses(before, after)) c.verdict = 'owner_lost';
        report.push(...before, ...after);
        notes[s.name] = { audience: audience.audience, audience_reasons: audience.reasons, serves: (await brainServes(b.engine)).serves,
          archive_rescope: rescope };
        const bad = [...before, ...after].filter(c => c.verdict !== 'ok').map(c => c.phase + ' ' + c.caller + ' ' + c.item + ' ' + c.path + ' ' + c.verdict + (c.error ? ' (' + c.error + ')' : ''));
        expect(bad).toEqual([]);
        expect(offHostFetches).toEqual([]);
      } finally {
        await closeBrain(b);
      }
    }, 300_000);
  });
}

afterAll(() => {
  globalThis.fetch = realFetch;
  __setEmbedTransportForTests(null);
  resetGateway();
  if (savedDiscovery === undefined) delete process.env.GBRAIN_MODEL_DISCOVERY;
  else process.env.GBRAIN_MODEL_DISCOVERY = savedDiscovery;
  const dir = process.env.AD_REPORT_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ad-sharing-cells.json'), JSON.stringify({ gbrain: BUILD_AT_START, gbrain_at_end: gbrainBuild(), has_slugs: HAS_SLUGS, too_old: TOO_OLD, scenarios: SCENARIOS.map(s => s.name),
    callers: CALLERS, items: ITEMS, notes, cells: report }, null, 1));
});
